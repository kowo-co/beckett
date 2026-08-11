/**
 * OPS-80 §9.3 — per-channel concierge sessions, exercised through {@link Concierge.onMessage} and
 * the control bus. Pins the properties the pool exists for: two channels' turns run CONCURRENTLY
 * (no cross-channel queueing), each channel gets its own persistent session (DMs included — the
 * structural fix for model-side DM bleed), reply-claim correlation stays channel-true when several
 * turns are live at once, daemon-origin updates stay on SYSTEM_SCOPE while replying to their
 * destination via CLI, and each channel's shared-context watermark keys to ITS session's id.
 * Harness conventions copied from shared-context-turn.test.ts (tmpdir BECKETT_DIR, access.txt,
 * fake gateway, validateConfig) with a per-scope session FACTORY instead of one fixed session.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import { validateConfig } from "../config.ts";
import type { IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { Run } from "../run/types.ts";
import type { QuickRun } from "../quick/index.ts";

const CHAN_A = "1097283746520174592";
const CHAN_B = "1097283746520174599";
const OWNER = "999888777666555444";
const MEMBER = "333333333333333333";

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

function msg(id: string, content: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: id,
    userId: MEMBER,
    authorDisplayName: "Jason",
    channelId: CHAN_A,
    guildId: "guild-1",
    content,
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: Date.now(),
    attachments: [],
    ...over,
  };
}

/** A per-scope scripted session: every ask records, and resolves only when the test says so. */
interface ScriptedSession {
  scope: string;
  asks: { message: TurnMessage; meta: unknown }[];
  meta: unknown;
  finish: (reply: string) => void;
  sessionId: string;
}

