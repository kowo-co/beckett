/**
 * #31 — the `pr.watch` control-bus op (the manual pr-create → poller registration path).
 * =======================================================================================
 * `beckett gh pr create` has no handle on the in-daemon poller, so it forwards the just-opened PR
 * over the control bus as `pr.watch`; this file pins that the concierge routes a valid payload —
 * origin channel and all — to the wired registrar (which v4-main points at `prPoller.watch`), and
 * that an unwired concierge answers a clean no-op instead of half-working.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { validateConfig } from "../config.ts";
import { GitHubPrPoller, type WatchRequest } from "../github/poll.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const tmpDirs: string[] = [];
const savedDir = process.env.BECKETT_DIR;
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(): Concierge {
  const dir = mkdtempSync(join(tmpdir(), "beckett-pr-watch-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  const saved = process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  const config = validateConfig({});
  if (saved === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = saved;
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
  return new Concierge({ config, session, gateway });
}

test("pr.watch forwards a hand-opened PR (channel stamped) to the wired registrar", async () => {
  const concierge = harness();
  const seen: WatchRequest[] = [];
  concierge.setPrWatchRegistrar((req) => seen.push(req));

  const res = await concierge.onBusRequest({
    cmd: "pr.watch",
    args: {
      repo: "betterwright/betterwright",
      number: 66,
      url: "https://github.com/betterwright/betterwright/pull/66",
      title: "reimplement #65",
      channel: "chan-open",
      author: "0xbeckett",
    },
  });

  expect(res).toEqual({ ok: true, data: { watching: true, repo: "betterwright/betterwright", number: 66 } });
  expect(seen).toEqual([
    {
      repo: "betterwright/betterwright",
      number: 66,
      url: "https://github.com/betterwright/betterwright/pull/66",
      title: "reimplement #65",
      channel: "chan-open",
      runId: undefined,
      author: "0xbeckett",
    },
  ]);
});

test("pr.watch through a real poller persists the origin channel onto the watch record", async () => {
  // The end-to-end proof: register a PR the way `beckett gh pr create` does (over the bus), wired to
  // a REAL GitHubPrPoller, and assert the origin channel actually lands on the poller's persisted
  // watch record — the record `Concierge.channelForPr` reads to route the PR's events. Without it,
  // a hand-opened cross-org PR (no origin ticket channel) has nothing to route on and is dropped.
  const concierge = harness();
  const dir = mkdtempSync(join(tmpdir(), "beckett-pr-watch-poller-"));
  tmpDirs.push(dir);
  const statePath = join(dir, "github-prs.json");
  const poller = new GitHubPrPoller({
    reader: { async prSignals() { throw new Error("unused"); } },
    account: "0xbeckett",
    logger: { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } } as never,
    statePath,
    now: () => 1_000,
  });
  concierge.setPrWatchRegistrar((req) => poller.watch(req));

  const res = await concierge.onBusRequest({
    cmd: "pr.watch",
    args: {
      repo: "betterwright/betterwright",
      number: 66,
      url: "https://github.com/betterwright/betterwright/pull/66",
      title: "reimplement #65",
      channel: "chan-open",
      author: "0xbeckett",
    },
  });
  expect(res.ok).toBe(true);

  const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, { channel?: string }>;
  expect(persisted["betterwright/betterwright#66"]!.channel).toBe("chan-open");
});

test("pr.watch rejects an incomplete payload without touching the registrar", async () => {
  const concierge = harness();
  let calls = 0;
  concierge.setPrWatchRegistrar(() => calls++);

  const res = await concierge.onBusRequest({ cmd: "pr.watch", args: { repo: "x/y", url: "u" } });
  expect(res.ok).toBe(false);
  expect(calls).toBe(0);
});
