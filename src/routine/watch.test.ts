import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchStateStore } from "./watch-store.ts";
import { runWatchCycle, previewWatchCycle, startWatchLoop, type WatchDeps } from "./watch.ts";
import { applyWatchCycleHealth } from "./dispatch-health.ts";
import type { ModelNewsFetchResult, ModelNewsItem } from "./model-news.ts";
import type { Routine } from "./types.ts";
import { emptyRoutineState } from "./types.ts";
import { RoutineStore } from "./store.ts";
import { quietLogger } from "../cli/io.ts";

const dirs: string[] = [];
const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpPath(prefix: string, file: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, file);
}

function makeItem(overrides: Partial<ModelNewsItem> = {}): ModelNewsItem {
  return {
    id: overrides.id ?? "item-1",
    title: "Claude added claude-opus-5",
    summary: "Anthropic shipped claude-opus-5.",
    tags: [],
    source: { url: "https://example.com/release" },
    publishedAt: "2026-07-25T11:00:00.000Z",
    newModel: true,
    models: ["claude-opus-5"],
    removedModels: [],
    ...overrides,
  };
}

function makeRoutine(action: Partial<Extract<Routine["action"], { kind: "watch" }>> = {}): Routine {
  return {
    id: "model-news-watch",
    name: "model news event watch",
    builtin: true,
    enabled: true,
    action: {
      kind: "watch",
      feedUrl: "https://ai-tracker.ssh.codes/api/v1/model-news",
      pollIntervalMinutes: 15,
      agentId: "social-media",
      credsEntry: "x-account",
      dryRun: false,
      ...action,
    },
    state: emptyRoutineState(),
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const NOW = new Date("2026-07-25T12:00:00.000Z");

function feedOf(items: ModelNewsItem[]): (url: string) => Promise<ModelNewsFetchResult> {
  return async () => ({ ok: true, items });
}

interface Harness {
  deps: WatchDeps;
  dispatchCalls: Array<{ agentId: string; agentInput: string; opts: { channelId: string; requesterId: string; credsEntry: string | null } }>;
  reportCalls: Array<{ channelId: string; text: string }>;
  stateStore: WatchStateStore;
}

function harness(opts: { fetchFeed?: (url: string) => Promise<ModelNewsFetchResult>; now?: () => Date } = {}): Harness {
  const now = opts.now ?? (() => NOW);
  // Inject the SAME clock the test uses into the store's own age-based pruning (`pruneState`
  // reads `this.now()` on every write) — otherwise pruning runs against the real wall clock
  // while everything else in the test is pinned to a fixed virtual `now`, and fixture posts
  // silently age out of the 30-day window as real time marches on. That mismatch is exactly
  // what caused the rate-limit test to flake in CI once real time passed 30 days post-2026-07-25.
  const stateStore = new WatchStateStore(tmpPath("beckett-watch-", "watch-state.json"), { now });
  const dispatchCalls: Harness["dispatchCalls"] = [];
  const reportCalls: Harness["reportCalls"] = [];
  const deps: WatchDeps = {
    stateStore,
    fetchFeed: opts.fetchFeed ?? feedOf([]),
    now,
    dispatchAgent: async (agentId, agentInput, o) => {
      dispatchCalls.push({ agentId, agentInput, opts: o });
    },
    reportChannel: async (channelId, text) => {
      reportCalls.push({ channelId, text });
    },
    defaultOrigin: () => ({ channelId: "chan-1", requesterId: "user-1" }),
    logger: quietLogger,
  };
  return { deps, dispatchCalls, reportCalls, stateStore };
}

// ── seed-no-backfill (cold start) ───────────────────────────────────────────────────────────

test("a cold start seeds every current feed item as seen and posts nothing", async () => {
  const items = [makeItem({ id: "a" }), makeItem({ id: "b", models: ["other-model"] })];
  const h = harness({ fetchFeed: feedOf(items) });
  const routine = makeRoutine();

  const result = await runWatchCycle(routine, h.deps);

  expect(result.status).toBe("seeded");
  expect(h.dispatchCalls).toHaveLength(0);
  expect(h.reportCalls).toHaveLength(0);
  const state = await h.stateStore.get(routine.id);
  expect(state.seeded).toBe(true);
  expect(state.seenIds.map((s) => s.id).sort()).toEqual(["a", "b"]);
  expect(state.posts).toHaveLength(0);
});

test("after the cold start, the SAME items that were seeded never qualify later", async () => {
  const items = [makeItem({ id: "a" })];
  const h = harness({ fetchFeed: feedOf(items) });
  const routine = makeRoutine();

  await runWatchCycle(routine, h.deps); // seeds
  const second = await runWatchCycle(routine, h.deps); // same feed, still "new" by publishedAt

  expect(second.status).toBe("no-qualifying");
  expect(h.dispatchCalls).toHaveLength(0);
});

// ── qualification → real dispatch ───────────────────────────────────────────────────────────

test("a genuinely new item after seeding dispatches the agent lane with title/models/summary/source", async () => {
  const h = harness({ fetchFeed: feedOf([]) });
  const routine = makeRoutine();
  await runWatchCycle(routine, h.deps); // seed on empty feed

  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh", models: ["claude-opus-5"] })]);
  const result = await runWatchCycle(routine, h.deps);

  expect(result.status).toBe("posted");
  expect(result.postedModelId).toBe("claude-opus-5");
  expect(h.dispatchCalls).toHaveLength(1);
  expect(h.dispatchCalls[0]!.agentId).toBe("social-media");
  expect(h.dispatchCalls[0]!.agentInput).toContain("claude-opus-5");
  expect(h.dispatchCalls[0]!.agentInput).toContain("Claude added claude-opus-5");
  expect(h.dispatchCalls[0]!.agentInput).toContain("https://example.com/release");
  expect(h.dispatchCalls[0]!.opts).toEqual({ channelId: "chan-1", requesterId: "user-1", credsEntry: "x-account" });

  const state = await h.stateStore.get(routine.id);
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]!.modelId).toBe("claude-opus-5");
  expect(state.posts[0]!.simulated).toBe(false);
});

