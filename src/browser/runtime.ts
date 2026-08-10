/// <reference lib="dom" />

/**
 * Browser runtime contracts and the local Playwright implementation.
 *
 * Production callers receive the isolated subprocess adapter. The local implementation is the
 * trusted browser controller used only by the browser host and focused integration tests. Model
 * code runs in a disposable evaluator because node:vm is neither a security nor a wall-time
 * boundary.
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Cookie,
  type Download,
  type Frame,
  type Page,
} from "playwright";
import { buildPaths } from "../paths.ts";
import type { Config, Logger } from "../types.ts";
import {
  runBrowserEvaluator,
  type BrowserEvaluatorOutput,
  type BrowserEvaluatorSession,
} from "./evaluator-runner.ts";
import { createIsolatedBrowserRuntime } from "./isolated.ts";
import { isDisposableCacheDir, pruneChromeProfileCaches } from "./profile-cache.ts";
import { sleep, spawnSubprocess, type SpawnedProcess, type SpawnProcess } from "./subprocess.ts";

const MAX_CODE_CHARS = 100_000;
const MAX_EVENTS = 100;
const MAX_SCREENSHOTS_PER_EVAL = 3;
const MAX_RESULT_PAGES = 32;
const MAX_OPEN_PAGES = 32;
const MAX_PAGE_URL_CHARS = 2_048;
const MAX_PAGE_TITLE_CHARS = 512;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOADS_PER_LEASE = 4;
const MAX_PROFILE_BYTES = 512 * 1024 * 1024;
const MAX_PROFILE_GROWTH_BYTES = 100 * 1024 * 1024;
const PROFILE_PRUNE_HIGH_WATER_MARK = 0.7;
const PROFILE_WATCH_MIN_INTERVAL_MS = 100;
const PROFILE_WATCH_MAX_INTERVAL_MS = 2_000;
const CONTROLLER_GUARD_INTERVAL_MS = 100;
const DOWNLOAD_BEHAVIOR_REFRESH_MS = 500;
const MAX_SESSION_COOKIE_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_SESSION_COOKIE_COUNT = 4_096;
const SESSION_COOKIE_SNAPSHOT_NAME = ".beckett-session-cookies.json";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const EVALUATOR_PATH = join(MODULE_DIR, "evaluator.cjs");

export type { BrowserEvaluatorOutput, BrowserEvaluatorSession } from "./evaluator-runner.ts";

export interface BrowserPageSummary {
  index: number;
  active: boolean;
  url: string;
  title: string;
}

/** Skill pack surfaced by betterwright whose autoInject.url matches an open page. */
export interface BrowserSkillHint { name: string; description: string; path: string; }
/** Secret-free metadata for a generated credential still awaiting recovery. */
export interface BrowserPendingCredential {
  pendingId: string;
  origin: string;
  matchMode: string;
  username: string | null;
  label: string | null;
  expiresAt: string | null;
}

export interface BrowserEvalResult {
  value: unknown;
  console?: string[];
  pages: BrowserPageSummary[];
  events?: string[];
  screenshots?: string[];
  /** Trusted PNG screenshots the agent may attach later in this same run. */
  attachments?: string[];
  elapsedMs: number;
  truncated?: boolean;
  /** 1.7.1 envelope passthrough — omitted when empty. */
  warnings?: string[];
  challenges?: unknown[];
  skills?: BrowserSkillHint[];
  pendingCredential?: BrowserPendingCredential;
}

/** Optional per-call evaluation controls threaded from the MCP tool input to BetterWright run(). */
export interface BrowserEvalCallOptions {
  /** Short host-facing status line (live view / status surface). Never evaluated as code. */
  note?: string;
  /** Per-call timeout override in milliseconds; bounded by MAX_BROWSER_EVAL_CALL_TIMEOUT_MS. */
  timeoutMs?: number;
}
/** Hard ceiling for a per-call eval timeout override (5 minutes). */
export const MAX_BROWSER_EVAL_CALL_TIMEOUT_MS = 300_000;
/** Longest note accepted from the model before truncation. */
export const MAX_BROWSER_EVAL_NOTE_CHARS = 300;

export interface BrowserRuntimeStats {
  ready: boolean;
  profileDir: string;
  /** Legacy first active lease; use activeRunIds when concurrent sessions are available. */
  activeRunId: string | null;
  /** Every active lease (one BetterWright session per run). */
  activeRunIds?: string[];
  /** Admission cap exposed to the agent; absent means the legacy single lease. */
  maxConcurrentLeases?: number;
  pages: number;
  launches: number;
  evaluations: number;
  averageEvalMs: number;
}

export interface BrowserLease {
  runId: string;
  channelId: string | null;
  artifactsDir: string;
  /** High-entropy daemon-side capability; never forwarded into the isolated host. */
  controlToken: string;
}

export interface BrowserCheckpoint {
  urls: string[];
  activeIndex: number;
}

export interface BrowserRuntime {
  acquire(lease: BrowserLease): Promise<void>;
  evaluate(runId: string, code: string, controlToken?: string, options?: BrowserEvalCallOptions): Promise<BrowserEvalResult>;
  capture(runId: string, name: string): Promise<string>;
  checkpoint(runId: string): Promise<BrowserCheckpoint>;
  restore(runId: string, checkpoint: BrowserCheckpoint): Promise<void>;
  release(runId: string, captureProof: boolean): Promise<string[]>;
  hasLease(runId: string): boolean;
  stats(): BrowserRuntimeStats;
  stop(): Promise<void>;
}

/** Internal controller API used across the daemon/host boundary. */
export interface BrowserControllerRuntime extends BrowserRuntime {
  prepareEvaluation(runId: string): Promise<BrowserEvaluatorSession>;
  applyEvaluation(runId: string, evaluated: BrowserEvaluatorOutput): Promise<BrowserEvalResult>;
}

export interface BrowserHostSettings {
  profileDir: string;
  artifactsRoot: string;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  launchTimeoutMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  evalTimeoutMs: number;
  maxOutputChars: number;
  /** Global configured roots; each lease adds its own artifactsDir at attachment time. */
  attachmentRoots?: string[];
  /** Extra Chromium switches for the BetterWright-managed launch (betterwright backend only). */
  chromiumArgs?: string[];
  /** Quiet session pages between executions (betterwright backend only; default true). */
  parkBackgroundPages?: boolean;
}

interface ActiveLease extends BrowserLease {
  activePage: Page;
  events: string[];
  screenshots: string[];
  state: Record<string, unknown>;
  pendingDownloads: Set<Promise<void>>;
  downloadBytes: number;
  downloadCount: number;
  downloadGuids: Set<string>;
  profileBytesAtAcquire: number;
}

interface GuardedDownload {
  guid: string;
  lease: ActiveLease;
  suggestedFilename: string;
  receivedBytes: number;
  totalBytes: number;
  canceled: boolean;
  claimed: boolean;
}

interface CdpTargetInfo {
  targetId?: unknown;
  type?: unknown;
  browserContextId?: unknown;
}

interface SessionCookieSnapshot {
  version: 1;
  cookies: Cookie[];
}

interface ScreenshotRedaction {
  changed: number;
  restore(): Promise<void>;
}

interface FrozenScreenshotPage {
  assertUnchanged(): Promise<void>;
  restore(): Promise<void>;
}

type ChromiumChild = SpawnedProcess;

export interface CreateBrowserRuntimeDeps {
  config: Config;
  logger: Logger;
}

export interface CreateLocalBrowserRuntimeDeps {
  settings: BrowserHostSettings;
  logger: Logger;
  launchPersistentContext?: typeof chromium.launchPersistentContext;
  spawn?: SpawnProcess;
  chromiumExecutable?: string;
  /** Test-only budget overrides; production uses the hard constants above. */
  maxDownloadBytes?: number;
  maxDownloadsPerLease?: number;
  maxProfileBytes?: number;
  maxProfileGrowthBytes?: number;
}

export type BrowserBudgetOverrides = Pick<
  CreateLocalBrowserRuntimeDeps,
  "maxDownloadBytes" | "maxDownloadsPerLease" | "maxProfileBytes" | "maxProfileGrowthBytes"
>;

export function browserHostSettings(config: Config): BrowserHostSettings {
  const paths = buildPaths(config);
  const beckettDir = paths.beckettDir;
  const browserRoot = resolve(beckettDir, "browser");
  const configuredProfile = config.quick.browser_profile_dir;
  const profileDir = isAbsolute(configuredProfile)
    ? resolve(configuredProfile)
    : resolve(beckettDir, configuredProfile);
  if (profileDir === browserRoot || !pathIsWithin(browserRoot, profileDir)) {
    throw new Error(`browser profile must be a dedicated directory below ${browserRoot}`);
  }
  assertNoExistingSymlink(browserRoot, profileDir);
  return {
    profileDir,
    artifactsRoot: resolve(beckettDir, "browser-agent"),
    headless: config.quick.browser_headless,
    viewportWidth: config.quick.browser_viewport_width,
    viewportHeight: config.quick.browser_viewport_height,
    launchTimeoutMs: config.quick.browser_launch_timeout_ms,
    actionTimeoutMs: config.quick.browser_action_timeout_ms,
    navigationTimeoutMs: config.quick.browser_navigation_timeout_ms,
    evalTimeoutMs: config.quick.browser_eval_timeout_ms,
    maxOutputChars: config.quick.browser_max_output_chars,
    chromiumArgs: config.quick.browser_chromium_args,
    parkBackgroundPages: config.quick.browser_park_background_pages,
    attachmentRoots: [...new Set([resolve(paths.imagesDir), ...config.quick.browser_attach_roots])],
  };
}