function harness(opts: { deferAsks?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-multisession-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = OWNER;
  writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");

  const sessions: ScriptedSession[] = [];
  const posts: { channelId: string; text: string; replyTo?: string }[] = [];

  const sessionFactory = (scope: string): ConciergeSession => {
    let resolveTurn: ((reply: string) => void) | null = null;
    const scripted: ScriptedSession = {
      scope,
      asks: [],
      meta: null,
      sessionId: `sid-${scope}`,
      finish: (reply: string) => {
        const r = resolveTurn;
        resolveTurn = null;
        scripted.meta = null;
        r?.(reply);
      },
    };
    sessions.push(scripted);
    const fake = {
      start: async () => {},
      stop: async () => {},
      ask: (message: TurnMessage, meta?: unknown) => {
        scripted.asks.push({ message, meta });
        if (!opts.deferAsks) return Promise.resolve(`reply-from-${scope}`);
        scripted.meta = meta ?? null;
        return new Promise<string>((resolve) => {
          resolveTurn = resolve;
        });
      },
      queueDepth: () => 0,
      currentSessionId: () => scripted.sessionId,
      getCurrentMeta: () => scripted.meta,
      stats: () => ({ scope }),
      requestReload: () => {},
      recycle: () => {},
      hasLiveChild: () => true,
      busToken: () => `tok-${scope}`,
    };
    return fake as unknown as ConciergeSession;
  };

  const gateway = {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async (channelId: string, text: string, o?: { replyToMessageId?: string }) => {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return `posted-${posts.length}`;
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;

  const config = validateConfig({});
  const concierge = new Concierge({ config, sessionFactory, gateway });
  const sessionFor = (scope: string) => sessions.find((s) => s.scope === scope);
  return { concierge, sessions, posts, sessionFor, dir };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Await until each named channel's turn has gone live (its session recorded an `ask`). buildTurn's
 * shared-context prefix now primes the #73 semantic index before it can score cross-channel context
 * (issue #74), so a turn goes live a few macrotasks after `onMessage` rather than within a single
 * `tick()`. In production nothing observes a turn before its session's child starts on `ask`, so
 * this only tightens the test's barrier — the concurrency/claiming properties below are unchanged.
 */
async function whenLive(h: ReturnType<typeof harness>, ...channelIds: string[]): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (channelIds.every((c) => (h.sessionFor(c)?.asks.length ?? 0) >= 1)) return;
    await tick();
  }
  throw new Error(`turns never went live for ${channelIds.join(", ")}`);
}

test("mentions in two channels run concurrently on their own sessions and reply to their own channels", async () => {
  const h = harness({ deferAsks: true });
  const turnA = h.concierge.onMessage(msg("m-a", "how goes channel a?", { channelId: CHAN_A }));
  const turnB = h.concierge.onMessage(msg("m-b", "and channel b?", { channelId: CHAN_B }));
  await whenLive(h, CHAN_A, CHAN_B);

  // BOTH turns are in flight at once — the single-session era would have queued B behind A.
  const a = h.sessionFor(CHAN_A)!;
  const b = h.sessionFor(CHAN_B)!;
  expect(a.asks).toHaveLength(1);
  expect(b.asks).toHaveLength(1);

  // Resolve B FIRST: its reply posts while A is still thinking — no head-of-line blocking.
  b.finish("b is great");
  await turnB;
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]).toEqual({ channelId: CHAN_B, text: "b is great", replyTo: "m-b" });

  a.finish("a is fine too");
  await turnA;
  expect(h.posts[1]).toEqual({ channelId: CHAN_A, text: "a is fine too", replyTo: "m-a" });
});

test("a DM gets its own session, separate from any guild channel's", async () => {
  const h = harness();
  await h.concierge.onMessage(msg("m-dm", "psst, just us", { channelId: "3097", guildId: null }));
  await h.concierge.onMessage(msg("m-g", "public question", { channelId: CHAN_A }));
  expect(h.sessionFor("3097")!.asks).toHaveLength(1);
  expect(h.sessionFor(CHAN_A)!.asks).toHaveLength(1);
  expect(h.sessions).toHaveLength(2);
});

test("discord.reply claims the turn in ITS channel even with two turns live", async () => {
  const h = harness({ deferAsks: true });
  const turnA = h.concierge.onMessage(msg("m-a", "channel a asks", { channelId: CHAN_A }));
  const turnB = h.concierge.onMessage(msg("m-b", "channel b asks", { channelId: CHAN_B }));
  await whenLive(h, CHAN_A, CHAN_B);

  // The model answering channel B replies via the CLI while A's turn is ALSO live.
  const res = await h.concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: CHAN_B, text: "cli reply for b" },
  });
  expect(res.ok).toBeTrue();
  expect(h.posts).toHaveLength(1);
  // Claimed B's turn: posted as a native reply to B's message, not A's.
  expect(h.posts[0]!.channelId).toBe(CHAN_B);
  expect(h.posts[0]!.replyTo).toBe("m-b");

  // B's turn text is suppressed (already replied via CLI); A's auto-post still fires.
  h.sessionFor(CHAN_B)!.finish("unused draft");
  await turnB;
  expect(h.posts).toHaveLength(1);
  h.sessionFor(CHAN_A)!.finish("a's answer");
  await turnA;
  expect(h.posts[2] ?? h.posts[1]).toEqual({ channelId: CHAN_A, text: "a's answer", replyTo: "m-a" });
});

test("proactivity set auto stays owner-gated when several turns are live (no channel match → denied)", async () => {
  const h = harness({ deferAsks: true });
  void h.concierge.onMessage(msg("m-a", "owner here", { channelId: CHAN_A, userId: OWNER }));
  void h.concierge.onMessage(msg("m-b", "member here", { channelId: CHAN_B }));
  await whenLive(h, CHAN_A, CHAN_B);

  // Two live turns, target channel has no live turn → ambiguous → denied (never guesses).
  const denied = await h.concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: "7777", mode: "auto" },
  });
  expect(denied.ok).toBeFalse();
  expect(denied.error).toContain("owner-only");

  // Owner's own live channel as the target → the claimant is the owner's turn → allowed.
  const allowed = await h.concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: CHAN_A, mode: "auto" },
  });
  expect(allowed.ok).toBeTrue();
  h.sessionFor(CHAN_A)!.finish("");
  h.sessionFor(CHAN_B)!.finish("");
});

