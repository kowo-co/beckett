/**
 * The directed settle window, wired: `Concierge.onMessage` end to end on an injected clock.
 *
 * The core (directed-settle.test.ts) owns the timing arithmetic. This file owns the five things
 * the wiring can get wrong, in the order they would hurt:
 *
 *   1. OFF IS OFF — at the shipped default the directed path is the one that existed before this
 *      feature: the turn starts on the same tick, no timer is ever armed, and the composed prompt
 *      carries no preamble. Pinned as a characterization test against the same "lone mention on an
 *      idle channel" shape turn-interrupt.test.ts pins.
 *   2. The fold — two fragments become ONE turn, framed by the SAME coalesced-burst preamble a
 *      superseded queued turn already uses, replying to the newest message.
 *   3. The cap — a fast typist cannot hold their own answer past 2x the window.
 *   4. Passthrough — a different author (and a different channel) is never held or folded.
 *   5. Shutdown — a held message flushes into a real turn on stop() and is never dropped.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import { validateConfig } from "../config.ts";
import { grantAccess } from "../discord/access.ts";
import type { AmbientClock } from "./ambient.ts";
import type { IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { DiscordTurnOutput } from "./output.ts";

const OWNER = "111111111111111111";
const OTHER = "222222222222222222";

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

/** A clock whose timers only fire when this test says so — no wall-clock sleeps anywhere below. */
class FakeClock implements AmbientClock {
  t = 0;
  next = 1;
  timers = new Map<number, { at: number; cb: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, cb });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Move time forward and fire everything now due, oldest first. */
  advance(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.t) continue;
      this.timers.delete(id);
      timer.cb();
    }
  }
}

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
}

interface Harness {
  concierge: Concierge;
  clock: FakeClock;
  posts: Post[];
  asks: TurnMessage[];
  typing: string[];
  beckettDir: string;
}

function harness(settleMs: number): Harness {
  const dir = mkdtempSync(join(tmpdir(), "beckett-settle-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = OWNER;
  // A second real member, so the different-author case exercises the settle scope rather than
  // being turned away by the outsider gate before it ever gets there.
  grantAccess(join(dir, "access.txt"), OTHER, OWNER);

  const posts: Post[] = [];
  const asks: TurnMessage[] = [];
  const typing: string[] = [];
  const clock = new FakeClock();
  const session = {
    start: async () => {},
    stop: async () => {},
    queueDepth: () => 0,
    getCurrentMeta: () => null,
    ask: async (turn: TurnMessage): Promise<DiscordTurnOutput> => {
      asks.push(turn);
      return { decision: "send", message: `answer-${asks.length}` };
    },
  } as unknown as ConciergeSession;
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping(channelId: string) {
      typing.push(channelId);
    },
    async post(channelId: string, text: string, o?: { replyToMessageId?: string }) {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return `mid-${posts.length}`;
    },
  } as unknown as DiscordGateway;

  const config = validateConfig({ concierge: { directed_settle_ms: settleMs } });
  const concierge = new Concierge({ config, gateway, session, ambientClock: clock });
  return { concierge, clock, posts, asks, typing, beckettDir: dir };
}

function msg(channelId: string, messageId: string, content: string, userId = OWNER): IncomingMessage {
  return {
    channelId,
    messageId,
    userId,
    displayName: userId === OWNER ? "jason" : "sam",
    content,
    mentionsBot: true,
    guildId: null,
    attachments: [],
  } as unknown as IncomingMessage;
}

/**
 * What the owed-mention ledger still has on its books, read off disk — the same file the next
 * boot's replay reads. "Never dropped" is a claim about THIS file, so the test reads it rather
 * than a private field.
 */
function owedIds(h: Harness): string[] {
  const file = join(h.beckettDir, "concierge-owed-mentions.json");
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: { messageId?: string }[] } | unknown[];
  const entries = Array.isArray(raw) ? raw : (raw.entries ?? []);
  return (entries as { messageId?: string }[]).map((e) => e.messageId ?? "").filter(Boolean);
}