/** The production runtime always crosses an OS process and sandbox boundary. */
export function createBrowserRuntime(deps: CreateBrowserRuntimeDeps): BrowserRuntime {
  const settings = browserHostSettings(deps.config);
  const defaultImagesRoot = resolve(buildPaths(deps.config).imagesDir);
  const widenedRoots = deps.config.quick.browser_attach_roots.filter((root) => resolve(root) !== defaultImagesRoot);
  if (widenedRoots.length > 0) {
    deps.logger.warn("browser attachment access widened beyond the default roots", { roots: widenedRoots });
  }
  return createIsolatedBrowserRuntime({ settings, logger: deps.logger, backend: "betterwright" });
}

/** Keep filenames boring and force every artifact below the trusted per-run directory. */
export function safeArtifactPath(artifactsDir: string, requested: string, extension = ""): string {
  const cleaned = requested
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "artifact";
  const name = extension && !cleaned.toLowerCase().endsWith(extension) ? `${cleaned}${extension}` : cleaned;
  const root = resolve(artifactsDir);
  const target = resolve(root, name);
  if (!pathIsWithin(root, target)) throw new Error("artifact path escaped the run directory");
  return target;
}

/** Bound noisy model-facing strings without corrupting the useful prefix. */
export function truncateBrowserOutput(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars; narrow the query or return less data]`,
    truncated: true,
  };
}

interface PersistentChromiumCommandOptions {
  executable: string;
  profileDir: string;
  origin: string;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

/** Build the controller-owned Chromium command without Playwright's implicit debugging pipe. */
export function buildPersistentChromiumCommand(options: PersistentChromiumCommandOptions): string[] {
  return [
    options.executable,
    `--user-data-dir=${options.profileDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--remote-allow-origins=${options.origin}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-features=Translate,MediaRouter",
    "--disable-popup-blocking",
    "--enable-automation",
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-sandbox",
    `--window-size=${options.viewportWidth},${options.viewportHeight}`,
    ...(options.headless ? ["--headless=new"] : []),
    "about:blank",
  ];
}

