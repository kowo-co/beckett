/**
 * V6 Phase 3b — the routines organ on the extension contract (docs/v6-architecture.md §6).
 * Pins the FIRST background-loop lifecycle: init builds the store + scheduler deps INERT (no
 * interval armed), start rides ONLY the "late" sweep (arms the cron loop, no double-start),
 * stop is idempotent and stills the loop, health reports liveness + census + next fire. Also
 * pins the discovery surface (router prose, FREE reads vs non-FREE mutations), invoke's
 * auth/origin defense and fireNow passthrough to the SAME scheduler core, and the asCapability
 * projection into the CLI's pinned spine slot. The CLI/bus surfaces themselves stay pinned by
 * their characterization suites; `src/routine/*` internals are untouched by the migration and
 * stay pinned by their own suites.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionClass, ExtensionRegistry, asCapability, type ExtensionContext } from "../../ext/index.ts";
import { CapabilityRegistry } from "../index.ts";
import { createRoutinesExtension, type RoutinesExtension, type RoutinesExtensionDeps } from "./routines.ts";
import { RoutineStore } from "../../routine/store.ts";
import type { RoutineScheduler, RoutineSchedulerDeps } from "../../routine/scheduler.ts";
import { validateConfig } from "../../config.ts";
import { buildPaths } from "../../paths.ts";
import type { Config, Logger } from "../../types.ts";

const dirs: string[] = [];
const built: RoutinesExtension[] = [];
afterEach(async () => {
  // Still any armed loop before the temp store dir goes away.
  for (const ext of built.splice(0)) await ext.lifecycle!.stop!();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ctx(configure?: (config: Config) => void): ExtensionContext {
  const config = validateConfig({});
  configure?.(config);
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return { config, paths: buildPaths(config, {}), logger: quiet };
}

/** A clean-slate store in a temp dir (no builtin seeding — the census stays deterministic). */
function tempStore(): RoutineStore {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-ext-"));
  dirs.push(dir);
  return new RoutineStore(join(dir, "routines.json"), { seedBuiltins: false });
}

/** A recording fake scheduler: proves WHEN the loop is armed without arming anything real. */
function fakeScheduler(log: string[]): RoutineScheduler {
  return {
    async tick() {
      log.push("tick");
    },
    async fireNow(id, opts = {}) {
      log.push(`fireNow:${id}:force=${opts.force === true}:dryRun=${opts.dryRun === true}`);
      return {
        routineId: id,
        lane: "browser",
        agentId: null,
        agentInput: null,
        dream: false,
        freeTime: false,
        browserTask: "check the thing",
        depsUpdate: null,
        proactiveSweep: null,
        selfPrompt: null,
        preview: "check the thing",
        credsEntry: "x.com",
        channelId: null,
        requesterId: null,
      };
    },
    stop() {
      log.push("stop");
    },
  };
}

function build(
  overrides: RoutinesExtensionDeps = {},
  configure?: (config: Config) => void,
): {
  ext: RoutinesExtension;
  deps: ExtensionContext;
  schedulerLog: string[];
  schedulerBuilds: RoutineSchedulerDeps[];
} {
  const deps = ctx(configure);
  const schedulerLog: string[] = [];
  const schedulerBuilds: RoutineSchedulerDeps[] = [];
  const ext = createRoutinesExtension({
    createStore: () => tempStore(),
    createScheduler: (sd) => {
      schedulerBuilds.push(sd);
      return fakeScheduler(schedulerLog);
    },
    ...overrides,
  })(deps);
  built.push(ext);
  return { ext, deps, schedulerLog, schedulerBuilds };
}

/** The derived-by-the-core origin identity (ext.invoke strips caller-supplied ids). */
const ORIGIN = { channelId: "chan", userId: "owner-1" };

const ADD_ARGS = {
  id: "daily-check",
  window: "09:00-09:40",
  tz: "America/New_York",
  task: "check the thing",
};

// ── lifecycle: init is inert / start is late-only / stop idempotent ──────────────────────

