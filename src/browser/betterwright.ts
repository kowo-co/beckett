/**
 * BetterWright-backed controller used by the isolated computer-use host.
 *
 * BetterWright owns the persistent browser, policy enforcement, and sandbox for
 * model-authored snippets. This adapter keeps Beckett's lease/proof contract at
 * the host boundary without exposing a raw Playwright/CDP handle to the model.
 *
 * BetterWright's session daemon (1.7.1 pinned) runs separate `--session`s
 * concurrently while keeping calls *within* one session strictly ordered (see
 * node_modules/betterwright/docs/sessions.md). This adapter holds a map of
 * concurrent leases — one betterwright session per run — instead of a single
 * global lease. Every per-run guard (profile-budget accounting, per-session
 * download approval, proof capture, and the event ring) is keyed off its own
 * lease so one run can never blind, throttle, or corrupt another.
 *
 * Concurrency is capped (default 3, `BECKETT_BROWSER_MAX_LEASES`). The kill
 * switch `BECKETT_BROWSER_SINGLE_LEASE=1` pins the cap to one lease, restoring
 * the old strictly-single-lease behaviour without a revert.
 *
 * The profile budget is two ceilings, not one, split along who put the bytes there.
 * Beckett's own profile state is held to MAX_PROFILE_BYTES with a per-lease growth
 * allowance. Storage a page filled under the quota the lane granted it — Cache Storage,
 * the HTTP cache, OPFS, IndexedDB — is held to MAX_PROFILE_DISK_BYTES, which is that
 * same advertised quota (storage-quota.ts). Budgeting a page against what it was
 * promised, rather than against Beckett's housekeeping allowance, is what lets a model
 * runner stage several GB of weights and still have a working lane afterwards.
 */

import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { BetterWright, NetworkPolicy, piImageArtifacts } from "betterwright";
import { kindForExtension, openTrustedBrowserAttachment } from "./attachments.ts";
import type { Logger } from "../types.ts";
import { createMeasurementCache, measureDirectoryBytes, pruneChromeProfileCaches } from "./profile-cache.ts";
import { LANE_STORAGE_BYTES } from "./storage-quota.ts";
import type {
  BrowserCheckpoint,
  BrowserEvalCallOptions,
  BrowserEvalResult,
  BrowserHostSettings,
  BrowserLease,
  BrowserPendingCredential,
  BrowserRuntime,
  BrowserRuntimeStats,
} from "./runtime.ts";

const MAX_CODE_CHARS = 100_000;
const MAX_EVENTS = 100;
/** Media paths one snippet may name. Bounds the filesystem work a single call can provoke. */
const MAX_ATTACHMENT_CANDIDATES = 32;
/** Uploads one lease may stage. Bounds the bytes copied into BetterWright's artifact dir. */
const MAX_STAGED_ATTACHMENTS = 32;
/** Not-yet-staged files a permitted root's own reachable media pre-stages, per lease. */
export const MAX_ROOT_PRESTAGED = 8;
/** Directory entries examined while walking a root for pre-staging. Bounds the I/O cost. */
const MAX_ROOT_SCAN_ENTRIES = 200;
/** How deep pre-staging walks under a permitted root. */
const MAX_ROOT_SCAN_DEPTH = 2;
/** Default concurrent-lease cap. A real browser on a real machine, not a fleet. */
const DEFAULT_MAX_LEASES = 3;
/** Absolute upper bound on the cap regardless of configuration. */
const MAX_LEASES_HARD_CAP = 16;
/**
 * Global absolute ceiling for Beckett's own profile state — cookies, logins, history,
 * Chromium's bookkeeping. Storage a page filled under its granted quota is excluded
 * (see isSiteStorageDir), so this stays a measure of what the browser accumulates on
 * Beckett's behalf rather than of what a site was invited to store.
 */
const MAX_PROFILE_BYTES = 512 * 1024 * 1024;
/**
 * Absolute ceiling for the profile's whole on-disk footprint, site storage included, when
 * the lane did not say what it advertised. It is the ceiling of the lane budget
 * (storage-quota.ts): a page told it may keep 32 GiB must not then be refused a lease, or
 * have the bytes deleted out from under it, by a ceiling two orders of magnitude smaller.
 */
const MAX_PROFILE_DISK_BYTES = LANE_STORAGE_BYTES;
/** Set by isolated.ts to the budget this lane advertised to pages; see storage-quota.ts. */
const QUOTA_ENV = "BECKETT_BROWSER_STORAGE_QUOTA_MIB";

/**
 * The whole-footprint ceiling this lane enforces: exactly the quota it advertised through
 * `navigator.storage.estimate()`, which on a tight host is well under the ceiling above.
 *
 * The advertised number and the enforced one must be the same number. CloakBrowser's
 * `--fingerprint-storage-quota` only changes what a page is *told* — Chromium's quota
 * manager keeps accepting writes past it — so this check is the only thing standing
 * between a page and the host's free-space reserve. Reading the figure the host already
 * computed, rather than recomputing it here, is what keeps the two from drifting apart.
 */
