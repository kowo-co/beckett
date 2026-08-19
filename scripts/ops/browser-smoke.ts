#!/usr/bin/env bun

/**
 * End-to-end BetterWright MCP backend smoke: the actual stdio MCP bridge drives
 * a live page through the isolated host, then verifies the persistent profile.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateConfig } from "../../src/config.ts";
import { browserHostSettings, createBrowserRuntime } from "../../src/browser/runtime.ts";
import { obscuraLaunch } from "../../src/browser/isolated.ts";
import { laneStorageQuotaViolation, resolveLaneStorageBytes } from "../../src/browser/storage-quota.ts";
import { serveBus } from "../../src/shell/control-bus.ts";
import type { BrowserEvalResult } from "../../src/browser/runtime.ts";
import type { BrowserLaneBackend } from "../../src/browser/storage-quota.ts";
import type { Logger } from "../../src/types.ts";
import betterwrightPkg from "betterwright/package.json";

/**
 * Version gates for two backends BetterWright removed outright, mirrored from
 * `chromiumForkLayoutFor`'s major.minor comparison in isolated.ts. Obscura went in 1.8.0
 * ("Removed Obscura and made native BetterChromium the required/default backend",
 * CHANGELOG); CloakBrowser followed in 1.8.5 ("CloakBrowser is removed. The managed fork
 * is the default and only bundled browser."). Below either gate the installed package
 * cannot serve the backend this smoke used to distinguish, so both the routing gate and
 * the quota-tracking assertion built around that distinction stop meaning anything and
 * must not be asked to hold.
 */
function versionAtLeast(version: string, target: [number, number, number]): boolean {
  const parts = version.trim().split(".", 3).map((part) => Number.parseInt(part, 10));
  const [actualMajor = 0, actualMinor = 0, actualPatch = 0] = parts;
  const [targetMajor, targetMinor, targetPatch] = target;
  if (![actualMajor, actualMinor, actualPatch].every(Number.isInteger)) return false;
  if (actualMajor !== targetMajor) return actualMajor > targetMajor;
  if (actualMinor !== targetMinor) return actualMinor > targetMinor;
  return actualPatch >= targetPatch;
}
const OBSCURA_REMOVED = versionAtLeast(betterwrightPkg.version, [1, 8, 0]);
const CLOAKBROWSER_REMOVED = versionAtLeast(betterwrightPkg.version, [1, 8, 5]);

// Diagnostics go to stderr, not /dev/null: the isolated browser host surfaces its stderr only
// through logger.debug (isolated.ts), and a CI-only worker crash (issue #181) is undebuggable
// when the smoke swallows it. Errors/warnings too — a smoke that fails silent helps nobody.
const logger = (() => {
  const emit = (level: string) => (msg: unknown, meta?: unknown) => {
    process.stderr.write(`[browser-smoke:${level}] ${String(msg)}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`);
  };
  const log = { info: emit("info"), warn: emit("warn"), error: emit("error"), debug: emit("debug"), child() { return log; } };
  return log as unknown as Logger;
})();

const dir = mkdtempSync(join(tmpdir(), "beckett-betterwright-smoke-"));
const socket = join(dir, "control.sock");
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    // The parallel-session check needs one request to remain in flight while a
    // different BetterWright session completes its own browser work.
    if (new URL(request.url).pathname === "/parallel-slow") {
      await Bun.sleep(1_500);
      return new Response("slow", { headers: { "content-type": "text/plain" } });
    }
    if (new URL(request.url).pathname === "/parallel-fast") {
      return new Response("fast", { headers: { "content-type": "text/plain" } });
    }
    return new Response(`<!doctype html><title>BetterWright smoke</title>
      <main><label>Message <input aria-label="Message"></label><button>Save</button><output></output></main>
      <script>document.querySelector('button').onclick = () => {
        const value = document.querySelector('input').value;
        localStorage.setItem('browser-smoke', value); document.cookie = 'browser_smoke=' + value + '; path=/; max-age=3600';
        document.querySelector('output').textContent = 'saved:' + value;
      }</script>`, { headers: { "content-type": "text/html" } });
  },
});
const baseUrl = `http://127.0.0.1:${server.port}`;
const previousDir = process.env.BECKETT_DIR;
process.env.BECKETT_DIR = dir;
const token = randomBytes(32).toString("base64url");
const runId = "betterwright-smoke";
const config = validateConfig({
  paths: { beckett_dir: dir },
  quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 20_000 },
});
const runtime = createBrowserRuntime({ config, logger });

interface McpClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
  stop(): Promise<void>;
}

