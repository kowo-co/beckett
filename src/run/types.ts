/**
 * Beckett v7 — the RUN contract (`src/run/types.ts`)
 * =======================================================================================
 * A {@link Run} is v7's execution unit: the thing `beckett task deploy` creates and the
 * {@link RunSupervisor} (`./supervisor.ts`) drives from `queued` to `done`. It replaces the
 * ticket as the unit of dispatch — no board, no poller, no ticket ceremony. The public
 * `#N.x` task registry stays exactly where it was; a run merely points at it (`taskRef`).
 *
 * This module is intentionally implementation-free (types only), mirroring
 * `src/tracker/types.ts` and the root `src/types.ts` convention.
 */

import type { Casting } from "../tracker/types.ts";

/** The worker stages a run passes through. Mirrors the dispatcher's stage names 1:1. */
export type RunStage = "implement" | "review";

/**
 * A run's lifecycle. `parked` is the "a human must look at this" terminal-ish state (the
 * ticket era's park-to-todo); `failed`/`cancelled`/`done` are genuinely terminal.
 */
export type RunState =
  | "queued"
  | "implementing"
  | "reviewing"
  | "publishing"
  | "done"
  | "failed"
  | "cancelled"
  | "parked";

/** Non-terminal run states — the supervisor's boot scan and watchdog enumerate exactly these. */
export const RUN_TERMINAL: ReadonlySet<RunState> = new Set<RunState>([
  "done",
  "failed",
  "cancelled",
  "parked",
]);

/** One deployed unit of work. See `specs/architecture.md` §"The run model". */
export interface Run {
  /** "run-20260810-oauth-middleware" (date + slug, unique). */
  id: string;
  /** "oauth-middleware". */
  slug: string;
  /** Short human title. */
  title: string;
  /** The original request, verbatim. */
  prompt: string;
  /** Discord origin channel, when the run came from a conversation. */
  channelId: string | null;
  requesterId: string | null;
  /** "#12.1" public ref when linked to the task registry, else null. */
  taskRef: string | null;
  ultracode: boolean;
  /** Per-stage harness/model/effort; null = stage defaults. */
  cast: Casting | null;
  /** Project slug, null = beckett itself. */
  repo: string | null;
  state: RunState;
  /** ISO — REQUIRED (the budget ceiling depends on it). */
  createdAt: string;
  updatedAt: string;
  /** Worktree path once allocated. */
  workspace: string | null;
  /** "beckett/run-<slug>". */
  branch: string;
  baseSha: string | null;
  /** Claude session uuids per stage (crash resume). */
  sessionIds: Partial<Record<RunStage, string>>;
  /** "beckett-run-<slug>" — the cross-session address. */
  sessionName: string;
  reviewCycles: number;
  prUrl: string | null;
  error: string | null;
}

/** The patch shape {@link RunStore.update} accepts (everything but the identity fields). */
export type RunPatch = Partial<Omit<Run, "id" | "slug" | "createdAt">>;
