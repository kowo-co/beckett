import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineStore } from "./store.ts";
import { fixedFireWindow } from "./builtins.ts";
import { rollFireTime } from "./schedule.ts";
import type { Logger } from "../types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(seedBuiltins = true): { path: string; store: RoutineStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  return { path, store: new RoutineStore(path, { seedBuiltins }) };
}

test("seeds the built-in daily-x-shitpost on first load", async () => {
  const { store } = makeStore();
  const routines = await store.list();
  const x = routines.find((r) => r.id === "daily-x-shitpost");
  expect(x).toBeTruthy();
  expect(x!.builtin).toBe(true);
  // The daily shitpost now routes THROUGH the social-media agent (issue #55/#72) — one path.
  expect(x!.action.kind).toBe("agent");
  expect(x!.schedule!.window).toEqual({ start: "12:00", end: "13:00", tz: "America/Los_Angeles" });
  if (x!.action.kind === "agent") {
    expect(x!.action.agentId).toBe("social-media");
    // The vault has no "x.com" entry, only "x-account" (the creds-entry bug fix) — was "x.com".
    expect(x!.action.credsEntry).toBe("x-account");
  }
});

// ── boot-time credsEntry migration (heals prod's routines.json — no manual surgery) ──────────

test("heals a persisted routine's dead credsEntry: \"x.com\" -> \"x-account\", logged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-migrate-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  // Simulate a pre-fix disk state: a builtin already seeded with the OLD dead entry name.
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      removedBuiltins: [],
      routines: [
        {
          id: "daily-x-shitpost",
          name: "daily X shitpost",
          builtin: true,
          enabled: true,
          action: { kind: "agent", agentId: "social-media", input: "compose today's shitpost", credsEntry: "x.com" },
          schedule: { cadence: { kind: "daily" }, window: { start: "12:00", end: "13:00", tz: "America/Los_Angeles" } },
          state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );

  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    warn() {},
    error() {},
    info(msg, fields) {
      logged.push({ msg, fields });
    },
    child() {
      return this;
    },
  };

  const store = new RoutineStore(path, { seedBuiltins: false, logger });
  const routine = await store.get("daily-x-shitpost");
  expect(routine!.action.kind).toBe("agent");
  if (routine!.action.kind === "agent") expect(routine!.action.credsEntry).toBe("x-account");

  // Persisted to disk, not just returned in-memory — this is what heals prod without a manual edit.
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  expect(onDisk.routines[0].action.credsEntry).toBe("x-account");
  expect(logged.some((l) => l.msg.includes("healed") && l.fields?.routineId === "daily-x-shitpost")).toBe(true);
});

test("the credsEntry migration is idempotent — a second load touches nothing further", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-migrate-idem-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      removedBuiltins: [],
      routines: [
        {
          id: "daily-x-shitpost",
          name: "daily X shitpost",
          builtin: true,
          enabled: true,
          action: { kind: "agent", agentId: "social-media", input: "compose today's shitpost", credsEntry: "x.com" },
          schedule: { cadence: { kind: "daily" }, window: { start: "12:00", end: "13:00", tz: "America/Los_Angeles" } },
          state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );

  const first = new RoutineStore(path, { seedBuiltins: false });
  await first.get("daily-x-shitpost"); // triggers the first heal + write
  const afterFirst = readFileSync(path, "utf8");

  const logged: Array<{ msg: string }> = [];
  const logger: Logger = {
    debug() {},
    warn() {},
    error() {},
    info(msg) {
      logged.push({ msg });
    },
    child() {
      return this;
    },
  };
  const second = new RoutineStore(path, { seedBuiltins: false, logger });
  await second.get("daily-x-shitpost");
  const afterSecond = readFileSync(path, "utf8");

  expect(afterSecond).toBe(afterFirst); // no further rewrite — already healed
  expect(logged.some((l) => l.msg.includes("healed"))).toBe(false); // nothing left to heal
});

test("a routine already on \"x-account\" is left alone by the migration", async () => {
  const { store } = makeStore(false);
  await store.add({
    id: "hourly-check",
    name: "hourly check",
    enabled: true,
    action: { kind: "browser", task: "check the thing", credsEntry: "x-account" },
    schedule: { cadence: { kind: "daily" }, window: { start: "09:00", end: "09:40", tz: "America/New_York" } },
  });
  const routine = await store.get("hourly-check");
  expect(routine!.action.kind).toBe("browser");
  if (routine!.action.kind === "browser") expect(routine!.action.credsEntry).toBe("x-account");
});

// ── boot-time drop of routines carrying a retired action kind ────────────────────────────────
//
// `dream` was retired here too (overhaul P16: rip-dream) but the nightly dream pass was later
// rebuilt on the day's Discord sessions (`src/dream/`) and `{kind: "dream"}` is a live action
// kind again — RETIRED_ACTION_KINDS is empty on this build, and a row carrying it must load as a
// REAL routine, not be silently dropped the way an actually-retired kind would be.

