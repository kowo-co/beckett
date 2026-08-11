/**
 * OPS-68 / T4 — Ambient interjection end-to-end harness (offline).
 *
 * Drives fake normalized Discord gateway messages through the real Concierge +
 * AmbientCoordinator pipeline with injected fakes for Discord, triage, and the
 * model session. No live model, Discord, or tracker calls are made.
 *
 * Coverage:
 *   code gate (enabled master + single channel suggest override, default off)
 *     → burst buffer/debounce
 *     → stubbed triage
 *     → ambient candidate turn
 *     → plain offer post + persisted offer ledger
 *     → consent follow-up bypassing triage
 *     → CLI ack + ticket.filed lifecycle signal + offer cleared
 *     → PASS/no-post path
 *
 * Run:
 *   bun scripts/e2e/ambient-interjection-e2e.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { Concierge, type ConciergeSession, type TurnMessage } from "../../src/concierge/index.ts";
import { validateConfig } from "../../src/config.ts";
import type { AmbientClock } from "../../src/concierge/ambient.ts";
import type { TriageFn, TriageVerdict } from "../../src/concierge/triage.ts";
import type {
  DiscordGateway,
  DiscordMessageEditPayload,
  IncomingMessage,
  ReplyOptions,
  ThreadCreated,
} from "../../src/types.ts";

const repoRoot = join(import.meta.dir, "../..");
const CHAN = "1520658476974735490";
const OTHER_CHAN = "2000000000000000000";
const MEMBER = "333333333333333333";
const GUILD = "guild-e2e";

class FakeClock implements AmbientClock {
  t = Date.now();
  private next = 1;
  private readonly timers = new Map<number, { at: number; cb: () => void }>();

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
    while (true) {
      const due = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > target) break;
      this.t = due[1].at;
      this.timers.delete(due[0]);
      due[1].cb();
    }
    this.t = target;
  }
}

interface PostRecord {
  id: string;
  channelId: string;
  text: string;
  replyTo?: string;
}

class FakeGateway implements DiscordGateway {
  readonly posts: PostRecord[] = [];
  readonly typings: string[] = [];
  private handler: ((m: IncomingMessage) => void | Promise<void>) | null = null;
  private threadHandler: ((t: ThreadCreated) => void | Promise<void>) | null = null;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async post(channelId: string, content: string, opts?: ReplyOptions): Promise<string> {
    const id = `post-${this.posts.length + 1}`;
    this.posts.push({ id, channelId, text: content, replyTo: opts?.replyToMessageId });
    return id;
  }

  async editMessage(channelId: string, messageId: string, payload: DiscordMessageEditPayload): Promise<void> {
    const post = this.posts.find((item) => item.channelId === channelId && item.id === messageId);
    if (post && payload.content !== undefined) post.text = payload.content;
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const index = this.posts.findIndex((post) => post.channelId === channelId && post.id === messageId);
    if (index >= 0) this.posts.splice(index, 1);
  }

  async fetchMessageAuthorId(channelId: string, messageId: string): Promise<string | null> {
    const post = this.posts.find((p) => p.channelId === channelId && p.id === messageId);
    return post ? this.botUserId() : null;
  }

  botUserId(): string {
    return "fake-bot";
  }

  async sendTyping(channelId: string): Promise<void> {
    this.typings.push(channelId);
  }

  onMessage(cb: (m: IncomingMessage) => void | Promise<void>): void {
    this.handler = cb;
  }

  onThreadCreate(cb: (t: ThreadCreated) => void | Promise<void>): void {
    this.threadHandler = cb;
  }

  isConnected(): boolean {
    return true;
  }

  lastEventAgeMs(): number {
    return 0;
  }

  async emit(m: IncomingMessage): Promise<void> {
    if (!this.handler) throw new Error("fake gateway has no message handler");
    await this.handler(m);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) throw new Error(`${message}: missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
}

async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function msg(id: string, content: string, createdAt: number, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: id,
    userId: MEMBER,
    authorDisplayName: "Jason",
    channelId: CHAN,
    guildId: GUILD,
    content,
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: false,
    createdAt,
    attachments: [],
    ...over,
  };
}

function readLedger(dir: string): { offers?: unknown[] } {
  const file = join(dir, "pending-offers.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as { offers?: unknown[] };
}

function verifyDeployDefaults(): void {
  const configFile = join(repoRoot, "deploy/config.toml.example");
  const parsed = parse(readFileSync(configFile, "utf8")) as {
    proactivity?: { enabled?: unknown; default_mode?: unknown; channels?: unknown };
  };
  assert(parsed.proactivity, "deploy/config.toml.example must include [proactivity]");
  assertEqual(parsed.proactivity.enabled, false, "deploy config must ship proactivity.enabled=false");
  assertEqual(parsed.proactivity.default_mode, "off", "deploy config must ship proactivity.default_mode=off");
  assert(
    parsed.proactivity.channels === undefined ||
      (typeof parsed.proactivity.channels === "object" && parsed.proactivity.channels !== null && Object.keys(parsed.proactivity.channels).length === 0),
    "deploy config must not enable any [proactivity.channels] override",
  );

  const defaults = validateConfig({});
  assertEqual(defaults.proactivity.enabled, false, "schema default must keep proactivity disabled");
  assertEqual(defaults.proactivity.default_mode, "off", "schema default mode must be off");
  assertEqual(Object.keys(defaults.proactivity.channels).length, 0, "schema defaults must not enable channels");
}

async function main(): Promise<void> {
  verifyDeployDefaults();

  const dir = mkdtempSync(join(tmpdir(), "beckett-ambient-e2e-"));
  const savedDir = process.env.BECKETT_DIR;
  const savedOwner = process.env.DISCORD_OWNER_ID;

  try {
    process.env.BECKETT_DIR = dir;
    delete process.env.DISCORD_OWNER_ID;
    writeFileSync(join(dir, "access.txt"), `${MEMBER}\n`, "utf8");

    const clock = new FakeClock();
    const gateway = new FakeGateway();
    const frames: TurnMessage[] = [];
    const deployedRuns: { runId: string; title: string; channelId: string }[] = [];
    let concierge!: Concierge;
    let triageCalls = 0;

    const yes: TriageVerdict = {
      interject: true,
      kind: "feature-wish",
      confidence: 0.91,
      reason: "concrete CSV export wish",
      addressee: "group",
    };

    const triage: TriageFn = async (burst, transcript, meta) => {
      triageCalls++;
      assert(meta, "triage meta should include a channel id");
      assertEqual(meta.channelId, CHAN, "triage should only run for the suggested fake channel");
      assertEqual(burst.length, 2, "debounce should collapse the two-message burst into one triage call");
      assert(transcript.some((m) => m.content.includes("CSV")), "triage transcript should include the buffered wish");
      return yes;
    };

    const session = {
      start: async () => {},
      stop: async () => {},
      queueDepth: () => 0,
      ask: async (turn: TurnMessage) => {
        frames.push(turn);
        const text = typeof turn === "string" ? turn : JSON.stringify(turn);
        if (text.includes("SYSTEM (ambient follow-up)")) {
          assertIncludes(text, "want me to file CSV export?", "consent frame should include the offer text");
          assertIncludes(text, "sure, go for it", "consent frame should include the consent message");

          const ack = await concierge.onBusRequest({
            cmd: "discord.reply",
            args: { channelId: CHAN, text: "On it — filing CSV export now." },
          });
          assert(ack.ok, `discord.reply bus ack failed: ${ack.error ?? "unknown"}`);

          deployedRuns.push({ runId: "run-20260810-csv-export", title: "Add CSV export", channelId: CHAN });
          return "Deployed run-20260810-csv-export.";
        }
        if (text.includes("wish the dashboard had PDF export")) return "PASS";
        return "I can do that — want me to file CSV export?";
      },
    } as unknown as ConciergeSession;

    const config = validateConfig({
      proactivity: {
        enabled: true,
        default_mode: "off",
        channels: { [CHAN]: "suggest" },
        burst_quiet_secs: 2,
        channel_cooldown_secs: 0,
        offer_ttl_secs: 60,
        // This harness asserts a fresh post-consent candidate re-enters triage; disable the
        // production engaged-conversation grace window so that assertion is deterministic.
        engaged_window_secs: 0,
      },
    });

    concierge = new Concierge({ config, session, gateway, ambientTriage: triage, ambientClock: clock });
    gateway.onMessage((m) => concierge.onMessage(m));

    console.log("→ code gate: default off, one fake channel in suggest mode");
    await gateway.emit(msg("off-1", "wish the other channel had XML export", clock.now(), { channelId: OTHER_CHAN }));
    clock.advance(2_000);
    await drain();
    assertEqual(triageCalls, 0, "default_mode=off should prevent triage in non-overridden channels");

    console.log("→ ambient offer pipeline: burst/debounce → triage → offer ledger");
    await gateway.emit(msg("m1", "the export flow is painful", clock.now()));
    await gateway.emit(msg("m2", "wish it gave me a CSV", clock.now() + 500));
    clock.advance(1_999);
    await drain();
    assertEqual(triageCalls, 0, "debounce should not flush before the quiet window elapses");
    clock.advance(1);
    await drain();

    assertEqual(triageCalls, 1, "stubbed triage should run once after quiet");
    assertEqual(frames.length, 1, "ambient candidate should run one session turn");
    assertIncludes(frames[0] as string, "SYSTEM (ambient — nobody addressed you", "candidate frame should be ambient");
    assertIncludes(frames[0] as string, "wish it gave me a CSV", "candidate frame should carry transcript context");
    assertEqual(gateway.typings.length, 0, "ambient turns must not send typing indicators");
    assertEqual(gateway.posts.length, 1, "candidate offer should post exactly once");
    assertEqual(gateway.posts[0]?.replyTo, undefined, "ambient offer should be a plain post, not a native reply");
    assertEqual(gateway.posts[0]?.text, "I can do that — want me to file CSV export?", "candidate offer text mismatch");

    const ledgerAfterOffer = readLedger(dir);
    assertEqual(ledgerAfterOffer.offers?.length ?? 0, 1, "offer ledger should persist one pending offer");
    assert(JSON.stringify(ledgerAfterOffer).includes("concrete CSV export wish"), "offer ledger should carry triage summary");

    console.log("→ consent lifecycle: follow-up bypasses triage, acks, files ticket, clears offer");
    await gateway.emit(msg("m3", "sure, go for it", clock.now() + 3_000));
    await drain();

    assertEqual(triageCalls, 1, "consent follow-up should bypass triage");
    assertEqual(frames.length, 2, "consent should run one follow-up session turn");
    assertIncludes(frames[1] as string, "SYSTEM (ambient follow-up)", "second frame should be consent follow-up");
    const parentPosts = gateway.posts.filter((p) => p.channelId === CHAN);
    assertEqual(parentPosts.length, 2, "consent should post exactly one parent-channel ack via the CLI path");
    assertEqual(parentPosts[1]?.text, "On it — filing CSV export now.", "consent ack mismatch");
    assertEqual(deployedRuns.length, 1, "consent should deploy one run");
    assertEqual(deployedRuns[0]?.runId, "run-20260810-csv-export", "deployed run id mismatch");
    await drain();
    // Coworker-as-a-Service: deploying work spawns NO bot threads and posts nothing beyond the
    // ack — the worker firehose goes to the private journal, not a user-facing Discord thread.
    assertEqual(gateway.posts.length, parentPosts.length, "run lifecycle should post nothing outside the parent channel");
    assertEqual(readLedger(dir).offers?.length ?? 0, 0, "offer ledger should clear after accepted consent");

    console.log("→ PASS/no-post path");
    await gateway.emit(msg("m4", "wish the dashboard had PDF export", clock.now() + 6_000));
    await gateway.emit(msg("m5", "but maybe never mind", clock.now() + 6_500));
    clock.advance(2_000);
    await drain();

    assertEqual(triageCalls, 2, "fresh ambient candidate should triage after accepted offer clears");
    assertEqual(frames.length, 3, "PASS candidate should still run the ambient turn");
    assertIncludes(frames[2] as string, "SYSTEM (ambient — nobody addressed you", "PASS path should be an ambient candidate");
    assertEqual(gateway.posts.length, 2, "PASS should suppress posting");
    assertEqual(readLedger(dir).offers?.length ?? 0, 0, "PASS should not create a pending offer");

    console.log("\n✅ AMBIENT INTERJECTION E2E PASSED (offline; no live model/Discord/tracker)");
  } finally {
    if (savedDir === undefined) delete process.env.BECKETT_DIR;
    else process.env.BECKETT_DIR = savedDir;
    if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
    else process.env.DISCORD_OWNER_ID = savedOwner;
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