// ── dedup by model id ────────────────────────────────────────────────────────────────────────

test("never posts twice about the same model id, even from two different feed items", async () => {
  const h = harness({ fetchFeed: feedOf([]) });
  const routine = makeRoutine();
  await runWatchCycle(routine, h.deps);

  h.deps.fetchFeed = feedOf([makeItem({ id: "first", models: ["claude-opus-5"] })]);
  const first = await runWatchCycle(routine, h.deps);
  expect(first.status).toBe("posted");

  // A second, DIFFERENT feed item announcing the SAME model id.
  h.deps.fetchFeed = feedOf([makeItem({ id: "second", models: ["claude-opus-5"] })]);
  const second = await runWatchCycle(routine, h.deps);

  expect(second.status).toBe("no-qualifying");
  expect(second.droppedModelIds).toEqual(["claude-opus-5"]);
  expect(h.dispatchCalls).toHaveLength(1); // still just the one real post
});

test("extra qualifying items in the same round are dropped, not queued", async () => {
  const h = harness({ fetchFeed: feedOf([]) });
  const routine = makeRoutine();
  await runWatchCycle(routine, h.deps);

  h.deps.fetchFeed = feedOf([
    makeItem({ id: "later", models: ["model-b"], publishedAt: "2026-07-25T11:30:00.000Z" }),
    makeItem({ id: "earlier", models: ["model-a"], publishedAt: "2026-07-25T10:00:00.000Z" }),
  ]);
  const result = await runWatchCycle(routine, h.deps);

  expect(result.status).toBe("posted");
  // Oldest-published wins the round; the other is dropped, not queued for next round.
  expect(result.postedModelId).toBe("model-a");
  expect(result.droppedModelIds).toEqual(["model-b"]);
  expect(h.dispatchCalls).toHaveLength(1);

  // The dropped item is marked seen too — it will never be reconsidered.
  const state = await h.stateStore.get(routine.id);
  expect(state.seenIds.map((s) => s.id)).toContain("later");
});

// ── rate limiting ────────────────────────────────────────────────────────────────────────────

