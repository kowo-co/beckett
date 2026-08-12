import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateConfig } from "../config.ts";
import type { Logger } from "../types.ts";
import { buildBrowserEvaluatorLaunch } from "./evaluator-runner.ts";
import { assertTrustedBrowserAttachment } from "./attachments.ts";
import { assertTrustedArtifactPng, buildBrowserHostLaunch, createIsolatedBrowserRuntime, obscuraLaunch } from "./isolated.ts";
import { browserHostSettings, type BrowserHostSettings } from "./runtime.ts";
import { laneStorageQuotaMib, MIN_LANE_STORAGE_BYTES, resolveLaneStorageBytes } from "./storage-quota.ts";

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();
const CONTROL_TOKEN = "test-control-token-0123456789abcdef0123456789abcdef";

function fixturePaths(): {
  dir: string;
  settings: BrowserHostSettings;
  browser: string;
  host: string;
  node: string;
  prlimit: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-policy-test-"));
  const browser = join(dir, "ms-playwright", "chromium-123", "chrome-linux", "chrome");
  const host = join(dir, "host.mjs");
  const node = join(dir, "node");
  const prlimit = join(dir, "prlimit");
  mkdirSync(dirname(browser), { recursive: true });
  writeFileSync(browser, "fixture");
  writeFileSync(host, "fixture");
  writeFileSync(node, "fixture");
  writeFileSync(prlimit, "fixture");
  return {
    dir,
    browser,
    host,
    node,
    prlimit,
    settings: {
      profileDir: join(dir, "profile"),
      artifactsRoot: join(dir, "run", "artifacts"),
      headless: true,
      viewportWidth: 1440,
      viewportHeight: 900,
      launchTimeoutMs: 30_000,
      actionTimeoutMs: 10_000,
      navigationTimeoutMs: 30_000,
      evalTimeoutMs: 60_000,
      maxOutputChars: 24_000,
    },
  };
}

/** bwrap arguments are positional: a flag only means anything with its own operands. */
function hasTriple(command: string[], triple: [string, string, string]): boolean {
  return command.some((value, index) =>
    value === triple[0] && command[index + 1] === triple[1] && command[index + 2] === triple[2]);
}

describe("obscura launch gating", () => {
  test("an existing platform binary yields an explicit root and a mount", () => {
    const root = "/host/.betterwright/obscura";
    expect(obscuraLaunch({
      obscuraRoot: root,
      platform: "linux",
      arch: "x64",
      exists: (path) => path === join(root, "linux-x64", "obscura"),
    })).toEqual({ env: { BETTERWRIGHT_OBSCURA_ROOT: root }, mountRoot: root });
  });

  test("a missing binary yields nothing, so betterwright falls back to the compatibility backend", () => {
    expect(obscuraLaunch({
      obscuraRoot: "/host/.betterwright/obscura",
      platform: "linux",
      arch: "x64",
      exists: () => false,
    })).toEqual({ env: {}, mountRoot: null });
  });

  test("a root of \"off\" keeps the pre-1.7 pin as an operator kill switch", () => {
    for (const value of ["off", "OFF", " off "]) {
      expect(obscuraLaunch({ obscuraRoot: value, platform: "linux", arch: "x64", exists: () => true }))
        .toEqual({ env: { BETTERWRIGHT_OBSCURA_PATH: "off" }, mountRoot: null });
    }
  });

  test("win32 probes obscura.exe", () => {
    const probed: string[] = [];
    obscuraLaunch({
      obscuraRoot: "C:\\obscura",
      platform: "win32",
      arch: "x64",
      exists: (path) => {
        probed.push(path);
        return false;
      },
    });
    expect(probed).toEqual([join("C:\\obscura", "win32-x64", "obscura.exe")]);
  });
});

