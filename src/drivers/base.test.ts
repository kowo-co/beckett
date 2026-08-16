import { expect, test } from "bun:test";
import { OneShotDriver, DEFAULT_RESUME_PROMPT } from "./base.ts";
import type { Config, WorkerEvent, WorkerState } from "../types.ts";

const config = {
  harness: {},
  supervise: { worker_hard_cap_s: 3600, worker_stall_s: 300 },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

/** Minimal concrete OneShotDriver — just enough to exercise the shared lifecycle. */
class TestDriver extends OneShotDriver {
  constructor() {
    super(config, quietLog, "driver.test");
  }
  protected harnessName(): string {
    return "test";
  }
  protected binName(): string {
    return "test-bin";
  }
  protected usdEstimate(): number | null {
    return null;
  }
  protected handleLine(_line: string): void {}
  protected buildResumeArgs(prompt: string): string[] {
    return ["resume", prompt];
  }
  protected resetParseState(): void {}
}

/** The private surface the tests reach into (same pattern as the per-driver tests). */
interface Guts {
  finished: boolean;
  latch(cause: "terminal-event" | "process-exit" | "wall-clock-cap" | "turn-boundary"): void;
  lastLatch: string | null;
  capTripped: boolean;
  workerState: WorkerState;
  childGen: number;
  spawnedAt: number;
  spec: unknown;
  tickWatchdog(): void;
  lastProgressTs: number;
  lastStallEmitTs: number;
  stderrRing: { record(text: string): void };
  sendNudge(msg: string): Promise<{ accepted: string }>;
  takeBufferedPrompt(): string;
  onProcessExit(
    code: number,
    gen: number,
    pid: number,
    groupKill: boolean,
    signal?: NodeJS.Signals | null,
  ): Promise<void>;
  timeOut(capS: number, totalS: number): Promise<void>;
  tickStall(): void;
  emit(e: WorkerEvent): void;
  onEvent(cb: (e: WorkerEvent) => void): () => void;
  getTelemetry(): { diffLines: { added: number; removed: number; files: number } };
}

function makeDriver(): Guts {
  return new TestDriver() as unknown as Guts;
}

// ── OneShotDriver steering (issue #19: honest receipts) ─────────────────────────

test("one-shot nudges buffer with an honest will-restart receipt and drain FIFO", async () => {
  const d = makeDriver();
  expect((await d.sendNudge("do X")).accepted).toBe("will-restart");
  expect((await d.sendNudge("do Y")).accepted).toBe("will-restart");
  expect(d.takeBufferedPrompt()).toBe("do X\n\ndo Y");
  // drained: the next take falls back to the generic continue instruction
  expect(d.takeBufferedPrompt()).toBe(DEFAULT_RESUME_PROMPT);
});

test("a nudge after the terminal finish is dropped, never silently eaten", async () => {
  const d = makeDriver();
  d.latch("terminal-event");
  expect((await d.sendNudge("too late")).accepted).toBe("dropped");
  expect(d.takeBufferedPrompt()).toBe(DEFAULT_RESUME_PROMPT); // nothing was buffered
});

// ── BaseDriver exit handling (crash path + gen guard) ───────────────────────────

test("a crash exit synthesizes a classified error finish carrying the stderr tail", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";
  d.stderrRing.record("Error: not logged in — please run login");

  await d.onProcessExit(1, d.childGen, 12345, /*groupKill*/ false);

  const finished = events.find((e) => e.kind === "finished");
  expect(finished).toBeDefined();
  if (finished?.kind !== "finished") throw new Error("unreachable");
  expect(finished.status).toBe("error");
  expect(finished.subtype).toBe("error_process_exit");
  expect(finished.errorClass).toBe("auth"); // classified off the stderr tail (issue #17)
  const error = events.find((e) => e.kind === "error");
  if (error?.kind !== "error") throw new Error("no error event");
  expect(error.message).toContain("not logged in");
  expect(d.workerState as WorkerState).toBe("failed");
  expect(d.finished).toBe(true);
});

// Issue #247: the daemon's own restart kills a worker with a SIGNAL and no exit code, and the
// crash-path `error` event is the only place the cause is ever stated. "code null" is not a cause
// anyone can diagnose a parked run from — the signal has to be named.
test("a signalled exit names the signal instead of a null exit code", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";

  await d.onProcessExit(null as unknown as number, d.childGen, 12345, /*groupKill*/ false, "SIGTERM");

  const error = events.find((e) => e.kind === "error");
  if (error?.kind !== "error") throw new Error("no error event");
  expect(error.message).toContain("signal SIGTERM");
  expect(error.message).not.toContain("code null");
  const finished = events.find((e) => e.kind === "finished");
  if (finished?.kind !== "finished") throw new Error("no finished event");
  expect(finished.status).toBe("error");
  expect(finished.subtype).toBe("error_process_exit");
});

