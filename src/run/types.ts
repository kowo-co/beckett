/**
 * Beckett — v7 run contract (`src/run/types.ts`)
 * =======================================================================================
 * THE RUN CONTRACT (docs/../specs/architecture.md "v7 architecture: ticketless runs"). A `Run`
 * replaces `Ticket` as the execution unit: the concierge (or a human) deploys work with one CLI
 * call, `RunSupervisor` drives it through implement → review → publish, and the worker's spec.md
 * checklist (see `./spec-file.ts`) is the enforced contract instead of tracker acceptance
 * criteria. This module is intentionally implementation-free (types only), mirroring the root
 * `src/types.ts` convention.
 *
 * `Casting` is re-exported from `./cast.ts` rather than imported ad hoc by every consumer, so the
 * run contract stays the one import a consumer needs.
 */

export type { Casting } from "./cast.ts";
import type { Casting } from "./cast.ts";

/** The two worker stages a run drives a Claude session through. */
export type RunStage = "implement" | "review";

/** A run's lifecycle. Terminal states: done, failed, cancelled. `parked` is a held-but-alive state. */
export type RunState =
  | "queued"
  | "implementing"
  | "reviewing"
  | "publishing"
  | "done"
  | "failed"
  | "cancelled"
  | "parked";

/**
 * States the supervisor must NOT act on: the three genuinely terminal ones plus `parked`, which is
 * a run deliberately held for a human — re-staffing it is exactly what parking exists to stop.
 *
 * Deliberately WIDER than `RunStore.live()`'s complement: the store keeps parked runs in `live()`
 * so `beckett status` and the run dashboard still show a held run (it has not left the board). The
 * supervisor's own `stageFor()` returns null for `parked`, so the two views never disagree about
 * whether a parked run gets a worker.
 */
export const RUN_TERMINAL: ReadonlySet<RunState> = new Set<RunState>(["done", "failed", "cancelled", "parked"]);

/**
 * What the supervisor tells the rest of the daemon about a run's lifecycle. Deliberately ONE kind:
 * the ticket system's four poll-event kinds existed because a tracker was the source of truth and
 * the daemon had to diff it; the supervisor OWNS the transition, so a state change is the whole
 * vocabulary. `from` is null for a run admitted mid-flight after a restart.
 */
export interface RunStateChange {
  kind: "state_changed";
  run: Run;
  from: RunState | null;
  to: RunState;
}

/**
 * The execution unit. One row per `beckett task deploy` call (or plan-filed run). Durable at
 * `<beckettDir>/runs.json` via {@link ./store.ts}'s `RunStore`.
 */
export interface Run {
  /** "run-20260810-oauth-middleware" (date + slug, unique). */
  id: string;
  /** "oauth-middleware" */
  slug: string;
  /** Short human title. */
  title: string;
  /** The original request, verbatim. */
  prompt: string;
  /** Discord origin. */
  channelId: string | null;
  requesterId: string | null;
  /** "#12.1" public ref when linked to the task registry, else null. */
  taskRef: string | null;
  ultracode: boolean;
  /** Per-stage harness/model/effort. null = defaults. */
  cast: Casting | null;
  /** Project slug, null = beckett itself. */
  repo: string | null;
  state: RunState;
  /** ISO — REQUIRED (budget ceiling depends on it). */
  createdAt: string;
  updatedAt: string;
  /** Worktree path once allocated. */
  workspace: string | null;
  /** "beckett/run-<slug>" */
  branch: string;
  baseSha: string | null;
  /** Claude session uuids per stage. */
  sessionIds: Partial<Record<RunStage, string>>;
  /** "beckett-run-<slug>" — the cross-session address. */
  sessionName: string;
  reviewCycles: number;
  prUrl: string | null;
  error: string | null;
}