test("a cross-channel reply carrying its issuer token never claims the target channel's live turn", async () => {
  const h = harness({ deferAsks: true });
  const turnA = h.concierge.onMessage(msg("m-a", "channel a asks", { channelId: CHAN_A }));
  const turnB = h.concierge.onMessage(msg("m-b", "channel b asks", { channelId: CHAN_B }));
  await whenLive(h, CHAN_A, CHAN_B);

  // A's turn cross-posts into B ("let #b know…") while B's own mention turn is live. The issuer
  // token resolves the op to A's turn — B's turn is untouched.
  const res = await h.concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: CHAN_B, text: "fyi from a's turn" },
    token: `tok-${CHAN_A}`,
  });
  expect(res.ok).toBeTrue();
  // Posted plainly — NOT as a native reply to B's mention (that would read as B's answer).
  expect(h.posts[0]!.channelId).toBe(CHAN_B);
  expect(h.posts[0]!.replyTo).toBeUndefined();

  // B's turn was not marked replied: its real answer still auto-posts when it finishes.
  h.sessionFor(CHAN_B)!.finish("b's real answer");
  await turnB;
  const bPost = h.posts.find((p) => p.text === "b's real answer");
  expect(bPost).toEqual({ channelId: CHAN_B, text: "b's real answer", replyTo: "m-b" });
  h.sessionFor(CHAN_A)!.finish("");
  await turnA;
});

test("owner-gated ops are authorized by the ISSUING turn's speaker, not the target channel's", async () => {
  const h = harness({ deferAsks: true });
  void h.concierge.onMessage(msg("m-a", "owner here", { channelId: CHAN_A, userId: OWNER }));
  void h.concierge.onMessage(msg("m-b", "member here", { channelId: CHAN_B }));
  await whenLive(h, CHAN_A, CHAN_B);

  // The member's turn (in B) targets the owner's channel A: pre-token, channel-first correlation
  // let A's live owner turn authorize it — the confused deputy. The token pins it to B's turn.
  const denied = await h.concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: CHAN_A, mode: "auto" },
    token: `tok-${CHAN_B}`,
  });
  expect(denied.ok).toBeFalse();
  expect(denied.error).toContain("owner-only");

  // The owner's own turn can arm ANY channel — authority rides the issuer, not the target.
  const allowed = await h.concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: "424242424242424242", mode: "auto" },
    token: `tok-${CHAN_A}`,
  });
  expect(allowed.ok).toBeTrue();

  // A forged/stale token authorizes nothing.
  const forged = await h.concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: CHAN_A, mode: "auto" },
    token: "tok-not-a-session",
  });
  expect(forged.ok).toBeFalse();
  h.sessionFor(CHAN_A)!.finish("");
  h.sessionFor(CHAN_B)!.finish("");
});

test("tokenless correlation never falls back to a live turn in a DIFFERENT channel", async () => {
  const h = harness({ deferAsks: true });
  void h.concierge.onMessage(msg("m-a", "owner speaking", { channelId: CHAN_A, userId: OWNER }));
  await whenLive(h, CHAN_A);

  // Sole live turn is the owner's in A, but the target is another channel: deny, never guess —
  // pre-fix the sole-live-turn fallback would have let A's owner turn authorize this.
  const denied = await h.concierge.onBusRequest({
    cmd: "proactivity.set",
    args: { channelId: "424242424242424242", mode: "auto" },
  });
  expect(denied.ok).toBeFalse();
  expect(denied.error).toContain("owner-only");
  h.sessionFor(CHAN_A)!.finish("");
});

test("run updates run on the system session, grouped per destination channel", async () => {
  const h = harness();
  const run = (id: string, channel: string): Run =>
    ({
      id,
      slug: id,
      title: `work ${id}`,
      prompt: "",
      channelId: channel,
      taskRef: null,
      state: "cancelled",
      cast: null,
      repo: null,
      prUrl: null,
      error: null,
    }) as unknown as Run;

  h.concierge.notify([
    { kind: "state_changed", run: run("run-1", CHAN_A), from: "implementing", to: "cancelled" },
    { kind: "state_changed", run: run("run-2", CHAN_A), from: "implementing", to: "cancelled" },
    { kind: "state_changed", run: run("run-3", CHAN_B), from: "implementing", to: "cancelled" },
  ]);
  await tick();
  await tick();

  const system = h.sessionFor("system")!;
  // A's two updates fold into one system turn and B's gets another; neither human channel gets
  // daemon chatter in its conversation transcript.
  expect(system.asks).toHaveLength(2);
  expect(String(system.asks[0]!.message)).toContain("run-1");
  expect(String(system.asks[0]!.message)).toContain("run-2");
  expect(String(system.asks[1]!.message)).toContain("run-3");
  expect(h.sessionFor(CHAN_A)).toBeUndefined();
  expect(h.sessionFor(CHAN_B)).toBeUndefined();
});

