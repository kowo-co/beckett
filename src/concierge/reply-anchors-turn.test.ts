/**
 * Issues #232 and #235, exercised through {@link Concierge.onMessage}.
 *
 *   - #235: a burst that spans two people, answered per person, delivers per person — each answer
 *     posts as a native reply to the message it actually answers. Everything ambiguous keeps the
 *     single delivery it has always had.
 *   - #235 (embeds): a settled link preview reaches the turn; a link with provably no preview says
 *     so, rather than leaving the turn to improvise "nothing came through on my end".
 *   - #232: the reply edge and the explicit @mention targets survive capture into the snapshot the
 *     ambient classifier scores.
 *
 * Harness copied from shared-context-turn.test.ts: tmpdir BECKETT_DIR, access.txt fixture, fake
 * session/gateway, validateConfig, injected FakeClock.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession, type TurnMessage } from "./index.ts";
import { validateConfig } from "../config.ts";
import type { AmbientClock } from "./ambient.ts";
import type { TriageFn, TriageMessage, TriageVerdict } from "./triage.ts";
import type { IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const CHAN = "1097283746520174592";
const RO = "222222222222222222";
const SSH = "444444444444444444";

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
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.t = due[1].at;
      this.timers.delete(due[0]);
      due[1].cb();
    }
    this.t = target;
  }
}

/** Flush enough microtask turns to drain the fire-and-forget triage → engage chain. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function msg(id: string, content: string, createdAt: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: id,
    userId: RO,
    authorDisplayName: "ro",
    channelId: CHAN,
    guildId: "guild-1",
    content,
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: false,
    createdAt,
    attachments: [],
    ...over,
  };
}

interface Harness {
  concierge: Concierge;
  asks: TurnMessage[];
  posts: { channelId: string; text: string; replyTo?: string; replyToUser?: string }[];
  triaged: { burst: TriageMessage[]; transcript: TriageMessage[] }[];
  clock: FakeClock;
}

function harness(opts: { reply?: string; config?: Parameters<typeof validateConfig>[0] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "beckett-reply-anchors-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  delete process.env.DISCORD_OWNER_ID;
  writeFileSync(join(dir, "access.txt"), `${RO}\n${SSH}\n`, "utf8");

  const asks: TurnMessage[] = [];
  const posts: Harness["posts"] = [];
  const triaged: Harness["triaged"] = [];

  const session = {
    start: async () => {},
    stop: async () => {},
    ask: async (m: TurnMessage) => {
      asks.push(m);
      return opts.reply ?? "ok";
    },
    queueDepth: () => 0,
    currentSessionId: () => "session-a",
  } as unknown as ConciergeSession;

  const gateway = {
    start: async () => {},
    stop: async () => {},
    onMessage: () => {},
    sendTyping: async () => {},
    post: async (
      channelId: string,
      text: string,
      o?: { replyToMessageId?: string; replyToUserId?: string },
    ) => {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId, replyToUser: o?.replyToUserId });
      return `posted-${posts.length}`;
    },
    isConnected: () => true,
    lastEventAgeMs: () => 0,
  } as unknown as DiscordGateway;

  const triage: TriageFn = async (burst, transcript) => {
    triaged.push({ burst, transcript });
    return { interject: false, kind: "none", confidence: 0, reason: "", addressee: "other" } as TriageVerdict;
  };

  const clock = new FakeClock();
  const concierge = new Concierge({
    config: validateConfig(opts.config ?? {}),
    session,
    gateway,
    ambientTriage: triage,
    ambientClock: clock,
  });
  return { concierge, asks, posts, triaged, clock };
}

function text(t: TurnMessage | undefined): string {
  expect(typeof t).toBe("string");
  return t as string;
}

// ── #235: per-addressee delivery anchors ─────────────────────────────────────────────────

test("a two-author burst answered per person posts each answer under the message it answers", async () => {
  // The prod shape: ro complains in the channel, SSH's @mention lands next, and ONE turn answers
  // both. Before this, everything hung off SSH's message and ro's answer read as a reply to SSH.
  const h = harness({
    reply:
      "ro: yeah, that backlog is mine — I'm clearing it tonight.\n\n" +
      "sshdev: that link 404s for me too, the doc moved to /guides.",
  });
  await h.concierge.onMessage(msg("m-ro", "this queue backlog is killing me", 0));
  await h.concierge.onMessage(
    msg("m-ssh", "@beckett what happened to this link?", 10, {
      userId: SSH,
      authorDisplayName: "sshdev",
      mentionsBot: true,
    }),
  );

  expect(h.posts).toEqual([
    {
      channelId: CHAN,
      text: "ro: yeah, that backlog is mine — I'm clearing it tonight.",
      replyTo: "m-ro",
      replyToUser: RO,
    },
    {
      channelId: CHAN,
      text: "sshdev: that link 404s for me too, the doc moved to /guides.",
      replyTo: "m-ssh",
      replyToUser: SSH,
    },
  ]);
});

test("both split answers join the shared record, so the next turn sees what was actually said", async () => {
  const h = harness({ reply: "ro: yours tonight.\n\nsshdev: the doc moved." });
  await h.concierge.onMessage(msg("m-ro", "queue backlog again", 0));
  await h.concierge.onMessage(
    msg("m-ssh", "@beckett link?", 10, { userId: SSH, authorDisplayName: "sshdev", mentionsBot: true }),
  );
  await h.concierge.onMessage(
    msg("m-ssh-2", "@beckett recap", 20, { userId: SSH, authorDisplayName: "sshdev", mentionsBot: true }),
  );
  const turn = text(h.asks[1]);
  expect(turn).toContain("beckett: ro: yours tonight.");
  expect(turn).toContain("beckett: sshdev: the doc moved.");
});

test("an answer whose opening belongs to nobody keeps its single delivery", async () => {
  // Conservative by design: leading text addressed to no one has no anchor of its own, and
  // guessing which of two people it belongs to is exactly the mis-pin this fixes.
  const h = harness({
    reply: "Same root cause, both of you.\n\nro: yours tonight.\n\nsshdev: doc moved to /guides.",
  });
  await h.concierge.onMessage(msg("m-ro", "queue backlog again", 0));
  await h.concierge.onMessage(
    msg("m-ssh", "@beckett link?", 10, { userId: SSH, authorDisplayName: "sshdev", mentionsBot: true }),
  );

  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]?.replyTo).toBe("m-ssh");
  expect(h.posts[0]?.text).toContain("Same root cause");
});

test("a single-author burst delivers exactly as it always did, however the answer is shaped", async () => {
  const h = harness({ reply: "ro: first part.\n\nro: second part." });
  await h.concierge.onMessage(msg("m-ro-1", "background line", 0));
  await h.concierge.onMessage(msg("m-ro-2", "@beckett so what now", 10, { mentionsBot: true }));

  expect(h.posts).toEqual([
    {
      channelId: CHAN,
      text: "ro: first part.\n\nro: second part.",
      replyTo: "m-ro-2",
      replyToUser: RO,
    },
  ]);
});

test("a stale window line is background context, never a reply anchor", async () => {
  const h = harness({ reply: "ro: yours tonight.\n\nsshdev: doc moved." });
  // ro's line is an hour old — answering it as a native reply would pin an answer under ancient
  // chatter, which reads worse than not pinning it at all.
  await h.concierge.onMessage(msg("m-ro", "queue backlog again", 0));
  await h.concierge.onMessage(
    msg("m-ssh", "@beckett link?", 3_600_000, {
      userId: SSH,
      authorDisplayName: "sshdev",
      mentionsBot: true,
    }),
  );
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]?.replyTo).toBe("m-ssh");
});

// ── #235: embed settle ───────────────────────────────────────────────────────────────────

test("a settled link preview reaches the turn as quoted third-party material", async () => {
  const h = harness();
  await h.concierge.onMessage(
    msg("m1", "@beckett what do you make of https://example.com/post", 0, {
      mentionsBot: true,
      embeds: [
        { title: "The post", url: "https://example.com/post", description: "a short summary" },
      ],
    }),
  );
  const turn = text(h.asks[0]);
  expect(turn).toContain("[Link preview 1");
  expect(turn).toContain("title: The post");
  expect(turn).toContain("url: https://example.com/post");
  expect(turn).toContain("description: a short summary");
});

test("a link Discord attached no preview to is stated as a fact, not improvised around", async () => {
  const h = harness();
  await h.concierge.onMessage(
    msg("m1", "@beckett thoughts on https://example.com/post", 0, { mentionsBot: true, embeds: [] }),
  );
  expect(text(h.asks[0])).toContain("Discord attached no preview");
});

test("a message nothing ever looked at keeps its exact pre-existing turn shape", async () => {
  const h = harness();
  await h.concierge.onMessage(msg("m1", "@beckett thoughts on https://example.com/post", 0, { mentionsBot: true }));
  const turn = text(h.asks[0]);
  expect(turn).not.toContain("link preview");
  expect(turn).not.toContain("Link preview");
});

// ── #232: the classifier's snapshot ──────────────────────────────────────────────────────

test("the reply edge and the @mention targets survive capture into the classifier's snapshot", async () => {
  const h = harness({
    config: { proactivity: { enabled: true, default_mode: "suggest", burst_quiet_secs: 2, channel_cooldown_secs: 0 } },
  });
  await h.concierge.onMessage(
    msg("m-ssh", "ro, were you working on the RO thing?", 0, {
      userId: SSH,
      authorDisplayName: "sshdev",
      mentionedUsers: [{ id: RO, name: "ro" }],
    }),
  );
  await h.concierge.onMessage(msg("m-ro", "hold on", 1_000, { repliedToId: "m-ssh" }));
  h.clock.advance(2_000);
  await drain();

  const scored = h.triaged.at(-1);
  const all = [...(scored?.transcript ?? []), ...(scored?.burst ?? [])];
  const question = all.find((m) => m.messageId === "m-ssh");
  const holdOn = all.find((m) => m.messageId === "m-ro");
  // Who sshdev addressed — the fact that turns "hold on" from a message to the room into a reply
  // aimed at ro, which is the read triage was getting wrong.
  expect(question?.mentions).toEqual([{ id: RO, name: "ro" }]);
  expect(holdOn?.repliedToId).toBe("m-ssh");
});