describe("browser host sandbox policy", () => {
  test("Linux uses bubblewrap with only the current profile and artifacts writable", () => {
    const fixture = fixturePaths();
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "auto",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        repoRoot: resolve(import.meta.dir, "../.."),
        bwrapPath: "/usr/bin/bwrap",
        prlimitPath: fixture.prlimit,
        parentEnv: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "https://user:secret@proxy.invalid" },
      });
      expect(launch.isolation).toBe("bubblewrap");
      expect(launch.command).toContain("--unshare-all");
      expect(launch.command).toContain("--clearenv");
      expect(launch.command).toContain("--cap-drop");
      expect(launch.command).not.toContain("CAP_SYS_ADMIN");
      expect(launch.command).toContain("/runtime/node");
      expect(launch.command).not.toContain("/runtime/bun");
      // The per-file ceiling is the lane's storage budget, not a separate constant:
      // CacheStorage keeps one file per entry, so a lower ceiling would cap a single
      // cached asset and kill Chromium with SIGXFSZ partway through writing it.
      const laneBytes = resolveLaneStorageBytes({ profileDir: fixture.settings.profileDir });
      expect(launch.command.slice(0, 3)).toEqual([fixture.prlimit, `--fsize=${laneBytes}`, "--"]);
      expect(laneBytes).toBeGreaterThanOrEqual(MIN_LANE_STORAGE_BYTES);
      const writable = launch.command.flatMap((value, index, all) => (value === "--bind" ? [all[index + 1]] : []));
      expect(writable).toEqual([fixture.settings.profileDir, fixture.settings.artifactsRoot]);
      expect(launch.command.join(" ")).not.toContain(".env");
      expect(JSON.stringify(launch)).not.toContain("user:secret");
      expect(launch.command.some((value, index) => value === resolve(import.meta.dir, "../..") && launch.command[index + 1] === "/repo")).toBe(false);
      expect(launch.command).toContain("/repo/node_modules/.cache/beckett-browser/host.mjs");
      expect(launch.command).not.toContain("/repo/src/browser");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("the betterwright backend hands Chromium the lane's real storage budget", () => {
    const fixture = fixturePaths();
    const shimDir = join(fixture.dir, "cloak-storage-quota");
    mkdirSync(join(shimDir, "dist"), { recursive: true });
    writeFileSync(join(shimDir, "dist", "index.js"), "fixture");
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "auto",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        cloakShimDir: shimDir,
        repoRoot: resolve(import.meta.dir, "../.."),
        bwrapPath: "/usr/bin/bwrap",
        prlimitPath: fixture.prlimit,
        backend: "betterwright",
        parentEnv: { PATH: "/usr/bin:/bin" },
      });

      const setenv = new Map<string, string>();
      launch.command.forEach((value, index) => {
        if (value === "--setenv") setenv.set(launch.command[index + 1]!, launch.command[index + 2]!);
      });
      const laneBytes = resolveLaneStorageBytes({ profileDir: fixture.settings.profileDir });
      expect(setenv.get("BECKETT_BROWSER_STORAGE_QUOTA_MIB")).toBe(String(laneStorageQuotaMib(laneBytes)));
      // BetterWright must load the shim from the sandbox's own path, never the host's.
      expect(setenv.get("BETTERWRIGHT_CLOAKBROWSER_PATH"))
        .toBe("/repo/node_modules/.cache/beckett-browser/cloak-storage-quota");
      expect(launch.command).toContain("/repo/node_modules/.cache/beckett-browser/cloak-storage-quota/dist/index.js");

      // The shim is a read-only mount: the only writable binds stay the profile and
      // artifact roots, and nothing about network or capability isolation moves.
      const writable = launch.command.flatMap((value, index, all) => (value === "--bind" ? [all[index + 1]] : []));
      expect(writable).toEqual([fixture.settings.profileDir, fixture.settings.artifactsRoot]);
      const readOnly = launch.command.flatMap((value, index, all) => (value === "--ro-bind" ? [all[index + 1]] : []));
      expect(readOnly).toContain(join(shimDir, "dist", "index.js"));
      expect(launch.command).toContain("--unshare-all");
      expect(launch.command).toContain("--cap-drop");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("an installed Obscura engine is bound read-only and pointed at by an explicit root", () => {
    const fixture = fixturePaths();
    const obscuraRoot = join(fixture.dir, "obscura-root");
    mkdirSync(join(obscuraRoot, `linux-${process.arch}`), { recursive: true });
    writeFileSync(join(obscuraRoot, `linux-${process.arch}`, "obscura"), "fixture");
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "auto",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        obscuraRoot,
        repoRoot: resolve(import.meta.dir, "../.."),
        bwrapPath: "/usr/bin/bwrap",
        prlimitPath: fixture.prlimit,
        backend: "betterwright",
        parentEnv: { PATH: "/usr/bin:/bin" },
      });
      expect(hasTriple(launch.command, ["--setenv", "BETTERWRIGHT_OBSCURA_ROOT", obscuraRoot])).toBe(true);
      expect(hasTriple(launch.command, ["--ro-bind", obscuraRoot, obscuraRoot])).toBe(true);
      // The kill-switch pin is gone: an installed engine is used, not disabled.
      expect(launch.command).not.toContain("BETTERWRIGHT_OBSCURA_PATH");
      const writable = launch.command.flatMap((value, index, all) => (value === "--bind" ? [all[index + 1]] : []));
      expect(writable).not.toContain(obscuraRoot);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("a missing Obscura install sets no override, leaving betterwright's compatibility fallback", () => {
    const fixture = fixturePaths();
    const obscuraRoot = join(fixture.dir, "no-obscura-here");
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "auto",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        obscuraRoot,
        repoRoot: resolve(import.meta.dir, "../.."),
        bwrapPath: "/usr/bin/bwrap",
        prlimitPath: fixture.prlimit,
        backend: "betterwright",
        parentEnv: { PATH: "/usr/bin:/bin" },
      });
      // An explicit root betterwright cannot resolve would throw upstream, so we set none.
      expect(launch.command).not.toContain("BETTERWRIGHT_OBSCURA_ROOT");
      expect(launch.command).not.toContain("BETTERWRIGHT_OBSCURA_PATH");
      expect(launch.command).not.toContain(obscuraRoot);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("the playwright backend gets no CloakBrowser shim at all", () => {
    const fixture = fixturePaths();
    const shimDir = join(fixture.dir, "cloak-storage-quota");
    mkdirSync(join(shimDir, "dist"), { recursive: true });
    writeFileSync(join(shimDir, "dist", "index.js"), "fixture");
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "auto",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        cloakShimDir: shimDir,
        repoRoot: resolve(import.meta.dir, "../.."),
        bwrapPath: "/usr/bin/bwrap",
        prlimitPath: fixture.prlimit,
        parentEnv: { PATH: "/usr/bin:/bin" },
      });
      expect(launch.command.join(" ")).not.toContain("BETTERWRIGHT_CLOAKBROWSER_PATH");
      expect(launch.command.join(" ")).not.toContain("cloak-storage-quota");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("process-only mode points betterwright at the shim's real host path", () => {
    const fixture = fixturePaths();
    const shimDir = join(fixture.dir, "cloak-storage-quota");
    mkdirSync(join(shimDir, "dist"), { recursive: true });
    writeFileSync(join(shimDir, "dist", "index.js"), "fixture");
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "none",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        cloakShimDir: shimDir,
        repoRoot: resolve(import.meta.dir, "../.."),
        backend: "betterwright",
      });
      expect(launch.env.BETTERWRIGHT_CLOAKBROWSER_PATH).toBe(shimDir);
      expect(Number(launch.env.BECKETT_BROWSER_STORAGE_QUOTA_MIB)).toBeGreaterThan(0);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("Linux fails closed when bubblewrap is unavailable", () => {
    const fixture = fixturePaths();
    try {
      expect(() =>
        buildBrowserHostLaunch({
          settings: fixture.settings,
          platform: "linux",
          sandbox: "auto",
          execPath: process.execPath,
          nodePath: fixture.node,
          hostPath: fixture.host,
          chromiumExecutable: fixture.browser,
          repoRoot: resolve(import.meta.dir, "../.."),
          bwrapPath: "",
          parentEnv: { PATH: "" },
        }),
      ).toThrow("requires bubblewrap");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("process-only development mode keeps Chromium's Unix socket path short", () => {
    const fixture = fixturePaths();
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "linux",
        sandbox: "none",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        repoRoot: resolve(import.meta.dir, "../.."),
      });
      const runtimeTmp = launch.env.TMPDIR!;
      expect(runtimeTmp).toMatch(/^\/tmp\/beckett-browser-[a-f0-9]{12}$/);
      expect(runtimeTmp).not.toContain(fixture.settings.profileDir);
      expect(runtimeTmp.length).toBeLessThan(64);
      expect(launch.command).toEqual([realpathSync(fixture.node), realpathSync(fixture.host)]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("macOS uses sandbox-exec when supplied", () => {
    const fixture = fixturePaths();
    try {
      const launch = buildBrowserHostLaunch({
        settings: fixture.settings,
        platform: "darwin",
        sandbox: "macos",
        execPath: process.execPath,
        nodePath: fixture.node,
        hostPath: fixture.host,
        chromiumExecutable: fixture.browser,
        repoRoot: resolve(import.meta.dir, "../.."),
        sandboxExecPath: "/usr/bin/sandbox-exec",
      });
      expect(launch.isolation).toBe("sandbox-exec");
      expect(launch.command[0]).toBe("/usr/bin/sandbox-exec");
      expect(launch.command.join(" ")).toContain("(deny default)");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("browser evaluator sandbox policy", () => {
  test("Linux uses a fresh bounded bubblewrap without controller state mounts", () => {
    const fixture = fixturePaths();
    const repoRoot = resolve(import.meta.dir, "../..");
    try {
      const launch = buildBrowserEvaluatorLaunch(
        { evalTimeoutMs: 60_000 },
        {
          isolation: "bubblewrap",
          repoRoot,
          bwrapPath: "/usr/bin/bwrap",
          nodePath: fixture.node,
          prlimitPath: fixture.prlimit,
          parentEnv: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "https://user:secret@proxy.invalid" },
        },
      );

      expect(launch.isolation).toBe("bubblewrap");
      expect(launch.command[0]).toBe("/usr/bin/bwrap");
      expect(launch.command).toContain("--unshare-all");
      expect(launch.command).toContain("--share-net");
      expect(launch.command).toContain("--cap-drop");
      expect(launch.command).not.toContain("CAP_SYS_ADMIN");
      expect(launch.command).toContain("/runtime/prlimit");
      expect(launch.command).toContain("--as=17179869184");
      expect(launch.command).toContain("--max-old-space-size=256");
      expect(launch.command).toContain("--nproc=256");
      expect(launch.command).toContain("--fsize=33554432");
      expect(launch.command).toContain("--cpu=62");
      expect(launch.command).not.toContain("--bind");
      expect(launch.command.join(" ")).not.toContain(fixture.settings.profileDir);
      expect(launch.command.join(" ")).not.toContain(fixture.settings.artifactsRoot);
      expect(launch.command.some((value, index) => value === repoRoot && launch.command[index + 1] === "/repo")).toBe(false);
      expect(launch.command).toContain("/repo/src/browser/evaluator.cjs");
      expect(JSON.stringify(launch)).not.toContain("user:secret");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

test("isolated leases require the exact high-entropy control capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-capability-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    await expect(runtime.acquire({
      runId: "capability",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "capability", "artifacts"),
      controlToken: "short",
    })).rejects.toThrow("high-entropy");
    await runtime.acquire({
      runId: "capability",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "capability", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    await expect(runtime.evaluate("capability", "return 42", "wrong-token-that-is-long-enough-000000")).rejects.toThrow(
      "capability rejected",
    );
    expect((await runtime.evaluate("capability", "return 42", CONTROL_TOKEN)).value).toBe(42);
    await runtime.release("capability", false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("attachment validation refuses a PNG path outside the run artifacts directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-attachment-boundary-test-"));
  try {
    const artifactsDir = join(dir, "run", "artifacts");
    const outside = join(dir, "outside.png");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(() => assertTrustedArtifactPng(outside, artifactsDir)).toThrow("escaped the permitted roots");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured attachment roots accept media, reject escaping symlinks and mismatched bytes, and honor '/'", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-attachment-roots-test-"));
  try {
    const artifacts = join(dir, "artifacts");
    const extra = join(dir, "approved");
    const outside = join(dir, "outside");
    mkdirSync(artifacts, { recursive: true });
    mkdirSync(extra, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)]);
    const configuredRoots = browserHostSettings(validateConfig({
      paths: { beckett_dir: dir },
      quick: { browser_attach_roots: [extra] },
    })).attachmentRoots!;
    expect(configuredRoots).toContain(resolve(extra));
    const approved = join(extra, "post.png");
    writeFileSync(approved, png);
    expect(assertTrustedBrowserAttachment(approved, [artifacts, ...configuredRoots])).toBe(realpathSync(approved));

    const escaped = join(outside, "outside.png");
    writeFileSync(escaped, png);
    symlinkSync(escaped, join(extra, "escape.png"));
    expect(() => assertTrustedBrowserAttachment(join(extra, "escape.png"), [artifacts, extra])).toThrow("escaped the permitted roots");

    const mismatch = join(extra, "not-a-jpeg.jpg");
    writeFileSync(mismatch, png);
    expect(() => assertTrustedBrowserAttachment(mismatch, [artifacts, extra])).toThrow("do not match its extension");

    const broadRoots = browserHostSettings(validateConfig({
      paths: { beckett_dir: dir },
      quick: { browser_attach_roots: ["/"] },
    })).attachmentRoots!;
    expect(broadRoots).toContain("/");
    expect(assertTrustedBrowserAttachment(escaped, broadRoots)).toBe(realpathSync(escaped));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default images root authorizes a pre-existing upload, and nothing above or beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-images-root-test-"));
  try {
    // No [quick].browser_attach_roots at all: the documented default is the images directory,
    // and a file an earlier run generated there must be uploadable without widening anything.
    const settings = browserHostSettings(validateConfig({ paths: { beckett_dir: dir } }));
    const roots = settings.attachmentRoots!;
    const images = resolve(dir, "images");
    expect(roots).toEqual([images]);
    mkdirSync(images, { recursive: true });

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    const generated = join(images, "avatar.png");
    writeFileSync(generated, png);
    expect(assertTrustedBrowserAttachment(generated, roots)).toBe(realpathSync(generated));

    // A sibling of the images directory is outside every approved root.
    const beside = join(dir, "beside.png");
    writeFileSync(beside, png);
    expect(() => assertTrustedBrowserAttachment(beside, roots)).toThrow("escaped the permitted roots");

    // A symlink sitting inside the approved root cannot lend its location to its target:
    // containment is decided after realpath, never from the spelling the caller supplied.
    const escape = join(images, "escape.png");
    symlinkSync(beside, escape);
    expect(() => assertTrustedBrowserAttachment(escape, roots)).toThrow("escaped the permitted roots");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluator never receives a screenshot path and daemon delivers a trusted PNG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-nofollow-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    await runtime.acquire({
      runId: "nofollow",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "nofollow", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const evaluated = await runtime.evaluate("nofollow", `
      await page.setContent('<main>trusted screenshot</main>');
      return await screenshot('shot-link');
    `, CONTROL_TOKEN);
    expect(evaluated.value).toBe("[screenshot queued: shot-link]");
    const screenshots = evaluated.screenshots ?? [];
    expect(screenshots).toHaveLength(1);
    expect(screenshots[0]).not.toContain(join("nofollow", "artifacts"));
    // The display copy is deleted by MCP after vision delivery; the separately
    // reported source remains a validated same-run path for attachFile.
    expect(evaluated.attachments).toHaveLength(1);
    expect(evaluated.attachments![0]).toContain(join("nofollow", "artifacts"));
    expect(readFileSync(evaluated.attachments![0]!).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(readFileSync(screenshots[0]!).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  } finally {
    if (runtime.hasLease("nofollow")) await runtime.release("nofollow", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("persistent browser state survives lease host replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-persistence-test-"));
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("<!doctype html><title>state</title><main>state</main>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    await runtime.acquire({
      runId: "first",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "first", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    await runtime.evaluate("first", `
      await page.goto(${JSON.stringify(url)});
      await page.evaluate(() => {
        document.cookie = 'host_session=persisted; path=/; max-age=3600';
        localStorage.setItem('host-state', 'persisted');
      });
    `, CONTROL_TOKEN);
    await runtime.release("first", false);
    expect(runtime.stats().ready).toBe(false);

    await runtime.acquire({
      runId: "second",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "second", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const restored = await runtime.evaluate("second", `
      await page.goto(${JSON.stringify(url)});
      return await page.evaluate(() => document.cookie + '|' + localStorage.getItem('host-state'));
    `, CONTROL_TOKEN);
    expect(restored.value).toContain("host_session=persisted|persisted");
    await runtime.release("second", false);
  } finally {
    await runtime.stop();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("isolated stop interrupts a cold acquisition without leaving a host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-stop-host-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    const acquisition = runtime.acquire({
      runId: "stopping",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "stopping", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const stopping = runtime.stop();
    await expect(acquisition).rejects.toThrow("interrupted by shutdown");
    await stopping;
    expect(runtime.stats()).toMatchObject({ ready: false, activeRunId: null });
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