test("init builds the store INERT; both accessors refuse before their hook has run", async () => {
  const { ext, deps, schedulerBuilds } = build();
  expect(() => ext.store()).toThrow(/not initialized/);
  expect(() => ext.scheduler()).toThrow(/not started/);
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  // The store exists, but NOTHING is armed: no scheduler was constructed, no interval ticks.
  expect(ext.store()).toBeDefined();
  expect(schedulerBuilds).toEqual([]);
  expect(() => ext.scheduler()).toThrow(/not started/);
});

test("start arms the loop in the LATE sweep only, over the init-built store, with no double-start", async () => {
  const { ext, deps, schedulerBuilds } = build();
  expect(ext.lifecycle!.startPhase).toBe("late");
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);

  // The early sweep (crash-recovery organs) must NOT arm a scheduler whose fires dispatch
  // into a system that is not up yet.
  await registry.startAll(deps, "early");
  expect(schedulerBuilds).toEqual([]);

  await registry.startAll(deps, "late");
  expect(schedulerBuilds.length).toBe(1);
  // The scheduler runs over the SAME store init built — one durable source of truth.
  expect(schedulerBuilds[0]!.store).toBe(ext.store());
  expect(ext.scheduler()).toBeDefined();

  // Re-entry is a no-op: a second sweep never arms a second interval.
  await registry.startAll(deps, "late");
  expect(schedulerBuilds.length).toBe(1);
});

test("start refuses when init never ran (the daemon always inits first)", () => {
  const { ext } = build();
  expect(() => (ext.lifecycle!.start! as (c: ExtensionContext) => void)(ctx())).toThrow(/not initialized/);
});

