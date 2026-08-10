/**
 * V6 Phase 2 — the browser organ on the extension contract (docs/v6-architecture.md §6).
 * Pins the FIRST STATEFUL lifecycle: init constructs both subprocess owners INERT (no host
 * spawn, no recover), start runs the agent's durable-ledger recover (riding the post-concierge
 * startAll sweep), stop settles agent legs BEFORE killing the host, and health maps both
 * stats. Plus the discovery surface: five advertised capabilities with router prose (never
 * the internal browser.eval bridge) and an invoke that routes to the agent/runtime and never
 * exits the process. The CLI/bus surfaces stay pinned by their characterization suites.
 */

import { expect, test } from "bun:test";
import { ActionClass, ExtensionRegistry, type ExtensionContext } from "../../ext/index.ts";
import { createBrowserExtension, type BrowserExtension } from "./browser.ts";
import type { BrowserAgent, BrowserAgentStats } from "../../browser/agent.ts";
import type { BrowserEvalResult, BrowserRuntime } from "../../browser/runtime.ts";
import { validateConfig } from "../../config.ts";
import { buildPaths } from "../../paths.ts";
import type { Logger } from "../../types.ts";

function ctx(): ExtensionContext {
  const config = validateConfig({});
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return { config, paths: buildPaths(config, {}), logger: quiet };
}

function fakeRuntime(calls: string[], maxConcurrentLeases = 3): BrowserRuntime {
  let lease: string | null = null;
  return {
    async acquire(next) {
      calls.push(`runtime.acquire:${next.runId.startsWith("inline-") ? "inline" : next.runId}`);
      lease = next.runId;
    },
    async evaluate(runId, code) {
      calls.push(`runtime.evaluate:${code}`);
      return { value: "evaluated", console: [], pages: [], events: [], screenshots: [], elapsedMs: 1, truncated: false } as BrowserEvalResult;
    },
    async capture() {
      return "/tmp/shot.png";
    },
    async checkpoint() {
      return { urls: [], activeIndex: 0 };
    },
    async restore() {},
    async release(runId) {
      calls.push("runtime.release");
      if (lease === runId) lease = null;
      return [];
    },
    hasLease(runId) {
      return lease === runId;
    },
    stats() {
      return {
        ready: true,
        profileDir: "p",
        activeRunId: lease,
        activeRunIds: lease ? [lease] : [],
        maxConcurrentLeases,
        pages: 2,
        launches: 1,
        evaluations: 3,
        averageEvalMs: 10,
      };
    },
    async stop() {
      calls.push("runtime.stop");
    },
  };
}

function fakeAgent(calls: string[], stats: Partial<BrowserAgentStats> = {}): BrowserAgent {
  return {
    async run(task, opts) {
      calls.push(`agent.run:${task}:${opts.channelId}:${opts.requesterId}:${opts.credsEntry ?? ""}`);
      return { runId: "run-1", queued: 1 };
    },
    async resume() {},
    async steer(runId, note) {
      calls.push(`agent.steer:${runId}:${note}`);
      return "queued";
    },
    async stop(runId, reason) {
      calls.push(`agent.stop:${runId}:${reason ?? ""}`);
    },
    drainSteers: () => [],
    recordEval: () => {},
    async inspect(runId, opts) {
      if (runId === "missing") return null;
      return {
        run: {
          runId,
          state: "running",
          task: "t",
          channelId: "chan",
          startedAt: 1,
          finishedAt: null,
          question: null,
          result: null,
          proofFiles: [],
        },
        journal: [],
        screenshot: null,
        // Mirrors the real agent: the live view only starts when the watcher opted in.
        liveViewUrl: opts?.live ? "https://live.example/#tok" : null,
      };
    },
    async evalSecrets() {
      return null;
    },
    async recover() {
      calls.push("agent.recover");
    },
    stats: () => ({ running: 0, waiting: 0, queued: 0, runs: [], ...stats }),
    async stopAll() {
      calls.push("agent.stopAll");
    },
  };
}

