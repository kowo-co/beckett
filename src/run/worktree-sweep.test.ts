/**
 * `planWorktreeSweep` policy tests (`src/run/worktree-sweep.ts`). Pure table tests — no I/O, no
 * fake git. See `src/run/supervisor.test.ts` for the I/O-driving half.
 */
import { describe, expect, test } from "bun:test";
import { planWorktreeSweep, SWEEP_TTL_ABANDONED_MS, SWEEP_TTL_DONE_MS, type SweepCandidate } from "./worktree-sweep.ts";

function candidate(over: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    runId: over.runId ?? "run-20260810-oauth",
    state: over.state ?? "done",
    workspace: over.workspace ?? "/repos/gateway/.beckett/worktrees/run-20260810-oauth",
    repoRoot: over.repoRoot ?? "/repos/gateway",
    branch: over.branch ?? "beckett/run-oauth",
    ageMs: over.ageMs ?? 0,
    pushed: over.pushed ?? false,
  };
}

describe("planWorktreeSweep", () => {
  test("parked runs are never swept", () => {
    const decisions = planWorktreeSweep([candidate({ state: "parked", ageMs: 365 * 86_400_000, pushed: true })]);
    const d = decisions[0]!;
    expect(d.action).toBe("keep");
    expect(d.reason).toMatch(/parked runs belong to a human/);
  });

  test("a done run older than 48h is swept", () => {
    const decisions = planWorktreeSweep([candidate({ state: "done", ageMs: SWEEP_TTL_DONE_MS + 1 })]);
    const d = decisions[0]!;
    expect(d.action).toBe("remove");
    expect(d.reason).toMatch(/48h/);
  });

  test("a done run younger than 48h is kept", () => {
    const decisions = planWorktreeSweep([candidate({ state: "done", ageMs: SWEEP_TTL_DONE_MS - 1 })]);
    const d = decisions[0]!;
    expect(d.action).toBe("keep");
    expect(d.reason).toMatch(/48h/);
  });

  test("a failed run whose branch is not on origin is kept", () => {
    const d = planWorktreeSweep([
      candidate({ state: "failed", ageMs: SWEEP_TTL_ABANDONED_MS + 1, pushed: false }),
    ])[0]!;
    expect(d.action).toBe("keep");
    expect(d.reason).toMatch(/not on origin/);
  });

  test("a failed run older than 7 days whose branch IS on origin is swept", () => {
    const d = planWorktreeSweep([
      candidate({ state: "failed", ageMs: SWEEP_TTL_ABANDONED_MS + 1, pushed: true }),
    ])[0]!;
    expect(d.action).toBe("remove");
    expect(d.reason).toMatch(/7d/);
  });

  test("a failed run younger than 7 days, even pushed, is kept", () => {
    const d = planWorktreeSweep([
      candidate({ state: "failed", ageMs: SWEEP_TTL_ABANDONED_MS - 1, pushed: true }),
    ])[0]!;
    expect(d.action).toBe("keep");
  });

  test("a cancelled run follows the same 7-day+pushed rule as failed", () => {
    const d = planWorktreeSweep([
      candidate({ state: "cancelled", ageMs: SWEEP_TTL_ABANDONED_MS + 1, pushed: true }),
    ])[0]!;
    expect(d.action).toBe("remove");
  });

  test("a non-terminal state is kept with a reason naming the state", () => {
    const decisions = planWorktreeSweep([candidate({ state: "implementing", ageMs: 999_999_999 })]);
    const d = decisions[0]!;
    expect(d.action).toBe("keep");
    expect(d.reason).toMatch(/implementing/);
  });

  test("decisions come back one per candidate, in order", () => {
    const decisions = planWorktreeSweep([
      candidate({ runId: "a", state: "parked" }),
      candidate({ runId: "b", state: "done", ageMs: SWEEP_TTL_DONE_MS + 1 }),
    ]);
    expect(decisions.map((d) => d.runId)).toEqual(["a", "b"]);
  });
});
