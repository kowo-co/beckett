/**
 * Issue #235, half two — a link-bearing mention must not reach the turn before Discord has
 * unfurled it. Beckett answering "nothing came through on my end" was a race, not a fact: the
 * embed lands a beat after MESSAGE_CREATE, and nothing re-read the message.
 */

import { expect, test } from "bun:test";
import { EMBED_SETTLE_MS, hasBareUrl, settleEmbeds } from "./embed-settle.ts";

function fake(over: Record<string, unknown> = {}) {
  const state = {
    content: "look at this https://example.com/post",
    embeds: [] as unknown[],
    createdTimestamp: 1_000,
    fetches: 0,
    fetch: async (force?: boolean) => {
      state.fetches++;
      state.forced = force;
      return { ...state, embeds: [{ title: "A post", url: "https://example.com/post" }] };
    },
    forced: undefined as boolean | undefined,
    ...over,
  };
  return state;
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

test("a bare URL with no embed yet is re-read after the settle wait", async () => {
  sleeps.length = 0;
  const msg = fake();
  const settled = await settleEmbeds(msg, { sleep, now: () => 1_000 });
  expect(sleeps).toEqual([EMBED_SETTLE_MS]);
  expect(msg.fetches).toBe(1);
  expect(msg.forced).toBe(true);
  expect(settled.embeds).toHaveLength(1);
});

test("a message that already carries its embed is never delayed or re-read", async () => {
  sleeps.length = 0;
  const msg = fake({ embeds: [{ title: "already here" }] });
  await settleEmbeds(msg, { sleep, now: () => 1_000 });
  expect(sleeps).toEqual([]);
  expect(msg.fetches).toBe(0);
});

test("a message with no link is never delayed", async () => {
  sleeps.length = 0;
  const msg = fake({ content: "how did the deploy go?" });
  await settleEmbeds(msg, { sleep, now: () => 1_000 });
  expect(sleeps).toEqual([]);
  expect(msg.fetches).toBe(0);
});

test("an old message is a fact, not a race — downtime catch-up never sleeps per link", async () => {
  sleeps.length = 0;
  const msg = fake({ createdTimestamp: 0 });
  await settleEmbeds(msg, { sleep, now: () => 10 * 60_000 });
  expect(sleeps).toEqual([]);
  expect(msg.fetches).toBe(0);
});

test("a failed re-read degrades to the message already in hand", async () => {
  const msg = fake({
    fetch: async () => {
      throw new Error("unknown message");
    },
  });
  const settled = await settleEmbeds(msg, { sleep, now: () => 1_000 });
  expect(settled).toBe(msg);
});

test("a message double with no fetch method (a test fake, a partial) is left exactly alone", async () => {
  sleeps.length = 0;
  const msg = { content: "https://example.com", embeds: [] as unknown[] };
  expect(await settleEmbeds(msg, { sleep })).toBe(msg);
  expect(sleeps).toEqual([]);
});

test("hasBareUrl ignores links Discord would not unfurl anyway", () => {
  expect(hasBareUrl("see https://example.com/post")).toBe(true);
  expect(hasBareUrl("see http://example.com")).toBe(true);
  expect(hasBareUrl("see <https://example.com/post>")).toBe(false);
  expect(hasBareUrl("run `curl https://example.com`")).toBe(false);
  expect(hasBareUrl("```\nhttps://example.com\n```")).toBe(false);
  expect(hasBareUrl("no links here")).toBe(false);
  expect(hasBareUrl(undefined)).toBe(false);
});