/** Models agent admission so the extension test exercises task/watch/steer/stop as one surface. */
function concurrentAgent(calls: string[], cap: number): BrowserAgent {
  const runs = new Map<string, { state: "queued" | "running" | "cancelled"; task: string }>();
  let next = 0;
  return {
    async run(task) {
      const runId = `run-${++next}`;
      const live = [...runs.values()].filter((run) => run.state === "running").length;
      const queued = [...runs.values()].filter((run) => run.state === "queued").length;
      const state = live < cap && queued === 0 ? "running" : "queued";
      runs.set(runId, { state, task });
      calls.push(`agent.run:${runId}:${state}:${task}`);
      return state === "queued" ? { runId, queued: queued + 1 } : { runId };
    },
    async resume() {},
    async steer(runId, note) {
      if (!runs.has(runId)) throw new Error(`browser run ${runId} is not live`);
      calls.push(`agent.steer:${runId}:${note}`);
      return "queued";
    },
    async stop(runId, reason) {
      const run = runs.get(runId);
      if (!run) throw new Error(`browser run ${runId} is not live`);
      run.state = "cancelled";
      calls.push(`agent.stop:${runId}:${reason ?? ""}`);
    },
    drainSteers: () => [],
    recordEval: () => {},
    async inspect(runId) {
      const run = runs.get(runId);
      if (!run) return null;
      return {
        run: {
          runId,
          state: run.state,
          task: run.task,
          channelId: "chan",
          startedAt: 1,
          finishedAt: run.state === "cancelled" ? 2 : null,
          question: null,
          result: null,
          proofFiles: [],
        },
        journal: [],
        screenshot: null,
      };
    },
    async evalSecrets() { return null; },
    async recover() {},
    stats: () => {
      const values = [...runs.entries()].map(([runId, run]) => ({
        runId,
        state: run.state,
        startedAt: 1,
        finishedAt: run.state === "cancelled" ? 2 : null,
        credsEntry: null,
        question: null,
        task: run.task,
      }));
      return {
        running: values.filter((run) => run.state === "running").length,
        waiting: 0,
        queued: values.filter((run) => run.state === "queued").length,
        runs: values,
      };
    },
    async stopAll() {},
  };
}

function build(stats: Partial<BrowserAgentStats> = {}, maxConcurrentLeases = 3): { ext: BrowserExtension; calls: string[]; deps: ExtensionContext } {
  const deps = ctx();
  const calls: string[] = [];
  const ext = createBrowserExtension({
    onQuestion: async () => "anchor-1",
    onOutcome: () => {},
    createRuntime: () => fakeRuntime(calls, maxConcurrentLeases),
    createAgent: () => fakeAgent(calls, stats),
  })(deps);
  return { ext, calls, deps };
}

// ── lifecycle: init inert / start recovers / stop order / health ─────────────────────────

test("init constructs both owners inert; the accessors refuse before it runs", async () => {
  const { ext, calls, deps } = build();
  expect(() => ext.runtime()).toThrow(/not initialized/);
  expect(() => ext.agent()).toThrow(/not initialized/);
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  // Constructed but INERT: nothing spawned, nothing recovered, nothing acquired.
  expect(calls).toEqual([]);
  expect(ext.runtime()).toBeDefined();
  expect(ext.agent()).toBeDefined();
});