test("a qualifying item is dropped, not posted, once the rate limit is reached", async () => {
  const h = harness({ fetchFeed: feedOf([]) });
  const routine = makeRoutine();
  await runWatchCycle(routine, h.deps);
  // Pre-seed 3 posts within the trailing 24h (the hard 3/24h cap).
  await h.stateStore.update(routine.id, (s) => ({
    ...s,
    posts: [
      { modelId: "m1", postedAt: "2026-07-25T02:00:00.000Z", url: null, simulated: false },
      { modelId: "m2", postedAt: "2026-07-25T05:00:00.000Z", url: null, simulated: false },
      { modelId: "m3", postedAt: "2026-07-25T08:00:00.000Z", url: null, simulated: false },
    ],
  }));

  h.deps.fetchFeed = feedOf([makeItem({ id: "blocked", models: ["m4"] })]);
  const result = await runWatchCycle(routine, h.deps);

  expect(result.status).toBe("rate-limited");
  expect(result.droppedModelIds).toEqual(["m4"]);
  expect(h.dispatchCalls).toHaveLength(0);
});

test("never more than 1 event post per hour", async () => {
  const h = harness({ fetchFeed: feedOf([]) });
  const routine = makeRoutine();
  await runWatchCycle(routine, h.deps);
  await h.stateStore.update(routine.id, (s) => ({
    ...s,
    posts: [{ modelId: "m1", postedAt: "2026-07-25T11:45:00.000Z", url: null, simulated: false }],
  }));

  h.deps.fetchFeed = feedOf([makeItem({ id: "too-soon", models: ["m2"] })]);
  const result = await runWatchCycle(routine, h.deps);

  expect(result.status).toBe("rate-limited");
  expect(h.dispatchCalls).toHaveLength(0);
});

// ── broken feed ──────────────────────────────────────────────────────────────────────────────

test("a broken feed logs, skips the round, and never posts", async () => {
  const h = harness({ fetchFeed: async () => ({ ok: false, reason: "HTTP 503" }) });
  const routine = makeRoutine();

  const result = await runWatchCycle(routine, h.deps);

  expect(result.status).toBe("feed-error");
  expect(h.dispatchCalls).toHaveLength(0);
  const state = await h.stateStore.get(routine.id);
  expect(state.seeded).toBe(false); // never even reached the cold-start seed
});

// ── dry-run ──────────────────────────────────────────────────────────────────────────────────

test("dry-run reports a preview line and never dispatches the agent", async () => {
  const h = harness({ fetchFeed: feedOf([]) });
  const routine = makeRoutine({ dryRun: true });
  await runWatchCycle(routine, h.deps);

  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh", models: ["claude-opus-5"] })]);
  const result = await runWatchCycle(routine, h.deps);

  expect(result.status).toBe("dry-run-posted");
  expect(h.dispatchCalls).toHaveLength(0);
  expect(h.reportCalls).toHaveLength(1);
  expect(h.reportCalls[0]!.text).toContain("[dry-run]");
  expect(h.reportCalls[0]!.text).toContain("claude-opus-5");

  const state = await h.stateStore.get(routine.id);
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]!.simulated).toBe(true);
});

test("flipping dry-run back off does not treat a simulated post as a real one", async () => {
  const h = harness({ fetchFeed: feedOf([]) });
  const dryRoutine = makeRoutine({ dryRun: true });
  await runWatchCycle(dryRoutine, h.deps);
  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh", models: ["claude-opus-5"] })]);
  await runWatchCycle(dryRoutine, h.deps); // simulated post recorded

  const liveRoutine = makeRoutine({ dryRun: false });
  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh-2", models: ["claude-opus-5"] })]);
  const result = await runWatchCycle(liveRoutine, h.deps);

  expect(result.status).toBe("posted");
  expect(h.dispatchCalls).toHaveLength(1);
});

// ── previewWatchCycle: read-only ────────────────────────────────────────────────────────────

