/**
 * Beckett — worktree sweep policy (`src/run/worktree-sweep.ts`)
 * =======================================================================================
 * `removeWorktree` (`../worker/worktree.ts`) has been wired into `RunSupervisor`'s git deps since
 * v7 launch but had zero call sites — 58 orphaned worktrees / 16.8 GB accumulated. This module is
 * the pure policy half of the fix: given a candidate list, decide which terminal runs' worktrees
 * (and local branches) are safe to remove. `RunSupervisor.sweepWorktrees` (`./supervisor.ts`) is
 * the I/O half — it builds candidates from the run store and executes the plan.
 *
 * The policy is deliberately conservative:
 *   - `parked` runs are NEVER swept — a human is holding that workspace, full stop.
 *   - `done` runs wait 48h (short: the work is merged, only local disk is at stake).
 *   - `failed`/`cancelled` runs wait 7 days AND require the branch to be provably on origin
 *     (`pushed`) — the work must be durable elsewhere before the only copy on disk is deleted.
 */

import type { RunState } from "./types.ts";

/** A terminal run whose workspace might be swept, plus the facts the policy needs. */
export interface SweepCandidate {
  runId: string;
  state: RunState;
  workspace: string;
  repoRoot: string;
  branch: string;
  /** ms since the run last changed state. */
  ageMs: number;
  /** Is the branch on origin (work is durable elsewhere)? */
  pushed: boolean;
}

export type SweepDecision =
  | { runId: string; action: "remove"; reason: string }
  | { runId: string; action: "keep"; reason: string };

/** A `done` run's worktree is removed once it has sat this long past completion. */
export const SWEEP_TTL_DONE_MS = 48 * 60 * 60_000;
/** A `failed`/`cancelled` run's worktree is removed once it has sat this long AND its branch is on origin. */
export const SWEEP_TTL_ABANDONED_MS = 7 * 24 * 60 * 60_000;

/**
 * Pure policy: no I/O, table-tested. One decision per candidate, in order.
 */
export function planWorktreeSweep(candidates: SweepCandidate[]): SweepDecision[] {
  return candidates.map((c): SweepDecision => {
    if (c.state === "parked") {
      return { runId: c.runId, action: "keep", reason: "parked runs belong to a human" };
    }
    if (c.state === "done") {
      if (c.ageMs >= SWEEP_TTL_DONE_MS) {
        return { runId: c.runId, action: "remove", reason: `done for ${Math.round(c.ageMs / 3_600_000)}h — past the 48h TTL` };
      }
      return { runId: c.runId, action: "keep", reason: "done but younger than the 48h TTL" };
    }
    if (c.state === "failed" || c.state === "cancelled") {
      if (!c.pushed) {
        return { runId: c.runId, action: "keep", reason: `${c.state} but its branch is not on origin` };
      }
      if (c.ageMs >= SWEEP_TTL_ABANDONED_MS) {
        return {
          runId: c.runId,
          action: "remove",
          reason: `${c.state} for ${Math.round(c.ageMs / 86_400_000)}d, branch is on origin — past the 7d TTL`,
        };
      }
      return { runId: c.runId, action: "keep", reason: `${c.state} but younger than the 7d TTL` };
    }
    return { runId: c.runId, action: "keep", reason: `state ${c.state} is not a sweep target` };
  });
}