test("email, unstamped quick results, and boot warm-up use the dedicated system scope", async () => {
  const h = harness();
  await h.concierge.start();
  const system = h.sessionFor("system")!;
  expect(system).toBeDefined(); // boot warm-up did not create the ops-channel session
  expect(h.sessionFor("1520658476974735490")).toBeUndefined();

  await h.concierge.notifyIncomingEmail({
    from: "sender@example.com",
    subject: "A subject",
    snippet: "A preview",
    messageId: "mail-1",
  });
  const unstamped = {
    runId: "quick-1",
    agent: "quick-code",
    task: "check it",
    channelId: null,
    requesterId: null,
    startedAt: 0,
    finishedAt: 1,
    state: "done",
    result: "all clear",
    detached: true,
  } satisfies QuickRun;
  await h.concierge.notifyQuickResult(unstamped);
  await tick();

  expect(system.asks).toHaveLength(2);
  expect(String(system.asks[0]!.message)).toContain("incoming email");
  expect(String(system.asks[0]!.message)).toContain("discord reply --channel 1520658476974735490");
  expect(String(system.asks[1]!.message)).toContain("quick-agent result");
  expect(h.sessionFor(CHAN_A)).toBeUndefined();
  await h.concierge.stop();
});

test("first per-channel boot migrates the legacy global session file to the system scope", () => {
  const h = harness();
  const migrate = (scope: string) =>
    (h.concierge as unknown as { migrateLegacySessionState(s: string): void }).migrateLegacySessionState(scope);
  const home = "system";
  writeFileSync(
    join(h.dir, "concierge-session.json"),
    JSON.stringify({ sessionId: "legacy-sid", handoff: "old note" }),
    "utf8",
  );

  migrate(home);
  // Yesterday's all-channels conversation resumes in the isolated system scope…
  const migrated = JSON.parse(readFileSync(join(h.dir, "concierge-sessions", `${home}.json`), "utf8"));
  expect(migrated.sessionId).toBe("legacy-sid");
  expect(migrated.handoff).toBe("old note");
  // …and the legacy file is gone, so the shim can never run twice.
  expect(existsSync(join(h.dir, "concierge-session.json"))).toBeFalse();
});

test("migration is a no-op once the per-scope state dir exists (already-migrated boot)", () => {
  const h = harness();
  mkdirSync(join(h.dir, "concierge-sessions"), { recursive: true });
  writeFileSync(join(h.dir, "concierge-session.json"), JSON.stringify({ sessionId: "stale" }), "utf8");
  (h.concierge as unknown as { migrateLegacySessionState(s: string): void }).migrateLegacySessionState(
    "system",
  );
  expect(existsSync(join(h.dir, "concierge-session.json"))).toBeTrue();
  expect(existsSync(join(h.dir, "concierge-sessions", "system.json"))).toBeFalse();
});

test("each channel's shared-context watermark keys to that channel's own sessionId", async () => {
  const h = harness();
  // Ambient lines land in both channels' stored windows.
  await h.concierge.onMessage(msg("amb-a", "background chatter a", { channelId: CHAN_A, mentionsBot: false }));
  await h.concierge.onMessage(msg("amb-b", "background chatter b", { channelId: CHAN_B, mentionsBot: false }));
  // A mention in A consumes A's unseen window (keyed to sid-A); B's stays unconsumed.
  await h.concierge.onMessage(msg("m-a", "so?", { channelId: CHAN_A }));
  const turnA = String(h.sessionFor(CHAN_A)!.asks[0]!.message);
  expect(turnA).toContain("background chatter a");
  expect(turnA).not.toContain("background chatter b");
  // B's first mention still sees B's backlog — untouched by A's consumption.
  await h.concierge.onMessage(msg("m-b", "and here?", { channelId: CHAN_B }));
  const turnB = String(h.sessionFor(CHAN_B)!.asks[0]!.message);
  expect(turnB).toContain("background chatter b");
  expect(turnB).not.toContain("background chatter a");
});
