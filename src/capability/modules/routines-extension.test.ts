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
function planFor(kind: "deps-update" | "browser" | "self" | "spend-report" | "free-time") {
  return {
    routineId:
      kind === "self" ? "morning-sweep"
      : kind === "free-time" ? "weekly-free-time"
      : kind === "spend-report" ? "weekly-spend-report"
      : "weekly-deps-update",
    // The free-time variant rides the self LANE; only its flag differs.
    lane: kind === "free-time" ? "self" : kind,
    agentId: null,
    agentInput: null,
    browserTask: kind === "browser" ? "go do the thing" : null,
    depsUpdate: kind === "deps-update" ? { repo: null, base: "main", sourceRepo: null } : null,
    selfPrompt: kind === "self" ? "look over the board and nudge anything stalled" : null,
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

// ── the agent lane's POST: contract routes through chilltext before the browser (W4A) ────

/** A plan shaped like the scheduler builds one for the `agent` lane. */
function agentPlanFor(agentId: string, agentInput: string) {
  return {
    routineId: "daily-x-shitpost",
    lane: "agent" as const,
    agentId,
    agentInput,
    browserTask: null,
    depsUpdate: null,
    selfPrompt: null,
    freeTime: false,
    preview: "p",
    credsEntry: "x-account",
    channelId: null,
    requesterId: null,
  };
}

test("an agent-lane POST: output routes through the injected chillTransform before hitting the browser lane", async () => {
  const posted: string[] = [];
  const chillCalls: Array<{ cfg: { url: string; timeout_ms: number }; req: { agentOutput: string } }> = [];
  const dispatcher = await dispatcherOf(
    {
      browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
      agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
      agentRunner: () => ({ run: async () => ({ state: "done", output: "POST: infra is on fire again" }) }) as never,
      // The seam under test: production wiring binds this to the real chilltext.ts client and
      // the real global fetch. Injecting it here proves that seam is exercised — and reachable —
      // without a live network call, per the routine-extension DI pattern the other lanes use.
      chillTransform: async (cfg, req) => {
        chillCalls.push({ cfg, req });
        return { messages: ["infra's on fire again, groundhog day fr"] };
      },
    },
    (config) => {
      config.social.chill = true;
      config.concierge.chilltext.url = "https://chilltext.example";
      config.concierge.chilltext.timeout_ms = 1234;
    },
  );

  await dispatcher.dispatch(agentPlanFor("social-media", "") as never, {} as never);

  // The transform was actually called, with the configured url/timeout — not skipped.
  expect(chillCalls.length).toBe(1);
  expect(chillCalls[0]!.cfg).toMatchObject({ url: "https://chilltext.example", timeout_ms: 1234 });
  expect(chillCalls[0]!.req.agentOutput).toBe("infra is on fire again");
  // The chilled text — not the raw draft — reaches the browser task.
  expect(posted.length).toBe(1);
  expect(posted[0]).toContain("infra's on fire again, groundhog day fr");
  expect(posted[0]).not.toContain("infra is on fire again");
});

test("an agent-lane POST: output fails open to the draft when chillTransform errors", async () => {
  const posted: string[] = [];
  const dispatcher = await dispatcherOf(
    {
      browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
      agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
      agentRunner: () => ({ run: async () => ({ state: "done", output: "POST: ship it" }) }) as never,
      chillTransform: async () => {
        throw new Error("chilltext is down");
      },
    },
    (config) => {
      config.social.chill = true;
    },
  );

  await dispatcher.dispatch(agentPlanFor("social-media", "") as never, {} as never);

  expect(posted.length).toBe(1);
  expect(posted[0]).toContain("ship it");
});

// ── the social-media agent's mandatory grounding step (real-sources ticket, Half 1) ──────────

test("a compose fire appends the fetched SOURCES block to the agent's input before it composes", async () => {
  const seenInputs: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run() { return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async (_def: unknown, input: string) => {
        seenInputs.push(input);
        return { state: "done", output: "POST: fine" };
      },
    }) as never,
    gatherGrounding: async () => "SOURCES FOR THIS RUN (read before you write anything) — fake test sources",
  });

  await dispatcher.dispatch(agentPlanFor("social-media", "Compose today's shitpost.") as never, {} as never);

  expect(seenInputs).toHaveLength(1);
  expect(seenInputs[0]).toContain("Compose today's shitpost.");
  expect(seenInputs[0]).toContain("SOURCES FOR THIS RUN");
  expect(seenInputs[0]).toContain("fake test sources");
});

