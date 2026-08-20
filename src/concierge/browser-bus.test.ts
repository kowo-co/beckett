/**
 * `browser.steer` / `browser.stop` over the control bus (the CLI's own dispatch path).
 * =======================================================================================
 * The CLI (`beckett browser steer|stop`) always calls these two bus commands with NO session
 * token — a bare shell has no live concierge turn to echo `BECKETT_SESSION_TOKEN` from — so
 * `callBus` stamps the request `operator: true` (see `BusRequest.operator`). Before this fix,
 * both handlers demanded an `issuerMention`, which a tokenless bare-CLI call could only ever
 * satisfy by accident (a coincidentally live Discord turn), so `beckett browser stop <run-id>`
 * always failed with "stopping a run needs an authenticated authorized request".
 *
 * A SECOND, subtler dead path: `beckett` run from a shell a concierge session itself spawned
 * (e.g. a Bash tool call mid a `SYSTEM_SCOPE` update turn — `askUpdate` runs meta-less) is NOT
 * tokenless — `ConciergeSession.childEnv()` unconditionally echoes `BECKETT_SESSION_TOKEN` — so it
 * never gets `operator: true`, and its token resolves to no mention (the turn has no channel to
 * protect) exactly like a forged token would. `isSystemTurnToken` tells those apart: a token that
 * matches a LIVE pooled session (`pool.tokenKnown`) but whose current turn carries no mention meta
 * is trusted like an operator call; a token matching no live session still fails closed.
 *
 * This suite pins: an operator (tokenless) call succeeds without any live mention; a system-turn
 * token (recognized session, no mention) succeeds the same way; an unrecognized/forged token is
 * still refused; and a Discord-originated call (a resolvable issuer mention) is still refused when
 * it targets a run dispatched in a DIFFERENT channel — neither bypass weakens that lock.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { validateConfig } from "../config.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { BrowserAgent } from "../browser/agent.ts";

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function keylessDefaultConfig() {
  const saved = process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  try {
    return validateConfig({});
  } finally {
    if (saved === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = saved;
  }
}

/** A minimal fake BrowserAgent with one parked run in RUN_CHANNEL; steer/stop record their calls. */
function fakeAgent(runChannelId: string): { agent: BrowserAgent; calls: string[] } {
  const calls: string[] = [];
  const inspection = {
    run: {
      runId: "run-1",
      state: "waiting",
      task: "do the thing",
      channelId: runChannelId,
      startedAt: 0,
      finishedAt: null,
      question: "what next?",
      result: null,
      proofFiles: [],
    },
    journal: [],
    screenshot: null,
    liveViewUrl: null,
  };
  const agent = {
    async run() {
      throw new Error("not exercised");
    },
    async resume() {},
    async steer(runId: string, note: string) {
      calls.push(`steer:${runId}:${note}`);
      return "resumed" as const;
    },
    async stop(runId: string, reason?: string) {
      calls.push(`stop:${runId}:${reason ?? ""}`);
    },
    drainSteers() {
      return [];
    },
    recordEval() {},
    async inspect(runId: string) {
      return runId === "run-1" ? inspection : null;
    },
    async evalSecrets() {
      return null;
    },
    async saveSecret() {
      return { ok: false, error: "not exercised" } as never;
    },
    async recover() {},
    stats() {
      return { live: [], recent: [], queued: [] } as never;
    },
    async stopAll() {},
  } as unknown as BrowserAgent;
  return { agent, calls };
}

function harness(runChannelId: string) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-bus-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const config = keylessDefaultConfig();
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() {
      return "mid-1";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 1,
  } as unknown as DiscordGateway;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => "",
    stats: () => ({}),
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });
  const { agent, calls } = fakeAgent(runChannelId);
  concierge.setBrowserAgent(agent);
  return { concierge, calls };
}

/**
 * Like {@link harness}, but the fixed session exposes `busToken`/`getCurrentMeta` so the pool can
 * recognize `token` as belonging to a LIVE session — simulating a concierge-spawned shell mid a
 * meta-less system/update turn (see the file header). `getCurrentMeta` returns null throughout:
 * a real system turn never attaches a mention.
 */
function harnessWithSystemToken(runChannelId: string, token: string) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-bus-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const config = keylessDefaultConfig();
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() {
      return "mid-1";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 1,
  } as unknown as DiscordGateway;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => "",
    stats: () => ({}),
    busToken: () => token,
    getCurrentMeta: () => null,
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });
  const { agent, calls } = fakeAgent(runChannelId);
  concierge.setBrowserAgent(agent);
  return { concierge, calls };
}

// ── operator (CLI) path: no token, no live mention needed ────────────────────────────────────

test("browser.steer: an operator call (no token) delivers the note with no live mention", async () => {
  const { concierge, calls } = harness("chan-a");
  const res = await concierge.onBusRequest({
    cmd: "browser.steer",
    args: { runId: "run-1", note: "use the annual plan" },
    operator: true,
  });
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({ runId: "run-1", delivery: "resumed" });
  expect(calls).toEqual(["steer:run-1:use the annual plan"]);
});

