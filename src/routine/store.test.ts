import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineStore } from "./store.ts";
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

test("setProactiveRepos edits the built-in sweep's opt-in list (de-duped, order-stable)", async () => {
  const { store } = makeStore();
  // Ships enabled but with an EMPTY list — dormant until a repo is opted in.
  const seeded = await store.get("proactive-sweep");
  expect(seeded!.action.kind).toBe("proactive-sweep");
  if (seeded!.action.kind === "proactive-sweep") expect(seeded!.action.repos).toEqual([]);

  const updated = await store.setProactiveRepos("proactive-sweep", ["me/a", " me/b ", "me/a"]);
  if (updated.action.kind === "proactive-sweep") expect(updated.action.repos).toEqual(["me/a", "me/b"]);

  // It refuses to write repos onto a non-sweep routine.
  await expect(store.setProactiveRepos("daily-x-shitpost", ["me/a"])).rejects.toThrow(/not a "proactive-sweep"/);
});
