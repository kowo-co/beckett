import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchStateStore, WATCH_SEEN_CAP } from "./watch-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(now?: () => Date): { path: string; store: WatchStateStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-watch-store-"));
  dirs.push(dir);
  const path = join(dir, "watch-state.json");
  return { path, store: new WatchStateStore(path, now ? { now } : {}) };
}

test("an unpolled routine reads as the empty default", async () => {
  const { store } = makeStore();
  const state = await store.get("model-news-watch");
  expect(state).toEqual({ seeded: false, seenIds: [], posts: [], lastPolledAt: null });
});

test("update() persists and is readable back from a NEW store instance (restart safety)", async () => {
  // Fixed clock: `update()` prunes seenIds older than WATCH_SEEN_MAX_AGE_MS against `now()`, so a
  // real wall clock would eventually age the fixture's firstSeenAt out from under this test.
  const NOW = () => new Date("2026-07-25T00:00:00.000Z");
  const { path, store } = makeStore(NOW);
  await store.update("model-news-watch", (s) => ({
    ...s,
    seeded: true,
    seenIds: [...s.seenIds, { id: "a", firstSeenAt: "2026-07-25T00:00:00.000Z" }],
    lastPolledAt: "2026-07-25T00:00:00.000Z",
  }));

  const restarted = new WatchStateStore(path, { now: NOW });
  const state = await restarted.get("model-news-watch");
  expect(state.seeded).toBe(true);
  expect(state.seenIds).toEqual([{ id: "a", firstSeenAt: "2026-07-25T00:00:00.000Z" }]);
});

test("different routines get independent state", async () => {
  const { store } = makeStore();
  await store.update("a", (s) => ({ ...s, seeded: true }));
  expect((await store.get("a")).seeded).toBe(true);
  expect((await store.get("b")).seeded).toBe(false);
});

test("seen-set is capped so a feed that never stops growing can't grow the file without limit", async () => {
  const NOW = () => new Date("2026-07-25T00:00:00.000Z");
  const { store } = makeStore(NOW);
  const many = Array.from({ length: WATCH_SEEN_CAP + 50 }, (_, i) => ({
    id: `item-${i}`,
    firstSeenAt: "2026-07-25T00:00:00.000Z",
  }));
  await store.update("model-news-watch", (s) => ({ ...s, seenIds: [...s.seenIds, ...many] }));
  const state = await store.get("model-news-watch");
  expect(state.seenIds.length).toBe(WATCH_SEEN_CAP);
  // The newest entries are kept, not the oldest.
  expect(state.seenIds.at(-1)!.id).toBe(`item-${WATCH_SEEN_CAP + 49}`);
});

test("seen entries older than the age bound are pruned on the next write", async () => {
  const now = () => new Date("2026-07-25T00:00:00.000Z");
  const { store } = makeStore(now);
  await store.update("model-news-watch", (s) => ({
    ...s,
    seenIds: [
      { id: "stale", firstSeenAt: "2026-01-01T00:00:00.000Z" },
      { id: "fresh", firstSeenAt: "2026-07-24T00:00:00.000Z" },
    ],
  }));
  const state = await store.get("model-news-watch");
  expect(state.seenIds.map((s) => s.id)).toEqual(["fresh"]);
});

test("post history older than the age bound is pruned on the next write", async () => {
  const now = () => new Date("2026-07-25T00:00:00.000Z");
  const { store } = makeStore(now);
  await store.update("model-news-watch", (s) => ({
    ...s,
    posts: [
      { modelId: "old-model", postedAt: "2026-01-01T00:00:00.000Z", url: null, simulated: false },
      { modelId: "recent-model", postedAt: "2026-07-24T00:00:00.000Z", url: null, simulated: false },
    ],
  }));
  const state = await store.get("model-news-watch");
  expect(state.posts.map((p) => p.modelId)).toEqual(["recent-model"]);
});
