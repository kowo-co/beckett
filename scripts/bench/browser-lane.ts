#!/usr/bin/env bun
/**
 * Browser lane benchmark. Run with: bun run browser:bench
 *
 * Drives the production betterwright/CloakBrowser stack through the real
 * isolated (bubblewrap on Linux) host and reports the four numbers that decide
 * whether a config change on this 4-core box is a win:
 *   - cold lease acquire ms  (spawn host + launch CloakBrowser + acquire())
 *   - warm eval ms           (a fixed scripted interaction, repeated)
 *   - peak RSS               (whole host+browser process tree, sampled)
 *   - CPU-seconds            (utime+stime summed across that tree)
 *
 * The page is a local deterministic fixture (Bun.serve on loopback) rather than
 * a live site so runs stay comparable over time. Loopback is already permitted
 * by NetworkPolicy({ allowLoopback: true }); the benchmark changes no security
 * posture.
 *
 * Process accounting works by wrapping Bun.spawn so we capture the host child
 * PID, then walking its /proc descendant tree. Renderers that exit mid-run keep
 * their last-observed CPU total (utime/stime are monotonic per PID), so a
 * short-lived renderer still shows up in the CPU-seconds figure.
 */

import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateConfig } from "../../src/config.ts";
import { browserHostSettings } from "../../src/browser/runtime.ts";
import { createIsolatedBrowserRuntime } from "../../src/browser/isolated.ts";
import type { Logger } from "../../src/types.ts";

const WARM_ITERATIONS = Number(process.env.BROWSER_BENCH_ITERATIONS ?? "6");
const CLK_TCK = 100; // getconf CLK_TCK on this host; USER_HZ is fixed at kernel build.
const PAGE_SIZE = 4096; // getconf PAGESIZE.
const SAMPLE_INTERVAL_MS = 100;

// Quiet unless something goes wrong: the report is the only thing on stdout.
const logger = (() => {
  const emit = (level: string) => (msg: unknown, meta?: unknown) => {
    if (level === "debug" || level === "info") return;
    process.stderr.write(`[browser-bench:${level}] ${String(msg)}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`);
  };
  const log = { info: emit("info"), warn: emit("warn"), error: emit("error"), debug: emit("debug"), child() { return log; } };
  return log as unknown as Logger;
})();

interface ProcStat {
  ppid: number;
  cpuTicks: number;
  rssPages: number;
}

/**
 * Which browser binary actually ran. BetterWright picks its backend at launch
 * (native BetterChromium fork vs managed CloakBrowser) and, on Linux, that
 * choice depends on a /dev/dri probe the sandbox's minimal --dev can defeat.
 * A benchmark number is only comparable once you know which one produced it,
 * so the sampler resolves the executable of every process in the host's tree
 * and the report names the browser binaries it saw. This reads /proc only; it
 * changes no launch behaviour.
 */
function classifyBrowserBinary(exe: string): string | null {
  const lower = exe.toLowerCase();
  if (lower.includes("betterchromium")) return exe; // 1.8.x native fork
  if (lower.includes("cloakbrowser")) return exe; // managed compatibility backend
  if (lower.includes("obscura")) return exe; // 1.7.x resident DOM runtime
  if (/\/(?:chrome|chromium|headless_shell)$/.test(lower)) return exe; // any other Chromium
  return null;
}

function readProcStat(pid: number): ProcStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces and parens; everything after the final ')' is fixed-width.
    const rest = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    // rest[0] = state (field 3). utime=field14 -> rest[11], stime=field15 -> rest[12], rss=field24 -> rest[21].
    const ppid = Number(rest[1]);
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const rssPages = Number(rest[21]);
    if (!Number.isFinite(ppid)) return null;
    return { ppid, cpuTicks: utime + stime, rssPages };
  } catch {
    return null;
  }
}