test("start runs the agent's recover (the durable-ledger re-report), and only that", async () => {
  const { ext, calls, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  await registry.startAll(deps);
  expect(calls).toEqual(["agent.recover"]);
});

test("stop settles agent legs FIRST, then kills the host — the v5 shutdown order exactly", async () => {
  const { ext, calls, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);
  await registry.stopAll();
  expect(calls).toEqual(["agent.stopAll", "runtime.stop"]);
});

test("health maps runtime + agent stats into one ok/detail verdict", async () => {
  const { ext, deps } = build({ running: 1, queued: 2 });
  expect(ext.lifecycle!.health!()).toMatchObject({ ok: false, detail: "not initialized" });
  await ext.lifecycle!.init!(deps);
  const verdict = await ext.lifecycle!.health!();
  expect(verdict.ok).toBeTrue();
  expect(verdict.detail).toContain("1 running");
  expect(verdict.detail).toContain("2 queued");
});

// ── discovery: the catalog carries router prose and never the internal eval bridge ───────

test("advertises task/exec/watch/steer/stop with routing prose; browser.eval stays internal", () => {
  const { ext } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  const catalog = registry.catalog();
  expect(catalog.map((entry) => entry.capabilityId)).toEqual([
    "browser.task",
    "browser.exec",
    "browser.watch",
    "browser.steer",
    "browser.stop",
  ]);
  for (const entry of catalog) {
    expect(entry.description.length).toBeGreaterThan(40);
    expect(entry.examples.length).toBeGreaterThan(0);
  }
  expect(catalog.find((entry) => entry.capabilityId === "browser.task")!.actionClass).toBe(ActionClass.ALWAYS_ASK);
  expect(catalog.find((entry) => entry.capabilityId === "browser.exec")!.actionClass).toBe(ActionClass.FREE);
});

// ── dispatch: invoke routes and never exits ──────────────────────────────────────────────

test("browser.task validates at the seam and routes to agent.run with the origin identity", async () => {
  const { ext, calls, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);

  const invalid = await registry.invoke({ capabilityId: "browser.task", args: {} }, deps);
  expect(invalid.ok).toBeFalse();
  expect(invalid.error).toContain("invalid args");

  const queued = await registry.invoke(
    {
      capabilityId: "browser.task",
      args: { task: "post the thread", credsEntry: "x.com" },
      origin: { channelId: "chan-9", userId: "owner-1" },
    },
    deps,
  );
  expect(queued).toEqual({ ok: true, data: { runId: "run-1", queued: 1 } });
  expect(calls).toEqual(["agent.run:post the thread:chan-9:owner-1:x.com"]);
});

test("capability surface admits two tasks through distinct lanes and routes watch/steer/stop by runId", async () => {
  const deps = ctx();
  const calls: string[] = [];
  const agent = concurrentAgent(calls, 2);
  const ext = createBrowserExtension({
    onQuestion: async () => "anchor-1",
    onOutcome: () => {},
    createRuntime: () => fakeRuntime(calls, 2),
    createAgent: () => agent,
  })(deps);
  await ext.lifecycle!.init!(deps);
  const origin = { channelId: "chan", userId: "owner-1" };

  const first = await ext.invoke!({ capabilityId: "browser.task", args: { task: "first" }, origin }, deps);
  const second = await ext.invoke!({ capabilityId: "browser.task", args: { task: "second" }, origin }, deps);
  const third = await ext.invoke!({ capabilityId: "browser.task", args: { task: "third" }, origin }, deps);
  expect(first).toEqual({ ok: true, data: { runId: "run-1" } });
  expect(second).toEqual({ ok: true, data: { runId: "run-2" } });
  expect(third).toEqual({ ok: true, data: { runId: "run-3", queued: 1 } });

  expect(await ext.invoke!({ capabilityId: "browser.watch", args: { runId: "run-1" } }, deps))
    .toMatchObject({ ok: true, data: { run: { runId: "run-1", task: "first" } } });
  expect(await ext.invoke!(
    { capabilityId: "browser.steer", args: { runId: "run-2", note: "only second" }, origin }, deps,
  )).toEqual({ ok: true, data: { runId: "run-2", delivery: "queued" } });
  expect(await ext.invoke!(
    { capabilityId: "browser.stop", args: { runId: "run-1", reason: "only first" }, origin }, deps,
  )).toEqual({ ok: true, data: { runId: "run-1", state: "cancelled" } });
  expect(calls).toContain("agent.steer:run-2:only second");
  expect(calls).toContain("agent.stop:run-1:only first");
  expect(calls).not.toContain("agent.stop:run-2:only first");
});

/** The derived-by-the-core origin identity every acting capability requires. */
const ORIGIN = { channelId: "chan", userId: "owner-1" };

test("capability surface restores single-lane task queueing with the kill switch", async () => {
  const deps = ctx();
  const calls: string[] = [];
  const ext = createBrowserExtension({
    onQuestion: async () => "anchor-1",
    onOutcome: () => {},
    createRuntime: () => fakeRuntime(calls, 1),
    createAgent: () => concurrentAgent(calls, 1),
  })(deps);
  await ext.lifecycle!.init!(deps);
  const first = await ext.invoke!({ capabilityId: "browser.task", args: { task: "first" }, origin: ORIGIN }, deps);
  const second = await ext.invoke!({ capabilityId: "browser.task", args: { task: "second" }, origin: ORIGIN }, deps);
  expect(first).toEqual({ ok: true, data: { runId: "run-1" } });
  expect(second).toEqual({ ok: true, data: { runId: "run-2", queued: 1 } });
});

test("browser.exec runs in its own session even while a background run is live", async () => {
  const idle = build();
  const registry = new ExtensionRegistry();
  registry.register(idle.ext);
  await registry.initAll(idle.deps);
  const result = await registry.invoke(
    { capabilityId: "browser.exec", args: { code: "return 1" }, origin: ORIGIN },
    idle.deps,
  );
  expect(result.ok).toBeTrue();
  expect(idle.calls).toEqual(["runtime.acquire:inline", "runtime.evaluate:return 1", "runtime.release"]);

  const busy = build({
    runs: [{ runId: "r-live", state: "running", startedAt: 1, finishedAt: null, credsEntry: null, question: null, task: "t" }],
  });
  await busy.ext.lifecycle!.init!(busy.deps);
  const alongsideLive = await busy.ext.invoke!(
    { capabilityId: "browser.exec", args: { code: "return 1" }, origin: ORIGIN },
    busy.deps,
  );
  expect(alongsideLive.ok).toBeTrue();
  expect(busy.calls).toEqual(["runtime.acquire:inline", "runtime.evaluate:return 1", "runtime.release"]);
});

test("browser.exec also does not defer to a queued background run", async () => {
  const { ext, calls, deps } = build({
    runs: [{ runId: "r-q", state: "queued", startedAt: 1, finishedAt: null, credsEntry: null, question: null, task: "t" }],
  });
  await ext.lifecycle!.init!(deps);
  const alongsideQueue = await ext.invoke!(
    { capabilityId: "browser.exec", args: { code: "return 1" }, origin: ORIGIN },
    deps,
  );
  expect(alongsideQueue.ok).toBeTrue();
  expect(calls).toEqual(["runtime.acquire:inline", "runtime.evaluate:return 1", "runtime.release"]);
});

test("browser.exec restores the former background-lease refusal when the kill switch pins one lane", async () => {
  const { ext, calls, deps } = build({
    runs: [{ runId: "r-live", state: "running", startedAt: 1, finishedAt: null, credsEntry: null, question: null, task: "t" }],
  }, 1);
  await ext.lifecycle!.init!(deps);
  const refused = await ext.invoke!(
    { capabilityId: "browser.exec", args: { code: "return 1" }, origin: ORIGIN }, deps,
  );
  expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("holds the browser") });
  expect(calls).toEqual([]);
});