function advertisedProfileDiskBytes(env: Record<string, string | undefined>): number {
  const mib = parsePositiveInt(env[QUOTA_ENV]);
  if (mib === undefined) return MAX_PROFILE_DISK_BYTES;
  return Math.min(MAX_PROFILE_DISK_BYTES, mib * 1024 * 1024);
}
/** Per-lease growth allowance for real profile state, from each lease's own baseline. */
const MAX_PROFILE_GROWTH_BYTES = 100 * 1024 * 1024;
/** Prune disposable caches before they can make a dormant profile unavailable. */
const PROFILE_PRUNE_HIGH_WATER_MARK = 0.7;
/**
 * How long one profile-size scan stays authoritative. Steady-state evaluate/capture/checkpoint/
 * restore/release calls inside this window do ZERO directory walks; budget enforcement is
 * therefore delayed by at most this window and never skipped (the first budget check after
 * expiry re-scans). Sticky per-lease breaches (profileBudgetError) are unaffected.
 *
 * A lazy TTL cache rather than the interval-driven watcher in runtime.ts: this adapter lives
 * inside the sandboxed host process, where an interval timer would keep the event loop busy
 * between runs and need lifecycle plumbing through stop(). A TTL cache does no work at all
 * while idle and re-measures on the first call after expiry.
 */
const PROFILE_SCAN_TTL_MS = 10_000;

/** The slice of the betterwright client this adapter drives; injectable for tests. */
export interface BetterWrightClient {
  run(code: string, options?: { session?: string; approvedDownloads?: boolean; note?: string; timeout?: number }): Promise<unknown>;
  closeSession?(session?: string): Promise<unknown>;
  startLiveView?(options?: { session?: string; expose?: "lan" | "local" | "tailscale" }): Promise<{ ok: boolean; running?: boolean; url?: string; error?: string }>;
  stopLiveView?(): Promise<{ ok: boolean; running?: boolean; error?: string }>;
  close(): Promise<void>;
}

interface ActiveLease extends BrowserLease {
  /** BetterWright session this lease is pinned to; one session per run. */
  session: string;
  /** Per-lease event ring — never interleaves with another lease's events. */
  events: string[];
  screenshots: string[];
  /** Validated public path -> BetterWright-owned readable copy. */
  attachments: Map<string, string>;
  /** Named-but-rejected path -> host-side reason, so the snippet can report why. */
  attachmentRefusals: Map<string, string>;
  /** Uploads copied for this lease, held under MAX_STAGED_ATTACHMENTS. */
  stagedAttachments: number;
  /** Set once this lease's permitted roots have been walked for pre-staging. */
  rootsPrestaged: boolean;
  /** Serializes this lease's own calls so they stay strictly ordered. */
  queue: Promise<void>;
  /** Shared-profile size observed when this lease acquired, its growth baseline. */
  profileBytesAtAcquire: number;
  /** Per-lease budget breach; set only for the offending lease, never shared. */
  profileBudgetError: Error | null;
}

interface BetterWrightResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  console?: unknown[];
  events?: unknown[];
  artifacts?: Array<{ path?: unknown; kind?: unknown; media?: unknown }>;
  pages?: Array<{ url?: unknown; title?: unknown; active?: unknown }>;
  durationMs?: unknown;
  warnings?: unknown[];
  challenges?: unknown[];
  skills?: Array<{ name?: unknown; description?: unknown; path?: unknown }>;
  pendingCredential?: unknown;
  [key: string]: unknown;
}

/** Raised when a lease is requested past the concurrency cap. Catchable, never hangs. */
export class BrowserLeaseCapExceededError extends Error {
  readonly cap: number;
  readonly runId: string;
  constructor(cap: number, runId: string) {
    super(`browser lease cap of ${cap} concurrent session(s) reached; cannot acquire run ${runId} until one releases`);
    this.name = "BrowserLeaseCapExceededError";
    this.cap = cap;
    this.runId = runId;
  }
}

