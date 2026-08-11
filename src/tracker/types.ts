/**
 * Beckett — tracker shared domain types (`src/tracker/types.ts`)
 * =======================================================================================
 * THE TICKET CONTRACT. Every module imports its shared vocabulary from here:
 *   - BoredClient (`../bored/client.ts`) — speaks bored's HTTP API, returns {@link Ticket}s
 *   - Poller     (`./poll.ts`)           — diffs poll snapshots, emits {@link PollEvent}s
 *   - Dispatcher (`../dispatch/*`)       — consumes {@link PollEvent}s, spawns workers
 *   - Concierge  (`../concierge/*`)      — files {@link Ticket}s with per-stage {@link Casting}
 *
 * This module is intentionally implementation-free (types only), mirroring the root
 * `src/types.ts` convention. The cast-block parse/serialize logic lives next door in
 * `./cast.ts` so this file stays a pure contract.
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions —
 *   `import type { Ticket } from "./types.ts";`
 */

// =======================================================================================
// Ticket lifecycle
// =======================================================================================

/**
 * Beckett's canonical ticket lifecycle. bored projects these states from its workflow runs;
 * the client translates lifecycle writes into bored's staff/gate/cancel verbs.
 */
export type TicketState =
  | "backlog"
  | "todo"
  /** INT only: live design-document authoring stage. */
  | "design"
  /** INT only: parked human approval gate for the design document. */
  | "design_review"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled";

/** Terminal ticket states — no worker runs once a ticket is here. */
export const TICKET_TERMINAL: ReadonlySet<TicketState> = new Set<TicketState>([
  "done",
  "cancelled",
]);

// =======================================================================================
// Casting — which harness/model runs each workflow stage
// =======================================================================================

/**
 * A coding-agent CLI Beckett drives as a worker (matches root `Harness`). Open toward a
 * registry-validated string: the in-tree core `claude`/`codex`/`pi` stay literals for autocomplete,
 * but which harness names are actually FILEABLE is decided at runtime by the driver registry
 * (`isRegisteredHarness`), not by this type — see {@link validateCasting}.
 */
export type HarnessName = "claude" | "codex" | "pi" | (string & {});

/** One stage's harness selection: which CLI, optionally which model + reasoning effort. */
export interface HarnessSpec {
  harness: HarnessName;
  model?: string;
  // "ultracode" (claude-only, 2.1.203+) — automatic workflow orchestration on top of xhigh
  // reasoning. See root `Effort` (src/types.ts) for the shared union this mirrors.
  effort?: "low" | "medium" | "high" | "xhigh" | "ultracode";
  /**
   * v3.1 review gate (set on the `implement` cast). `self` = the implement worker self-verifies
   * inline and the ticket goes straight to `done` (one pass, no separate reviewer). `fresh` = a
   * separate adversarial reviewer runs (`in_review` stage). When unset the dispatcher derives it
   * from `effort` (low/medium → self; high/xhigh/unset → fresh).
   */
  reviewTier?: "self" | "fresh";
}

/**
 * Per-stage casting for a ticket. `design` staffs an INT ticket's design worker, `implement`
 * staffs the `in_progress` worker, and `review` staffs the `in_review` reviewer. Open-ended:
 * future stages (e.g. `integrate`) key in by name. Stored inside the ticket description as
 * a ```beckett-cast``` fenced block.
 */
export interface Casting {
  implement?: HarnessSpec;
  review?: HarnessSpec;
  [stage: string]: HarnessSpec | undefined;
}

// =======================================================================================
// Ticket + comments — the hydrated view of a tracker ticket
// =======================================================================================

/**
 * A tracker ticket hydrated into Beckett's view. `description` is the raw stored description
 * (cast block + criteria + prose); `body` is JUST the human prose with the cast block and
 * the acceptance-criteria section stripped out (see {@link parseCast} in `./cast.ts`).
 * `casting` and `criteria` are the parsed-out structured halves of `description`.
 */