test("an unwired grounding dependency degrades to the honest unavailable note — no live network call", async () => {
  const seenInputs: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run() { return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async (_def: unknown, input: string) => {
        seenInputs.push(input);
        return { state: "done", output: "POST: fine" };
      },
    }) as never,
    // No gatherGrounding provided — this must never attempt a real fetch.
  });

  await dispatcher.dispatch(agentPlanFor("social-media", "Compose today's shitpost.") as never, {} as never);

  expect(seenInputs).toHaveLength(1);
  expect(seenInputs[0]).toContain("SOURCES FOR THIS RUN: none available");
});

test("a failing grounding fetch is caught and falls back to the unavailable note, not a thrown error", async () => {
  const seenInputs: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run() { return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async (_def: unknown, input: string) => {
        seenInputs.push(input);
        return { state: "done", output: "POST: fine" };
      },
    }) as never,
    gatherGrounding: async () => {
      throw new Error("network exploded");
    },
  });

  await dispatcher.dispatch(agentPlanFor("social-media", "Compose today's shitpost.") as never, {} as never);

  expect(seenInputs).toHaveLength(1);
  expect(seenInputs[0]).toContain("SOURCES FOR THIS RUN: none available");
});

test("a TIMELINE REPLY ROUND fire never fetches grounding sources — its grounding is the live page", async () => {
  const seenInputs: string[] = [];
  let groundingCalls = 0;
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run() { return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async (_def: unknown, input: string) => {
        seenInputs.push(input);
        return { state: "done", output: "go read the timeline" };
      },
    }) as never,
    gatherGrounding: async () => {
      groundingCalls++;
      return "SOURCES FOR THIS RUN — should never appear here";
    },
  });

  await dispatcher.dispatch(
    agentPlanFor("social-media", "TIMELINE REPLY ROUND: open the home timeline...") as never,
    {} as never,
  );

  expect(groundingCalls).toBe(0);
  expect(seenInputs).toEqual(["TIMELINE REPLY ROUND: open the home timeline..."]);
});

// ── the hard stop: a grounded fire with no POST: line must never reach the browser lane ──────
// (fabricated-posts ticket, 2026-08-22: `daily-x-shitpost-4` posted a fabricated AWS-lockout
// story because the compose-time agent's whole freeform output — never grounded by SOURCES, since
// it was never sent to a second agent that had them — was handed straight to the background
// browser lane under the legacy no-`POST:`-line fallback. See routines.ts#dispatchAgentLane.)

test("a compose fire whose agent output has no POST: line is refused, never shipped to the browser lane ungrounded", async () => {
  const posted: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async () => ({
        state: "done",
        // No `POST:` line — a freeform, self-authored browser instruction, exactly the shape that
        // let the browser-driving agent invent the AWS-lockout incident with zero grounding.
        output:
          "Log into X and compose one fresh post in voice, rotating across tech news and your own actual life...",
      }),
    }) as never,
    gatherGrounding: async () => "SOURCES FOR THIS RUN — real sources were fetched this run",
  });

  await expect(
    dispatcher.dispatch(agentPlanFor("social-media", "Compose today's shitpost.") as never, {} as never),
  ).rejects.toThrow(/did not follow the POST: output contract/);

  expect(posted).toEqual([]);
});

