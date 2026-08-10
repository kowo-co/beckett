import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { validateConfig } from "../config.ts";
import type { Logger } from "../types.ts";
import { createIsolatedBrowserRuntime } from "./isolated.ts";
import {
  browserHostSettings,
  buildPersistentChromiumCommand,
  createLocalBrowserRuntime as createInjectedLocalBrowserRuntime,
  safeArtifactPath,
  truncateBrowserOutput,
  type BrowserBudgetOverrides,
  type BrowserRuntime,
  type CreateLocalBrowserRuntimeDeps,
} from "./runtime.ts";

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();
const CONTROL_TOKEN = "test-control-token-0123456789abcdef0123456789abcdef";

function createLocalBrowserRuntime(options: CreateLocalBrowserRuntimeDeps): BrowserRuntime {
  const budgetOverrides: BrowserBudgetOverrides = {
    maxDownloadBytes: options.maxDownloadBytes,
    maxDownloadsPerLease: options.maxDownloadsPerLease,
    maxProfileBytes: options.maxProfileBytes,
    maxProfileGrowthBytes: options.maxProfileGrowthBytes,
  };
  const runtime = createIsolatedBrowserRuntime({
    settings: options.settings,
    logger: options.logger,
    sandbox: "none",
    hostBudgetOverrides: budgetOverrides,
  });
  return {
    acquire: runtime.acquire.bind(runtime),
    evaluate: (runId, code) => runtime.evaluate(runId, code, CONTROL_TOKEN),
    capture: runtime.capture.bind(runtime),
    checkpoint: runtime.checkpoint.bind(runtime),
    restore: runtime.restore.bind(runtime),
    release: runtime.release.bind(runtime),
    hasLease: runtime.hasLease.bind(runtime),
    stats: runtime.stats.bind(runtime),
    stop: runtime.stop.bind(runtime),
  };
}

/**
 * Chromium delivers Browser.downloadWillBegin/downloadProgress on its own schedule, so the guard
 * events an evaluation observes depend on how much of that traffic landed before the snippet
 * returned. Keep draining the lease log with short follow-up evaluations until the guard reports,
 * instead of asserting on whatever happened to arrive inside one fixed sleep.
 */
