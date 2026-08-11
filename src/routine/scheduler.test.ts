import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineStore } from "./store.ts";
import { startRoutineScheduler, type RoutineDispatcher } from "./scheduler.ts";
import type { RoutineDispatchPlan } from "./plan.ts";
import { quietLogger } from "../cli/io.ts";

const dirs: string[] = [];
const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { path: string; store: RoutineStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routine-sched-"));
  dirs.push(dir);
  const path = join(dir, "routines.json");
  return { path, store: new RoutineStore(path) };
}

function recorder(): { dispatcher: RoutineDispatcher; calls: RoutineDispatchPlan[] } {
  const calls: RoutineDispatchPlan[] = [];
  return { calls, dispatcher: { async dispatch(plan) { calls.push(plan); } } };
}

// 2026-07-20 12:30 PT (inside the 12:00–13:00 window) = 19:30Z.
const INSIDE = new Date("2026-07-20T19:30:00.000Z");

test("fires exactly once per period (idempotent) and delegates dispatch off-process", async () => {
  const { store } = makeStore();
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store,
    dispatcher,
    logger: quietLogger,
    now: () => INSIDE,
    rng: () => 0, // rolls the window start (19:00Z), which is < now → due
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  await scheduler.tick();
  await scheduler.tick();

  // Three dispatches total across three ticks — the shitpost, the nightly dream (issue #36; with
  // rng 0 its 03:00 PT roll is long past by 12:30 PT), AND the proactive rot sweep (issue #79; its
  // 09:00–10:30 PT window is also past by 12:30 PT), each exactly once per period.
  expect(calls.length).toBe(3);
  expect(calls.map((c) => c.routineId).sort()).toEqual([
    "daily-x-shitpost",
    "nightly-dream",
    "proactive-sweep",
  ]);
  const shitpost = calls.find((c) => c.routineId === "daily-x-shitpost")!;
  expect(shitpost.credsEntry).toBe("x-account");
  const dream = calls.find((c) => c.routineId === "nightly-dream")!;
  expect(dream.lane).toBe("self");
  expect(dream.dream).toBe(true);
  // The period is claimed on disk, for both.
  const state = (await store.get("daily-x-shitpost"))!.state;
  expect(state.lastFiredPeriodKey).toBe("2026-07-20");
  expect((await store.get("nightly-dream"))!.state.lastFiredPeriodKey).toBe("2026-07-20");
});

test("a restart inside the window neither re-rolls the chosen time nor double-fires", async () => {
  const { path, store } = makeStore();
  // Pre-roll a concrete time for today, unfired — as if a prior daemon rolled it before crashing.
  await store.setState("daily-x-shitpost", {
    periodKey: "2026-07-20",
    chosenFireAt: "2026-07-20T19:20:00.000Z",
    lastFiredPeriodKey: null,
    lastFiredAt: null,
  });

  // New scheduler (the restart). A different RNG that WOULD roll a later minute if it re-rolled.
  const restarted = new RoutineStore(path);
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store: restarted,
    dispatcher,
    logger: quietLogger,
    now: () => INSIDE,
    rng: () => 0.95,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();

  const state = (await restarted.get("daily-x-shitpost"))!.state;
  expect(state.chosenFireAt).toBe("2026-07-20T19:20:00.000Z"); // NOT re-rolled
  // Exactly one shitpost fire (the seeded nightly-dream also catches up its own period here —
  // its 03:00–05:00 PT window is past at 12:30 PT — but never affects this routine's state).
  expect(calls.filter((c) => c.routineId === "daily-x-shitpost").length).toBe(1);

  // A second restart after firing must not double-fire.
  const second = new RoutineStore(path);
  const rec2 = recorder();
  const sched2 = startRoutineScheduler({
    store: second, dispatcher: rec2.dispatcher, logger: quietLogger,
    now: () => INSIDE, rng: () => 0.95, intervalMs: 10_000_000,
  });
  stoppers.push(sched2.stop);
  await sched2.tick();
  expect(rec2.calls.length).toBe(0);
});