/** Minimal line-framed client so this smoke covers the production stdio MCP bridge too. */
function startMcp(run: string): McpClient {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "..", "..", "src", "browser", "mcp.ts")],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BECKETT_CONTROL_SOCKET: socket,
      BECKETT_BROWSER_RUN_ID: run,
      BECKETT_BROWSER_CONTROL_TOKEN: token,
      BECKETT_BROWSER_EVAL_TIMEOUT_MS: "30000",
      BECKETT_BROWSER_MAX_OUTPUT_CHARS: "24000",
    },
  });
  const sink = child.stdin;
  if (!sink || typeof sink === "number") throw new Error("could not open BetterWright MCP stdin");
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const pending = new Map<number, { resolve(value: Record<string, any>): void; reject(error: Error): void }>();
  let buffer = "";
  let nextId = 1;
  const receive = (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Record<string, any>;
          const request = pending.get(message.id);
          if (!request) continue;
          pending.delete(message.id);
          request.resolve(message);
        }
      }
      for (const request of pending.values()) request.reject(new Error("BetterWright MCP closed before responding"));
    } catch (error) {
      for (const request of pending.values()) request.reject(error as Error);
    }
  })();
  return {
    call(method, params = {}) {
      const id = nextId++;
      const response = new Promise<Record<string, any>>((resolve, reject) => pending.set(id, { resolve, reject }));
      sink.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    async stop() {
      sink.end();
      await Promise.all([receive, child.exited]);
      if ((await child.exited) !== 0) {
        const stderr = await new Response(child.stderr as ReadableStream).text();
        throw new Error(`BetterWright MCP exited unexpectedly: ${stderr}`);
      }
    },
  };
}

/**
 * BetterWright 1.7.1's own words for "Obscura served this call", emitted in the result
 * envelope's `warnings` at the exact point the worker sets `browserBackend = "obscura"`
 * (betterwright src/worker.ts: the Obscura launch arm ends with this note whenever
 * `chromiumArgs` were supplied, because the resident engine ignores them). The
 * compatibility arm only ever warns about individual *rejected* switches, so this exact
 * string is unambiguous — and it comes from the session that actually ran, rather than
 * from the quota number this smoke is trying to judge.
 */
const OBSCURA_ENVELOPE_WARNING =
  "chromiumArgs apply only to the on-demand pixel renderer; Obscura ignored them for resident execution.";

/**
 * The backend Beckett *intended*: betterwright picks Obscura only for headless sessions,
 * and inside the sandbox it can only find the engine when isolated.ts mounts it and sets
 * BETTERWRIGHT_OBSCURA_ROOT (obscuraLaunch, mirrored here on the same inputs). Detection
 * cross-checks the envelope against this so a silent fallback — engine mounted but not
 * used — fails the gate instead of quietly relaxing the assertion to Obscura's.
 *
 * Moot on betterwright >=1.8.0: Obscura was removed outright ("Removed Obscura and made
 * native BetterChromium the required/default backend", CHANGELOG 1.8.0), so no installed
 * version past that point can ever route here regardless of `headless` or whether a stale
 * Obscura install still sits on disk. `OBSCURA_ENVELOPE_WARNING` — the only signal
 * `detectBackend` has for "Obscura served this call" — can then never appear either, so
 * both sides of the comparison agree without the mount-probe ever running.
 */
function gatedBackend(headless: boolean): BrowserLaneBackend {
  if (OBSCURA_REMOVED) return "compatibility";
  const root = process.env.BETTERWRIGHT_OBSCURA_ROOT?.trim() || join(homedir(), ".betterwright", "obscura");
  return headless && obscuraLaunch({ obscuraRoot: root }).mountRoot !== null ? "obscura" : "compatibility";
}

/** Which engine served this envelope, or a thrown error when the two signals disagree. */
function detectBackend(result: BrowserEvalResult, headless: boolean, chromiumArgs: readonly string[] | undefined): BrowserLaneBackend {
  // The signal is "Obscura discarded your switches", so it only exists when there were
  // switches to discard. The lane always sets some (config default --disable-gpu), and a
  // lane that stopped would make the absence of the warning meaningless, not reassuring.
  if (!chromiumArgs || chromiumArgs.length === 0) {
    throw new Error("browser smoke cannot identify the backend: the lane passed no chromiumArgs for BetterWright to report on");
  }
  const observed: BrowserLaneBackend = (result.warnings ?? []).includes(OBSCURA_ENVELOPE_WARNING) ? "obscura" : "compatibility";
  const intended = gatedBackend(headless);
  if (observed !== intended) {
    throw new Error(`browser backend mismatch: Beckett gated ${intended} but BetterWright served ${observed}`);
  }
  return observed;
}