/** Local implementation for the isolated browser host and integration tests only. */
export function createLocalBrowserRuntime(deps: CreateLocalBrowserRuntimeDeps): BrowserControllerRuntime {
  const { settings, logger } = deps;
  const usesInjectedLaunch = deps.launchPersistentContext !== undefined;
  const injectedLaunch = deps.launchPersistentContext;
  const spawn = deps.spawn ?? spawnSubprocess;
  const chromiumExecutable = deps.chromiumExecutable ?? chromium.executablePath();
  const profileDir = resolve(settings.profileDir);
  const artifactsRoot = resolve(settings.artifactsRoot);
  const downloadsDir = join(profileDir, "downloads");
  const sessionCookieSnapshotPath = join(profileDir, SESSION_COOKIE_SNAPSHOT_NAME);
  const maxDownloadBytes = boundedBudget(deps.maxDownloadBytes, MAX_DOWNLOAD_BYTES);
  const maxDownloadsPerLease = boundedBudget(deps.maxDownloadsPerLease, MAX_DOWNLOADS_PER_LEASE);
  const maxProfileBytes = boundedBudget(deps.maxProfileBytes, MAX_PROFILE_BYTES);
  const maxProfileGrowthBytes = boundedBudget(deps.maxProfileGrowthBytes, MAX_PROFILE_GROWTH_BYTES);
  const daemonClosers = new WeakMap<BrowserContext, () => Promise<void>>();
  const chromiumTerminations = new WeakMap<ChromiumChild, Promise<void>>();
  const guardedDownloads = new Map<string, GuardedDownload>();
  const deniedBrowserContexts = new Set<string>();
  const targetOrder = new Map<string, number>();

  let context: BrowserContext | null = null;
  let starting: Promise<BrowserContext> | null = null;
  let reserved: BrowserLease | null = null;
  let active: ActiveLease | null = null;
  let stopped = false;
  let launches = 0;
  let evaluations = 0;
  let totalEvalMs = 0;
  let cdpEndpoint: string | null = null;
  let cdpOrigin: string | null = null;
  let downloadCdp: CDPSession | null = null;
  let defaultBrowserContextId: string | null = null;
  let profileWatchTimer: ReturnType<typeof setTimeout> | null = null;
  let controllerGuardTimer: ReturnType<typeof setInterval> | null = null;
  let profileScanPromise: Promise<number> | null = null;
  let controllerGuardRunning = false;
  let profileWatchDelayMs = PROFILE_WATCH_MIN_INTERVAL_MS;
  let profileBytesLastSeen = 0;
  let targetSequence = 0;
  let lastDownloadBehaviorAt = 0;
  let profileBudgetError: Error | null = null;
  let profileBudgetShutdown: Promise<void> | null = null;
  let chromiumChild: ChromiumChild | null = null;
  let currentDaemonClose: (() => Promise<void>) | null = null;

  function pushLeaseEvent(lease: ActiveLease, message: string): void {
    lease.events.push(truncatePlain(message, 500));
    while (lease.events.length > MAX_EVENTS) lease.events.shift();
  }

  function stopLeaseGuards(): void {
    if (profileWatchTimer) clearTimeout(profileWatchTimer);
    profileWatchTimer = null;
    if (controllerGuardTimer) clearInterval(controllerGuardTimer);
    controllerGuardTimer = null;
  }

  async function refreshDownloadBehavior(force = false): Promise<void> {
    const session = downloadCdp;
    if (!session || (!force && Date.now() - lastDownloadBehaviorAt < DOWNLOAD_BEHAVIOR_REFRESH_MS)) return;
    await session.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadsDir,
      eventsEnabled: true,
    });
    lastDownloadBehaviorAt = Date.now();
  }

  function rememberTarget(targetInfo: CdpTargetInfo): void {
    const targetId = targetInfo.targetId;
    if (typeof targetId !== "string" || !targetId || targetOrder.has(targetId)) return;
    targetOrder.set(targetId, ++targetSequence);
  }

  function isDefaultPageTarget(targetInfo: CdpTargetInfo): boolean {
    if (targetInfo.type !== "page") return false;
    return defaultBrowserContextId
      ? targetInfo.browserContextId === defaultBrowserContextId
      : !targetInfo.browserContextId;
  }

  async function enforceControllerBoundaries(forceDownloadBehavior = false): Promise<void> {
    const session = downloadCdp;
    if (!session) return;
    if (controllerGuardRunning) {
      if (forceDownloadBehavior) {
        while (controllerGuardRunning && downloadCdp === session) await sleep(5);
        if (downloadCdp === session) await enforceControllerBoundaries(true);
      }
      return;
    }
    controllerGuardRunning = true;
    try {
      const current = await session.send("Target.getBrowserContexts") as { browserContextIds?: unknown };
      if (Array.isArray(current.browserContextIds)) {
        await Promise.all(current.browserContextIds
          .filter((id): id is string => typeof id === "string")
          .map(async (browserContextId) => {
            deniedBrowserContexts.add(browserContextId);
            if (active) pushLeaseEvent(active, "[browser context blocked] additional contexts are not allowed");
            await session.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
          }));
      }

      const result = await session.send("Target.getTargets") as { targetInfos?: unknown };
      const targetInfos = Array.isArray(result.targetInfos)
        ? result.targetInfos.filter((item): item is CdpTargetInfo => !!item && typeof item === "object")
        : [];
      for (const targetInfo of targetInfos) rememberTarget(targetInfo);
      const liveIds = new Set(
        targetInfos.map((item) => item.targetId).filter((id): id is string => typeof id === "string"),
      );
      for (const targetId of targetOrder.keys()) {
        if (!liveIds.has(targetId)) targetOrder.delete(targetId);
      }
      const defaultPages = targetInfos
        .filter(isDefaultPageTarget)
        .filter((item): item is CdpTargetInfo & { targetId: string } => typeof item.targetId === "string")
        .sort((left, right) => (targetOrder.get(left.targetId) ?? 0) - (targetOrder.get(right.targetId) ?? 0));
      const excess = defaultPages.slice(MAX_OPEN_PAGES);
      if (excess.length > 0 && active) {
        pushLeaseEvent(active, `[tab limit] closed ${excess.length} target(s) above the ${MAX_OPEN_PAGES}-page ceiling`);
      }
      await Promise.all(excess.map(async ({ targetId }) => {
        await session.send("Target.closeTarget", { targetId }).catch(() => undefined);
        targetOrder.delete(targetId);
      }));
      await refreshDownloadBehavior(forceDownloadBehavior);
    } catch {
      // Context close races and Chromium shutdown are handled by the surrounding lease lifecycle.
    } finally {
      controllerGuardRunning = false;
    }
  }

  async function enforceProfileBudget(lease: ActiveLease): Promise<number> {
    if (profileBudgetError || active !== lease) return profileBytesLastSeen;
    if (profileScanPromise) return profileScanPromise;
    const storageLimit = Math.min(maxProfileBytes, lease.profileBytesAtAcquire + maxProfileGrowthBytes);
    profileScanPromise = (async () => {
      // Discount disposable Chromium caches: a media-heavy page grows them by ~100MB in a
      // single lease, which is regenerable churn, not real profile state. Measuring non-cache
      // bytes — against a non-cache acquire baseline — keeps the growth allowance and the
      // ceiling tracking state that actually persists. Purely structural, so it is safe to run
      // against the live browser (no touching the open profile, unlike a mid-lease prune).
      const profileBytes = await allocatedDirectoryBytes(profileDir, storageLimit + 1, { excludeDisposableCache: true });
      profileBytesLastSeen = profileBytes;
      if (active !== lease || profileBudgetError || profileBytes <= storageLimit) return profileBytes;
      const growthBytes = Math.max(0, profileBytes - lease.profileBytesAtAcquire);
      profileBudgetError = new Error(
        `browser profile storage budget exceeded (profile=${profileBytes}, lease growth=${growthBytes} bytes)`,
      );
      pushLeaseEvent(lease, `[profile blocked] ${profileBudgetError.message}`);
      stopLeaseGuards();
      const target = context;
      if (target) {
        profileBudgetShutdown = closeContext(target).finally(() => {
          profileBudgetShutdown = null;
        });
        // The error gate below blocks every subsequent lease operation immediately. Shutdown runs
        // concurrently so an RPC can report the budget violation instead of waiting on Chromium.
        void profileBudgetShutdown;
      }
      return profileBytes;
    })();
    try {
      return await profileScanPromise;
    } finally {
      profileScanPromise = null;
    }
  }

  function assertProfileHealthy(): void {
    if (profileBudgetError) throw profileBudgetError;
  }

  function scheduleProfileWatch(lease: ActiveLease, delayMs: number): void {
    profileWatchTimer = setTimeout(async () => {
      const previousBytes = profileBytesLastSeen;
      const profileBytes = await enforceProfileBudget(lease).catch(() => profileBytesLastSeen);
      if (active !== lease || profileBudgetError) return;
      const storageLimit = Math.min(maxProfileBytes, lease.profileBytesAtAcquire + maxProfileGrowthBytes);
      const growthBudget = Math.max(1, storageLimit - lease.profileBytesAtAcquire);
      const headroom = Math.max(0, storageLimit - profileBytes);
      const fastScan = profileBytes - previousBytes >= 1024 * 1024 || headroom <= Math.max(1024 * 1024, growthBudget / 4);
      profileWatchDelayMs = fastScan
        ? PROFILE_WATCH_MIN_INTERVAL_MS
        : Math.min(PROFILE_WATCH_MAX_INTERVAL_MS, Math.max(250, profileWatchDelayMs * 2));
      scheduleProfileWatch(lease, profileWatchDelayMs);
    }, delayMs);
    profileWatchTimer.unref?.();
  }

  function startLeaseGuards(lease: ActiveLease): void {
    stopLeaseGuards();
    profileWatchDelayMs = PROFILE_WATCH_MIN_INTERVAL_MS;
    scheduleProfileWatch(lease, profileWatchDelayMs);
    controllerGuardTimer = setInterval(() => void enforceControllerBoundaries(), CONTROLLER_GUARD_INTERVAL_MS);
    controllerGuardTimer.unref?.();
  }

  function attachPage(page: Page): void {
    void page.setViewportSize({ width: settings.viewportWidth, height: settings.viewportHeight }).catch(() => undefined);
    page.on("close", () => {
      if (active) pushLeaseEvent(active, `[tab closed] ${page.url()}`);
    });
    page.on("crash", () => {
      if (active) pushLeaseEvent(active, `[tab crashed] ${page.url()}`);
    });
    page.on("pageerror", (error) => {
      if (active) pushLeaseEvent(active, `[page error] ${truncateOneLine(error.message, 300)}`);
    });
    page.on("popup", (popup) => {
      if (active) pushLeaseEvent(active, `[popup opened] ${popup.url() || "about:blank"}`);
    });
    page.on("download", (download) => trackDownload(download));
  }

  function projectedDownloadBytes(lease: ActiveLease): number {
    let projected = lease.downloadBytes;
    for (const guarded of guardedDownloads.values()) {
      if (guarded.lease !== lease || guarded.canceled) continue;
      projected += Math.max(0, guarded.totalBytes - guarded.receivedBytes);
    }
    return projected;
  }

  async function cancelDownloadAcrossContexts(guid: string): Promise<boolean> {
    const session = downloadCdp;
    if (!session) return false;
    let contextIds = [...deniedBrowserContexts];
    try {
      const current = await session.send("Target.getBrowserContexts") as { browserContextIds?: unknown };
      if (Array.isArray(current.browserContextIds)) {
        contextIds = [...new Set([...contextIds, ...current.browserContextIds.filter((id): id is string => typeof id === "string")])];
      }
    } catch {
      // Still try the default context and any context ids observed by the target guard.
    }
    let accepted = false;
    for (const browserContextId of [undefined, ...contextIds]) {
      try {
        await session.send("Browser.cancelDownload", {
          guid,
          ...(browserContextId ? { browserContextId } : {}),
        });
        accepted = true;
      } catch {
        // A guid belongs to exactly one context; the other attempts are expected to fail.
      }
    }
    return accepted;
  }

  async function cancelGuardedDownload(guarded: GuardedDownload, reason: string): Promise<void> {
    if (guarded.canceled) return;
    guarded.canceled = true;
    const accepted = await cancelDownloadAcrossContexts(guarded.guid);
    pushLeaseEvent(
      guarded.lease,
      accepted ? `[download blocked] ${reason}` : `[download guard failed] ${reason}`,
    );
  }

  async function installDownloadProgressGuard(created: BrowserContext): Promise<void> {
    const browser = created.browser();
    if (!browser) throw new Error("persistent Chromium did not expose a browser CDP session");
    const session = await browser.newBrowserCDPSession();
    const browserContexts = await session.send("Target.getBrowserContexts") as {
      defaultBrowserContextId?: unknown;
    };
    defaultBrowserContextId = typeof browserContexts.defaultBrowserContextId === "string"
      ? browserContexts.defaultBrowserContextId
      : null;
    downloadCdp = session;
    await refreshDownloadBehavior(true);
    session.on("Target.targetCreated", (raw: unknown) => {
      const event = raw as { targetInfo?: CdpTargetInfo };
      if (!event.targetInfo) return;
      rememberTarget(event.targetInfo);
      const browserContextId = event.targetInfo?.browserContextId;
      if (
        typeof browserContextId !== "string"
        || !browserContextId
        || browserContextId === defaultBrowserContextId
      ) {
        if (isDefaultPageTarget(event.targetInfo)) void enforceControllerBoundaries();
        return;
      }
      deniedBrowserContexts.add(browserContextId);
      if (active) pushLeaseEvent(active, "[browser context blocked] additional contexts are not allowed");
      void session.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
    });
    session.on("Target.targetDestroyed", (raw: unknown) => {
      const targetId = (raw as { targetId?: unknown }).targetId;
      if (typeof targetId === "string") targetOrder.delete(targetId);
    });
    session.on("Browser.downloadWillBegin", (raw: unknown) => {
      const event = raw as { guid?: unknown; suggestedFilename?: unknown };
      if (typeof event.guid !== "string" || !event.guid) return;
      const lease = active;
      if (!lease) {
        void cancelDownloadAcrossContexts(event.guid);
        return;
      }
      if (lease.downloadGuids.has(event.guid)) return;
      lease.downloadGuids.add(event.guid);
      lease.downloadCount++;
      const guarded: GuardedDownload = {
        guid: event.guid,
        lease,
        suggestedFilename: String(event.suggestedFilename ?? "file"),
        receivedBytes: 0,
        totalBytes: 0,
        canceled: false,
        claimed: false,
      };
      guardedDownloads.set(event.guid, guarded);
      pushLeaseEvent(lease, `[download started] ${truncateOneLine(guarded.suggestedFilename, 200)}`);
      if (lease.downloadCount > maxDownloadsPerLease) {
        void cancelGuardedDownload(guarded, `download count exceeded ${maxDownloadsPerLease}`);
      }
    });
    session.on("Browser.downloadProgress", (raw: unknown) => {
      const event = raw as { guid?: unknown; receivedBytes?: unknown; totalBytes?: unknown; state?: unknown; filePath?: unknown };
      if (typeof event.guid !== "string") return;
      const guarded = guardedDownloads.get(event.guid);
      if (!guarded) return;
      const receivedBytes = Number(event.receivedBytes);
      const totalBytes = Number(event.totalBytes);
      if (Number.isFinite(receivedBytes) && receivedBytes >= guarded.receivedBytes) {
        guarded.lease.downloadBytes += receivedBytes - guarded.receivedBytes;
        guarded.receivedBytes = receivedBytes;
      }
      if (Number.isFinite(totalBytes) && totalBytes >= 0) guarded.totalBytes = totalBytes;
      if (
        !guarded.canceled
        && (guarded.lease.downloadBytes > maxDownloadBytes || projectedDownloadBytes(guarded.lease) > maxDownloadBytes)
      ) {
        void cancelGuardedDownload(guarded, `aggregate budget exceeded ${maxDownloadBytes} bytes`);
      }
      if (event.state === "completed" || event.state === "canceled") {
        // Where the bytes actually landed, per Chromium. A cancel can lose the race against a
        // small transfer — the file completes into the (possibly attacker-redirected) download
        // dir before Browser.cancelDownload arrives — so a canceled download's landed file must
        // be deleted too. Only trust the reported path when its basename is the Chromium-chosen
        // download guid (allowAndName naming): the guid is unguessable, so the path can't be
        // steered at a pre-existing file.
        const landedPath = typeof event.filePath === "string" && basename(event.filePath) === guarded.guid
          ? event.filePath
          : null;
        const cleanup = sleep(100).then(() => {
          if (!guarded.claimed && validTargetId(guarded.guid)) {
            try {
              unlinkSync(join(downloadsDir, guarded.guid));
            } catch {
              // A canceled transfer or Playwright-owned download may already be gone.
            }
            if (guarded.canceled && landedPath) {
              try {
                unlinkSync(landedPath);
              } catch {
                // The cancel won the race after all, or Chromium already removed the partial.
              }
            }
          }
          guardedDownloads.delete(guarded.guid);
        });
        guarded.lease.pendingDownloads.add(cleanup);
        void cleanup.finally(() => guarded.lease.pendingDownloads.delete(cleanup));
      }
    });
    await session.send("Target.setDiscoverTargets", { discover: true });
    await enforceControllerBoundaries(true);
  }

  async function claimGuardedDownload(lease: ActiveLease, suggestedFilename: string): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const guarded = [...guardedDownloads.values()].find((candidate) => (
        candidate.lease === lease
        && !candidate.claimed
        && candidate.suggestedFilename === suggestedFilename
      ));
      if (guarded) {
        guarded.claimed = true;
        return true;
      }
      await sleep(10);
    }
    return false;
  }

  function trackDownload(download: Download): void {
    const lease = active;
    if (!lease) {
      void download.delete().catch(() => undefined);
      return;
    }
    const target = uniqueArtifactPath(lease.artifactsDir, `download-${download.suggestedFilename()}`);
    const pending = (async () => {
      let fd: number | null = null;
      let stream: Awaited<ReturnType<Download["createReadStream"]>> | null = null;
      try {
        const rootTracked = await claimGuardedDownload(lease, download.suggestedFilename());
        if (!rootTracked) {
          // A second CDP client can temporarily disable Browser events. Double-counting a late root
          // event is intentionally safer than allowing an untracked download through.
          lease.downloadCount++;
          pushLeaseEvent(lease, "[download guard fallback] root download event was unavailable");
          if (lease.downloadCount > maxDownloadsPerLease) {
            await download.cancel().catch(() => undefined);
            throw new Error(`download count exceeded ${maxDownloadsPerLease}`);
          }
        }
        stream = await download.createReadStream();
        if (!stream) throw new Error("download stream is unavailable");
        fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        let downloadBytes = 0;
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          downloadBytes += buffer.length;
          if (!rootTracked) lease.downloadBytes += buffer.length;
          if (downloadBytes > maxDownloadBytes || lease.downloadBytes > maxDownloadBytes) {
            await download.cancel().catch(() => undefined);
            throw new Error(`download budget exceeded ${maxDownloadBytes} bytes`);
          }
          let written = 0;
          while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written);
        }
        pushLeaseEvent(lease, `[download saved] ${target}`);
      } catch (error) {
        await download.cancel().catch(() => undefined);
        stream?.destroy();
        if (fd !== null) {
          closeSync(fd);
          fd = null;
        }
        try {
          unlinkSync(target);
        } catch {
          // No partial artifact should survive a failed or oversized transfer.
        }
        pushLeaseEvent(lease, `[download failed] ${truncateOneLine(String(error), 300)}`);
      } finally {
        if (fd !== null) closeSync(fd);
        // Chromium retains a temporary file even after the bounded artifact stream completes.
        // A warm context must not keep that original indefinitely.
        await download.delete().catch(() => undefined);
      }
    })();
    lease.pendingDownloads.add(pending);
    void pending.finally(() => lease.pendingDownloads.delete(pending));
  }

  async function closeContext(target: BrowserContext | null): Promise<void> {
    if (!target) return;
    const close = daemonClosers.get(target);
    if (close) await close().catch(() => undefined);
  }

  async function persistSessionCookies(target: BrowserContext): Promise<void> {
    const snapshot = sessionCookieSnapshot(await target.cookies());
    writeAtomicPrivateFile(sessionCookieSnapshotPath, encodeSessionCookieSnapshot(snapshot));
  }

  async function restoreSessionCookies(target: BrowserContext): Promise<void> {
    try {
      const snapshot = readSessionCookieSnapshot(sessionCookieSnapshotPath);
      if (snapshot?.cookies.length) await target.addCookies(snapshot.cookies);
    } catch (error) {
      try {
        unlinkSync(sessionCookieSnapshotPath);
      } catch {
        // Invalid or incompatible snapshots are discarded instead of repeatedly blocking startup.
      }
      logger.warn("discarded invalid browser session cookie snapshot", {
        error: truncateOneLine(String((error as Error).message ?? error), 300),
      });
    }
  }

  function purgeDownloads(): void {
    mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });
    if (lstatSync(downloadsDir).isSymbolicLink()) throw new Error("browser downloads directory must not be a symlink");
    for (const entry of readdirSync(downloadsDir)) {
      rmSync(join(downloadsDir, entry), { recursive: true, force: true });
    }
  }

  async function terminateChromiumChild(child: ChromiumChild): Promise<void> {
    const existing = chromiumTerminations.get(child);
    if (existing) return existing;
    const terminating = (async () => {
      const signalChild = (signal: NodeJS.Signals): void => {
        try {
          child.kill(signal);
        } catch {
          // The host supervisor owns the shared process group and reaps it on a hard timeout.
        }
      };
      signalChild("SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        sleep(2_000).then(() => false),
      ]);
      if (!exited) {
        signalChild("SIGKILL");
        await Promise.race([child.exited.catch(() => -1), sleep(1_000)]);
      }
      if (chromiumChild === child) chromiumChild = null;
    })();
    chromiumTerminations.set(child, terminating);
    return terminating;
  }

  async function launchManagedChromium(
    launchOrigin: string,
    portFile: string,
  ): Promise<{ created: BrowserContext; endpoint: string; close: () => Promise<void> }> {
    if (!existsSync(chromiumExecutable)) throw new Error(`bundled Chromium is missing: ${chromiumExecutable}`);
    const child = spawn({
      cmd: buildPersistentChromiumCommand({
        executable: chromiumExecutable,
        profileDir,
        origin: launchOrigin,
        headless: settings.headless,
        viewportWidth: settings.viewportWidth,
        viewportHeight: settings.viewportHeight,
      }),
      cwd: profileDir,
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // The Node controller is the process-group leader. Keeping Chromium in that group lets the
      // Bun supervisor reap browser and renderer processes if the controller is hard-killed.
      detached: false,
    });
    chromiumChild = child;
    let browser: Browser | null = null;
    try {
      const endpoint = await waitForCdpEndpoint(portFile, settings.launchTimeoutMs, child);
      browser = await chromium.connectOverCDP(endpoint, {
        artifactsDir: downloadsDir,
        isLocal: true,
        timeout: settings.launchTimeoutMs,
      });
      const created = browser.contexts()[0];
      if (!created) throw new Error("Chromium did not expose its persistent default context");
      let closing: Promise<void> | null = null;
      const close = (): Promise<void> => {
        closing ??= (async () => {
          const rootSession = downloadCdp;
          if (rootSession) {
            await Promise.race([
              rootSession.send("Browser.close").catch(() => undefined),
              sleep(1_000),
            ]);
            const exitedCleanly = await Promise.race([
              child.exited.then(() => true).catch(() => true),
              sleep(5_000).then(() => false),
            ]);
            if (exitedCleanly) {
              if (chromiumChild === child) chromiumChild = null;
              return;
            }
          }
          await terminateChromiumChild(child);
        })();
        return closing;
      };
      return { created, endpoint, close };
    } catch (error) {
      await browser?.close().catch(() => undefined);
      await terminateChromiumChild(child);
      throw error;
    }
  }

  async function ensureContext(): Promise<BrowserContext> {
    if (stopped) throw new Error("browser runtime is stopped");
    assertProfileHealthy();
    if (context) return context;
    if (starting) return starting;
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });
    mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
    const existingProfileBytes = await allocatedDirectoryBytes(profileDir, maxProfileBytes + 1);
    if (existingProfileBytes > maxProfileBytes) {
      throw new Error(`browser profile exceeds its ${maxProfileBytes}-byte storage ceiling`);
    }
    chmodSync(profileDir, 0o700);
    const portFile = join(profileDir, "DevToolsActivePort");
    try {
      unlinkSync(portFile);
    } catch {
      // A clean profile has no stale endpoint file.
    }
    const launchOrigin = `https://${randomBytes(24).toString("hex")}.beckett.invalid`;
    const launched = usesInjectedLaunch
      ? injectedLaunch!(profileDir, {
        headless: settings.headless,
        channel: "chromium",
        viewport: { width: settings.viewportWidth, height: settings.viewportHeight },
        acceptDownloads: true,
        downloadsPath: downloadsDir,
        timeout: settings.launchTimeoutMs,
      }).then((created) => ({
        created,
        endpoint: "http://127.0.0.1:1",
        close: created.close.bind(created),
      }))
      : launchManagedChromium(launchOrigin, portFile);
    starting = launched
      .then(async ({ created, endpoint, close: rawDaemonClose }) => {
        let daemonClosing: Promise<void> | null = null;
        const daemonClose = (): Promise<void> => {
          daemonClosing ??= rawDaemonClose();
          return daemonClosing;
        };
        daemonClosers.set(created, daemonClose);
        currentDaemonClose = daemonClose;
        if (!usesInjectedLaunch) {
          try {
            await installDownloadProgressGuard(created);
          } catch (error) {
            await daemonClose().catch(() => undefined);
            throw new Error(`could not install Chromium download guard: ${String((error as Error).message ?? error)}`);
          }
        }
        Object.defineProperty(created, "close", {
          configurable: false,
          enumerable: false,
          value: async () => {
            throw new Error("the persistent browser context is host-owned and cannot be closed by a run");
          },
        });
        if (stopped) {
          await daemonClose().catch(() => undefined);
          throw new Error("browser runtime stopped while Chromium was starting");
        }
        await restoreSessionCookies(created);
        context = created;
        cdpOrigin = launchOrigin;
        cdpEndpoint = endpoint;
        launches++;
        created.setDefaultTimeout(settings.actionTimeoutMs);
        created.setDefaultNavigationTimeout(settings.navigationTimeoutMs);
        for (const page of created.pages()) attachPage(page);
        created.on("page", attachPage);
        created.on("close", () => {
          if (context === created) context = null;
          cdpEndpoint = null;
          cdpOrigin = null;
          downloadCdp = null;
          defaultBrowserContextId = null;
          guardedDownloads.clear();
          deniedBrowserContexts.clear();
          targetOrder.clear();
          lastDownloadBehaviorAt = 0;
          logger.warn("persistent Chromium context closed", {});
        });
        logger.info("persistent Chromium ready", { profileDir, headless: settings.headless });
        return created;
      })
      .catch((error) => {
        throw new Error(
          `could not start persistent Chromium at ${profileDir}: ${String((error as Error).message ?? error)}`,
        );
      })
      .finally(() => {
        starting = null;
      });
    return starting;
  }

  async function waitForCdpEndpoint(
    portFile: string,
    timeoutMs: number,
    child?: ChromiumChild,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child && child.exitCode !== null) {
        throw new Error(`Chromium exited before CDP was ready (code ${child.exitCode})`);
      }
      if (existsSync(portFile)) {
        const port = readFileSync(portFile, "utf8").split("\n", 1)[0]?.trim();
        if (port && /^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
      }
      await sleep(25);
    }
    throw new Error("Chromium did not publish its loopback DevTools endpoint");
  }

  async function prepareEvaluatorSession(lease: ActiveLease): Promise<BrowserEvaluatorSession> {
    await enforceProfileBudget(lease);
    assertProfileHealthy();
    await enforceControllerBoundaries(true);
    assertProfileHealthy();
    const ctx = await ensureContext();
    if (lease.activePage.isClosed() || !ctx.pages().includes(lease.activePage)) {
      lease.activePage = ctx.pages().find((page) => !page.isClosed()) ?? await ctx.newPage();
    }
    if (!cdpEndpoint || !cdpOrigin) throw new Error("persistent Chromium DevTools endpoint is unavailable");
    const openPages = ctx.pages().filter((page) => !page.isClosed());
    return {
      endpoint: cdpEndpoint,
      origin: cdpOrigin,
      state: lease.state,
      activeIndex: Math.max(0, openPages.indexOf(lease.activePage)),
      activeTargetId: await chromiumTargetId(ctx, lease.activePage).catch(() => ""),
    };
  }

  async function applyEvaluatorOutput(
    lease: ActiveLease,
    evaluated: BrowserEvaluatorOutput,
  ): Promise<BrowserEvalResult> {
    if (!evaluated || (evaluated.ok !== true && evaluated.recoverable !== true)) {
      // The profile watchdog can race an in-flight evaluation: it sets profileBudgetError and
      // closes Chromium, and the evaluator then dies with a transport error (connect
      // ECONNREFUSED). The budget breach is the root cause — surface it, not the fallout.
      await enforceProfileBudget(lease).catch(() => undefined);
      assertProfileHealthy();
      throw new Error(evaluated?.error ?? "browser evaluator did not complete successfully");
    }
    const succeeded = evaluated.ok === true;
    await enforceProfileBudget(lease);
    assertProfileHealthy();
    await enforceControllerBoundaries(true);
    assertProfileHealthy();
    const ctx = await ensureContext();
    lease.state = sanitizeEvaluatorState(evaluated.state);
    let currentPages = ctx.pages().filter((page) => !page.isClosed());
    if (currentPages.length === 0) currentPages = [await ctx.newPage()];
    const requestedIndex = Number.isSafeInteger(evaluated.activeIndex) && (evaluated.activeIndex ?? -1) >= 0
      ? evaluated.activeIndex!
      : 0;
    const activeByTarget = validTargetId(evaluated.activeTargetId)
      ? await waitForTargetPage(ctx, evaluated.activeTargetId, Math.min(1_000, settings.actionTimeoutMs))
      : null;
    currentPages = ctx.pages().filter((page) => !page.isClosed());
    lease.activePage = activeByTarget
      ?? currentPages[Math.min(requestedIndex, currentPages.length - 1)]
      ?? currentPages[0]!;

    const screenshots: string[] = [];
    const requests = succeeded && Array.isArray(evaluated.screenshotRequests) ? evaluated.screenshotRequests : [];
    for (const request of requests.slice(0, MAX_SCREENSHOTS_PER_EVAL)) {
      if (!request || typeof request.name !== "string" || !Number.isSafeInteger(request.pageIndex)) continue;
      const target = validTargetId(request.targetId)
        ? await waitForTargetPage(ctx, request.targetId, Math.min(1_000, settings.actionTimeoutMs))
        : request.pageIndex >= 0 ? currentPages[request.pageIndex] : undefined;
      screenshots.push(await capture(lease, request.name, target ?? lease.activePage));
    }

    const elapsedMs = typeof evaluated.elapsedMs === "number" && Number.isFinite(evaluated.elapsedMs)
      ? Math.max(0, Math.min(Math.round(evaluated.elapsedMs), settings.evalTimeoutMs + 750))
      : 0;
    evaluations++;
    totalEvalMs += elapsedMs;
    const summarized = await pageSummaries(lease);
    return boundBrowserEvalResult({
      value: evaluated.value ?? null,
      console: Array.isArray(evaluated.console)
        ? evaluated.console.filter((line): line is string => typeof line === "string").slice(-20)
        : [],
      pages: summarized.pages,
      events: succeeded ? lease.events.splice(0) : [],
      screenshots,
      elapsedMs,
      truncated: evaluated.truncated === true || summarized.truncated,
    }, settings.maxOutputChars);
  }

  function requireLease(runId: string): ActiveLease {
    if (!active || active.runId !== runId) throw new Error(`browser lease ${runId} is not active`);
    return active;
  }

  async function pageSummaries(
    lease: ActiveLease,
  ): Promise<{ pages: BrowserPageSummary[]; truncated: boolean }> {
    const openPages = context?.pages().filter((page) => !page.isClosed()) ?? [];
    let truncated = openPages.length > MAX_RESULT_PAGES;
    const pages = await Promise.all(
      openPages.slice(0, MAX_RESULT_PAGES).map(async (page, index) => {
        const url = page.url();
        const title = await page.title().catch(() => "");
        truncated ||= url.length > MAX_PAGE_URL_CHARS || title.length > MAX_PAGE_TITLE_CHARS;
        return {
          index,
          active: page === lease.activePage,
          url: truncatePlain(url, MAX_PAGE_URL_CHARS),
          title: truncatePlain(title, MAX_PAGE_TITLE_CHARS),
        };
      }),
    );
    return { pages, truncated };
  }

  async function capture(lease: ActiveLease, requestedName: string, target = lease.activePage): Promise<string> {
    mkdirSync(lease.artifactsDir, { recursive: true, mode: 0o700 });
    const path = uniqueArtifactPath(lease.artifactsDir, requestedName, ".png");
    let frozen: FrozenScreenshotPage | null = null;
    let redaction: ScreenshotRedaction | null = null;
    let usePlaceholder = target.isClosed();
    let targetCaptured = false;
    try {
      if (!usePlaceholder) {
        frozen = await freezeScreenshotPage(target);
        usePlaceholder = await isSensitiveScreenshotPage(target);
        if (!usePlaceholder) {
          redaction = await redactSensitiveScreenshotContent(target);
          await frozen.assertUnchanged();
          await target.screenshot({ path, type: "png", scale: "css", animations: "disabled", caret: "hide" });
          await frozen.assertUnchanged();
          targetCaptured = true;
        }
      }
    } catch (error) {
      usePlaceholder = true;
      logger.warn("browser screenshot privacy check failed closed", {
        error: truncateOneLine(String((error as Error).message ?? error), 300),
      });
    } finally {
      if (redaction) {
        try {
          await redaction.restore();
        } catch (error) {
          usePlaceholder = true;
          logger.warn("browser screenshot redaction restore failed closed", {
            error: truncateOneLine(String((error as Error).message ?? error), 300),
          });
        }
      }
      if (frozen) {
        try {
          await frozen.assertUnchanged();
        } catch (error) {
          usePlaceholder = true;
          logger.warn("browser screenshot page state changed during capture", {
            error: truncateOneLine(String((error as Error).message ?? error), 300),
          });
        }
        try {
          await frozen.restore();
        } catch (error) {
          usePlaceholder = true;
          logger.warn("browser screenshot execution restore failed closed", {
            error: truncateOneLine(String((error as Error).message ?? error), 300),
          });
        }
      }
    }
    if (usePlaceholder || !targetCaptured) {
      try {
        unlinkSync(path);
      } catch {
        // A failed or rejected target capture must never remain deliverable.
      }
      await captureGenericPrivacyPlaceholder(target.context(), path, {
        width: settings.viewportWidth,
        height: settings.viewportHeight,
      });
    }
    lease.screenshots.push(path);
    return path;
  }

  async function cleanPages(lease: ActiveLease): Promise<void> {
    if (!context) return;
    const pages = context.pages().filter((page) => !page.isClosed());
    const keeper = pages.includes(lease.activePage) ? lease.activePage : pages[0];
    for (const page of pages) {
      if (page !== keeper) await page.close().catch(() => undefined);
    }
    if (keeper && !keeper.isClosed()) await keeper.goto("about:blank").catch(() => undefined);
  }

  return {
    async acquire(lease) {
      if (stopped) throw new Error("browser runtime is stopped");
      const occupying = active ?? reserved;
      if (occupying && occupying.runId !== lease.runId) {
        throw new Error(`computer-use is busy with run ${occupying.runId}; retry after it finishes`);
      }
      if (active?.runId === lease.runId) return;
      if (!pathIsWithin(artifactsRoot, resolve(lease.artifactsDir))) {
        throw new Error(`browser artifacts must stay below ${artifactsRoot}`);
      }

      // Reserve before the first await so concurrent cold-start calls cannot both acquire.
      reserved = { ...lease };
      let cachePruneReclaimed: number | null = null;
      try {
        let profileBytes = await allocatedDirectoryBytes(profileDir, maxProfileBytes + 1);
        if (profileBytes > maxProfileBytes * PROFILE_PRUNE_HIGH_WATER_MARK) {
          // A warm persistent context may still own this profile after the prior
          // lease. Close it first; pruning an open Chrome profile is unsafe.
          if (context) await closeContext(context);
          cachePruneReclaimed = (await pruneChromeProfileCaches(profileDir)).reclaimedBytes;
          profileBytes = await allocatedDirectoryBytes(profileDir, maxProfileBytes + 1);
        }
        if (profileBytes > maxProfileBytes) {
          const pruneDetail = cachePruneReclaimed === null
            ? "cache prune was not needed"
            : `cache prune reclaimed ${cachePruneReclaimed} bytes, still over`;
          throw new Error(`browser profile storage budget exceeded (${pruneDetail}; profile=${profileBytes}, lease growth=0 bytes)`);
        }
        const ctx = await ensureContext();
        if (stopped || reserved?.runId !== lease.runId) throw new Error("browser acquisition was interrupted");
        mkdirSync(lease.artifactsDir, { recursive: true, mode: 0o700 });
        chmodSync(lease.artifactsDir, 0o700);
        let page = ctx.pages().find((candidate) => !candidate.isClosed());
        if (!page) page = await ctx.newPage();
        active = {
          ...lease,
          activePage: page,
          events: cachePruneReclaimed === null ? [] : [`[profile cache pruned] reclaimed ${cachePruneReclaimed} bytes`],
          screenshots: [],
          state: Object.create(null),
          pendingDownloads: new Set(),
          downloadBytes: 0,
          downloadCount: 0,
          downloadGuids: new Set(),
          profileBytesAtAcquire: 0,
        };
        await cleanPages(active);
        purgeDownloads();
        // Growth baseline discounts disposable caches so enforceProfileBudget compares like
        // against like; the ceiling/prune checks above stay cache-inclusive (real disk usage).
        active.profileBytesAtAcquire = await allocatedDirectoryBytes(profileDir, maxProfileBytes + 1, { excludeDisposableCache: true });
        profileBytesLastSeen = active.profileBytesAtAcquire;
        profileBudgetError = null;
        startLeaseGuards(active);
        logger.info("browser lease acquired", { runId: lease.runId, channelId: lease.channelId });
      } catch (error) {
        if (reserved?.runId === lease.runId) reserved = null;
        throw error;
      }
    },

    async evaluate(runId, code) {
      const lease = requireLease(runId);
      if (!code.trim()) throw new Error("playwright_eval needs non-empty JavaScript");
      if (code.length > MAX_CODE_CHARS) throw new Error(`playwright_eval code exceeds ${MAX_CODE_CHARS} characters`);
      const session = await prepareEvaluatorSession(lease);
      const evaluated = await runBrowserEvaluator(
        {
          ...session,
          code,
          actionTimeoutMs: settings.actionTimeoutMs,
          navigationTimeoutMs: settings.navigationTimeoutMs,
          evalTimeoutMs: settings.evalTimeoutMs,
          maxOutputChars: settings.maxOutputChars,
        },
        {
          isolation: "none",
          repoRoot: resolve(MODULE_DIR, "../.."),
          evaluatorPath: EVALUATOR_PATH,
          spawn,
        },
      );
      const result = await applyEvaluatorOutput(lease, evaluated);
      if (!evaluated.ok) throw new Error(evaluated.error ?? "playwright_eval failed");
      return result;
    },

    async prepareEvaluation(runId) {
      return prepareEvaluatorSession(requireLease(runId));
    },

    async applyEvaluation(runId, evaluated) {
      return applyEvaluatorOutput(requireLease(runId), evaluated);
    },

    async capture(runId, name) {
      const lease = requireLease(runId);
      await enforceProfileBudget(lease);
      assertProfileHealthy();
      return capture(lease, name);
    },

    async checkpoint(runId) {
      const lease = requireLease(runId);
      await enforceProfileBudget(lease);
      assertProfileHealthy();
      const open = context?.pages().filter((page) => !page.isClosed()) ?? [];
      return {
        urls: open.slice(0, 8).map((page) => page.url()),
        activeIndex: Math.max(0, open.indexOf(lease.activePage)),
      };
    },

    async restore(runId, checkpoint) {
      const lease = requireLease(runId);
      await enforceProfileBudget(lease);
      assertProfileHealthy();
      if (!context) throw new Error("persistent Chromium is not ready");
      const urls = checkpoint.urls.slice(0, 8).map(safeRestoreUrl).filter((url): url is string => !!url);
      const targets: Page[] = [];
      const existing = context.pages().find((page) => !page.isClosed()) ?? await context.newPage();
      targets.push(existing);
      while (targets.length < Math.max(1, urls.length)) targets.push(await context.newPage());
      await Promise.all(targets.map((page, index) => page.goto(urls[index] ?? "about:blank").catch(() => undefined)));
      lease.activePage = targets[Math.min(checkpoint.activeIndex, targets.length - 1)] ?? existing;
    },

    async release(runId, captureProof) {
      const lease = requireLease(runId);
      stopLeaseGuards();
      if (profileBudgetShutdown) await profileBudgetShutdown.catch(() => undefined);
      const proofFiles: string[] = [];
      try {
        if (lease.pendingDownloads.size > 0) await Promise.allSettled([...lease.pendingDownloads]);
        if (captureProof && lease.activePage.url() !== "about:blank") {
          proofFiles.push(await capture(lease, "proof-auto"));
        }
        return proofFiles;
      } finally {
        await cleanPages(lease);
        purgeDownloads();
        for (const [guid, guarded] of guardedDownloads) {
          if (guarded.lease === lease) guardedDownloads.delete(guid);
        }
        active = null;
        if (reserved?.runId === runId) reserved = null;
        profileBudgetError = null;
        logger.info("browser lease released", { runId });
      }
    },

    hasLease(runId) {
      return active?.runId === runId || reserved?.runId === runId;
    },

    stats() {
      return {
        ready: context !== null,
        profileDir,
        activeRunId: active?.runId ?? reserved?.runId ?? null,
        pages: context?.pages().filter((page) => !page.isClosed()).length ?? 0,
        launches,
        evaluations,
        averageEvalMs: evaluations === 0 ? 0 : Math.round(totalEvalMs / evaluations),
      };
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      stopLeaseGuards();
      active = null;
      reserved = null;
      const pendingChild = chromiumChild;
      const inFlightStart = starting;
      // Interrupt only a launch that has not produced a context. A warm browser must receive
      // Browser.close first so Chromium flushes cookies and other persistent profile state.
      if (pendingChild && inFlightStart && !context) {
        await terminateChromiumChild(pendingChild).catch(() => undefined);
      }
      if (inFlightStart) await inFlightStart.catch(() => undefined);
      const target = context;
      context = null;
      if (target) {
        try {
          await persistSessionCookies(target);
        } catch (error) {
          try {
            unlinkSync(sessionCookieSnapshotPath);
          } catch {
            // Never retain an older snapshot after a failed refresh.
          }
          logger.warn("could not persist browser session cookies", {
            error: truncateOneLine(String((error as Error).message ?? error), 300),
          });
        }
        await closeContext(target);
      }
      else await currentDaemonClose?.().catch(() => undefined);
      currentDaemonClose = null;
    },
  };
}