test("the REAL scheduler loop arms on start and stop stills it (idempotent)", async () => {
  // No createScheduler seam here: the true startRoutineScheduler interval, sped up.
  const listCalls: number[] = [];
  const store = tempStore();
  const spied = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "list") {
        return async () => {
          listCalls.push(Date.now());
          return [];
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as RoutineStore;
  const deps = ctx();
  const ext = createRoutinesExtension({ createStore: () => spied, intervalMs: 5 })(deps);
  built.push(ext);
  await ext.lifecycle!.init!(deps);
  await new Promise((r) => setTimeout(r, 25));
  expect(listCalls.length).toBe(0); // init armed nothing

  await ext.lifecycle!.start!(deps);
  await new Promise((r) => setTimeout(r, 40));
  expect(listCalls.length).toBeGreaterThan(0); // the cron loop is live

  await ext.lifecycle!.stop!();
  await ext.lifecycle!.stop!(); // idempotent — a second stop must not throw
  const settled = listCalls.length;
  await new Promise((r) => setTimeout(r, 40));
  expect(listCalls.length).toBe(settled); // stilled
  expect(() => ext.scheduler()).toThrow(/not started/);
});

// ── health: liveness + census + next fire ────────────────────────────────────────────────

test("health reports liveness, the routine census, and the next concrete fire", async () => {
  const NOW = new Date("2026-07-20T12:00:00.000Z");
  const { ext, deps } = build({ now: () => NOW, rng: () => 0 });
  expect(await ext.lifecycle!.health!()).toMatchObject({ ok: false, detail: "not initialized" });

  await ext.lifecycle!.init!(deps);
  await ext.store().add({
    id: "daily-check",
    name: "daily check",
    enabled: true,
    action: { kind: "browser", task: "check the thing" },
    schedule: { cadence: { kind: "daily" }, window: { start: "09:00", end: "09:40", tz: "UTC" } },
  });
  const idle = await ext.lifecycle!.health!();
  expect(idle.ok).toBeTrue();
  // 09:00 UTC already elapsed unfired at 12:00 → the next fire is tomorrow's window (rng 0 → its start).
  expect(idle.detail).toBe("scheduler idle; 1/1 routines enabled; next fire 2026-07-21T09:00:00.000Z");

  await ext.lifecycle!.start!(deps);
  const running = await ext.lifecycle!.health!();
  expect(running.detail).toStartWith("scheduler running; 1/1 routines enabled");
});

// ── discovery: the catalog carries router prose with the right postures ──────────────────

test("advertises the management verb set with router prose; reads FREE, mutations non-FREE", () => {
  const { ext } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  const catalog = registry.catalog();
  expect(catalog.map((entry) => entry.capabilityId)).toEqual([
    "routines.list",
    "routines.inspect",
    "routines.add",
    "routines.remove",
    "routines.fire",
  ]);
  const byId = new Map(catalog.map((entry) => [entry.capabilityId, entry]));
  expect(byId.get("routines.list")!.actionClass).toBe(ActionClass.FREE);
  expect(byId.get("routines.inspect")!.actionClass).toBe(ActionClass.FREE);
  expect(byId.get("routines.add")!.actionClass).toBe(ActionClass.HANDSHAKE_GATED);
  expect(byId.get("routines.remove")!.actionClass).toBe(ActionClass.HANDSHAKE_GATED);
  expect(byId.get("routines.fire")!.actionClass).toBe(ActionClass.ALWAYS_ASK);
  for (const entry of catalog) {
    expect(entry.description.length).toBeGreaterThan(40);
    expect(entry.examples.length).toBeGreaterThan(0);
  }
});

// ── dispatch: invoke routes to the same store/scheduler core and never exits ─────────────

test("routines.list/inspect are FREE reads over the lifecycle store — no origin required", async () => {
  const { ext, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  await ext.store().add({
    id: "daily-check",
    name: "daily check",
    enabled: true,
    action: { kind: "browser", task: "check the thing" },
    schedule: { cadence: { kind: "daily" }, window: { start: "09:00", end: "09:40", tz: "UTC" } },
  });

  const listed = await registry.invoke({ capabilityId: "routines.list", args: {} }, deps);
  expect(listed.ok).toBeTrue();
  const routines = (listed.data as { routines: Array<{ id: string }> }).routines;
  expect(routines.map((r) => r.id)).toEqual(["daily-check"]);

  const inspected = await registry.invoke({ capabilityId: "routines.inspect", args: { id: "daily-check" } }, deps);
  expect(inspected.ok).toBeTrue();
  expect(inspected.data).toMatchObject({ id: "daily-check", action: "browser", window: "09:00-09:40 UTC" });
  expect((inspected.data as { state: unknown }).state).toBeDefined();

  const missing = await registry.invoke({ capabilityId: "routines.inspect", args: { id: "nope" } }, deps);
  expect(missing).toEqual({ ok: false, error: "no such routine: nope" });
});

test("mutating capabilities refuse without an authenticated origin (defense in depth)", async () => {
  const { ext, deps, schedulerLog } = build();
  await ext.lifecycle!.init!(deps);
  await ext.lifecycle!.start!(deps);

  const add = await ext.invoke!({ capabilityId: "routines.add", args: ADD_ARGS }, deps);
  expect(add).toEqual({ ok: false, error: "routine changes need an authenticated authorized request" });
  const remove = await ext.invoke!({ capabilityId: "routines.remove", args: { id: "daily-check" } }, deps);
  expect(remove).toEqual({ ok: false, error: "routine changes need an authenticated authorized request" });
  const fire = await ext.invoke!({ capabilityId: "routines.fire", args: { id: "daily-check" } }, deps);
  expect(fire).toEqual({ ok: false, error: "firing a routine needs an authenticated authorized request" });
  expect((await ext.store().list()).length).toBe(0);
  expect(schedulerLog).toEqual([]);
});

test("routines.add validates at the seam, may restate but never redirect the report channel", async () => {
  const { ext, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);

  const invalid = await registry.invoke(
    { capabilityId: "routines.add", args: { ...ADD_ARGS, window: "9-10" }, origin: ORIGIN },
    deps,
  );
  expect(invalid.ok).toBeFalse();
  expect(invalid.error).toContain("invalid args");

  const redirected = await registry.invoke(
    { capabilityId: "routines.add", args: { ...ADD_ARGS, channelId: "elsewhere" }, origin: ORIGIN },
    deps,
  );
  expect(redirected).toEqual({
    ok: false,
    error: "routines must report to the channel where the authorized request began",
  });
  expect((await ext.store().list()).length).toBe(0);

  // A vault entry name unrelated to "x.com" — the routine store's boot-time credsEntry
  // migration (W4A: heals the dead "x.com" jingle entry to "x-account") would otherwise rewrite
  // it on the next load, which is not what THIS test is exercising (plain add pass-through).
  const added = await registry.invoke(
    { capabilityId: "routines.add", args: { ...ADD_ARGS, channelId: "chan", credsEntry: "example-vault-entry" }, origin: ORIGIN },
    deps,
  );
  expect(added.ok).toBeTrue();
  expect(added.data).toMatchObject({ id: "daily-check", enabled: true, window: "09:00-09:40 America/New_York" });
  const stored = await ext.store().get("daily-check");
  expect(stored!.action).toEqual({ kind: "browser", task: "check the thing", credsEntry: "example-vault-entry", channelId: "chan" });

  // The store's own duplicate guard surfaces as a result, never an exit.
  const dup = await registry.invoke({ capabilityId: "routines.add", args: ADD_ARGS, origin: ORIGIN }, deps);
  expect(dup).toEqual({ ok: false, error: "routine already exists: daily-check" });

  const removed = await registry.invoke({ capabilityId: "routines.remove", args: { id: "daily-check" }, origin: ORIGIN }, deps);
  expect(removed).toEqual({ ok: true, data: { removed: "daily-check" } });
  expect((await ext.store().list()).length).toBe(0);
});

test("routines.fire passes through to the LIVE scheduler's fireNow and returns the plan", async () => {
  const { ext, deps, schedulerLog } = build();
  await ext.lifecycle!.init!(deps);

  // Before the late start there is no live scheduler — a result, not a throw.
  const early = await ext.invoke!({ capabilityId: "routines.fire", args: { id: "daily-check" }, origin: ORIGIN }, deps);
  expect(early.ok).toBeFalse();
  expect(early.error).toContain("not started");

  await ext.lifecycle!.start!(deps);
  const fired = await ext.invoke!(
    { capabilityId: "routines.fire", args: { id: "daily-check", force: true }, origin: ORIGIN },
    deps,
  );
  expect(fired).toEqual({
    ok: true,
    data: { routineId: "daily-check", lane: "browser", preview: "check the thing", credsEntry: "x.com", dryRun: false },
  });
  const dry = await ext.invoke!(
    { capabilityId: "routines.fire", args: { id: "daily-check", dryRun: true }, origin: ORIGIN },
    deps,
  );
  expect(dry.ok).toBeTrue();
  expect((dry.data as { dryRun: boolean }).dryRun).toBeTrue();
  expect(schedulerLog).toEqual([
    "fireNow:daily-check:force=true:dryRun=false",
    "fireNow:daily-check:force=false:dryRun=true",
  ]);
});

test("unknown capabilities and pre-init calls refuse with results", async () => {
  const { ext, deps } = build();
  const early = await ext.invoke!({ capabilityId: "routines.list", args: {} }, deps);
  expect(early.ok).toBeFalse();
  expect(early.error).toContain("not initialized");

  await ext.lifecycle!.init!(deps);
  const unknown = await ext.invoke!({ capabilityId: "routines.nope", args: {} }, deps);
  expect(unknown).toEqual({ ok: false, error: 'routines: unknown capability "routines.nope"' });
});

// ── the deps-update lane forks BEFORE the browser (issue #85) ─────────────────────────────

/** A plan shaped like the scheduler builds one, minus the fields the lane under test ignores. */
function planFor(kind: "deps-update" | "browser" | "self" | "dream" | "spend-report" | "free-time") {
  return {
    routineId:
      kind === "self" ? "morning-sweep"
      : kind === "dream" ? "nightly-dream"
      : kind === "free-time" ? "weekly-free-time"
      : kind === "spend-report" ? "weekly-spend-report"
      : "weekly-deps-update",
    // The dream and free-time variants ride the self LANE; only their flag differs.
    lane: kind === "dream" || kind === "free-time" ? "self" : kind,
    agentId: null,
    agentInput: null,
    browserTask: kind === "browser" ? "go do the thing" : null,
    depsUpdate: kind === "deps-update" ? { repo: null, base: "main", sourceRepo: null } : null,
    selfPrompt: kind === "self" ? "look over the board and nudge anything stalled" : null,
    dream: kind === "dream",
    freeTime: kind === "free-time",
    preview: "p",
    credsEntry: null,
    channelId: null,
    requesterId: null,
  };
}

/**
 * Grab the dispatch closure the extension hands its scheduler. `createScheduler` receives the same
 * `RoutineSchedulerDeps` the real loop would, so this exercises the PRODUCTION dispatcher.
 */
async function dispatcherOf(overrides: RoutinesExtensionDeps, configure?: (config: Config) => void) {
  const { ext, deps, schedulerBuilds } = build(
    {
      defaultOrigin: () => ({ channelId: "chan", requesterId: "owner-1" }),
      ...overrides,
    },
    configure,
  );
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  await registry.startAll(deps, "late");
  return schedulerBuilds[0]!.dispatcher;
}

/** Any accessor built from this must never be reached on the deps-update lane. */
function exploding(): RoutinesExtensionDeps {
  const boom = (what: string) => () => {
    throw new Error(`the deps-update lane reached ${what}`);
  };
  return {
    browserAgent: boom("the browser agent") as never,
    agentRegistry: boom("the agent registry") as never,
    agentRunner: boom("the agent runner") as never,
  };
}

test("a deps-update fire launches its own process and never resolves the browser lane", async () => {
  const launched: string[][] = [];
  const dispatcher = await dispatcherOf({
    ...exploding(),
    spawnDepsUpdate: (argv) => void launched.push(argv),
  });

  // If the dispatcher touched browserAgent/agentRegistry/agentRunner this would throw.
  await dispatcher.dispatch(planFor("deps-update") as never, {} as never);

  expect(launched.length).toBe(1);
  const argv = launched[0]!;
  expect(argv.slice(0, 2)).toEqual(["routine", "deps-update"]);
  expect(argv[argv.indexOf("--base") + 1]).toBe("main");
  // The fire-time origin is threaded through so the subprocess knows where to post its one line.
  expect(argv[argv.indexOf("--channel") + 1]).toBe("chan");
  expect(argv[argv.indexOf("--requester") + 1]).toBe("owner-1");
});

test("a spend-report fire launches its own process and never resolves the browser lane (#77)", async () => {
  const launched: string[][] = [];
  const dispatcher = await dispatcherOf({
    ...exploding(), // browserAgent/agentRegistry/agentRunner all throw if the lane reaches them
    spawnSpendReport: (argv) => void launched.push(argv),
  });

  // Passing a real routine so the lane can read its `since`; an over-budget dispatch must never
  // touch the browser deps (they'd throw), proving the bill forks before the browser-deps check.
  await dispatcher.dispatch(
    planFor("spend-report") as never,
    { action: { kind: "spend-report", since: "14d" } } as never,
  );

  expect(launched.length).toBe(1);
  const argv = launched[0]!;
  expect(argv.slice(0, 2)).toEqual(["routine", "spend-report"]);
  expect(argv[argv.indexOf("--since") + 1]).toBe("14d");
  // The fire-time origin is threaded through so the subprocess knows where to post the bill.
  expect(argv[argv.indexOf("--channel") + 1]).toBe("chan");
  expect(argv[argv.indexOf("--requester") + 1]).toBe("owner-1");
});

test("the browser lane still goes to the browser — the fork is on the lane, not luck", async () => {
  const posted: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => null }),
    agentRunner: () => ({ run: async () => ({ state: "done", output: "x" }) }) as never,
    spawnDepsUpdate: () => {
      throw new Error("a browser routine took the deps-update lane");
    },
  });
  await dispatcher.dispatch(planFor("browser") as never, {} as never);
  expect(posted).toEqual(["go do the thing"]);
});

