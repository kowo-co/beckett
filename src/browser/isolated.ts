/**
 * Daemon-side supervisor for the browser host subprocess.
 *
 * A BetterWright host owns multiple concurrent, session-scoped leases; the legacy Playwright
 * controller retains its one-host-per-lease isolation. Chromium profile state remains on disk
 * while every BetterWright session is named for its run. Production modes fail closed when their
 * OS sandbox is unavailable; explicit process-only mode exists for local benchmark development
 * and is never selected automatically.
 */

import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Logger } from "../types.ts";
import { openTrustedBrowserAttachment, type TrustedBrowserAttachment } from "./attachments.ts";
import { runBrowserEvaluator } from "./evaluator-runner.ts";
import { laneStorageQuotaMib, resolveLaneStorageBytes } from "./storage-quota.ts";
import type { BrowserHostRequest, BrowserHostResponse, BrowserHostMethod } from "./host.ts";
import type {
  BrowserEvalCallOptions,
  BrowserEvalResult,
  BrowserCheckpoint,
  BrowserBudgetOverrides,
  BrowserEvaluatorOutput,
  BrowserEvaluatorSession,
  BrowserHostSettings,
  BrowserLease,
  BrowserLiveViewStatus,
  BrowserRuntime,
  BrowserRuntimeStats,
} from "./runtime.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const HOST_PATH = join(MODULE_DIR, "host.ts");
const CLOAK_SHIM_SOURCE = join(MODULE_DIR, "cloak-storage-quota.mjs");
/** Directory name the shim is published under, beside the built host bundle. */
const CLOAK_SHIM_DIR_NAME = "cloak-storage-quota";
/** Where the bound host bundle (and so the shim beside it) lives inside bubblewrap. */
const SANDBOX_HOST_DIR = "/repo/node_modules/.cache/beckett-browser";
const HOST_BUNDLES = new Map<string, Promise<BrowserHostArtifacts>>();
const MAX_HOST_LINE_CHARS = 32 * 1024 * 1024;
const MAX_CODE_CHARS = 100_000;

/** Built host bundle plus the CloakBrowser wrapper shim published alongside it. */
interface BrowserHostArtifacts {
  hostPath: string;
  /** Directory holding `dist/index.js`, the value BETTERWRIGHT_CLOAKBROWSER_PATH takes. */
  cloakShimDir: string;
}

type HostChild = ReturnType<typeof Bun.spawn>;
type SandboxMode = "auto" | "none" | "macos";

