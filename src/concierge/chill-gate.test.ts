/**
 * The chilltext delivery gate (`src/concierge/chill-gate.ts`): multi-bubble posting order/opts,
 * and the fallback to one plain post on bypass or transform failure. `transform` is injected in
 * every chilled-path test, so no network is ever touched here.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverChilled } from "./chill-gate.ts";
import { OutboundDedupe } from "../discord/outbound-dedupe.ts";
import { readChillTransformLog } from "./chilltext-log.ts";
import { chillTransform, type ChilltextConfig, type ChillTransformResult } from "../chilltext.ts";
import type { DiscordGateway, Logger, ReplyOptions } from "../types.ts";

const CHAN = "chan-1";

function cfg(overrides: Partial<ChilltextConfig> = {}): ChilltextConfig {
  return {
    enabled: true,
    url: "https://chilltext.example",
    timeout_ms: 8_000,
    max_bubbles: 3,
    bubble_delay_ms: 2_500,
    system_override: "",
    skip_code_blocks: true,
    ...overrides,
  };
}

interface Post {
  channelId: string;
  text: string;
  opts?: ReplyOptions;
}

function fakeGateway(): { gateway: DiscordGateway; posts: Post[] } {
  const posts: Post[] = [];
  const gateway = {
    async post(channelId: string, text: string, opts?: ReplyOptions) {
      posts.push({ channelId, text, opts });
      return `msg-${posts.length}`;
    },
  } as unknown as DiscordGateway;
  return { gateway, posts };
}

function noSleep() {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

function tmpLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "beckett-gate-log-")), "chilltext-transforms.jsonl");
}

describe("deliverChilled — bypass / fallback (fail-open)", () => {
  test("cfg disabled: one plain post of the original text, unchanged postOpts", async () => {
    const { gateway, posts } = fakeGateway();
    const postOpts: ReplyOptions = { replyToMessageId: "m1", replyToUserId: "u1" };
    const id = await deliverChilled(CHAN, "a normal reply here", {
      gateway,
      cfg: cfg({ enabled: false }),
      postOpts,
    });
    expect(posts).toEqual([{ channelId: CHAN, text: "a normal reply here", opts: postOpts }]);
    expect(id).toBe("msg-1");
  });

  test("cfg undefined (hand-built test config without a chilltext slice): same inert single post", async () => {
    const { gateway, posts } = fakeGateway();
    const id = await deliverChilled(CHAN, "a normal reply here", { gateway, cfg: undefined });
    expect(posts).toEqual([{ channelId: CHAN, text: "a normal reply here", opts: undefined }]);
    expect(id).toBe("msg-1");
  });

  test("a code-fenced reply bypasses even when enabled", async () => {
    const { gateway, posts } = fakeGateway();
    const text = "```ts\nconst x = 1;\n```";
    let transformCalled = false;
    await deliverChilled(CHAN, text, {
      gateway,
      cfg: cfg(),
      transform: async () => {
        transformCalled = true;
        return { messages: ["should not be used"] };
      },
    });
    expect(transformCalled).toBe(false);
    expect(posts).toEqual([{ channelId: CHAN, text, opts: undefined }]);
  });

  test("transform returns null: falls back to one plain post of the original text", async () => {
    const { gateway, posts } = fakeGateway();
    const postOpts: ReplyOptions = { replyToMessageId: "m1" };
    const id = await deliverChilled(CHAN, "a normal reply that would have been chilled", {
      gateway,
      cfg: cfg(),
      postOpts,
      transform: async () => null,
    });
    expect(posts).toEqual([
      { channelId: CHAN, text: "a normal reply that would have been chilled", opts: postOpts },
    ]);
    expect(id).toBe("msg-1");
  });

  test("a throwing transform still falls open to one plain post", async () => {
    const { gateway, posts } = fakeGateway();
    const id = await deliverChilled(CHAN, "a normal reply here", {
      gateway,
      cfg: cfg(),
      transform: async () => {
        throw new Error("boom");
      },
    });
    expect(posts).toEqual([{ channelId: CHAN, text: "a normal reply here", opts: undefined }]);
    expect(id).toBe("msg-1");
  });
});

describe("deliverChilled — multi-bubble posting order/opts", () => {
  test("first bubble carries postOpts, later bubbles post plainly, all singleMessage", async () => {
    const { gateway, posts } = fakeGateway();
    const { sleep, calls } = noSleep();
    const postOpts: ReplyOptions = { replyToMessageId: "m1", replyToUserId: "u1" };
    const result: ChillTransformResult = { messages: ["hey", "so about that", "done!"] };
    const id = await deliverChilled(CHAN, "hey\n\nso about that\n\ndone!", {
      gateway,
      cfg: cfg(),
      postOpts,
      sleep,
      transform: async () => result,
    });
    expect(posts).toEqual([
      { channelId: CHAN, text: "hey", opts: { replyToMessageId: "m1", replyToUserId: "u1", singleMessage: true } },
      { channelId: CHAN, text: "so about that", opts: { singleMessage: true } },
      { channelId: CHAN, text: "done!", opts: { singleMessage: true } },
    ]);
    // Returns the FIRST posted message id.
    expect(id).toBe("msg-1");
    // One delay BETWEEN each pair of bubbles — none before the first.
    expect(calls).toEqual([2_500, 2_500]);
  });

  test("a single-bubble chilled reply posts once, with postOpts, no delay", async () => {
    const { gateway, posts } = fakeGateway();
    const { sleep, calls } = noSleep();
    const id = await deliverChilled(CHAN, "one bubble", {
      gateway,
      cfg: cfg(),
      postOpts: { replyToMessageId: "m1" },
      sleep,
      transform: async () => ({ messages: ["one bubble"] }),
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      channelId: CHAN,
      text: "one bubble",
      opts: { replyToMessageId: "m1", singleMessage: true },
    });
    expect(id).toBe("msg-1");
    expect(calls).toEqual([]);
  });

  test("every bubble is recorded via recordPost, including the first — the caller records nothing extra", async () => {
    // Regression (ro's "mega message" report, aug 11-12): the old contract left the FIRST bubble
    // for the caller to record, and every real caller recorded it against the full pre-chill
    // `text` instead of the bubble's own text — producing a store entry that re-concatenated
    // content already recorded correctly for the later bubbles. `deliverChilled` now owns 100% of
    // the recording, one call per message it actually posted, each with that message's own text.
    const { gateway } = fakeGateway();
    const recorded: Array<[string, string, string | null]> = [];
    await deliverChilled(CHAN, "hey\n\nso about that\n\ndone!", {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: ["hey", "so about that", "done!"] }),
      recordPost: (channelId, text, messageId) => recorded.push([channelId, text, messageId]),
    });
    expect(recorded).toEqual([
      [CHAN, "hey", "msg-1"],
      [CHAN, "so about that", "msg-2"],
      [CHAN, "done!", "msg-3"],
    ]);
    // Never the full pre-chill text under any id — that's the "mega message" duplicate.
    expect(recorded.some(([, text]) => text === "hey\n\nso about that\n\ndone!")).toBe(false);
  });

  test("a bypass post is recorded once, with the exact text posted", async () => {
    const { gateway } = fakeGateway();
    const recorded: Array<[string, string, string | null]> = [];
    await deliverChilled(CHAN, "a normal reply here", {
      gateway,
      cfg: cfg({ enabled: false }),
      recordPost: (channelId, text, messageId) => recorded.push([channelId, text, messageId]),
    });
    expect(recorded).toEqual([[CHAN, "a normal reply here", "msg-1"]]);
  });

  test("single:true is forwarded to the transform call (the ack seam)", async () => {
    const { gateway } = fakeGateway();
    let sawSingle: boolean | undefined;
    await deliverChilled(CHAN, "digging in", {
      gateway,
      cfg: cfg(),
      single: true,
      transform: async (_cfg, input) => {
        sawSingle = input.single;
        return { messages: ["digging in"] };
      },
    });
    expect(sawSingle).toBe(true);
  });

  test("input is forwarded to the transform call", async () => {
    const { gateway } = fakeGateway();
    let sawInput: string | undefined;
    await deliverChilled(CHAN, "here is my answer", {
      gateway,
      cfg: cfg(),
      input: "what's the status",
      transform: async (_cfg, input) => {
        sawInput = input.input;
        return { messages: ["all good"] };
      },
    });
    expect(sawInput).toBe("what's the status");
  });

  test("personaPath is forwarded to the transform call (the voice comes from that file)", async () => {
    const { gateway } = fakeGateway();
    let sawPersonaPath: string | undefined;
    await deliverChilled(CHAN, "here is my answer", {
      gateway,
      cfg: cfg(),
      personaPath: "/tmp/some/persona.md",
      transform: async (_cfg, input) => {
        sawPersonaPath = input.personaPath;
        return { messages: ["all good"] };
      },
    });
    expect(sawPersonaPath).toBe("/tmp/some/persona.md");
  });
});

describe("deliverChilled — a --ping mention survives a mangling chilltext rewrite", () => {
  // ro's report (aug 12): `--ping ro` posted the bare string `@1151230208783945818` — angle
  // brackets stripped by the LLM rewrite — which renders as a raw number and notifies nobody. The
  // gate must repair the mention STRUCTURALLY, not trust the model to have kept it. Each case feeds
  // deliberately mangled transform output and asserts a real, notifying `<@RO>` still posts.
  const RO = "1151230208783945818";
  const pingOpts: ReplyOptions = { replyToMessageId: "m1", pingUserIds: [RO] };

  function postedText(posts: Post[]): string {
    return posts.map((p) => p.text).join("\n");
  }

  const mangled: Array<[string, string]> = [
    ["bare @id (angle brackets stripped)", `hey @${RO} take a look`],
    ["spaced < @id >", `hey < @${RO} > take a look`],
    ["backticked \\`<@id>\\`", `hey \`<@${RO}>\` take a look`],
    ["<@!id> variant", `hey <@!${RO}> take a look`],
    ["dropped entirely", "hey take a look"],
  ];

  for (const [name, output] of mangled) {
    test(`repairs ${name} back to a valid <@id> in the posted text`, async () => {
      const { gateway, posts } = fakeGateway();
      await deliverChilled(CHAN, `<@${RO}>\nhey take a look`, {
        gateway,
        cfg: cfg(),
        postOpts: pingOpts,
        sleep: async () => {},
        transform: async () => ({ messages: [output] }),
      });
      expect(postedText(posts)).toContain(`<@${RO}>`);
      // …and no inert/mangled residue is left behind.
      expect(postedText(posts)).not.toContain(`@${RO} `);
      expect(postedText(posts)).not.toContain(`\`<@${RO}>\``);
    });
  }

  test("the repaired mention rides the FIRST bubble — the only one the gateway pings from", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, `so here is the thing\n\nanyway thoughts?`, {
      gateway,
      cfg: cfg(),
      postOpts: pingOpts,
      sleep: async () => {},
      // The model moved the (mangled) mention into the SECOND bubble, where allowed_mentions never
      // reaches it. Repair must relocate it to the first bubble.
      transform: async () => ({ messages: ["so here is the thing", `anyway @${RO} thoughts?`] }),
    });
    expect(posts[0]!.text).toContain(`<@${RO}>`);
    // Exactly once across every posted bubble — never duplicated, never lost.
    const count = postedText(posts).split(`<@${RO}>`).length - 1;
    expect(count).toBe(1);
    // The first bubble still carries the ping allow-list; later bubbles do not.
    expect(posts[0]!.opts?.pingUserIds).toEqual([RO]);
    expect(posts[1]!.opts?.pingUserIds).toBeUndefined();
  });

  test("a mention duplicated into every bubble collapses to exactly one, on the first", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, `<@${RO}>\nreply`, {
      gateway,
      cfg: cfg(),
      postOpts: pingOpts,
      sleep: async () => {},
      transform: async () => ({ messages: [`<@${RO}> one`, `<@${RO}> two`, `@${RO} three`] }),
    });
    const count = postedText(posts).split(`<@${RO}>`).length - 1;
    expect(count).toBe(1);
    expect(posts[0]!.text).toContain(`<@${RO}>`);
  });

  test("no pingUserIds: ordinary prose (even prose the model happened to @-mangle) is untouched", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, "yeah all good\n\ntalk soon", {
      gateway,
      cfg: cfg(),
      postOpts: { replyToMessageId: "m1" },
      sleep: async () => {},
      transform: async () => ({ messages: ["yeah all good", "talk soon"] }),
    });
    expect(posts.map((p) => p.text)).toEqual(["yeah all good", "talk soon"]);
  });
});

describe("deliverChilled — a bubble with the user's input prepended is repaired, not discarded", () => {
  // ro's message to Beckett: "yeah merge it". chilltext's rewrite handed back that message
  // prepended verbatim onto the front of the real reply — the whole-bubble check alone can't see
  // this (the echoed span is a small fraction of the bubble), but the leading-span check can.
  const INPUT = "yeah merge it";
  const ORIGINAL_TEXT =
    "all three are on main already, the deploy was just stuck. it's armed now and fires the second " +
    "those two workers finish, no babysitting needed.";
  const PREPENDED_BUBBLE = `${INPUT}. ${ORIGINAL_TEXT}`;

  test("posts the repaired remainder, not the full fallback to the original text", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      input: INPUT,
      sleep: async () => {},
      transform: async () => ({ messages: [PREPENDED_BUBBLE] }),
    });
    expect(posts.map((p) => p.text)).toEqual([ORIGINAL_TEXT]);
  });

  test("logs the repair, distinct from a full fallback, with the before/after pair", async () => {
    const { gateway } = fakeGateway();
    const logPath = tmpLogPath();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      input: INPUT,
      sleep: async () => {},
      transform: async () => ({ messages: [PREPENDED_BUBBLE] }),
      logPath,
    });
    const rows = readChillTransformLog(logPath);
    const bubble = rows[0]!.bubbles![0]!;
    expect(bubble.rewritten).toBe(PREPENDED_BUBBLE);
    expect(bubble.posted).toBe(ORIGINAL_TEXT);
    expect(bubble.echoFallback).toBe(true);
    expect(bubble.echoRepaired).toBe(true);
  });
});

describe("deliverChilled — a bubble that echoes the user's own input falls back per-bubble", () => {
  // Channel 1520986792373911622, message 1539063244914950257 (2026-08-18): chilltext handed the
  // user's own triggering message back as Beckett's reply, pronouns inverted, as ONE of three
  // bubbles in the delivery. The other two bubbles were fine and must post exactly as rewritten.
  const INPUT =
    "right thats the correct flow. questions or like 90% of things should go to you, not me. " +
    "cuz imagine bothering the ceo with every task, you da cto so you gotta step up and be a leader lol.";
  const ECHOED_BUBBLE =
    "yeah that's the right flow. questions or like 90% of stuff should go to you, not me. " +
    "imagine bothering the ceo with every task, you're the cto, so you gotta step up and lead lol.";
  const ORIGINAL_TEXT = "the real reply beckett actually meant to send";

  test("only the echoed bubble falls back to the original text; the other bubbles post as rewritten", async () => {
    const { gateway, posts } = fakeGateway();
    // One block (no blank line): the two legitimate bubbles are each a genuine fragment of it, and
    // the echoed one falls back to this same text wholesale — all three "belong" to it.
    const text = "wrote three, they're in the graph now. want me to walk you through them?";
    await deliverChilled(CHAN, text, {
      gateway,
      cfg: cfg(),
      input: INPUT,
      sleep: async () => {},
      transform: async () => ({
        messages: ["wrote three, they're in the graph now", ECHOED_BUBBLE, "want me to walk you through them?"],
      }),
    });
    expect(posts.map((p) => p.text)).toEqual([
      "wrote three, they're in the graph now",
      text,
      "want me to walk you through them?",
    ]);
  });

  test("logs a warning with the similarity score on a trip", async () => {
    const { gateway } = fakeGateway();
    const warnings: Array<[string, unknown]> = [];
    const logger = { warn: (msg: string, meta?: unknown) => warnings.push([msg, meta]) } as unknown as Logger;
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      input: INPUT,
      logger,
      sleep: async () => {},
      transform: async () => ({ messages: [ECHOED_BUBBLE] }),
    });
    const trip = warnings.find(([msg]) => msg.includes("echoed the user's own input"));
    expect(trip).toBeDefined();
    const meta = trip![1] as { contentScore: number; bubble: string; input: string };
    expect(meta.contentScore).toBeGreaterThanOrEqual(0.65);
    expect(meta.bubble).toContain("cto");
    expect(meta.input).toContain("cto");
  });

  test("a legitimate short agreement is not treated as an echo", async () => {
    const { gateway, posts } = fakeGateway();
    // Agreeing with something the reply itself said — the block genuinely contains "agreed".
    const text = "sounds like we're agreed on the plan then";
    await deliverChilled(CHAN, text, {
      gateway,
      cfg: cfg(),
      input: INPUT,
      sleep: async () => {},
      transform: async () => ({ messages: ["yeah, agreed"] }),
    });
    expect(posts.map((p) => p.text)).toEqual(["yeah, agreed"]);
  });

  test("no input provided: the guard never runs, bubbles post exactly as rewritten", async () => {
    const { gateway, posts } = fakeGateway();
    // The fidelity guard (unlike the echo guard) doesn't care whether `input` was supplied — it
    // only needs the bubble to relate to the pre-chill text, so this must be that text verbatim.
    await deliverChilled(CHAN, ECHOED_BUBBLE, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [ECHOED_BUBBLE] }),
    });
    expect(posts.map((p) => p.text)).toEqual([ECHOED_BUBBLE]);
  });

  test("a throwing echo guard fails open: the rewritten bubble is kept, not dropped or blocked", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, "hey\n\nso about that", {
      gateway,
      cfg: cfg(),
      input: INPUT,
      sleep: async () => {},
      transform: async () => ({ messages: ["hey", "so about that"] }),
      echoGuard: () => {
        throw new Error("boom");
      },
    });
    expect(posts.map((p) => p.text)).toEqual(["hey", "so about that"]);
  });

  test("the fallback still composes with ping repair: an echoed first bubble still gets the ping", async () => {
    const RO = "1151230208783945818";
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      input: INPUT,
      postOpts: { pingUserIds: [RO] },
      sleep: async () => {},
      transform: async () => ({ messages: [ECHOED_BUBBLE] }),
    });
    expect(posts[0]!.text).toBe(`<@${RO}>\n${ORIGINAL_TEXT}`);
  });
});

describe("deliverChilled — content substitution and injection (the 2026-08-21 incident)", () => {
  // Channel 1520986792373911622, 04:57:58.516Z: chilltext discarded the first block of the reply
  // and returned a verbatim `persona.md` sample line ("yeah that's broken. i know why. gimme 10")
  // instead. The second bubble was a faithful (here, verbatim) rewrite of the second block. Neither
  // `echoContentScore` nor `echoFullScore` caught it — both were 0, because the echo guard compares
  // against the USER's message, not against what the bubble was supposedly rewritten FROM.
  const BLOCK_1 =
    "classifier's actually going now — comedy counts as a reason to speak, serious rooms stay locked down";
  const BLOCK_2 = "also correcting myself from earlier: the image fix IS live, has been since 23:49. i said it wasn't";
  const FABRICATED_BUBBLE = "yeah that's broken. i know why. gimme 10";
  const TEXT = `${BLOCK_1}\n\n${BLOCK_2}`;

  test("substitution: the fabricated bubble never posts — the real block posts in its place, the other bubble posts as rewritten", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [FABRICATED_BUBBLE, BLOCK_2] }),
    });
    expect(posts.map((p) => p.text)).toEqual([BLOCK_1, BLOCK_2]);
    expect(posts.some((p) => p.text === FABRICATED_BUBBLE)).toBe(false);
  });

  test("the substitution is logged with its fidelity score and the fallback flag", async () => {
    const { gateway } = fakeGateway();
    const logPath = tmpLogPath();
    await deliverChilled(CHAN, TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [FABRICATED_BUBBLE, BLOCK_2] }),
      logPath,
    });
    const rows = readChillTransformLog(logPath);
    const bubbles = rows[0]!.bubbles!;
    const droppedEntry = bubbles.find((b) => b.rewritten === FABRICATED_BUBBLE);
    expect(droppedEntry).toBeDefined();
    expect(droppedEntry!.posted).toBeNull();
    expect(droppedEntry!.fidelityDropped).toBe(true);
    const fallbackEntry = bubbles.find((b) => b.posted === BLOCK_1);
    expect(fallbackEntry).toBeDefined();
    expect(fallbackEntry!.rewritten).toBeNull();
    expect(fallbackEntry!.fidelityFallback).toBe(true);
  });

  // The 2026-08-21 05:00:35.558Z widening: `agentOutput` had exactly two blank-line-separated
  // blocks, but chilltext returned THREE bubbles — the fabricated one PREPENDED ahead of two
  // faithful rewrites. A count mismatch, not just a content mismatch.
  test("injection: a surplus bubble ahead of two faithful ones is dropped — exactly two post, matching the two blocks", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [FABRICATED_BUBBLE, BLOCK_1, BLOCK_2] }),
    });
    expect(posts.map((p) => p.text)).toEqual([BLOCK_1, BLOCK_2]);
  });

  test("injection: the dropped surplus bubble never posts, in any position", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      // The fabricated bubble at the END this time, not the front — the structural check doesn't
      // care where the surplus bubble sits.
      transform: async () => ({ messages: [BLOCK_1, BLOCK_2, FABRICATED_BUBBLE] }),
    });
    expect(posts.map((p) => p.text)).toEqual([BLOCK_1, BLOCK_2]);
  });

  // The reverse of injection: FEWER bubbles than blocks. Silently dropping a real block would be
  // its own defect, so the unmatched block falls back to posting verbatim rather than vanishing.
  test("reverse: fewer bubbles than blocks — the block with no matching bubble still posts, verbatim", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      // Only ONE bubble came back, covering just the first block — the second block's content
      // never made it into anything chilltext returned.
      transform: async () => ({ messages: [BLOCK_1] }),
    });
    expect(posts.map((p) => p.text)).toEqual([BLOCK_1, BLOCK_2]);
  });

  test("a legitimate rewrite — different wording, same meaning — passes through unchanged, proving this isn't a blanket disable", async () => {
    const { gateway, posts } = fakeGateway();
    const block1 = "the giveaway form got filled and submitted, page came back with \"Unable to accept this submission.\" and nothing else";
    const block2 = "second attempt, same wall. \"Unable to accept this submission.\" and still no reason given";
    const rewrite1 = "the giveaway form got filled and submitted, then it just came back with \"unable to accept this submission\"";
    const rewrite2 = "second attempt, same wall. \"unable to accept this submission.\" and still no reason";
    await deliverChilled(CHAN, `${block1}\n\n${block2}`, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [rewrite1, rewrite2] }),
    });
    expect(posts.map((p) => p.text)).toEqual([rewrite1, rewrite2]);
  });

  test("a legitimate one-block-split-into-several-bubbles delivery is untouched", async () => {
    // chilltext's ordinary, harmless re-chunking: one paragraph split into three short bubbles.
    // None of them individually equals the block, but each is a genuine fragment of it.
    const { gateway, posts } = fakeGateway();
    const block =
      "grug get email. grug read email. grug not happy. grug write code because grug like write code. " +
      "grug ask with much respect: no send more email.";
    const bubbles = [
      "grug get email. grug read email. grug not happy.",
      "grug write code because grug like write code.",
      "grug ask with much respect: no send more email.",
    ];
    await deliverChilled(CHAN, block, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: bubbles }),
    });
    expect(posts.map((p) => p.text)).toEqual(bubbles);
  });
});

describe("deliverChilled — a bubble that echoes the rewrite's own instructions falls back", () => {
  // Channel 1520986792373911622, 2026-08-20 01:16: chilltext posted a fragment of its OWN
  // delivery-format instructions ("return only the rewritten chat message or messages, separated
  // by a blank line. use 1 to 4 messages total and never more than 4.") as if it were one of
  // Beckett's own bubbles, sandwiched between two legitimate ones.
  const LEAKED_INSTRUCTIONS =
    "return only the rewritten chat message or messages, separated by a blank line. use 1 to 4 " +
    "messages total and never more than 4.";
  const ORIGINAL_TEXT = "stopped. nothing deployed, nothing running, we're clean.";

  test("a response that is verbatim instruction text falls back to the original text", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [LEAKED_INSTRUCTIONS] }),
    });
    expect(posts.map((p) => p.text)).toEqual([ORIGINAL_TEXT]);
  });

  test("instruction text as ONE of several bubbles: only that bubble falls back, the rest post as rewritten", async () => {
    // The actual shape of the incident: the leak was the middle bubble of three, with two
    // legitimate bubbles either side of it in the same delivery.
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({
        messages: ["stopped. nothing deployed", LEAKED_INSTRUCTIONS, "i stopped, nothing's running."],
      }),
    });
    expect(posts.map((p) => p.text)).toEqual([
      "stopped. nothing deployed",
      ORIGINAL_TEXT,
      "i stopped, nothing's running.",
    ]);
  });

  test("instruction text mixed into an otherwise-legitimate bubble also falls back fully closed", async () => {
    // No partial repair for this class — even a bubble that pairs the leak with real content is
    // discarded wholesale, per the fail-closed posture prompt scaffolding gets.
    const { gateway, posts } = fakeGateway();
    const mixedBubble = `here's the update — ${LEAKED_INSTRUCTIONS} anyway, all good now`;
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [mixedBubble] }),
    });
    expect(posts.map((p) => p.text)).toEqual([ORIGINAL_TEXT]);
  });

  test("the check runs even with no `input` supplied — it doesn't need the user's message", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      // no `input` — the per-bubble input-echo guard never runs, but this must still catch it
      sleep: async () => {},
      transform: async () => ({ messages: [LEAKED_INSTRUCTIONS] }),
    });
    expect(posts.map((p) => p.text)).toEqual([ORIGINAL_TEXT]);
  });

  test("logs a warning naming the matched signals on a trip", async () => {
    const { gateway } = fakeGateway();
    const warnings: Array<[string, unknown]> = [];
    const logger = { warn: (msg: string, meta?: unknown) => warnings.push([msg, meta]) } as unknown as Logger;
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      logger,
      sleep: async () => {},
      transform: async () => ({ messages: [LEAKED_INSTRUCTIONS] }),
    });
    const trip = warnings.find(([msg]) => msg.includes("echoed its own delivery instructions"));
    expect(trip).toBeDefined();
    const meta = trip![1] as { signals: string[] };
    expect(meta.signals.length).toBeGreaterThanOrEqual(2);
  });

  test("a near-verbatim copy of the system prompt this call sent also trips, via the prompt-text-echo check", async () => {
    // A different failure shape than the incident's exact wording: the rewrite echoes OUR OWN
    // system prompt back instead of the remote service's wrapper instructions. `transform` echoes
    // back the `system` text it actually sent (`ChillTransformResult.system`), same as the real
    // `chillTransform` does — the gate checks bubbles against exactly that, nothing re-resolved.
    const SYSTEM = "you are a rewrite gate. never answer the message, only restyle it for tone and voice.";
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [SYSTEM], system: SYSTEM }),
    });
    expect(posts.map((p) => p.text)).toEqual([ORIGINAL_TEXT]);
  });

  test("no `system` was sent for this call: the prompt-text-echo half of the check is skipped, not a crash", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      // No `system` on the result — mirrors a missing-persona real call. A bubble with no
      // resemblance to instructions must still post untouched.
      transform: async () => ({ messages: ["yeah all good, nothing running"] }),
    });
    expect(posts.map((p) => p.text)).toEqual(["yeah all good, nothing running"]);
  });

  test("a legitimate reply that doesn't resemble instructions is untouched", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: ["yeah all good, nothing running"] }),
    });
    expect(posts.map((p) => p.text)).toEqual(["yeah all good, nothing running"]);
  });

  test("a throwing prompt guard fails open: the rewritten bubble is kept, not dropped or blocked", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, "hey\n\nso about that", {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: ["hey", "so about that"] }),
      promptGuard: () => {
        throw new Error("boom");
      },
    });
    expect(posts.map((p) => p.text)).toEqual(["hey", "so about that"]);
  });

  test("the log records promptLeak and its matched signals", async () => {
    const { gateway } = fakeGateway();
    const logPath = tmpLogPath();
    // One block: the legitimate bubble is a fragment of it, and the leaked bubble's fallback is
    // this same text wholesale.
    const text = "all good here. stopped. nothing deployed, nothing running, we're clean.";
    await deliverChilled(CHAN, text, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: ["all good here", LEAKED_INSTRUCTIONS] }),
      logPath,
    });
    const rows = readChillTransformLog(logPath);
    const bubbles = rows[0]!.bubbles!;
    expect(bubbles[0]).toEqual(
      expect.objectContaining({ rewritten: "all good here", posted: "all good here" }),
    );
    expect(bubbles[0]!.promptLeak).toBeUndefined();
    expect(bubbles[1]).toEqual(
      expect.objectContaining({ rewritten: LEAKED_INSTRUCTIONS, posted: text, promptLeak: true }),
    );
    expect(bubbles[1]!.promptLeakSignals!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("deliverChilled — a missing persona file never costs a message", () => {
  test("the real transform + a missing persona: the reply still lands, chilled, with no system", async () => {
    // No `transform` injected: this drives the REAL chillTransform (with a fake fetch) so the
    // persona read is on the path. The file does not exist — the send must survive that.
    const { gateway, posts } = fakeGateway();
    const missingPersona = join(mkdtempSync(join(tmpdir(), "beckett-gate-")), "gone.md");
    let sentBody: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["yeah it landed"] }), { status: 200 });
    }) as unknown as typeof fetch;

    const id = await deliverChilled(CHAN, "yeah, it landed on main and deployed clean.", {
      gateway,
      cfg: cfg(),
      personaPath: missingPersona,
      transform: (c, i) => chillTransform(c, i, fetchFn),
    });

    expect(sentBody.system).toBeUndefined(); // degraded to chilltext's own voice…
    expect(posts).toEqual([
      { channelId: CHAN, text: "yeah it landed", opts: { singleMessage: true } },
    ]); // …and the message still went out
    expect(id).toBe("msg-1");
  });

  test("a missing persona AND a dead chilltext: the original text still posts once", async () => {
    const { gateway, posts } = fakeGateway();
    const missingPersona = join(mkdtempSync(join(tmpdir(), "beckett-gate-")), "gone.md");
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const id = await deliverChilled(CHAN, "a normal reply that would have been chilled", {
      gateway,
      cfg: cfg(),
      personaPath: missingPersona,
      transform: (c, i) => chillTransform(c, i, fetchFn),
    });

    expect(posts).toEqual([
      { channelId: CHAN, text: "a normal reply that would have been chilled", opts: undefined },
    ]);
    expect(id).toBe("msg-1");
  });
});

describe("deliverChilled — chilltext transform transcript (logPath)", () => {
  test("no logPath given: nothing is logged, delivery is unaffected", async () => {
    const { gateway, posts } = fakeGateway();
    const id = await deliverChilled(CHAN, "a normal reply here", {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: ["hey there"] }),
    });
    expect(posts).toHaveLength(1);
    expect(id).toBe("msg-1");
  });

  test("a normal chilled transform writes one 'ok' record with input/before/after and per-bubble echo scores", async () => {
    const { gateway } = fakeGateway();
    const logPath = tmpLogPath();
    await deliverChilled(CHAN, "hey\n\nso about that", {
      gateway,
      cfg: cfg(),
      input: "what's the status",
      sleep: async () => {},
      transform: async () => ({ messages: ["hey", "so about that"] }),
      logPath,
    });
    const rows = readChillTransformLog(logPath);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.channelId).toBe(CHAN);
    expect(row.input).toBe("what's the status");
    expect(row.agentOutput).toBe("hey\n\nso about that");
    expect(row.outcome).toBe("ok");
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.bubbles).toEqual([
      {
        rewritten: "hey",
        posted: "hey",
        echoFallback: false,
        echoContentScore: expect.any(Number),
        echoFullScore: expect.any(Number),
        fidelityScore: expect.any(Number),
      },
      {
        rewritten: "so about that",
        posted: "so about that",
        echoFallback: false,
        echoContentScore: expect.any(Number),
        echoFullScore: expect.any(Number),
        fidelityScore: expect.any(Number),
      },
    ]);
  });

  test("a bypassed delivery writes a 'bypassed' record with no bubbles", async () => {
    const { gateway } = fakeGateway();
    const logPath = tmpLogPath();
    await deliverChilled(CHAN, "a normal reply here", {
      gateway,
      cfg: cfg({ enabled: false }),
      logPath,
    });
    const rows = readChillTransformLog(logPath);
    expect(rows).toEqual([
      expect.objectContaining({ channelId: CHAN, outcome: "bypassed", agentOutput: "a normal reply here", bubbles: null }),
    ]);
  });

  test("transform returns null: writes a 'fallback' record, not 'threw'", async () => {
    const { gateway } = fakeGateway();
    const logPath = tmpLogPath();
    await deliverChilled(CHAN, "would have been chilled", {
      gateway,
      cfg: cfg(),
      transform: async () => null,
      logPath,
    });
    const rows = readChillTransformLog(logPath);
    expect(rows).toEqual([expect.objectContaining({ outcome: "fallback", bubbles: null })]);
  });

  test("a throwing transform writes a 'threw' record", async () => {
    const { gateway } = fakeGateway();
    const logPath = tmpLogPath();
    await deliverChilled(CHAN, "would have been chilled", {
      gateway,
      cfg: cfg(),
      transform: async () => {
        throw new Error("boom");
      },
      logPath,
    });
    const rows = readChillTransformLog(logPath);
    expect(rows).toEqual([expect.objectContaining({ outcome: "threw", bubbles: null })]);
  });

  test("an echoed bubble is recorded with echoFallback true and its scores, alongside the un-echoed bubble", async () => {
    const INPUT =
      "right thats the correct flow. questions or like 90% of things should go to you, not me. " +
      "cuz imagine bothering the ceo with every task, you da cto so you gotta step up and be a leader lol.";
    const ECHOED_BUBBLE =
      "yeah that's the right flow. questions or like 90% of stuff should go to you, not me. " +
      "imagine bothering the ceo with every task, you're the cto, so you gotta step up and lead lol.";
    // One block: the legitimate bubble is a fragment of it, and the echoed bubble's fallback is
    // this same text wholesale.
    const ORIGINAL_TEXT = "all good here. the real reply beckett actually meant to send";
    const { gateway } = fakeGateway();
    const logPath = tmpLogPath();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      input: INPUT,
      sleep: async () => {},
      transform: async () => ({ messages: ["all good here", ECHOED_BUBBLE] }),
      logPath,
    });
    const rows = readChillTransformLog(logPath);
    const bubbles = rows[0]!.bubbles!;
    expect(bubbles[0]).toEqual(
      expect.objectContaining({ rewritten: "all good here", posted: "all good here", echoFallback: false }),
    );
    expect(bubbles[1]).toEqual(
      expect.objectContaining({ rewritten: ECHOED_BUBBLE, posted: ORIGINAL_TEXT, echoFallback: true }),
    );
    expect(bubbles[1]!.echoContentScore).toBeGreaterThanOrEqual(0.65);
  });

  test("a log-write failure never breaks delivery — the reply still posts", async () => {
    // The log's directory can't be created (its parent is a file, not a directory), so every
    // append fails — the delivery itself must still succeed exactly as it would with no logPath.
    const dir = mkdtempSync(join(tmpdir(), "beckett-gate-log-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const badLogPath = join(blocker, "chilltext-transforms.jsonl");
    const { gateway, posts } = fakeGateway();
    const warnings: Array<[string, unknown]> = [];
    const logger = { warn: (msg: string, meta?: unknown) => warnings.push([msg, meta]) } as unknown as Logger;

    const id = await deliverChilled(CHAN, "hey\n\nso about that", {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: ["hey", "so about that"] }),
      logPath: badLogPath,
      logger,
    });

    expect(posts.map((p) => p.text)).toEqual(["hey", "so about that"]);
    expect(id).toBe("msg-1");
    expect(warnings.some(([msg]) => msg.includes("chilltext transform log write failed"))).toBe(true);
  });
});


describe("deliverChilled — bubble idempotency", () => {
  test("the same deliveryId posts each bubble once even when deliverChilled is called twice", async () => {
    const { gateway, posts } = fakeGateway();
    const dedupe = new OutboundDedupe();
    const send = gateway.post.bind(gateway);
    gateway.post = (channelId, text, opts) =>
      dedupe.run(opts?.idempotencyKey, () => send(channelId, text, opts));
    const opts = {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: ["that's one approval, shipping it"] }),
      deliveryId: "turn:trigger-1",
    };
    const first = await deliverChilled(CHAN, "shipping it", opts);
    const second = await deliverChilled(CHAN, "shipping it", opts);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toBe("that's one approval, shipping it");
    expect(first).toBe(second);
    expect(posts[0]!.opts?.idempotencyKey).toBe(`turn:trigger-1:${CHAN}:0`);
  });
});