test("task/exec/steer/stop refuse without an origin identity; watch stays an open read", async () => {
  const { ext, calls, deps } = build();
  await ext.lifecycle!.init!(deps);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["browser.task", { task: "post it" }, "browser tasks need an authenticated authorized request"],
    ["browser.exec", { code: "return 1" }, "inline browser scripts need an authenticated authorized request"],
    ["browser.steer", { runId: "run-1", note: "n" }, "steering needs an authenticated authorized request"],
    ["browser.stop", { runId: "run-1" }, "stopping a run needs an authenticated authorized request"],
  ];
  for (const [capabilityId, args, error] of cases) {
    expect(await ext.invoke!({ capabilityId, args }, deps)).toEqual({ ok: false, error });
  }
  expect(calls).toEqual([]);
  const watched = await ext.invoke!({ capabilityId: "browser.watch", args: { runId: "run-1" } }, deps);
  expect(watched.ok).toBeTrue();
});

test("browser.task refuses a channel override that leaves the authorized channel", async () => {
  const { ext, calls, deps } = build();
  await ext.lifecycle!.init!(deps);
  const refused = await ext.invoke!(
    { capabilityId: "browser.task", args: { task: "post it", channelId: "elsewhere" }, origin: ORIGIN },
    deps,
  );
  expect(refused).toEqual({
    ok: false,
    error: "browser tasks must return to the channel where the authorized request began",
  });
  expect(calls).toEqual([]);
});

test("steer/stop refuse from a channel other than the run's own", async () => {
  const { ext, calls, deps } = build();
  await ext.lifecycle!.init!(deps);
  const foreign = { channelId: "other-chan", userId: "owner-1" };
  const steered = await ext.invoke!(
    { capabilityId: "browser.steer", args: { runId: "run-1", note: "n" }, origin: foreign },
    deps,
  );
  expect(steered).toEqual({
    ok: false,
    error: "browser runs can only be steered from the channel that dispatched them",
  });
  const stopped = await ext.invoke!(
    { capabilityId: "browser.stop", args: { runId: "run-1" }, origin: foreign },
    deps,
  );
  expect(stopped).toEqual({
    ok: false,
    error: "browser runs can only be stopped from the channel that dispatched them",
  });
  expect(calls).toEqual([]);
});