interface PendingRequest {
  child: HostChild;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * Visual browser captures remain PNGs because MCP delivers them as image/png;
 * upload validation itself is broader (see attachments.ts).
 */
function openTrustedArtifactPng(source: string, artifactsDir: string): TrustedBrowserAttachment {
  const trusted = openTrustedBrowserAttachment(source, [artifactsDir]);
  if (trusted.kind === "png") return trusted;
  closeSync(trusted.fd);
  throw new Error("browser screenshot is not a PNG");
}

/** Public for focused boundary tests and for every future artifact consumer. */
export function assertTrustedArtifactPng(source: string, artifactsDir: string): string {
  const trusted = openTrustedArtifactPng(source, artifactsDir);
  closeSync(trusted.fd);
  return trusted.sourcePath;
}

export interface CreateIsolatedBrowserRuntimeDeps {
  settings: BrowserHostSettings;
  logger: Logger;
  spawn?: typeof Bun.spawn;
  platform?: NodeJS.Platform;
  sandbox?: SandboxMode;
  execPath?: string;
  chromiumExecutable?: string;
  /** Managed CloakBrowser cache dir bound into the betterwright sandbox. */
  cloakCacheDir?: string;
  /** Host Obscura install root bound read-only into the betterwright sandbox. */
  obscuraRoot?: string;
  /** Host BetterWright Chromium fork artifact root bound read-only into the betterwright sandbox. */
  chromiumForkRoot?: string;
  repoRoot?: string;
  bwrapPath?: string;
  sandboxExecPath?: string;
  nodePath?: string;
  prlimitPath?: string;
  evaluatorPath?: string;
  /** Browser backend. Legacy callers retain the direct controller for focused tests. */
  backend?: "playwright" | "betterwright";
  /** Focused integration-test reductions; runtime hard limits cannot be raised. */
  hostBudgetOverrides?: BrowserBudgetOverrides;
}

export interface BrowserHostLaunch {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  isolation: "bubblewrap" | "sandbox-exec" | "process";
}

interface BuildBrowserHostLaunchOptions {
  settings: BrowserHostSettings;
  platform: NodeJS.Platform;
  sandbox: SandboxMode;
  execPath: string;
  nodePath?: string;
  hostPath: string;
  chromiumExecutable: string;
  cloakCacheDir?: string;
  /** Host Obscura install root bound read-only into the betterwright sandbox. */
  obscuraRoot?: string;
  /** Host BetterWright Chromium fork artifact root bound read-only into the betterwright sandbox. */
  chromiumForkRoot?: string;
  /**
   * Host directory holding the CloakBrowser wrapper shim's `dist/index.js`. Only the
   * betterwright backend loads it; without it the lane keeps CloakBrowser's fabricated
   * storage quota, so startHost always supplies it.
   */
  cloakShimDir?: string;
  repoRoot: string;
  bwrapPath?: string;
  sandboxExecPath?: string;
  prlimitPath?: string;
  parentEnv?: NodeJS.ProcessEnv;
  budgetOverrides?: BrowserBudgetOverrides;
  backend?: "playwright" | "betterwright";
}

/**
 * Obscura enablement for the sandboxed betterwright host. The sandbox sets
 * HOME=/tmp/home, so betterwright's implicit ~/.betterwright/obscura discovery
 * can never find the host install; instead, when the pinned binary exists on the
 * host we point BETTERWRIGHT_OBSCURA_ROOT at it (and bind it read-only in bwrap).
 * Explicit roots are STRICT in betterwright (missing binary throws), which is why
 * the env var is gated on the binary existing. When it does not exist we set
 * nothing: implicit discovery inside the sandbox finds nothing and betterwright
 * falls back to the Chromium/Cloak compatibility backend (resolveObscuraBinary
 * returns null for an absent implicit install). A root configured as "off"
 * keeps the pre-1.7 pin as an operator kill switch. Note: an explicit root skips
 * betterwright's version-marker check; deploy refreshes the install via
 * `betterwright setup`, keeping the binary at the package's pin.
 */
export function obscuraLaunch(options: {
  obscuraRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
}): { env: Record<string, string>; mountRoot: string | null } {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;
  const root = options.obscuraRoot.trim();
  if (root.toLowerCase() === "off") return { env: { BETTERWRIGHT_OBSCURA_PATH: "off" }, mountRoot: null };
  const binary = join(root, `${platform}-${arch}`, platform === "win32" ? "obscura.exe" : "obscura");
  if (!exists(binary)) return { env: {}, mountRoot: null };
  return { env: { BETTERWRIGHT_OBSCURA_ROOT: root }, mountRoot: root };
}

/**
 * Per-platform binary layout under a BetterWright Chromium fork artifact root, mirroring
 * betterwright's own (unexported) `PLATFORM_LAYOUT` in `src/chromium-fork.ts`. Duplicated
 * here rather than imported because the resolver is internal to the package; only the
 * shipped platforms (macOS arm64, Linux x64, Windows x64) have an artifact at all.
 */
const CHROMIUM_FORK_PLATFORM_LAYOUT: Record<string, string> = {
  "darwin-arm64": join("mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
  "linux-x64": join("linux-x64", "chrome"),
  "win32-x64": join("win-x64", "chrome.exe"),
};

/**
 * BetterWright Chromium fork enablement for the sandboxed betterwright host, mirroring
 * obscuraLaunch above for the same reason: the sandbox sets HOME=/tmp/home, so
 * betterwright's implicit ~/.betterwright/chromium discovery can never find the host
 * install, and BETTERWRIGHT_CHROMIUM_ROOT never survives bwrap's --clearenv unless it is
 * both re-set with --setenv and its target directory is bound into the sandbox's mount
 * namespace. When the pinned fork artifact exists on the host we point
 * BETTERWRIGHT_CHROMIUM_ROOT at it (and bind it read-only in bwrap); explicit roots are
 * STRICT in betterwright (a configured-but-missing binary throws), which is why the env
 * var is gated on the binary existing. When it does not exist we set nothing: implicit
 * discovery inside the sandbox finds nothing and betterwright falls back to managed
 * CloakBrowser. A root configured as "off" keeps the CloakBrowser-only path as an
 * operator kill switch.
 */
export function chromiumForkLaunch(options: {
  chromiumRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
}): { env: Record<string, string>; mountRoot: string | null } {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;
  const root = options.chromiumRoot.trim();
  if (root.toLowerCase() === "off") return { env: { BETTERWRIGHT_CHROMIUM_PATH: "off" }, mountRoot: null };
  const layout = CHROMIUM_FORK_PLATFORM_LAYOUT[`${platform}-${arch}`];
  if (!layout) return { env: {}, mountRoot: null };
  const binary = join(root, layout);
  if (!exists(binary)) return { env: {}, mountRoot: null };
  return { env: { BETTERWRIGHT_CHROMIUM_ROOT: root }, mountRoot: root };
}

/** Pure command builder, exported so Linux/macOS sandbox policy remains unit-testable. */
export function buildBrowserHostLaunch(options: BuildBrowserHostLaunchOptions): BrowserHostLaunch {
  const repoRoot = resolve(options.repoRoot);
  const nodePath = realpathIfPossible(options.nodePath ?? options.execPath);
  const hostPath = realpathIfPossible(options.hostPath);
  const browserRoot = playwrightBrowserRoot(options.chromiumExecutable);
  const hostHome = join(options.settings.profileDir, ".host-home");
  // Chromium places a SingletonSocket below TMPDIR and Linux limits Unix socket paths to roughly
  // 108 bytes. A short 0700 temp root avoids profile paths making otherwise valid launches abort.
  const profileHash = createHash("sha256").update(options.settings.profileDir).digest("hex").slice(0, 12);
  const hostTmp = join("/tmp", `beckett-browser-${profileHash}`);
  mkdirSync(options.settings.profileDir, { recursive: true, mode: 0o700 });
  mkdirSync(options.settings.artifactsRoot, { recursive: true, mode: 0o700 });
  // Mount even an empty configured root so media created after this long-lived host starts is
  // visible to a later browser run. A non-directory fails loudly instead of becoming a file root.
  for (const root of attachmentRoots(options.settings)) mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(hostHome, { recursive: true, mode: 0o700 });
  mkdirSync(hostTmp, { recursive: true, mode: 0o700 });

  // One number governs the lane's storage: what pages are told they may keep, the
  // largest single file the sandbox will let Chromium write, and (in betterwright.ts)
  // the profile's on-disk ceiling. See storage-quota.ts.
  const laneStorageBytes = resolveLaneStorageBytes({ profileDir: options.settings.profileDir });
  const encodedSettings = Buffer.from(JSON.stringify(options.settings), "utf8").toString("base64url");
  const encodedBudgets = options.budgetOverrides
    ? Buffer.from(JSON.stringify(options.budgetOverrides), "utf8").toString("base64url")
    : undefined;
  // The betterwright backend launches the managed CloakBrowser, which resolves
  // its signed binary from CLOAKBROWSER_CACHE_DIR (defaulting to ~/.cloakbrowser).
  // Point it at the host's cache and pin auto-update off so a persistent, network
  // isolated session never tries to (and fails to) rewrite a read-only mount.
  const cloakEnv: Record<string, string> =
    options.backend === "betterwright" && options.cloakCacheDir
      ? { CLOAKBROWSER_CACHE_DIR: options.cloakCacheDir, CLOAKBROWSER_AUTO_UPDATE: "false" }
      : {};
  const obscura = options.backend === "betterwright" && options.obscuraRoot
    ? obscuraLaunch({ obscuraRoot: options.obscuraRoot, platform: options.platform })
    : { env: {}, mountRoot: null };
  const chromiumFork = options.backend === "betterwright" && options.chromiumForkRoot
    ? chromiumForkLaunch({ chromiumRoot: options.chromiumForkRoot, platform: options.platform })
    : { env: {}, mountRoot: null };
  // The shim reads the budget from the environment and appends CloakBrowser's
  // --fingerprint-storage-quota, the only switch that moves what
  // navigator.storage.estimate() reports. Inside bubblewrap the shim is bound beside
  // the host bundle, so BetterWright loads it from the sandbox's own path.
  const storageEnv = (sandboxed: boolean): Record<string, string> =>
    options.backend === "betterwright" && options.cloakShimDir
      ? {
        BECKETT_BROWSER_STORAGE_QUOTA_MIB: String(laneStorageQuotaMib(laneStorageBytes)),
        BETTERWRIGHT_CLOAKBROWSER_PATH: sandboxed
          ? join(SANDBOX_HOST_DIR, CLOAK_SHIM_DIR_NAME)
          : options.cloakShimDir,
      }
      : {};
  // Forward the betterwright adapter's concurrent-lease controls into the host
  // so the cap and the single-lease kill switch operate inside the sandbox.
  // Only forward what is actually set, so a default launch's command is unchanged.
  const leaseEnv: Record<string, string> = {};
  for (const name of ["BECKETT_BROWSER_MAX_LEASES", "BECKETT_BROWSER_SINGLE_LEASE"]) {
    const value = options.parentEnv?.[name];
    if (typeof value === "string" && value.length > 0) leaseEnv[name] = value;
  }
  // BetterWright >=1.8.2 picks its backend by probing /dev/dri for an accessible render
  // device. The sandbox's minimal --dev exposes no such device, so the lane always reads
  // as GPU-less and auto-routes to managed CloakBrowser even on a GPU-equipped host.
  // BETTERWRIGHT_BACKEND=auto|chromium-fork|cloak is upstream's documented override for
  // exactly this case (containers and OS sandboxes that hide the device tree), and it
  // cannot survive --clearenv unless forwarded. Forwarded only when the operator set it,
  // so a default launch's command line is byte-for-byte unchanged and `auto` still rules.
  const backendEnv: Record<string, string> = {};
  if (options.backend === "betterwright") {
    const value = options.parentEnv?.BETTERWRIGHT_BACKEND;
    if (typeof value === "string" && value.trim().length > 0) backendEnv.BETTERWRIGHT_BACKEND = value.trim();
  }
  const baseEnv: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: hostHome,
    TMPDIR: hostTmp,
    XDG_CACHE_HOME: join(hostTmp, "cache"),
    XDG_CONFIG_HOME: join(hostTmp, "config"),
    LANG: "C.UTF-8",
    PLAYWRIGHT_BROWSERS_PATH: browserRoot,
    BECKETT_BROWSER_HOST_SETTINGS: encodedSettings,
    BECKETT_BROWSER_BACKEND: options.backend ?? "playwright",
    ...cloakEnv,
    ...obscura.env,
    ...chromiumFork.env,
    ...backendEnv,
    ...storageEnv(false),
    ...leaseEnv,
    ...(encodedBudgets ? { BECKETT_BROWSER_HOST_BUDGETS: encodedBudgets } : {}),
  };
  if (options.sandbox === "none") {
    return {
      command: [nodePath, hostPath],
      cwd: repoRoot,
      env: baseEnv,
      isolation: "process",
    };
  }

  if (options.platform === "linux") {
    const bwrap = options.bwrapPath ?? findExecutable("bwrap", options.parentEnv?.PATH);
    if (!bwrap) {
      throw new Error("secure computer-use on Linux requires bubblewrap (bwrap) in PATH");
    }
    const prlimit = options.prlimitPath ?? findExecutable("prlimit", options.parentEnv?.PATH);
    if (!prlimit) throw new Error("secure computer-use on Linux requires prlimit (util-linux) in PATH");
    const args = [
      bwrap,
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/tmp/home",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "XDG_CACHE_HOME",
      "/tmp/cache",
      "--setenv",
      "XDG_CONFIG_HOME",
      "/tmp/config",
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--setenv",
      "PLAYWRIGHT_BROWSERS_PATH",
      "/ms-playwright",
      "--setenv",
      "BECKETT_BROWSER_HOST_SETTINGS",
      encodedSettings,
      "--setenv",
      "BECKETT_BROWSER_BACKEND",
      options.backend ?? "playwright",
    ];
    if (encodedBudgets) args.push("--setenv", "BECKETT_BROWSER_HOST_BUDGETS", encodedBudgets);
    for (const [name, value] of Object.entries(cloakEnv)) args.push("--setenv", name, value);
    for (const [name, value] of Object.entries(obscura.env)) args.push("--setenv", name, value);
    for (const [name, value] of Object.entries(chromiumFork.env)) args.push("--setenv", name, value);
    for (const [name, value] of Object.entries(backendEnv)) args.push("--setenv", name, value);
    for (const [name, value] of Object.entries(storageEnv(true))) args.push("--setenv", name, value);
    for (const [name, value] of Object.entries(leaseEnv)) args.push("--setenv", name, value);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    addLinuxSystemMounts(args);
    // Attachment roots are read-only. They are mounted before the writable profile/artifact
    // overlays so the explicit run roots keep their existing write policy even when '/' is set.
    for (const root of attachmentRoots(options.settings)) {
      if (existsSync(root)) args.push("--ro-bind", root, root);
    }
    // bwrap creates missing parents for bind destinations. /runtime is explicit because its child
    // is a file mount rather than a directory mount.
    args.push(
      "--dir",
      "/runtime",
      "--ro-bind",
      nodePath,
      "/runtime/node",
      "--ro-bind",
      browserRoot,
      "/ms-playwright",
      "--bind",
      options.settings.profileDir,
      options.settings.profileDir,
      "--bind",
      options.settings.artifactsRoot,
      options.settings.artifactsRoot,
      "--dir",
      "/tmp/home",
      "--dir",
      "/tmp/cache",
      "--dir",
      "/tmp/config",
    );
    // Expose the managed CloakBrowser binary at its host path (CLOAKBROWSER_CACHE_DIR
    // points here) so betterwright can launch it without a writable download step.
    if (options.backend === "betterwright" && options.cloakCacheDir && existsSync(options.cloakCacheDir)) {
      args.push("--ro-bind", options.cloakCacheDir, options.cloakCacheDir);
    }
    // Obscura's pinned binary, read-only at its host path (BETTERWRIGHT_OBSCURA_ROOT
    // points here). obscuraLaunch only emits a mountRoot when the binary exists.
    if (obscura.mountRoot) args.push("--ro-bind", obscura.mountRoot, obscura.mountRoot);
    // BetterWright Chromium fork artifact root, read-only at its host path
    // (BETTERWRIGHT_CHROMIUM_ROOT points here). chromiumForkLaunch only emits a
    // mountRoot when the binary exists, mirroring Obscura above.
    if (chromiumFork.mountRoot) args.push("--ro-bind", chromiumFork.mountRoot, chromiumFork.mountRoot);
    // Read-only, and beside the host bundle rather than under /repo/src, so the shim
    // resolves `cloakbrowser` from the node_modules already bound below.
    if (options.backend === "betterwright" && options.cloakShimDir) {
      args.push(
        "--ro-bind",
        join(options.cloakShimDir, "dist", "index.js"),
        join(SANDBOX_HOST_DIR, CLOAK_SHIM_DIR_NAME, "dist", "index.js"),
      );
    }
    addBrowserRuntimeMounts(args, repoRoot, hostPath);
    args.push("--chdir", "/repo", "--", "/runtime/node", join(SANDBOX_HOST_DIR, "host.mjs"));
    // bwrap receives a minimal environment too; --clearenv controls the sandboxed child.
    return {
      // Chromium inherits this per-file ceiling, so a download cannot fill the disk before the
      // controller's aggregate streaming budget gets a chance to cancel and delete it. It is the
      // lane's whole storage budget rather than a separate smaller number: CacheStorage keeps one
      // file per entry, so any ceiling below the budget silently caps a single cached asset — and
      // Chromium does not survive the SIGXFSZ, it dies mid-fetch and the page sees a network error.
      command: [prlimit, `--fsize=${laneStorageBytes}`, "--", ...args],
      cwd: repoRoot,
      env: { PATH: options.parentEnv?.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      isolation: "bubblewrap",
    };
  }

  if (options.platform === "darwin") {
    const sandboxExec = options.sandboxExecPath ?? (existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : undefined);
    if (sandboxExec) {
      const profile = macSandboxProfile({
        repoRoot,
        execPath: nodePath,
        browserRoot,
        cloakCacheDir: options.backend === "betterwright" ? options.cloakCacheDir : undefined,
        obscuraRoot: obscura.mountRoot ?? undefined,
        chromiumForkRoot: chromiumFork.mountRoot ?? undefined,
        profileDir: options.settings.profileDir,
        artifactsRoot: options.settings.artifactsRoot,
        attachmentRoots: attachmentRoots(options.settings),
        hostTmp,
      });
      return {
        command: [sandboxExec, "-p", profile, nodePath, hostPath],
        cwd: repoRoot,
        env: baseEnv,
        isolation: "sandbox-exec",
      };
    }
    throw new Error(
      "secure computer-use on macOS requires sandbox-exec; use explicit process-only mode only for local testing",
    );
  }

  throw new Error(`secure computer-use is unsupported on ${options.platform}; use explicit process-only mode only for testing`);
}

function browserHostBundle(repoRoot: string): Promise<BrowserHostArtifacts> {
  const root = resolve(repoRoot);
  const existing = HOST_BUNDLES.get(root);
  if (existing) return existing;
  const pending = buildBrowserHostBundle(root).catch((error) => {
    HOST_BUNDLES.delete(root);
    throw error;
  });
  HOST_BUNDLES.set(root, pending);
  return pending;
}

async function buildBrowserHostBundle(repoRoot: string): Promise<BrowserHostArtifacts> {
  const nodeModules = join(repoRoot, "node_modules");
  const cacheParent = join(nodeModules, ".cache");
  const cacheRoot = join(cacheParent, "beckett-browser");
  for (const path of [nodeModules, cacheParent, cacheRoot]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`browser host bundle path must not contain symlinks: ${path}`);
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const tempDir = join(cacheRoot, `.build-${process.pid}-${randomUUID()}`);
  mkdirSync(tempDir, { mode: 0o700 });
  try {
    const result = await Bun.build({
      entrypoints: [HOST_PATH],
      outdir: tempDir,
      naming: "host.mjs",
      target: "node",
      format: "esm",
      // BetterWright starts its packaged worker by path, so it must remain an
      // external module rather than being folded into this host bundle.
      external: ["betterwright", "playwright", "playwright-core"],
    });
    if (!result.success || result.outputs.length !== 1) {
      const diagnostics = result.logs.map((log) => String(log)).join("\n");
      throw new Error(`could not build Node browser host${diagnostics ? `: ${diagnostics}` : ""}`);
    }
    const target = join(cacheRoot, "host.mjs");
    renameSync(result.outputs[0]!.path, target);
    chmodSync(target, 0o600);
    return { hostPath: realpathSync(target), cloakShimDir: publishCloakShim(cacheRoot) };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Copy the CloakBrowser wrapper shim beside the host bundle, unbundled: BetterWright
 * imports it by path at runtime, and its `cloakbrowser` import has to stay a bare
 * specifier so Node resolves it from the bound `/repo/node_modules` inside the sandbox.
 */
function publishCloakShim(cacheRoot: string): string {
  const shimDir = join(cacheRoot, CLOAK_SHIM_DIR_NAME);
  const distDir = join(shimDir, "dist");
  for (const path of [shimDir, distDir]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`CloakBrowser shim path must not contain symlinks: ${path}`);
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const target = join(distDir, "index.js");
  copyFileSync(CLOAK_SHIM_SOURCE, target);
  chmodSync(target, 0o600);
  return shimDir;
}

export function createIsolatedBrowserRuntime(deps: CreateIsolatedBrowserRuntimeDeps): BrowserRuntime {
  const { settings, logger } = deps;
  const spawn = deps.spawn ?? Bun.spawn;
  const platform = deps.platform ?? process.platform;
  const sandbox = deps.sandbox ?? "auto";
  const backend = deps.backend ?? "playwright";
  const execPath = deps.execPath ?? process.execPath;
  const nodePath = deps.nodePath ?? findExecutable("node", process.env.PATH);
  if (!nodePath) throw new Error("computer-use browser host requires Node.js");
  const chromiumExecutable = deps.chromiumExecutable ?? chromium.executablePath();
  // Managed CloakBrowser (betterwright backend) caches its signed binary here;
  // mirror cloakbrowser's own resolution (CLOAKBROWSER_CACHE_DIR, else ~/.cloakbrowser).
  const cloakCacheDir = deps.cloakCacheDir ?? (process.env.CLOAKBROWSER_CACHE_DIR?.trim() || join(homedir(), ".cloakbrowser"));
  // Mirror betterwright's own Obscura resolution (BETTERWRIGHT_OBSCURA_ROOT, else
  // ~/.betterwright/obscura); obscuraLaunch gates the env var on the binary existing.
  const obscuraRoot = deps.obscuraRoot ?? (process.env.BETTERWRIGHT_OBSCURA_ROOT?.trim() || join(homedir(), ".betterwright", "obscura"));
  // Mirror betterwright's own Chromium fork resolution (BETTERWRIGHT_CHROMIUM_ROOT, else
  // ~/.betterwright/chromium); chromiumForkLaunch gates the env var on the binary existing.
  const chromiumForkRoot = deps.chromiumForkRoot ?? (process.env.BETTERWRIGHT_CHROMIUM_ROOT?.trim() || join(homedir(), ".betterwright", "chromium"));
  const repoRoot = deps.repoRoot ?? resolve(MODULE_DIR, "../..");

  let child: HostChild | null = null;
  let hostIsolation: BrowserHostLaunch["isolation"] | null = null;
  let starting: Promise<void> | null = null;
  // BetterWright sessions coexist in one host. The legacy Playwright controller remains
  // deliberately single-lease, preserving its evaluator process and profile semantics.
  const configuredCap = Number.parseInt(process.env.BECKETT_BROWSER_MAX_LEASES ?? "3", 10);
  const singleLease = /^(1|true|yes|on)$/i.test(process.env.BECKETT_BROWSER_SINGLE_LEASE?.trim() ?? "");
  const maxConcurrentLeases = backend === "betterwright" && !singleLease
    ? Math.min(16, Math.max(1, Number.isInteger(configuredCap) && configuredCap > 0 ? configuredCap : 3))
    : 1;
  const hostLeaseRunIds = new Set<string>();
  const leases = new Map<string, BrowserLease>();
  let stopped = false;
  let nextRequestId = 1;
  let pending = new Map<number, PendingRequest>();
  let launches = 0;
  let evaluations = 0;
  let totalEvalMs = 0;
  let pages = 0;
  let evaluationQueue: Promise<void> = Promise.resolve();
  const delivered = new Map<string, string>();

  function serializeEvaluation<T>(task: () => Promise<T>): Promise<T> {
    const running = evaluationQueue.then(task, task);
    evaluationQueue = running.then(() => undefined, () => undefined);
    return running;
  }

  function requireLease(runId: string): BrowserLease {
    const lease = leases.get(runId);
    if (!lease) throw new Error(`browser lease ${runId} is not active`);
    return lease;
  }

  function requireControlToken(current: BrowserLease, supplied: string | undefined): void {
    const expected = Buffer.from(current.controlToken);
    const actual = Buffer.from(supplied ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("browser control capability rejected");
    }
  }

  function rejectPendingFor(target: HostChild, error: Error): void {
    for (const [id, request] of pending) {
      if (request.child !== target) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
  }

  function markHostExited(target: HostChild, error: Error): void {
    rejectPendingFor(target, error);
    if (child === target) {
      child = null;
      hostIsolation = null;
      hostLeaseRunIds.clear();
      pages = 0;
    }
  }

  async function killHost(target: HostChild, reason: Error): Promise<void> {
    markHostExited(target, reason);
    killProcessGroup(target);
    await target.exited.catch(() => undefined);
  }

  function killProcessGroup(target: HostChild): void {
    try {
      if (target.pid > 0) process.kill(-target.pid, "SIGKILL");
      else target.kill("SIGKILL");
    } catch {
      try {
        target.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
  }

  function rpc(method: BrowserHostMethod, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const target = child;
    if (!target) return Promise.reject(new Error("isolated browser host is not running"));
    const id = nextRequestId++;
    const request: BrowserHostRequest = { version: 1, id, method, params };
    return new Promise((resolveValue, rejectValue) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`isolated browser host ${method} timed out after ${timeoutMs}ms`);
        rejectValue(error);
        void killHost(target, error);
      }, timeoutMs);
      pending.set(id, { child: target, timer, resolve: resolveValue, reject: rejectValue });
      try {
        const input = target.stdin;
        if (!input || typeof input === "number") throw new Error("isolated browser host stdin is unavailable");
        input.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        rejectValue(error as Error);
        void killHost(target, error as Error);
      }
    });
  }

  async function consumeStdout(target: HostChild): Promise<void> {
    const stream = target.stdout;
    if (!stream || typeof stream === "number") throw new Error("isolated browser host stdout is unavailable");
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > MAX_HOST_LINE_CHARS) throw new Error("isolated browser host output exceeded size limit");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) receiveResponse(target, line);
        newline = buffered.indexOf("\n");
      }
    }
    if (buffered.trim()) throw new Error("isolated browser host emitted an unterminated response");
  }

  function receiveResponse(target: HostChild, line: string): void {
    let response: BrowserHostResponse;
    try {
      response = JSON.parse(line) as BrowserHostResponse;
    } catch {
      throw new Error("isolated browser host emitted invalid JSON");
    }
    if (response.version !== 1 || !Number.isSafeInteger(response.id) || typeof response.ok !== "boolean") {
      throw new Error("isolated browser host emitted an invalid response envelope");
    }
    const request = pending.get(response.id);
    if (!request || request.child !== target) throw new Error(`isolated browser host emitted unknown response ${response.id}`);
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok) request.resolve(response.data);
    else request.reject(new Error(response.error ?? "isolated browser host request failed"));
  }

  async function consumeStderr(target: HostChild): Promise<void> {
    const stream = target.stderr;
    if (!stream || typeof stream === "number") return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let tail = "";
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-2_000);
    }
    tail = tail.trim();
    if (tail) logger.debug("isolated browser host diagnostics", { tail });
  }

  function hostSettingsForLease(_current: BrowserLease): BrowserHostSettings {
    // The shared host must be sandboxed against the common artifacts root, not whichever run
    // happened to start it. Per-run artifact paths are still validated by the host runtime.
    return settings;
  }

  async function startHost(current: BrowserLease, forceProcess = false): Promise<void> {
    if (child) return;
    if (stopped) throw new Error("browser runtime is stopped");
    const currentSettings = hostSettingsForLease(current);
    const { hostPath, cloakShimDir } = await browserHostBundle(repoRoot);
    const launch = buildBrowserHostLaunch({
      settings: currentSettings,
      platform,
      sandbox: forceProcess ? "none" : sandbox,
      execPath,
      nodePath,
      hostPath,
      chromiumExecutable,
      cloakCacheDir,
      obscuraRoot,
      chromiumForkRoot,
      cloakShimDir,
      repoRoot,
      bwrapPath: deps.bwrapPath,
      sandboxExecPath: deps.sandboxExecPath,
      prlimitPath: deps.prlimitPath,
      parentEnv: process.env,
      budgetOverrides: deps.hostBudgetOverrides,
      backend,
    });
    if (launch.isolation === "process") {
      logger.warn("browser host has process isolation only; filesystem sandboxing is unavailable", { platform });
    }
    const target = spawn({
      cmd: launch.command,
      cwd: launch.cwd,
      env: launch.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    child = target;
    hostIsolation = launch.isolation;
    void consumeStdout(target).catch((error) => killHost(target, error as Error));
    void consumeStderr(target);
    void target.exited.then((code) => {
      markHostExited(target, new Error(`isolated browser host exited with code ${code}`));
      // The host is Chromium's process-group leader, so reap descendants after any unexpected
      // controller failure even when the normal runtime.stop() path never ran.
      killProcessGroup(target);
    });
    await rpc("stats", {}, 5_000);
    logger.info("isolated browser host ready", { isolation: launch.isolation, runId: current.runId });
  }

  async function ensureHost(current: BrowserLease): Promise<void> {
    if (child) return;
    if (starting) return starting;
    starting = startHost(current, false).finally(() => {
      starting = null;
    });
    return starting;
  }

  async function acquireInHost(current: BrowserLease): Promise<void> {
    try {
      await ensureHost(current);
      if (stopped) throw new Error("browser acquisition was interrupted by shutdown");
      if (hostLeaseRunIds.has(current.runId)) return;
      const hostLease = { runId: current.runId, channelId: current.channelId, artifactsDir: current.artifactsDir };
      const stats = (await rpc("acquire", hostLease, settings.launchTimeoutMs + 5_000)) as BrowserRuntimeStats;
      if (stopped) throw new Error("browser acquisition was interrupted by shutdown");
      hostLeaseRunIds.add(current.runId);
      launches++;
      pages = stats.pages;
    } catch (error) {
      throw error;
    }
  }

  async function checkpointInHost(current: BrowserLease): Promise<BrowserCheckpoint> {
    await acquireInHost(current);
    return await rpc("checkpoint", { runId: current.runId }, settings.actionTimeoutMs + 2_000) as BrowserCheckpoint;
  }

  async function restoreInHost(current: BrowserLease, checkpoint: BrowserCheckpoint): Promise<void> {
    await rpc("restore", { runId: current.runId, checkpoint }, settings.navigationTimeoutMs + 5_000);
  }

  function trustedPng(source: string, current: BrowserLease, preserveSource = false): string {
    const existing = delivered.get(source);
    if (existing) return existing;
    const artifactsDir = resolve(current.artifactsDir);
    let trusted: TrustedBrowserAttachment | null = null;
    let deliveryTarget: string | null = null;
    try {
      // This is the shared containment/regular-file/size/PNG signature gate for
      // both visual delivery and the later attachFile bridge.
      trusted = openTrustedArtifactPng(source, artifactsDir);
      const deliveryDir = join(dirname(artifactsDir), "deliveries");
      mkdirSync(deliveryDir, { recursive: true, mode: 0o700 });
      deliveryTarget = join(deliveryDir, `${basename(trusted.sourcePath, ".png")}-${randomUUID().slice(0, 8)}.png`);
      const output = openSync(deliveryTarget, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (offset < trusted.size) {
          const count = readSync(trusted.fd, buffer, 0, Math.min(buffer.length, trusted.size - offset), offset);
          if (count <= 0) throw new Error("browser screenshot ended while copying");
          let written = 0;
          while (written < count) written += writeSync(output, buffer, written, count - written);
          offset += count;
        }
      } finally {
        closeSync(output);
      }
      delivered.set(source, deliveryTarget);
      return deliveryTarget;
    } catch (error) {
      if (deliveryTarget) {
        try {
          unlinkSync(deliveryTarget);
        } catch {
          // No trusted partial should survive a failed copy.
        }
      }
      throw error;
    } finally {
      if (trusted) closeSync(trusted.fd);
      if (!preserveSource && trusted) {
        try {
          unlinkSync(trusted.sourcePath);
        } catch {
          // The trusted copy is authoritative; source cleanup is best effort.
        }
      }
    }
  }

  function deliverEvaluation(result: BrowserEvalResult, current: BrowserLease): BrowserEvalResult {
    const sources = result.screenshots ?? [];
    if (sources.length === 0) return result;
    const attachments = sources.map((path) => assertTrustedArtifactPng(path, current.artifactsDir));
    return {
      ...result,
      screenshots: attachments.map((path) => trustedPng(path, current, true)),
      // Unlike display copies, these source files remain under the per-run
      // artifact directory so a later attachFile can name only this trusted PNG.
      attachments,
    };
  }

  async function terminateLeaseHost(): Promise<void> {
    const target = child;
    if (!target) return;
    try {
      await rpc("stop", {}, Math.max(5_000, settings.actionTimeoutMs));
      const input = target.stdin;
      if (input && typeof input !== "number") input.end();
      await Promise.race([
        target.exited,
        Bun.sleep(2_000).then(() => {
          throw new Error("isolated browser host did not exit after stop");
        }),
      ]);
    } catch (error) {
      await killHost(target, error as Error);
    } finally {
      markHostExited(target, new Error("isolated browser host stopped"));
    }
  }

  return {
    async acquire(nextLease) {
      if (stopped) throw new Error("browser runtime is stopped");
      if (!nextLease.controlToken || nextLease.controlToken.length < 32) {
        throw new Error("browser lease requires a high-entropy control capability");
      }
      const occupying = leases.values().next().value as BrowserLease | undefined;
      if (leases.has(nextLease.runId) && hostLeaseRunIds.has(nextLease.runId)) return;
      if (!leases.has(nextLease.runId) && leases.size >= maxConcurrentLeases) {
        if (maxConcurrentLeases === 1) {
          throw new Error(`computer-use is busy with run ${occupying?.runId}; retry after it finishes`);
        }
        throw new Error(`browser lease cap of ${maxConcurrentLeases} concurrent session(s) reached; cannot acquire run ${nextLease.runId} until one releases`);
      }
      if (!pathIsWithin(settings.artifactsRoot, resolve(nextLease.artifactsDir))) {
        throw new Error(`browser artifacts must stay below ${settings.artifactsRoot}`);
      }

      // Reserve before any await, closing the cold-start concurrency race.
      const current = { ...nextLease };
      leases.set(current.runId, current);
      try {
        await acquireInHost(current);
      } catch (error) {
        // One failed BetterWright session must not tear down unrelated live sessions.
        if (backend !== "betterwright") {
          const target = child;
          if (target) await killHost(target, error as Error);
        }
        leases.delete(current.runId);
        hostLeaseRunIds.delete(current.runId);
        throw error;
      }
    },

    async evaluate(runId, code, controlToken, options?: BrowserEvalCallOptions) {
      const current = requireLease(runId);
      requireControlToken(current, controlToken);
      if (!code.trim()) throw new Error(`${backend} browser needs non-empty JavaScript`);
      if (code.length > MAX_CODE_CHARS) throw new Error(`${backend} browser code exceeds ${MAX_CODE_CHARS} characters`);
      try {
        const evaluateInHost = async () => {
          if (stopped) throw new Error("browser runtime is stopped");
          await acquireInHost(current);
          if (backend === "betterwright") {
            // BetterWright owns the sandboxed snippet worker and persistent
            // browser session inside the isolated host. No Playwright/CDP
            // session crosses back into Beckett's evaluator process.
            const callTimeoutMs = options?.timeoutMs;
            const result = await rpc(
              "evaluate",
              {
                runId,
                code,
                ...(options?.note ? { note: options.note } : {}),
                ...(callTimeoutMs ? { timeoutMs: callTimeoutMs } : {}),
              },
              Math.max(settings.evalTimeoutMs, callTimeoutMs ?? 0) + settings.actionTimeoutMs + 5_000,
            ) as BrowserEvalResult;
            evaluations++;
            totalEvalMs += result.elapsedMs;
            pages = result.pages.length;
            return deliverEvaluation(result, current);
          }
          const session = await rpc(
            "prepareEvaluation",
            { runId },
            settings.actionTimeoutMs + 2_000,
          ) as BrowserEvaluatorSession;
          const isolation = hostIsolation === "bubblewrap"
            ? "bubblewrap"
            : hostIsolation === "sandbox-exec"
              ? "sandbox-exec"
              : "none";
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
              isolation,
              repoRoot,
              spawn,
              nodePath: deps.nodePath,
              bwrapPath: deps.bwrapPath,
              sandboxExecPath: deps.sandboxExecPath,
              prlimitPath: deps.prlimitPath,
              evaluatorPath: deps.evaluatorPath,
              parentEnv: process.env,
            },
          );
          const result = await rpc(
            "applyEvaluation",
            { runId, evaluated: evaluated as BrowserEvaluatorOutput },
            settings.actionTimeoutMs * 3 + 5_000,
          ) as BrowserEvalResult;
          evaluations++;
          totalEvalMs += result.elapsedMs;
          pages = result.pages.length;
          if (!evaluated.ok) throw new Error(evaluated.error ?? "browser evaluation failed");
          return deliverEvaluation(result, current);
        };
        // BetterWright serializes each session itself; serializing here would turn concurrent
        // sessions back into one global lane. The legacy evaluator remains globally serialized.
        return await (backend === "betterwright" ? evaluateInHost() : serializeEvaluation(evaluateInHost));
      } catch (error) {
        throw markTimeoutUncertain(error);
      }
    },

    async capture(runId, name) {
      const current = requireLease(runId);
      await acquireInHost(current);
      const source = await rpc("capture", { runId, name }, settings.actionTimeoutMs + 5_000) as string;
      return trustedPng(source, current);
    },

    async liveView(runId, action) {
      requireLease(runId);
      // Start may promote an Obscura session to the visual compatibility browser
      // (a browser launch), so it gets the launch budget; stop/status are cheap.
      const timeoutMs = action === "start" ? settings.launchTimeoutMs + 5_000 : settings.actionTimeoutMs + 2_000;
      return (await rpc("liveView", { runId, action }, timeoutMs)) as BrowserLiveViewStatus;
    },

    async checkpoint(runId) {
      return checkpointInHost(requireLease(runId));
    },

    async restore(runId, checkpoint) {
      const current = requireLease(runId);
      await acquireInHost(current);
      await restoreInHost(current, checkpoint);
    },

    async release(runId, captureProof) {
      const current = requireLease(runId);
      try {
        // The BetterWright host orders release behind that run's own work. Only the legacy
        // evaluator needs the global queue before its single host can exit.
        if (backend !== "betterwright") await evaluationQueue;
        if (!child || !hostLeaseRunIds.has(runId)) return [];
        const sources = await rpc(
          "release",
          { runId, captureProof },
          settings.navigationTimeoutMs + settings.actionTimeoutMs + 5_000,
        ) as string[];
        return sources.map((source) => trustedPng(source, current));
      } finally {
        leases.delete(runId);
        hostLeaseRunIds.delete(runId);
        if (backend !== "betterwright") {
          await terminateLeaseHost();
          pages = 0;
        }
      }
    },

    hasLease(runId) {
      return leases.has(runId);
    },

    stats() {
      return {
        ready: child !== null && hostLeaseRunIds.size > 0,
        profileDir: settings.profileDir,
        activeRunId: leases.keys().next().value ?? null,
        activeRunIds: [...leases.keys()],
        maxConcurrentLeases,
        pages,
        launches,
        evaluations,
        averageEvalMs: evaluations === 0 ? 0 : Math.round(totalEvalMs / evaluations),
      };
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      const inFlight = starting;
      if (inFlight) await inFlight.catch(() => undefined);
      await evaluationQueue.catch(() => undefined);
      await terminateLeaseHost();
      leases.clear();
      hostLeaseRunIds.clear();
      pages = 0;
    },
  };
}