test("previewWatchCycle never mutates state or dispatches, even when it would post", async () => {
  const h = harness({ fetchFeed: feedOf([]) });
  const routine = makeRoutine();
  await runWatchCycle(routine, h.deps);

  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh", models: ["claude-opus-5"] })]);
  const before = await h.stateStore.get(routine.id);
  const preview = await previewWatchCycle(routine, h.deps);

  expect(preview.wouldPost).toBe(true);
  expect(preview.modelId).toBe("claude-opus-5");
  expect(preview.agentSubject).toContain("claude-opus-5");
  expect(h.dispatchCalls).toHaveLength(0);
  expect(h.reportCalls).toHaveLength(0);
  const after = await h.stateStore.get(routine.id);
  expect(after).toEqual(before);
});

test("previewWatchCycle on a cold start reports what a real round would seed, without seeding", async () => {
  const h = harness({ fetchFeed: feedOf([makeItem({ id: "a" }), makeItem({ id: "b" })]) });
  const routine = makeRoutine();

  const preview = await previewWatchCycle(routine, h.deps);

  expect(preview.wouldPost).toBe(false);
  expect(preview.status).toBe("seeded");
  const state = await h.stateStore.get(routine.id);
  expect(state.seeded).toBe(false);
});

// ── startWatchLoop: enable/disable takes effect live, interval gating ──────────────────────────

test("the loop polls a due watch routine and skips a disabled one, live off the store", async () => {
  const routineStore = new RoutineStore(tmpPath("beckett-routines-", "routines.json"), { seedBuiltins: false });
  await routineStore.add({ id: "w1", name: "w1", enabled: true, action: makeRoutine().action });
  await routineStore.add({ id: "w2", name: "w2", enabled: false, action: makeRoutine().action });

  const h = harness({ fetchFeed: feedOf([]) });
  const loop = startWatchLoop({ routineStore, watchDeps: h.deps, now: () => NOW, intervalMs: 10_000_000 });
  stoppers.push(loop.stop);

  await loop.tick();

  const w1 = await h.stateStore.get("w1");
  const w2 = await h.stateStore.get("w2");
  expect(w1.seeded).toBe(true); // enabled, never polled → cold-start round ran
  expect(w2.seeded).toBe(false); // disabled → never touched
});

test("a routine is not re-polled before its own pollIntervalMinutes has elapsed", async () => {
  const routineStore = new RoutineStore(tmpPath("beckett-routines-", "routines.json"), { seedBuiltins: false });
  await routineStore.add({
    id: "w1",
    name: "w1",
    enabled: true,
    action: makeRoutine({ pollIntervalMinutes: 15 }).action,
  });

  let now = NOW;
  const h = harness({ fetchFeed: feedOf([]), now: () => now });
  const loop = startWatchLoop({ routineStore, watchDeps: h.deps, now: () => now, intervalMs: 10_000_000 });
  stoppers.push(loop.stop);

  await loop.tick(); // seeds
  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh", models: ["claude-opus-5"] })]);

  now = new Date(NOW.getTime() + 5 * 60_000); // only 5 of 15 minutes elapsed
  await loop.tick();
  expect(h.dispatchCalls).toHaveLength(0);

  now = new Date(NOW.getTime() + 16 * 60_000); // now past the interval
  await loop.tick();
  expect(h.dispatchCalls).toHaveLength(1);
});

test("enable/disable takes effect on the very next tick with no restart", async () => {
  const routineStore = new RoutineStore(tmpPath("beckett-routines-", "routines.json"), { seedBuiltins: false });
  await routineStore.add({ id: "w1", name: "w1", enabled: true, action: makeRoutine().action });

  const h = harness({ fetchFeed: feedOf([]) });
  const loop = startWatchLoop({ routineStore, watchDeps: h.deps, now: () => NOW, intervalMs: 10_000_000 });
  stoppers.push(loop.stop);

  await loop.tick(); // seeds while enabled
  await routineStore.setEnabled("w1", false);

  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh", models: ["claude-opus-5"] })]);
  await loop.tick(); // would be due, but now disabled
  expect(h.dispatchCalls).toHaveLength(0);
});

function attachHealth(h: Harness, routineStore: RoutineStore, alerts: string[]): void {
  h.deps.reportHealth = async (event) => {
    const routine = await routineStore.get(event.routineId);
    if (!routine) return;
    const update = applyWatchCycleHealth(routine.state, event.routineId, event.at, event.dispatch);
    await routineStore.setState(event.routineId, update.state);
    if (update.alert) alerts.push(update.alert);
  };
}

