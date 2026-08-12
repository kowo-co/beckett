/**
 * Early-ack channel (issue #122 — streaming / progressive reply delivery). A slow @mention turn
 * (Opus + tool calls) used to sit 15–90s behind only a typing indicator: the single terminal
 * structured output was the FIRST visible text. `beckett discord ack` decouples that — the model
 * emits one immediate line the instant it starts working, WITHOUT claiming the turn, so the real
 * schema-validated answer still posts terminally afterwards. These pin that contract:
 *   - the ack posts immediately, as one atomic message (no humanizer gaps), a native reply;
 *   - it does NOT suppress the terminal answer (unlike `discord.reply`), so the person gets both;
 *   - it stays one short line (over-long text is truncated, never a second answer channel);
 *   - a declined turn can't sneak output out via an ack.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, EARLY_ACK_MAX_CHARS, type ConciergeSession } from "./index.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
const MSG = "msg-42";
const USER = "111111111111111111";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
  singleMessage?: boolean;
}

/**
 * A Concierge whose fake session, mid-turn, calls `beckett discord ack` (the bus path) before
 * returning its terminal turn text — the exact shape of a slow question that acks then answers.
 */
function harness(opts: { ackText?: string; turnText: string; config?: Config }) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-early-ack-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = USER;
  const posts: Post[] = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: { replyToMessageId?: string; singleMessage?: boolean }) {
      posts.push({
        channelId,
        text,
        replyTo: o?.replyToMessageId,
        ...(o?.singleMessage !== undefined ? { singleMessage: o.singleMessage } : {}),
      });
      return `mid-${posts.length}`;
    },
    async deleteMessage() {},
  } as unknown as DiscordGateway;

  let concierge!: Concierge;
  const session = {
    async start() {},
    async stop() {},
    ask: async (_m: string) => {
      if (opts.ackText !== undefined) {
        await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: CHAN, text: opts.ackText } });
      }
      return opts.turnText;
    },
  } as unknown as ConciergeSession;

  concierge = new Concierge({ config: opts.config ?? config, session, gateway });
  return { concierge, posts };
}

/** A `config.concierge.chilltext` slice, `enabled` set per test (issue W3A — chilltext gate). */
function chillConfig(enabled: boolean): Config {
  return {
    concierge: {
      model: "m",
      rotate_at_tokens: 190_000,
      chilltext: {
        enabled,
        url: "https://chilltext.example",
        timeout_ms: 8_000,
        max_bubbles: 3,
        bubble_delay_ms: 0,
        system_override: "",
        skip_code_blocks: true,
      },
    },
    paths: {},
  } as unknown as Config;
}

function mention(): IncomingMessage {
  return {
    messageId: MSG,
    userId: USER,
    channelId: CHAN,
    roleIds: [],
    content: "@beckett dig through the repo and tell me where X lives",
    mentionsBot: true,
    attachments: [],
  } as unknown as IncomingMessage;
}

test("an early ack posts immediately AND the terminal answer still posts (both, in order)", async () => {
  const { concierge, posts } = harness({ ackText: "on it — digging through the repo now", turnText: "found it: X lives in foo.ts" });
  await concierge.onMessage(mention());
  expect(posts).toHaveLength(2);
  // The ack lands first, as one atomic native reply (singleMessage bypasses the 2–4s humanizer gaps).
  expect(posts[0]).toEqual({ channelId: CHAN, text: "on it — digging through the repo now", replyTo: MSG, singleMessage: true });
  // The real, schema-validated answer still flows through the terminal structured-output boundary.
  expect(posts[1]).toMatchObject({ channelId: CHAN, text: "found it: X lives in foo.ts", replyTo: MSG });
  expect(posts[1]!.singleMessage).toBeUndefined();
});

test("a cross-channel / off-turn ack posts plainly (no native reply-bar)", async () => {
  const { concierge, posts } = harness({ turnText: "" });
  // No @mention turn in flight → a plain post, exactly like discord.reply's proactive-update path.
  const res = await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: CHAN, text: "quick heads up" } });
  expect(res.ok).toBe(true);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "quick heads up", replyTo: undefined, singleMessage: true });
});

test("chilltext enabled: an early ack is rewritten through the API before it posts, still one message", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ messages: ["digging in now"] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const { concierge, posts } = harness({ turnText: "", config: chillConfig(true) });
    const res = await concierge.onBusRequest({
      cmd: "discord.ack",
      args: { channelId: CHAN, text: "on it — digging through the repo now" },
    });
    expect(res.ok).toBe(true);
    expect(fetchCalled).toBe(true);
    expect(posts).toEqual([{ channelId: CHAN, text: "digging in now", replyTo: undefined, singleMessage: true }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("chilltext explicitly disabled: an early ack posts the original text untouched, no fetch", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const { concierge, posts } = harness({ turnText: "", config: chillConfig(false) });
    await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: CHAN, text: "quick heads up" } });
    expect(fetchCalled).toBe(false);
    expect(posts).toEqual([{ channelId: CHAN, text: "quick heads up", replyTo: undefined, singleMessage: true }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an over-long ack is truncated to one short line — never a second answer channel", async () => {
  const long = "x".repeat(EARLY_ACK_MAX_CHARS + 200);
  const { concierge, posts } = harness({ turnText: "" });
  await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: CHAN, text: long } });
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text.length).toBeLessThanOrEqual(EARLY_ACK_MAX_CHARS);
  expect(posts[0]!.text.endsWith("…")).toBe(true);
});

test("discord.ack needs a channel and text", async () => {
  const { concierge } = harness({ turnText: "" });
  const noText = await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: CHAN, text: "   " } });
  expect(noText.ok).toBe(false);
  const noChan = await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: "", text: "hi" } });
  expect(noChan.ok).toBe(false);
});

test("a duplicate ack payload is coalesced, not double-posted", async () => {
  const { concierge, posts } = harness({ turnText: "" });
  await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: CHAN, text: "digging in" } });
  await concierge.onBusRequest({ cmd: "discord.ack", args: { channelId: CHAN, text: "digging in" } });
  expect(posts).toHaveLength(1);
});
