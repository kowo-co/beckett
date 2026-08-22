import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderStore, type ReminderStoreOptions, type NewReminder } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(opts: ReminderStoreOptions = {}): { path: string; store: ReminderStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-reminder-store-"));
  dirs.push(dir);
  const path = join(dir, "reminders.json");
  return { path, store: new ReminderStore(path, opts) };
}

const BASE: NewReminder = {
  id: "",
  note: "check the deploy",
  kind: "external",
  fireAt: "2026-07-20T19:00:00.000Z",
  tz: "America/Los_Angeles",
  recurrence: { kind: "none" },
  channelId: "chan-1",
  pingUserIds: [],
  requesterId: null,
};

test("add assigns an id when the caller leaves it empty, and get/list round-trip it", async () => {
  const { store } = makeStore();
  const created = await store.add(BASE);
  expect(created.id.length).toBeGreaterThan(0);
  expect(created.status).toBe("pending");
  expect(await store.get(created.id)).toEqual(created);
  expect((await store.list()).map((r) => r.id)).toEqual([created.id]);
});

test("add refuses a duplicate explicit id", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, id: "dup" });
  await expect(store.add({ ...BASE, id: "dup" })).rejects.toThrow(/already exists/);
});

test("list is sorted by fireAt ascending", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, id: "later", fireAt: "2026-07-21T09:00:00.000Z" });
  await store.add({ ...BASE, id: "sooner", fireAt: "2026-07-20T09:00:00.000Z" });
  expect((await store.list()).map((r) => r.id)).toEqual(["sooner", "later"]);
});

test("remove deletes by id and reports whether anything was removed", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, id: "gone" });
  expect(await store.remove("gone")).toBe(true);
  expect(await store.remove("gone")).toBe(false);
  expect(await store.get("gone")).toBeNull();
});

test("setFiring claims exactly once — a second claim before setPending/finalize is refused", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, id: "r1" });
  expect(await store.setFiring("r1")).toBe(true);
  expect((await store.get("r1"))!.status).toBe("firing");
  // A racing second claim (e.g. two ticks overlapping) must not succeed twice.
  expect(await store.setFiring("r1")).toBe(false);
});

test("setFiring on a missing reminder is a no-op false, not a throw", async () => {
  const { store } = makeStore();
  expect(await store.setFiring("nope")).toBe(false);
});

test("setPending releases a claim back to pending (the failed-dispatch retry path)", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, id: "r1" });
  await store.setFiring("r1");
  await store.setPending("r1");
  expect((await store.get("r1"))!.status).toBe("pending");
  // Released, so it can be claimed again.
  expect(await store.setFiring("r1")).toBe(true);
});

test("removeOneShot deletes the reminder atomically — the self-clearing behavior", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, id: "r1" });
  await store.setFiring("r1");
  await store.removeOneShot("r1");
  expect(await store.get("r1")).toBeNull();
  expect(await store.list()).toEqual([]);
});

test("rollRecurring advances fireAt and clears the claim back to pending", async () => {
  const { store } = makeStore();
  await store.add({ ...BASE, id: "r1", recurrence: { kind: "daily" } });
  await store.setFiring("r1");
  const next = new Date("2026-07-21T19:00:00.000Z");
  await store.rollRecurring("r1", next);
  const reminder = (await store.get("r1"))!;
  expect(reminder.fireAt).toBe(next.toISOString());
  expect(reminder.status).toBe("pending");
});

test("a fresh store instance re-reads the same file — restart persistence", async () => {
  const { path, store } = makeStore();
  await store.add({ ...BASE, id: "r1" });
  await store.setFiring("r1");

  const restarted = new ReminderStore(path);
  const reminder = (await restarted.get("r1"))!;
  expect(reminder.status).toBe("firing");
  expect(reminder.note).toBe(BASE.note);
});

test("a store with no file yet behaves as empty rather than throwing", async () => {
  const { store } = makeStore();
  expect(await store.list()).toEqual([]);
  expect(await store.get("anything")).toBeNull();
});