/** Sample the host child + all its descendants: peak tree RSS and per-PID CPU. */
function createTreeSampler(rootPid: number) {
  const cpuByPid = new Map<number, number>();
  const browserBinaries = new Set<string>();
  let peakRssBytes = 0;

  function recordBinary(pid: number): void {
    try {
      // readlink over cmdline: Chromium overwrites its own argv to set a process
      // title, so /proc/<pid>/cmdline is one blob rather than NUL-separated argv.
      // /proc/<pid>/exe is the kernel's record of the file actually executed.
      const exe = readlinkSync(`/proc/${pid}/exe`);
      const classified = classifyBrowserBinary(exe);
      if (classified) browserBinaries.add(classified);
    } catch {
      // A process that exits between readdir and readlink is expected; skip it.
    }
  }

  function sample(): void {
    const stats = new Map<number, ProcStat>();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = readProcStat(Number(entry));
      if (stat) stats.set(Number(entry), stat);
    }
    // Collect rootPid and every transitive child.
    const tree = new Set<number>([rootPid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, stat] of stats) {
        if (!tree.has(pid) && tree.has(stat.ppid)) {
          tree.add(pid);
          grew = true;
        }
      }
    }
    let rssBytes = 0;
    for (const pid of tree) {
      const stat = stats.get(pid);
      if (!stat) continue;
      rssBytes += stat.rssPages * PAGE_SIZE;
      cpuByPid.set(pid, stat.cpuTicks); // monotonic; survives a PID that later exits.
      recordBinary(pid);
    }
    if (rssBytes > peakRssBytes) peakRssBytes = rssBytes;
  }

  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return {
    sample,
    stop() {
      clearInterval(timer);
    },
    peakRssBytes: () => peakRssBytes,
    cpuSeconds: () => [...cpuByPid.values()].reduce((sum, ticks) => sum + ticks, 0) / CLK_TCK,
    browserBinaries: () => [...browserBinaries].sort(),
  };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