test("a legacy x-shitpost fire with no POST: line is refused the same way as the new compose shape", async () => {
  const posted: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({ run: async () => ({ state: "done", output: "just going to wing this one" }) }) as never,
    gatherGrounding: async () => "SOURCES FOR THIS RUN — real sources were fetched this run",
  });

  await expect(
    dispatcher.dispatch(
      agentPlanFor(
        "social-media",
        "Compose today's shitpost — one fresh, in-voice line — and author the browser task that posts it to X.",
      ) as never,
      {} as never,
    ),
  ).rejects.toThrow(/did not follow the POST: output contract/);

  expect(posted).toEqual([]);
});

test("an EVENT TRIGGER fire with no POST: line is refused the same way as a plain compose fire — it skips the SOURCES fetch but not the hard stop", async () => {
  const posted: string[] = [];
  let groundingCalls = 0;
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async () => ({
        state: "done",
        // No `POST:` line — the same shape that let the browser-driving agent invent an incident
        // with zero grounding, this time on the `watch` lane's own EVENT TRIGGER fire
        // (needsGroundingSources returns false for it, so it never sees a fetched SOURCES block —
        // but it still owes the OUTPUT CONTRACT, and this is the same fallback hole either way).
        output: "Log into X and post something about the new model release, in voice...",
      }),
    }) as never,
    gatherGrounding: async () => {
      groundingCalls++;
      return "SOURCES FOR THIS RUN — should never be fetched for an EVENT TRIGGER";
    },
  });

  await expect(
    dispatcher.dispatch(
      agentPlanFor(
        "social-media",
        "EVENT TRIGGER (not a scheduled lane): the model-news feed just reported a new model release.",
      ) as never,
      {} as never,
    ),
  ).rejects.toThrow(/did not follow the POST: output contract/);

  expect(groundingCalls).toBe(0);
  expect(posted).toEqual([]);
});

test("a TIMELINE REPLY ROUND fire keeps the legacy whole-output-is-the-task fallback — it is exempt from the hard stop", async () => {
  const posted: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({ run: async () => ({ state: "done", output: "go read the timeline and reply" }) }) as never,
    gatherGrounding: async () => {
      throw new Error("grounding must never be fetched for a TIMELINE REPLY ROUND");
    },
  });

  await dispatcher.dispatch(
    agentPlanFor("social-media", "TIMELINE REPLY ROUND: open the home timeline...") as never,
    {} as never,
  );

  expect(posted).toEqual(["go read the timeline and reply"]);
});

test("a non-social-media agent's input is never touched by the grounding step", async () => {
  const seenInputs: string[] = [];
  let groundingCalls = 0;
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run() { return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "some-other-agent" }) }) as never,
    agentRunner: () => ({
      run: async (_def: unknown, input: string) => {
        seenInputs.push(input);
        return { state: "done", output: "POST: fine" };
      },
    }) as never,
    gatherGrounding: async () => {
      groundingCalls++;
      return "SOURCES";
    },
  });

  await dispatcher.dispatch(agentPlanFor("some-other-agent", "do a thing") as never, {} as never);

  expect(groundingCalls).toBe(0);
  expect(seenInputs).toEqual(["do a thing"]);
});

// ── the grounding-verification gate (real-sources ticket, Half 2: enforce, don't just ask) ──────

/** The exact fabricated post from the 2026-08-22T01:34 PT incident — Beckett has no AWS account. */
const AWS_LOCKOUT_POST =
  'aws locked me out for twenty minutes today over "unusual activity" right after i rotated an ssh key i\'ve had since 2021. the unusual activity was rotating the key';

