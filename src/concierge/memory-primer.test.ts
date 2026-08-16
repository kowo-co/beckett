/**
 * Memory primer (overhaul B — memory-primer): a per-turn SYSTEM block of relevant memory-graph
 * notes, auto-selected by relevance to the message. Exercised through {@link Concierge.onMessage}
 * exactly like the person block (`identity-turn.test.ts`) — same harness, same
 * "byte-identical when there's nothing to add" bar.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import { createMemory, type MemoryStore } from "../memory/index.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
const OWNER = "999888777666555444";
const ALICE = "222222222222222222";

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

function tmpBeckettDir(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-memory-primer-"));
  tmpDirs.push(d);
  process.env.BECKETT_DIR = d;
  return d;
}

function config(overrides: Record<string, unknown> = {}): Config {
  return {
    concierge: { model: "m", rotate_at_tokens: 190_000, ...overrides },
    paths: {},
  } as unknown as Config;
}

function fakeSession(asks: TurnMessage[]): ConciergeSession {
  return {
    start: async () => {},
    stop: async () => {},
    ask: async (m: TurnMessage) => {
      asks.push(m);
      return "ok";
    },
  } as unknown as ConciergeSession;
}

function fakeGateway(): DiscordGateway {
  return {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async () => "posted-id",
    isConnected: () => true,
  } as unknown as DiscordGateway;
}

function message(over: Partial<IncomingMessage>): IncomingMessage {
  return {
    messageId: "msg-1",
    userId: ALICE,
    channelId: CHAN,
    guildId: "g",
    content: "hey",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 0,
    attachments: [],
    ...over,
  };
}

function stamp(turn: TurnMessage): string {
  return typeof turn === "string" ? turn : "";
}

function newMemory(dir: string): MemoryStore {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return createMemory({ memoryDir: join(dir, "memory"), logger: log as never, git: false });
}

/** ALICE is a non-owner speaker in every test here; grant access so turns actually reach `ask`. */
function grantAliceAccess(dir: string): void {
  writeFileSync(join(dir, "access.txt"), `${ALICE}\n`);
}

test("a relevant public node is injected once, and not again in the same session", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  grantAliceAccess(dir);
  const memory = newMemory(dir);
  await memory.remember({
    op: "create",
    name: "rocketship-project",
    type: "project",
    description: "our flagship project, rocketship",
    body: "Rocketship ships every Friday using the deploy pipeline.",
    source: "manual",
    reason: "test fixture",
  });

  const asks: TurnMessage[] = [];
  const c = new Concierge({ config: config(), session: fakeSession(asks), gateway: fakeGateway(), memory });

  await c.onMessage(message({ userId: ALICE, content: "hey, how is the rocketship project deploy going this week?", messageId: "m1" }));
  expect(stamp(asks[0]!)).toContain("SYSTEM (helpful memories");
  expect(stamp(asks[0]!)).toContain("rocketship-project");
  expect(stamp(asks[0]!)).toContain("recall more with `beckett recall");

  // Same session, same relevant message → the note is standing knowledge now, not re-shown.
  await c.onMessage(message({ userId: ALICE, content: "any update on the rocketship project deploy today?", messageId: "m2" }));
  expect(stamp(asks[1]!)).not.toContain("SYSTEM (helpful memories");
  expect(stamp(asks[1]!)).not.toContain("rocketship-project");
});

test("a dm-scoped node is never injected into a guild turn", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  grantAliceAccess(dir);
  const memory = newMemory(dir);
  await memory.remember({
    op: "create",
    name: "dm-secret-project",
    type: "project",
    description: "a dm-only project called dm secret project",
    body: "Only in that DM should this dm secret project fact ever appear.",
    metadata: { visibility: "dm", dm_with: ALICE },
    source: "manual",
    reason: "test fixture",
  });

  const asks: TurnMessage[] = [];
  const c = new Concierge({ config: config(), session: fakeSession(asks), gateway: fakeGateway(), memory });

  // Guild turn (message() defaults guildId: "g") mentioning the dm-scoped fact by name.
  await c.onMessage(message({ userId: ALICE, content: "what's the status of the dm secret project fact?", messageId: "m1" }));
  expect(stamp(asks[0]!)).not.toContain("dm-secret-project");
  expect(stamp(asks[0]!)).not.toContain("SYSTEM (helpful memories");
});