export interface Ticket {
  id: string; // tracker ticket id (bored ref, e.g. "OPS-42")
  identifier: string; // human ref, e.g. "BEC-42"
  title: string;
  description: string; // raw stored description (cast block + criteria + prose)
  body: string; // prose only (cast block + criteria section removed)
  state: TicketState;
  assignees: string[]; // tracker member ids (bored tickets carry none)
  casting: Casting;
  criteria: string[]; // acceptance-criteria bullet lines
  /**
   * Identifiers of tickets this one is blocked by (a `beckett plan` dependency edge, e.g.
   * `["OPS-41"]`). The ticket is held in `backlog` until EVERY blocker reaches `done`, at which
   * point the dispatcher promotes it to `in_progress`. Empty for an independent ticket. Stored in
   * the ticket description (```beckett-deps``` block) so the tracker stays the single source of truth and
   * the DAG survives a daemon restart — no in-memory dependency state to lose.
   */
  blockedBy: string[];
  /**
   * The CODE project this ticket builds — its own repo under `~/Projects/<project>`, pushed to
   * `<owner>/<project>` on GitHub, fully decoupled from Beckett's own source repo. The Concierge
   * names it at creation (```beckett-project``` block); absent ⇒ the dispatcher falls back to the
   * ticket identifier (a per-ticket sandbox). NOT the tracker board (that's `projectId`).
   */
  project?: string;
  /** Stable user-facing task-branch reference, for example `42.2`. */
  branchRef?: string;
  /**
   * Non-main integration/target branch this ticket publishes onto (```beckett-target-branch``` block,
   * e.g. `v5-daemon`). When set, the publisher ships the finished work to THIS branch on the code
   * repo and never advances the repo's default branch (`main`) — the funnel that keeps a campaign
   * off `main` until one final human-merged integration→main PR (OPS-185). Absent ⇒ publish to the
   * repo default exactly as a normal ticket does.
   */
  targetBranch?: string;
  /** Parent ticket id when this branch is nested under another started branch. */
  parentId?: string;
  /** Lifecycle state a held task branch should enter once its dependencies finish. */
  startState?: TicketState;
  projectId: string; // tracker board id (the queue, e.g. "bored:ops") — NOT the code project above
  url: string; // deep link to the ticket on the tracker
  /**
   * Filing time, used to distinguish a recycled display identifier from its prior incarnation.
   * Optional for legacy tracker adapters that do not expose it.
   */
  createdAt?: string; // ISO-8601
  updatedAt: string; // ISO-8601; the poll cursor / change key
  /**
   * The tracker has durably paused this ticket for a human. This is deliberately
   * independent of `state`: bored projects a paused run as `in_review`.
   */
  parked?: boolean;
  /** Human-readable tracker reason for the durable park, when available. */
  parkReason?: string;
  /**
   * Discord channel that filed this ticket, stamped by the Concierge at creation so worker/ticket
   * updates can be routed back to the conversation that asked (the closed agent loop). Absent for
   * tickets created outside Discord (e.g. straight on the tracker). Stored natively by bored —
   * the tracker stays the single source of truth (no sidecar DB).
   */
  originChannel?: string;
}

/** One comment on a ticket (bored surfaces these from its event journal). */
export interface TicketComment {
  id: string;
  ticketId: string;
  author: string; // author id / display name
  body: string;
  createdAt: string; // ISO-8601
}

// =======================================================================================
// PollEvent — the normalized shell→dispatcher signal stream
// =======================================================================================

/**
 * What the poller emits after diffing one poll snapshot against the last. The dispatcher is
 * the sole consumer (the shell POLLS the tracker every `config.tracker.poll_secs`, emits these).
 */
export type PollEvent =
  | { kind: "created"; ticket: Ticket }
  | { kind: "state_changed"; ticket: Ticket; from: TicketState | null; to: TicketState }
  | { kind: "comment_added"; ticket: Ticket; comment: TicketComment }
  | { kind: "cancelled"; ticket: Ticket };

/** Convenience discriminator alias for the four poll-event kinds. */
export type PollEventKind = PollEvent["kind"];

// =======================================================================================
// Cast-block parse/serialize — the structured halves of a ticket description
// =======================================================================================

/** The structured parts {@link parseCast} pulls out of a ticket description. */
export interface ParsedCast {
  casting: Casting;
  criteria: string[];
  blockedBy: string[]; // ticket identifiers this one waits on (```beckett-deps``` block)
  project?: string; // code-project slug (```beckett-project``` block) — see Ticket.project
  branchRef?: string; // user-facing task branch (```beckett-branch``` block), e.g. `42.2`
  startState?: TicketState; // desired post-dependency state (```beckett-start-state``` block)
  targetBranch?: string; // non-main publish/integration branch (```beckett-target-branch```) — see Ticket.targetBranch
  body: string; // prose with the cast/deps/project blocks + criteria section removed
}

// =======================================================================================
// Client contract inputs/outputs (shared by the client factory and its consumers)
// =======================================================================================

/** Inputs to {@link TrackerClient.createIssue}. `body`/`description` are aliases (prose only). */
export interface CreateTicketInput {
  title: string;
  /** Human prose body; `serializeCast` composes the final stored description. */
  body?: string;
  /** Alias for {@link CreateTicketInput.body} (the CLI / Concierge may pass either name). */
  description?: string;
  casting?: Casting;
  criteria?: string[];
  /** Identifiers of tickets this one is blocked by (held in `backlog` until all are `done`). */
  blockedBy?: string[];
  /** Code-project slug — the ticket's own repo under `~/Projects/<project>` (see {@link Ticket.project}). */
  project?: string;
  /** User-facing task branch reference, e.g. `42.2`. */
  branchRef?: string;
  /** Non-main integration/target branch to publish onto (see {@link Ticket.targetBranch}). */
  targetBranch?: string;
  /** Parent ticket id for nested task branches. */
  parentId?: string;
  /** State to enter after dependencies clear; defaults to the requested initial state. */
  startState?: TicketState;
  /** Lifecycle state to file into; defaults to the tracker's ready column. */
  state?: TicketState;
  /** Tracker member ids to assign (unused by bored). */
  assignees?: string[];
  /**
   * Discord channel that originated this ticket, so worker/ticket updates route back to the
   * right conversation (closed agent loop). Surfaced on hydration as {@link Ticket.originChannel}.
   */
  originChannel?: string;
}

/** A workflow state descriptor, as returned by {@link TrackerClient.listStates}. */
export interface WorkflowState {
  id: string;
  name: string;
  group?: string;
}

/** What a call to {@link TrackerClient.ensureProvisioned} had to create. */
export interface ProvisioningResult {
  projectCreated: boolean;
  statesCreated: string[];
}
