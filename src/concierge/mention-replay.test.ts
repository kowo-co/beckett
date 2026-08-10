/**
 * Issue #3 — a mention whose turn died is REPLAYED, not re-asked.
 *
 * The bug, from the 2026-08-04 daemon journal: three directed mentions in one evening got
 * "that turn died on me, ask again." and nothing else. All three came through one branch —
 * `concierge result missing valid Discord delivery output; suppressing`, `rawOutput:"<absent>"` —
 * with two distinct causes behind it: a turn that answered in plain assistant text and never
 * emitted the delivery object (01:39:30Z, 01:43:36Z — one assistant block, no tools), and a turn
 * whose `claude` child was SIGTERMed by a deploy three seconds before the new pid came up
 * (04:56:17Z — fifteen assistant blocks). Boot reconciliation could not save the third: it recovers
 * messages after the channel-store cursor, and that cursor advances at CAPTURE time, so a mention
 * that WAS received and then died mid-turn is behind it and invisible forever.
 *
 * These pin the two halves of the fix:
 *   1. in-turn  — a lost delivery object re-drives once before anyone hears the canned line
 *   2. across a restart — an unanswered mention stays owed and is replayed after boot, exactly
 *      once, and never on top of an answer that already went out
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, ConciergeSession, TURN_DIED_LINE } from "./index.ts";
import { validateConfig } from "../config.ts";
import { OWED_MENTION_MAX_REPLAYS, type OwedMention } from "./owed-mentions.ts";
import type { Config, IncomingMessage, ReplyContextMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1520986792373911622";
const USER = "111111111111111111";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {}, harness: { claude: { bin: "claude", extra_flags: [] } } } as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const savedStartup = process.env.BECKETT_STARTUP_CHANNEL_ID;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  if (savedStartup === undefined) delete process.env.BECKETT_STARTUP_CHANNEL_ID;
  else process.env.BECKETT_STARTUP_CHANNEL_ID = savedStartup;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function tempBeckettDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-replay-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = USER;
  process.env.BECKETT_STARTUP_CHANNEL_ID = "disabled";
  return dir;
}

function mention(messageId = "m-1", content = "is the v6.23 deploy done?"): IncomingMessage {
  return {
    messageId,
    channelId: CHAN,
    userId: USER,
    guildId: null,
    content,
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: Date.now(),
    attachments: [],
  } as unknown as IncomingMessage;
}

// ── 1. in-turn: a lost delivery object re-drives instead of settling ───────────────────────
//
// Drives the ACTUAL runTurn/driveTurn/onResult/onExit machinery with a scripted child, exactly
// like the issue-#98 re-drive tests next door — only the subprocess is faked.

interface SessionGuts {
  sessionId: string;
  child: unknown;
  initSeen: boolean;
  lastLaunchWasResume: boolean;
  launch(isResume: boolean): Promise<void>;
  writeUserLine(content: unknown): void;
  handleLine(line: string, from: unknown): void;
  onExit(code: number, exited: unknown): Promise<void>;
  runTurn(message: unknown, meta?: unknown): Promise<unknown>;
}

function scriptedSession(
  script: (attempt: number, child: { kill(): void }, s: SessionGuts) => void,
): { session: SessionGuts; launches: boolean[]; writes: unknown[] } {
  const session = new ConciergeSession({ config, logger: quietLog }) as unknown as SessionGuts;
  const launches: boolean[] = [];
  const writes: unknown[] = [];
  session.child = null;
  session.launch = async (isResume: boolean) => {
    session.initSeen = false;
    session.lastLaunchWasResume = isResume;
    session.child = { kill() {} } as unknown;
    launches.push(isResume);
  };
  session.writeUserLine = (content: unknown) => {
    writes.push(content);
    const attempt = writes.length;
    const child = session.child as { kill(): void };
    queueMicrotask(() => script(attempt, child, session));
  };
  return { session, launches, writes };
}

/** The meta a direct @mention rides — what tells a failing turn it owes someone a word. */
function directMeta(messageId = "m-1") {
  return { channelId: CHAN, messageId, userId: USER, isOwner: true, repliedViaCli: false, ackMessageId: null };
}

