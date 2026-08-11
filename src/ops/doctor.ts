/**
 * Beckett — `beckett doctor` (`src/ops/doctor.ts`)
 * =======================================================================================
 * The v3 health probe (issue #30): one command on the box that answers "would Beckett work
 * right now, and if not, what exactly is broken?". Rebuilt from the retired v2 `cmdDoctor`
 * skeleton for the ticket-queue world. Every check is a plain data row so the CLI can render
 * human output and `--json` from the same run, and tests can assert each detection.
 *
 * Design notes:
 *   - Binaries are probed with the DAEMON's PATH (the systemd unit's `Environment=PATH=...`),
 *     not the login shell's — this exact gap hid the node-18 pi crash for days.
 *   - Every probe is injectable ({@link DoctorDeps}) so the regression suite can assert the
 *     specific outages this issue was opened for: pi under node 18, a stale pi version, a
 *     leaked worker process on a done ticket, and missing env keys.
 *   - The doctor NEVER throws: a probe that blows up becomes a `fail` row, not a crash.
 */

import { join, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import type { Config, Harness } from "../types.ts";
import { availableHarnesses, preflightFor, type PreflightResult } from "../drivers/index.ts";
import { buildPaths } from "../paths.ts";
import { callBus } from "../shell/control-bus.ts";
import { resolveGitHubAccount } from "../github/owner.ts";
import { GitHubAppAuth, loadGitHubAppCredentials } from "../github/app.ts";

/** One health probe's outcome. `fail` rows flip the report's overall `ok` to false. */
export interface DoctorCheck {
  name: string;
  level: "ok" | "warn" | "fail" | "skip";
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * The PATH the daemon actually runs under — MUST mirror `Environment=PATH=` in
 * `deploy/systemd/beckett-v4.service`. Probing binaries with the login shell's PATH instead is
 * how "pi works when I ssh in" and "pi crashes under systemd" coexisted for days.
 */
export function daemonPath(home: string): string {
  return [join(home, ".local/bin"), join(home, ".bun/bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

/** A row from the process table, plus its cwd where the platform lets us read it (Linux). */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** Full command line, argv joined. */
  command: string;
  cwd: string | null;
}

/** Everything the doctor touches, injectable so tests can stage each outage. */
export interface DoctorDeps {
  config: Config;
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  fetchFn?: typeof fetch;
  /** Run argv with an explicit env; resolves (never rejects) with the exit code + output. */
  exec?: (argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Ask `<bin> --version` for its version without waiting on the child to exit. */
  probeVersion?: (bin: string, opts?: { env?: Record<string, string>; timeoutMs?: number }) => Promise<VersionProbe>;
  preflight?: (harness: Harness) => Promise<PreflightResult>;
  listProcesses?: () => Promise<ProcRow[]>;
  /** Read a file, or null when absent/unreadable. */
  readFile?: (path: string) => string | null;
  /** Ask the live daemon for its `status` over the control bus; null = no daemon answering. */
  busStatus?: () => Promise<Record<string, unknown> | null>;
  /** Free space at a path in KiB, or null when unknowable. */
  diskFreeKb?: (path: string) => Promise<number | null>;
  /** Verify the pinned Chromium artifact actually launches, not merely that its file exists. */
  browserProbe?: () => Promise<{ executable: string; launchable: boolean; error?: string }>;
  /** List a directory's entry names, or null when absent/unreadable. */
  listDir?: (path: string) => string[] | null;
}

// ── default (real) probe implementations ──────────────────────────────────────────────────

async function realExec(
  argv: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(argv, {
      env: { ...(opts.env ?? (process.env as Record<string, string>)) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 15_000);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timeout);
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
}

/**
 * Outcome of a `<bin> --version` probe.
 *
 *   - `ok`      — the binary printed a version. It may or may not have exited; `lingered` says which.
 *   - `timeout` — the binary is there and ran, but printed nothing before the deadline.
 *   - `absent`  — the binary could not be spawned, or exited non-zero without printing a version.
 */
export interface VersionProbe {
  outcome: "ok" | "timeout" | "absent";
  /** First non-empty output line (stdout preferred, stderr as fallback); "" when nothing printed. */
  version: string;
  /** True when the child was still running once we had our answer and the probe had to kill it. */
  lingered: boolean;
}

/**
 * How long a version probe waits for a FIRST LINE of output, down from the old flat 15s exec
 * timeout (issue #149). The probe now resolves on output rather than on exit, so this budget only
 * has to cover process startup, and it is the sole thing standing between one wedged binary and a
 * stalled doctor run. Sized from measurement on the box: `pi --version` takes ~1.0s idle and
 * stretched to 5.3s under ~3.6x CPU oversubscription, so 8s keeps headroom for a busy sweep while
 * still halving the old ceiling. A binary that prints and hangs no longer costs anything near this
 * — it settles on its first line. The harness driver's own preflight keeps its roomier 30s/60s
 * budgets; that, not doctor, is the authoritative castability check.
 */
export const VERSION_PROBE_TIMEOUT_MS = 8_000;
/** Grace between a first output line and giving up on the child's exit code. */
const VERSION_EXIT_GRACE_MS = 250;
/** Grace between SIGTERM and SIGKILL when reaping a child that outlasted its probe. */
const SIGKILL_GRACE_MS = 500;
/** Bounded wait for the output pipes to finish draining once we already have our answer. */
const PUMP_DRAIN_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** SIGTERM, then SIGKILL if it is still alive — a probe must never leak a process. */
async function reap(proc: { exitCode: number | null; signalCode: string | null; exited: Promise<number>; kill: (sig?: number | NodeJS.Signals) => void }): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const exitedFirst = await Promise.race([proc.exited.then(() => true), sleep(SIGKILL_GRACE_MS).then(() => false)]);
  if (exitedFirst) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  await proc.exited.catch(() => 0);
}

/**
 * Probe `<bin> --version`, resolving on the binary's first line of OUTPUT rather than on its exit.
 *
 * Issue #149: `beckett doctor` reported pi as "not runnable on the daemon PATH" because the old
 * probe waited on `proc.exited` and a hung binary is, to `exec`, indistinguishable from a missing
 * one. A harness CLI that prints its version and then fails to drain its event loop is installed
 * and runnable — it just never exits — so the probe answers the question it was actually asked
 * ("what version is on the PATH?") and reaps whatever is left over.
 */
export async function realProbeVersion(
  bin: string,
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<VersionProbe> {
  const timeoutMs = opts.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "--version"], {
      env: { ...(opts.env ?? (process.env as Record<string, string>)) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    // Bun.spawn throws synchronously on ENOENT — the binary genuinely is not on this PATH.
    return { outcome: "absent", version: "", lingered: false };
  }

  // Buffer both streams, and signal as soon as either yields a complete line. Both must be drained
  // regardless: an unread pipe fills and wedges the child we are trying to measure.
  const buffers = { stdout: "", stderr: "" };
  let firstLine = "";
  let signalFirstLine = () => {};
  const sawFirstLine = new Promise<void>((resolve) => {
    signalFirstLine = resolve;
  });
  const pump = async (stream: ReadableStream<Uint8Array> | undefined, into: "stdout" | "stderr") => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buffers[into] += decoder.decode(chunk, { stream: true });
      const nl = buffers[into].indexOf("\n");
      if (!firstLine && nl >= 0) {
        const line = buffers[into].slice(0, nl).trim();
        if (line) {
          firstLine = line;
          signalFirstLine();
        }
      }
    }
  };
  const pumps = Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array> | undefined, "stdout"),
    pump(proc.stderr as ReadableStream<Uint8Array> | undefined, "stderr"),
  ]).catch(() => {});

  /**
   * The version we report. stdout wins over stderr even when stderr spoke first — a binary that
   * warns on stderr before printing its version on stdout must not have the warning read as its
   * version (that would sail into the `minVersion` comparison). Falls back to the first line we
   * saw when neither buffer holds a complete line yet.
   */
  const versionLine = () =>
    buffers.stdout.trim().split("\n")[0]?.trim() || buffers.stderr.trim().split("\n")[0]?.trim() || firstLine;

  /**
   * Bounded wait for the pipes to drain. NEVER await the pumps unbounded: a child that forks and
   * exits leaves its grandchild holding the write end, so the streams never EOF and we would hang
   * exactly where this probe exists to stop hanging.
   */
  const drain = () => Promise.race([pumps, sleep(PUMP_DRAIN_MS)]);

  const EXITED = Symbol("exited");
  const TIMED_OUT = Symbol("timed-out");
  const first = await Promise.race([
    proc.exited.then(() => EXITED),
    sawFirstLine.then(() => "line" as const),
    sleep(timeoutMs).then(() => TIMED_OUT),
  ]);

  if (first === "line") {
    // A version line is not yet proof of health: a binary can print "Unknown option: --version" and
    // exit non-zero. Give it a moment to land an exit code before we call the run good.
    const exited = await Promise.race([proc.exited.then(() => true), sleep(VERSION_EXIT_GRACE_MS).then(() => false)]);
    if (!exited) {
      await reap(proc);
      await drain();
      return { outcome: "ok", version: versionLine(), lingered: true };
    }
  } else if (first === TIMED_OUT) {
    await reap(proc);
    await drain();
    const line = versionLine();
    // Output without a trailing newline still answers the question; silence does not.
    return line ? { outcome: "ok", version: line, lingered: true } : { outcome: "timeout", version: "", lingered: true };
  }

  // The child exited on its own: its exit code is the honest verdict.
  await drain();
  const code = await proc.exited;
  const line = versionLine();
  if (code !== 0) return { outcome: "absent", version: line, lingered: false };
  return { outcome: "ok", version: line, lingered: false };
}

/** `ps` sweep for harness-looking processes; cwd via /proc on Linux (null elsewhere). */
async function realListProcesses(): Promise<ProcRow[]> {
  const { code, stdout } = await realExec(["ps", "axo", "pid=,ppid=,args="]);
  if (code !== 0) return [];
  const rows: ProcRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    let cwd: string | null = null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      /* not Linux, or the process died / isn't ours */
    }
    rows.push({ pid, ppid: Number(m[2]), command: m[3]!.trim(), cwd });
  }
  return rows;
}

function realReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function realListDir(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

async function realDiskFreeKb(path: string): Promise<number | null> {
  const { code, stdout } = await realExec(["df", "-Pk", path]);
  if (code !== 0) return null;
  const cols = stdout.trim().split("\n").at(-1)?.trim().split(/\s+/);
  const avail = Number(cols?.[3]);
  return Number.isFinite(avail) ? avail : null;
}

async function realBrowserProbe(): Promise<{ executable: string; launchable: boolean; error?: string }> {
  try {
    const { chromium } = await import("playwright");
    const executable = chromium.executablePath();
    if (!existsSync(executable)) return { executable, launchable: false, error: "browser binary is missing" };
    const browser = await chromium.launch({ headless: true, channel: "chromium", timeout: 15_000 });
    await browser.close();
    return { executable, launchable: true };
  } catch (error) {
    return { executable: "unknown", launchable: false, error: (error as Error).message };
  }
}

// ── .env / .env.example parsing ────────────────────────────────────────────────────────────

/** Keys declared in a dotenv-shaped body; a same-line `# optional` marks the key optional. */
export function parseEnvInventory(body: string): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    if (!m) continue;
    (/#\s*optional/i.test(line) ? optional : required).push(m[1]!);
  }
  return { required, optional };
}

function envKeys(body: string): Set<string> {
  const keys = new Set<string>();
  for (const line of body.split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

// ── the doctor ─────────────────────────────────────────────────────────────────────────────

/** Registry-driven so a newly-registered driver's stray processes are recognized without an edit. */
const KNOWN_HARNESSES: Harness[] = availableHarnesses();

/** Compare the numeric core of semver-shaped CLI output (for example, `v22.19.0`). */
function semverGte(raw: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/v?(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const current = parse(raw);
  const wanted = parse(minimum);
  if (!current || !wanted) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > wanted[index]!) return true;
    if (current[index]! < wanted[index]!) return false;
  }
  return true;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const config = deps.config;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const exec = deps.exec ?? realExec;
  const probeVersion = deps.probeVersion ?? realProbeVersion;
  const preflight = deps.preflight ?? ((h: Harness) => preflightFor(h, config, { force: true }));
  const listProcesses = deps.listProcesses ?? realListProcesses;
  const readFile = deps.readFile ?? realReadFile;
  const listDir = deps.listDir ?? realListDir;
  const diskFreeKb = deps.diskFreeKb ?? realDiskFreeKb;
  const browserProbe = deps.browserProbe ?? realBrowserProbe;
  const paths = buildPaths(config);
  const busStatus =
    deps.busStatus ??
    (async () => {
      const res = await callBus(join(paths.beckettDir, "control.sock"), "status", {}, 3_000).catch(() => null);
      return res?.ok ? ((res.data ?? {}) as Record<string, unknown>) : null;
    });

  const checks: DoctorCheck[] = [];
  const path = daemonPath(home);
  const binEnv = { PATH: path, HOME: home };

  // 1. Binaries + versions, resolved exactly as systemd resolves them.
  const harnessCfg = config.harness as unknown as Record<string, { bin?: string } | undefined>;
  const binaries: Array<{ bin: string; required: boolean; minVersion?: string; why?: string }> = [
    { bin: "bun", required: true },
    ...(platform === "linux" ? [{ bin: "bwrap", required: true }] : []),
    ...(platform === "linux" ? [{ bin: "prlimit", required: true }] : []),
    {
      bin: "node",
      required: true,
      ...(config.harness.pi.enabled
        ? {
            minVersion: "22.19.0",
            why: "the current Pi package requires node >= 22.19.0",
          }
        : {}),
    },
    { bin: harnessCfg.claude?.bin || "claude", required: true },
    ...(config.harness.codex.enabled
      ? [{ bin: harnessCfg.codex?.bin || "codex", required: true }]
      : []),
    ...(config.harness.pi.enabled
      ? [{ bin: harnessCfg.pi?.bin || "pi", required: true }]
      : []),
    { bin: "gh", required: false },
    { bin: "cloudflared", required: false },
  ];
  for (const b of binaries) {
    const r = await probeVersion(b.bin, { env: binEnv, timeoutMs: VERSION_PROBE_TIMEOUT_MS });
    const version = r.version;
    if (r.outcome === "absent") {
      checks.push({
        name: `binary: ${b.bin}`,
        level: b.required ? "fail" : "warn",
        detail: `not runnable on the daemon PATH (${path})`,
      });
      continue;
    }
    if (r.outcome === "timeout") {
      // Installed but silent. That is a genuine anomaly and worth a row, but it is NOT the same
      // outage as a missing binary, and it is indistinguishable from plain CPU starvation on a busy
      // box — so it warns rather than flipping the whole report to UNHEALTHY (issue #149).
      checks.push({
        name: `binary: ${b.bin}`,
        level: "warn",
        detail: `found on the daemon PATH (${path}) but printed no version within ${Math.round(VERSION_PROBE_TIMEOUT_MS / 1000)}s - the probe timed out and killed it; the binary may be wedged or the box may be starved`,
      });
      continue;
    }
    if (b.minVersion !== undefined) {
      if (!semverGte(version, b.minVersion)) {
        checks.push({
          name: `binary: ${b.bin}`,
          level: "fail",
          detail: `${version || "unknown version"} on the daemon PATH but ${b.bin} >= ${b.minVersion} is required - ${b.why}`,
        });
        continue;
      }
    }
    checks.push({
      name: `binary: ${b.bin}`,
      level: "ok",
      detail: r.lingered ? `${version} (printed its version but did not exit; the probe killed it)` : version,
    });
  }
  // The CLI shim every worker skill invokes (`beckett gh`, `beckett browser`, …). It is host
  // state written by install.sh, NOT started by systemd — the daemon runs `bun src/shell/main.ts`
  // directly — so a box can pass every check above while workers die on `beckett: command not
  // found` (the desktop migration did exactly this).
  {
    const shim = await exec(["beckett", "version"], { env: binEnv, timeoutMs: VERSION_PROBE_TIMEOUT_MS });
    const version = shim.stdout.trim().split("\n")[0] ?? "";
    checks.push(shim.code === 0 && version
      ? { name: "cli: beckett", level: "ok", detail: version }
      : {
          name: "cli: beckett",
          level: "fail",
          detail: `\`beckett version\` is not runnable on the daemon PATH (${path}) - every worker skill calls this CLI; recreate the ~/.local/bin/beckett shim (install.sh writes it: exec bun ~/beckett/src/cli/beckett.ts)`,
        });
  }
  if (platform === "linux") {
    const sandbox = await exec(
      ["bwrap", "--unshare-all", "--share-net", "--die-with-parent", "--ro-bind", "/", "/", "/bin/true"],
      { env: binEnv, timeoutMs: 15_000 },
    );
    checks.push(sandbox.code === 0
      ? { name: "browser: process sandbox", level: "ok", detail: "bubblewrap user namespace works" }
      : {
          name: "browser: process sandbox",
          level: "fail",
          detail: `bubblewrap cannot create the browser sandbox: ${(sandbox.stderr || sandbox.stdout).trim() || `exit ${sandbox.code}`}`,
        });
  }
  // The package, browser download, and Linux shared libraries are separate artifacts. Launching a
  // real process catches all three before the first computer-use request does.
  try {
    const probe = await browserProbe();
    checks.push(probe.launchable
      ? { name: "browser: chromium", level: "ok", detail: probe.executable }
      : {
          name: "browser: chromium",
          level: "fail",
          detail: `${probe.error ?? "launch failed"} - run bun x playwright install --no-shell chromium and, on Linux, sudo bun x playwright install-deps chromium`,
        });
  } catch (err) {
    checks.push({ name: "browser: chromium", level: "fail", detail: `Playwright unavailable: ${(err as Error).message}` });
  }
  // The managed CloakBrowser binary the BetterWright backend launches inside the bubblewrap
  // sandbox. With the cache absent the host still comes up ("host ready") and then every session
  // dies at launch with "worker exited unexpectedly" — so probe the artifact, not the host.
  if (platform === "linux") {
    const cloakDir = env.CLOAKBROWSER_CACHE_DIR?.trim() || join(home, ".cloakbrowser");
    const managed = (listDir(cloakDir) ?? []).filter((entry) => entry.startsWith("chromium-"));
    checks.push(managed.length > 0
      ? { name: "browser: cloakbrowser", level: "ok", detail: `${join(cloakDir, managed[0]!)}` }
      : {
          name: "browser: cloakbrowser",
          level: "fail",
          detail: `no managed CloakBrowser binary under ${cloakDir} - BetterWright sessions die at launch without it; run bun x betterwright setup --cloak-only (deploy-prod.sh runs this on every deploy)`,
        });
  }

  // 2. Harness preflights (issue #17's checks, forced fresh): auth artifact, version minimum,
  // flags. Disabled optional harnesses are intentionally absent rather than permanently yellow.
  const activeHarnesses: Harness[] = [
    "claude",
    ...(config.harness.pi.enabled ? (["pi"] as Harness[]) : []),
    ...(config.harness.codex.enabled ? (["codex"] as Harness[]) : []),
  ];
  for (const h of activeHarnesses) {
    try {
      const r = await preflight(h);
      checks.push(
        r.ok
          ? { name: `preflight: ${h}`, level: "ok", detail: "usable" }
          : r.cooledUntil
            ? {
                // A rate-limit cooldown (#133) is expected + self-healing, not a broken box: warn,
                // not fail, so it never flips the report red, and name the expiry so the state is
                // visible instead of pi reading as merely "unusable".
                name: `preflight: ${h}`,
                level: "warn",
                detail: `rate-limit cooldown until ${new Date(r.cooledUntil).toISOString()} — casts route to the substitute; auto-clears when quota resets`,
              }
            : { name: `preflight: ${h}`, level: "fail", detail: r.problems.join("; ") },
      );
    } catch (err) {
      checks.push({ name: `preflight: ${h}`, level: "fail", detail: `preflight crashed: ${(err as Error).message}` });
    }
  }

  // 3. Live token probes — the only honest answer to "is this credential still good?".
  const probes: Array<{ name: string; key: string; required: boolean; url: (v: string) => string; headers: (v: string) => Record<string, string>; missingDetail?: string }> = [
    {
      name: "token: discord",
      key: "DISCORD_TOKEN",
      required: true,
      url: () => "https://discord.com/api/v10/users/@me",
      headers: (v) => ({ Authorization: `Bot ${v}` }),
    },
    {
      // Legacy path only: with the GitHub App configured this probe is skipped entirely (see the
      // "identity: github app" check below), and a bare box with neither credential fails there.
      name: "token: github",
      key: "GITHUB_PAT",
      required: false,
      url: () => "https://api.github.com/user",
      headers: (v) => ({ Authorization: `Bearer ${v}`, "User-Agent": "beckett-doctor" }),
      missingDetail: "GITHUB_PAT is not set (expected — the GitHub App replaced it)",
    },
    {
      name: "token: cloudflare",
      key: "CLOUDFLARE_API_TOKEN",
      required: false,
      url: () => "https://api.cloudflare.com/client/v4/user/tokens/verify",
      headers: (v) => ({ Authorization: `Bearer ${v}` }),
    },
    {
      // A GET on a Discord webhook URL returns its metadata without posting — a free validity probe.
      name: "token: alert webhook",
      key: "DISCORD_ALERT_WEBHOOK_URL",
      required: false,
      url: (v) => v,
      headers: () => ({}),
      missingDetail: "crash alerts are OFF — set DISCORD_ALERT_WEBHOOK_URL in ~/.beckett/.env",
    },
  ];
  for (const p of probes) {
    const value = env[p.key]?.trim();
    if (!value) {
      checks.push({
        name: p.name,
        level: p.required ? "fail" : "warn",
        detail: p.missingDetail ?? `${p.key} is not set`,
      });
      continue;
    }
    try {
      const res = await fetchFn(p.url(value), { headers: p.headers(value), signal: AbortSignal.timeout(10_000) });
      if (res.ok && p.name === "token: github") {
        const body = await res.json().catch(() => null) as { login?: unknown } | null;
        const login = typeof body?.login === "string" ? body.login.trim() : "";
        const expected = resolveGitHubAccount(config, env);
        if (!login) {
          checks.push({ name: p.name, level: "fail", detail: `HTTP ${res.status} but GitHub returned no account login` });
        } else if (login.toLowerCase() !== expected.toLowerCase()) {
          checks.push({
            name: p.name,
            level: "fail",
            detail: `PAT belongs to ${login}, but the configured authenticated account is ${expected}`,
          });
        } else {
          checks.push({ name: p.name, level: "ok", detail: `HTTP ${res.status} as ${login}` });
        }
        continue;
      }
      checks.push(
        res.ok
          ? { name: p.name, level: "ok", detail: `HTTP ${res.status}` }
          : { name: p.name, level: "fail", detail: `HTTP ${res.status} — the credential is present but rejected` },
      );
    } catch (err) {
      checks.push({ name: p.name, level: "fail", detail: `probe failed: ${(err as Error).message}` });
    }
  }

  // 3c. GitHub identity. Since #114 Beckett is a GitHub App owned by kowo-co, not a machine
  // account: the live question is no longer "is the PAT valid?" but "can the app still sign a
  // JWT, and who has installed it?". A half-configured app (id without a key) throws at load —
  // that is a fail, not a skip, because it looks exactly like "GitHub isn't set up here".
  {
    let appCreds: ReturnType<typeof loadGitHubAppCredentials> = null;
    let configError: string | null = null;
    try {
      appCreds = loadGitHubAppCredentials(env);
    } catch (err) {
      configError = (err as Error).message;
    }
    if (configError) {
      checks.push({ name: "identity: github app", level: "fail", detail: configError });
    } else if (!appCreds) {
      checks.push(
        env.GITHUB_PAT?.trim()
          ? {
              name: "identity: github app",
              level: "warn",
              detail:
                "no GitHub App configured — still on the legacy PAT. Set GITHUB_APP_ID + " +
                "GITHUB_APP_PRIVATE_KEY_PATH (deploy/github-app.md)",
            }
          : {
              name: "identity: github app",
              level: "fail",
              detail:
                "no GitHub credentials at all — set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH " +
                "in ~/.beckett/.env (deploy/github-app.md)",
            },
      );
    } else {
      try {
        const auth = new GitHubAppAuth(appCreds, { fetchImpl: fetchFn });
        const meta = await auth.appMetadata();
        const installs = await auth.listInstallations();
        checks.push({
          name: "identity: github app",
          level: "ok",
          detail:
            `${meta.slug}[bot] (app ${meta.id}, owner ${meta.owner}) — ` +
            `${installs.length} installation(s): ${installs.map((i) => i.account).join(", ") || "none yet"}`,
        });
        // A signed JWT proves the key; a minted installation token proves the whole chain.
        const home = appCreds.installationId ?? installs[0]?.id;
        if (home) {
          const tok = await auth.tokenForInstallation(home);
          checks.push({
            name: "identity: github token",
            level: "ok",
            detail: `installation ${home} token minted, expires ${tok.expiresAt} (${tok.repositorySelection} repos)`,
          });
        } else {
          checks.push({
            name: "identity: github token",
            level: "warn",
            detail: `nobody has installed the app yet — share ${await auth.installUrl()}`,
          });
        }
      } catch (err) {
        checks.push({ name: "identity: github app", level: "fail", detail: (err as Error).message });
      }
    }
  }

  // 4. Env completeness: the committed `.env.example` is the key inventory; drift is a finding.
  const examplePath = join(import.meta.dir, "..", "..", ".env.example");
  const example = readFile(examplePath);
  const envBody = readFile(join(paths.beckettDir, ".env"));
  if (!example) {
    checks.push({ name: "env: inventory", level: "skip", detail: `.env.example not found at ${examplePath}` });
  } else if (envBody === null) {
    checks.push({ name: "env: inventory", level: "fail", detail: `no ${join(paths.beckettDir, ".env")} — every secret is missing` });
  } else {
    const inv = parseEnvInventory(example);
    const present = envKeys(envBody);
    const missingReq = inv.required.filter((k) => !present.has(k));
    const missingOpt = inv.optional.filter((k) => !present.has(k));
    const undocumented = [...present].filter((k) => !inv.required.includes(k) && !inv.optional.includes(k));
    if (missingReq.length > 0) {
      checks.push({ name: "env: required keys", level: "fail", detail: `missing: ${missingReq.join(", ")}` });
    } else {
      checks.push({ name: "env: required keys", level: "ok", detail: `all ${inv.required.length} present` });
    }
    if (missingOpt.length > 0) {
      // Informational, not a warn: optional means optional — a permanently-yellow line here
      // would train people to ignore the warns that matter.
      checks.push({ name: "env: optional keys", level: "skip", detail: `${missingOpt.length} not set (optional): ${missingOpt.join(", ")}` });
    }
    if (undocumented.length > 0) {
      checks.push({ name: "env: undocumented keys", level: "warn", detail: `in .env but not .env.example: ${undocumented.join(", ")} — document or remove` });
    }
  }

  // 5. Process hygiene: harness processes systemd/the dispatcher don't know about are leaks.
  try {
    const projectsRoot = env.BECKETT_PROJECTS_ROOT?.trim() || join(home, "Projects");
    const ledgerRaw = readFile(join(paths.beckettDir, "dispatcher-state.json"));
    const ledgerPids = new Set<number>();
    if (ledgerRaw) {
      try {
        const parsed = JSON.parse(ledgerRaw) as { liveWorkers?: Record<string, { pid?: number }> };
        for (const w of Object.values(parsed.liveWorkers ?? {})) {
          if (typeof w.pid === "number" && w.pid > 0) ledgerPids.add(w.pid);
        }
      } catch {
        /* unreadable ledger → treat as empty */
      }
    }
    const harnessBins = new Set(
      KNOWN_HARNESSES.map((h) => basename(harnessCfg[h]?.bin || h)),
    );
    const looksLikeHarness = (command: string): boolean => {
      const argv = command.split(/\s+/);
      // Direct (`claude -p ...`) or interpreter-wrapped (`node /path/to/pi ...`) invocations.
      return harnessBins.has(basename(argv[0] ?? "")) || (argv[1] !== undefined && harnessBins.has(basename(argv[1])));
    };
    const strays: string[] = [];
    let orphaned = 0;
    for (const proc of await listProcesses()) {
      if (!looksLikeHarness(proc.command)) continue;
      const inProjects = proc.cwd !== null && proc.cwd.startsWith(projectsRoot);
      if (proc.ppid === 1 && inProjects) {
        orphaned += 1;
        strays.push(`pid ${proc.pid} ORPHANED (ppid=1, cwd ${proc.cwd})`);
      } else if (inProjects && !ledgerPids.has(proc.pid)) {
        strays.push(`pid ${proc.pid} not in the dispatcher ledger (cwd ${proc.cwd})`);
      }
    }
    if (strays.length > 0) {
      checks.push({
        name: "processes: harness leaks",
        level: orphaned > 0 ? "fail" : "warn",
        detail: strays.join("; "),
      });
    } else {
      checks.push({ name: "processes: harness leaks", level: "ok", detail: "no stray harness processes" });
    }
  } catch (err) {
    checks.push({ name: "processes: harness leaks", level: "warn", detail: `sweep failed: ${(err as Error).message}` });
  }

  // 6. Is the daemon itself alive and answering?
  try {
    const status = await busStatus();
    if (status) {
      const version = typeof status.version === "string" ? status.version : "?";
      const uptime = typeof status.uptimeSecs === "number" ? `${status.uptimeSecs}s` : "?";
      checks.push({ name: "daemon: control.sock", level: "ok", detail: `answering (v${version}, up ${uptime})` });
    } else {
      checks.push({
        name: "daemon: control.sock",
        level: "fail",
        detail: "not answering — is beckett-v4.service running?",
      });
    }
  } catch (err) {
    checks.push({ name: "daemon: control.sock", level: "fail", detail: (err as Error).message });
  }

  // 7. cloudflared ingress config (the tunnels behind *.0xbeckett.me).
  const cfConfig = join(home, ".cloudflared", "config.yml");
  if (readFile(cfConfig) === null) {
    checks.push({ name: "cloudflared: ingress", level: "skip", detail: `no ${cfConfig}` });
  } else {
    const r = await exec(["cloudflared", "tunnel", "ingress", "validate"], { env: binEnv, timeoutMs: 15_000 });
    checks.push(
      r.code === 0
        ? { name: "cloudflared: ingress", level: "ok", detail: "config.yml validates" }
        : { name: "cloudflared: ingress", level: "fail", detail: (r.stderr || r.stdout).trim().split("\n")[0] ?? "validation failed" },
    );
  }

  // 8. Disk space where all the state lives.
  const freeKb = await diskFreeKb(existsSync(paths.beckettDir) ? paths.beckettDir : home);
  if (freeKb === null) {
    checks.push({ name: "disk: ~/.beckett", level: "skip", detail: "df unavailable" });
  } else {
    const gb = freeKb / 1024 / 1024;
    const detail = `${gb.toFixed(1)} GB free`;
    checks.push({
      name: "disk: ~/.beckett",
      level: gb < 1 ? "fail" : gb < 5 ? "warn" : "ok",
      detail,
    });
  }

  return { ok: !checks.some((c) => c.level === "fail"), checks };
}

/** Render a report the way a human over ssh wants it: one aligned line per check. */
export function renderReport(report: DoctorReport): string {
  const icon: Record<DoctorCheck["level"], string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = report.checks.map((c) => `${icon[c.level]} ${c.name.padEnd(width)}  ${c.detail}`);
  lines.push("", report.ok ? "healthy — no failing checks" : "UNHEALTHY — fix the ✗ lines above");
  return lines.join("\n");
}
