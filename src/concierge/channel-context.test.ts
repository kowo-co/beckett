/**
 * OPS-80 §3 — channel-scoped shared context store. Pins the store's contract:
 * bounded (count cap + TTL) attributed windows persisted as per-channel JSONL,
 * compaction rewrites, restart survival, sessionId-keyed watermarks, wipe, and the
 * never-throw / never-traverse hardening (capture must never break a turn).
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelContextStore } from "./channel-context.ts";
import type { ChannelContextStoreOptions, ChannelEntry } from "./channel-context.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function tempChannelsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-channel-context-"));
  tmpDirs.push(dir);
  return join(dir, "channels");
}

function makeStore(overrides: Partial<ChannelContextStoreOptions> = {}) {
  const channelsDir = overrides.channelsDir ?? tempChannelsDir();
  const store = createChannelContextStore({
    channelsDir,
    maxEntriesPerChannel: 50,
    maxAgeHours: 24,
    logger: quietLog,
    ...overrides,
  });
  return { store, channelsDir };
}

function entry(messageId: string, ts: number, over: Partial<ChannelEntry> = {}): ChannelEntry {
  return {
    messageId,
    ts,
    authorId: "224712345678901234",
    authorName: "Jason",
    content: `msg ${messageId}`,
    kind: "user",
    ...over,
  };
}

function fileLines(channelsDir: string, channelId: string): string[] {
  return readFileSync(join(channelsDir, `${channelId}.jsonl`), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim());
}

// ── round-trip ──────────────────────────────────────────────────────────────────────────

test("append → recent round-trips all fields in order", () => {
  const { store } = makeStore({ now: () => 10_000 });
  const a = entry("m1", 1_000, { repliedToId: "prior-message" });
  const b = entry("m2", 2_000, { authorId: "beckett", authorName: "beckett", kind: "beckett" });
  const c = entry("m3", 3_000, { authorName: "angry worm", content: "it 502s for me too" });
  store.append("chan", a);
  store.append("chan", b);
  store.append("chan", c);

  const got = store.recent("chan");
  expect(got).toEqual([a, b, c]);

  // recent() hands back a copy — mutating it never touches the store.
  got.pop();
  got[0]!.content = "tampered";
  expect(store.recent("chan")).toEqual([a, b, c]);
});

test("mention targets survive a restart, and a malformed one costs only itself (issue #232)", () => {
  const channelsDir = tempChannelsDir();
  const { store } = makeStore({ channelsDir, now: () => 10_000 });
  store.append("chan", entry("m1", 1_000, { mentions: [{ id: "u-ro", name: "ro" }] }));
  // A fresh store re-materializes from disk — this is the snapshot the classifier scores.
  const { store: reloaded } = makeStore({ channelsDir, now: () => 10_000 });
  expect(reloaded.recent("chan")[0]?.mentions).toEqual([{ id: "u-ro", name: "ro" }]);

  mkdirSync(channelsDir, { recursive: true });
  writeFileSync(
    join(channelsDir, "chan2.jsonl"),
    `${JSON.stringify({
      messageId: "m9",
      ts: 1_000,
      authorId: "224712345678901234",
      authorName: "Jason",
      content: "still a real line",
      mentions: ["not-an-object", { id: 7 }, { name: "ro" }],
      kind: "user",
    })}\n`,
  );
  const { store: third } = makeStore({ channelsDir, now: () => 10_000 });
  const row = third.recent("chan2")[0];
  // The entry stands; only its unusable mention list is dropped. An @mention list is enrichment.
  expect(row?.content).toBe("still a real line");
  expect(row?.mentions).toBeUndefined();
});

// ── bounds ──────────────────────────────────────────────────────────────────────────────

test("count cap keeps only the newest maxEntriesPerChannel", () => {
  const { store } = makeStore({ maxEntriesPerChannel: 3, now: () => 100_000 });
  for (let i = 1; i <= 7; i++) store.append("chan", entry(`m${i}`, i * 1_000));
  expect(store.recent("chan").map((e) => e.messageId)).toEqual(["m5", "m6", "m7"]);
});

test("TTL expires old entries at read time via the injected clock", () => {
  let clock = 0;
  const { store } = makeStore({ maxAgeHours: 1, now: () => clock });
  clock = 10 * 3_600_000;
  store.append("chan", entry("old", clock - 2 * 3_600_000)); // 2h old, TTL 1h
  store.append("chan", entry("fresh", clock - 60_000));
  expect(store.recent("chan").map((e) => e.messageId)).toEqual(["fresh"]);

  clock += 2 * 3_600_000; // everything ages out; no writes needed
  expect(store.recent("chan")).toEqual([]);
});

// ── compaction ──────────────────────────────────────────────────────────────────────────

test("crossing compactEvery rewrites the file to the bounded window", () => {
  const { store, channelsDir } = makeStore({
    maxEntriesPerChannel: 2,
    compactEvery: 4,
    now: () => 1_000_000,
  });
  for (let i = 1; i <= 3; i++) store.append("chan", entry(`m${i}`, i));
  expect(fileLines(channelsDir, "chan")).toHaveLength(3); // append-only so far

  store.append("chan", entry("m4", 4)); // 4th append triggers compaction
  const lines = fileLines(channelsDir, "chan");
  expect(lines).toHaveLength(2);
  expect(lines.map((l) => (JSON.parse(l) as ChannelEntry).messageId)).toEqual(["m3", "m4"]);
});

// ── restart survival ────────────────────────────────────────────────────────────────────

test("a new store over the same dir sees the same window and watermark", () => {
  const channelsDir = tempChannelsDir();
  const a = makeStore({ channelsDir, now: () => 50_000 }).store;
  a.append("chan", entry("m1", 1_000));
  a.append("chan", entry("m2", 2_000));
  expect(a.takeUnseen("chan", "session-1").map((e) => e.messageId)).toEqual(["m1", "m2"]);
  a.markSeen("chan", "session-1", "m2");

  const b = makeStore({ channelsDir, now: () => 50_000 }).store;
  expect(b.recent("chan").map((e) => e.messageId)).toEqual(["m1", "m2"]);
  // Same sessionId (a --resume): the persisted watermark holds — nothing re-injected.
  expect(b.takeUnseen("chan", "session-1")).toEqual([]);
});

// ── watermarks ──────────────────────────────────────────────────────────────────────────

test("same session: takeUnseen is non-mutating until its successful turn marks the cursor", () => {
  const { store } = makeStore({ now: () => 50_000 });
  store.append("chan", entry("m1", 1_000));
  store.append("chan", entry("m2", 2_000));
  expect(store.takeUnseen("chan", "s1").map((e) => e.messageId)).toEqual(["m1", "m2"]);
  // A failed/abandoned turn did not advance anything, so retry gets the same transcript.
  expect(store.takeUnseen("chan", "s1").map((e) => e.messageId)).toEqual(["m1", "m2"]);
  store.markSeen("chan", "s1", "m2");
  expect(store.takeUnseen("chan", "s1")).toEqual([]);

  store.append("chan", entry("m3", 3_000));
  store.append("chan", entry("m4", 4_000));
  expect(store.takeUnseen("chan", "s1").map((e) => e.messageId)).toEqual(["m3", "m4"]);
});

test("different sessionId gets the full window again (rotation semantics)", () => {
  const { store } = makeStore({ now: () => 50_000 });
  store.append("chan", entry("m1", 1_000));
  store.append("chan", entry("m2", 2_000));
  expect(store.takeUnseen("chan", "s1")).toHaveLength(2);
  store.markSeen("chan", "s1", "m2");
  // rotate() minted a new sessionId → the watermark is dead → full catch-up window.
  expect(store.takeUnseen("chan", "s2").map((e) => e.messageId)).toEqual(["m1", "m2"]);
  // A successful turn binds the watermark to the new session.
  store.markSeen("chan", "s2", "m2");
  expect(store.takeUnseen("chan", "s2")).toEqual([]);
});

test("markSeen suppresses a following takeUnseen for that session", () => {
  const { store } = makeStore({ now: () => 50_000 });
  store.append("chan", entry("m1", 1_000));
  store.append("chan", entry("m2", 2_000));
  store.markSeen("chan", "s1", "m2");
  expect(store.takeUnseen("chan", "s1")).toEqual([]);

  store.append("chan", entry("m3", 3_000));
  expect(store.takeUnseen("chan", "s1").map((e) => e.messageId)).toEqual(["m3"]);
});

test("a watermark id that aged out of the window yields the whole window", () => {
  let clock = 10 * 3_600_000;
  const { store } = makeStore({ maxAgeHours: 1, now: () => clock });
  store.append("chan", entry("m1", clock));
  expect(store.takeUnseen("chan", "s1")).toHaveLength(1);
  store.markSeen("chan", "s1", "m1");

  clock += 2 * 3_600_000; // m1 expires out of the window
  store.append("chan", entry("m2", clock));
  expect(store.takeUnseen("chan", "s1").map((e) => e.messageId)).toEqual(["m2"]);
});

test("markSeen is monotonic per (channelId, sessionId): a stale post-hoc commit doesn't regress it", () => {
  const { store } = makeStore({ now: () => 50_000 });
  store.append("chan", entry("m1", 1_000));
  store.append("chan", entry("m2", 2_000));
  store.append("chan", entry("m3", 3_000));
  // A later-landing turn commits the newer position first (e.g. an injected mid-flow message
  // whose watermark commit races ahead of the original turn's own stale commit).
  store.markSeen("chan", "s1", "m3");
  // The original turn's own commit, computed from state before the injection, lands after —
  // and must not regress the cursor back to m1.
  store.markSeen("chan", "s1", "m1");
  expect(store.takeUnseen("chan", "s1")).toEqual([]);
});

test("markSeen still advances normally when commits arrive in forward order", () => {
  const { store } = makeStore({ now: () => 50_000 });
  store.append("chan", entry("m1", 1_000));
  store.append("chan", entry("m2", 2_000));
  store.append("chan", entry("m3", 3_000));
  store.markSeen("chan", "s1", "m1");
  store.markSeen("chan", "s1", "m3");
  expect(store.takeUnseen("chan", "s1")).toEqual([]);
});

test("empty window: takeUnseen returns [] and leaves the watermark untouched", () => {
  const { store, channelsDir } = makeStore({ now: () => 50_000 });
  expect(store.takeUnseen("chan", "s1")).toEqual([]);
  expect(existsSync(join(channelsDir, "watermarks.json"))).toBe(false);
});

// ── wipe ────────────────────────────────────────────────────────────────────────────────

test("wipe(single) removes that channel only; wipe() sweeps everything", () => {
  const { store, channelsDir } = makeStore({ now: () => 50_000 });
  store.append("a", entry("m1", 1_000));
  store.append("b", entry("m2", 2_000));
  store.takeUnseen("a", "s1");
  store.takeUnseen("b", "s1");
  store.markSeen("a", "s1", "m1");
  store.markSeen("b", "s1", "m2");

  expect(store.wipe("a")).toEqual(["a"]);
  expect(existsSync(join(channelsDir, "a.jsonl"))).toBe(false);
  expect(existsSync(join(channelsDir, "b.jsonl"))).toBe(true);
  expect(store.recent("a")).toEqual([]);
  expect(store.recent("b")).toHaveLength(1);
  const marks = JSON.parse(readFileSync(join(channelsDir, "watermarks.json"), "utf8")) as {
    channels: Record<string, unknown>;
  };
  expect(marks.channels.a).toBeUndefined();
  expect(marks.channels.b).toBeDefined();

  expect(store.wipe()).toEqual(["b"]);
  expect(existsSync(join(channelsDir, "b.jsonl"))).toBe(false);
  expect(store.recent("b")).toEqual([]);
});

// ── hardening ───────────────────────────────────────────────────────────────────────────

test("a malformed JSONL line is dropped (once, with counts); valid neighbors survive", () => {
  const channelsDir = tempChannelsDir();
  const good1 = entry("m1", 1_000);
  const good2 = entry("m2", 2_000);
  const badKind = JSON.stringify({ ...entry("m3", 3_000), kind: "alien" });
  // Build the dir + file by hand to simulate a store that crashed mid-write.
  mkdirSync(channelsDir, { recursive: true });
  writeFileSync(
    join(channelsDir, "chan.jsonl"),
    `${JSON.stringify(good1)}\n{not json at all\n${badKind}\n${JSON.stringify(good2)}\n`,
    "utf8",
  );

  const warns: string[] = [];
  const capture = {
    info() {},
    debug() {},
    error() {},
    warn(msg: string) {
      warns.push(msg);
    },
    child() {
      return capture;
    },
  };
  const store = createChannelContextStore({
    channelsDir,
    maxEntriesPerChannel: 50,
    maxAgeHours: 24,
    logger: capture as never,
    now: () => 10_000,
  });

  expect(store.recent("chan").map((e) => e.messageId)).toEqual(["m1", "m2"]);
  expect(warns.filter((m) => m.includes("malformed"))).toHaveLength(1);
  // First-load compaction scrubbed the bad lines off disk.
  expect(fileLines(channelsDir, "chan")).toHaveLength(2);
});

test("hostile channelId is a no-op and never touches the filesystem", () => {
  const { store, channelsDir } = makeStore({ now: () => 10_000 });
  const hostile = "../../etc/passwd";
  store.append(hostile, entry("m1", 1_000));
  expect(store.recent(hostile)).toEqual([]);
  expect(store.takeUnseen(hostile, "s1")).toEqual([]);
  store.markSeen(hostile, "s1", "m1");
  expect(store.wipe(hostile)).toEqual([]);
  // No valid write ever happened, so the lazily-created dir must not even exist —
  // and nothing escaped upward toward the traversal target.
  expect(existsSync(channelsDir)).toBe(false);
  expect(existsSync(join(channelsDir, "..", "..", "etc", "passwd.jsonl"))).toBe(false);
});

test("an unwritable channelsDir degrades silently — the store never throws", () => {
  const parent = mkdtempSync(join(tmpdir(), "beckett-channel-context-"));
  tmpDirs.push(parent);
  const blocker = join(parent, "not-a-dir");
  writeFileSync(blocker, "i am a file", "utf8");
  const { store } = makeStore({ channelsDir: join(blocker, "channels"), now: () => 10_000 });

  expect(() => store.append("chan", entry("m1", 1_000))).not.toThrow();
  // Disk failed but capture still works this process: the in-memory cache holds the entry.
  expect(store.recent("chan").map((e) => e.messageId)).toEqual(["m1"]);
  expect(() => store.takeUnseen("chan", "s1")).not.toThrow();
  expect(() => store.markSeen("chan", "s1", "m1")).not.toThrow();
  expect(() => store.wipe()).not.toThrow();
});