const text = (turn: TurnMessage): string =>
  typeof turn === "string" ? turn : turn.map((b) => ("text" in b ? b.text : "")).join("\n");

// ── 1. default OFF: the pre-feature path, unchanged ───────────────────────────────────────

test("with directed_settle_ms at its 0 default a lone mention answers on the same tick", async () => {
  const h = harness(0);
  await h.concierge.onMessage(msg("chan-1", "m-1", "how's the deploy looking?"));

  // Answered without the clock moving at all — no hold, no timer, nothing to advance.
  expect(h.asks).toHaveLength(1);
  expect(h.posts.map((p) => p.text)).toEqual(["answer-1"]);
  expect(h.posts[0]!.replyTo).toBe("m-1");
  expect(h.clock.timers.size).toBe(0);
  // And no burst preamble on the prompt: an ordinary turn's text is untouched.
  expect(text(h.asks[0]!)).toContain("how's the deploy looking?");
  expect(text(h.asks[0]!)).not.toContain("quick succession");
});

test("with the window OFF a same-author burst still takes the pre-feature path: a turn each", async () => {
  const h = harness(0);
  await h.concierge.onMessage(msg("chan-1", "m-1", "deploy the thing"));
  await h.concierge.onMessage(msg("chan-1", "m-2", "actually to staging first"));

  // Two messages, two turns, two replies — exactly what this path did before the settle window,
  // and the behavior the feature must not change until someone sets the key.
  expect(h.asks).toHaveLength(2);
  expect(h.posts.map((p) => p.replyTo)).toEqual(["m-1", "m-2"]);
  expect(h.clock.timers.size).toBe(0);
  for (const ask of h.asks) expect(text(ask)).not.toContain("quick succession");
});

// ── 2. the fold ───────────────────────────────────────────────────────────────────────────

test("two fragments inside the window become ONE turn, framed by the existing burst preamble", async () => {
  const h = harness(1_000);

  await h.concierge.onMessage(msg("chan-1", "m-1", "deploy the thing"));
  // Held: nothing asked, nothing posted — but the person can see typing, so the beat reads as
  // thinking rather than as being ignored.
  expect(h.asks).toHaveLength(0);
  expect(h.typing).toEqual(["chan-1"]);

  h.clock.t += 300;
  await h.concierge.onMessage(msg("chan-1", "m-2", "actually to staging first"));
  expect(h.asks).toHaveLength(0); // still held — the restart is the whole point

  h.clock.advance(1_000);
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  expect(h.asks).toHaveLength(1);
  const turn = text(h.asks[0]!);
  // The SAME renderer a superseded queued turn uses — not a second preamble format.
  expect(turn).toContain("quick succession");
  expect(turn).toContain("ONE thought");
  expect(turn).toContain("1. deploy the thing");
  expect(turn).toContain("2. actually to staging first");
  // One reply, on the newest message: that is the one the person is still looking at.
  expect(h.posts.map((p) => p.text)).toEqual(["answer-1"]);
  expect(h.posts[0]!.replyTo).toBe("m-2");
});

test("a plausible AMEND arriving during a hold folds too — there is no live turn to cancel", async () => {
  const h = harness(1_000);
  await h.concierge.onMessage(msg("chan-1", "m-1", "file a ticket for the login bug"));
  h.clock.t += 200;
  // Question-shaped, so messagePlausiblyAmends() is true. With the message still parked, the
  // cancel-and-amend path has nothing to cancel — this is simply the next fragment.
  await h.concierge.onMessage(msg("chan-1", "m-2", "wait — which repo?"));
  h.clock.advance(1_000);
  await new Promise((r) => setTimeout(r, 0));

  expect(h.asks).toHaveLength(1);
  const turn = text(h.asks[0]!);
  expect(turn).toContain("1. file a ticket for the login bug");
  expect(turn).toContain("2. wait — which repo?");
  // The amend note belongs to the cancel path; a hold never killed a turn, so it must not claim to.
  expect(turn).not.toContain("still stands");
});