async function leaseEventsContaining(
  runtime: BrowserRuntime,
  runId: string,
  seen: string[],
  needle: string,
  timeoutMs = 15_000,
): Promise<string> {
  const collected = [...seen];
  const deadline = Date.now() + timeoutMs;
  while (!collected.join("\n").includes(needle) && Date.now() < deadline) {
    // A drain evaluation is only a probe: let a transient evaluator/CDP hiccup retry rather than
    // fail the test in place of the assertion below.
    const drained = await runtime.evaluate(runId, "await page.waitForTimeout(100);")
      .catch(() => ({ events: [] as string[] }));
    collected.push(...(drained.events ?? []));
  }
  return collected.join("\n");
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let slowDownloadBytes = 0;
let slowDownloadCanceled = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/login") {
        return new Response(`<!doctype html><title>Login fixture</title>
          <button onclick="document.cookie='beckett_session=warm; path=/'; localStorage.setItem('signedIn','yes'); this.textContent='Signed in'">Sign in</button>` , {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/check") {
        return new Response(`<!doctype html><title>State check</title><main id="result"></main>
          <script>result.textContent = document.cookie + '|' + localStorage.getItem('signedIn')</script>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/security") {
        return new Response(`<!doctype html><title>Account security</title>
          <input id="otp" name="one-time-code" value="DISTINCT-OTP-739184" style="color: red">
          <p id="instructions">Store these recovery codes somewhere safe.</p>
          <pre id="recovery" data-recovery-code>ABCD-EFGH-1234-IJKL</pre>
          <img id="qr" alt="recovery QR" style="border: 1px solid blue"
            src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
          <script>
            window.redactions = 0;
            new MutationObserver(() => {
              if (otp.style.getPropertyValue('color') === 'transparent' &&
                  qr.style.visibility === 'hidden' && recovery.textContent.includes('*')) {
                window.redactions++;
              }
            }).observe(document.documentElement, {
              attributes: true,
              characterData: true,
              subtree: true,
              attributeFilter: ['style'],
            });
          </script>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/neutral-secret") {
        return new Response(`<!doctype html><title>Account</title><main>Account details</main>
          <pre data-secret>ABCD-EFGH-1234-IJKL</pre>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/mutation-static") {
        return new Response("<!doctype html><title>Mutation fixture</title><main id=status>Ready</main>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/mutation-race") {
        return new Response(`<!doctype html><title>Mutation fixture</title><main id=status>Ready</main>
          <script>
            window.spaTicks = 0;
            const observer = new MutationObserver(() => {
              window.spaTicks++;
              status.textContent = Number(document.documentElement.dataset.phase) % 2 === 0
                ? 'Ready'
                : 'Access token DYNAMIC-SECRET-739184';
            });
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-phase'] });
            setInterval(() => {
              document.documentElement.dataset.phase = String(window.spaTicks + 1);
            }, 1);
          </script>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/download-page") {
        return new Response(`<!doctype html><title>Download</title><a href="/download-file">Download file</a>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/download-file") {
        return new Response("download payload", {
          headers: {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="fixture.txt"',
          },
        });
      }
      if (path === "/slow-oversized") {
        let canceled = false;
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            while (!canceled && slowDownloadBytes < 8 * 1024 * 1024) {
              controller.enqueue(new Uint8Array(64 * 1024));
              slowDownloadBytes += 64 * 1024;
              await Bun.sleep(20);
            }
            if (!canceled) controller.close();
          },
          cancel() {
            canceled = true;
            slowDownloadCanceled++;
          },
        });
        return new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="oversized.bin"',
          },
        });
      }
      if (/^\/concurrent-[123]$/.test(path)) {
        return new Response(new Uint8Array(40 * 1024), {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${path.slice(1)}.bin"`,
            "content-length": String(40 * 1024),
          },
        });
      }
      return new Response(`<!doctype html><title>${path}</title><h1>${path}</h1>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

describe("browser helpers", () => {
  test("artifact names stay below the run directory", () => {
    expect(safeArtifactPath("/tmp/run", "../proof image", ".png")).toBe("/tmp/run/proof-image.png");
    expect(truncateBrowserOutput("abcdef", 3)).toMatchObject({ truncated: true });
  });

  test("manual Chromium launch uses one loopback CDP transport and a dedicated profile", () => {
    const command = buildPersistentChromiumCommand({
      executable: "/browser/chromium",
      profileDir: "/state/profile",
      origin: "https://controller.beckett.invalid",
      headless: true,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    expect(command).toContain("--remote-debugging-port=0");
    expect(command).toContain("--remote-debugging-address=127.0.0.1");
    expect(command).toContain("--user-data-dir=/state/profile");
    expect(command).not.toContain("--remote-debugging-pipe");
  });
});

test("page metadata and the complete evaluator result stay inside the configured output budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-output-budget-test-"));
  const config = validateConfig({
    paths: { beckett_dir: dir },
    quick: { browser_profile_dir: "browser/profile", browser_max_output_chars: 4_096 },
  });
  const settings = browserHostSettings(config);
  const runtime = createLocalBrowserRuntime({ settings, logger: quietLog });
  try {
    await runtime.acquire({
      runId: "bounded",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "bounded", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const result = await runtime.evaluate("bounded", `
      await page.goto('data:text/html,' + 'x'.repeat(100_000));
      await page.evaluate(() => { document.title = 't'.repeat(100_000); });
      return 'ok';
    `);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(settings.maxOutputChars);
    expect(result.pages[0]!.url.length).toBeLessThanOrEqual(2_048);
    expect(result.pages[0]!.title.length).toBeLessThanOrEqual(512);
    expect(result.truncated).toBe(true);
    await runtime.release("bounded", false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("persistent cookies, AI snapshots, parallel pages, proof, and warm state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-test-"));
  const config = validateConfig({
    paths: { beckett_dir: dir },
    quick: {
      browser_profile_dir: "browser/profile",
      browser_launch_timeout_ms: 30_000,
      browser_eval_timeout_ms: 15_000,
    },
  });
  const artifacts1 = join(dir, "browser-agent", "run-one", "artifacts");
  const settings = browserHostSettings(config);
  const first = createLocalBrowserRuntime({ settings, logger: quietLog });
  try {
    await first.acquire({ runId: "run-one", channelId: "chan", artifactsDir: artifacts1, controlToken: CONTROL_TOKEN });
    const signedIn = await first.evaluate("run-one", `
      await page.goto(${JSON.stringify(`${baseUrl}/login`)});
      await page.getByRole('button', { name: 'Sign in' }).click();
      state.counter = 41;
      return { text: await page.getByRole('button').textContent(), snapshot: await observe() };
    `);
    expect(signedIn.value).toEqual(expect.objectContaining({ text: "Signed in" }));
    expect(JSON.stringify(signedIn.value)).toContain("[ref=");

    const parallel = await first.evaluate("run-one", `
      const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
      await Promise.all([a.goto(${JSON.stringify(`${baseUrl}/a`)}), b.goto(${JSON.stringify(`${baseUrl}/b`)})]);
      return { titles: await Promise.all([a.title(), b.title()]), counter: state.counter + 1 };
    `);
    expect(parallel.value).toEqual({ titles: ["/a", "/b"], counter: 42 });
    expect(parallel.pages.length).toBe(3);
    expect(parallel.pages.find((item) => item.active)?.url).toBe(`${baseUrl}/b`);
    expect((await first.evaluate("run-one", "return page.url()")).value).toBe(`${baseUrl}/b`);
    const switched = await first.evaluate("run-one", `
      const a = pages.find((candidate) => candidate.url().endsWith('/a'));
      const c = await context.newPage();
      await c.goto(${JSON.stringify(`${baseUrl}/c`)});
      const afterOpen = { pageUrl: page.url(), pageCount: pages.length };
      usePage(a);
      return { ...afterOpen, selectedUrl: page.url() };
    `);
    expect(switched.value).toEqual({ pageUrl: `${baseUrl}/c`, pageCount: 4, selectedUrl: `${baseUrl}/a` });
    expect((await first.evaluate("run-one", "return page.url()")).value).toBe(`${baseUrl}/a`);

    await first.evaluate("run-one", `
      await page.goto(${JSON.stringify(`${baseUrl}/download-page`)});
      const download = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download file' }).click();
      await download;
    `);

    await first.evaluate("run-one", `
      usePage(0);
      try { await page.context().close(); } catch (error) { return error.message; }
    `).then((result) => expect(result.value).toContain("host-owned"));
    const proofFiles = await first.release("run-one", true);
    expect(proofFiles).toHaveLength(1);
    expect(existsSync(proofFiles[0]!)).toBe(true);
    expect(readdirSync(join(settings.profileDir, "downloads"))).toEqual([]);
    await first.stop();
    const sessionSnapshot = join(settings.profileDir, ".beckett-session-cookies.json");
    expect(existsSync(sessionSnapshot)).toBe(true);
    expect(statSync(sessionSnapshot).mode & 0o777).toBe(0o600);
    expect(statSync(sessionSnapshot).size).toBeLessThanOrEqual(1024 * 1024);
    expect(JSON.parse(readFileSync(sessionSnapshot, "utf8")).cookies).toEqual([
      expect.objectContaining({ name: "beckett_session", value: "warm", expires: -1 }),
    ]);

    const second = createLocalBrowserRuntime({ settings, logger: quietLog });
    await second.acquire({
      runId: "run-two",
      channelId: "chan",
      artifactsDir: join(dir, "browser-agent", "run-two", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const restored = await second.evaluate("run-two", `
      await page.goto(${JSON.stringify(`${baseUrl}/check`)});
      return await page.locator('#result').textContent();
    `);
    expect(restored.value).toContain("beckett_session=warm|yes");
    expect(second.stats().averageEvalMs).toBeLessThan(5_000);
    await second.release("run-two", false);
    await second.stop();
  } finally {
    await first.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("CDP cancels slow and concurrent downloads before they exceed the lease aggregate budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-download-budget-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createLocalBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    maxDownloadBytes: 64 * 1024,
  });
  try {
    slowDownloadBytes = 0;
    slowDownloadCanceled = 0;
    const slowArtifacts = join(dir, "browser-agent", "slow-download", "artifacts");
    await runtime.acquire({
      runId: "slow-download",
      channelId: null,
      artifactsDir: slowArtifacts,
      controlToken: CONTROL_TOKEN,
    });
    const slowState = await runtime.evaluate("slow-download", `
      const started = page.waitForEvent('download');
      await page.goto(${JSON.stringify(`${baseUrl}/slow-oversized`)}).catch(() => undefined);
      await started;
      await page.waitForTimeout(500);
    `);
    expect(await leaseEventsContaining(runtime, "slow-download", slowState.events ?? [], "aggregate budget exceeded"))
      .toContain("aggregate budget exceeded");
    await runtime.release("slow-download", false);
    expect(slowDownloadCanceled).toBeGreaterThan(0);
    expect(slowDownloadBytes).toBeLessThan(8 * 1024 * 1024);
    expect(readdirSync(slowArtifacts)).toEqual([]);

    const concurrentArtifacts = join(dir, "browser-agent", "concurrent-downloads", "artifacts");
    await runtime.acquire({
      runId: "concurrent-downloads",
      channelId: null,
      artifactsDir: concurrentArtifacts,
      controlToken: CONTROL_TOKEN,
    });
    const concurrentState = await runtime.evaluate("concurrent-downloads", `
      const tabs = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
      await Promise.all(tabs.map(async (tab, index) => {
        const started = tab.waitForEvent('download');
        await tab.goto(${JSON.stringify(baseUrl)} + '/concurrent-' + (index + 1)).catch(() => undefined);
        await started;
      }));
      await page.waitForTimeout(500);
    `);
    expect(await leaseEventsContaining(runtime, "concurrent-downloads", concurrentState.events ?? [], "aggregate budget exceeded"))
      .toContain("aggregate budget exceeded");
    await runtime.release("concurrent-downloads", false);
    const artifactBytes = readdirSync(concurrentArtifacts)
      .reduce((sum, name) => sum + statSync(join(concurrentArtifacts, name)).size, 0);
    expect(artifactBytes).toBeLessThanOrEqual(64 * 1024);
    expect(readdirSync(join(browserHostSettings(config).profileDir, "downloads"))).toEqual([]);
  } finally {
    if (runtime.hasLease("slow-download")) await runtime.release("slow-download", false).catch(() => undefined);
    if (runtime.hasLease("concurrent-downloads")) await runtime.release("concurrent-downloads", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("root CDP counts raw-target downloads once, caps their files, and restores the trusted path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-raw-download-test-"));
  const redirectDir = join(dir, "redirected-downloads");
  mkdirSync(redirectDir, { recursive: true });
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const settings = browserHostSettings(config);
  const runtime = createLocalBrowserRuntime({
    settings,
    logger: quietLog,
    maxDownloadsPerLease: 2,
  });
  try {
    await runtime.acquire({
      runId: "raw-downloads",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "raw-downloads", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const attempted = await runtime.evaluate("raw-downloads", `
      const internalBrowser = [...page.context()._connection._objects.values()]
        .find((candidate) => typeof candidate.newBrowserCDPSession === 'function');
      if (!internalBrowser) throw new Error('internal browser object not found');
      const session = await internalBrowser.newBrowserCDPSession();
      try {
        await session.send('Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          downloadPath: ${JSON.stringify(redirectDir)},
          eventsEnabled: true,
        });
        await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
          session.send('Target.createTarget', {
            url: ${JSON.stringify(`${baseUrl}/download-file`)} + '?raw=' + index,
          })));
        await page.waitForTimeout(2_000);
      } finally {
        await session.detach().catch(() => undefined);
      }
    `);
    expect(await leaseEventsContaining(runtime, "raw-downloads", attempted.events ?? [], "download count exceeded 2"))
      .toContain("download count exceeded 2");
    // Tiny transfers can complete before Browser.cancelDownload lands; the guard then deletes
    // the landed file on the completion event, ~100ms deferred. Wait for that cleanup rather
    // than racing it — the invariant is that excess files do not PERSIST, not that the cancel
    // RPC always outruns a 16-byte download.
    const cleanupDeadline = Date.now() + 5_000;
    while (readdirSync(redirectDir).length > 2 && Date.now() < cleanupDeadline) {
      await Bun.sleep(100);
    }
    expect(readdirSync(redirectDir).length).toBeLessThanOrEqual(2);
    await runtime.release("raw-downloads", false);

    rmSync(redirectDir, { recursive: true, force: true });
    mkdirSync(redirectDir, { recursive: true });
    const trustedArtifacts = join(dir, "browser-agent", "trusted-download", "artifacts");
    await runtime.acquire({
      runId: "trusted-download",
      channelId: null,
      artifactsDir: trustedArtifacts,
      controlToken: CONTROL_TOKEN,
    });
    await runtime.evaluate("trusted-download", `
      await page.goto(${JSON.stringify(`${baseUrl}/download-page`)});
      const download = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download file' }).click();
      await download;
    `);
    await runtime.release("trusted-download", false);
    expect(readdirSync(trustedArtifacts)).toEqual([
      expect.stringMatching(/^download-fixture-\d+-[a-z0-9]+\.txt$/),
    ]);
    expect(readdirSync(redirectDir)).toEqual([]);
    expect(readdirSync(join(settings.profileDir, "downloads"))).toEqual([]);
  } finally {
    if (runtime.hasLease("raw-downloads")) await runtime.release("raw-downloads", false).catch(() => undefined);
    if (runtime.hasLease("trusted-download")) await runtime.release("trusted-download", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("an oversized persistent profile is rejected before Chromium starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-total-profile-budget-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const settings = browserHostSettings(config);
  mkdirSync(settings.profileDir, { recursive: true });
  writeFileSync(join(settings.profileDir, "oversized.bin"), randomBytes(768 * 1024));
  const runtime = createLocalBrowserRuntime({ settings, logger: quietLog, maxProfileBytes: 128 * 1024 });
  try {
    await expect(runtime.acquire({
      runId: "oversized-profile",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "oversized-profile", "artifacts"),
      controlToken: CONTROL_TOKEN,
    })).rejects.toThrow("cache prune reclaimed 0 bytes, still over");
    expect(runtime.stats().launches).toBe(0);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile growth watchdog stops web-storage abuse while preserving persistent cookies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-profile-budget-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  // The growth budget needs headroom above Chromium's OWN profile writes: the baseline is
  // measured right after launch, and on a slow runner Chromium's first-run writes (shader
  // caches, LevelDBs) land after it. A 512 KiB budget let those writes trip the watchdog
  // before the eval ran — Chromium died and the evaluator's CDP connect was refused (the
  // recurring CI flake). 16 MiB is far above first-run noise, far below the 24 MiB hog.
  const runtime = createLocalBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    maxProfileGrowthBytes: 16 * 1024 * 1024,
  });
  try {
    await runtime.acquire({
      runId: "storage-hog",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "storage-hog", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    await expect(runtime.evaluate("storage-hog", `
      await page.goto(${JSON.stringify(`${baseUrl}/storage`)})
      await page.evaluate(async () => {
        document.cookie = 'profile_budget_cookie=kept; path=/; max-age=3600';
        const bytes = new Uint8Array(24 * 1024 * 1024);
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          crypto.getRandomValues(bytes.subarray(offset, Math.min(bytes.length, offset + 65536)));
        }
        // IndexedDB is real, persistent profile state — not a disposable cache the budget
        // now discounts — so growth here is exactly what the watchdog must still bound.
        await new Promise((resolve, reject) => {
          const open = indexedDB.open('budget-hog', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('blobs');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('blobs', 'readwrite');
            tx.objectStore('blobs').put(bytes, 'hog');
            tx.oncomplete = () => { db.close(); resolve(undefined); };
            tx.onerror = () => reject(tx.error);
          };
        });
      });
      await page.waitForTimeout(300);
    `)).rejects.toThrow(/profile storage budget exceeded/);
    await runtime.release("storage-hog", false);

    await runtime.acquire({
      runId: "after-storage-hog",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "after-storage-hog", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const cookie = await runtime.evaluate("after-storage-hog", `
      await page.goto(${JSON.stringify(`${baseUrl}/storage-check`)});
      return await page.evaluate(() => document.cookie);
    `);
    expect(cookie.value).toContain("profile_budget_cookie=kept");
    await runtime.release("after-storage-hog", false);
  } finally {
    if (runtime.hasLease("storage-hog")) await runtime.release("storage-hog", false).catch(() => undefined);
    if (runtime.hasLease("after-storage-hog")) await runtime.release("after-storage-hog", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a budget breach outranks the evaluator's transport error when the watchdog kills Chromium mid-eval", async () => {
  // The race behind the recurring CI flake: the watchdog detects a breach, sets the budget
  // error, and closes Chromium in the window between prepareEvaluation's health checks and
  // the evaluator's CDP connect — so the evaluator dies with a bare transport error (connect
  // ECONNREFUSED) and no recoverable state, and applyEvaluation used to throw that fallout
  // verbatim. Reproduced at the deterministic seam: breach the budget on disk, then hand
  // applyEvaluation exactly what the orphaned evaluator reports. The surfaced error must be
  // the budget breach, never the transport fallout. No real Chromium: the failure path must
  // throw before ever touching the context again, so a stub context is all acquire needs.
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-budget-attribution-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const settings = browserHostSettings(config);
  const fakePage = {
    setViewportSize: async () => {},
    on: () => {},
    isClosed: () => false,
    url: () => "about:blank",
    goto: async () => null,
  };
  const fakeContext = {
    pages: () => [fakePage],
    newPage: async () => fakePage,
    on: () => {},
    cookies: async () => [],
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    close: async () => {},
  } as unknown as BrowserContext;
  const runtime = createInjectedLocalBrowserRuntime({
    settings,
    logger: quietLog,
    maxProfileGrowthBytes: 1024 * 1024,
    launchPersistentContext: (async () => fakeContext) as unknown as typeof chromium.launchPersistentContext,
  });
  try {
    await runtime.acquire({
      runId: "budget-attribution",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "budget-attribution", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    writeFileSync(join(settings.profileDir, "mid-eval-growth.bin"), randomBytes(4 * 1024 * 1024));
    await expect(runtime.applyEvaluation("budget-attribution", {
      ok: false,
      error: "browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:1",
    })).rejects.toThrow(/profile storage budget exceeded/);
  } finally {
    if (runtime.hasLease("budget-attribution")) await runtime.release("budget-attribution", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("disposable cache growth is not charged to the per-lease budget, but real profile growth still trips it", async () => {
  // The regression this guards: an x.com session grew Chromium's disposable caches by ~100MB
  // in a single lease and tripped the growth cap, permanently failing every later call. The
  // budget must discount that regenerable churn while still bounding real profile writes.
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-cache-exclusion-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const settings = browserHostSettings(config);
  const fakePage = {
    setViewportSize: async () => {},
    on: () => {},
    isClosed: () => false,
    url: () => "about:blank",
    goto: async () => null,
  };
  const fakeContext = {
    pages: () => [fakePage],
    newPage: async () => fakePage,
    on: () => {},
    cookies: async () => [],
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    close: async () => {},
  } as unknown as BrowserContext;
  const runtime = createInjectedLocalBrowserRuntime({
    settings,
    logger: quietLog,
    maxProfileGrowthBytes: 1024 * 1024,
    launchPersistentContext: (async () => fakeContext) as unknown as typeof chromium.launchPersistentContext,
  });
  try {
    await runtime.acquire({
      runId: "cache-exclusion",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "cache-exclusion", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const defaultDir = join(settings.profileDir, "Default");
    // 16 MiB of disposable cache — far past the 1 MiB growth allowance. Chromium regenerates
    // these trees, so they are not real profile state and must not trip the budget.
    mkdirSync(join(defaultDir, "Cache"), { recursive: true });
    writeFileSync(join(defaultDir, "Cache", "media.bin"), randomBytes(8 * 1024 * 1024));
    mkdirSync(join(defaultDir, "Service Worker", "CacheStorage"), { recursive: true });
    writeFileSync(join(defaultDir, "Service Worker", "CacheStorage", "sw.bin"), randomBytes(8 * 1024 * 1024));
    // checkpoint() runs the budget scan then asserts health; with only cache growth it holds.
    await expect(runtime.checkpoint("cache-exclusion")).resolves.toBeDefined();

    // A runaway write into real (non-cache) profile state is still bounded and still errors.
    // Poll so the assertion never races an in-flight pre-write watchdog scan.
    writeFileSync(join(settings.profileDir, "runaway-state.bin"), randomBytes(4 * 1024 * 1024));
    let tripped = false;
    for (let attempt = 0; attempt < 50 && !tripped; attempt++) {
      try {
        await runtime.checkpoint("cache-exclusion");
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch (error) {
        tripped = String(error).includes("profile storage budget exceeded");
      }
    }
    expect(tripped).toBe(true);
  } finally {
    if (runtime.hasLease("cache-exclusion")) await runtime.release("cache-exclusion", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("the controller closes excess tabs and force-disposes raw browser contexts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-tab-ceiling-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createLocalBrowserRuntime({ settings: browserHostSettings(config), logger: quietLog });
  try {
    await runtime.acquire({
      runId: "tab-ceiling",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "tab-ceiling", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const opened = await runtime.evaluate("tab-ceiling", `
      await Promise.allSettled(Array.from({ length: 40 }, () => page.context().newPage()));
      return context.pages().length;
    `);
    expect(opened.pages.length).toBeLessThanOrEqual(32);
    expect((opened.events ?? []).join("\n")).toContain("32-page ceiling");
    expect((await runtime.evaluate("tab-ceiling", "return context.pages().length")).value).toBeLessThanOrEqual(32);
    const rawEscape = await runtime.evaluate("tab-ceiling", `
      let cdpError = '';
      try { await page.context().newCDPSession(page); } catch (error) { cdpError = error.message; }
      return {
        globalBrowser: context.browser(),
        pageBrowser: page.context().browser(),
        internalBrowser: page.context()._browser,
        cdpError,
      };
    `);
    expect(rawEscape.value).toEqual({
      globalBrowser: null,
      pageBrowser: null,
      internalBrowser: null,
      cdpError: "raw CDP sessions are controller-owned",
    });
    const rawContextEscape = await runtime.evaluate("tab-ceiling", `
      const internalBrowser = [...page.context()._connection._objects.values()]
        .find((candidate) => typeof candidate.newBrowserCDPSession === 'function');
      if (!internalBrowser) throw new Error('internal browser object not found');
      const session = await internalBrowser.newBrowserCDPSession();
      try {
        const { browserContextId } = await session.send('Target.createBrowserContext');
        await page.waitForTimeout(350);
        const current = await session.send('Target.getBrowserContexts');
        return {
          created: typeof browserContextId === 'string' && browserContextId.length > 0,
          stillPresent: current.browserContextIds.includes(browserContextId),
        };
      } finally {
        await session.detach().catch(() => undefined);
      }
    `);
    expect(rawContextEscape.value).toEqual({ created: true, stillPresent: false });
    expect((rawContextEscape.events ?? []).join("\n")).toContain("[browser context blocked]");
    const rawTargetEscape = await runtime.evaluate("tab-ceiling", `
      const internalBrowser = [...page.context()._connection._objects.values()]
        .find((candidate) => typeof candidate.newBrowserCDPSession === 'function');
      if (!internalBrowser) throw new Error('internal browser object not found');
      const session = await internalBrowser.newBrowserCDPSession();
      try {
        const created = await Promise.all(Array.from({ length: 12 }, () =>
          session.send('Target.createTarget', { url: 'about:blank' })));
        const createdIds = created.map((item) => item.targetId);
        await page.waitForTimeout(350);
        const contexts = await session.send('Target.getBrowserContexts');
        const targets = await session.send('Target.getTargets');
        const defaultPages = targets.targetInfos.filter((target) =>
          target.type === 'page' && target.browserContextId === contexts.defaultBrowserContextId);
        return {
          defaultPages: defaultPages.length,
          rawSurvivors: defaultPages.filter((target) => createdIds.includes(target.targetId)).length,
        };
      } finally {
        await session.detach().catch(() => undefined);
      }
    `);
    expect(rawTargetEscape.value).toEqual({ defaultPages: 32, rawSurvivors: 0 });
    expect((rawTargetEscape.events ?? []).join("\n")).toContain("32-page ceiling");
    await runtime.release("tab-ceiling", false);
  } finally {
    if (runtime.hasLease("tab-ceiling")) await runtime.release("tab-ceiling", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  // 60s like the other Chromium-heavy tests: six sequential evals (each bracketed by profile
  // scans) run ~10s on a healthy runner but cleared 30s on a loaded one.
}, 60_000);

test("a timed-out evaluator marks the outcome uncertain and leaves the lease inspectable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-timeout-test-"));
  const config = validateConfig({
    paths: { beckett_dir: dir },
    quick: {
      browser_profile_dir: "browser/profile",
      // The eval budget bounds EVERY snippet on this lease, including the trivial recovery
      // `page.title()` below — one CDP round-trip. Under CPU load that round-trip was measured at
      // ~64ms, so the former 30ms budget tripped the in-process timeout on the recovery itself and
      // reported it as a spurious timeout (the load-only flake this ticket chases). 250ms clears a
      // loaded round-trip with wide margin while staying well under the timed-out snippet's own
      // ~1s+ runtime below, so the intended timeout still fires deterministically.
      browser_eval_timeout_ms: 250,
    },
  });
  const runtime = createLocalBrowserRuntime({ settings: browserHostSettings(config), logger: quietLog });
  try {
    await runtime.acquire({
      runId: "slow",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "slow", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    await expect(runtime.evaluate("slow", `
      await page.setContent('<title>before-timeout</title>');
      // Fire the title change AFTER the 250ms eval budget so it lands once the evaluator has given
      // up — that is the "browser-side work may have continued" the recovery must observe.
      await page.evaluate(() => setTimeout(() => { document.title = 'after-timeout'; }, 400));
      // Well past the eval budget so the snippet is unambiguously over-budget under any load; the
      // in-process timeout still fires at ~250ms, so this does not lengthen the test.
      await page.waitForTimeout(2_000);
    `)).rejects.toThrow("outcome is uncertain");
    expect(runtime.hasLease("slow")).toBe(true);
    await Bun.sleep(450);
    expect((await runtime.evaluate("slow", "return await page.title()")).value).toBe("after-timeout");
    await runtime.release("slow", false);

    await Bun.sleep(300);
    await runtime.acquire({
      runId: "next",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "next", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const next = await runtime.evaluate("next", "return page.url()");
    expect(next.value).toBe("about:blank");
    await runtime.release("next", false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("an ordinary Playwright error preserves the selected tab and serializable state for recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-error-state-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createLocalBrowserRuntime({ settings: browserHostSettings(config), logger: quietLog });
  try {
    await runtime.acquire({
      runId: "recoverable",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "recoverable", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    await runtime.evaluate("recoverable", `await page.goto(${JSON.stringify(`${baseUrl}/old`)})`);
    await expect(runtime.evaluate("recoverable", `
      state.progress = 7;
      const next = await context.newPage();
      await next.goto(${JSON.stringify(`${baseUrl}/new`)})
      usePage(next);
      throw new Error('fixture locator failed');
    `)).rejects.toThrow("fixture locator failed");
    const recovered = await runtime.evaluate("recoverable", `
      return { url: page.url(), progress: state.progress, pageCount: pages.length };
    `);
    expect(recovered.value).toEqual({ url: `${baseUrl}/new`, progress: 7, pageCount: 2 });
    await runtime.release("recoverable", false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("sensitive screenshots use fail-closed capture styling without mutating the page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-redaction-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createLocalBrowserRuntime({ settings: browserHostSettings(config), logger: quietLog });
  try {
    await runtime.acquire({
      runId: "redact",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "redact", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    await runtime.evaluate("redact", `
      await page.goto(${JSON.stringify(`${baseUrl}/security`)});
      await page.locator('#otp').fill('UNSAVED-OTP-739184');
    `);
    const screenshot = await runtime.capture("redact", "question");
    expect(existsSync(screenshot)).toBe(true);
    const restored = await runtime.evaluate("redact", `
      return await page.evaluate(() => ({
        value: document.querySelector('#otp')?.value,
        otpStyle: document.querySelector('#otp')?.getAttribute('style'),
        qrStyle: document.querySelector('#qr')?.getAttribute('style'),
        recovery: document.querySelector('#recovery')?.textContent,
        instructions: document.querySelector('#instructions')?.textContent,
        redactions: window.redactions,
      }));
    `);
    expect(restored.value).toEqual({
      value: "UNSAVED-OTP-739184",
      otpStyle: "color: red",
      qrStyle: "border: 1px solid blue",
      recovery: "ABCD-EFGH-1234-IJKL",
      instructions: "Store these recovery codes somewhere safe.",
      redactions: 0,
    });
    await runtime.evaluate("redact", `await page.goto(${JSON.stringify(`${baseUrl}/neutral-secret`)})`);
    const neutralSecret = await runtime.capture("redact", "neutral-secret");
    expect(readFileSync(neutralSecret)).toEqual(readFileSync(screenshot));

    await runtime.evaluate("redact", `await page.goto(${JSON.stringify(`${baseUrl}/mutation-static`)})`);
    const staticSafe = await runtime.capture("redact", "mutation-static");
    const safePixels = readFileSync(staticSafe);
    const placeholderPixels = readFileSync(screenshot);
    await runtime.evaluate("redact", `await page.goto(${JSON.stringify(`${baseUrl}/mutation-race`)})`);
    for (let index = 0; index < 6; index++) {
      const dynamic = await runtime.capture("redact", `mutation-race-${index}`);
      const pixels = readFileSync(dynamic);
      expect(pixels.equals(safePixels) || pixels.equals(placeholderPixels)).toBe(true);
    }
    const resumed = await runtime.evaluate("redact", `
      const before = await page.evaluate(() => window.spaTicks);
      await page.waitForTimeout(20);
      return await page.evaluate((before) => ({
        before,
        after: window.spaTicks,
        redactionKeys: Object.getOwnPropertyNames(window).filter((key) => key.startsWith('__beckett_redaction_')),
      }), before);
    `);
    expect((resumed.value as { after: number; before: number }).after).toBeGreaterThan(
      (resumed.value as { after: number; before: number }).before,
    );
    expect((resumed.value as { redactionKeys: string[] }).redactionKeys).toEqual([]);
    await runtime.release("redact", false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("concurrent cold acquisitions have exactly one owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-lease-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  const runtime = createLocalBrowserRuntime({ settings: browserHostSettings(config), logger: quietLog });
  try {
    const settled = await Promise.allSettled([
      runtime.acquire({ runId: "one", channelId: null, artifactsDir: join(dir, "browser-agent", "one", "artifacts"), controlToken: CONTROL_TOKEN }),
      runtime.acquire({ runId: "two", channelId: null, artifactsDir: join(dir, "browser-agent", "two", "artifacts"), controlToken: CONTROL_TOKEN }),
    ]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    const owner = runtime.hasLease("one") ? "one" : "two";
    await runtime.release(owner, false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("stop waits for and closes an in-flight Chromium launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-stop-launch-test-"));
  const config = validateConfig({ paths: { beckett_dir: dir }, quick: { browser_profile_dir: "browser/profile" } });
  let finishLaunch: ((context: BrowserContext) => void) | undefined;
  const launching = new Promise<BrowserContext>((resolveLaunch) => {
    finishLaunch = resolveLaunch;
  });
  let closes = 0;
  const fakeContext = {
    close: async () => {
      closes++;
    },
  } as unknown as BrowserContext;
  let launchStarted: (() => void) | undefined;
  const launchInFlight = new Promise<void>((resolveStarted) => {
    launchStarted = resolveStarted;
  });
  const runtime = createInjectedLocalBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    launchPersistentContext: (() => {
      launchStarted!();
      return launching;
    }) as typeof chromium.launchPersistentContext,
  });
  try {
    const acquisition = runtime.acquire({
      runId: "starting",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "starting", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    // acquire does async profile bookkeeping before it launches Chromium; a bare tick yield can
    // land stop() before that finishes, which is the ordinary "runtime is stopped" rejection.
    // This test is about the launch-in-flight path, so wait until the launch is actually running.
    await launchInFlight;
    const stopping = runtime.stop();
    finishLaunch!(fakeContext);
    await stopping;
    await expect(acquisition).rejects.toThrow("stopped while Chromium was starting");
    expect(closes).toBe(1);
    expect(runtime.stats().ready).toBe(false);
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disposable evaluator contains vm escape and async infinite loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-isolation-test-"));
  const config = validateConfig({
    paths: { beckett_dir: dir },
    quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 100 },
  });
  const runtime = createIsolatedBrowserRuntime({
    settings: browserHostSettings(config),
    logger: quietLog,
    sandbox: "none",
  });
  try {
    await runtime.acquire({
      runId: "isolated",
      channelId: null,
      artifactsDir: join(dir, "browser-agent", "isolated", "artifacts"),
      controlToken: CONTROL_TOKEN,
    });
    const escaped = await runtime.evaluate(
      "isolated",
      `return page.constructor.constructor("return process.pid")()`,
      CONTROL_TOKEN,
    );
    expect(escaped.value).not.toBe(process.pid);

    await expect(
      runtime.evaluate("isolated", `page.constructor.constructor("return process.exit(19)")()`, CONTROL_TOKEN),
    ).rejects.toThrow("invalid output");
    const recovered = await runtime.evaluate("isolated", "return 42", CONTROL_TOKEN);
    expect(recovered.value).toBe(42);

    const startedAt = Date.now();
    await expect(runtime.evaluate("isolated", "await 0; while (true) {}", CONTROL_TOKEN)).rejects.toThrow("timed out");
    // The `.rejects.toThrow("timed out")` above is the real invariant: an event-loop-blocking
    // snippet is contained by a hard process kill (no in-process timer can fire once the loop
    // never yields) and attributed as a timeout, deterministically, under any load.
    // This bound only guards PROMPTNESS. It must cover the disposable evaluator's cold start — a
    // fresh sandboxed Node plus a Playwright connectOverCDP, measured at ~2.5s under CPU load and
    // spikier under full-suite load — PLUS the snippet-kill budget (evalTimeoutMs 100ms + the
    // runner's 2000ms slack, measured from the STARTED marker). The former 4000ms assumed a
    // near-instant cold start (~0.5s idle) and so flaked once startup alone approached it. 8000ms
    // clears a loaded cold start plus the kill with margin, and still proves the loop is contained
    // rather than hanging until the 60s test timeout.
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(runtime.hasLease("isolated")).toBe(true);
  } finally {
    if (runtime.hasLease("isolated")) await runtime.release("isolated", false).catch(() => undefined);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