const DREAM_ROW = {
  id: "nightly-dream",
  name: "nightly dream pass",
  builtin: true,
  enabled: true,
  action: { kind: "dream" },
  schedule: { cadence: { kind: "daily" }, window: { start: "04:00", end: "05:30", tz: "America/Los_Angeles" } },
  state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("a routines.json carrying a dream action loads it as a real routine — dream is not retired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-dream-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  writeFileSync(path, JSON.stringify({ version: 1, removedBuiltins: [], routines: [DREAM_ROW] }));

  const store = new RoutineStore(path, { seedBuiltins: false });
  const routines = await store.list();
  const dream = routines.find((r) => r.id === "nightly-dream");
  expect(dream).toBeTruthy();
  expect(dream!.action.kind).toBe("dream");

  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  expect(onDisk.routines.find((r: { id: string }) => r.id === "nightly-dream")).toBeTruthy();
  expect(onDisk.removedBuiltins).not.toContain("nightly-dream");
});

// ── the dream pass's FIXED fire time (`[dream] fire_at` / `timezone`) ────────────────────────

test("fixedFireWindow renders a fixed time as the one-minute window the scheduler can express", () => {
  expect(fixedFireWindow("00:00", "America/Los_Angeles")).toEqual({
    start: "00:00",
    end: "00:01",
    tz: "America/Los_Angeles",
  });
  expect(fixedFireWindow("23:58", "UTC")).toEqual({ start: "23:58", end: "23:59", tz: "UTC" });
});

test("a one-minute window can only ever roll to its own start — the fire time is FIXED", () => {
  const schedule = { cadence: { kind: "daily" as const }, window: fixedFireWindow("00:00", "UTC") };
  // Whatever the RNG says, the rolled minute is the window's start: 00:00 UTC on the period's date.
  for (const rng of [() => 0, () => 0.5, () => 0.999999]) {
    expect(rollFireTime(schedule, "2026-08-19", rng).toISOString()).toBe("2026-08-19T00:00:00.000Z");
  }
});

test("the seeded nightly-dream routine fires at a fixed 00:00 PT by default", async () => {
  const { store } = makeStore();
  const dream = (await store.list()).find((r) => r.id === "nightly-dream")!;
  expect(dream.schedule!.window).toEqual({ start: "00:00", end: "00:01", tz: "America/Los_Angeles" });
});

test("[dream] fire_at / timezone retime the seeded routine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-dream-time-"));
  dirs.push(dir);
  const store = new RoutineStore(join(dir, "routines.json"), {
    builtins: { dream: { fireAt: "03:30", tz: "Europe/Berlin" } },
  });
  const dream = (await store.list()).find((r) => r.id === "nightly-dream")!;
  expect(dream.schedule!.window).toEqual({ start: "03:30", end: "03:31", tz: "Europe/Berlin" });
});

test("a retimed [dream] fire_at is applied to an EXISTING routines.json on the next load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-dream-retime-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  // The pre-fixed-time shape: the old fuzzed 04:00–05:30 window, with a minute already chosen.
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      removedBuiltins: [],
      routines: [
        {
          ...DREAM_ROW,
          state: {
            periodKey: "2026-08-19",
            chosenFireAt: "2026-08-19T11:42:00.000Z",
            lastFiredPeriodKey: null,
            lastFiredAt: null,
          },
        },
      ],
    }),
  );

  const store = new RoutineStore(path, {
    seedBuiltins: false,
    builtins: { dream: { fireAt: "00:00", tz: "America/Los_Angeles" } },
  });
  const dream = (await store.list()).find((r) => r.id === "nightly-dream")!;
  expect(dream.schedule!.window).toEqual({ start: "00:00", end: "00:01", tz: "America/Los_Angeles" });
  // The minute chosen inside the OLD window is dropped, or the pass would still fire at 04:42.
  expect(dream.state.chosenFireAt).toBeNull();
  expect(dream.state.periodKey).toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8")).routines[0].schedule.window.start).toBe("00:00");
});

// ── boot-time removedBuiltins heal (residue from the v7 dream retirement) ────────────────────

test("heals stale removedBuiltins residue from the v7 dream retirement, reseeding nightly-dream, logged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-heal-removed-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  // Simulate a real box that lived through overhaul P16 (dream retired whole) and never had a
  // chance to un-remove it by hand: no dream row, but the old removal is still on disk.
  writeFileSync(path, JSON.stringify({ version: 1, removedBuiltins: ["nightly-dream"], routines: [] }));

  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    warn() {},
    error() {},
    info(msg, fields) {
      logged.push({ msg, fields });
    },
    child() {
      return this;
    },
  };

  const store = new RoutineStore(path, { seedBuiltins: true, logger });
  const dream = await store.get("nightly-dream");
  expect(dream).toBeTruthy();
  expect(dream!.builtin).toBe(true);
  expect(dream!.action.kind).toBe("dream");

  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  expect(onDisk.removedBuiltins).not.toContain("nightly-dream");
  expect(onDisk.routines.find((r: { id: string }) => r.id === "nightly-dream")).toBeTruthy();
  expect(logged.some((l) => l.msg.includes("healed") && l.fields?.routineId === "nightly-dream")).toBe(true);
});