async function freezeScreenshotPage(page: Page): Promise<FrozenScreenshotPage> {
  const sessions: CDPSession[] = [];
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    let firstError: unknown = null;
    for (const session of sessions.reverse()) {
      try {
        await session.send("Emulation.setScriptExecutionDisabled", { value: false });
      } catch (error) {
        firstError ??= error;
      }
      try {
        await session.detach();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };

  try {
    const context = page.context();
    const mainSession = await context.newCDPSession(page);
    sessions.push(mainSession);
    await mainSession.send("Emulation.setScriptExecutionDisabled", { value: true });
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      let frameSession: CDPSession;
      try {
        frameSession = await context.newCDPSession(frame);
      } catch (error) {
        if (/part of the parent frame's session/i.test(String((error as Error).message ?? error))) continue;
        throw error;
      }
      sessions.push(frameSession);
      await frameSession.send("Emulation.setScriptExecutionDisabled", { value: true });
    }
    const initialState = await screenshotPageState(page, mainSession);
    return {
      async assertUnchanged() {
        if (restored) throw new Error("screenshot execution guard was already restored");
        const currentState = await screenshotPageState(page, mainSession);
        if (currentState !== initialState) throw new Error("page navigated or changed frame state during screenshot");
      },
      restore,
    };
  } catch (error) {
    await restore().catch(() => undefined);
    throw error;
  }
}

async function screenshotPageState(page: Page, session: CDPSession): Promise<string> {
  if (page.isClosed()) throw new Error("screenshot page closed during privacy inspection");
  const [frameTree, targetInfo] = await Promise.all([
    session.send("Page.getFrameTree"),
    session.send("Target.getTargetInfo"),
  ]);
  return JSON.stringify({ frameTree, targetInfo });
}

async function captureGenericPrivacyPlaceholder(
  context: BrowserContext,
  path: string,
  viewport: { width: number; height: number },
): Promise<void> {
  const blank = await context.newPage();
  let session: CDPSession | null = null;
  let failed: unknown = null;
  try {
    await blank.setViewportSize(viewport);
    session = await context.newCDPSession(blank);
    await session.send("Emulation.setScriptExecutionDisabled", { value: true });
    await blank.setContent("<!doctype html><html><head><title></title></head><body></body></html>");
    await blank.screenshot({
      path,
      type: "png",
      scale: "css",
      animations: "disabled",
      caret: "hide",
      style: [
        "html, body { margin: 0 !important; background: #f4f4f5 !important; }",
        "body > * { display: none !important; }",
        "body::before { content: 'Sensitive page redacted'; display: block !important;",
        "padding: 32px !important; color: #18181b !important; font: 600 18px system-ui !important; }",
      ].join(" "),
    });
  } catch (error) {
    failed = error;
  } finally {
    if (session) {
      await session.send("Emulation.setScriptExecutionDisabled", { value: false }).catch((error) => {
        failed ??= error;
      });
      await session.detach().catch((error) => {
        failed ??= error;
      });
    }
    await blank.close().catch((error) => {
      failed ??= error;
    });
  }
  if (failed) {
    try {
      unlinkSync(path);
    } catch {
      // Never retain a partial generic placeholder.
    }
    throw failed;
  }
}

async function isSensitiveScreenshotPage(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const sensitive = await frame.evaluate(() => {
        if (/(login|log-in|sign-in|signin|auth|password|security|2fa|mfa|otp|verify|verification|recovery|backup)/i.test(
          `${location.href} ${document.title}`,
        )) return true;
        const signal = (document.body?.innerText ?? "").slice(0, 100_000);
        if (/(password|passcode|one[ -]?time|otp|2fa|mfa|recovery|backup code|verification code|security code|api key|access token)/i.test(signal)) {
          return true;
        }
        if (document.querySelector("[data-secret], [data-recovery-code], [data-backup-code]")) return true;
        const looksLikeSecretValue = (value: string): boolean => {
          const trimmed = value.trim();
          if (trimmed.length < 8 || trimmed.length > 512) return false;
          const structured = /^(?=.{8,100}$)(?=.*[a-z])(?=.*\d)[a-z0-9]+(?:[- ]+[a-z0-9]+)+$/i;
          const numeric = /^\d{4,}(?:[- ]+\d{4,})+$/;
          const compact = /^(?=.{10,100}$)(?=.*[a-z])(?=.*\d)[a-z0-9]+$/i;
          const token = /^eyJ[a-z0-9_-]+(?:\.[a-z0-9_-]+){1,2}$/i;
          return structured.test(trimmed) || numeric.test(trimmed) || compact.test(trimmed) || token.test(trimmed);
        };
        const suspiciousContainers = Array.from(document.querySelectorAll<HTMLElement>([
          "code",
          "pre",
          "samp",
          "output",
          '[class*="recovery" i]',
          '[id*="recovery" i]',
          '[class*="backup" i]',
          '[id*="backup" i]',
          '[class*="token" i]',
          '[id*="token" i]',
          '[class*="secret" i]',
          '[id*="secret" i]',
        ].join(",")));
        if (suspiciousContainers.some((element) => looksLikeSecretValue(element.textContent ?? ""))) return true;
        return Array.from(document.querySelectorAll<HTMLElement>(
          'input, textarea, [contenteditable="true"], [role="textbox"]',
        )).some((element) => {
          const input = element instanceof HTMLInputElement ? element : null;
          const labels = input?.labels ? Array.from(input.labels).map((label) => label.textContent ?? "").join(" ") : "";
          const metadata = [
            input?.type,
            element.getAttribute("name"),
            element.id,
            element.getAttribute("autocomplete"),
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
            labels,
          ].filter(Boolean).join(" ");
          return input?.type === "password" || /(password|passcode|otp|token|secret|recovery|backup|security)/i.test(metadata);
        });
      });
      if (sensitive) return true;
    } catch {
      // Screenshot privacy fails closed when any frame cannot be classified reliably.
      return true;
    }
  }
  return false;
}

