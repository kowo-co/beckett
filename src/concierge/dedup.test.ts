/**
 * Regression for the duplicate-Discord-message bug. On a direct @mention the Concierge has two
 * ways to reach the human: (a) the turn's return text, which `onMessage` auto-posts as a native
 * reply, and (b) running `beckett discord reply` from its Bash tool, which routes through
 * `onBusRequest`. The bug was both firing for ONE turn → the person got the same answer twice.
 * These pin the dedup: when the Concierge answers a live @mention via the CLI, that becomes THE
 * reply (native, once) and the auto-post is suppressed; when it doesn't, the auto-post is the reply.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, redactBrowserSecrets, type ConciergeSession } from "./index.ts";
import { callBus, ControlBusTimeoutError, serveBus } from "../shell/control-bus.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";
import type { BrowserRuntime } from "../browser/runtime.ts";
import type { BrowserAgent, BrowserAgentRun } from "../browser/agent.ts";

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
  files?: string[];
  singleMessage?: boolean;
  browserQuestion?: boolean;
  pingUserIds?: string[];
}

/**
 * Build a Concierge whose session, when it runs a turn, optionally simulates the Concierge
 * answering via `beckett discord reply` (the bus path) before returning its turn text.
 */
function harness(opts: {
  replyViaCli: boolean;
  turnText: string;
  cliText?: string;
  dir?: string;
  ownerId?: string;
  /** Override the shared module-level config (issue W3A — chilltext gate on/off coverage). */
  config?: Config;
  currentMeta?: {
    channelId: string;
    messageId: string;
    userId: string;
    isOwner: boolean;
    repliedViaCli: boolean;
    ackMessageId: string | null;
  };
  failPosts?: boolean | { remaining: number };
  failFilePosts?: { remaining: number };
  failDeletes?: boolean;
  postDelayMs?: number;
  browserOnAsk?: boolean;
  /**
   * When `false`, the simulated turn fires the CLI reply and does NOT wait for it to land before
   * returning its turn text — exactly like a model whose Bash tool call already got its result
   * (e.g. its own bus ack timed out) while the daemon is still sending. Defaults to `true` (the
   * ordinary, well-behaved shape every other test in this file exercises). The in-flight promise
   * is captured on the returned handle so a test can await it before asserting.
   */
  replyViaCliAwait?: boolean;
}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "beckett-dedup-"));
  if (!tmpDirs.includes(dir)) tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = opts.ownerId ?? USER;
  const posts: Post[] = [];
  const asks: string[] = [];
  const deletedMessages: { channelId: string; messageId: string }[] = [];
  let postAttempts = 0;
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: {
      replyToMessageId?: string;
      files?: string[];
      singleMessage?: boolean;
      browserQuestion?: boolean;
      pingUserIds?: string[];
    }) {
      postAttempts++;
      if (opts.postDelayMs) await Bun.sleep(opts.postDelayMs);
      if (o?.files?.length && opts.failFilePosts && opts.failFilePosts.remaining > 0) {
        opts.failFilePosts.remaining--;
        throw new Error("discord attachment rejected");
      }
      if (opts.failPosts === true) throw new Error("discord offline");
      if (typeof opts.failPosts === "object" && opts.failPosts.remaining > 0) {
        opts.failPosts.remaining--;
        throw new Error("discord offline");
      }
      posts.push({
        channelId,
        text,
        replyTo: o?.replyToMessageId,
        files: o?.files,
        pingUserIds: o?.pingUserIds,
        ...(o?.singleMessage !== undefined ? { singleMessage: o.singleMessage } : {}),
        ...(o?.browserQuestion !== undefined ? { browserQuestion: o.browserQuestion } : {}),
      });
      return `mid-${posts.length}`;
    },
    async deleteMessage(channelId: string, messageId: string) {
      if (opts.failDeletes) throw new Error("missing Manage Messages");
      deletedMessages.push({ channelId, messageId });
    },
  } as unknown as DiscordGateway;

  // Late-bound so the fake session can call back into the Concierge's bus handler mid-turn.
  let concierge!: Concierge;
  let pendingCliReply: Promise<unknown> | undefined;
  const session = {
    async start() {},
    async stop() {},
    ...(opts.currentMeta ? { getCurrentMeta: () => opts.currentMeta } : {}),
    ask: async (m: string) => {
      asks.push(m);
      if (opts.browserOnAsk) {
        await concierge.onBusRequest({
          cmd: "browser.run",
          args: { task: "open inbox", channelId: CHAN },
        });
      }
      if (opts.replyViaCli) {
        const cliReply = concierge.onBusRequest({
          cmd: "discord.reply",
          args: { channelId: CHAN, text: opts.cliText ?? "via cli" },
        });
        if (opts.replyViaCliAwait === false) {
          pendingCliReply = cliReply;
        } else {
          await cliReply;
        }
      }
      return opts.turnText;
    },
  } as unknown as ConciergeSession;

  concierge = new Concierge({ config: opts.config ?? config, session, gateway });
  return {
    concierge,
    posts,
    asks,
    deletedMessages,
    dir,
    postAttempts: () => postAttempts,
    pendingCliReply: () => pendingCliReply,
  };
}

function mention(): IncomingMessage {
  return {
    messageId: MSG,
    userId: USER,
    channelId: CHAN,
    roleIds: [],
    content: "@beckett where my site at",
    mentionsBot: true,
    attachments: [],
  } as unknown as IncomingMessage;
}