test("the AWS-lockout post, checked against sources that never mention AWS, is REFUSED — nothing reaches the browser lane", async () => {
  const posted: string[] = [];
  const verifyCalls: Array<{ postText: string; sourcesBlock: string }> = [];
  const notified: Array<{ channelId: string; text: string }> = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async () => ({ state: "done", output: `POST: ${AWS_LOCKOUT_POST}` }),
    }) as never,
    gatherGrounding: async () => "SOURCES FOR THIS RUN — real tech news, fetched this run — (nothing about AWS)",
    verifyGrounding: async (postText, sourcesBlock) => {
      verifyCalls.push({ postText, sourcesBlock });
      return { claims: [{ claim: postText, tracesToSource: false, sourceLine: "" }], reason: "no AWS entry in sources", grounded: false };
    },
    notifyOrigin: async (channelId, text) => {
      notified.push({ channelId, text });
    },
  });

  await dispatcher.dispatch(agentPlanFor("social-media", "Compose today's shitpost.") as never, {} as never);

  // NEVER dispatched to the browser lane — refused twice (the one allowed retry also refused,
  // since the fake agent keeps authoring the same unfounded claim).
  expect(posted).toEqual([]);
  expect(verifyCalls.length).toBe(2); // the original attempt + the one allowed retry
  for (const call of verifyCalls) {
    expect(call.postText).toBe(AWS_LOCKOUT_POST);
    expect(call.sourcesBlock).toContain("nothing about AWS");
  }
  // Refusal is a visible outcome, not a silent drop — logged AND reported to the origin channel.
  expect(notified.length).toBe(1);
  expect(notified[0]!.channelId).toBe("chan");
  expect(notified[0]!.text).toContain(AWS_LOCKOUT_POST);
  expect(notified[0]!.text.toLowerCase()).toContain("refused");
});

test("a post whose claim traces to a real source line PASSES and reaches the browser lane", async () => {
  const posted: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async () => ({
        state: "done",
        output: "POST: crashed and came back today and nobody even noticed. humbling.",
      }),
    }) as never,
    gatherGrounding: async () =>
      "SOURCES FOR THIS RUN\n\n— Beckett's own real history —\n- [uptime ledger, 2026-08-21T09:00:00Z] the daemon restarted unclean",
    verifyGrounding: async (postText) => ({
      claims: [{ claim: postText, tracesToSource: true, sourceLine: "uptime ledger, 2026-08-21T09:00:00Z" }],
      reason: "traced to the uptime ledger",
      grounded: true,
    }),
  });

  await dispatcher.dispatch(agentPlanFor("social-media", "Compose today's shitpost.") as never, {} as never);

  expect(posted.length).toBe(1);
  expect(posted[0]).toContain("crashed and came back");
});

test("a refused first draft that's corrected on retry publishes the CORRECTED post, not the refused one", async () => {
  const posted: string[] = [];
  const authored: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({
      run: async (_def: unknown, input: string) => {
        authored.push(input);
        // First call authors the fabrication; the retry (its input carries the refusal reason)
        // authors something else entirely.
        const isRetry = input.includes("REFUSED by the grounding-verification gate");
        return { state: "done", output: isRetry ? "POST: a flat bad opinion about tabs vs spaces. that's it." : `POST: ${AWS_LOCKOUT_POST}` };
      },
    }) as never,
    gatherGrounding: async () => "SOURCES FOR THIS RUN — (nothing about AWS)",
    verifyGrounding: async (postText) =>
      postText === AWS_LOCKOUT_POST
        ? { claims: [{ claim: postText, tracesToSource: false }], reason: "no AWS entry", grounded: false }
        : { claims: [], reason: "pure opinion, nothing to trace", grounded: true },
  });

  await dispatcher.dispatch(agentPlanFor("social-media", "Compose today's shitpost.") as never, {} as never);

  expect(authored.length).toBe(2);
  expect(posted.length).toBe(1);
  expect(posted[0]).toContain("tabs vs spaces");
  expect(posted[0]).not.toContain("aws locked me out");
});

test("an unwired verifier degrades to an open pass (test-harness safety) — production always wires the real gate", async () => {
  const posted: string[] = [];
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({ run: async () => ({ state: "done", output: "POST: fine" }) }) as never,
    gatherGrounding: async () => "SOURCES FOR THIS RUN — fake test sources",
    // No verifyGrounding provided.
  });

  await dispatcher.dispatch(agentPlanFor("social-media", "Compose today's shitpost.") as never, {} as never);
  expect(posted.length).toBe(1);
});