test("a watch agent-dispatch failure alerts once, persists, and does not look like ok", async () => {
  const routineStore = new RoutineStore(tmpPath("beckett-routines-", "routines.json"), { seedBuiltins: false });
  await routineStore.add({ id: "model-news-watch", name: "w", enabled: true, action: makeRoutine().action });

  const alerts: string[] = [];
  const h = harness({ fetchFeed: feedOf([]) });
  attachHealth(h, routineStore, alerts);
  h.deps.dispatchAgent = async () => {
    throw new Error("agent social-media is not registered\n    at dispatchAgentLane (routines.ts:1:1)");
  };

  await runWatchCycle(makeRoutine(), h.deps); // seed
  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh", models: ["claude-opus-5"] })]);
  await expect(runWatchCycle(makeRoutine(), h.deps)).rejects.toThrow(/not registered/);

  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("`model-news-watch`");
  expect(alerts[0]).toContain("not registered");
  expect(alerts[0]).not.toContain("at dispatchAgentLane");
  const failed = (await routineStore.get("model-news-watch"))!;
  expect(failed.state.lastOutcome).toBe("failed");
  expect(failed.state.consecutiveFailures).toBe(1);
  expect(failed.state.lastFiredAt).not.toBeNull();
  expect(failed.state.lastSucceededAt).toBeNull();
  expect(failed.state.lastError).toBe("agent social-media is not registered");

  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh-2", models: ["claude-sonnet-5"] })]);
  await expect(runWatchCycle(makeRoutine(), h.deps)).rejects.toThrow(/not registered/);
  expect(alerts).toHaveLength(1);
  expect((await routineStore.get("model-news-watch"))!.state.consecutiveFailures).toBe(2);

  h.deps.dispatchAgent = async () => {};
  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh-3", models: ["claude-haiku-5"] })]);
  const recovered = await runWatchCycle(makeRoutine(), h.deps);
  expect(recovered.status).toBe("posted");
  expect(alerts).toHaveLength(2);
  expect(alerts[1]).toMatch(/dispatched again after 2 misses/);
  const ok = (await routineStore.get("model-news-watch"))!;
  expect(ok.state.lastOutcome).toBe("ok");
  expect(ok.state.consecutiveFailures).toBe(0);
  expect(ok.state.lastSucceededAt).not.toBeNull();
  expect(ok.state.lastError).toBeNull();
});

test("the watch poll loop records lastFiredAt on a quiet tick and a failing dispatch on a hit", async () => {
  const routineStore = new RoutineStore(tmpPath("beckett-routines-", "routines.json"), { seedBuiltins: false });
  await routineStore.add({
    id: "model-news-watch",
    name: "w",
    enabled: true,
    action: makeRoutine({ pollIntervalMinutes: 1 }).action,
  });
  const alerts: string[] = [];
  let now = NOW;
  const h = harness({ fetchFeed: feedOf([]), now: () => now });
  attachHealth(h, routineStore, alerts);
  const loop = startWatchLoop({
    routineStore,
    watchDeps: h.deps,
    now: () => now,
    intervalMs: 10_000_000,
  });
  stoppers.push(loop.stop);

  await loop.tick(); // seed — lastFiredAt set, lastOutcome not ok
  const seeded = (await routineStore.get("model-news-watch"))!;
  expect(seeded.state.lastFiredAt).toBe(NOW.toISOString());
  expect(seeded.state.lastOutcome).toBeNull();

  h.deps.dispatchAgent = async () => {
    throw new Error("lane exploded");
  };
  h.deps.fetchFeed = feedOf([makeItem({ id: "fresh", models: ["claude-opus-5"] })]);
  now = new Date(NOW.getTime() + 2 * 60_000);
  await loop.tick();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain("`model-news-watch`");
  const failed = (await routineStore.get("model-news-watch"))!;
  expect(failed.state.lastOutcome).toBe("failed");
  expect(failed.state.consecutiveFailures).toBe(1);
});