test("a deferred fire does NOT claim its period, and the next tick fires it (docs/freetime.md)", async () => {
  const { store } = makeStore();
  const { calls } = recorder();
  let busy = true;
  const scheduler = startRoutineScheduler({
    store,
    dispatcher: {
      async dispatch(plan) {
        calls.push(plan);
      },
      // Stands in for the free-time idle gate: defer while the machine is busy.
      deferReason: (plan) => (busy && plan.routineId === "daily-x-shitpost" ? "busy" : null),
    },
    logger: quietLogger,
    now: () => INSIDE,
    rng: () => 0,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  expect(calls.some((c) => c.routineId === "daily-x-shitpost")).toBe(false);
  // The period is deliberately UNCLAIMED — that is what makes the retry possible.
  expect((await store.get("daily-x-shitpost"))!.state.lastFiredPeriodKey).toBeNull();
  // …and every other routine claimed and fired as always: deferral is per-fire, not a pause.
  expect((await store.get("nightly-dream"))!.state.lastFiredPeriodKey).toBe("2026-07-20");

  busy = false;
  await scheduler.tick();
  expect(calls.filter((c) => c.routineId === "daily-x-shitpost").length).toBe(1);
  expect((await store.get("daily-x-shitpost"))!.state.lastFiredPeriodKey).toBe("2026-07-20");

  // Still once per period after the deferral — the retry did not buy a second fire.
  await scheduler.tick();
  expect(calls.filter((c) => c.routineId === "daily-x-shitpost").length).toBe(1);
});

test("does not fire before the chosen time", async () => {
  const { store } = makeStore();
  await store.setState("daily-x-shitpost", {
    periodKey: "2026-07-20",
    chosenFireAt: "2026-07-20T19:45:00.000Z", // 12:45 PT, after our 12:30 now
    lastFiredPeriodKey: null,
    lastFiredAt: null,
  });
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger, now: () => INSIDE, rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);
  await scheduler.tick();
  // The pre-rolled 12:45 PT shitpost must NOT fire at 12:30 (only the seeded routines whose windows
  // are long past — nightly-dream and the proactive sweep — dispatch this tick).
  expect(calls.filter((c) => c.routineId === "daily-x-shitpost").length).toBe(0);
  expect(calls.every((c) => c.routineId === "nightly-dream" || c.routineId === "proactive-sweep")).toBe(true);
});

test("fireNow dry-run returns the plan WITHOUT dispatching (no live post)", async () => {
  const { store } = makeStore();
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger, now: () => INSIDE, rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  const plan = await scheduler.fireNow("daily-x-shitpost", { dryRun: true });
  // The built-in routine now drives the social-media agent (one path): the plan carries the
  // invocation, not a composed post — the agent AUTHORS the browser task live at fire time.
  expect(plan.lane).toBe("agent");
  expect(plan.agentId).toBe("social-media");
  expect(plan.browserTask).toBeNull();
  expect(plan.credsEntry).toBe("x-account");
  expect(calls.length).toBe(0); // dry-run never dispatches
});

test("fireNow --force dispatches even when already fired this period", async () => {
  const { store } = makeStore();
  await store.setState("daily-x-shitpost", {
    periodKey: "2026-07-20",
    chosenFireAt: "2026-07-20T19:00:00.000Z",
    lastFiredPeriodKey: "2026-07-20", // already fired today
    lastFiredAt: INSIDE.toISOString(),
  });
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger, now: () => INSIDE, rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await expect(scheduler.fireNow("daily-x-shitpost", {})).rejects.toThrow(/already fired/);
  await scheduler.fireNow("daily-x-shitpost", { force: true });
  expect(calls.length).toBe(1);
});

// ── weekly cadence through the real scheduler (issue #85) ────────────────────────────────────

/** Sun 2026-07-26 09:30 PT (inside the built-in deps-update 08:00–10:00 window) = 16:30Z. */
const SUNDAY_INSIDE = new Date("2026-07-26T16:30:00.000Z");

test("the weekly built-in fires once per ISO WEEK, not once per day", async () => {
  const { store } = makeStore();
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger, now: () => SUNDAY_INSIDE, rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  await scheduler.tick();
  const weeklyCalls = calls.filter((p) => p.routineId === "weekly-deps-update");
  expect(weeklyCalls.length).toBe(1);
  // Its own lane — a maintenance job must never be handed to the browser.
  expect(weeklyCalls[0]!.lane).toBe("deps-update");
  expect(weeklyCalls[0]!.browserTask).toBeNull();
  expect(weeklyCalls[0]!.credsEntry).toBeNull();

  // The period claimed on disk is the ISO WEEK, so every remaining day of it is already spent.
  const state = (await store.get("weekly-deps-update"))!.state;
  expect(state.lastFiredPeriodKey).toBe("2026-W30");
});

test("a restart mid-week keeps the weekly period claimed (no second run that week)", async () => {
  const { path, store } = makeStore();
  await store.setState("weekly-deps-update", {
    periodKey: "2026-W30",
    chosenFireAt: "2026-07-26T15:12:00.000Z",
    lastFiredPeriodKey: "2026-W30",
    lastFiredAt: "2026-07-26T15:12:00.000Z",
  });

  // A restart on the Wednesday AFTER that Sunday — same ISO week, so still spent.
  const restarted = new RoutineStore(path);
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store: restarted, dispatcher, logger: quietLogger,
    now: () => new Date("2026-07-22T20:00:00.000Z"), rng: () => 0.95, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);
  await scheduler.tick();

  expect(calls.filter((p) => p.routineId === "weekly-deps-update").length).toBe(0);
  // ...and the chosen instant is untouched — a restart must never re-roll the week's time.
  const state = (await restarted.get("weekly-deps-update"))!.state;
  expect(state.chosenFireAt).toBe("2026-07-26T15:12:00.000Z");
});

test("a weekly routine does not fire on a non-matching weekday", async () => {
  const { store } = makeStore();
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger,
    // Wed 2026-07-22 09:30 PT — inside the window's HOURS but the wrong day.
    now: () => new Date("2026-07-22T16:30:00.000Z"), rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);
  await scheduler.tick();
  expect(calls.filter((p) => p.routineId === "weekly-deps-update").length).toBe(0);
  // The week's time IS rolled (and persisted) — it just sits in the future, on Sunday.
  const state = (await store.get("weekly-deps-update"))!.state;
  expect(state.periodKey).toBe("2026-W30");
  expect(state.chosenFireAt).toBe("2026-07-26T15:00:00.000Z");
});
