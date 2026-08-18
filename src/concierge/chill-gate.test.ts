/**
 * The chilltext delivery gate (`src/concierge/chill-gate.ts`): multi-bubble posting order/opts,
 * and the fallback to one plain post on bypass or transform failure. `transform` is injected in
 * every chilled-path test, so no network is ever touched here.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverChilled } from "./chill-gate.ts";
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
    const id = await deliverChilled(CHAN, "the original long reply", {
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
    const id = await deliverChilled(CHAN, "short-ish reply that got chilled", {
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
    await deliverChilled(CHAN, "the original long reply", {
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
    expect(recorded.some(([, text]) => text === "the original long reply")).toBe(false);
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
    await deliverChilled(CHAN, `<@${RO}>\nlong reply`, {
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
    await deliverChilled(CHAN, "just a normal reply", {
      gateway,
      cfg: cfg(),
      postOpts: { replyToMessageId: "m1" },
      sleep: async () => {},
      transform: async () => ({ messages: ["yeah all good", "talk soon"] }),
    });
    expect(posts.map((p) => p.text)).toEqual(["yeah all good", "talk soon"]);
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
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
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
      ORIGINAL_TEXT,
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
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
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
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
      gateway,
      cfg: cfg(),
      sleep: async () => {},
      transform: async () => ({ messages: [ECHOED_BUBBLE] }),
    });
    expect(posts.map((p) => p.text)).toEqual([ECHOED_BUBBLE]);
  });

  test("a throwing echo guard fails open: the rewritten bubble is kept, not dropped or blocked", async () => {
    const { gateway, posts } = fakeGateway();
    await deliverChilled(CHAN, ORIGINAL_TEXT, {
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

    const id = await deliverChilled(CHAN, "a normal reply that would have been chilled", {
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