test("a superseded child's exit is ignored (childGen guard — auto-resume relaunch)", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";
  d.childGen = 2;

  await d.onProcessExit(1, /*stale gen*/ 1, 12345, /*groupKill*/ false);

  expect(events).toHaveLength(0);
  expect(d.workerState).toBe("running");
  expect(d.finished).toBe(false);
});

test("an exit after a terminal finish does not double-emit", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.latch("terminal-event");
  d.workerState = "failed";

  await d.onProcessExit(0, d.childGen, 12345, false);

  expect(events.filter((e) => e.kind === "finished")).toHaveLength(0);
});

// ── wall-clock backstop ──────────────────────────────────────────────────────────

test("the hard-cap timeout emits a graceful error_wall_clock_cap finish", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));

  await d.timeOut(3600, 3700);

  const finished = events.find((e) => e.kind === "finished");
  if (finished?.kind !== "finished") throw new Error("no finished event");
  expect(finished.subtype).toBe("error_wall_clock_cap");
  expect(finished.errorClass).toBe("timeout");
  expect(d.workerState).toBe("aborted");
});

// The 2026-08-14 misreport. `timeOut` kills the tree FIRST and emits its verdict only after the
// reap (kill-first, OPS-50) — and a harness spends that SIGTERM grace window flushing its own
// dying words. `claude` emits a final stream-json `result` line, which `claude.ts#handleResult`
// turns into a `finished` carrying `errorClass: "crash"`. `spawn.ts#fireDone` latches the FIRST
// finish, so that lie won and the run was parked as a segfault it never had.
test("a harness finish that races the wall-clock cap kill is dropped, not reported as a crash", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.spec = { workspace: undefined };
  d.workerState = "running";
  d.spawnedAt = Date.now() - 3_601_000; // one second past the cap this config sets

  d.tickWatchdog(); // trips the cap → kills the tree, THEN emits its verdict
  expect(d.capTripped).toBe(true);

  // Mid-kill, the dying harness flushes its own terminal result line.
  d.emit({
    kind: "finished",
    status: "error",
    subtype: "error_during_execution",
    structuredOutput: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    errorClass: "crash",
    ts: Date.now(),
  });

  await Promise.resolve(); // let the async timeOut() settle
  await Promise.resolve();

  const finishes = events.filter((e) => e.kind === "finished");
  expect(finishes).toHaveLength(1); // the crash lie never reached a subscriber
  if (finishes[0]?.kind !== "finished") throw new Error("unreachable");
  expect(finishes[0].subtype).toBe("error_wall_clock_cap");
  expect(finishes[0].errorClass).toBe("timeout");
});

// B7: the 12 hand-copied `this.finished` assignments are now one `latch(cause)` call. This is
// the regression over that refactor — the cap's own latch must still win the race even though
// every site now goes through the same method instead of its own inline assignment.
test("the cap latch still suppresses a harness finish that races it", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.spec = { workspace: undefined };
  d.workerState = "running";
  d.spawnedAt = Date.now() - 3_601_000;

  d.tickWatchdog();
  expect(d.finished).toBe(true);
  expect(d.lastLatch).toBe("wall-clock-cap");

  d.emit({
    kind: "finished",
    status: "error",
    subtype: "error_during_execution",
    structuredOutput: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    errorClass: "crash",
    ts: Date.now(),
  });
  await Promise.resolve();
  await Promise.resolve();

  const finishes = events.filter((e) => e.kind === "finished");
  expect(finishes).toHaveLength(1);
  if (finishes[0]?.kind !== "finished") throw new Error("unreachable");
  expect(finishes[0].subtype).toBe("error_wall_clock_cap");
});