test("the removedBuiltins heal is idempotent — a second load touches nothing further", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-heal-removed-idem-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  writeFileSync(path, JSON.stringify({ version: 1, removedBuiltins: ["nightly-dream"], routines: [] }));

  const first = new RoutineStore(path, { seedBuiltins: true });
  await first.get("nightly-dream"); // triggers the heal + reseed + write
  const afterFirst = readFileSync(path, "utf8");

  const logged: Array<{ msg: string }> = [];
  const logger: Logger = {
    debug() {},
    warn() {},
    error() {},
    info(msg) {
      logged.push({ msg });
    },
    child() {
      return this;
    },
  };
  const second = new RoutineStore(path, { seedBuiltins: true, logger });
  await second.get("nightly-dream");
  const afterSecond = readFileSync(path, "utf8");

  expect(afterSecond).toBe(afterFirst); // no further rewrite — already healed
  expect(logged.some((l) => l.msg.includes("healed"))).toBe(false); // nothing left to heal
});

test("seeds the built-in nightly-dream routine on first load", async () => {
  const { store } = makeStore();
  const routines = await store.list();
  const dream = routines.find((r) => r.id === "nightly-dream");
  expect(dream).toBeTruthy();
  expect(dream!.builtin).toBe(true);
  expect(dream!.action.kind).toBe("dream");
  expect(dream!.schedule!.cadence).toEqual({ kind: "daily" });
});

test("a registry with no retired rows is not rewritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-retired-noop-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      removedBuiltins: [],
      routines: [
        {
          id: "hourly-check",
          name: "hourly check",
          builtin: false,
          enabled: true,
          action: { kind: "browser", task: "check the thing" },
          schedule: { cadence: { kind: "daily" }, window: { start: "09:00", end: "09:40", tz: "America/New_York" } },
          state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const before = readFileSync(path, "utf8");

  const store = new RoutineStore(path, { seedBuiltins: false });
  await store.list();

  expect(readFileSync(path, "utf8")).toBe(before);
});

test("definitions and chosen fire time persist and restore across a new store", async () => {
  const { path, store } = makeStore();
  await store.setState("daily-x-shitpost", {
    periodKey: "2026-07-20",
    chosenFireAt: "2026-07-20T19:23:00.000Z",
    lastFiredPeriodKey: null,
    lastFiredAt: null,
  });

  // A fresh store (simulating a daemon restart) reads the same chosen time back.
  const restored = new RoutineStore(path, { seedBuiltins: true });
  const routine = await restored.get("daily-x-shitpost");
  expect(routine!.state.periodKey).toBe("2026-07-20");
  expect(routine!.state.chosenFireAt).toBe("2026-07-20T19:23:00.000Z");
});

test("add/inspect/remove a user routine", async () => {
  const { store } = makeStore(false);
  const added = await store.add({
    id: "hourly-check",
    name: "hourly check",
    enabled: true,
    action: { kind: "browser", task: "check the thing" },
    schedule: { cadence: { kind: "daily" }, window: { start: "09:00", end: "09:40", tz: "America/New_York" } },
  });
  expect(added.builtin).toBe(false);
  expect((await store.get("hourly-check"))!.action.kind).toBe("browser");
  await expect(store.add({ ...added } as never)).rejects.toThrow(/already exists/);

  expect(await store.remove("hourly-check")).toBe(true);
  expect(await store.get("hourly-check")).toBeNull();
});

test("removing a built-in sticks across a restart (not re-seeded)", async () => {
  const { path, store } = makeStore();
  expect(await store.remove("daily-x-shitpost")).toBe(true);
  const restored = new RoutineStore(path, { seedBuiltins: true });
  expect(await restored.get("daily-x-shitpost")).toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8")).removedBuiltins).toContain("daily-x-shitpost");
});

test("the sweep's repo list comes from the config override, on every load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-sweep-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");

  const storeA = new RoutineStore(path, { builtins: { proactiveSweep: { repos: ["me/a"] } } });
  const seeded = await storeA.get("proactive-sweep");
  expect(seeded!.action.kind).toBe("proactive-sweep");
  if (seeded!.action.kind === "proactive-sweep") expect(seeded!.action.repos).toEqual(["me/a"]);

  // A second store, pointed at the SAME file, with a DIFFERENT config override — config wins over
  // whatever is already on disk; there is no lingering "me/a" from the first load.
  const storeB = new RoutineStore(path, { builtins: { proactiveSweep: { repos: ["me/b"] } } });
  const reloaded = await storeB.get("proactive-sweep");
  if (reloaded!.action.kind === "proactive-sweep") expect(reloaded!.action.repos).toEqual(["me/b"]);
});

test("an omitted proactiveSweep override leaves an existing list untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-sweep-noop-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");

  const storeA = new RoutineStore(path, { builtins: { proactiveSweep: { repos: ["me/a"] } } });
  await storeA.get("proactive-sweep");

  // No `builtins` override at all this time — the config-authoritative reconcile is a no-op, and
  // the list from the prior load survives untouched.
  const storeB = new RoutineStore(path);
  const reloaded = await storeB.get("proactive-sweep");
  if (reloaded!.action.kind === "proactive-sweep") expect(reloaded!.action.repos).toEqual(["me/a"]);
});