test("a TIMELINE REPLY ROUND fire never calls the grounding-verification gate — it skips the compose gate entirely", async () => {
  const posted: string[] = [];
  let verifyCalls = 0;
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({ run: async () => ({ state: "done", output: "go read the timeline" }) }) as never,
    gatherGrounding: async () => "SOURCES FOR THIS RUN — should never be fetched here",
    verifyGrounding: async (postText, sourcesBlock) => {
      verifyCalls++;
      return { claims: [], reason: "should never be called", grounded: true };
    },
  });

  await dispatcher.dispatch(
    agentPlanFor("social-media", "TIMELINE REPLY ROUND: open the home timeline...") as never,
    {} as never,
  );

  expect(verifyCalls).toBe(0);
  expect(posted.length).toBe(1); // unaffected — the fire still dispatches normally
});

test("a watch-lane EVENT TRIGGER fire never calls the grounding-verification gate — it skips the compose gate entirely", async () => {
  const posted: string[] = [];
  let verifyCalls = 0;
  const dispatcher = await dispatcherOf({
    browserAgent: () => ({ async run(task: string) { posted.push(task); return undefined as never; } }) as never,
    agentRegistry: () => ({ get: () => ({ id: "social-media" }) }) as never,
    agentRunner: () => ({ run: async () => ({ state: "done", output: "POST: reacting to the event" }) }) as never,
    gatherGrounding: async () => "SOURCES FOR THIS RUN — should never be fetched here",
    verifyGrounding: async () => {
      verifyCalls++;
      return { claims: [], reason: "should never be called", grounded: true };
    },
  });

  await dispatcher.dispatch(
    agentPlanFor("social-media", "EVENT TRIGGER (not a scheduled lane): the model-news feed...") as never,
    {} as never,
  );

  expect(verifyCalls).toBe(0);
  expect(posted.length).toBe(1); // unaffected — the fire still dispatches normally
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

test("a free-time fire spawns its contained process on the self lane — never the browser, never a concierge wake", async () => {
  const launched: string[][] = [];
  const dispatcher = await dispatcherOf({
    // Reaching the browser agent/registry/runner throws, so this passing means free time forks
    // on the self lane BEFORE the browser-deps requirement check.
    ...exploding(),
    wakeSelf: () => {
      throw new Error("a free-time fire framed a concierge turn — the session must not hold the concierge's shell");
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
  expect(dispatcher.deferReason?.(planFor("self") as never, {} as never)).toBeNull();
  fleetIdle = true;
  expect(dispatcher.deferReason?.(planFor("free-time") as never, {} as never)).toBeNull();
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

// ── overhaul B-P16 (Task 4): the sweep's repo list is config-only, `add`/`remove` are gone ──

/** Spawns the real `beckett` CLI (task-cli.test.ts's pattern) — `runRoutine` calls `out`/`fail`
 *  (`process.exit`), so this is the only way to observe its stdout/stderr/exit code in-process. */
async function beckett(
  dir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "..", "cli", "beckett.ts"), ...args],
    {
      cwd: join(import.meta.dir, "..", "..", ".."),
      env: { ...process.env, BECKETT_DIR: dir, BECKETT_HOME: dir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("beckett routine proactive add is gone and points at config.toml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-routines-cli-"));
  dirs.push(dir);

  const list = await beckett(dir, ["routine", "proactive", "list"]);
  expect(list.code).toBe(0);
  const listed = JSON.parse(list.stdout);
  expect(listed).toMatchObject({ routine: "proactive-sweep", repos: [], source: "config.toml [proactive_sweep] repos" });

  const add = await beckett(dir, ["routine", "proactive", "add", "kowo-co/beckett"]);
  expect(add.code).toBe(1);
  expect(add.stderr).toContain("[proactive_sweep] repos");
  expect(add.stderr).toContain("config.toml");

  const remove = await beckett(dir, ["routine", "proactive", "remove", "kowo-co/beckett"]);
  expect(remove.code).toBe(1);
  expect(remove.stderr).toContain("[proactive_sweep] repos");
}, 20_000);
