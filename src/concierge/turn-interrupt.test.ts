/**
 * Issue #117 — in-flight turn interrupt / steer / amend. A same-channel message arriving while a
 * turn is still generating must cancel that (now stale) turn and be answered as the next turn,
 * instead of the stale reply posting and the correction running as a separate full turn minutes
 * later. Pins the three layers of the cancel-and-restart path:
 *   1. ConciergeSession.cancelLiveTurn  — clean cancel of the live child + silent-pass resolve
 *   2. SessionPool.cancelLiveTurn       — channel-scoped guard (never cancels another channel)
 *   3. Concierge.onMessage              — supersede-and-answer wiring end to end
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, ConciergeSession, messagePlausiblyAmends } from "./index.ts";
import { SessionPool, type PoolSession } from "./session-pool.ts";
import { validateConfig } from "../config.ts";
import { grantAccess } from "../discord/access.ts";
import { createChannelContextStore } from "./channel-context.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { DiscordTurnOutput } from "./output.ts";

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {}, harness: { claude: { bin: "claude", extra_flags: [] } } } as unknown as Config;

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

function tempBeckettDir(): void {
  const dir = mkdtempSync(join(tmpdir(), "beckett-interrupt-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
}

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

// ── 1. ConciergeSession.cancelLiveTurn ────────────────────────────────────────────────────

interface SessionGuts {
  child: unknown;
  pending: {
    parts: string[];
    timer: ReturnType<typeof setTimeout>;
    timedOut: boolean;
    resolve: (output: unknown) => void;
    reject: (error: Error) => void;
  } | null;
  cancelLiveTurn(reason: string): boolean;
}

function makeSession(): SessionGuts {
  return new ConciergeSession({ config, logger: quietLog }) as unknown as SessionGuts;
}

test("cancelLiveTurn stops the live child and resolves the in-flight ask as a silent pass", () => {
  tempBeckettDir();
  const s = makeSession();
  let killed = false;
  const child = { kill() { killed = true; } };
  let delivered: unknown;
  s.child = child;
  s.pending = {
    parts: ["half of a now-stale answer"],
    timer: setTimeout(() => undefined, 60_000),
    timedOut: false,
    resolve: (output) => { delivered = output; },
    reject: () => {},
  };

  const cancelled = s.cancelLiveTurn("superseded by same-channel message");

  expect(cancelled).toBe(true);
  expect(killed).toBe(true); // the doomed generation is stopped, not left to finish minutes later
  expect(s.child).toBeNull(); // child recycled; the session id survives so the next ask() --resumes
  expect(s.pending).toBeNull();
  // A silent pass — never the stale half-answer, never an error bubble.
  expect(delivered).toEqual({ decision: "pass", message: null });
});

test("cancelLiveTurn is a no-op when no turn is live (normal path untouched)", () => {
  tempBeckettDir();
  const s = makeSession();
  s.pending = null;
  let killed = false;
  s.child = { kill() { killed = true; } };
  expect(s.cancelLiveTurn("nothing to cancel")).toBe(false);
  expect(killed).toBe(false); // an idle session's child is not touched
  expect(s.child).not.toBeNull();
});

// ── 2. SessionPool.cancelLiveTurn — channel-scoped guard ──────────────────────────────────

interface FakePoolSession extends PoolSession {
  cancels: string[];
  meta: unknown;
  toolUsed: boolean;
}

function fakePoolSession(scope: string): FakePoolSession {
  const s: FakePoolSession = {
    cancels: [],
    meta: null,
    toolUsed: false,
    start: async () => {},
    stop: async () => {},
    ask: () => Promise.resolve(`reply:${scope}`),
    getCurrentMeta: () => s.meta,
    hasLiveChild: () => true,
    liveTurnToolUse: () => s.toolUsed,
    cancelLiveTurn: (reason: string) => {
      s.cancels.push(reason);
      return true;
    },
  };
  return s;
}

function poolWith(made: FakePoolSession[]): SessionPool {
  return new SessionPool({
    scope: "channel",
    maxLiveSessions: 6,
    idleRecycleMs: 0,
    makeSession: (scope) => {
      const s = fakePoolSession(scope);
      made.push(s);
      return s;
    },
  });
}

test("pool cancelLiveTurn cancels a live directed turn for the matching channel", async () => {
  const made: FakePoolSession[] = [];
  const p = poolWith(made);
  await p.ask("chan-a", "hi"); // creates + starts chan-a's session
  const chanA = made[0]!;
  chanA.meta = { channelId: "chan-a", messageId: "m-1" }; // a directed turn is live on chan-a

  expect(p.cancelLiveTurn("chan-a", "superseded")).toBe(true);
  expect(chanA.cancels).toEqual(["superseded"]);
});

test("pool cancelLiveTurn never cancels a turn belonging to another channel or a system turn", async () => {
  const made: FakePoolSession[] = [];
  const p = poolWith(made);
  await p.ask("chan-a", "hi");
  const chanA = made[0]!;

  // A system/update turn (no channel meta) is never superseded.
  chanA.meta = null;
  expect(p.cancelLiveTurn("chan-a", "x")).toBe(false);

  // Belt-and-suspenders for collapsed modes: a live turn for a different channel is left alone.
  chanA.meta = { channelId: "chan-OTHER", messageId: "m-9" };
  expect(p.cancelLiveTurn("chan-a", "x")).toBe(false);

  // An unknown channel (no session) is a clean no-op.
  expect(p.cancelLiveTurn("chan-none", "x")).toBe(false);
  expect(chanA.cancels).toEqual([]);
});

// ── 2b. The multitasking policy: amendments cancel; independent asks queue ────────────────

test("a different author's message never cancels someone else's live turn", async () => {
  const made: FakePoolSession[] = [];
  const p = poolWith(made);
  await p.ask("chan-a", "hi");
  const chanA = made[0]!;
  chanA.meta = { channelId: "chan-a", messageId: "m-1", userId: "alice" };

  expect(p.cancelLiveTurn("chan-a", "x", { byUserId: "bob" })).toBe(false); // bob's ask is his own turn
  expect(p.cancelLiveTurn("chan-a", "amend", { byUserId: "alice" })).toBe(true); // alice amends alice
  expect(chanA.cancels).toEqual(["amend"]);
});

test("a turn that already invoked a tool is never cancelled — the new ask queues instead", async () => {
  const made: FakePoolSession[] = [];
  const p = poolWith(made);
  await p.ask("chan-a", "hi");
  const chanA = made[0]!;
  chanA.meta = { channelId: "chan-a", messageId: "m-1", userId: "alice" };
  chanA.toolUsed = true; // mid-dispatch: a browser task / recall / edit is in flight

  expect(p.cancelLiveTurn("chan-a", "x", { byUserId: "alice" })).toBe(false); // work survives
  chanA.toolUsed = false;
  expect(p.cancelLiveTurn("chan-a", "amend", { byUserId: "alice" })).toBe(true); // composing → amend
});

test("an ambient turn is always cancellable by a directed message, whoever sent it", async () => {
  const made: FakePoolSession[] = [];
  const p = poolWith(made);
  await p.ask("chan-a", "hi");
  const chanA = made[0]!;
  chanA.meta = { channelId: "chan-a", messageId: "m-amb", userId: "alice", ambient: true };
  chanA.toolUsed = true; // even a tool-using ambient turn yields to a person

  expect(p.cancelLiveTurn("chan-a", "person outranks interjection", { byUserId: "bob" })).toBe(true);
  expect(chanA.cancels).toEqual(["person outranks interjection"]);
});

test("without opts the legacy unconditional cancel is preserved", async () => {
  const made: FakePoolSession[] = [];
  const p = poolWith(made);
  await p.ask("chan-a", "hi");
  const chanA = made[0]!;
  chanA.meta = { channelId: "chan-a", messageId: "m-1", userId: "alice" };
  chanA.toolUsed = true;

  expect(p.cancelLiveTurn("chan-a", "legacy")).toBe(true);
});

// ── 3. Concierge.onMessage — supersede-and-answer end to end ──────────────────────────────

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
}

function conciergeHarness(session: Partial<ConciergeSession> & Record<string, unknown>) {
  tempBeckettDir();
  process.env.DISCORD_OWNER_ID = "111111111111111111";
  const posts: Post[] = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: { replyToMessageId?: string }) {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return `mid-${posts.length}`;
    },
  } as unknown as DiscordGateway;
  const concierge = new Concierge({ config, gateway, session: session as unknown as ConciergeSession });
  return { concierge, posts };
}

function msg(channelId: string, messageId: string, content = "wait, actually — do it the other way"): IncomingMessage {
  return {
    channelId,
    messageId,
    userId: "111111111111111111",
    displayName: "jason",
    content,
    mentionsBot: true,
    guildId: null,
    attachments: [],
  } as unknown as IncomingMessage;
}

test("a same-channel message mid-turn cancels the stale turn and answers the correction (issue #117)", async () => {
  // A stateful fake session: the first turn hangs as "still generating" until cancelLiveTurn
  // fires (resolving it as a silent pass); the amending turn answers normally.
  let live: { resolve: (o: DiscordTurnOutput) => void; meta: unknown } | null = null;
  let asks = 0;
  const session = {
    async start() {},
    async stop() {},
    queueDepth: () => (live ? 1 : 0),
    getCurrentMeta: () => live?.meta ?? null,
    cancelLiveTurn(_reason: string) {
      if (!live) return false;
      const l = live;
      live = null;
      l.resolve({ decision: "pass", message: null }); // silent pass — the stale reply never posts
      return true;
    },
    ask(_message: unknown, meta?: unknown): Promise<DiscordTurnOutput> {
      asks += 1;
      if (asks === 1) {
        return new Promise<DiscordTurnOutput>((resolve) => { live = { resolve, meta }; });
      }
      return Promise.resolve({ decision: "send", message: "amended answer" });
    },
  };
  const { concierge, posts } = conciergeHarness(session);

  const first = concierge.onMessage(msg("chan-1", "m-1"));
  await new Promise((r) => setTimeout(r, 20)); // let the first turn reach ask() and go live
  expect(live).not.toBeNull();

  await concierge.onMessage(msg("chan-1", "m-2")); // the correction supersedes the stale turn
  await first;

  // Exactly one post — the correction's answer. The stale first turn posted nothing.
  expect(posts.map((p) => p.text)).toEqual(["amended answer"]);
  expect(posts[0]!.replyTo).toBe("m-2");
  expect(asks).toBe(2);
});

test("a lone mention on an idle channel is answered normally (no interruption path)", async () => {
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the answer" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null, // nothing live → cancelLiveTurn is a no-op
  });
  await concierge.onMessage(msg("chan-1", "m-1"));
  expect(posts.map((p) => p.text)).toEqual(["the answer"]);
  expect(posts[0]!.replyTo).toBe("m-1");
});

// ── 5. issue #138 — only an AMENDING message supersedes a live answer ──────────────────────
//
// The #117 interrupt cancelled on same-user-same-channel alone. Under a burst of banter that
// killed three real answers with nothing said. The gate is now: the follow-up must plausibly
// AMEND the ask (messagePlausiblyAmends). Banter falls through and the live answer survives; a
// real correction still cancels, and a cancelled turn now posts one short line instead of muteness.

test("messagePlausiblyAmends: banter is not an amendment; a correction or a question is", () => {
  // The room's banter from the incident — short and flat — must read as "not an amendment".
  for (const banter of ["wat da fuk", "lmaooooo", "fish", "lol", "same", "brb"]) {
    expect(messagePlausiblyAmends(banter)).toBe(false);
  }
  // A genuine redirect (long enough) or anything question-shaped is an amendment.
  for (const amend of ["do it the other way", "actually make it python", "wait — which repo?", "no?"]) {
    expect(messagePlausiblyAmends(amend)).toBe(true);
  }
});

test("same-author BANTER mid-turn does not cancel the live answer (issue #138)", async () => {
  // The live turn hangs as "still generating"; a short banter follow-up arrives from the same
  // author. It must NOT reach the session's cancelLiveTurn, and the real answer must still land.
  let live: { resolve: (o: DiscordTurnOutput) => void; meta: unknown } | null = null;
  let asks = 0;
  let cancelCalls = 0;
  const session = {
    async start() {},
    async stop() {},
    queueDepth: () => (asks > 1 ? 1 : 0),
    getCurrentMeta: () => live?.meta ?? null,
    liveTurnToolUse: () => false, // still composing — the case #117 used to kill
    cancelLiveTurn(_reason: string) {
      cancelCalls += 1; // the pool's amend gate should short-circuit before ever calling this
      if (!live) return false;
      const l = live;
      live = null;
      l.resolve({ decision: "pass", message: null });
      return true;
    },
    ask(_message: unknown, meta?: unknown): Promise<DiscordTurnOutput> {
      asks += 1;
      if (asks === 1) return new Promise<DiscordTurnOutput>((resolve) => { live = { resolve, meta }; });
      // The banter's own turn: the model chooses to stay quiet (a pass), so no banter reply posts.
      return Promise.resolve({ decision: "pass", message: null });
    },
  };
  const { concierge, posts } = conciergeHarness(session);

  const first = concierge.onMessage(msg("chan-1", "m-1", "how do I wire the deploy tunnel?"));
  await new Promise((r) => setTimeout(r, 20));
  expect(live).not.toBeNull();

  await concierge.onMessage(msg("chan-1", "m-2", "lmaooooo")); // pure banter — restates nothing

  expect(cancelCalls).toBe(0); // the amend gate refused before the session was ever asked to cancel
  expect(live).not.toBeNull(); // the real answer's turn is still in flight, unharmed

  live!.resolve({ decision: "send", message: "the real answer" });
  await first;

  // The live answer survived; the banter posted nothing of its own.
  expect(posts.map((p) => p.text)).toEqual(["the real answer"]);
  expect(posts[0]!.replyTo).toBe("m-1");
});

test("a cancelled turn posts one short line instead of resolving to silent muteness (issue #138)", async () => {
  // A real amendment cancels the live turn. cancelLiveTurn resolves it as a silent pass but tags
  // the meta as superseded (as the real session does) — the daemon then posts one short line for
  // the drop, and the amending message answers separately.
  let live: { resolve: (o: DiscordTurnOutput) => void; meta: { superseded?: boolean } } | null = null;
  let asks = 0;
  const session = {
    async start() {},
    async stop() {},
    queueDepth: () => (asks > 1 ? 1 : 0),
    getCurrentMeta: () => live?.meta ?? null,
    liveTurnToolUse: () => false,
    cancelLiveTurn(_reason: string) {
      if (!live) return false;
      const l = live;
      l.meta.superseded = true; // the real ConciergeSession tags the killed turn's meta
      live = null;
      l.resolve({ decision: "pass", message: null }); // silent on the OUTPUT, no stale half-answer
      return true;
    },
    ask(_message: unknown, meta?: unknown): Promise<DiscordTurnOutput> {
      asks += 1;
      if (asks === 1) {
        return new Promise<DiscordTurnOutput>((resolve) => {
          live = { resolve, meta: meta as { superseded?: boolean } };
        });
      }
      return Promise.resolve({ decision: "send", message: "amended answer" });
    },
  };
  const { concierge, posts } = conciergeHarness(session);

  const first = concierge.onMessage(msg("chan-1", "m-1", "how do I wire the deploy tunnel?"));
  await new Promise((r) => setTimeout(r, 20));
  expect(live).not.toBeNull();

  await concierge.onMessage(msg("chan-1", "m-2")); // the amending correction supersedes
  await first;

  const texts = posts.map((p) => p.text);
  // Exactly one short "dropped that" line (replying to the killed question) plus the amended answer.
  expect(texts).toContain("amended answer");
  expect(texts).toHaveLength(2);
  const notice = posts.find((p) => p.text !== "amended answer")!;
  expect(notice.replyTo).toBe("m-1"); // the drop is announced against the question it dropped
  expect(notice.text.length).toBeLessThan(120); // one SHORT line, not a stale paragraph
});

// ── 4. mid-flow injection — the third path beside cancel and queue ────────────────────────
//
// Once a live turn has invoked a tool (liveTurnToolUse() true), cancelLiveTurn's own gate
// refuses to kill it (session-pool.ts's tool-use branch) — that part is pinned above (line 183).
// What happens to the same-author follow-up NEXT is new: it used to just queue silently for the
// whole rest of the tool-heavy arc (the owner's complaint). It should now fold into the live
// turn via injectLiveTurn instead, and post nothing of its own.

test("a same-author message after tool-use folds into the live turn via injectLiveTurn — no second ask, no queue", async () => {
  let live: { resolve: (o: DiscordTurnOutput) => void; meta: unknown } | null = null;
  let asks = 0;
  const injections: string[] = [];
  const session = {
    async start() {},
    async stop() {},
    // Mirrors the real session's turnQueue.length: only a SECOND ask() would ever populate it.
    queueDepth: () => (asks > 1 ? 1 : 0),
    getCurrentMeta: () => live?.meta ?? null,
    liveTurnToolUse: () => live !== null, // already doing work — the tool-use branch, not composing
    injectIntoLiveTurn: (text: string) => {
      injections.push(text);
      return "injected" as const;
    },
    ask(_message: unknown, meta?: unknown): Promise<DiscordTurnOutput> {
      asks += 1;
      if (asks === 1) {
        return new Promise<DiscordTurnOutput>((resolve) => {
          live = { resolve, meta };
        });
      }
      return Promise.resolve({ decision: "send", message: "should never post — no second ask expected" });
    },
    // Deliberately no cancelLiveTurn: liveTurnToolUse()===true makes the pool's own gate return
    // false before it would ever be reached, so a fake that threw on it would still pass — this
    // omission asserts that by construction instead.
  };
  const { concierge, posts } = conciergeHarness(session);

  const first = concierge.onMessage(msg("chan-1", "m-1"));
  await new Promise((r) => setTimeout(r, 20)); // let the first turn reach ask() and go live
  expect(live).not.toBeNull();

  await concierge.onMessage(msg("chan-1", "m-2")); // same author, same channel, mid-flow follow-up

  expect(asks).toBe(1); // no second turn started
  expect(session.queueDepth()).toBe(0); // and nothing queued behind the live one either
  expect(injections).toHaveLength(1);
  expect(injections[0]).toContain("[mid-flow:");
  expect(injections[0]).toContain("msg:m-2");
  expect(posts).toEqual([]); // the injected message itself posts nothing of its own

  live!.resolve({ decision: "send", message: "folded-in answer" });
  await first;
  expect(posts.map((p) => p.text)).toEqual(["folded-in answer"]); // one coherent reply, not two
});

test("a different author's message, or one on a different channel, after tool-use still queues exactly as today", async () => {
  let live: { resolve: (o: DiscordTurnOutput) => void; meta: unknown } | null = null;
  let asks = 0;
  const injections: string[] = [];
  const session = {
    async start() {},
    async stop() {},
    queueDepth: () => (asks > 1 ? 1 : 0),
    getCurrentMeta: () => live?.meta ?? null,
    liveTurnToolUse: () => live !== null,
    injectIntoLiveTurn: (text: string) => {
      injections.push(text);
      return "injected" as const;
    },
    ask(_message: unknown, meta?: unknown): Promise<DiscordTurnOutput> {
      asks += 1;
      if (asks === 1) {
        return new Promise<DiscordTurnOutput>((resolve) => {
          live = { resolve, meta };
        });
      }
      return Promise.resolve({ decision: "send", message: `queued answer ${asks}` });
    },
  };
  const { concierge, posts } = conciergeHarness(session);
  // Bob needs real access (member), or he's denied as an outsider before ever reaching the
  // interrupt/inject logic this test exercises — that would prove nothing about the gate.
  grantAccess(join(process.env.BECKETT_DIR!, "access.txt"), "222222222222222222", "111111111111111111");

  const first = concierge.onMessage(msg("chan-1", "m-1"));
  await new Promise((r) => setTimeout(r, 20));
  expect(live).not.toBeNull();

  // A different author in the SAME channel: cross-author hazard closed by scope, not injection.
  const bobMsg = { ...msg("chan-1", "m-2"), userId: "222222222222222222" } as unknown as IncomingMessage;
  await concierge.onMessage(bobMsg);

  live!.resolve({ decision: "send", message: "original answer" });
  await first;

  expect(asks).toBe(2); // the second author's message ran its own turn, exactly as today
  expect(injections).toEqual([]); // injectLiveTurn's eligibility gate refused — never reached the session
  expect(posts.map((p) => p.text).sort()).toEqual(["original answer", "queued answer 2"]);
});

// ── 4b. the injected message's watermark commits when its turn FINISHES, not at injection ──
//
// Marking it seen at injection time claimed an absorption nothing had proven: the line only
// reaches the model at the next turn boundary, so a turn that died (or never consumed it) left a
// message that was both unanswered AND invisible to every later turn's unseen window. The commit
// now waits for the consuming turn's result. channel-context.ts's markSeen stays monotonic per
// (channelId, sessionId) because the two commits still land out of order: the live turn's own
// watermark was computed BEFORE the injected message existed. Real ChannelContextStore, real dir.

function sharedContextHarness(session: Partial<ConciergeSession> & Record<string, unknown>) {
  tempBeckettDir();
  process.env.DISCORD_OWNER_ID = "111111111111111111";
  const config = validateConfig({});
  const posts: Post[] = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: { replyToMessageId?: string }) {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return `mid-${posts.length}`;
    },
  } as unknown as DiscordGateway;
  const concierge = new Concierge({ config, gateway, session: session as unknown as ConciergeSession });
  return { concierge, posts };
}

function shMsg(channelId: string, messageId: string, userId = "111111111111111111"): IncomingMessage {
  return {
    channelId,
    messageId,
    userId,
    authorDisplayName: "jason",
    content: `content of ${messageId}`,
    mentionsBot: true,
    authorIsBot: false,
    guildId: null,
    createdAt: Date.now(),
    attachments: [],
    repliedToId: null,
  } as unknown as IncomingMessage;
}

test("a successful injection commits the watermark only once its consuming turn completes", async () => {
  let live: { resolve: (o: DiscordTurnOutput) => void; meta: unknown } | null = null;
  let asks = 0;
  const session = {
    async start() {},
    async stop() {},
    queueDepth: () => (asks > 1 ? 1 : 0),
    getCurrentMeta: () => live?.meta ?? null,
    liveTurnToolUse: () => live !== null,
    currentSessionId: () => "sid-1",
    injectIntoLiveTurn: (_text: string) => "injected" as const,
    ask(_message: unknown, meta?: unknown): Promise<DiscordTurnOutput> {
      asks += 1;
      if (asks === 1) {
        return new Promise<DiscordTurnOutput>((resolve) => {
          live = { resolve, meta };
        });
      }
      return Promise.resolve({ decision: "send", message: "n/a — a second ask means the test is wrong" });
    },
  };
  const { concierge } = sharedContextHarness(session);

  const first = concierge.onMessage(shMsg("chan-1", "m-1"));
  await new Promise((r) => setTimeout(r, 20));
  expect(live).not.toBeNull();

  await concierge.onMessage(shMsg("chan-1", "m-2")); // folds in via injectLiveTurn

  // A fresh store over the SAME channelsDir (restart-survival pattern, channel-context.test.ts).
  const openStore = () =>
    createChannelContextStore({
      channelsDir: join(process.env.BECKETT_DIR!, "channels"),
      maxEntriesPerChannel: 500,
      maxAgeHours: 999_999,
      logger: quietLog,
    });
  // Mid-flight: nothing has absorbed m-2 yet, so it is still unseen — a turn that died here would
  // leave it in the window for the next one instead of hiding it.
  expect(openStore().takeUnseen("chan-1", "sid-1").map((e) => e.messageId)).toEqual(["m-1", "m-2"]);

  live!.resolve({ decision: "send", message: "done" });
  await first;
  expect(asks).toBe(1); // the live turn's own eventual watermark commit never started a second ask
  // The consuming turn finished, so the injected message's own id is the watermark now — committed
  // AFTER the turn's older, pre-injection mark, which monotonic markSeen keeps from regressing it.
  // (Beckett's own reply lands in the record after the watermark, so filter to the human lines.)
  expect(
    openStore()
      .takeUnseen("chan-1", "sid-1")
      .filter((e) => e.kind === "user")
      .map((e) => e.messageId),
  ).toEqual([]);
});
