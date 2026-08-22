import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderStore, type NewReminder } from "./store.ts";
import { startReminderScheduler, REMINDER_TICK_MS, type ReminderDispatcher } from "./scheduler.ts";
import type { Reminder } from "./types.ts";
import { quietLogger } from "../cli/io.ts";

const dirs: string[] = [];
const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { path: string; store: ReminderStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-reminder-sched-"));
  dirs.push(dir);
  const path = join(dir, "reminders.json");
  return { path, store: new ReminderStore(path) };
}

function recorder(): { dispatcher: ReminderDispatcher; calls: Reminder[] } {
  const calls: Reminder[] = [];
  return { calls, dispatcher: { async dispatch(reminder) { calls.push(reminder); } } };
}

function failingDispatcher(): { dispatcher: ReminderDispatcher; calls: number[] } {
  const calls: number[] = [];
  return { calls, dispatcher: { async dispatch() { calls.push(1); throw new Error("simulated delivery failure"); } } };
}

const BASE: NewReminder = {
  id: "r1",
  note: "check the deploy",
  kind: "external",
  fireAt: "2026-07-20T19:00:00.000Z",
  tz: "America/Los_Angeles",
  recurrence: { kind: "none" },
  channelId: "chan-1",
  pingUserIds: [],
  requesterId: null,
};

const NOW = new Date("2026-07-20T19:30:00.000Z"); // 30 minutes past fireAt — due

test("REMINDER_TICK_MS is the scheduler's default cadence when intervalMs is not overridden", () => {
  expect(REMINDER_TICK_MS).toBe(30_000);
});

test("a one-shot reminder fires exactly once and is removed atomically (self-clearing)", async () => {
  const { store } = makeStore();
  await store.add(BASE);
  const { dispatcher, calls } = recorder();
  const scheduler = startReminderScheduler({
    store,
    dispatcher,
    logger: quietLogger,
    now: () => NOW,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  expect(calls.length).toBe(1);
  expect(calls[0]!.id).toBe("r1");
  expect(await store.list()).toEqual([]);

  // A second tick must not re-fire it — it's gone.
  await scheduler.tick();
  expect(calls.length).toBe(1);
});

test("a fresh store instance confirms the one-shot removal is durable, not just in-memory", async () => {
  const { path, store } = makeStore();
  await store.add(BASE);
  const scheduler = startReminderScheduler({
    store,
    dispatcher: recorder().dispatcher,
    logger: quietLogger,
    now: () => NOW,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);
  await scheduler.tick();

  const restarted = new ReminderStore(path);
  expect(await restarted.list()).toEqual([]);
});

test("a weekly reminder fires and stays on the list, rolled forward to its next occurrence", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, recurrence: { kind: "weekly", weekday: "monday" } });
  const { dispatcher, calls } = recorder();
  const scheduler = startReminderScheduler({
    store,
    dispatcher,
    logger: quietLogger,
    now: () => NOW,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  expect(calls.length).toBe(1);
  const reminders = await store.list();
  expect(reminders.length).toBe(1);
  expect(reminders[0]!.status).toBe("pending");
  // BASE.fireAt is 2026-07-20T19:00:00Z (Monday); +7 days, same wall-clock time.
  expect(reminders[0]!.fireAt).toBe("2026-07-27T19:00:00.000Z");

  // It must not fire again until its NEW fireAt is due.
  await scheduler.tick();
  expect(calls.length).toBe(1);
});

test("a reminder overdue by many missed periods fires exactly once and rolls to the first future occurrence (late-catch-up)", async () => {
  const { store } = makeStore();
  // Daily reminder whose fireAt is ten days stale, as if the daemon was down through all of them.
  await store.add({ ...BASE, fireAt: "2026-07-01T16:00:00.000Z", recurrence: { kind: "daily" } });
  const { dispatcher, calls } = recorder();
  const now = new Date("2026-07-11T12:00:00.000Z"); // 05:00 PT, 2026-07-11
  const scheduler = startReminderScheduler({
    store,
    dispatcher,
    logger: quietLogger,
    now: () => now,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  // Exactly one dispatch for all ten missed days — never one per missed day.
  expect(calls.length).toBe(1);
  const reminder = (await store.get("r1"))!;
  expect(reminder.status).toBe("pending");
  // First 09:00 PT strictly after `now` — later the same day.
  expect(reminder.fireAt).toBe("2026-07-11T16:00:00.000Z");
});

test("a claim orphaned by a crash before restart is retried, not lost, and not double-delivered", async () => {
  const { path, store } = makeStore();
  await store.add(BASE);
  // Simulate a daemon that claimed the reminder (persisted `status: "firing"`) and then crashed
  // before the dispatch (or its finalize write) ever completed.
  await store.setFiring("r1");

  // The "restart": a brand-new store instance over the same file, brand-new scheduler.
  const restartedStore = new ReminderStore(path);
  const { dispatcher, calls } = recorder();
  const scheduler = startReminderScheduler({
    store: restartedStore,
    dispatcher,
    logger: quietLogger,
    now: () => NOW,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  // The orphaned claim was retried exactly once — not lost (it still fired) and not doubled.
  expect(calls.length).toBe(1);
  expect(await restartedStore.list()).toEqual([]); // one-shot: removed after the retried fire

  await scheduler.tick();
  expect(calls.length).toBe(1); // no further, spurious re-fire
});

test("a dispatch failure releases the claim back to pending so the next tick retries it", async () => {
  const { store } = makeStore();
  await store.add(BASE);
  const { dispatcher, calls } = failingDispatcher();
  const scheduler = startReminderScheduler({
    store,
    dispatcher,
    logger: quietLogger,
    now: () => NOW,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  await scheduler.tick();
  expect(calls.length).toBe(1);
  const reminder = (await store.get("r1"))!;
  expect(reminder.status).toBe("pending"); // released, not stuck "firing"

  // Retried on the next tick — the reminder is neither lost nor permanently stuck.
  await scheduler.tick();
  expect(calls.length).toBe(2);
  expect(await store.get("r1")).not.toBeNull();
});

test("fireNow with dryRun builds the plan without dispatching or mutating the store", async () => {
  const { store } = makeStore();
  await store.add(BASE);
  const { dispatcher, calls } = recorder();
  const scheduler = startReminderScheduler({
    store,
    dispatcher,
    logger: quietLogger,
    now: () => NOW,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  const plan = await scheduler.fireNow("r1", { dryRun: true });
  expect(plan.reminderId).toBe("r1");
  expect(plan.kind).toBe("external");
  expect(calls.length).toBe(0);
  expect((await store.get("r1"))!.status).toBe("pending");
});

test("fireNow without dryRun fires for real regardless of fireAt (manual fire outranks the schedule)", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, fireAt: "2099-01-01T00:00:00.000Z" }); // far in the future
  const { dispatcher, calls } = recorder();
  const scheduler = startReminderScheduler({
    store,
    dispatcher,
    logger: quietLogger,
    now: () => NOW,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);

  const plan = await scheduler.fireNow("r1");
  expect(plan.reminderId).toBe("r1");
  expect(calls.length).toBe(1);
  expect(await store.list()).toEqual([]); // one-shot, cleared after firing
});

test("fireNow throws for an unknown id", async () => {
  const { store } = makeStore();
  const scheduler = startReminderScheduler({
    store,
    dispatcher: recorder().dispatcher,
    logger: quietLogger,
    now: () => NOW,
    intervalMs: 10_000_000,
  });
  stoppers.push(scheduler.stop);
  await expect(scheduler.fireNow("nope")).rejects.toThrow(/no such reminder/);
});