test("three fragments all land in one turn, oldest first", async () => {
  const h = harness(1_000);
  await h.concierge.onMessage(msg("chan-1", "m-1", "one"));
  h.clock.t += 100;
  await h.concierge.onMessage(msg("chan-1", "m-2", "two"));
  h.clock.t += 100;
  await h.concierge.onMessage(msg("chan-1", "m-3", "three"));
  h.clock.advance(1_000);
  await new Promise((r) => setTimeout(r, 0));

  expect(h.asks).toHaveLength(1);
  const turn = text(h.asks[0]!);
  expect(turn.indexOf("1. one")).toBeLessThan(turn.indexOf("2. two"));
  expect(turn.indexOf("2. two")).toBeLessThan(turn.indexOf("3. three"));
  expect(h.posts[0]!.replyTo).toBe("m-3");
});

// ── 3. the cap ────────────────────────────────────────────────────────────────────────────

test("a fast typist cannot hold their own answer past 2x the window", async () => {
  const h = harness(1_000);
  await h.concierge.onMessage(msg("chan-1", "m-1", "first"));
  // A fragment every 400ms. Each restarts the window, so without the cap the turn would never
  // start; the cap fires it at t=2000 with everything said so far in it.
  for (let i = 2; i <= 8 && h.asks.length === 0; i++) {
    h.clock.t += 400;
    await h.concierge.onMessage(msg("chan-1", `m-${i}`, `fragment ${i}`));
    await new Promise((r) => setTimeout(r, 0));
  }

  expect(h.asks).toHaveLength(1);
  // t=400,800,1200,1600 extend; t=2000 is the ceiling → released on arrival, not on a timer.
  expect(h.clock.t).toBe(2_000);
  const turn = text(h.asks[0]!);
  expect(turn).toContain("1. first");
  expect(turn).toContain("6. fragment 6"); // m-2..m-6 all carried, none dropped
  expect(h.posts[0]!.replyTo).toBe("m-6");
  // The hold is gone: a further message starts its own fresh hold rather than joining a dead one.
  expect(h.clock.timers.size).toBe(0);
});

// ── 4. passthrough: someone else's message is never held by your burst ────────────────────

test("a different author in the same channel is never folded into someone else's burst", async () => {
  const h = harness(1_000);
  await h.concierge.onMessage(msg("chan-1", "m-1", "deploy the thing"));
  h.clock.t += 300;
  // Sam is not part of the owner's thought. His message opens a hold of HIS own — it neither joins
  // the owner's, nor restarts it, nor is answered by it.
  await h.concierge.onMessage(msg("chan-1", "m-2", "unrelated question from sam", OTHER));
  expect(h.asks).toHaveLength(0);

  // The owner's hold is still due at t=1000 — sam's message did not extend it by a millisecond.
  h.clock.advance(700);
  await new Promise((r) => setTimeout(r, 0));
  expect(h.asks).toHaveLength(1);
  expect(text(h.asks[0]!)).toContain("deploy the thing");
  expect(text(h.asks[0]!)).not.toContain("unrelated question from sam");
  expect(text(h.asks[0]!)).not.toContain("quick succession");
  expect(h.posts[0]!.replyTo).toBe("m-1");

  // Sam's own turn follows on his own schedule, answering only him.
  h.clock.advance(300);
  await new Promise((r) => setTimeout(r, 0));
  expect(h.asks).toHaveLength(2);
  expect(text(h.asks[1]!)).toContain("unrelated question from sam");
  expect(text(h.asks[1]!)).not.toContain("deploy the thing");
  expect(h.posts[1]!.replyTo).toBe("m-2");
});

