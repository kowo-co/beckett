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
import type { DoneBlockerClass } from "../types.ts";

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
 * States the supervisor must NOT auto-restaff: the three genuinely terminal ones plus `parked`.
 * `parked` is no longer a one-way door — `beckett task resume` and `beckett task steer` (B5) both
 * exit it — but the WATCHDOG must never re-staff one on its own, which is exactly what belonging
 * to this set stops.
 *
 * Deliberately WIDER than `RunStore.live()`'s complement: the store keeps parked runs in `live()`
 * so `beckett status` and the run dashboard still show a held run (it has not left the board). The
 * supervisor's own `stageFor()` returns null for `parked`, so the two views never disagree about
 * whether a parked run gets a worker.
 */
export const RUN_TERMINAL: ReadonlySet<RunState> = new Set<RunState>(["done", "failed", "cancelled", "parked"]);

/** Truly finished — nothing, human or machine, will ever move these. */
export const RUN_FINAL: ReadonlySet<RunState> = new Set<RunState>(["done", "failed", "cancelled"]);

// ── B5: the typed blocker ───────────────────────────────────────────────────────────────────

/**
 * Mirrors `../types.ts#DoneBlockerClass` verbatim (that file cannot import from `src/run/`, so
 * this one re-derives from it instead of the other way round).
 */
export type BlockerClass = DoneBlockerClass;

/** Who can clear this. ONLY `"human"` may stop a run — see `./blocker.ts`'s actor table. */
export type BlockerActor = "human" | "supervisor";

/**
 * Why a run stopped, typed. The `class` decides the `actor` (`./blocker.ts`) — a worker's own
 * done-signal names only a class, never an actor, so it cannot talk the run into stopping.
 */
export interface Blocker {
  class: BlockerClass;
  actor: BlockerActor;
  /** Can the remedy be undone? Informational; drives concierge phrasing, never control flow. */
  reversible: boolean;
  /** One line, imperative: what clears this. Rendered to the channel verbatim. */
  remedy: string;
  /** The long form — what used to be the whole free-text park reason. */
  detail: string;
  /** For class "question": what fires if nobody answers before the timeout. */
  defaultAnswer: string | null;
  /** ISO. */
  at: string;
}

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
 * How a `done` run's branch actually reached GitHub — additive next to the existing top-level
 * `prUrl` (#228). Two terminal shapes:
 *   - `{via: "outbox", prUrl}` — the durable publish outbox (`../dispatch/publish-outbox.ts`)
 *     landed it itself, synchronously or after a retry.
 *   - `{via: "courier", prUrl}` — a human took the outbox row over and published it by hand
 *     (`RunSupervisor.courier`). `prUrl` starts `null` (there is no automatic signal for a
 *     courier-landed PR — the daemon never drove it) and can be backfilled later
 *     ({@link ../store.ts RunStore.backfillCourierPrUrl}) once a human knows it.
 * `null` on every run that never reached `publishing`, and on every OLD persisted run from before
 * this field existed — `../store.ts`'s schema tolerates the missing field on load (migration
 * safety), and nothing reads `published` as load-bearing for a run's actual state (`state` +
 * `prUrl` still carry that), so an old row renders exactly as it always did.
 */
export type PublishRecord = { via: "outbox" | "courier"; prUrl: string | null };

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
  /** Implement passes spent on "ran out of turn" (`done:false, blocker:null`). */
  continuations: number;
  prUrl: string | null;
  error: string | null;
  /** How a `done` run got published — null until it does (see {@link PublishRecord}). */
  published: PublishRecord | null;
  /** Non-null iff `state === "parked"` (B5). The typed reason a human is holding this run. */
  blocker: Blocker | null;
}