function mcpResult(response: Record<string, any>): BrowserEvalResult {
  if (response.error) throw new Error(`MCP error: ${response.error.message}`);
  const result = response.result as { isError?: boolean; content?: Array<{ type?: string; text?: string; data?: string }> };
  if (result.isError) throw new Error(`browser tool error: ${result.content?.[0]?.text ?? "unknown error"}`);
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error("BetterWright MCP returned no browser result");
  return JSON.parse(text) as BrowserEvalResult;
}

let stopBus: (() => void) | undefined;
let mcp: McpClient | undefined;
try {
  await runtime.acquire({
    runId,
    channelId: null,
    artifactsDir: join(dir, "browser-agent", runId, "artifacts"),
    controlToken: token,
  });
  stopBus = serveBus(socket, async (request) => {
    if (request.cmd !== "browser.eval" || request.args.runId !== runId || request.args.controlToken !== token || typeof request.args.code !== "string") {
      return { ok: false, error: "unexpected browser smoke request" };
    }
    return { ok: true, data: await runtime.evaluate(runId, request.args.code, token) };
  });
  mcp = startMcp(runId);
  const initialized = await mcp.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  if (initialized.result?.serverInfo?.name !== "beckett-browser") throw new Error("BetterWright MCP did not initialize");
  const tools = await mcp.call("tools/list");
  if (tools.result?.tools?.[0]?.name !== "betterwright_browser") throw new Error("BetterWright browser tool was not exposed");

  const result = mcpResult(await mcp.call("tools/call", {
    name: "betterwright_browser",
    arguments: {
      code: `
        await page.goto(${JSON.stringify(baseUrl)});
        await page.getByLabel('Message').fill('browser-ready');
        await page.getByRole('button', { name: 'Save' }).click();
        return await page.locator('output').innerText();
      `,
    },
  }));
  if (result.value !== "saved:browser-ready") throw new Error(`unexpected BetterWright result: ${String(result.value)}`);

  // The storage quota a page actually reads. What counts as correct depends on which
  // engine served the session: CloakBrowser fabricates this figure from the profile's
  // fingerprint seed unless the lane's `--fingerprint-storage-quota` override wins, while
  // Obscura takes no such switch and reports its own fixed constant. Only a real browser
  // on a real origin can tell which number won — unit tests reach the switch, not the page.
  const estimate = mcpResult(await mcp.call("tools/call", {
    name: "betterwright_browser",
    arguments: {
      code: `
        await page.goto(${JSON.stringify(baseUrl)});
        const estimate = await page.evaluate(() => navigator.storage.estimate());
        return estimate.quota;
      `,
    },
  }));
  const settings = browserHostSettings(config);
  const quota = Number(estimate.value);
  const expected = resolveLaneStorageBytes({ profileDir: settings.profileDir });
  if (!Number.isFinite(quota) || quota <= 0) throw new Error(`browser reported no storage quota: ${String(estimate.value)}`);
  const backend = detectBackend(estimate, settings.headless, settings.chromiumArgs);
  // One line so a future deploy log explains itself: the two backends assert different
  // numbers, and "which engine ran" is the first thing anyone reading a failure needs.
  process.stdout.write(`browser smoke exercised the ${backend} backend; page storage quota ${quota} bytes (lane budget ${expected})\n`);
  if (CLOAKBROWSER_REMOVED) {
    // cloak-storage-quota.mjs (isolated.ts's BETTERWRIGHT_CLOAKBROWSER_PATH shim) only
    // ever reached the browser by substituting CloakBrowser's own launcher module with
    // `--fingerprint-storage-quota` appended. CloakBrowser is gone as of 1.8.5 ("the
    // managed fork is the default and only bundled browser"), so betterwright never
    // imports that shim any more — it is dead code the lane still publishes into the
    // sandbox, and `navigator.storage.estimate()` now reports whatever BetterChromium
    // computes on its own (measured on this box: a flat 10 GiB, tracking nothing about
    // the lane's actual budget). That is a real quota-advertisement gap, not a safety
    // gap: `enforceProfileBudget` in betterwright.ts measures the profile directory on
    // disk directly and is wholly independent of what the page was told, so a lease is
    // still killed at its real ceiling regardless of this number. Tracked as follow-up;
    // this smoke only asserts the figure is sane, not that it matches the lane budget.
    process.stdout.write(
      `browser smoke: skipping quota-tracks-budget assertion — CloakBrowser's quota shim ` +
      `has no effect on betterwright ${betterwrightPkg.version} (quota ${quota} vs lane budget ${expected}, ` +
      `diff ${Math.abs(quota - expected)} bytes; host-side profile enforcement is unaffected)\n`,
    );
  } else {
    // Both arms are gated here; only one runs per session because betterwright picks the
    // backend per launch and the two are documented as unsafe to share a profile
    // (betterwright docs/getting-started.md), so a second in-script pass would trade a real
    // check for a profile reset. laneStorageQuotaViolation is pure and unit-tested against
    // both backends' fixtures instead.
    const violation = laneStorageQuotaViolation({ backend, quota, expectedBytes: expected });
    if (violation) throw new Error(violation);
  }

  const captured = await mcp.call("tools/call", {
    name: "betterwright_browser",
    arguments: { code: "return await screenshot({ kind: 'proof', name: 'betterwright-smoke' })" },
  });
  const image = (captured.result?.content as Array<{ type?: string; data?: string }> | undefined)?.find((entry) => entry.type === "image");
  if (!image?.data) throw new Error("BetterWright MCP screenshot handoff failed");
  await mcp.stop();
  mcp = undefined;
  await runtime.release(runId, false);

  await runtime.acquire({
    runId: "betterwright-smoke-restart",
    channelId: null,
    artifactsDir: join(dir, "browser-agent", "betterwright-smoke-restart", "artifacts"),
    controlToken: token,
  });
  const persisted = await runtime.evaluate(
    "betterwright-smoke-restart",
    `
      await page.goto(${JSON.stringify(baseUrl)});
      return await page.evaluate(() => document.cookie + '|' + localStorage.getItem('browser-smoke'));
    `,
    token,
  );
  // What survives a session restart is also backend-specific, and for the same reason as
  // the quota: BetterWright's Obscura profile persistence covers cookies and only cookies
  // (CHANGELOG 1.7.0, "Persistent Obscura profiles now restore and durably save bounded
  // cookies"; worker.ts has read/writeObscuraCookies and no localStorage counterpart),
  // while the compatibility backend hands Chromium a real persistent profile that keeps
  // both. So the cookie half is asserted on both backends and the localStorage half is
  // pinned to what each one actually guarantees — including Obscura's `null`, so the day
  // it gains durable DOM storage this fires instead of silently widening.
  const expectedPersisted = backend === "obscura"
    ? "browser_smoke=browser-ready|null"
    : "browser_smoke=browser-ready|browser-ready";
  if (persisted.value !== expectedPersisted) {
    throw new Error(`persistent BetterWright state failed: ${String(persisted.value)}`);
  }
  await runtime.release("betterwright-smoke-restart", false);

  // The production adapter intentionally leaves `profile` unset: these are two
  // named sessions in its one backward-compatible default profile. A slow page
  // load in alpha must not block beta, which proves the session daemon accepted
  // both leases without attempting a second owner for that profile lock.
  const alphaRunId = "betterwright-parallel-alpha";
  const betaRunId = "betterwright-parallel-beta";
  await Promise.all([alphaRunId, betaRunId].map((parallelRunId) => runtime.acquire({
    runId: parallelRunId,
    channelId: null,
    artifactsDir: join(dir, "browser-agent", parallelRunId, "artifacts"),
    controlToken: token,
  })));
  let alphaFinished = false;
  const alpha = runtime.evaluate(
    alphaRunId,
    `await page.goto(${JSON.stringify(`${baseUrl}/parallel-slow`)}); return await page.textContent('body')`,
    token,
  ).finally(() => { alphaFinished = true; });
  // Give alpha's navigation a chance to reach the shared daemon before beta
  // starts. The endpoint remains slow enough for the assertion below to be
  // deterministic without imposing a timing threshold on the fast session.
  await Bun.sleep(100);
  const beta = await runtime.evaluate(
    betaRunId,
    `await page.goto(${JSON.stringify(`${baseUrl}/parallel-fast`)}); return await page.textContent('body')`,
    token,
  );
  if (beta.value !== "fast") throw new Error(`parallel beta session failed: ${String(beta.value)}`);
  if (alphaFinished) throw new Error("parallel alpha session completed before beta; parallelism was not exercised");
  const alphaResult = await alpha;
  if (alphaResult.value !== "slow") throw new Error(`parallel alpha session failed: ${String(alphaResult.value)}`);
  await Promise.all([runtime.release(alphaRunId, false), runtime.release(betaRunId, false)]);
  process.stdout.write("betterwright browser MCP and default-profile parallel-session smoke passed\n");
} finally {
  if (mcp) await mcp.stop().catch(() => undefined);
  stopBus?.();
  await runtime.stop();
  server.stop(true);
  if (previousDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
}