test("a self fire wakes the concierge and never resolves the browser lane (issue #26)", async () => {
  const woke: Array<{ routineId: string; prompt: string; channelId: string }> = [];
  const dispatcher = await dispatcherOf({
    ...exploding(), // browserAgent/agentRegistry/agentRunner all throw if the lane reaches them
    wakeSelf: (post) => void woke.push(post),
  });

  // If the dispatcher touched browserAgent/agentRegistry/agentRunner this would throw — proving the
  // self lane forks BEFORE that requirement check, exactly like deps-update.
  await dispatcher.dispatch(planFor("self") as never, {} as never);

  expect(woke.length).toBe(1);
  expect(woke[0]!.routineId).toBe("morning-sweep");
  expect(woke[0]!.prompt).toBe("look over the board and nudge anything stalled");
  // The fire-time origin is threaded through so the framed turn knows which channel to report to.
  expect(woke[0]!.channelId).toBe("chan");
});

test("a dream fire spawns its contained process on the self lane — never the browser, never a concierge wake (issue #36)", async () => {
  const launched: string[][] = [];
  const dispatcher = await dispatcherOf({
    // If the dream fork ever reached the browser agent/registry/runner, these throw — proving it
    // forks on the self lane BEFORE the browser-deps requirement check, exactly like deps-update.
    ...exploding(),
    wakeSelf: () => {
      throw new Error("a dream fire framed a concierge turn — the dream must never hold the concierge's shell");
    },
    spawnDream: (argv) => void launched.push(argv),
  });

  await dispatcher.dispatch(planFor("dream") as never, {} as never);

  expect(launched.length).toBe(1);
  expect(launched[0]!.slice(0, 2)).toEqual(["dream", "run"]);
  const routineFlag = launched[0]!.indexOf("--routine");
  expect(routineFlag).toBeGreaterThan(-1);
  expect(launched[0]![routineFlag + 1]).toBe("nightly-dream");
  // Nothing secret-shaped or creds-shaped rides the argv.
  expect(launched[0]!.join(" ")).not.toContain("--creds");
});