function pathIsWithin(root: string, target: string): boolean {
  const offset = relative(resolve(root), resolve(target));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function playwrightBrowserRoot(executable: string): string {
  let current = resolve(executable);
  while (dirname(current) !== current) {
    if (/^(chromium|chromium_headless_shell)-\d+$/.test(basename(current))) return dirname(current);
    current = dirname(current);
  }
  throw new Error(`could not locate Playwright browser bundle above ${executable}`);
}

function findExecutable(name: string, pathValue = process.env.PATH): string | undefined {
  for (const dir of (pathValue ?? "").split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function addBrowserRuntimeMounts(args: string[], repoRoot: string, hostPath: string): void {
  args.push(
    "--dir",
    "/repo",
    "--dir",
    "/repo/node_modules",
    "--dir",
    "/repo/node_modules/.cache",
    "--dir",
    SANDBOX_HOST_DIR,
    "--ro-bind",
    hostPath,
    join(SANDBOX_HOST_DIR, "host.mjs"),
  );
  // betterwright 1.x drives the managed CloakBrowser as this host's backend, so
  // the sandbox must now expose that whole runtime dependency closure: tldts
  // (+ tldts-core) for the credential-vault URL scoping betterwright pulls in,
  // and cloakbrowser's tar extractor (+ its minipass/chownr subtree), which
  // cloakbrowser's entrypoint statically imports. The optional patchright-core
  // stealth driver is deliberately omitted — it is only loaded when
  // stealthRuntimeFix is enabled, which this host never sets.
  for (const packageName of [
    "betterwright",
    "cloakbrowser",
    "playwright",
    "playwright-core",
    "tldts",
    "tldts-core",
    "tar",
    "@isaacs/fs-minipass",
    "chownr",
    "minipass",
    "minizlib",
    "yallist",
  ]) {
    args.push(
      "--ro-bind",
      join(repoRoot, "node_modules", packageName),
      join("/repo/node_modules", packageName),
    );
  }
}

function addLinuxSystemMounts(args: string[]): void {
  for (const path of ["/usr", "/sys", "/var/cache/fontconfig"]) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) args.push("--symlink", readlinkSync(path), path);
    else args.push("--ro-bind", path, path);
  }
  for (const path of [
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/gai.conf",
    "/etc/localtime",
    "/etc/passwd",
    "/etc/group",
    "/etc/ssl",
    "/etc/fonts",
    "/etc/machine-id",
    "/etc/ld.so.cache",
  ]) {
    if (existsSync(path)) args.push("--ro-bind", realpathIfPossible(path), path);
  }
}

function attachmentRoots(settings: BrowserHostSettings): string[] {
  return [...new Set((settings.attachmentRoots ?? []).map((root) => resolve(root)))];
}

function macSandboxProfile(paths: {
  repoRoot: string;
  execPath: string;
  browserRoot: string;
  cloakCacheDir?: string;
  obscuraRoot?: string;
  chromiumForkRoot?: string;
  profileDir: string;
  artifactsRoot: string;
  attachmentRoots: string[];
  hostTmp: string;
}): string {
  const read = [
    "/System",
    "/usr",
    "/Library",
    "/private/etc",
    "/private/var/db",
    "/dev",
    paths.repoRoot,
    paths.execPath,
    paths.browserRoot,
    ...(paths.cloakCacheDir ? [paths.cloakCacheDir] : []),
    ...(paths.obscuraRoot ? [paths.obscuraRoot] : []),
    ...(paths.chromiumForkRoot ? [paths.chromiumForkRoot] : []),
    paths.profileDir,
    paths.artifactsRoot,
    ...paths.attachmentRoots,
    realpathIfPossible(paths.hostTmp),
  ];
  const write = [paths.profileDir, paths.artifactsRoot, realpathIfPossible(paths.hostTmp)];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow network*)",
    "(allow sysctl-read)",
    "(allow mach*)",
    "(allow ipc-posix*)",
    "(allow file-read-metadata)",
    ...read.map((path) => `(allow file-read* (subpath ${sandboxQuote(path)}))`),
    ...write.map((path) => `(allow file-write* (subpath ${sandboxQuote(path)}))`),
    `(allow file-write* (literal ${sandboxQuote("/dev/null")}))`,
  ].join("\n");
}

function sandboxQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("sandbox paths cannot contain control characters");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function markTimeoutUncertain(error: unknown): Error {
  const message = String((error as Error)?.message ?? error);
  if (!/tim(?:eout|ed out)/i.test(message) || /outcome is uncertain/i.test(message)) return new Error(message);
  return new Error(
    `${message}; browser-side work may have continued, so the outcome is uncertain. Inspect current state before retrying any action`,
  );
}