test("the live view is gated to the run's own channel; the journal read stays open", async () => {
  const { ext, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);

  // Live view is full browser control (take-control CDP input, chat, handoff), so it rides the
  // steer/stop gate: an origin identity, and the channel that dispatched the run.
  const foreign = { channelId: "other-chan", userId: "owner-1" };
  expect(await registry.invoke(
    { capabilityId: "browser.watch", args: { runId: "run-1", live: true }, origin: foreign }, deps,
  )).toEqual({ ok: false, error: "browser runs can only be watched live from the channel that dispatched them" });
  expect(await registry.invoke({ capabilityId: "browser.watch", args: { runId: "run-1", live: true } }, deps))
    .toEqual({ ok: false, error: "the live browser view needs an authenticated authorized request" });

  // An un-gated watch is still an open read — it just carries no live-view link.
  expect(await registry.invoke({ capabilityId: "browser.watch", args: { runId: "run-1" } }, deps))
    .toMatchObject({ ok: true, data: { run: { runId: "run-1" }, liveViewUrl: null } });
  expect(await registry.invoke({ capabilityId: "browser.watch", args: { runId: "run-1" }, origin: foreign }, deps))
    .toMatchObject({ ok: true, data: { liveViewUrl: null } });

  // Same channel, live requested: the link comes back.
  expect(await registry.invoke(
    { capabilityId: "browser.watch", args: { runId: "run-1", live: true }, origin: ORIGIN }, deps,
  )).toMatchObject({ ok: true, data: { liveViewUrl: "https://live.example/#tok" } });
});

test("watch/steer/stop route to the agent; unknown runs and capabilities refuse as results", async () => {
  const { ext, calls, deps } = build();
  const registry = new ExtensionRegistry();
  registry.register(ext);
  await registry.initAll(deps);

  const watched = await registry.invoke({ capabilityId: "browser.watch", args: { runId: "run-1" } }, deps);
  expect(watched.ok).toBeTrue();
  const missing = await registry.invoke({ capabilityId: "browser.watch", args: { runId: "missing" } }, deps);
  expect(missing).toEqual({ ok: false, error: "browser run missing is unknown" });

  const steered = await registry.invoke(
    { capabilityId: "browser.steer", args: { runId: "run-1", note: "annual plan" }, origin: ORIGIN },
    deps,
  );
  expect(steered).toEqual({ ok: true, data: { runId: "run-1", delivery: "queued" } });

  const stopped = await registry.invoke(
    { capabilityId: "browser.stop", args: { runId: "run-1", reason: "never mind" }, origin: ORIGIN },
    deps,
  );
  expect(stopped).toEqual({ ok: true, data: { runId: "run-1", state: "cancelled" } });
  expect(calls).toContain("agent.steer:run-1:annual plan");
  expect(calls).toContain("agent.stop:run-1:never mind");
});

test("watch, steer, and stop keep two concurrent runIds isolated", async () => {
  const { ext, calls, deps } = build();
  await ext.lifecycle!.init!(deps);
  for (const runId of ["run-1", "run-2"]) {
    const watched = await ext.invoke!({ capabilityId: "browser.watch", args: { runId } }, deps);
    expect(watched).toMatchObject({ ok: true, data: { run: { runId } } });
    expect(await ext.invoke!(
      { capabilityId: "browser.steer", args: { runId, note: `note for ${runId}` }, origin: ORIGIN }, deps,
    )).toEqual({ ok: true, data: { runId, delivery: "queued" } });
  }
  expect(await ext.invoke!(
    { capabilityId: "browser.stop", args: { runId: "run-1", reason: "stop first" }, origin: ORIGIN }, deps,
  )).toEqual({ ok: true, data: { runId: "run-1", state: "cancelled" } });
  expect(calls).toContain("agent.steer:run-1:note for run-1");
  expect(calls).toContain("agent.steer:run-2:note for run-2");
  expect(calls).toContain("agent.stop:run-1:stop first");
  expect(calls).not.toContain("agent.stop:run-2:stop first");
});

test("invoke before init refuses with a result — it never throws out or exits", async () => {
  const { ext, deps } = build();
  const result = await ext.invoke!({ capabilityId: "browser.task", args: { task: "x" } }, deps);
  expect(result.ok).toBeFalse();
  expect(result.error).toContain("not initialized");
});