function fakeBrowserAgent(overrides: Partial<BrowserAgent> = {}): BrowserAgent {
  return {
    run: async () => ({ runId: "unused" }),
    resume: async () => {},
    steer: async () => "queued" as const,
    stop: async () => {},
    drainSteers: () => [],
    recordEval: () => {},
    inspect: async () => null,
    evalSecrets: async () => null,
    saveSecret: async (_runId, field, _value) => ({ field, entry: "huggingface", ok: true }),
    recover: async () => {},
    stats: () => ({ running: 0, waiting: 1, queued: 0, runs: [] }),
    stopAll: async () => {},
    ...overrides,
  };
}

test("answers via CLI → exactly one post, native reply, no auto-post duplicate", async () => {
  const { concierge, posts } = harness({ replyViaCli: true, turnText: "the turn text", cliText: "the cli answer" });
  await concierge.onMessage(mention());
  // Only the CLI reply lands — once — and it's a NATIVE reply to the @mention (not a bare post).
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "the cli answer", replyTo: MSG, files: undefined });
});

test("answers normally (no CLI) → the turn text is auto-posted once as a native reply", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "just the turn text" });
  await concierge.onMessage(mention());
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "just the turn text", replyTo: MSG, files: undefined });
});

/**
 * The double-posting bug (ro's report, aug 11-12): a "mega" message re-concatenating text already
 * sent seconds/milliseconds earlier as separate standalone messages. Root cause — `discord.reply`
 * only stamped `repliedViaCli` AFTER its own send finished (index.ts, the old code right after the
 * `deliverChilled` call). A real CLI reply's delivery can still be in flight when the turn's own
 * structured output resolves (its bus round trip can hand control back to the model before the
 * daemon finishes sending — a slow/chilled multi-chunk delivery routinely takes several real
 * seconds, well within `discordReplyAckTimeoutMs`'s failure modes), and the terminal auto-post
 * read the flag in that exact window and fired a second, real send for the same turn — the model's
 * own answer, sent twice, landing as two Discord messages with distinct ids seconds or even
 * milliseconds apart. The fix stamps the claim synchronously, before the send starts, so the
 * auto-post can never observe a live CLI reply as unclaimed.
 */
test("a CLI reply still in flight is claimed immediately — the auto-post can't race it into a second send", async () => {
  const { concierge, posts, pendingCliReply } = harness({
    replyViaCli: true,
    replyViaCliAwait: false, // the model's Bash tool call returns before the send below finishes
    cliText: "steer work mid-flight",
    turnText: "steer work mid-flight",
    postDelayMs: 20, // gives the in-flight CLI send real async work left to do when the turn ends
  });
  await concierge.onMessage(mention());
  // The CLI reply is still in flight (postDelayMs) when onMessage's own turn finishes — let it land.
  await pendingCliReply();
  // Without the fix this is 2: the CLI reply's post PLUS the terminal auto-post of the same text.
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ channelId: CHAN, text: "steer work mid-flight" });
});

test("a second, wrap-up CLI reply that fails does not un-claim a turn the first reply already answered", async () => {
  // Guards the rollback added alongside the early claim above: only the reply that ACTUALLY
  // claimed the turn may un-claim it on failure. Without that guard, a failing SECOND reply in
  // the same turn (e.g. a wrap-up after filing) would reset `repliedViaCli` to false even though
  // the FIRST reply already posted the real answer — reopening the exact race the fix closes and
  // letting the terminal auto-post fire a duplicate on top of an already-answered turn.
  const dir = mkdtempSync(join(tmpdir(), "beckett-dedup-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = USER;
  const posts: Post[] = [];
  let attempt = 0;
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: { replyToMessageId?: string }) {
      attempt++;
      if (attempt === 2) throw new Error("discord offline"); // the wrap-up reply fails
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return `mid-${posts.length}`;
    },
    async deleteMessage() {},
  } as unknown as DiscordGateway;

  let concierge!: Concierge;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => {
      await concierge.onBusRequest({ cmd: "discord.reply", args: { channelId: CHAN, text: "the real answer" } });
      const wrapUp = await concierge.onBusRequest({ cmd: "discord.reply", args: { channelId: CHAN, text: "one more thing" } });
      expect(wrapUp.ok).toBe(false);
      return "must not auto-post";
    },
  } as unknown as ConciergeSession;

  concierge = new Concierge({ config, session, gateway });
  await concierge.onMessage(mention());
  // Exactly the first reply lands; the failed wrap-up does not, and — the point of this test — the
  // auto-post does not fire a duplicate of "the real answer" because the first reply's claim held.
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "the real answer", replyTo: MSG });
});

/** A `config.concierge.chilltext` slice, `enabled` set per test. */
function chillConfig(overrides: Partial<{ enabled: boolean; bubble_delay_ms: number }> = {}): Config {
  return {
    concierge: {
      model: "m",
      rotate_at_tokens: 190_000,
      chilltext: {
        enabled: false,
        url: "https://chilltext.example",
        timeout_ms: 8_000,
        max_bubbles: 3,
        bubble_delay_ms: 0,
        system_override: "",
        skip_code_blocks: true,
        ...overrides,
      },
    },
    paths: {},
  } as unknown as Config;
}