test("a free-time fire spawns its contained process on the self lane — never the browser, never a concierge wake", async () => {
  const launched: string[][] = [];
  const dispatcher = await dispatcherOf({
    // Same proof as the dream's: reaching the browser agent/registry/runner throws, so this
    // passing means free time forks on the self lane BEFORE the browser-deps requirement check.
    ...exploding(),
    wakeSelf: () => {
      throw new Error("a free-time fire framed a concierge turn — the session must not hold the concierge's shell");
    },
    spawnDream: () => {
      throw new Error("a free-time fire took the dream fork");
    },
    spawnFreeTime: (argv) => void launched.push(argv),
  });

  await dispatcher.dispatch(planFor("free-time") as never, {} as never);

  expect(launched.length).toBe(1);
  expect(launched[0]!.slice(0, 2)).toEqual(["free-time", "run"]);
  const routineFlag = launched[0]!.indexOf("--routine");
  expect(routineFlag).toBeGreaterThan(-1);
  expect(launched[0]![routineFlag + 1]).toBe("weekly-free-time");
  expect(launched[0]!.join(" ")).not.toContain("--creds");
});

test("[free_time] enabled=false refuses the fire before anything spawns (the human off-switch)", async () => {
  const dispatcher = await dispatcherOf(
    {
      ...exploding(),
      spawnFreeTime: () => {
        throw new Error("a disabled free-time routine still launched a session");
      },
    },
    (config) => {
      config.free_time.enabled = false;
    },
  );
  // Refused, not thrown: the period stays claimed and the week closes quietly.
  await dispatcher.dispatch(planFor("free-time") as never, {} as never);
});

