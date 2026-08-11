/**
 * Beckett — the Run contract (`src/run/types.ts`)
 * =======================================================================================
 * v7 replaces the Ticket as Beckett's execution unit with the Run: the concierge deploys work
 * with ONE CLI call (`beckett task deploy`), no ticket ceremony. This file is the EXACT contract
 * from `docs/architecture.md` (ticketless-runs decision record) — every builder across the v7
 * wave conforms to it byte-for-byte, so an independent copy of this file from another lane is
 * expected to be identical and trivially mergeable.
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions —
 *   `import type { Run } from "./types.ts";`
 */

import type { Casting } from "../tracker/types.ts";

/** The two stages a run's cast can address (open-ended stage names elsewhere, e.g. tickets, do
 * not apply here — a run's `cast` is validated to only these keys). */
export type RunStage = "implement" | "review";

export type RunState =
  | "queued"
  | "implementing"
  | "reviewing"
  | "publishing"
  | "done"
  | "failed"
  | "cancelled"
  | "parked";

export interface Run {
  id: string; // "run-20260810-oauth-middleware" (date + slug, unique)
  slug: string; // "oauth-middleware"
  title: string; // short human title
  prompt: string; // the original request, verbatim
  channelId: string | null; // Discord origin
  requesterId: string | null;
  taskRef: string | null; // "#12.1" public ref when linked to the task registry, else null
  ultracode: boolean;
  cast: Casting | null; // existing Casting type (per-stage harness/model/effort), null = defaults
  repo: string | null; // project slug, null = beckett itself
  state: RunState;
  createdAt: string; // ISO — REQUIRED (budget ceiling depends on it)
  updatedAt: string;
  workspace: string | null; // worktree path once allocated
  branch: string; // "beckett/run-<slug>"
  baseSha: string | null;
  sessionIds: Partial<Record<RunStage, string>>; // claude session uuids per stage
  sessionName: string; // "beckett-run-<slug>" — the cross-session address
  reviewCycles: number;
  prUrl: string | null;
  error: string | null;
}