test("chilltext enabled: the auto-posted reply is chilled into bubbles — first is the native reply, the rest post plainly, all singleMessage", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ messages: ["hey", "found it", "check foo.ts"] }), { status: 200 })) as unknown as typeof fetch;
  try {
    const { concierge, posts } = harness({
      replyViaCli: false,
      turnText: "found it: X lives in foo.ts, wired up exactly the way you described in the mention",
      config: chillConfig({ enabled: true }),
    });
    await concierge.onMessage(mention());
    expect(posts).toHaveLength(3);
    expect(posts[0]).toMatchObject({ channelId: CHAN, text: "hey", replyTo: MSG, singleMessage: true });
    expect(posts[1]).toMatchObject({ channelId: CHAN, text: "found it", replyTo: undefined, singleMessage: true });
    expect(posts[2]).toMatchObject({ channelId: CHAN, text: "check foo.ts", replyTo: undefined, singleMessage: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("chilltext explicitly disabled: the auto-post stays one plain native reply, same as the flag-off default", async () => {
  const { concierge, posts } = harness({
    replyViaCli: false,
    turnText: "just the turn text",
    config: chillConfig({ enabled: false }),
  });
  await concierge.onMessage(mention());
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "just the turn text", replyTo: MSG, files: undefined });
});

test("a CLI reply OUTSIDE any live @mention turn posts plainly (proactive update path)", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  // No @mention in flight (this models notify()'s update turn) → plain post, no reply-bar.
  await concierge.onBusRequest({ cmd: "discord.reply", args: { channelId: CHAN, text: "shipped it" } });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ channelId: CHAN, text: "shipped it", replyTo: undefined, files: undefined });
});

test("discord.reply forwards files and permits image-only posts", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  await concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: CHAN, text: "", files: ["/tmp/logo.png"] },
  });
  expect(posts).toEqual([{ channelId: CHAN, text: "", replyTo: undefined, files: ["/tmp/logo.png"] }]);
});

test("discord.reply forwards resolved --ping ids to the gateway so they actually notify (issue #10)", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  const RO = "1151230208783945818";
  await concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: CHAN, text: `<@${RO}>\nshipped it`, pingUserIds: [RO] },
  });
  expect(posts).toEqual([{ channelId: CHAN, text: `<@${RO}>\nshipped it`, replyTo: undefined, files: undefined, pingUserIds: [RO] }]);
});

test("discord.ack forwards resolved --ping ids to the gateway (issue #10)", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  const RO = "1151230208783945818";
  await concierge.onBusRequest({
    cmd: "discord.ack",
    args: { channelId: CHAN, text: `<@${RO}>\non it`, pingUserIds: [RO] },
  });
  expect(posts).toHaveLength(1);
  expect(posts[0]?.pingUserIds).toEqual([RO]);
  expect(posts[0]?.text).toBe(`<@${RO}>\non it`);
});

test("the browser agent cannot be borrowed outside an authenticated request", async () => {
  const { concierge } = harness({ replyViaCli: false, turnText: "" });
  let runs = 0;
  concierge.setBrowserAgent(fakeBrowserAgent({
    run: async () => { runs++; return { runId: "bad" }; },
  }));
  const result = await concierge.onBusRequest({
    cmd: "browser.run",
    args: { task: "open inbox", channelId: CHAN },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("authenticated authorized request");
  expect(runs).toBe(0);
});

test("an access-list user can start a browser task from a role-free Discord mention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dedup-"));
  writeFileSync(join(dir, "access.txt"), `${USER}\n`, "utf8");
  const { concierge } = harness({
    replyViaCli: false,
    turnText: "",
    browserOnAsk: true,
    dir,
    ownerId: "999999999999999999",
  });
  const runs: { channelId: string; requesterId: string }[] = [];
  concierge.setBrowserAgent(fakeBrowserAgent({
    run: async (_task, opts) => {
      runs.push({ channelId: opts.channelId, requesterId: opts.requesterId });
      return { runId: "authorized-run" };
    },
  }));
  await concierge.onMessage(mention());
  expect(runs).toEqual([{ channelId: CHAN, requesterId: USER }]);
});

test("an authenticated request dispatches the browser agent, stamped and channel-locked", async () => {
  const { concierge } = harness({
    replyViaCli: false,
    turnText: "",
    currentMeta: {
      channelId: CHAN,
      messageId: MSG,
      userId: USER,
      isOwner: false,
      repliedViaCli: false,
      ackMessageId: null,
    },
  });
  const dispatches: { task: string; channelId: string; requesterId: string; credsEntry: string | null | undefined }[] = [];
  concierge.setBrowserAgent(fakeBrowserAgent({
    run: async (task, opts) => {
      dispatches.push({ task, channelId: opts.channelId, requesterId: opts.requesterId, credsEntry: opts.credsEntry });
      return { runId: "ok" };
    },
  }));
  const result = await concierge.onBusRequest({
    cmd: "browser.run",
    args: { task: "log in and export the report", channelId: CHAN, credsEntry: "x.com" },
  });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ detached: true, runId: "ok" });
  expect(dispatches).toEqual([{
    task: "log in and export the report",
    channelId: CHAN,
    requesterId: USER,
    credsEntry: "x.com",
  }]);

  const mismatched = await concierge.onBusRequest({
    cmd: "browser.run",
    args: { task: "open inbox", channelId: "999999999999999999" },
  });
  expect(mismatched.ok).toBe(false);
  expect(mismatched.error).toContain("where the authorized request began");
});