test("an owner-scoped node IS injected (as-self is the concierge's own working knowledge)", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  grantAliceAccess(dir);
  const memory = newMemory(dir);
  await memory.remember({
    op: "create",
    name: "owner-only-project",
    type: "project",
    description: "an owner-only project called owner only project",
    body: "Owner only project deploys straight from main, no staging.",
    metadata: { visibility: "owner" },
    source: "manual",
    reason: "test fixture",
  });

  const asks: TurnMessage[] = [];
  const c = new Concierge({ config: config(), session: fakeSession(asks), gateway: fakeGateway(), memory });

  await c.onMessage(message({ userId: ALICE, content: "how does the owner only project deploy work these days?", messageId: "m1" }));
  expect(stamp(asks[0]!)).toContain("SYSTEM (helpful memories");
  expect(stamp(asks[0]!)).toContain("owner-only-project");
});

test("enabled=false ⇒ no block, even for an otherwise-relevant message", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  grantAliceAccess(dir);
  const memory = newMemory(dir);
  await memory.remember({
    op: "create",
    name: "rocketship-project",
    type: "project",
    description: "our flagship project, rocketship",
    body: "Rocketship ships every Friday using the deploy pipeline.",
    source: "manual",
    reason: "test fixture",
  });

  const asks: TurnMessage[] = [];
  const c = new Concierge({
    config: config({ memory_primer: { enabled: false } }),
    session: fakeSession(asks),
    gateway: fakeGateway(),
    memory,
  });

  await c.onMessage(message({ userId: ALICE, content: "hey, how is the rocketship project deploy going this week?", messageId: "m1" }));
  expect(stamp(asks[0]!)).not.toContain("SYSTEM (helpful memories");
  expect(stamp(asks[0]!)).not.toContain("rocketship-project");
});

test("a short or command-like message never calls recall", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  grantAliceAccess(dir);
  const memory = newMemory(dir);
  await memory.remember({
    op: "create",
    name: "rocketship-project",
    type: "project",
    description: "our flagship project, rocketship",
    body: "Rocketship ships every Friday.",
    source: "manual",
    reason: "test fixture",
  });
  let calls = 0;
  const originalRecall = memory.recall.bind(memory);
  memory.recall = (async (...args: Parameters<MemoryStore["recall"]>) => {
    calls++;
    return originalRecall(...args);
  }) as MemoryStore["recall"];

  const asks: TurnMessage[] = [];
  const c = new Concierge({ config: config(), session: fakeSession(asks), gateway: fakeGateway(), memory });

  await c.onMessage(message({ userId: ALICE, content: "ok thanks!", messageId: "m1" }));
  await c.onMessage(message({ userId: ALICE, content: "short one", messageId: "m2" }));
  expect(calls).toBe(0);
  expect(stamp(asks[0]!)).not.toContain("SYSTEM (helpful memories");
  expect(stamp(asks[1]!)).not.toContain("SYSTEM (helpful memories");
});

test("max_chars caps the injected block", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  grantAliceAccess(dir);
  const memory = newMemory(dir);
  const longBody =
    "Rocketship deploy notes: " + "the pipeline ships every Friday afternoon after tests pass. ".repeat(10);
  await memory.remember({
    op: "create",
    name: "rocketship-project",
    type: "project",
    description: "our flagship project, rocketship",
    body: longBody,
    source: "manual",
    reason: "test fixture",
  });
  await memory.remember({
    op: "create",
    name: "rocketship-project-two",
    type: "project",
    description: "second flagship project, rocketship two",
    body: longBody,
    source: "manual",
    reason: "test fixture",
  });

  const asks: TurnMessage[] = [];
  const c = new Concierge({
    config: config({ memory_primer: { enabled: true, max_notes: 5, max_chars: 60, min_score: 0.1 } }),
    session: fakeSession(asks),
    gateway: fakeGateway(),
    memory,
  });

  await c.onMessage(message({ userId: ALICE, content: "how are the rocketship project deploys going lately?", messageId: "m1" }));
  const turn = stamp(asks[0]!);
  const noteLines = turn.split("\n").filter((l) => l.startsWith("- rocketship"));
  // A budget of 60 chars can't fit two ~100+ char note lines; the first is always shown
  // (a single oversized line never empties the block), the second is dropped by the cap.
  expect(noteLines.length).toBe(1);
});

test("a throwing memory store yields no block, and the turn still builds", async () => {
  const dir = tmpBeckettDir();
  process.env.DISCORD_OWNER_ID = OWNER;
  grantAliceAccess(dir);
  const memory = newMemory(dir);
  memory.recall = (async () => {
    throw new Error("store is on fire");
  }) as MemoryStore["recall"];

  const asks: TurnMessage[] = [];
  const c = new Concierge({ config: config(), session: fakeSession(asks), gateway: fakeGateway(), memory });

  await c.onMessage(message({ userId: ALICE, content: "how is the rocketship project deploy going this week?", messageId: "m1" }));
  expect(stamp(asks[0]!)).not.toContain("SYSTEM (helpful memories");
  expect(stamp(asks[0]!)).toContain("how is the rocketship project deploy going this week?");
});
