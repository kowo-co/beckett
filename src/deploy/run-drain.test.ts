import { expect, test } from "bun:test";
import { describeRunWorker, restartBlockingRunWorkers, waitForRunDrain } from "./run-drain.ts";

/** The shape `beckett status` prints: `runs` is `RunSupervisor.live()` verbatim. */
const statusWith = (runs: unknown[]) => ({ version: "7.0.5", pid: 4242, runs });

const reviewer = {
  runId: "run-20260812-betterwright-1-8-0-vs-1-7-2-perf-reliabi",
  state: "reviewing",
  stage: "review",
  workerId: "wk_0ac14b7e",
  startedAt: 0,
};

test("deploy shutdown preflight visibly waits, then refuses over a live run worker at its bounded deadline", async () => {
  let clock = 1_000;
  const waits: string[] = [];

  // 2026-08-12 verbatim: the daemon's clean_shutdown killed this reviewer four minutes into its
  // session and the run parked. A finite deadline hands that exact worker back to the caller so
  // deploy-prod.sh refuses instead of restarting over it.
  const result = await waitForRunDrain({
    status: async () => statusWith([reviewer]),
    waitMs: 20,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onWaiting: (workers, remaining) => waits.push(`${workers[0]!.runId}:${remaining}`),
  });

  expect(result.drained).toBe(false);
  expect(result.workers).toEqual([reviewer]);
  expect(waits).toEqual([`${reviewer.runId}:20`, `${reviewer.runId}:10`]);
  // The wait cannot depend on a stage eventually completing.
  expect(clock).toBe(1_020);
});

test("only a run with a LIVE worker blocks the restart — queued, parked and publishing runs survive it", () => {
  const queued = { runId: "queued-run", state: "queued", stage: "implement", workerId: null, startedAt: null };
  const parked = { runId: "parked-run", state: "parked", stage: null, workerId: null, startedAt: null };
  // The publish outbox is durable and drains itself on boot, so a publishing run is not a loss.
  const publishing = { runId: "publishing-run", state: "publishing", stage: null, workerId: null, startedAt: null };
  const live = { runId: "live-run", state: "implementing", stage: "implement", workerId: "wk_1", startedAt: 5 };

  // `beckett status` prints its bus data directly, not a `{ data }` envelope.
  expect(restartBlockingRunWorkers(statusWith([queued, parked, publishing, live]))).toEqual([live]);
  // Keep direct control-bus consumers compatible too.
  expect(restartBlockingRunWorkers({ data: statusWith([live]) })).toEqual([live]);
  // A daemon that answers with no runs at all is idle, not malformed.
  expect(restartBlockingRunWorkers(statusWith([]))).toEqual([]);
  expect(restartBlockingRunWorkers(null)).toEqual([]);
});

test("the refusal names the run, the stage and the worker's age so a human can act on it", () => {
  expect(describeRunWorker(reviewer, 247_000)).toBe(
    `${reviewer.runId} (review worker wk_0ac14b7e, age 247s)`,
  );
  // A daemon that predates `startedAt` still gets named, just without an age.
  expect(describeRunWorker({ ...reviewer, startedAt: null }, 247_000)).toContain("age unknown");
});

test("deploy drain reports every concurrent live worker so none can be orphaned", async () => {
  let clock = 0;
  const first = { runId: "run-a", state: "implementing", stage: "implement", workerId: "wk_1", startedAt: 1 };
  const second = { runId: "run-b", state: "reviewing", stage: "review", workerId: "wk_2", startedAt: 2 };
  const result = await waitForRunDrain({
    status: async () => statusWith([first, second]),
    waitMs: 10,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  expect(result).toEqual({ drained: false, workers: [first, second] });
});

test("a deploy proceeds immediately once the last run worker is gone", async () => {
  const result = await waitForRunDrain({
    status: async () => statusWith([{ runId: "idle", state: "queued", stage: "implement", workerId: null, startedAt: null }]),
    waitMs: 60_000,
  });
  expect(result).toEqual({ drained: true, workers: [] });
});

test("a worker that finishes inside the window lets the deploy through without refusing", async () => {
  let clock = 0;
  let polls = 0;
  const result = await waitForRunDrain({
    status: async () => (polls++ === 0 ? statusWith([reviewer]) : statusWith([{ ...reviewer, workerId: null }])),
    waitMs: 100,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  expect(result).toEqual({ drained: true, workers: [] });
  expect(clock).toBe(10);
});