test("an inline exec is refused while a dispatch is queued for the browser lease", async () => {
  const { concierge } = harness({
    replyViaCli: false,
    turnText: "",
    currentMeta: {
      channelId: CHAN,
      messageId: MSG,
      userId: USER,
      isOwner: false,
      repliedViaCli: false,
      ackMessageId: null,
    },
  });
  concierge.setBrowserRuntime({} as unknown as BrowserRuntime);
  // A run in state "queued" (also the mid-acquire handoff) must keep exec off the lease —
  // exec winning that race would error the queued run the person was told never to re-dispatch.
  concierge.setBrowserAgent(fakeBrowserAgent({
    stats: () => ({
      running: 0,
      waiting: 0,
      queued: 1,
      runs: [{ runId: "q-1", state: "queued", startedAt: 1, finishedAt: null, credsEntry: null, question: null, task: "t" }],
    }),
  }));
  const result = await concierge.onBusRequest({ cmd: "browser.exec", args: { code: "return 1" } });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("run q-1 queued for the browser");
});

function agentRun(overrides: Partial<BrowserAgentRun> = {}): BrowserAgentRun {
  return {
    runId: "browser-1",
    task: "finish signup",
    channelId: CHAN,
    requesterId: USER,
    credsEntry: null,
    context: null,
    startedAt: Date.now(),
    finishedAt: null,
    state: "waiting",
    result: null,
    sessionId: "session-1",
    proofFiles: [],
    question: "Which plan?",
    questionMessageId: null,
    outcomeDelivered: false,
    ...overrides,
  };
}

test("browser question attaches its screenshot and a native reply resumes without entering chat context", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not run" });
  const resumed: { runId: string; answer: string }[] = [];
  concierge.setBrowserAgent(fakeBrowserAgent({
    resume: async (runId, answer) => {
      resumed.push({ runId, answer });
    },
  }));
  const questionId = await concierge.notifyBrowserQuestion(
    agentRun(),
    { text: "Which plan should I select?", screenshot: "/tmp/question.png" },
  );
  expect(posts[0]).toEqual({
    channelId: CHAN,
    text: "Which plan should I select?\nReply directly to this message and I'll continue from the same page.",
    replyTo: undefined,
    files: ["/tmp/question.png"],
    singleMessage: true,
    browserQuestion: true,
  });

  await concierge.onMessage({
    ...mention(),
    messageId: "answer-1",
    content: "Pro",
    mentionsBot: false,
    repliedToId: questionId,
    authorIsBot: false,
  });
  expect(resumed).toEqual([{ runId: "browser-1", answer: "Pro" }]);
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "answer-1" });
  expect(posts[1]).toMatchObject({ replyTo: undefined, text: "I have what I need. Continuing from that page now." });
});

test("a browser answer is not used when Discord cannot confirm its deletion", async () => {
  const { concierge, posts } = harness({
    replyViaCli: false,
    turnText: "must not run",
    failDeletes: true,
  });
  let resumes = 0;
  concierge.setBrowserAgent(fakeBrowserAgent({
    resume: async () => { resumes++; },
  }));
  const questionId = await concierge.notifyBrowserQuestion(
    agentRun(),
    { text: "What is the password?", screenshot: "/tmp/question.png" },
  );
  await concierge.onMessage({
    ...mention(),
    messageId: "undeletable-answer",
    content: "Sup3rSecret!",
    mentionsBot: false,
    repliedToId: questionId,
    authorIsBot: false,
  });
  expect(resumes).toBe(0);
  expect(posts.at(-1)?.text).toContain("Manage Messages");
  expect(JSON.stringify(posts)).not.toContain("Sup3rSecret");
});

test("a browser question is deleted when its privacy ledger cannot be persisted", async () => {
  const { concierge, deletedMessages, dir } = harness({ replyViaCli: false, turnText: "" });
  mkdirSync(join(dir, "browser-questions.json"));
  await expect(concierge.notifyBrowserQuestion(
    agentRun(),
    { text: "What is the password?", screenshot: join(dir, "question.png") },
  )).rejects.toThrow("was not made durable");
  expect(deletedMessages).toEqual([{ channelId: CHAN, messageId: "mid-1" }]);
  await concierge.stop();
});

test("browser question instructions stay in the one ledgered Discord message", async () => {
  const { concierge, posts } = harness({ replyViaCli: false, turnText: "" });
  await concierge.notifyBrowserQuestion(
    agentRun(),
    {
      text: `Page context before the question.\n\nWhich password should I use? ${"context ".repeat(400)}`,
      screenshot: "/tmp/question.png",
    },
  );
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text.length).toBeLessThanOrEqual(2_000);
  expect(posts[0]!.text).not.toContain("\n\n");
  expect(posts[0]!.text).toStartWith("Page context before the question. Which password should I use?");
  expect(posts[0]!.text).toEndWith("Reply directly to this message and I'll continue from the same page.");
  expect(posts[0]!.files).toEqual(["/tmp/question.png"]);
  // Atomicity is the GATEWAY's guarantee, not the chunker's: `singleMessage: true` bypasses
  // chunkReply entirely (and `browserQuestion` posts require it — gateway throws
  // otherwise), so the suffix can never be split away from the question. The old
  // `chunkReply(text) has length 1` assertion here only held because the pre-fix sentence
  // splitter silently DROPPED the long "context…" run; the lossless splitter would pack this
  // text into 2 chunks — correctly — on the (unused) non-atomic path.
  expect(posts[0]!.singleMessage).toBe(true);
  expect(posts[0]!.browserQuestion).toBe(true);
  await concierge.stop();
});

