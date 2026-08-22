/** Low-impact system metrics source: Netdata first, /proc + statfs when it is unavailable. */
import { readFile, statfs } from "node:fs/promises";

const NETDATA = "http://127.0.0.1:19999";
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

export interface SystemMetrics {
  source: "netdata" | "proc";
  collectedAt: string;
  cpu: { loadPercent: number };
  memory: { usedBytes: number; totalBytes: number };
  disk: { usedBytes: number; totalBytes: number };
  // Flat aliases keep the object convenient for simple status-card templates.
  cpuLoad: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
}

interface NetdataResponse {
  ok: boolean;
  json(): Promise<unknown>;
}
export type NetdataFetch = (input: string, init?: { signal?: AbortSignal }) => Promise<NetdataResponse>;
export type ProcReader = (path: string) => Promise<string>;

export interface StatFsResult {
  bsize: number | bigint;
  blocks: number | bigint;
  bfree: number | bigint;
}

export interface SystemMetricsOptions {
  /** Inject for tests; production defaults to global fetch. */
  fetch?: NetdataFetch;
  /** Injectable clock makes TTL behavior deterministic. */
  now?: () => number;
  /** A status consumer polling every minute should use the default 60 second cache. */
  ttlMs?: number;
  netdataUrl?: string;
  timeoutMs?: number;
  readFile?: ProcReader;
  statfs?: (path: string) => Promise<StatFsResult>;
}

interface ChartData { labels: string[]; data: number[][]; }
interface ChartsResponse {
  charts?: Record<string, { chart_labels?: Record<string, string> }>;
}

function asChartData(value: unknown): ChartData {
  if (!value || typeof value !== "object") throw new Error("invalid Netdata response");
  const row = value as { labels?: unknown; data?: unknown };
  if (!Array.isArray(row.labels) || !Array.isArray(row.data) || !Array.isArray(row.data[0])) {
    throw new Error("invalid Netdata chart data");
  }
  if (!row.labels.every((label) => typeof label === "string") || !row.data[0]!.every((cell) => typeof cell === "number")) {
    throw new Error("invalid Netdata chart values");
  }
  return { labels: row.labels as string[], data: row.data as number[][] };
}

function values(chart: ChartData): Record<string, number> {
  const result: Record<string, number> = {};
  for (let index = 0; index < chart.labels.length; index++) {
    const label = chart.labels[index]!;
    const value = chart.data[0]![index];
    if (typeof value === "number" && Number.isFinite(value)) result[label] = value;
  }
  return result;
}

function finite(value: number): number { return Number.isFinite(value) ? Math.max(0, value) : 0; }
function metric(source: SystemMetrics["source"], now: number, cpuLoad: number, memoryUsed: number, memoryTotal: number, diskUsed: number, diskTotal: number): SystemMetrics {
  return {
    source,
    collectedAt: new Date(now).toISOString(),
    cpu: { loadPercent: cpuLoad },
    memory: { usedBytes: memoryUsed, totalBytes: memoryTotal },
    disk: { usedBytes: diskUsed, totalBytes: diskTotal },
    cpuLoad,
    memoryUsed,
    memoryTotal,
    diskUsed,
    diskTotal,
  };
}

