/**
 * Beckett v7 — the work item (`src/run/work-item.ts`)
 * =======================================================================================
 * WHAT A WORKER STAGE IS HANDED. `src/dispatch/stages.ts` (every worker prompt and persona) and
 * `src/dispatch/spawn.ts` (the driver composition point) do not need a {@link Run} — they need the
 * handful of fields a brief is written from. Under the ticket system that shape was the tracker's
 * hydrated `Ticket`, which dragged a board id, a deep link, assignees, and a blocked-by DAG through
 * modules that never read any of them. This is the same seam with the tracker's half removed: the
 * {@link RunSupervisor} projects a Run onto it ({@link ./adapter.ts#runAsWorkItem}) and the stage
 * code programs against it.
 *
 * Every field here has a reader. `identifier` is the human handle a brief opens with (for a run it
 * IS the run id), `body`/`criteria` are the brief itself, `casting` scales review effort off the
 * implement cast, `project` names the repo the worker owns, and `createdAt` is what the budget
 * ceiling excludes prior spend against.
 */
import type { Casting } from "./cast.ts";
import type { RunState } from "./types.ts";

/** The stage-facing view of a unit of work. */
export interface WorkItem {
  /** Stable id — the run id (`run-20260810-oauth-middleware`). */
  id: string;
  /** Human-facing handle used in briefs and journals. Same string as {@link id} for a run. */
  identifier: string;
  title: string;
  /** The original request, verbatim. */
  description: string;
  /** The worker-visible brief: the goal, plus the spec checklist once the worker has authored one. */
  body: string;
  state: RunState;
  /** Per-stage harness/model/effort. `{}` = every stage on its default cast. */
  casting: Casting;
  /** Acceptance criteria bullet lines (a run's are its spec.md checklist items). */
  criteria: string[];
  /**
   * The CODE project this work builds — its own repo under `~/Projects/<project>`, pushed to
   * `<owner>/<project>`. Absent ⇒ the caller's fallback (for a run, Beckett's own self-project).
   */
  project?: string;
  /** The git branch carrying the work (`beckett/run-<slug>`). */
  branchRef?: string;
  /** ISO-8601 filing time — the budget ceiling's cutoff for prior spend. */
  createdAt?: string;
  /** ISO-8601. */
  updatedAt: string;
  /** Discord channel this work was deployed from, so updates route back to the conversation. */
  originChannel?: string;
}
