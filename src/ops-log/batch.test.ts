import { describe, expect, test } from "bun:test";
import { buildBatchMessage, createOpsLogBatcher, DEFAULT_MAX_QUEUED } from "./batch.ts";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;

/** A manual scheduler: nothing fires until the test says so. */
function manualScheduler() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    pending: () => timers.filter((t) => !t.cancelled),
    fire: () => {
      for (const timer of timers.filter((t) => !t.cancelled)) {
        timer.cancelled = true;
        timer.fn();
      }
    },
  };
}

function harness(overrides: { maxChars?: number; maxQueued?: number; failPost?: boolean } = {}) {
  const posts: string[] = [];
  let failing = overrides.failPost ?? false;
  const timers = manualScheduler();
  let clock = 1_000_000;
  const batcher = createOpsLogBatcher({
    post: async (content) => {
      if (failing) throw new Error("discord is down");
      posts.push(content);
    },
    logger: quiet,
    now: () => clock,
    schedule: timers.schedule,
    ...(overrides.maxChars ? { maxChars: overrides.maxChars } : {}),
    ...(overrides.maxQueued ? { maxQueued: overrides.maxQueued } : {}),
  });
  return {
    batcher,
    posts,
    timers,
    advance: (ms: number) => (clock += ms),
    setFailing: (v: boolean) => (failing = v),
  };
}

describe("batching window", () => {
  test("a single push arms exactly one timer at the 2s default window", () => {
    const { batcher, timers } = harness();
    batcher.push("line one");
    expect(timers.pending().length).toBe(1);
    expect(timers.pending()[0]!.ms).toBe(2_000);
  });

  test("pushes inside the same window join into ONE message on flush", async () => {
    const { batcher, timers, posts } = harness();
    batcher.push("⚙ concierge online (claude-sonnet-5)");
    batcher.push("▶ browser lease acquired run-1");
    // A second push before the timer fires must NOT arm a second timer.
    expect(timers.pending().length).toBe(1);
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(posts).toEqual(["⚙ concierge online (claude-sonnet-5)\n▶ browser lease acquired run-1"]);
  });

  test("a push after a flush opens a fresh window", async () => {
    const { batcher, timers, posts } = harness();
    batcher.push("first");
    timers.fire();
    await batcher.flush();
    batcher.push("second");
    expect(timers.pending().length).toBe(1);
    timers.fire();
    await Promise.resolve();
    expect(posts).toEqual(["first", "second"]);
  });

  test("an empty queue never posts", async () => {
    const { batcher, posts } = harness();
    await batcher.flush();
    expect(posts).toEqual([]);
  });
});

describe("char cap", () => {
  test("buildBatchMessage stays under maxChars and reports the drop count", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(5));
    const msg = buildBatchMessage(lines, 200);
    expect(msg.length).toBeLessThanOrEqual(200);
    expect(msg).toMatch(/… \+\d+ more$/);
  });

  test("lines that fit exactly are never truncated", () => {
    const msg = buildBatchMessage(["a", "b", "c"], 1_900);
    expect(msg).toBe("a\nb\nc");
  });

  test("an already-huge single line still returns something within budget when nothing else fits", () => {
    const msg = buildBatchMessage(["x".repeat(50)], 10, 3);
    // Nothing kept — the pre-existing drop count alone is reported.
    expect(msg).toBe("… +4 more");
  });

  test("the batcher enforces the char cap end to end", async () => {
    const { batcher, timers, posts } = harness({ maxChars: 40 });
    for (let i = 0; i < 10; i++) batcher.push(`event number ${i} happened just now`);
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(posts.length).toBe(1);
    expect(posts[0]!.length).toBeLessThanOrEqual(40);
    expect(posts[0]).toContain("more");
  });
});

describe("bounded queue + drop counter", () => {
  test("pushes beyond maxQueued are dropped and counted, not stored", async () => {
    const { batcher, timers, posts } = harness({ maxQueued: 3, maxChars: 1_900 });
    for (let i = 0; i < 10; i++) batcher.push(`line ${i}`);
    expect(batcher.queued()).toBe(3);
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(posts.length).toBe(1);
    expect(posts[0]).toBe("line 0\nline 1\nline 2\n… +7 more");
  });

  test("the default bound is a real ceiling, not unlimited", () => {
    const { batcher } = harness();
    for (let i = 0; i < DEFAULT_MAX_QUEUED + 50; i++) batcher.push(`line ${i}`);
    expect(batcher.queued()).toBe(DEFAULT_MAX_QUEUED);
  });
});

describe("fails open", () => {
  test("a throwing poster never rejects flush() and drops the batch silently", async () => {
    const { batcher, timers, posts } = harness({ failPost: true });
    batcher.push("this will fail to post");
    timers.fire();
    await expect(batcher.flush()).resolves.toBeUndefined();
    expect(posts).toEqual([]);
  });

  test("a failed flush does not wedge the next window", async () => {
    const { batcher, timers, posts, setFailing } = harness({ failPost: true });
    batcher.push("first (fails)");
    timers.fire();
    await batcher.flush();
    setFailing(false);
    batcher.push("second (succeeds)");
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(posts).toEqual(["second (succeeds)"]);
  });

  test("flushNow cancels the pending timer and flushes immediately", async () => {
    const { batcher, timers, posts } = harness();
    batcher.push("urgent");
    expect(timers.pending().length).toBe(1);
    await batcher.flushNow();
    expect(timers.pending().length).toBe(0);
    expect(posts).toEqual(["urgent"]);
  });
});