test("a result with no delivery object re-drives the same turn instead of posting the canned line", async () => {
  tempBeckettDir();
  const { session, writes } = scriptedSession((attempt, child, s) => {
    s.handleLine(JSON.stringify({ type: "system", subtype: "init" }), child);
    if (attempt === 1) {
      // The 01:39Z shape: the model wrote its answer as plain assistant text and never emitted
      // `structured_output`. That text is suppressed (it can carry deliberation) — and until now
      // that suppression WAS the canned line.
      s.handleLine(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "yeah, v6.23 is live" }] } }),
        child,
      );
      s.handleLine(JSON.stringify({ type: "result" }), child);
    } else {
      s.handleLine(
        JSON.stringify({ type: "result", structured_output: { decision: "send", voice_check: "", message: "yeah — v6.23 went out at 21:56" } }),
        child,
      );
    }
  });

  const output = await session.runTurn("is the v6.23 deploy done?", directMeta());

  expect(output).toEqual({ decision: "send", message: "yeah — v6.23 went out at 21:56" });
  expect(writes).toHaveLength(2); // asked once more, on the same warm transcript
  // The re-drive tells the model its previous attempt's tool calls may have LANDED, so a turn
  // that had already filed a ticket doesn't file it twice.
  expect(String(writes[1])).toContain("check before repeating them");
  expect(String(writes[1])).toContain("is the v6.23 deploy done?");
});

test("the canned line survives only where the re-drive ALSO comes back empty (bounded, never a loop)", async () => {
  tempBeckettDir();
  const { session, writes } = scriptedSession((_attempt, child, s) => {
    s.handleLine(JSON.stringify({ type: "system", subtype: "init" }), child);
    s.handleLine(JSON.stringify({ type: "result" }), child);
  });

  const output = await session.runTurn("is the v6.23 deploy done?", directMeta());

  // Two consecutive turns produced nothing deliverable — the "genuinely unreplayable" case.
  expect(output).toEqual({ decision: "send", message: TURN_DIED_LINE });
  expect(writes).toHaveLength(2);
});

test("an AMBIENT turn is never re-driven — a failed interjection stays invisible and cheap", async () => {
  tempBeckettDir();
  const { session, writes } = scriptedSession((_attempt, child, s) => {
    s.handleLine(JSON.stringify({ type: "system", subtype: "init" }), child);
    s.handleLine(JSON.stringify({ type: "result" }), child);
  });

  const output = await session.runTurn("someone said something", { ...directMeta(), ambient: true });

  expect(output).toEqual({ decision: "pass", message: null });
  expect(writes).toHaveLength(1); // no second generation spent on a turn nobody asked for
});

test("a child killed mid-turn FAILS the ask (so the ledger keeps the debt) — it never settles quietly", async () => {
  tempBeckettDir();
  const { session } = scriptedSession((_attempt, child, s) => {
    s.handleLine(JSON.stringify({ type: "system", subtype: "init" }), child);
    s.handleLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "checking the tags…" }] } }),
      child,
    );
    // The 04:56Z shape: the deploy's SIGTERM reaches the child mid-turn.
    void s.onExit(143, child);
  });

  // The turn rejects rather than resolving to a canned line: that rejection is what leaves the
  // mention owed in `onMessage`'s catch, which is what the boot replay below picks up.
  await expect(session.runTurn("is the v6.23 deploy done?", directMeta())).rejects.toThrow("mid-turn");
});

// ── 2. across a restart: the mention is answered after boot, without the human re-asking ───

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
}

interface Harness {
  concierge: Concierge;
  posts: Post[];
  asks: string[];
  dir: string;
}

function harness(opts: {
  dir?: string;
  /** How the fake session answers a turn. `hang` never resolves until the daemon stops. */
  answer?: "hang" | string;
  replyContext?: ReplyContextMessage[] | null;
  /** A real (validated) config, which brings the durable shared-context store up with it. */
  sharedContext?: boolean;
}): Harness {
  const dir = opts.dir ?? tempBeckettDir();
  if (opts.dir) {
    tmpDirs.includes(dir) || tmpDirs.push(dir);
    process.env.BECKETT_DIR = dir;
    process.env.DISCORD_OWNER_ID = USER;
    process.env.BECKETT_STARTUP_CHANNEL_ID = "disabled";
  }
  const posts: Post[] = [];
  const asks: string[] = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: { replyToMessageId?: string }) {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return `mid-${posts.length}`;
    },
    ...(opts.replyContext !== undefined
      ? { async fetchMessageContext() { return opts.replyContext; } }
      : {}),
  } as unknown as DiscordGateway;

  const hanging: ((err: Error) => void)[] = [];
  const session = {
    async start() {},
    async stop() {
      // What SessionPool.stopAll does to an in-flight turn on shutdown.
      for (const reject of hanging.splice(0)) reject(new Error("concierge session stopped"));
    },
    queueDepth: () => 0,
    getCurrentMeta: () => null,
    ask(message: unknown) {
      asks.push(String(message));
      if (opts.answer === "hang") {
        return new Promise((_resolve, reject) => hanging.push(reject));
      }
      return Promise.resolve({ decision: "send", message: opts.answer ?? "the answer" });
    },
  } as unknown as ConciergeSession;

  const turnConfig = opts.sharedContext ? validateConfig({}) : config;
  return { concierge: new Concierge({ config: turnConfig, gateway, session, logger: quietLog }), posts, asks, dir };
}

