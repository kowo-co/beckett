/**
 * Issue #233 — the owed-run-notification ledger. The durable half of "a run finished and
 * nobody durable knew a ping was owed until it was paid". Mirrors `owed-mentions.test.ts`'s
 * harness style: idempotent claims, the deliver-before-post stamp, a replay budget that survives
 * the restart it is counting, bounds on age and count — plus the run-specific wrinkles: settle
 * marks paid rather than deleting (so a later re-claim of the same run is a genuinely new debt),
 * and the boot-dedupe check is biased toward replaying rather than staying silent.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwedRunNotificationStore,
  OWED_RUN_NOTIFICATION_MAX_AGE_MS,
  runNotificationAlreadyAnnounced,
  type OwedRunNotificationClaim,
  type OwedRunNotificationStore,
} from "./owed-run-notifications.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-owed-run-"));
  tmpDirs.push(dir);
  return dir;
}

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function claim(runId = "run-1", overrides: Partial<OwedRunNotificationClaim> = {}): OwedRunNotificationClaim {
  return {
    runId,
    state: "done",
    channelId: "1520986792373911622",
    requesterIds: ["111111111111111111"],
    ...overrides,
  };
}

function storeAt(file: string, now?: () => number): OwedRunNotificationStore {
  return createOwedRunNotificationStore({ file, logger: quietLog, ...(now ? { now } : {}) });
}

test("a claimed run notification survives the process that claimed it", () => {
  const file = join(tempDir(), "owed.json");
  storeAt(file).claim(claim());

  const owed = storeAt(file).list();
  expect(owed).toHaveLength(1);
  expect(owed[0]!.runId).toBe("run-1");
  expect(owed[0]!.state).toBe("done");
  expect(owed[0]!.phase).toBe("queued");
  expect(owed[0]!.replays).toBe(0);
  expect(owed[0]!.settledAt).toBeNull();
  expect(owed[0]!.requesterIds).toEqual(["111111111111111111"]);
});

test("settling strikes the debt off the owed list for good", () => {
  const file = join(tempDir(), "owed.json");
  const store = storeAt(file);
  store.claim(claim());
  store.settle("run-1");

  expect(store.list()).toEqual([]);
  expect(store.has("run-1")).toBe(false);
  expect(storeAt(file).list()).toEqual([]); // and across the restart
});

test("a re-claim of a still-open debt never resets age or replay budget (idempotent by runId)", () => {
  const file = join(tempDir(), "owed.json");
  let clock = 1_000;
  const store = storeAt(file, () => clock);
  store.claim(claim());
  store.noteReplay("run-1");

  clock = 5_000;
  store.claim(claim()); // the same run reaching claim() twice must not launder its history

  const [entry] = store.list();
  expect(entry!.createdAt).toBe(1_000);
  expect(entry!.replays).toBe(1);
  expect(store.list()).toHaveLength(1);
});

test("a claim AFTER settle opens a genuinely new debt — a run can be parked, then later done", () => {
  const file = join(tempDir(), "owed.json");
  let clock = 1_000;
  const store = storeAt(file, () => clock);
  store.claim(claim("run-1", { state: "parked" }));
  store.settle("run-1");

  clock = 9_000;
  store.claim(claim("run-1", { state: "done" }));

  const [entry] = store.list();
  expect(entry!.state).toBe("done");
  expect(entry!.createdAt).toBe(9_000);
  expect(entry!.settledAt).toBeNull();
});

// overhaul B "surface-fixes" (finding 7): B5/B7 made `parked` a two-way door — a run can leave
// `parked` and reach a DIFFERENT owed state while the original debt is still unsettled (the ping
// was judged not worth sending). `claim` must refresh the entry's state in place rather than
// no-op on the stale one, so a later replay reports what actually happened instead of a lie.
test("claiming a still-open debt under a NEW state refreshes it in place (parked debt, later done)", () => {
  const file = join(tempDir(), "owed.json");
  let clock = 1_000;
  const store = storeAt(file, () => clock);
  store.claim(claim("run-1", { state: "parked" }));
  // the parked debt is never settled (no confirmed post) — then the run resumes and finishes.

  clock = 5_000;
  store.claim(claim("run-1", { state: "done" }));

  const owed = store.list();
  expect(owed).toHaveLength(1);
  expect(owed[0]!.state).toBe("done");
  expect(owed[0]!.createdAt).toBe(1_000); // the debt's age is unchanged — it is still the same debt
  expect(owed[0]!.settledAt).toBeNull();
  expect(owed[0]!.phase).toBe("queued");
});

test("markDelivering is what a crash-between-post-and-settle looks like on disk", () => {
  const file = join(tempDir(), "owed.json");
  const store = storeAt(file);
  store.claim(claim());
  store.markDelivering("run-1");

  expect(storeAt(file).list()[0]!.phase).toBe("delivering");
});

test("markDelivering and settle on an unknown runId are no-ops, not resurrections", () => {
  const store = storeAt(join(tempDir(), "owed.json"));
  expect(() => store.markDelivering("never-claimed")).not.toThrow();
  expect(() => store.settle("never-claimed")).not.toThrow();
  expect(store.list()).toEqual([]);
});

test("a replay is spent before it runs, so a run whose ping keeps dying gives up", () => {
  const file = join(tempDir(), "owed.json");
  storeAt(file).claim(claim());

  expect(storeAt(file).noteReplay("run-1")).toBe(1);
  expect(storeAt(file).noteReplay("run-1")).toBe(2);
  expect(storeAt(file).noteReplay("run-1")).toBe(3);
  expect(storeAt(file).list()[0]!.replays).toBe(3);
});

test("noteReplay on an unknown or settled runId is a no-op", () => {
  const file = join(tempDir(), "owed.json");
  const store = storeAt(file);
  expect(store.noteReplay("never-claimed")).toBe(0);
  store.claim(claim());
  store.settle("run-1");
  expect(store.noteReplay("run-1")).toBe(0);
});

test("a run notification nobody confirmed by tomorrow is dropped rather than announced out of nowhere", () => {
  const file = join(tempDir(), "owed.json");
  let clock = 1_000_000;
  storeAt(file, () => clock).claim(claim("run-stale"));

  clock += OWED_RUN_NOTIFICATION_MAX_AGE_MS + 1;
  expect(storeAt(file, () => clock).list()).toEqual([]);

  const fresh = join(tempDir(), "owed.json");
  let freshClock = 1_000_000;
  storeAt(fresh, () => freshClock).claim(claim("run-fresh"));
  freshClock += OWED_RUN_NOTIFICATION_MAX_AGE_MS - 1;
  expect(storeAt(fresh, () => freshClock).list().map((e) => e.runId)).toEqual(["run-fresh"]);
});

test("the queue is count-bounded, oldest first", () => {
  const file = join(tempDir(), "owed.json");
  const store = createOwedRunNotificationStore({ file, logger: quietLog, maxEntries: 3 });
  for (const id of ["run-1", "run-2", "run-3", "run-4", "run-5"]) store.claim(claim(id));

  expect(store.list().map((e) => e.runId)).toEqual(["run-3", "run-4", "run-5"]);
});

test("a corrupt ledger loses the queue, never the daemon", () => {
  const file = join(tempDir(), "owed.json");
  writeFileSync(file, "{ this is not json");
  const store = storeAt(file);

  expect(store.list()).toEqual([]);
  expect(() => store.claim(claim())).not.toThrow();
  expect(store.list()).toHaveLength(1);
});

test("rows that could not be replayed are dropped rather than carried", () => {
  const file = join(tempDir(), "owed.json");
  writeFileSync(
    file,
    JSON.stringify([
      { runId: "run-ok", state: "done", channelId: "c", createdAt: Date.now(), replays: 0, phase: "queued", settledAt: null },
      { runId: "run-no-channel", state: "failed", createdAt: Date.now() },
      // Not a recognized terminal state — nothing this ledger is meant to replay.
      { runId: "run-bad-state", state: "implementing", channelId: "c", createdAt: Date.now() },
      { state: "parked", channelId: "c" },
      "not even an object",
    ]),
  );

  expect(storeAt(file).list().map((e) => e.runId)).toEqual(["run-ok"]);
});

test("an unwritable ledger degrades to memory instead of throwing into a turn", () => {
  const dir = tempDir();
  const file = join(dir, "owed.json");
  mkdirSync(file); // a directory where the file should be: every write fails
  const store = storeAt(file);

  expect(() => store.claim(claim())).not.toThrow();
  expect(() => store.markDelivering("run-1")).not.toThrow();
  expect(store.list()[0]!.phase).toBe("delivering");
  expect(() => store.settle("run-1")).not.toThrow();
});

test("the ledger writes atomically and leaves no temp file behind", () => {
  const dir = tempDir();
  const file = join(dir, "owed.json");
  const store = storeAt(file);
  store.claim(claim());
  store.markDelivering("run-1");
  store.settle("run-1");

  // Settled, not deleted — the entry stays on disk (with settledAt set) so a rapid re-claim of
  // the same run can't relaunder into a brand-new debt the instant it's paid.
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as Array<{ runId: string; settledAt: number | null }>;
  expect(onDisk).toHaveLength(1);
  expect(onDisk[0]!.settledAt).not.toBeNull();
  // The rename target is the only artifact: a stray `.tmp` sitting next to it is a half-written
  // ledger, which is the one file shape this module must never leave behind.
  expect(readdirSync(dir)).toEqual(["owed.json"]);
});

// ── runNotificationAlreadyAnnounced: the boot-replay dedupe signal ───────────────────────────

test("already-announced dedupe: no channel history at all → replay (biased opposite of owed-mentions)", () => {
  expect(runNotificationAlreadyAnnounced([], 1_000)).toBe(false);
});

test("already-announced dedupe: a Beckett post after createdAt counts as already announced", () => {
  expect(
    runNotificationAlreadyAnnounced([{ authorId: "beckett", ts: 2_000 }], 1_000),
  ).toBe(true);
});

test("already-announced dedupe: a Beckett post BEFORE createdAt does not count", () => {
  expect(
    runNotificationAlreadyAnnounced([{ authorId: "beckett", ts: 500 }], 1_000),
  ).toBe(false);
});

test("already-announced dedupe: a human post after createdAt does not count as Beckett having spoken", () => {
  expect(
    runNotificationAlreadyAnnounced([{ authorId: "111111111111111111", ts: 2_000 }], 1_000),
  ).toBe(false);
});