/**
 * Hide credentials and recovery imagery for every runtime-owned screenshot. The original inline
 * styles are restored even when screenshotting fails. Each frame is handled independently so
 * embedded authentication widgets receive the same protection.
 */
export async function redactSensitiveScreenshotContent(page: Page): Promise<ScreenshotRedaction> {
  const restorers: { frame: Frame; key: string }[] = [];
  let changedTotal = 0;
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    const pending = restorers.splice(0).map(async ({ frame, key }) => {
      await frame.evaluate((storageKey) => {
        const global = window as unknown as Record<string, unknown>;
        const records = global[storageKey] as
          | (
              | { kind: "style"; element: HTMLElement; style: string | null }
              | { kind: "text"; node: Text; value: string }
            )[]
          | undefined;
        if (!records) throw new Error("screenshot redaction state was lost");
        for (const record of records) {
          if (record.kind === "text") {
            record.node.data = record.value;
          } else if (record.style === null) {
            record.element.removeAttribute("style");
          } else {
            record.element.setAttribute("style", record.style);
          }
        }
        delete global[storageKey];
      }, key);
    });
    const results = await Promise.allSettled(pending);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  };
  const frames = page.frames();
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    const key = `__beckett_redaction_${Date.now()}_${Math.random().toString(36).slice(2)}_${index}`;
    try {
      const changed = await frame.evaluate((storageKey) => {
        const global = window as unknown as Record<string, unknown>;
        const records: (
          | { kind: "style"; element: HTMLElement; style: string | null }
          | { kind: "text"; node: Text; value: string }
        )[] = [];
        const sensitive = /(pass(word|code)?|one[ -]?time|otp|2fa|mfa|auth(entication)?|token|secret|recovery|backup|verification|security[ -]?code|pin)/i;
        const authPage = /(login|log-in|sign-in|signin|auth|password|security|2fa|mfa|otp|verify|verification|recovery|backup)/i.test(
          `${location.href} ${document.title}`,
        );
        const fields = Array.from(
          document.querySelectorAll<HTMLElement>('input, textarea, [contenteditable="true"], [role="textbox"]'),
        );
        const sensitiveFields = fields.filter((element) => {
          const input = element instanceof HTMLInputElement ? element : null;
          const labelledBy = element.getAttribute("aria-labelledby")
            ?.split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          const label = input?.labels ? Array.from(input.labels).map((item) => item.textContent ?? "").join(" ") : "";
          const metadata = [
            input?.type,
            element.getAttribute("name"),
            element.id,
            element.getAttribute("autocomplete"),
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
            labelledBy,
            label,
          ]
            .filter(Boolean)
            .join(" ");
          return input?.type === "password" || sensitive.test(metadata);
        });
        const targets = new Set<HTMLElement>(sensitiveFields);
        const valueContainers = Array.from(
          document.querySelectorAll<HTMLElement>(
            [
              "code",
              "pre",
              "samp",
              "output",
              "[data-recovery-code]",
              "[data-backup-code]",
              "[data-secret]",
              '[class*="recovery" i]',
              '[id*="recovery" i]',
              '[class*="backup" i]',
              '[id*="backup" i]',
              '[class*="token" i]',
              '[id*="token" i]',
              '[class*="secret" i]',
              '[id*="secret" i]',
            ].join(","),
          ),
        );
        const looksLikeSecretValue = (value: string): boolean => {
          const trimmed = value.trim();
          if (trimmed.length < 8 || trimmed.length > 512) return false;
          const structured = /^(?=.{8,100}$)(?=.*[a-z])(?=.*\d)[a-z0-9]+(?:[- ]+[a-z0-9]+)+$/i;
          const numeric = /^\d{4,}(?:[- ]+\d{4,})+$/;
          const compact = /^(?=.{10,100}$)(?=.*[a-z])(?=.*\d)[a-z0-9]+$/i;
          const token = /^eyJ[a-z0-9_-]+(?:\.[a-z0-9_-]+){1,2}$/i;
          const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
          if (lines.length > 1) {
            const matches = lines.filter((line) => structured.test(line) || numeric.test(line) || compact.test(line));
            return matches.length >= Math.ceil(lines.length * 0.6);
          }
          return structured.test(trimmed) || numeric.test(trimmed) || compact.test(trimmed) || token.test(trimmed);
        };
        if (authPage || sensitiveFields.length > 0) {
          for (const element of Array.from(
            document.querySelectorAll<HTMLElement>("img, canvas, video, svg, [role=img]"),
          )) {
            targets.add(element);
          }
        }
        const seenText = new Set<Text>();
        for (const container of valueContainers) {
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          let current = walker.nextNode();
          while (current) {
            const node = current as Text;
            if (!seenText.has(node) && looksLikeSecretValue(node.data)) {
              seenText.add(node);
              records.push({ kind: "text", node, value: node.data });
              node.data = node.data.replace(/\S/g, "*");
            }
            current = walker.nextNode();
          }
        }
        for (const element of targets) {
          records.push({ kind: "style", element, style: element.getAttribute("style") });
          if (element.matches("img, canvas, video, svg, [role=img]")) {
            element.style.setProperty("visibility", "hidden", "important");
            element.style.setProperty("background", "#111", "important");
          } else {
            element.style.setProperty("color", "transparent", "important");
            element.style.setProperty("text-shadow", "none", "important");
            element.style.setProperty("caret-color", "transparent", "important");
            element.style.setProperty("background", "#111", "important");
            element.style.setProperty("border-color", "#111", "important");
            element.style.setProperty("-webkit-text-security", "disc", "important");
          }
        }
        if (records.length > 0) Object.defineProperty(global, storageKey, { configurable: true, value: records });
        return records.length;
      }, key);
      if (changed > 0) {
        changedTotal += changed;
        restorers.push({ frame, key });
      }
    } catch (error) {
      await restore().catch(() => undefined);
      throw new Error(`screenshot redaction could not inspect every frame: ${String((error as Error).message ?? error)}`);
    }
  }
  return { changed: changedTotal, restore };
}