/** A race is used in addition to aborting, so even a non-cooperative injected fetch cannot hang callers. */
async function fetchJson(fetcher: NetdataFetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Netdata request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetcher(url, { signal: controller.signal }), timedOut]);
    if (!response.ok) throw new Error(`Netdata returned ${response.ok}`);
    return await Promise.race([response.json(), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function netdataMetrics(fetcher: NetdataFetch, base: string, timeoutMs: number, now: number): Promise<SystemMetrics> {
  const query = (chart: string) => `${base}/api/v1/data?chart=${encodeURIComponent(chart)}&points=1&format=json`;
  // Root is Netdata's normal chart id. The chart-list fallback covers installations where the
  // sanitized root id differs, while keeping collection entirely in-process.
  const [cpuRaw, ramRaw, rootDisk] = await Promise.all([
    fetchJson(fetcher, query("system.cpu"), timeoutMs),
    fetchJson(fetcher, query("system.ram"), timeoutMs),
    fetchJson(fetcher, query("disk_space._"), timeoutMs).catch(() => null),
  ]);
  let diskRaw = rootDisk;
  if (!diskRaw) {
    const charts = await fetchJson(fetcher, `${base}/api/v1/charts`, timeoutMs) as ChartsResponse;
    const diskChart = Object.entries(charts.charts ?? {}).find(([id, chart]) =>
      id.startsWith("disk_space.") && chart.chart_labels?.mount_point === "/",
    )?.[0];
    if (!diskChart) throw new Error("Netdata has no root disk chart");
    diskRaw = await fetchJson(fetcher, query(diskChart), timeoutMs);
  }
  const cpu = values(asChartData(cpuRaw));
  const ram = values(asChartData(ramRaw));
  const disk = values(asChartData(diskRaw));
  // system.cpu exposes all busy dimensions (rather than idle), each as a percent.
  const cpuLoad = finite(Object.entries(cpu).filter(([label]) => label !== "time").reduce((sum, [, value]) => sum + value, 0));
  const memoryTotal = finite(Object.entries(ram).filter(([label]) => label !== "time").reduce((sum, [, value]) => sum + value, 0) * MIB);
  const memoryUsed = finite((ram.used ?? 0) * MIB);
  const diskUsed = finite((disk.used ?? 0) * GIB);
  const diskTotal = finite(Object.entries(disk).filter(([label]) => label !== "time").reduce((sum, [, value]) => sum + value, 0) * GIB);
  return metric("netdata", now, cpuLoad, memoryUsed, memoryTotal, diskUsed, diskTotal);
}

function memInfo(body: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of body.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB$/i.exec(line.trim());
    if (match) values[match[1]!] = Number(match[2]!);
  }
  return values;
}

async function procMetrics(readProc: ProcReader, diskStatfs: (path: string) => Promise<StatFsResult>, now: number): Promise<SystemMetrics> {
  // /proc/stat gives a cheap cumulative CPU utilization; unlike a subprocess it adds no polling load.
  const [stat, meminfo, fs] = await Promise.all([readProc("/proc/stat"), readProc("/proc/meminfo"), diskStatfs("/")]);
  const cpuLine = stat.split("\n").find((line) => /^cpu\s/.test(line));
  const ticks = cpuLine?.trim().split(/\s+/).slice(1).map(Number) ?? [];
  const totalTicks = ticks.reduce((sum, tick) => sum + (Number.isFinite(tick) ? tick : 0), 0);
  const idleTicks = (ticks[3] ?? 0) + (ticks[4] ?? 0);
  const cpuLoad = totalTicks > 0 ? finite(((totalTicks - idleTicks) / totalTicks) * 100) : 0;
  const memory = memInfo(meminfo);
  const memoryTotal = finite((memory.MemTotal ?? 0) * 1024);
  const memoryUsed = finite(memoryTotal - (memory.MemAvailable ?? memory.MemFree ?? 0) * 1024);
  const number = (value: number | bigint) => typeof value === "bigint" ? Number(value) : value;
  const totalBlocks = number(fs.blocks);
  const freeBlocks = number(fs.bfree);
  const blockSize = number(fs.bsize);
  return metric("proc", now, cpuLoad, memoryUsed, memoryTotal, finite((totalBlocks - freeBlocks) * blockSize), finite(totalBlocks * blockSize));
}

/**
 * Create one cached reader for a status consumer. Concurrent callers share the same in-flight read,
 * and a one-minute TTL means a 60s render loop triggers at most one metrics collection per cycle.
 */
export function createSystemMetricsReader(options: SystemMetricsOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const base = (options.netdataUrl ?? NETDATA).replace(/\/$/, "");
  const fetcher = options.fetch ?? (globalThis.fetch as unknown as NetdataFetch);
  const readProc = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const diskStatfs = options.statfs ?? ((path: string) => statfs(path));
  let cached: SystemMetrics | null = null;
  let expiresAt = 0;
  let pending: Promise<SystemMetrics> | null = null;

  const read = async (): Promise<SystemMetrics> => {
    const at = now();
    if (cached && at < expiresAt) return cached;
    if (pending) return pending;
    pending = netdataMetrics(fetcher, base, timeoutMs, at)
      .catch(() => procMetrics(readProc, diskStatfs, at))
      .then((result) => {
        cached = result;
        expiresAt = at + ttlMs;
        return result;
      })
      .finally(() => { pending = null; });
    return pending;
  };
  return { read };
}
