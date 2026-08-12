/**
 * The chilltext delivery gate (`src/concierge/chill-gate.ts`): multi-bubble posting order/opts,
 * and the fallback to one plain post on bypass or transform failure. `transform` is injected in
 * every chilled-path test, so no network is ever touched here.
 */

import { describe, expect, test } from "bun:test";
import { deliverChilled } from "./chill-gate.ts";
import type { ChilltextConfig, ChillTransformResult } from "../chilltext.ts";
import type { DiscordGateway, ReplyOptions } from "../types.ts";

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
});