test("the same author in a DIFFERENT channel gets a hold of their own, not a fold", async () => {
  const h = harness(1_000);
  await h.concierge.onMessage(msg("chan-1", "here", "about the deploy"));
  await h.concierge.onMessage(msg("chan-2", "there", "about the invoice"));
  expect(h.asks).toHaveLength(0);

  h.clock.advance(1_000);
  await new Promise((r) => setTimeout(r, 0));

  // Two separate conversations, two separate turns — never one merged prompt.
  expect(h.asks).toHaveLength(2);
  const bodies = h.asks.map(text);
  expect(bodies.some((b) => b.includes("about the deploy") && !b.includes("about the invoice"))).toBe(true);
  expect(bodies.some((b) => b.includes("about the invoice") && !b.includes("about the deploy"))).toBe(true);
  for (const body of bodies) expect(body).not.toContain("quick succession");
});

// ── 5. shutdown ───────────────────────────────────────────────────────────────────────────

test("a held message flushes into a turn on stop() and is left owed for the boot replay", async () => {
  const h = harness(1_000);
  await h.concierge.onMessage(msg("chan-1", "m-1", "one more thing before you go"));
  expect(h.asks).toHaveLength(0);
  expect(h.clock.timers.size).toBe(1);
  // Claimed at ARRIVAL, not at release: the ledger — not the timer — is what makes a held message
  // un-droppable, and it is already on the books while the hold is still running.
  expect(owedIds(h)).toEqual(["m-1"]);

  // The daemon goes down mid-hold. The timer will never fire, so stop() releases the hold itself;
  // the turn then loses its race with the closing session pool, which is the ordinary fate of any
  // directed turn in flight at shutdown — and the ordinary recovery applies.
  await h.concierge.stop();
  await new Promise((r) => setTimeout(r, 0));

  expect(h.clock.timers.size).toBe(0); // nothing left parked in a timer nobody will ever fire
  // Still owed → answered by the next boot's replay. NOT settled, and never silently dropped.
  expect(owedIds(h)).toEqual(["m-1"]);
});

test("stop() flushes every held channel and author, not just the first", async () => {
  const h = harness(1_000);
  await h.concierge.onMessage(msg("chan-1", "m-1", "owner in one"));
  await h.concierge.onMessage(msg("chan-2", "m-2", "owner in two"));
  await h.concierge.onMessage(msg("chan-1", "m-3", "sam in one", OTHER));
  expect(h.asks).toHaveLength(0);
  expect(h.clock.timers.size).toBe(3);

  await h.concierge.stop();
  await new Promise((r) => setTimeout(r, 0));

  expect(h.clock.timers.size).toBe(0);
  expect(owedIds(h).sort()).toEqual(["m-1", "m-2", "m-3"]);
});

test("a message folded into a hold is owed from ITS arrival too, not only the anchor", async () => {
  const h = harness(1_000);
  await h.concierge.onMessage(msg("chan-1", "m-1", "deploy the thing"));
  h.clock.t += 200;
  await h.concierge.onMessage(msg("chan-1", "m-2", "actually to staging first"));
  // Both fragments are on the books while still parked — a shutdown here loses neither.
  expect(owedIds(h).sort()).toEqual(["m-1", "m-2"]);

  h.clock.advance(1_000);
  await new Promise((r) => setTimeout(r, 0));

  // The one turn answered both, so both debts are settled by the single reply it posted.
  expect(h.posts).toHaveLength(1);
  expect(owedIds(h)).toEqual([]);
});

test("stop() with the window off has nothing to flush and no timers to clear", async () => {
  const h = harness(0);
  await h.concierge.onMessage(msg("chan-1", "m-1", "answered already"));
  expect(h.asks).toHaveLength(1);
  expect(owedIds(h)).toEqual([]); // answered, so settled — the pre-feature path exactly
  await h.concierge.stop();
  expect(h.asks).toHaveLength(1);
  expect(h.clock.timers.size).toBe(0);
});