// The guard the ticket asked us to verify: `tickWatchdog` sets `finished` BEFORE the kill, so the
// child's real exit — which lands after the cap has already ruled — must not synthesize a second,
// crash-class finish either.
test("the process exit that follows a cap kill does not synthesize a second finish", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.spec = { workspace: undefined };
  d.workerState = "running";
  d.spawnedAt = Date.now() - 3_601_000;

  d.tickWatchdog();
  await Promise.resolve();
  await Promise.resolve();

  // The SIGTERM lands and the child finally exits.
  await d.onProcessExit(null as unknown as number, d.childGen, 12345, false, "SIGTERM");

  const finishes = events.filter((e) => e.kind === "finished");
  expect(finishes).toHaveLength(1);
  if (finishes[0]?.kind !== "finished") throw new Error("unreachable");
  expect(finishes[0].subtype).toBe("error_wall_clock_cap");
  expect(finishes[0].errorClass).toBe("timeout");
  expect(events.filter((e) => e.kind === "error")).toHaveLength(0);
});

// The cap's finish is now the ONLY event that can close a capped worker, so it has to survive a
// kill that throws — otherwise a failed reap would wedge the run open with no terminal event at
// all, which is worse than the mislabelled park this change fixes.
test("the cap still reports its timeout when the kill itself throws", async () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";
  (d as unknown as { killChild(): Promise<void> }).killChild = () => {
    throw new Error("reap exploded");
  };

  await d.timeOut(14400, 14401);

  const finishes = events.filter((e) => e.kind === "finished");
  expect(finishes).toHaveLength(1);
  if (finishes[0]?.kind !== "finished") throw new Error("unreachable");
  expect(finishes[0].subtype).toBe("error_wall_clock_cap");
  expect(finishes[0].errorClass).toBe("timeout");
});

// ── stall detection (issue #21) ──────────────────────────────────────────────────

test("no progress for the stall window emits ONE stalled signal per silent window", () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";
  d.lastProgressTs = Date.now() - 301_000; // idle past the 300s window

  d.tickStall();
  d.tickStall(); // same window — must NOT double-signal

  const stalls = events.filter((e) => e.kind === "stalled");
  expect(stalls).toHaveLength(1);
  if (stalls[0]?.kind !== "stalled") throw new Error("unreachable");
  expect(stalls[0].idleMs).toBeGreaterThanOrEqual(300_000);
});

test("a progress event resets the stall clock; echoes and stall signals do not", () => {
  const d = makeDriver();
  d.workerState = "running";
  const stale = Date.now() - 301_000;
  d.lastProgressTs = stale;

  // user_echo is NOT progress (a wedged worker can still echo a nudge) …
  d.emit({ kind: "user_echo", text: "status check", ts: Date.now() });
  expect(d.lastProgressTs).toBe(stale);
  // … our own stall signal is not progress either …
  d.emit({ kind: "stalled", idleMs: 301_000, ts: Date.now() });
  expect(d.lastProgressTs).toBe(stale);
  // … but a tool call IS.
  d.emit({ kind: "tool_call", tool: "Bash", input: {}, toolId: "t1", ts: Date.now() });
  expect(d.lastProgressTs).toBeGreaterThan(stale);
});

test("an unmatched tool_call suppresses the stall signal; its tool_result restarts the clock (issue #83)", () => {
  const d = makeDriver();
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";

  // A single long foreground tool call: tool_call up front, then silence for 3x the stall window.
  d.emit({ kind: "tool_call", tool: "Bash", input: {}, toolId: "t1", ts: Date.now() });
  d.lastProgressTs = Date.now() - 900_000; // 3x the 300s window with the call still in flight
  d.tickStall();
  d.tickStall();
  expect(events.filter((e) => e.kind === "stalled")).toHaveLength(0);

  // The matching tool_result clears the in-flight call and restarts the clock (it is progress) …
  d.emit({ kind: "tool_result", toolId: "t1", isError: false, ts: Date.now() });
  d.lastProgressTs = Date.now() - 301_000; // … so a further silent window past the result DOES stall
  d.tickStall();
  expect(events.filter((e) => e.kind === "stalled")).toHaveLength(1);
});

test("stall detection is off when worker_stall_s is 0", () => {
  const d = new TestDriver() as unknown as Guts;
  (d as unknown as { config: { supervise: { worker_stall_s: number } } }).config = {
    supervise: { worker_hard_cap_s: 3600, worker_stall_s: 0 },
  } as never;
  const events: WorkerEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.workerState = "running";
  d.lastProgressTs = Date.now() - 10_000_000;
  d.tickStall();
  expect(events.filter((e) => e.kind === "stalled")).toHaveLength(0);
});

// ── telemetry ────────────────────────────────────────────────────────────────────

test("telemetry diff sizing is zero-safe with no workspace (never throws)", () => {
  const d = makeDriver();
  expect(d.getTelemetry().diffLines).toEqual({ added: 0, removed: 0, files: 0 });
});
