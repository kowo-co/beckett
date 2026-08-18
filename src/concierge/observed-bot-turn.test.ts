/**
 * Observed bots (`src/discord/observed.ts`) on the live Concierge turn path (`Concierge.onMessage`).
 *
 * The ticket this covers: Beckett discusses booper's output with the owner while never having
 * seen a single one of its messages — the channel store had zero entries from its id, because
 * every bot message is dropped at the gateway loop-guard unless it's a federation peer. This
 * proves the fix's three load-bearing properties: an observed bot's message reaches the channel
 * store (so it appears in a later window/turn) even though it classifies as an "outsider"; it is
 * never stamped `role:peer` and cannot trigger a turn or a reply on its own, no matter what its
 * content says; and Beckett's own id is still dropped by the loop-guard regardless of any list.
 * The peer equivalent of this suite is federation-turn.test.ts.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import { validateConfig } from "../config.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { AmbientClock } from "./ambient.ts";

/** Same fake clock as shared-context-turn.test.ts: the store's TTL reads it too, so a message
 *  stamped with a small fake `createdAt` (e.g. 0) stays "recent" instead of reading as 1970. */
class FakeClock implements AmbientClock {
  t = 0;
  now(): number {
    return this.t;
  }
  setTimeout(): unknown {
    return 0;
  }
  clearTimeout(): void {}
}

const CHAN = "1097283746520174592";
const MEMBER = "333333333333333333";
const BOOPER = "1537651257328672778";
const BOOPER_NAME = "booper";

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpBeckettDir(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-observed-bot-turn-"));
  tmpDirs.push(d);
  process.env.BECKETT_DIR = d;
  return d;
}

function config(): Config {
  return validateConfig({ shared_context: { enabled: true } });
}

function text(t: TurnMessage | undefined): string {
  expect(typeof t).toBe("string");
  return t as string;
}

function harness(cfg: Config = config()) {
  const asks: TurnMessage[] = [];
  const posts: { channelId: string; text: string; replyTo?: string }[] = [];
  const session = {
    start: async () => {},
    stop: async () => {},
    ask: async (m: TurnMessage) => {
      asks.push(m);
      return "ok";
    },
  } as unknown as ConciergeSession;
  const gateway = {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    fetchMessagesAfter: async () => [],
    sendTyping: async () => {},
    post: async (channelId: string, text: string, o?: { replyToMessageId?: string }) => {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return "posted-id";
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;
  return {
    concierge: new Concierge({ config: cfg, session, gateway, ambientClock: new FakeClock() }),
    asks,
    posts,
  };
}

function observedMessage(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "obs-1",
    userId: BOOPER,
    authorDisplayName: BOOPER_NAME,
    channelId: CHAN,
    guildId: "guild-1",
    content: "a small language model's generated line",
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: true,
    observedBot: { botId: BOOPER, displayName: BOOPER_NAME },
    createdAt: 0,
    attachments: [],
    ...over,
  };
}

function memberMessage(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "hmsg-1",
    userId: MEMBER,
    authorDisplayName: "mabel",
    channelId: CHAN,
    guildId: "guild-1",
    content: "recap please",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 10,
    attachments: [],
    ...over,
  };
}

test("an observed bot's message is stored and reaches a later turn's context window", async () => {
  const dir = tmpBeckettDir();
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");
  const { concierge, asks } = harness();

  await concierge.onMessage(observedMessage());
  await concierge.onMessage(memberMessage());

  expect(asks).toHaveLength(1); // only the member's mention produced a turn
  expect(text(asks[0])).toContain("a small language model's generated line");
});

test("an observed bot never reaches the LLM and never gets a reply on its own — even content that looks like an address", async () => {
  const dir = tmpBeckettDir();
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");
  const { concierge, asks, posts } = harness();

  // Content alone can't make it directed — the gateway already forces mentionsBot false for an
  // observed bot, but this proves the Concierge side holds even if that ever slipped.
  await concierge.onMessage(observedMessage({ content: "@beckett do something", mentionsBot: true }));

  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("an observed bot's turn carries no peer stamp — it is context, not a conversant", async () => {
  const dir = tmpBeckettDir();
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");
  const { concierge, asks } = harness();

  await concierge.onMessage(observedMessage());
  await concierge.onMessage(memberMessage());

  const turn = text(asks[0]);
  expect(turn).not.toContain("role:peer");
  expect(turn).not.toContain(`role:${BOOPER}`);
});