test("the idle gate defers a free-time fire on a busy machine and only that fire", async () => {
  let fleetIdle = false;
  const { ext, deps, schedulerBuilds } = build({
    defaultOrigin: () => ({ channelId: "chan", requesterId: "owner-1" }),
    isFleetIdle: () => fleetIdle,
    conciergeQuiet: () => true,
  });
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  await registry.startAll(deps, "late");
  const dispatcher = schedulerBuilds[0]!.dispatcher;

  expect(dispatcher.deferReason?.(planFor("free-time") as never, {} as never)).toContain("worker fleet is busy");
  // Nothing else is ever deferred — the veto is free time's alone.
  expect(dispatcher.deferReason?.(planFor("dream") as never, {} as never)).toBeNull();
  fleetIdle = true;
  expect(dispatcher.deferReason?.(planFor("free-time") as never, {} as never)).toBeNull();
});

test("a dream fire still resolves an origin like every routine (attribution only)", async () => {
  const dispatcher = await dispatcherOf({
    defaultOrigin: () => ({ channelId: null, requesterId: null }),
    spawnDream: () => {
      throw new Error("launched without an origin");
    },
  });
  await expect(dispatcher.dispatch(planFor("dream") as never, {} as never))
    .rejects.toThrow(/origin channel \+ requester/);
});