export interface CreateBetterWrightRuntimeDeps {
  /** Factory for the betterwright client; defaults to the managed CloakBrowser. */
  createBrowser?: (options: ConstructorParameters<typeof BetterWright>[0]) => BetterWrightClient;
  /** Concurrent-lease cap override; falls back to env / the default of 3. */
  maxLeases?: number;
  /** Kill switch override; pins the cap to a single lease when true. */
  singleLease?: boolean;
  /** Shared-profile size probe; defaults to scanning the betterwright home. */
  measureProfileBytes?: (options?: { excludeSiteStorage?: boolean }) => Promise<number>;
  maxProfileBytes?: number;
  /** Whole-footprint ceiling override, caches included; defaults to the lane budget. */
  maxProfileDiskBytes?: number;
  maxProfileGrowthBytes?: number;
  /** Profile-scan cache window override; 0 disables caching (tests). */
  profileScanTtlMs?: number;
  /** Clock override for the scan cache (tests). */
  now?: () => number;
  /** Environment source for the cap / kill-switch; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** The betterwright adapter plus the multi-lease controls #21.2 wires into routing. */
export interface BetterWrightRuntime extends BrowserRuntime {
  /** Resolved concurrent-lease cap (1 when the kill switch is engaged). */
  readonly maxConcurrentLeases: number;
  /** Session names of the currently live leases. */
  sessions(): string[];
  /**
   * Grant/revoke this lease's download approval. BetterWright receives it on
   * each run as `approvedDownloads`; it never mutates shared launch policy.
   */
  approveDownloads(runId: string, approved?: boolean): void;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function boundedBudget(value: number | undefined, hardLimit: number): number {
  if (value === undefined) return hardLimit;
  if (!Number.isFinite(value) || value <= 0) throw new Error("browser budget overrides must be positive numbers");
  return Math.min(hardLimit, Math.floor(value));
}

export function createBetterWrightRuntime(
  settings: BrowserHostSettings,
  logger: Logger,
  deps: CreateBetterWrightRuntimeDeps = {},
): BetterWrightRuntime {
  // BetterWright keeps its profile and worker state below this dedicated browser
  // directory. The host itself remains lease-scoped, so a parked question keeps
  // the same BetterWright session alive while cookies persist between leases.
  const home = join(resolve(settings.profileDir), "betterwright");
  const env = deps.env ?? process.env;
  const killSwitch = deps.singleLease ?? isTruthyEnv(env.BECKETT_BROWSER_SINGLE_LEASE);
  const configuredMax = deps.maxLeases ?? parsePositiveInt(env.BECKETT_BROWSER_MAX_LEASES) ?? DEFAULT_MAX_LEASES;
  const maxLeases = killSwitch ? 1 : Math.min(MAX_LEASES_HARD_CAP, Math.max(1, configuredMax));
  const maxProfileBytes = boundedBudget(deps.maxProfileBytes, MAX_PROFILE_BYTES);
  const maxProfileDiskBytes = boundedBudget(deps.maxProfileDiskBytes, advertisedProfileDiskBytes(env));
  const maxProfileGrowthBytes = boundedBudget(deps.maxProfileGrowthBytes, MAX_PROFILE_GROWTH_BYTES);
  const profileRoot = resolve(settings.profileDir);
  // The scan short-circuits at the ceiling it is being measured against. Using the
  // smaller one for a cache-inclusive scan would report a 5 GB CacheStorage as exactly
  // the ceiling plus a byte, and every acquire would refuse the lease.
  const measureProfileBytes = deps.measureProfileBytes
    ?? ((options) => measureDirectoryBytes(
      profileRoot,
      (options?.excludeSiteStorage ? maxProfileBytes : maxProfileDiskBytes) + 1,
      options,
    ));
  const scanCache = createMeasurementCache({ ttlMs: deps.profileScanTtlMs ?? PROFILE_SCAN_TTL_MS, now: deps.now });
  /** TTL-cached scan used on the per-call hot path; acquire() measures fresh and seeds it. */
  const cachedProfileBytes = (options?: { excludeSiteStorage?: boolean }) =>
    scanCache.measure(options?.excludeSiteStorage ? "profile-state" : "disk", () => measureProfileBytes(options));

  const createBrowser = deps.createBrowser ?? ((options) => new BetterWright(options) as unknown as BetterWrightClient);
  const browser = createBrowser({
    home,
    // `browserFlavor` on the client is a reported "cloak" constant, not a settable
    // option, and `betterwright setup` provisions its own signed CloakBrowser binary,
    // so the host neither picks a browser flavor nor hands in a Playwright executable
    // path. Since 1.7.0 headless sessions default to the resident Obscura engine;
    // isolated.ts binds the host's ~/.betterwright/obscura install into the sandbox
    // and points BETTERWRIGHT_OBSCURA_ROOT at it when it exists, falling back to the
    // Chromium/Cloak compatibility backend when it does not (implicit discovery of an
    // absent install returns null upstream).
    headless: settings.headless,
    defaultTimeout: Math.max(5, Math.ceil(settings.evalTimeoutMs / 1_000)),
    // Host-level Chromium tuning (1.7.1): appended to the managed launch args. Config-owned;
    // the zod default disables the GPU process on this GPU-less host (docs/betterwright.md #92).
    ...(settings.chromiumArgs !== undefined ? { chromiumArgs: settings.chromiumArgs } : {}),
    // Explicit, not implied: park pages between executions so idle tabs stop burning CPU.
    parkBackgroundPages: settings.parkBackgroundPages ?? true,
    // Pin the open private-network and loopback defaults explicitly so Beckett's
    // local/intranet access survives future upgrades.
    policy: new NetworkPolicy({ allowLoopback: true, allowPrivateNetwork: true }),
    // This is a launch-only setting. `ask` gates each download on the
    // `approvedDownloads` bit supplied with that specific session run.
    // Changing it after launch hot-restarts BetterWright's shared worker.
    downloadPolicy: "ask",
    publicSearchPolicy: "block",
  });

  // Keyed by BetterWright session name (currently the unique run id), never by
  // a global active slot. Requests resolve the same deterministic session name.
  const leases = new Map<string, ActiveLease>();
  // Session-scoped download approval. This is intentionally a set rather than
  // browser configuration: every `run` gets only its own session's bit.
  const downloadReferences = new Set<string>();
  // Sessions currently being live-viewed; the shared server stops when the last one goes.
  const liveViewRuns = new Set<string>();
  let stopped = false;
  let launches = 0;
  let evaluations = 0;
  let totalEvalMs = 0;
  let pages = 0;

  function requireLease(runId: string): ActiveLease {
    const lease = leases.get(runId);
    if (!lease) throw new Error(`browser lease ${runId} is not active`);
    return lease;
  }

  function pushLeaseEvent(lease: ActiveLease, message: string): void {
    lease.events.push(message.length > 500 ? `${message.slice(0, 497)}...` : message);
    while (lease.events.length > MAX_EVENTS) lease.events.shift();
  }

  /** Chain this lease's work so calls within one lease stay strictly ordered. */
  function runOnLease<T>(lease: ActiveLease, task: () => Promise<T>): Promise<T> {
    const next = lease.queue.then(task, task);
    lease.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function enforceProfileBudget(lease: ActiveLease): Promise<void> {
    // A lease that already tripped stays tripped until it releases; re-scanning
    // cannot un-trip it and must never touch another lease's accounting.
    if (lease.profileBudgetError) return;
    // Discount storage a page filled under its granted quota: a media-heavy page (x.com)
    // grows the disposable caches by ~100MB in a lease, and a model runner stages several
    // GB into Cache Storage and OPFS. Neither is Beckett's profile state, and both are
    // already bounded by the quota the lane advertised. Measuring the rest here — against
    // a like-for-like acquire baseline — keeps the growth allowance and this ceiling
    // tracking what Chromium itself accumulates.
    const profileBytes = await cachedProfileBytes({ excludeSiteStorage: true });
    // Growth allowance is per-lease (its own acquire baseline); the ceiling is
    // global and shared. Whichever binds first wins.
    const storageLimit = Math.min(maxProfileBytes, lease.profileBytesAtAcquire + maxProfileGrowthBytes);
    if (profileBytes > storageLimit) {
      const growthBytes = Math.max(0, profileBytes - lease.profileBytesAtAcquire);
      lease.profileBudgetError = new Error(
        `browser profile storage budget exceeded for run ${lease.runId} (profile=${profileBytes}, lease growth=${growthBytes} bytes)`,
      );
      pushLeaseEvent(lease, `[profile blocked] ${lease.profileBudgetError.message}`);
      return;
    }
    // Site storage is discounted above, so it needs its own bound: the advertised quota.
    // A page may use every byte it was promised and not one more, and it learns that here
    // rather than by filling the host disk.
    const diskBytes = await cachedProfileBytes();
    if (diskBytes > maxProfileDiskBytes) {
      lease.profileBudgetError = new Error(
        `browser profile storage budget exceeded for run ${lease.runId} (profile=${diskBytes} bytes, past the ${maxProfileDiskBytes}-byte storage quota this lane grants)`,
      );
      pushLeaseEvent(lease, `[profile blocked] ${lease.profileBudgetError.message}`);
    }
  }

  function assertProfileHealthy(lease: ActiveLease): void {
    if (lease.profileBudgetError) throw lease.profileBudgetError;
  }

  /** Copy BetterWright images into the run directory and retain their approved source mapping. */
  function copyArtifacts(result: BetterWrightResult, lease: ActiveLease): string[] {
    mkdirSync(lease.artifactsDir, { recursive: true, mode: 0o700 });
    const copied: string[] = [];
    // 1.x exposes screenshot files through the artifact's `MEDIA:`-prefixed
    // `media` field; piImageArtifacts resolves that (and legacy `path`) to real
    // local image paths, so copy those rather than reading `artifact.path`.
    for (const image of piImageArtifacts(result)) {
      if (!existsSync(image.path)) continue;
      const target = join(resolve(lease.artifactsDir), `betterwright-${Date.now()}-${copied.length}-${basename(image.path)}`);
      copyFileSync(image.path, target);
      // Screenshots are mapped eagerly so an agent may pass a previously returned path through a
      // variable. Validate it here with the same realpath/file-shape gate as configured roots.
      const trusted = openTrustedBrowserAttachment(target, [lease.artifactsDir]);
      closeSync(trusted.fd);
      lease.attachments.set(trusted.sourcePath, image.path);
      lease.attachments.set(target, image.path);
      copied.push(target);
    }
    return copied;
  }

  /**
   * Collect the media paths a snippet names, so the host can validate them before it runs.
   *
   * Scanning every string and substitution-free template literal — not just the second argument
   * of a textbook `attachFile("sel", "/path")` — is deliberate: the argument-position regex this
   * replaces missed the spellings the briefing itself invites (a Locator first argument, a path
   * held in a variable), and an unstaged path failed with a refusal that blamed the configured
   * roots. A candidate is only a name here; containment is still decided host-side by
   * openTrustedBrowserAttachment.
   */
  function candidateAttachmentPaths(code: string): string[] {
    const literals = code.matchAll(/"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`([^`\\$]*)`/g);
    const paths = new Set<string>();
    for (const match of literals) {
      const [, double, single, template] = match;
      let value: string | undefined;
      // Browser paths returned in tool results are JSON strings. Supporting the other two
      // spellings keeps normal JavaScript ergonomic without evaluating model-authored code.
      if (double !== undefined) {
        try {
          value = JSON.parse(`"${double}"`) as string;
        } catch {
          continue;
        }
      } else if (single !== undefined) {
        value = single.replace(/\\(['\\])/g, "$1");
      } else {
        value = template;
      }
      // Only absolute paths that already claim an attachable media type reach the filesystem,
      // so an ordinary program's strings never turn into stat/open traffic.
      if (!value || !isAbsolute(value) || !kindForExtension(value)) continue;
      paths.add(value);
      if (paths.size >= MAX_ATTACHMENT_CANDIDATES) break;
    }
    return [...paths];
  }

  /** Every root this lease may upload from: its own artifacts plus the configured roots. */
  function permittedAttachmentRoots(lease: ActiveLease): string[] {
    return [...new Set([resolve(lease.artifactsDir), ...(settings.attachmentRoots ?? []).map((root) => resolve(root))])];
  }

  /**
   * Validate one named path host-side and, when it passes, register it for the bridge.
   *
   * A candidate that fails keeps its reason instead of aborting the call: the scan reaches every
   * media-looking literal, so a string that merely resembles a path must not kill the snippet.
   * The snippet still cannot reach the file — it only ever receives the reason at its attachFile.
   */
  function prepareAttachment(lease: ActiveLease, source: string): void {
    if (lease.attachments.has(source)) return;
    try {
      if (lease.stagedAttachments >= MAX_STAGED_ATTACHMENTS) {
        throw new Error(`this run already staged ${MAX_STAGED_ATTACHMENTS} uploads`);
      }
      stageAttachment(lease, source);
      lease.attachmentRefusals.delete(source);
    } catch (error) {
      const reason = (error as Error).message;
      lease.attachmentRefusals.set(source, reason);
      logger.warn("browser upload candidate refused", { runId: lease.runId, source, reason });
    }
  }

  /** Copy the bytes from the checked descriptor into BetterWright's artifact directory. */
  function stageAttachment(lease: ActiveLease, source: string): void {
    const trusted = openTrustedBrowserAttachment(source, permittedAttachmentRoots(lease));
    try {
      const staged = lease.attachments.get(trusted.sourcePath);
      if (staged) {
        // Already copied under another spelling — alias this one rather than copying twice.
        lease.attachments.set(source, staged);
        return;
      }
      const sessionDir = createHash("sha256").update(lease.session).digest("hex").slice(0, 16);
      const destinationDir = join(home, "artifacts", sessionDir);
      mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
      const destination = join(
        destinationDir,
        `beckett-attach-${randomUUID().slice(0, 8)}${extname(trusted.sourcePath).toLowerCase()}`,
      );
      const output = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (offset < trusted.size) {
          const count = readSync(trusted.fd, buffer, 0, Math.min(buffer.length, trusted.size - offset), offset);
          if (count <= 0) throw new Error("browser attachment ended while copying");
          let written = 0;
          while (written < count) written += writeSync(output, buffer, written, count - written);
          offset += count;
        }
      } finally {
        closeSync(output);
      }
      lease.attachments.set(trusted.sourcePath, destination);
      // The snippet uses the spelling it supplied; retain it as a lookup alias while
      // containment is always decided from trusted.sourcePath after realpath.
      lease.attachments.set(source, destination);
      lease.stagedAttachments++;
    } finally {
      closeSync(trusted.fd);
    }
  }

  /**
   * Stage the lease's own reachable media once, so a path that was never spelled as a literal —
   * interpolated, concatenated, or assembled entirely at runtime — still resolves through the same
   * realpath/magic-byte gate as a named file. Bounded and best-effort: an unreadable directory (a
   * permission error, a root that vanished) is skipped rather than thrown, and the walk stops well
   * short of anything that could make a broad root configuration expensive to scan.
   */
  function prestageRootAttachments(lease: ActiveLease): void {
    if (lease.rootsPrestaged) return;
    lease.rootsPrestaged = true;
    let entriesExamined = 0;
    const found: Array<{ path: string; mtimeMs: number }> = [];
    const walk = (dir: string, depth: number): void => {
      if (entriesExamined >= MAX_ROOT_SCAN_ENTRIES) return;
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (entriesExamined >= MAX_ROOT_SCAN_ENTRIES) return;
        entriesExamined++;
        const full = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (depth < MAX_ROOT_SCAN_DEPTH) walk(full, depth + 1);
          continue;
        }
        if (!dirent.isFile() || !kindForExtension(full) || lease.attachments.has(full)) continue;
        try {
          found.push({ path: full, mtimeMs: statSync(full).mtimeMs });
        } catch {
          // Vanished between readdir and stat — skip it.
        }
      }
    };
    for (const root of permittedAttachmentRoots(lease)) walk(root, 1);
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of found.slice(0, MAX_ROOT_PRESTAGED)) prepareAttachment(lease, entry.path);
  }

  /**
   * Add the narrow file-upload primitive model snippets receive. The public path is a lookup key
   * for a host-validated BetterWright artifact, so it cannot turn into arbitrary filesystem read.
   */
  function attachmentBridge(lease: ActiveLease): string {
    const approved = JSON.stringify(Object.fromEntries(lease.attachments));
    const refusals = JSON.stringify(Object.fromEntries(lease.attachmentRefusals));
    // Naming the roots ends the loop this refusal used to start: an agent that saw only
    // "outside the approved roots" asked a human to widen config that already allowed the file.
    const roots = JSON.stringify(permittedAttachmentRoots(lease).join(", "));
    // Naming a few approved paths too turns a dead end into a one-turn recovery: an agent that
    // misspelled a path can see what actually resolved instead of guessing again blind.
    const knownPaths = [...new Set(lease.attachments.keys())].slice(0, 10);
    const known = knownPaths.length > 0 ? JSON.stringify(knownPaths.join(", ")) : null;
    return `
const attachFile = async (target, sourcePath) => {
  if (typeof sourcePath !== "string") throw new Error("attachFile needs a file path");
  const approvedPath = ${approved}[sourcePath];
  if (typeof approvedPath !== "string") {
    const refusal = ${refusals}[sourcePath];
    throw new Error(
      "attachFile refuses paths outside this run's approved attachment roots"
      + " (" + (refusal || "the host never saw this path; name it as a literal string so the host can validate it") + ")"
      + "; approved roots: " + ${roots}
      ${known ? `+ "; approved paths: " + ${known}` : ""},
    );
  }
  const input = typeof target === "string" ? page.locator(target) : target;
  if (!input || typeof input.setInputFiles !== "function") {
    throw new Error("attachFile target must be a file-input selector or Locator");
  }
  await input.setInputFiles(approvedPath);
  return { attached: sourcePath };
};
`;
  }

  /** Raw evaluation on one lease's session. Callers must already hold the lease queue. */
  async function execute(lease: ActiveLease, code: string, options?: BrowserEvalCallOptions): Promise<BrowserEvalResult> {
    if (!code.trim()) throw new Error("betterwright browser requires non-empty JavaScript");
    if (code.length > MAX_CODE_CHARS) throw new Error(`betterwright browser code exceeds ${MAX_CODE_CHARS} characters`);
    // Validate every path this snippet names before exposing the bridge; anything the host did
    // not approve still fails closed, now with the reason and the roots that actually apply.
    const wantsAttachment = code.includes("attachFile");
    if (wantsAttachment) {
      // Literals keep priority: a file the snippet named directly is never crowded out by the
      // pre-staging cap below.
      for (const source of candidateAttachmentPaths(code)) prepareAttachment(lease, source);
      prestageRootAttachments(lease);
    }
    // Do not alter ordinary program source until this lease attaches something or asks to.
    const bridgedCode = lease.attachments.size > 0 || wantsAttachment
      ? `${attachmentBridge(lease)}\n${code}`
      : code;
    const raw = await browser.run(bridgedCode, {
      session: lease.session,
      approvedDownloads: downloadReferences.has(lease.session),
      ...(options?.note ? { note: options.note } : {}),
      // BetterWright run() timeouts are seconds (constructor defaultTimeout likewise).
      ...(options?.timeoutMs ? { timeout: Math.max(5, Math.ceil(options.timeoutMs / 1_000)) } : {}),
    }) as BetterWrightResult;
    const screenshots = copyArtifacts(raw, lease);
    const summaries = raw.pages ?? [];
    // Include pending host events (such as an acquire-time cache prune) in the
    // next result journal entry, then retain the raw BetterWright events for
    // the bounded internal ring as well.
    const pendingEvents = lease.events.splice(0);
    const events = (raw.events ?? []).map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry));
    for (const entry of events) pushLeaseEvent(lease, entry);
    const consoleLines = (raw.console ?? []).map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry));
    const eventLines = [...pendingEvents, ...events];
    const warnings = (raw.warnings ?? []).filter((entry): entry is string => typeof entry === "string");
    const challenges = Array.isArray(raw.challenges) ? raw.challenges : [];
    const skills = (Array.isArray(raw.skills) ? raw.skills : []).filter(
      (entry): entry is { name: string; description: string; path: string } =>
        !!entry && typeof entry.name === "string" && typeof entry.description === "string" && typeof entry.path === "string",
    );
    const pendingCredential = raw.pendingCredential && typeof raw.pendingCredential === "object"
      && typeof (raw.pendingCredential as { pendingId?: unknown }).pendingId === "string"
      ? raw.pendingCredential as BrowserPendingCredential
      : undefined;
    const result: BrowserEvalResult = {
      value: raw.result,
      pages: summaries.map((entry, index) => ({
        index,
        active: entry.active === true,
        url: typeof entry.url === "string" ? entry.url : "about:blank",
        title: typeof entry.title === "string" ? entry.title : "",
      })),
      elapsedMs: typeof raw.durationMs === "number" ? raw.durationMs : 0,
      // 1.7.1 omits empty envelope fields; do not re-inflate them here.
      ...(consoleLines.length > 0 ? { console: consoleLines } : {}),
      ...(eventLines.length > 0 ? { events: eventLines } : {}),
      ...(screenshots.length > 0 ? { screenshots } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(challenges.length > 0 ? { challenges } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(pendingCredential ? { pendingCredential } : {}),
    };
    pages = result.pages.length;
    evaluations++;
    totalEvalMs += result.elapsedMs;
    if (!raw.ok) throw new Error(raw.error ?? "betterwright browser evaluation failed");
    return result;
  }

  /** Proof/question capture on one lease. Callers must already hold the lease queue. */
  async function captureOnLease(lease: ActiveLease, name: string): Promise<string> {
    const result = await execute(
      lease,
      `return await screenshot({ kind: ${JSON.stringify(name === "proof-auto" ? "proof" : "question")}, name: ${JSON.stringify(name)} })`,
    );
    const screenshot = result.screenshots?.[0];
    if (!screenshot) throw new Error("BetterWright did not produce a screenshot");
    return screenshot;
  }

  function releaseDownloadReference(lease: ActiveLease): void {
    downloadReferences.delete(lease.session);
  }

  const runtime: BetterWrightRuntime = {
    maxConcurrentLeases: maxLeases,

    sessions() {
      return [...leases.values()].map((lease) => lease.session);
    },

    approveDownloads(runId, approved = true) {
      const lease = requireLease(runId);
      if (approved) downloadReferences.add(lease.session);
      else downloadReferences.delete(lease.session);
    },

    async acquire(lease) {
      if (stopped) throw new Error("browser runtime is stopped");
      if (leases.has(lease.runId)) return;
      if (leases.size >= maxLeases) {
        if (maxLeases === 1) {
          const occupying = leases.values().next().value as ActiveLease | undefined;
          throw new Error(`computer-use is busy with run ${occupying?.runId}; retry after it finishes`);
        }
        throw new BrowserLeaseCapExceededError(maxLeases, lease.runId);
      }
      // Reserve the slot synchronously — before any await — so concurrent
      // acquisitions cannot both slip past the cap.
      const active: ActiveLease = {
        ...lease,
        session: lease.runId,
        events: [],
        screenshots: [],
        attachments: new Map(),
        attachmentRefusals: new Map(),
        stagedAttachments: 0,
        rootsPrestaged: false,
        queue: Promise.resolve(),
        profileBytesAtAcquire: 0,
        profileBudgetError: null,
      };
      leases.set(active.session, active);
      launches++;
      try {
        // Cache-inclusive, against the whole-footprint ceiling: this guards real disk,
        // and a lease that legitimately cached gigabytes of assets must still be able to
        // acquire the next one without those bytes being reclaimed first.
        let profileBytes = await measureProfileBytes();
        let cachePruneReclaimed: number | null = null;
        if (profileBytes > maxProfileDiskBytes * PROFILE_PRUNE_HIGH_WATER_MARK && leases.size === 1) {
          // This is before BetterWright starts a session. With another lease live its
          // worker may own the profile, so never risk deleting a cache under Chrome.
          cachePruneReclaimed = (await pruneChromeProfileCaches(profileRoot)).reclaimedBytes;
          profileBytes = await measureProfileBytes();
          // Caches alone may not be enough: a page that staged gigabytes into Cache
          // Storage or OPFS owes none of it back, and a lane with nothing left to reclaim
          // would refuse every lease from here on. Escalate rather than wedge.
          if (profileBytes > maxProfileDiskBytes) {
            cachePruneReclaimed += (await pruneChromeProfileCaches(profileRoot, { includeSiteStorage: true })).reclaimedBytes;
            profileBytes = await measureProfileBytes();
          }
        }
        // Pruning moved bytes under any cached value; the hot path must not keep serving it.
        if (cachePruneReclaimed !== null) scanCache.invalidate();
        if (profileBytes > maxProfileDiskBytes) {
          const pruneDetail = cachePruneReclaimed === null
            ? "cache prune was skipped while another browser lease was active"
            : `cache prune reclaimed ${cachePruneReclaimed} bytes, still over`;
          throw new Error(`browser profile storage budget exceeded for run ${lease.runId} (${pruneDetail}; profile=${profileBytes}, lease growth=0 bytes)`);
        }
        // Both acquire scans are fresh — its prune decisions need current numbers — so seed
        // the hot-path cache with them and a fresh lease's first evaluates walk nothing.
        scanCache.seed("disk", profileBytes);
        // The growth baseline discounts disposable caches so enforceProfileBudget compares
        // like against like; the ceiling/prune checks above deliberately stay cache-inclusive
        // because they guard real on-disk usage.
        active.profileBytesAtAcquire = await measureProfileBytes({ excludeSiteStorage: true });
        scanCache.seed("profile-state", active.profileBytesAtAcquire);
        // Start the BetterWright worker now so unavailable browser setup fails
        // before the agent begins its turn.
        await runOnLease(active, () => execute(active, "return page.url()"));
        if (cachePruneReclaimed !== null) {
          pushLeaseEvent(active, `[profile cache pruned] reclaimed ${cachePruneReclaimed} bytes`);
        }
        logger.info("BetterWright browser lease acquired", {
          runId: lease.runId,
          channelId: lease.channelId,
          session: active.session,
          live: leases.size,
        });
      } catch (error) {
        leases.delete(active.session);
        releaseDownloadReference(active);
        throw error;
      }
    },

    async evaluate(runId, code, _controlToken, options?: BrowserEvalCallOptions) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        await enforceProfileBudget(lease);
        assertProfileHealthy(lease);
        return execute(lease, code, options);
      });
    },

    async capture(runId, name) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        await enforceProfileBudget(lease);
        assertProfileHealthy(lease);
        return captureOnLease(lease, name);
      });
    },

    async liveView(runId, action) {
      if (action === "stop") {
        liveViewRuns.delete(runId);
        if (liveViewRuns.size === 0 && browser.stopLiveView) await browser.stopLiveView();
        return { running: false, url: null };
      }
      const lease = requireLease(runId);
      if (action === "status") {
        // liveViewStatus is not on the narrowed client type; report tracked state.
        return { running: liveViewRuns.has(runId), url: null };
      }
      const expose = settings.liveViewExpose ?? "tailscale";
      if (expose === "off") return { running: false, url: null };
      if (!browser.startLiveView) throw new Error("this betterwright client does not support live view");
      // Idempotent upstream: returns the already-running token-gated server. The
      // session option only picks which session streams first; viewers can switch.
      const status = await browser.startLiveView({ session: lease.session, expose });
      if (!status.ok || !status.url) throw new Error(status.error ?? "live view failed to start");
      liveViewRuns.add(runId);
      return { running: true, url: status.url };
    },

    async checkpoint(runId) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        await enforceProfileBudget(lease);
        assertProfileHealthy(lease);
        const result = await execute(lease, "return pages.map((candidate) => candidate.url())");
        const urls = Array.isArray(result.value) ? result.value.filter((url): url is string => typeof url === "string").slice(0, 8) : [];
        const activeIndex = Math.max(0, result.pages.findIndex((page) => page.active));
        return { urls, activeIndex };
      });
    },

    async restore(runId, checkpoint: BrowserCheckpoint) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        await enforceProfileBudget(lease);
        assertProfileHealthy(lease);
        const urls = checkpoint.urls.filter((url) => /^https?:\/\//i.test(url) || url === "about:blank").slice(0, 8);
        if (urls.length === 0) return;
        await execute(lease, `await Promise.all(${JSON.stringify(urls)}.map((url) => openPage(url))); return pages.length`);
      });
    },

    async release(runId, captureProof) {
      const lease = requireLease(runId);
      return runOnLease(lease, async () => {
        const proofFiles: string[] = [];
        try {
          if (captureProof) {
            await enforceProfileBudget(lease);
            if (!lease.profileBudgetError) proofFiles.push(await captureOnLease(lease, "proof-auto"));
          }
          return proofFiles;
        } catch (error) {
          logger.warn("BetterWright proof capture failed on release", {
            runId,
            error: String((error as Error).message ?? error),
          });
          return proofFiles;
        } finally {
          leases.delete(lease.session);
          releaseDownloadReference(lease);
          liveViewRuns.delete(lease.session);
          if (liveViewRuns.size === 0 && browser.stopLiveView) {
            await browser.stopLiveView().catch((error) => logger.warn("live view stop failed on release", { runId, error: String(error) }));
          }
          if (browser.closeSession) await browser.closeSession(lease.session).catch(() => undefined);
          logger.info("BetterWright browser lease released", { runId: lease.runId, live: leases.size });
        }
      });
    },

    hasLease(runId) {
      return leases.has(runId);
    },

    stats(): BrowserRuntimeStats {
      const first = leases.values().next().value as ActiveLease | undefined;
      return {
        ready: leases.size > 0,
        profileDir: settings.profileDir,
        activeRunId: first?.runId ?? null,
        activeRunIds: [...leases.keys()],
        maxConcurrentLeases: maxLeases,
        pages,
        launches,
        evaluations,
        averageEvalMs: evaluations === 0 ? 0 : Math.round(totalEvalMs / evaluations),
      };
    },

    async stop() {
      stopped = true;
      leases.clear();
      downloadReferences.clear();
      liveViewRuns.clear();
      await browser.close();
    },
  };

  return runtime;
}