const dir = mkdtempSync(join(tmpdir(), "beckett-browser-bench-"));
const server = Bun.serve({
  port: 0,
  fetch() {
    // Deterministic fixture: a visible #content node to wait on and read, plus a
    // button whose click mutates #out so the interaction exercises real DOM work.
    return new Response(
      `<!doctype html><title>Browser lane bench</title>
       <main><h1 id="content">Beckett browser lane benchmark fixture. ${"lorem ipsum ".repeat(40)}</h1>
       <button id="go">Go</button><output id="out"></output></main>
       <script>document.getElementById('go').onclick = () => { document.getElementById('out').textContent = 'clicked'; };</script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const baseUrl = `http://127.0.0.1:${server.port}`;

const previousDir = process.env.BECKETT_DIR;
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const runId = "browser-lane-bench";

let capturedPid = 0;
const spawn = ((options: Parameters<typeof Bun.spawn>[0]) => {
  const child = Bun.spawn(options as Parameters<typeof Bun.spawn>[0]);
  if (!capturedPid && child.pid > 0) capturedPid = child.pid;
  return child;
}) as typeof Bun.spawn;

// Default (unset): Beckett's stock browser_chromium_args, so a plain
// `bun run browser:bench` stays byte-identical to the harness that produced the
// historical numbers. BROWSER_BENCH_CHROMIUM_ARGS swaps in an explicit list so the
// same lane can be measured on a shared arg list both BetterWright versions accept
// without a compatibility drop (1.8.x reserves --disable-software-rasterizer, which
// the shipped default contains). It never edits the shipped default.
//
// Two spellings are honored because both bench harnesses in this repo are still run:
// a JSON array (`["--disable-gpu"]`, used by scripts/bench/betterwright-matrix.sh) and
// a comma-separated list (used by bench-results/run-bench.sh). A leading "[" picks JSON,
// since no Chromium switch starts with one.
const chromiumArgsOverride = (() => {
  const raw = process.env.BROWSER_BENCH_CHROMIUM_ARGS?.trim();
  if (!raw) return undefined;
  if (!raw.startsWith("[")) return raw.split(",").map((arg) => arg.trim()).filter(Boolean);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) {
    throw new Error("BROWSER_BENCH_CHROMIUM_ARGS must be a JSON array of strings");
  }
  return parsed as string[];
})();

const config = validateConfig({
  paths: { beckett_dir: dir },
  quick: {
    browser_profile_dir: "browser/profile",
    browser_eval_timeout_ms: 30_000,
    ...(chromiumArgsOverride ? { browser_chromium_args: chromiumArgsOverride } : {}),
  },
});
const runtime = createIsolatedBrowserRuntime({
  settings: browserHostSettings(config),
  logger,
  backend: "betterwright",
  spawn,
});

// The scripted interaction: navigate, wait for a visible node, click, read the
// DOM, screenshot. Deterministic and identical every iteration so runs compare.
const scriptedInteraction = `
  await page.goto(${JSON.stringify(baseUrl)});
  await page.locator('#content').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Go' }).click();
  const text = await page.locator('#content').innerText();
  const out = await page.locator('#out').innerText();
  await screenshot({ kind: 'question', name: 'bench-warm' });
  return text.length + (out === 'clicked' ? 1 : 0);
`;

let sampler: ReturnType<typeof createTreeSampler> | undefined;
try {
  const coldStarted = performance.now();
  const acquirePromise = runtime.acquire({
    runId,
    channelId: null,
    artifactsDir: join(dir, "browser-agent", runId, "artifacts"),
    controlToken: token,
  });
  // Bun.spawn runs synchronously inside acquire() before its RPC round trips
  // resolve, so the host child PID is available while acquire is still pending.
  // Start sampling now so cold-start CPU/RSS is counted too.
  while (!capturedPid) await Bun.sleep(2);
  sampler = createTreeSampler(capturedPid);
  await acquirePromise;
  const coldAcquireMs = performance.now() - coldStarted;

  const warmSamples: number[] = [];
  const warnings = new Set<string>();
  for (let i = 0; i < WARM_ITERATIONS; i++) {
    const started = performance.now();
    const result = await runtime.evaluate(runId, scriptedInteraction, token);
    warmSamples.push(performance.now() - started);
    for (const warning of result.warnings ?? []) warnings.add(warning);
    if (typeof result.value !== "number" || result.value <= 0) {
      throw new Error(`unexpected scripted-interaction result: ${JSON.stringify(result.value)}`);
    }
  }

  sampler?.sample();
  // Snapshot the cost figures before the identity probe so the probe's own work
  // is not counted against the warm loop it follows.
  const peakRssMb = Number((sampler!.peakRssBytes() / (1024 * 1024)).toFixed(1));
  const cpuSeconds = Number(sampler!.cpuSeconds().toFixed(2));
  const browserBinaries = sampler!.browserBinaries();

  // Second empirical backend witness, independent of argv: a native BetterChromium
  // fork and managed CloakBrowser report different Chrome majors and platforms.
  const identity = await runtime
    .evaluate(
      runId,
      `return await page.evaluate(() => JSON.stringify({
         ua: navigator.userAgent,
         platform: navigator.platform,
         webdriver: navigator.webdriver,
         cores: navigator.hardwareConcurrency,
         webglRenderer: (() => {
           try {
             const gl = document.createElement('canvas').getContext('webgl');
             if (!gl) return null;
             const ext = gl.getExtension('WEBGL_debug_renderer_info');
             return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no-debug-renderer-info';
           } catch (error) { return 'error: ' + String(error); }
         })(),
       }));`,
      token,
    )
    .then((result) => {
      for (const warning of result.warnings ?? []) warnings.add(warning);
      return typeof result.value === "string" ? JSON.parse(result.value) : result.value;
    })
    .catch((error) => ({ error: String(error) }));

  const stats = runtime.stats();
  const report = {
    fixture: baseUrl,
    backend: "betterwright/CloakBrowser (isolated host)",
    betterwrightVersion: (await import("betterwright/package.json", { with: { type: "json" } }).then(
      (mod) => (mod.default as { version?: string }).version,
      () => undefined,
    )) ?? "unknown",
    betterwrightBackendEnv: process.env.BETTERWRIGHT_BACKEND ?? "(unset → auto)",
    chromiumArgs: config.quick.browser_chromium_args,
    browserBinaries,
    identity,
    warnings: [...warnings],
    headless: config.quick.browser_headless,
    warmIterations: WARM_ITERATIONS,
    coldAcquireMs: Number(coldAcquireMs.toFixed(1)),
    warmEvalMs: {
      min: Number(Math.min(...warmSamples).toFixed(1)),
      p50: Number(percentile(warmSamples, 0.5).toFixed(1)),
      p95: Number(percentile(warmSamples, 0.95).toFixed(1)),
      max: Number(Math.max(...warmSamples).toFixed(1)),
      // The warm loop is bimodal on backends that launch a separate pixel renderer for
      // the first proof screenshot, so a percentile alone hides what a lease really
      // costs. Keep the whole series, and the total the lease actually paid.
      total: Number(warmSamples.reduce((sum, value) => sum + value, 0).toFixed(1)),
      samples: warmSamples.map((value) => Number(value.toFixed(1))),
    },
    // What one lease costs end to end: acquire plus every warm iteration. This is the
    // figure an operator feels, and the one metric no sub-step ordering can flatter.
    leaseTotalMs: Number((coldAcquireMs + warmSamples.reduce((sum, value) => sum + value, 0)).toFixed(1)),
    peakRssMb,
    cpuSeconds,
    hostLaunches: stats.launches,
    evaluations: stats.evaluations,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  sampler?.stop();
  await runtime.release(runId, false).catch(() => undefined);
  await runtime.stop().catch(() => undefined);
  server.stop(true);
  if (previousDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
}
