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

  // Two dispatches this tick — the ORIGINAL shitpost fire (with rng 0 its 12:00 PT roll is
  // already due at 12:30 PT, and its window hasn't elapsed yet, so it's ON TIME, not a catch-up)
  // and its 11:00–11:30 PT sibling `daily-x-shitpost-2` (LATE — its window already elapsed by
  // 12:30 PT), which claims this tick's one late-catch-up slot (boot-storm guard,
  // `LATE_CATCH_UP_BUDGET_PER_TICK`). The proactive rot sweep (issue #79; its 09:00–10:30 PT
  // window is ALSO past by 12:30 PT) is late too but loses the race — evaluated after
  // `daily-x-shitpost-2` exhausts the budget, it rolls straight to its next period instead of
  // storming in alongside it (the 2026-08-22T00:57 restart bug this guard fixes). The other
  // siblings (`daily-x-shitpost-3`/`-4`, all three timeline-reply rounds) roll to windows still in
  // the future at 12:30 PT, so they do not fire this tick either.
  expect(calls.length).toBe(2);
  expect(calls.map((c) => c.routineId).sort()).toEqual(["daily-x-shitpost", "daily-x-shitpost-2"]);
  const shitpost = calls.find((c) => c.routineId === "daily-x-shitpost")!;
  expect(shitpost.credsEntry).toBe("x-account");
  // The period is claimed on disk, for both — INCLUDING the sweep, which rolled to tomorrow
  // without ever dispatching (its period is spent either way, so it won't retry today).
  const state = (await store.get("daily-x-shitpost"))!.state;
  expect(state.lastFiredPeriodKey).toBe("2026-07-20");
  expect((await store.get("proactive-sweep"))!.state.lastFiredPeriodKey).toBe("2026-07-20");
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
  // Exactly one shitpost fire (the seeded proactive-sweep also catches up its own period here —
  // its 09:00–10:30 PT window is past at 12:30 PT — but never affects this routine's state).
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
  expect((await store.get("proactive-sweep"))!.state.lastFiredPeriodKey).toBe("2026-07-20");

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
  // The pre-rolled 12:45 PT shitpost must NOT fire at 12:30 — only its 11:00–11:30 PT sibling
  // `daily-x-shitpost-2` (already past by 12:30 PT) dispatches this tick, claiming the tick's one
  // late-catch-up slot. The seeded proactive sweep (also past its 09:00–10:30 PT window) is late
  // too but is evaluated after the budget is spent, so it rolls to its next period instead of
  // storming in alongside it — same boot-storm guard as the test above.
  expect(calls.filter((c) => c.routineId === "daily-x-shitpost").length).toBe(0);
  expect(calls.map((c) => c.routineId).sort()).toEqual(["daily-x-shitpost-2"]);
  expect((await store.get("proactive-sweep"))!.state.lastFiredPeriodKey).toBe("2026-07-20");
});

// ── boot catch-up storm (2026-08-22T00:57 restart: three sibling lanes fired within one second) ─

test("a restart after every window elapsed catches up AT MOST ONE routine per tick — the rest roll to tomorrow, not a storm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routine-sched-storm-"));
  dirs.push(dir);
  const store = new RoutineStore(join(dir, "routines.json"), { seedBuiltins: false });

  // Three independent daily lanes, each with a NON-overlapping window that has fully elapsed by
  // the time the daemon comes back up — exactly the shape of daily-x-shitpost-2/-3/-4 all firing
  // together after the 2026-08-22T00:57 restart, minus the builtins so the scenario is explicit.
  for (const id of ["lane-a", "lane-b", "lane-c"]) {
    await store.add({
      id,
      name: id,
      enabled: true,
      action: { kind: "agent", agentId: "social-media", input: `compose ${id}` },
      schedule: { cadence: { kind: "daily" }, window: { start: "09:00", end: "10:00", tz: "America/Los_Angeles" } },
    });
  }

  // 2026-07-20 20:00 PT = way past every lane's 09:00-10:00 PT window that day.
  const LATE = new Date("2026-07-21T03:00:00.000Z");
  const { dispatcher, calls } = recorder();
  const scheduler = startRoutineScheduler({
    store, dispatcher, logger: quietLogger, now: () => LATE, rng: () => 0, intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  // Exactly one of the three fires this tick — not a storm.
  expect(calls.length).toBe(1);
  const [fired] = calls.map((c) => c.routineId);

  // The two that lost the race are marked spent for today (so they don't retry every 30s for the
  // rest of the day) but were never dispatched.
  for (const id of ["lane-a", "lane-b", "lane-c"]) {
    const state = (await store.get(id))!.state;
    expect(state.lastFiredPeriodKey).toBe("2026-07-20");
    if (id !== fired) expect(state.lastFiredAt).toBeNull(); // marked spent, never actually fired
  }

  // A second tick the same day does not retroactively fire the skipped ones either — they rolled
  // to tomorrow, not "later today".
  await scheduler.tick();
  expect(calls.length).toBe(1);
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