test("browser.stop: an operator call (no token) cancels the run with no live mention", async () => {
  const { concierge, calls } = harness("chan-a");
  const res = await concierge.onBusRequest({
    cmd: "browser.stop",
    args: { runId: "run-1", reason: "person cancelled" },
    operator: true,
  });
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({ runId: "run-1", state: "cancelled" });
  expect(calls).toEqual(["stop:run-1:person cancelled"]);
});

test("browser.stop: an operator call for an unknown run still reports it as unknown", async () => {
  const { concierge } = harness("chan-a");
  const res = await concierge.onBusRequest({
    cmd: "browser.stop",
    args: { runId: "run-missing" },
    operator: true,
  });
  expect(res).toEqual({ ok: false, error: "browser run run-missing is unknown" });
});

// ── system-turn-token path: a concierge-spawned shell mid a meta-less update turn ────────────

test("browser.steer: a token from a live session's system turn (no mention) delivers the note", async () => {
  const { concierge, calls } = harnessWithSystemToken("chan-a", "sys-token");
  const res = await concierge.onBusRequest({
    cmd: "browser.steer",
    args: { runId: "run-1", note: "keep going" },
    token: "sys-token",
  });
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({ runId: "run-1", delivery: "resumed" });
  expect(calls).toEqual(["steer:run-1:keep going"]);
});

test("browser.stop: a token from a live session's system turn (no mention) cancels the run", async () => {
  const { concierge, calls } = harnessWithSystemToken("chan-a", "sys-token");
  const res = await concierge.onBusRequest({
    cmd: "browser.stop",
    args: { runId: "run-1", reason: "deploy preflight" },
    token: "sys-token",
  });
  expect(res.ok).toBe(true);
  expect(res.data).toEqual({ runId: "run-1", state: "cancelled" });
  expect(calls).toEqual(["stop:run-1:deploy preflight"]);
});

test("browser.stop: a token that matches no live session is still refused, not treated as a system turn", async () => {
  const { concierge, calls } = harnessWithSystemToken("chan-a", "sys-token");
  const res = await concierge.onBusRequest({
    cmd: "browser.stop",
    args: { runId: "run-1" },
    token: "forged-token",
  });
  expect(res).toEqual({ ok: false, error: "stopping a run needs an authenticated authorized request" });
  expect(calls).toEqual([]);
});

// ── Discord path: an issuer mention still exists, and the same-channel lock still applies ────

test("browser.steer: a Discord-originated call from a DIFFERENT channel is still refused", async () => {
  const { concierge, calls } = harness("chan-a");
  (concierge as unknown as { issuerMention: () => unknown }).issuerMention = () => ({
    channelId: "chan-b",
    userId: "user-1",
  });
  const res = await concierge.onBusRequest({
    cmd: "browser.steer",
    args: { runId: "run-1", note: "use the annual plan" },
    token: "session-token",
  });
  expect(res).toEqual({ ok: false, error: "browser runs can only be steered from the channel that dispatched them" });
  expect(calls).toEqual([]);
});

test("browser.stop: a Discord-originated call from a DIFFERENT channel is still refused", async () => {
  const { concierge, calls } = harness("chan-a");
  (concierge as unknown as { issuerMention: () => unknown }).issuerMention = () => ({
    channelId: "chan-b",
    userId: "user-1",
  });
  const res = await concierge.onBusRequest({
    cmd: "browser.stop",
    args: { runId: "run-1" },
    token: "session-token",
  });
  expect(res).toEqual({ ok: false, error: "browser runs can only be stopped from the channel that dispatched them" });
  expect(calls).toEqual([]);
});

test("browser.stop: a Discord-originated call with no resolvable issuer mention is still refused", async () => {
  const { concierge, calls } = harness("chan-a");
  (concierge as unknown as { issuerMention: () => unknown }).issuerMention = () => null;
  const res = await concierge.onBusRequest({
    cmd: "browser.stop",
    args: { runId: "run-1" },
    token: "session-token",
  });
  expect(res).toEqual({ ok: false, error: "stopping a run needs an authenticated authorized request" });
  expect(calls).toEqual([]);
});

test("browser.steer: a Discord-originated call from the SAME channel as the run still succeeds", async () => {
  const { concierge, calls } = harness("chan-a");
  (concierge as unknown as { issuerMention: () => unknown }).issuerMention = () => ({
    channelId: "chan-a",
    userId: "user-1",
  });
  const res = await concierge.onBusRequest({
    cmd: "browser.steer",
    args: { runId: "run-1", note: "same channel" },
    token: "session-token",
  });
  expect(res.ok).toBe(true);
  expect(calls).toEqual(["steer:run-1:same channel"]);
});