test("deleted browser question tombstones expire and remain bounded", async () => {
  const { concierge, deletedMessages, dir } = harness({ replyViaCli: false, turnText: "" });
  const now = Date.now();
  const records = Array.from({ length: 1_005 }, (_, index) => ({
    messageId: `question-${index}`,
    runId: `run-${index}`,
    channelId: CHAN,
    allowedUserId: USER,
    createdAt: now - index,
    stale: false,
  }));
  records.push({
    messageId: "expired-question",
    runId: "expired-run",
    channelId: CHAN,
    allowedUserId: USER,
    createdAt: now - 8 * 24 * 60 * 60_000,
    stale: false,
  });
  writeFileSync(join(dir, "browser-questions.json"), JSON.stringify(records));
  await concierge.start();
  try {
    let persisted: { stale: boolean; deletedAt?: number }[] = [];
    const deadline = Date.now() + 2_000;
    do {
      persisted = JSON.parse(readFileSync(join(dir, "browser-questions.json"), "utf8"));
      if (persisted.length === 1_000 && persisted.every((record) => record.deletedAt !== undefined)) break;
      if (Date.now() > deadline) throw new Error("stale browser questions were not deleted and compacted");
      await Bun.sleep(10);
    } while (true);
    expect(persisted).toHaveLength(1_000);
    expect(persisted.every((record) => record.stale && record.deletedAt !== undefined)).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain("expired-question");
    expect(deletedMessages).toHaveLength(1_006);
  } finally {
    await concierge.stop();
  }
});

test("only the browser-run owner can answer its screenshot-backed question", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not run" });
  let resumes = 0;
  concierge.setBrowserAgent(fakeBrowserAgent({
    resume: async () => { resumes++; },
  }));
  const questionId = await concierge.notifyBrowserQuestion(
    agentRun(),
    { text: "What is the one-time code?", screenshot: "/tmp/question.png" },
  );
  await concierge.onMessage({
    ...mention(),
    messageId: "answer-other",
    userId: "222222222222222222",
    content: "123456",
    mentionsBot: false,
    repliedToId: questionId,
    authorIsBot: false,
  });
  expect(resumes).toBe(0);
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "answer-other" });
  expect(posts.at(-1)?.text).toContain("Only the person who started");
});

test("the initiating authorized user can answer a browser question without a Discord role", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not run" });
  let resumes = 0;
  concierge.setBrowserAgent(fakeBrowserAgent({
    resume: async () => { resumes++; },
  }));
  const questionId = await concierge.notifyBrowserQuestion(
    agentRun(),
    { text: "What is the one-time code?", screenshot: "/tmp/question.png" },
  );
  await concierge.onMessage({
    ...mention(),
    messageId: "answer-revoked",
    roleIds: [],
    content: "123456",
    mentionsBot: false,
    repliedToId: questionId,
    authorIsBot: false,
  });
  expect(resumes).toBe(1);
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "answer-revoked" });
  expect(posts.at(-1)?.text).toContain("Continuing from that page");
});

test("a reply to a browser question from before restart is consumed as sensitive stale input", async () => {
  const first = harness({ replyViaCli: false, turnText: "must not run" });
  const questionId = await first.concierge.notifyBrowserQuestion(
    agentRun(),
    { text: "What is the one-time code?", screenshot: "/tmp/question.png" },
  );
  const restarted = harness({ replyViaCli: false, turnText: "must not run", dir: first.dir });
  await restarted.concierge.start();
  try {
    await restarted.concierge.onMessage({
      ...mention(),
      messageId: "late-secret",
      content: "654321",
      mentionsBot: false,
      repliedToId: questionId,
      authorIsBot: false,
    });
    expect(restarted.deletedMessages).toContainEqual({ channelId: CHAN, messageId: "late-secret" });
    expect(restarted.posts.some((post) => post.text.includes("browser run is no longer active"))).toBe(true);
    expect(restarted.posts.some((post) => post.text.includes("must not run"))).toBe(false);
  } finally {
    await restarted.concierge.stop();
  }
});

test("an orphan browser-question reply is consumed even if the daemon crashed before ledger persistence", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not enter chat" });
  await concierge.onMessage({
    ...mention(),
    messageId: "orphan-secret",
    content: "739184",
    mentionsBot: true,
    repliedToId: "accepted-before-crash",
    repliedToBrowserQuestion: true,
    authorIsBot: false,
  });
  expect(posts.some((post) => post.text.includes("browser run is no longer active"))).toBe(true);
  expect(posts.some((post) => post.text.includes("must not enter chat"))).toBe(false);
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "orphan-secret" });
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "accepted-before-crash" });
});

test("an unverified bot-reference reply fails closed instead of entering chat context", async () => {
  const { concierge, posts, deletedMessages } = harness({ replyViaCli: false, turnText: "must not enter chat" });
  await concierge.onMessage({
    ...mention(),
    messageId: "unverified-secret",
    content: "739184",
    mentionsBot: true,
    repliedToId: "uninspectable-bot-message",
    repliedToBotUnverified: true,
    authorIsBot: false,
  });
  expect(deletedMessages).toContainEqual({ channelId: CHAN, messageId: "unverified-secret" });
  expect(posts.some((post) => post.text.includes("I ignored it to be safe"))).toBe(true);
  expect(posts.some((post) => post.text.includes("must not enter chat"))).toBe(false);
});