function ledger(dir: string): OwedMention[] {
  const file = join(dir, "concierge-owed-mentions.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as OwedMention[]) : [];
}

function writeLedger(dir: string, entries: Partial<OwedMention>[]): void {
  writeFileSync(
    join(dir, "concierge-owed-mentions.json"),
    JSON.stringify(
      entries.map((e) => ({
        messageId: e.message?.messageId ?? "m-1",
        channelId: CHAN,
        message: mention(e.message?.messageId ?? "m-1"),
        claimedAt: Date.now(),
        replays: 0,
        phase: "queued",
        ...e,
      })),
    ),
  );
}

test("a mention whose turn dies with the daemon is left owed — not answered with an apology", async () => {
  const dying = harness({ answer: "hang" });
  const inFlight = dying.concierge.onMessage(mention());
  await Bun.sleep(20); // let the turn reach ask() and go live

  await dying.concierge.stop(); // the deploy's SIGTERM
  await inFlight;

  // Nothing was said to the person — no "ask again", no "something broke". The debt is on disk.
  expect(dying.posts).toEqual([]);
  const owed = ledger(dying.dir);
  expect(owed.map((e) => e.messageId)).toEqual(["m-1"]);
  expect(owed[0]!.phase).toBe("queued");
});

test("the next boot answers it automatically — the restart-window case, end to end", async () => {
  const dying = harness({ answer: "hang" });
  const inFlight = dying.concierge.onMessage(mention());
  await Bun.sleep(20);
  await dying.concierge.stop();
  await inFlight;

  // A new daemon over the same beckett dir: exactly what a deploy produces.
  const booted = harness({ dir: dying.dir, answer: "yeah — v6.23 went out at 21:56" });
  await booted.concierge.start();
  await (booted.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  try {
    // Answered, as a native reply to the ORIGINAL message, with nobody having re-asked.
    expect(booted.posts).toEqual([
      { channelId: CHAN, text: "yeah — v6.23 went out at 21:56", replyTo: "m-1" },
    ]);
    // And the session was told it is answering late, so it can say so in its own voice rather
    // than the daemon bolting a canned frame onto its words.
    expect(booted.asks).toHaveLength(1);
    expect(booted.asks[0]).toContain("arrived before your last restart");
    expect(booted.asks[0]).toContain("is the v6.23 deploy done?");
    // Debt paid — a third boot replays nothing.
    expect(ledger(booted.dir)).toEqual([]);
  } finally {
    await booted.concierge.stop();
  }
});

test("a replayed mention is answered ONCE — a third boot is silent", async () => {
  const dying = harness({ answer: "hang" });
  const inFlight = dying.concierge.onMessage(mention());
  await Bun.sleep(20);
  await dying.concierge.stop();
  await inFlight;

  const first = harness({ dir: dying.dir, answer: "the answer" });
  await first.concierge.start();
  await (first.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  await first.concierge.stop();

  const second = harness({ dir: dying.dir, answer: "the answer" });
  await second.concierge.start();
  await (second.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  try {
    expect(second.posts).toEqual([]);
    expect(second.asks).toEqual([]);
  } finally {
    await second.concierge.stop();
  }
});

test("a mention that was MID-POST when the daemon died is verified against Discord, not re-answered", async () => {
  const dir = tempBeckettDir();
  writeLedger(dir, [{ phase: "delivering" }]);
  // Discord says one of Beckett's own messages already follows the mention: the post landed and
  // only the settle was lost. Answering again would be the double-reply this whole path guards.
  const booted = harness({
    dir,
    answer: "must not post",
    replyContext: [
      { messageId: "m-1", ts: 1, authorId: USER, authorName: "jason", content: "is the v6.23 deploy done?", isBeckett: false, isTarget: true },
      { messageId: "mid-0", ts: 2, authorId: "bot", authorName: "beckett", content: "yeah, it's live", isBeckett: true, isTarget: false },
    ],
  });
  await booted.concierge.start();
  await (booted.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  try {
    expect(booted.posts).toEqual([]);
    expect(booted.asks).toEqual([]);
    expect(ledger(dir)).toEqual([]); // settled, not left to try again next boot
  } finally {
    await booted.concierge.stop();
  }
});

test("mid-post but Discord shows nothing after it: the reply never landed, so it IS replayed", async () => {
  const dir = tempBeckettDir();
  writeLedger(dir, [{ phase: "delivering" }]);
  const booted = harness({
    dir,
    answer: "yeah — it's live",
    replyContext: [
      { messageId: "m-1", ts: 1, authorId: USER, authorName: "jason", content: "is the v6.23 deploy done?", isBeckett: false, isTarget: true },
    ],
  });
  await booted.concierge.start();
  await (booted.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  try {
    expect(booted.posts.map((p) => p.text)).toEqual(["yeah — it's live"]);
  } finally {
    await booted.concierge.stop();
  }
});

test("a mid-post mention is left alone when Discord cannot be asked (silence beats a double answer)", async () => {
  const dir = tempBeckettDir();
  writeLedger(dir, [{ phase: "delivering" }]);
  // No fetchMessageContext on this gateway at all: unverifiable. The bias is deliberate — one
  // missed answer costs a re-ask, one duplicated answer costs trust in every answer.
  const booted = harness({ dir, answer: "must not post" });
  await booted.concierge.start();
  await (booted.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  try {
    expect(booted.posts).toEqual([]);
    expect(booted.asks).toEqual([]);
  } finally {
    await booted.concierge.stop();
  }
});

test("past its replay budget the honest line IS the answer — once, and the debt is closed", async () => {
  const dir = tempBeckettDir();
  writeLedger(dir, [{ replays: OWED_MENTION_MAX_REPLAYS }]);
  const booted = harness({ dir, answer: "must not run" });
  await booted.concierge.start();
  await (booted.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  try {
    expect(booted.posts).toEqual([{ channelId: CHAN, text: TURN_DIED_LINE, replyTo: "m-1" }]);
    expect(booted.asks).toEqual([]);
    expect(ledger(dir)).toEqual([]);
  } finally {
    await booted.concierge.stop();
  }
});

test("a replay does not re-capture the message into the shared record", async () => {
  const dying = harness({ answer: "hang", sharedContext: true });
  writeFileSync(join(dying.dir, "access.txt"), `${USER}\n`, "utf8");
  const inFlight = dying.concierge.onMessage(mention());
  await Bun.sleep(20);
  await dying.concierge.stop();
  await inFlight;

  const booted = harness({ dir: dying.dir, answer: "yeah — it's live", sharedContext: true });
  await booted.concierge.start();
  await (booted.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  try {
    expect(booted.posts.map((p) => p.text)).toEqual(["yeah — it's live"]);
    // Capture happens BEFORE the turn, so the run that received this message already recorded it.
    // The store appends blind, so re-capturing on replay would leave the room's shared history
    // holding the same line twice — forever, and visible in every later window.
    const rows = readFileSync(join(dying.dir, "channels", `${CHAN}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { messageId: string; kind: string });
    expect(rows.filter((r) => r.messageId === "m-1")).toHaveLength(1);
    // Beckett's own replayed answer DOES join the record — that half really is new.
    expect(rows.filter((r) => r.kind === "beckett")).toHaveLength(1);
  } finally {
    await booted.concierge.stop();
  }
});

test("a replay that ends in one of onMessage's early exits closes the debt instead of looping", async () => {
  const dir = tempBeckettDir();
  // The author lost access while the daemon was down: this replay hits the outsider gate and
  // returns long before any turn. Left owed it would replay every boot, then eventually post
  // "ask again" to someone who is no longer owed anything at all.
  writeLedger(dir, [{}]);
  delete process.env.DISCORD_OWNER_ID;
  writeFileSync(join(dir, "access.txt"), "", "utf8");
  const booted = harness({ dir, answer: "must not run", sharedContext: true });
  process.env.DISCORD_OWNER_ID = "999999999999999999";
  await booted.concierge.start();
  await (booted.concierge as unknown as { replayDone: Promise<void> }).replayDone;
  try {
    expect(booted.asks).toEqual([]);
    // The outsider gate really did fire (it posts its own denial) — this is the early exit,
    // not a replay that silently did nothing.
    expect(booted.posts).toHaveLength(1);
    expect(booted.posts[0]!.text).not.toBe(TURN_DIED_LINE);
    expect(ledger(dir)).toEqual([]);
  } finally {
    await booted.concierge.stop();
  }
});

test("an ordinary answered mention leaves nothing owed (the ledger does not grow on the happy path)", async () => {
  const h = harness({ answer: "the answer" });
  await h.concierge.onMessage(mention());

  expect(h.posts.map((p) => p.text)).toEqual(["the answer"]);
  expect(ledger(h.dir)).toEqual([]);
});

test("a live-daemon failure still gets a word NOW — the ledger is for restarts, not for stalling", async () => {
  const dir = tempBeckettDir();
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
  const session = {
    async start() {},
    async stop() {},
    queueDepth: () => 0,
    getCurrentMeta: () => null,
    ask: () => Promise.reject(new Error("claude exited (code 1) mid-turn")),
  } as unknown as ConciergeSession;

  await new Concierge({ config, gateway, session, logger: quietLog }).onMessage(mention());

  expect(posts.map((p) => p.text)).toEqual(["Something broke on my end — try me again in a sec."]);
  // Settled: a boot replay hours from now is not the answer to a failure the daemon survived.
  expect(ledger(dir)).toEqual([]);
});