test("a self fire still needs an origin channel to report to", async () => {
  const dispatcher = await dispatcherOf({
    defaultOrigin: () => ({ channelId: null, requesterId: null }),
    wakeSelf: () => {
      throw new Error("woke without an origin");
    },
  });
  await expect(dispatcher.dispatch(planFor("self") as never, {} as never))
    .rejects.toThrow(/origin channel \+ requester/);
});

test("a deps-update fire still needs an origin channel + requester to report to", async () => {
  const dispatcher = await dispatcherOf({
    defaultOrigin: () => ({ channelId: null, requesterId: null }),
    spawnDepsUpdate: () => {
      throw new Error("launched without an origin");
    },
  });
  await expect(dispatcher.dispatch(planFor("deps-update") as never, {} as never))
    .rejects.toThrow(/origin channel \+ requester/);
});

// ── the Phase 1–4 bridge: the CLI registers the projection ───────────────────────────────

test("asCapability projects the carried v5 facets into the pinned CLI spine slot", () => {
  // The CLI's exact registration: NO deps — its process never runs a lifecycle hook.
  const projected = asCapability(createRoutinesExtension({})(ctx()));
  expect(projected.id).toBe("routines");
  expect(projected.summary).toBe("humanized recurring routines: add/list/remove/inspect + fire (dry-run or --force)");
  expect(projected.actionClass).toBe(ActionClass.FREE);
  // The advertised help token is UNCHANGED by #85's deps-update verb: that verb is a routine's
  // body, launched by the scheduler, so it stays unadvertised (like spend/journal/config) and the
  // composed `beckett` command list the CLI characterization suite pins is byte-identical.
  expect(projected.cliHelp).toBe("routine list|inspect|add|remove|fire");
  expect(projected.cliVerbs.map((v) => v.name)).toEqual([
    "routine deps-update",
    "routine proactive-sweep",
    "routine spend-report",
    "routine",
  ]);
  expect(projected.cliVerbs.every((v) => typeof v.run === "function")).toBe(true);
  expect(projected.busCommands).toEqual([]);

  // The projection registers cleanly into the v5 spine (the CLI's exact move).
  const spine = new CapabilityRegistry();
  spine.register(projected);
  expect(spine.resolveCliVerb(["routine", "list"])!.capability.id).toBe("routines");
  // Longest-verb-first resolution: `routine deps-update` must win over the bare `routine`, or the
  // scheduler's subprocess would land in runRoutine's usage cascade.
  expect(spine.resolveCliVerb(["routine", "deps-update", "--base", "main"])!.verb.name)
    .toBe("routine deps-update");
});