test("a browser outcome arrives as an update turn instructing a voiced reply with proof attached", async () => {
  const { concierge, posts, asks, dir } = harness({ replyViaCli: false, turnText: "" });
  const proof = join(dir, "proof.png");
  writeFileSync(proof, "png fixture");
  await concierge.notifyBrowserOutcome(agentRun({
    state: "done",
    result: "The account is ready at https://example.test/account.",
    proofFiles: [proof],
    finishedAt: Date.now(),
  }));
  // The outcome routes through the Concierge (an update turn), never straight to Discord.
  expect(posts).toEqual([]);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("SYSTEM (browser-agent outcome");
  expect(asks[0]).toContain('finished with state "done"');
  expect(asks[0]).toContain("The account is ready at https://example.test/account.");
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN} --file ${proof} `);
});

test("a deploy-cancelled browser run is surfaced as exactly one identifying line", async () => {
  const { asks, concierge } = harness({ replyViaCli: false, turnText: "" });
  await concierge.notifyBrowserOutcome(agentRun({
    runId: "9fe5bfbe-519e-4784-9ba1-ad4eeb8269f6",
    task: "research replies and post the evening update",
    state: "cancelled",
    restartCancelled: true,
    finishedAt: Date.now(),
  }));
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("Send exactly this one line");
  expect(asks[0]).toContain("Deploy cancelled browser run 9fe5bfbe-519e-4784-9ba1-ad4eeb8269f6: research replies and post the evening update");
  expect(asks[0]).not.toContain("retry");
});

test("a failed browser outcome tells the Concierge to say so plainly", async () => {
  const { asks, concierge } = harness({ replyViaCli: false, turnText: "" });
  await concierge.notifyBrowserOutcome(agentRun({
    state: "timeout",
    result: "Timed out waiting 3600s for an answer to: Which plan?",
    finishedAt: Date.now(),
  }));
  expect(asks[0]).toContain('finished with state "timeout"');
  expect(asks[0]).toContain("say so plainly");
});

test("browser outcomes redact labelled credentials before entering the update turn", async () => {
  const { asks, concierge } = harness({ replyViaCli: false, turnText: "" });
  await concierge.notifyBrowserOutcome(agentRun({
    state: "done",
    result: "Created the account. Password: Sup3rSecret!",
    finishedAt: Date.now(),
  }));
  expect(asks[0]).toContain("[redacted]");
  expect(asks[0]).not.toContain("Sup3rSecret");
});

test("a browser outcome marks the run's parked question anchor stale", async () => {
  const { concierge, deletedMessages } = harness({ replyViaCli: false, turnText: "" });
  const questionId = await concierge.notifyBrowserQuestion(
    agentRun(),
    { text: "Which plan should I select?", screenshot: "/tmp/question.png" },
  );
  await concierge.notifyBrowserOutcome(agentRun({ state: "done", result: "Done.", finishedAt: Date.now() }));
  const deadline = Date.now() + 2_000;
  while (!deletedMessages.some((deleted) => deleted.messageId === questionId)) {
    if (Date.now() > deadline) throw new Error("stale question anchor was not deleted");
    await Bun.sleep(10);
  }
});

test("an update-turn failure propagates so the agent's durable ledger keeps retrying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dedup-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = USER;
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post() { return "mid-1"; },
    async deleteMessage() {},
  } as unknown as DiscordGateway;
  const session = {
    async start() {},
    async stop() {},
    ask: async () => { throw new Error("system session down"); },
  } as unknown as ConciergeSession;
  const concierge = new Concierge({ config, session, gateway });
  await expect(concierge.notifyBrowserOutcome(agentRun({
    state: "done",
    result: "Must not be marked delivered.",
    finishedAt: Date.now(),
  }))).rejects.toThrow("system session down");
});

test("browser.eval injects keychain secrets below the model and scrubs echoed values", async () => {
  const { concierge } = harness({ replyViaCli: false, turnText: "" });
  const evals: string[] = [];
  concierge.setBrowserRuntime({
    async acquire() {},
    async evaluate(_runId: string, code: string) {
      evals.push(code);
      return {
        value: "logged in as hunter2-secret",
        console: ["typed hunter2-secret into #pass"],
        pages: [],
        events: [],
        screenshots: [],
        elapsedMs: 1,
        truncated: false,
      };
    },
    async capture() { return ""; },
    async checkpoint() { return { urls: [], activeIndex: 0 }; },
    async restore() {},
    async release() { return []; },
    hasLease() { return true; },
    stats() { return { ready: true, profileDir: "t", activeRunId: "r1", pages: 1, launches: 1, evaluations: 0, averageEvalMs: 0 }; },
    async stop() {},
  } as BrowserRuntime);
  concierge.setBrowserAgent(fakeBrowserAgent({
    evalSecrets: async () => ({ password: "hunter2-secret", totp: "739184" }),
  }));
  const result = await concierge.onBusRequest({
    cmd: "browser.eval",
    args: { runId: "r1", controlToken: "token", code: "await page.fill('#pass', secrets.password)" },
  });
  expect(evals[0]).toStartWith("const secrets = Object.freeze({");
  expect(evals[0]).toContain("hunter2-secret");
  expect(evals[0]).toContain("await page.fill('#pass', secrets.password)");
  expect(evals[0]).toEndWith("return { __beckettEnvelope: 1, result: __beckettResult, saves: __beckettSaves };");
  // Nothing that flows back to the model transcript may carry a secret value.
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain("hunter2-secret");
  expect(JSON.stringify(result)).not.toContain("739184");
  expect((result.data as { value: string }).value).toBe("logged in as [redacted]");
});

test("browser.eval failures are scrubbed of secret values too", async () => {
  const { concierge } = harness({ replyViaCli: false, turnText: "" });
  concierge.setBrowserRuntime({
    async acquire() {},
    async evaluate() { throw new Error("locator not found after typing hunter2-secret"); },
    async capture() { return ""; },
    async checkpoint() { return { urls: [], activeIndex: 0 }; },
    async restore() {},
    async release() { return []; },
    hasLease() { return true; },
    stats() { return { ready: true, profileDir: "t", activeRunId: "r1", pages: 1, launches: 1, evaluations: 0, averageEvalMs: 0 }; },
    async stop() {},
  } as BrowserRuntime);
  concierge.setBrowserAgent(fakeBrowserAgent({
    evalSecrets: async () => ({ password: "hunter2-secret" }),
  }));
  const result = await concierge.onBusRequest({
    cmd: "browser.eval",
    args: { runId: "r1", controlToken: "token", code: "await page.click('#go')" },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toBe("locator not found after typing [redacted]");
});

test("browser.eval exposes secrets.save and stores what a script returns", async () => {
  const { concierge } = harness({ replyViaCli: false, turnText: "" });
  concierge.setBrowserRuntime({
    async acquire() {},
    async evaluate() {
      return {
        value: {
          __beckettEnvelope: 1,
          result: "ok",
          saves: [{ field: "hf_token", value: "hf_live_x" }],
        },
        pages: [],
        events: [],
        screenshots: [],
        elapsedMs: 1,
        truncated: false,
      };
    },
    async capture() { return ""; },
    async checkpoint() { return { urls: [], activeIndex: 0 }; },
    async restore() {},
    async release() { return []; },
    hasLease() { return true; },
    stats() { return { ready: true, profileDir: "t", activeRunId: "r1", pages: 1, launches: 1, evaluations: 0, averageEvalMs: 0 }; },
    async stop() {},
  } as BrowserRuntime);
  const saveSecretCalls: Array<{ runId: string; field: string; value: string }> = [];
  concierge.setBrowserAgent(fakeBrowserAgent({
    evalSecrets: async () => ({}),
    saveSecret: async (runId, field, value) => {
      saveSecretCalls.push({ runId, field, value });
      return { field, entry: "huggingface", ok: true };
    },
  }));
  const result = await concierge.onBusRequest({
    cmd: "browser.eval",
    args: { runId: "r1", controlToken: "token", code: "return secrets.save('hf_token', mintedToken())" },
  });
  expect(saveSecretCalls).toEqual([{ runId: "r1", field: "hf_token", value: "hf_live_x" }]);
  expect(result.ok).toBe(true);
  expect((result.data as { value: string }).value).toBe("ok");
  expect((result.data as { secretsSaved: unknown }).secretsSaved).toEqual([
    { field: "hf_token", entry: "huggingface", ok: true },
  ]);
  expect(JSON.stringify(result)).not.toContain("hf_live_x");
});

test("a failed save is reported without failing the eval", async () => {
  const { concierge } = harness({ replyViaCli: false, turnText: "" });
  concierge.setBrowserRuntime({
    async acquire() {},
    async evaluate() {
      return {
        value: {
          __beckettEnvelope: 1,
          result: "ok",
          saves: [{ field: "hf_token", value: "hf_live_x" }],
        },
        pages: [],
        events: [],
        screenshots: [],
        elapsedMs: 1,
        truncated: false,
      };
    },
    async capture() { return ""; },
    async checkpoint() { return { urls: [], activeIndex: 0 }; },
    async restore() {},
    async release() { return []; },
    hasLease() { return true; },
    stats() { return { ready: true, profileDir: "t", activeRunId: "r1", pages: 1, launches: 1, evaluations: 0, averageEvalMs: 0 }; },
    async stop() {},
  } as BrowserRuntime);
  concierge.setBrowserAgent(fakeBrowserAgent({
    evalSecrets: async () => ({}),
    saveSecret: async (_runId, field) => ({ field, entry: "huggingface", ok: false, error: "jingle refused the write (exit 1)" }),
  }));
  const result = await concierge.onBusRequest({
    cmd: "browser.eval",
    args: { runId: "r1", controlToken: "token", code: "return secrets.save('hf_token', mintedToken())" },
  });
  expect(result.ok).toBe(true);
  expect((result.data as { secretsSaved: unknown }).secretsSaved).toEqual([
    { field: "hf_token", entry: "huggingface", ok: false, error: "jingle refused the write (exit 1)" },
  ]);
  expect(JSON.stringify(result)).not.toContain("hf_live_x");
});

test("a run with no secrets is handed its own source untouched", async () => {
  const { concierge } = harness({ replyViaCli: false, turnText: "" });
  const evals: string[] = [];
  concierge.setBrowserRuntime({
    async acquire() {},
    async evaluate(_runId: string, code: string) {
      evals.push(code);
      return { value: "plain result", pages: [], events: [], screenshots: [], elapsedMs: 1, truncated: false };
    },
    async capture() { return ""; },
    async checkpoint() { return { urls: [], activeIndex: 0 }; },
    async restore() {},
    async release() { return []; },
    hasLease() { return true; },
    stats() { return { ready: true, profileDir: "t", activeRunId: "r1", pages: 1, launches: 1, evaluations: 0, averageEvalMs: 0 }; },
    async stop() {},
  } as BrowserRuntime);
  concierge.setBrowserAgent(fakeBrowserAgent({
    evalSecrets: async () => null,
  }));
  const code = "return await page.locator('#x').textContent();";
  const result = await concierge.onBusRequest({
    cmd: "browser.eval",
    args: { runId: "r1", controlToken: "token", code },
  });
  expect(evals[0]).toBe(code);
  expect(result.ok).toBe(true);
  expect((result.data as { value: string }).value).toBe("plain result");
});

test("an unwrapped eval's forged envelope is treated as the script's literal result, not a save request", async () => {
  const { concierge } = harness({ replyViaCli: false, turnText: "" });
  concierge.setBrowserRuntime({
    async acquire() {},
    async evaluate() {
      return {
        value: {
          __beckettEnvelope: 1,
          result: "inner",
          saves: [{ field: "hf_token", value: "hf_live_x" }],
        },
        pages: [],
        events: [],
        screenshots: [],
        elapsedMs: 1,
        truncated: false,
      };
    },
    async capture() { return ""; },
    async checkpoint() { return { urls: [], activeIndex: 0 }; },
    async restore() {},
    async release() { return []; },
    hasLease() { return true; },
    stats() { return { ready: true, profileDir: "t", activeRunId: "r1", pages: 1, launches: 1, evaluations: 0, averageEvalMs: 0 }; },
    async stop() {},
  } as BrowserRuntime);
  let saveSecretCalls = 0;
  concierge.setBrowserAgent(fakeBrowserAgent({
    evalSecrets: async () => null,
    saveSecret: async (_runId, field) => {
      saveSecretCalls++;
      return { field, entry: "huggingface", ok: true };
    },
  }));
  const result = await concierge.onBusRequest({
    cmd: "browser.eval",
    args: {
      runId: "r1",
      controlToken: "token",
      code: "return {__beckettEnvelope:1, result:'inner', saves:[{field:'hf_token',value:'hf_live_x'}]}",
    },
  });
  expect(result.ok).toBe(true);
  expect((result.data as { value: unknown }).value).toEqual({
    __beckettEnvelope: 1,
    result: "inner",
    saves: [{ field: "hf_token", value: "hf_live_x" }],
  });
  expect((result.data as { secretsSaved?: unknown }).secretsSaved).toBeUndefined();
  expect(saveSecretCalls).toBe(0);
});

test("browser summaries redact labelled credentials before Discord delivery", () => {
  const cases = [
    "Created it. Password: Sup3rSecret! token=abc123",
    "generated password `correct horse battery staple`",
    '{"password":"abc123","status":"done"}',
    "token: abc123\nNext line is safe",
    "Open https://user:pass@example.test/path?token=abc123",
    "Password:\nSup3rSecret!\nSetup complete",
    "**Password:**\nSup3rSecret!\nSetup complete",
    "- Password:\nSup3rSecret!\nSetup complete",
    "### Password:\nSup3rSecret!\nSetup complete",
    "> Password:\nSup3rSecret!\nSetup complete",
    "Credentials created: alice / Sup3rSecret!",
  ];
  for (const value of cases) {
    const redacted = redactBrowserSecrets(value);
    expect(redacted).toContain("[redacted]");
    for (const secret of ["Sup3rSecret", "abc123", "correct horse", "user:pass"]) {
      expect(redacted).not.toContain(secret);
    }
  }
  expect(redactBrowserSecrets(cases[3]!)).toContain("Next line is safe");
  expect(redactBrowserSecrets(cases[5]!)).toContain("Setup complete");
  expect(redactBrowserSecrets("What is the password? Which password should I use?")).toBe(
    "What is the password? Which password should I use?",
  );
});

test("a send that succeeds before its bus ack times out is not posted again on retry", async () => {
  const { concierge, posts, dir } = harness({ replyViaCli: false, turnText: "" });
  const socket = join(dir, "control.sock");
  let first = true;
  let releaseFirstAck!: () => void;
  let ackIsWaiting!: () => void;
  const waitingForAck = new Promise<void>((resolve) => { ackIsWaiting = resolve; });
  const stop = serveBus(socket, async (req) => {
    const response = await concierge.onBusRequest(req);
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        releaseFirstAck = resolve;
        ackIsWaiting();
      });
    }
    return response;
  });

  try {
    // The fake Discord gateway resolves immediately (the post exists), while the control-bus
    // response is deliberately held past the caller's deadline.
    const firstAttempt = callBus(socket, "discord.reply", { channelId: CHAN, text: "sent once" }, 10);
    await waitingForAck;
    await expect(firstAttempt).rejects.toBeInstanceOf(ControlBusTimeoutError);
    expect(posts).toHaveLength(1);

    releaseFirstAck();
    const retry = await callBus(socket, "discord.reply", { channelId: CHAN, text: "sent once" }, 100);
    expect(retry.ok).toBeTrue();
    expect(posts).toHaveLength(1);
  } finally {
    stop();
  }
});
