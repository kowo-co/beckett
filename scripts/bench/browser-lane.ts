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

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  let peakRssBytes = 0;

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

// Unset by default, so a plain `bun run browser:bench` is byte-identical to the harness
// that produced the historical numbers. betterwright 1.8.1 reserves
// --disable-software-rasterizer, which Beckett's default browser_chromium_args contains, so
// comparing 1.8.1 against 1.7.2 needs both versions run on one explicit arg list.
const chromiumArgsOverride = process.env.BROWSER_BENCH_CHROMIUM_ARGS;
const config = validateConfig({
  paths: { beckett_dir: dir },
  quick: {
    browser_profile_dir: "browser/profile",
    browser_eval_timeout_ms: 30_000,
    ...(chromiumArgsOverride === undefined
      ? {}
      : { browser_chromium_args: chromiumArgsOverride.split(",").map((arg) => arg.trim()).filter(Boolean) }),
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
  for (let i = 0; i < WARM_ITERATIONS; i++) {
    const started = performance.now();
    const result = await runtime.evaluate(runId, scriptedInteraction, token);
    warmSamples.push(performance.now() - started);
    if (typeof result.value !== "number" || result.value <= 0) {
      throw new Error(`unexpected scripted-interaction result: ${JSON.stringify(result.value)}`);
    }
  }

  sampler?.sample();
  const stats = runtime.stats();
  const report = {
    fixture: baseUrl,
    backend: "betterwright/CloakBrowser (isolated host)",
    headless: config.quick.browser_headless,
    warmIterations: WARM_ITERATIONS,
    chromiumArgs: config.quick.browser_chromium_args,
    coldAcquireMs: Number(coldAcquireMs.toFixed(1)),
    warmEvalMs: {
      min: Number(Math.min(...warmSamples).toFixed(1)),
      p50: Number(percentile(warmSamples, 0.5).toFixed(1)),
      p95: Number(percentile(warmSamples, 0.95).toFixed(1)),
      max: Number(Math.max(...warmSamples).toFixed(1)),
    },
    peakRssMb: Number((sampler!.peakRssBytes() / (1024 * 1024)).toFixed(1)),
    cpuSeconds: Number(sampler!.cpuSeconds().toFixed(2)),
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