function pathIsWithin(root: string, target: string): boolean {
  const offset = relative(root, target);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function boundedBudget(value: number | undefined, hardLimit: number): number {
  if (value === undefined) return hardLimit;
  if (!Number.isFinite(value) || value <= 0) throw new Error("browser budget overrides must be positive numbers");
  return Math.min(hardLimit, Math.floor(value));
}

function sessionCookieSnapshot(cookies: readonly Cookie[]): SessionCookieSnapshot {
  const sessionCookies = cookies
    .filter((cookie) => cookie.expires <= 0)
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: -1,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    }));
  if (sessionCookies.length > MAX_SESSION_COOKIE_COUNT) {
    throw new Error(`session cookie snapshot exceeds ${MAX_SESSION_COOKIE_COUNT} cookies`);
  }
  return { version: 1, cookies: sessionCookies };
}

function encodeSessionCookieSnapshot(snapshot: SessionCookieSnapshot): Buffer {
  const encoded = Buffer.from(JSON.stringify(snapshot));
  if (encoded.length > MAX_SESSION_COOKIE_SNAPSHOT_BYTES) {
    throw new Error(`session cookie snapshot exceeds ${MAX_SESSION_COOKIE_SNAPSHOT_BYTES} bytes`);
  }
  return encoded;
}

function writeAtomicPrivateFile(path: string, contents: Buffer): void {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let written = 0;
    while (written < contents.length) {
      written += writeSync(fd, contents, written, contents.length - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // A successful atomic rename has already removed the temporary pathname.
    }
  }
}

function readSessionCookieSnapshot(path: string): SessionCookieSnapshot | null {
  if (!existsSync(path)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SESSION_COOKIE_SNAPSHOT_BYTES) {
      throw new Error("session cookie snapshot is not a bounded regular file");
    }
    if ((stat.mode & 0o077) !== 0) throw new Error("session cookie snapshot permissions are not private");
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("session cookie snapshot is not an object");
    const candidate = parsed as { version?: unknown; cookies?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.cookies)) {
      throw new Error("session cookie snapshot has an unsupported shape");
    }
    if (candidate.cookies.length > MAX_SESSION_COOKIE_COUNT) {
      throw new Error(`session cookie snapshot exceeds ${MAX_SESSION_COOKIE_COUNT} cookies`);
    }
    const cookies = candidate.cookies.map(validateSessionCookieSnapshotEntry);
    return { version: 1, cookies };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function validateSessionCookieSnapshotEntry(value: unknown): Cookie {
  if (!value || typeof value !== "object") throw new Error("session cookie snapshot contains a non-object cookie");
  const cookie = value as Partial<Cookie>;
  const boundedString = (field: keyof Cookie, candidate: unknown, max: number, allowEmpty = true): string => {
    if (typeof candidate !== "string" || candidate.length > max || (!allowEmpty && candidate.length === 0)) {
      throw new Error(`session cookie snapshot has an invalid ${String(field)}`);
    }
    return candidate;
  };
  const sameSite = cookie.sameSite;
  if (sameSite !== "Strict" && sameSite !== "Lax" && sameSite !== "None") {
    throw new Error("session cookie snapshot has an invalid sameSite");
  }
  if (cookie.expires !== -1 || typeof cookie.httpOnly !== "boolean" || typeof cookie.secure !== "boolean") {
    throw new Error("session cookie snapshot contains a non-session cookie");
  }
  const partitionKey = cookie.partitionKey === undefined
    ? undefined
    : boundedString("partitionKey", cookie.partitionKey, 4_096, false);
  return {
    name: boundedString("name", cookie.name, 4_096),
    value: boundedString("value", cookie.value, 64 * 1024),
    domain: boundedString("domain", cookie.domain, 1_024, false),
    path: boundedString("path", cookie.path, 4_096, false),
    expires: -1,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite,
    ...(partitionKey ? { partitionKey } : {}),
  };
}

async function allocatedDirectoryBytes(
  root: string,
  stopAfter = Number.POSITIVE_INFINITY,
  options?: { excludeDisposableCache?: boolean },
): Promise<number> {
  const excludeDisposableCache = options?.excludeDisposableCache ?? false;
  const pending = [root];
  let total = 0;
  while (pending.length > 0 && total <= stopAfter) {
    const batch = pending.splice(Math.max(0, pending.length - 64));
    const measured = await Promise.all(batch.map(async (current) => {
      if (excludeDisposableCache && isDisposableCacheDir(current)) return { allocated: 0, children: [] as string[] };
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) return { allocated: 0, children: [] as string[] };
        const allocated = Number.isFinite(stat.blocks) && stat.blocks > 0 ? stat.blocks * 512 : stat.size;
        const children = stat.isDirectory()
          ? (await readdir(current)).map((entry) => join(current, entry))
          : [];
        return { allocated: Math.max(0, allocated), children };
      } catch {
        // Chromium creates and removes cache files concurrently; the next scan sees stable state.
        return { allocated: 0, children: [] as string[] };
      }
    }));
    for (const item of measured) {
      total += item.allocated;
      pending.push(...item.children);
    }
  }
  return total;
}

function assertNoExistingSymlink(root: string, target: string): void {
  let current = target;
  while (pathIsWithin(root, current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`browser profile path must not contain symlinks: ${current}`);
    }
    if (current === root) break;
    current = dirname(current);
  }
}

function safeRestoreUrl(value: string): string | null {
  if (value === "about:blank") return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function validTargetId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

async function chromiumTargetId(context: BrowserContext, page: Page): Promise<string> {
  const session = await context.newCDPSession(page);
  try {
    const result = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    const targetId = result.targetInfo?.targetId;
    if (!validTargetId(targetId)) throw new Error("Chromium returned an invalid page target ID");
    return targetId;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function waitForTargetPage(
  context: BrowserContext,
  targetId: string,
  timeoutMs: number,
): Promise<Page | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const pages = context.pages().filter((page) => !page.isClosed());
    const targetIds = await Promise.all(pages.map((page) => chromiumTargetId(context, page).catch(() => "")));
    const index = targetIds.indexOf(targetId);
    if (index >= 0) return pages[index] ?? null;
    if (Date.now() >= deadline) return null;
    await sleep(10);
  } while (true);
}

function sanitizeEvaluatorState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.create(null);
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 512_000) throw new Error("state is too large");
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return Object.create(null);
  }
}

function boundBrowserEvalResult(result: BrowserEvalResult, maxChars: number): BrowserEvalResult {
  const length = () => JSON.stringify(result).length;
  if (length() <= maxChars) return result;
  result.truncated = true;
  result.console = boundStringList(result.console ?? [], Math.min(2_000, Math.floor(maxChars / 8)));
  result.events = boundStringList(result.events ?? [], Math.min(2_000, Math.floor(maxChars / 8)));
  result.pages = result.pages.slice(0, 8).map((page) => ({
    ...page,
    url: truncatePlain(page.url, 512),
    title: truncatePlain(page.title, 128),
  }));
  if (length() <= maxChars) return result;

  let rawValue: string;
  try {
    rawValue = typeof result.value === "string" ? result.value : JSON.stringify(result.value);
  } catch {
    rawValue = "[non-serializable value]";
  }
  const marker = "\n...[result truncated to browser output budget]";
  result.value = marker;
  let low = 0;
  let high = rawValue.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    result.value = `${rawValue.slice(0, middle)}${marker}`;
    if (length() <= maxChars) low = middle;
    else high = middle - 1;
  }
  result.value = `${rawValue.slice(0, low)}${marker}`;
  if (length() <= maxChars) return result;

  return {
    value: "[browser result exceeded its output budget]",
    console: [],
    pages: [],
    events: [],
    screenshots: (result.screenshots ?? []).slice(0, MAX_SCREENSHOTS_PER_EVAL),
    elapsedMs: result.elapsedMs,
    truncated: true,
  };
}

function boundStringList(values: string[], maxChars: number): string[] {
  const bounded: string[] = [];
  let used = 0;
  for (const value of values) {
    if (used >= maxChars) break;
    const next = truncatePlain(value, Math.min(500, maxChars - used));
    bounded.push(next);
    used += next.length;
  }
  return bounded;
}

function truncatePlain(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

function uniqueArtifactPath(root: string, requested: string, extension = ""): string {
  const base = safeArtifactPath(root, requested, extension);
  const dot = base.lastIndexOf(".");
  const stem = dot > Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) ? base.slice(0, dot) : base;
  const ext = dot > Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) ? base.slice(dot) : "";
  return `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`;
}

function truncateOneLine(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}...`;
}
