/**
 * Beckett — deciding a proposal (`src/proposal/decide.ts`)
 * =======================================================================================
 * The ONLY way a proposal moves (issue #37), and deliberately the smallest file to audit in
 * the queue. Two verbs, and neither of them can edit anything:
 *
 *   - **accept** routes the proposal through the NORMAL pipeline. Accepting a doctrine or
 *     persona change does not edit doctrine or persona — it files a ticket, which takes the
 *     same road, with the same review gate, as any other change to my core. A dream gets no
 *     shortcut for having been clever at 4am. A `ticket` proposal becomes a real task branch,
 *     and a `memory-correction` becomes one too: correcting a memory is work a waking session
 *     does with judgement and visibility rules in hand, not a write this file performs.
 *   - **reject** requires a reason and writes a calibration record, so the same SHAPE of
 *     proposal is weighed differently in that room next time. The rejected record is kept with
 *     its reason — rejection is signal, not deletion, the same logic as the open-loop ledger
 *     keeping what it dropped.
 *
 * {@link ACCEPT_ROUTE} is the containment in one table: every kind maps to `"run"` or
 * `"task"`, and there is no third destination to map to. Both destinations are injected as
 * function seams the caller supplies (the CLI supplies the real tracker client and task store),
 * so this module holds no filesystem handle other than the proposal record it stamps. It
 * imports nothing that can reach doctrine, persona, or the memory graph's write path.
 */

import {
  type Proposal,
  type ProposalKind,
  listProposals,
  pastDeadline,
  readProposal,
  sweepExpiredProposals,
  writeProposal,
} from "./store.ts";

/**
 * Where an accepted proposal goes. Exhaustive by construction: adding a kind is a compile
 * error until it is given a destination here, and the only destinations that exist are the two
 * normal front doors. Nothing maps to "apply".
 */
export const ACCEPT_ROUTE: Record<ProposalKind, "run" | "task"> = {
  "doctrine-change": "run",
  "persona-change": "run",
  "memory-correction": "task",
  // The kind name is frozen history: proposals raised before the ticket rip-out are on disk with
  // `kind: "ticket"`, and renaming it would strand them. It routes to a task branch either way.
  ticket: "task",
};

/** The sentinel room for a signal that came from the dream lane rather than a Discord channel. */
export const DREAM_CALIBRATION_CHANNEL = "dream";

/** Deploy a run — the `beckett task deploy` road. */
export type RunDeployer = (input: {
  title: string;
  body: string;
  criteria: string[];
}) => Promise<{ runId: string; url?: string | null }>;

/** Allocate a real task branch — the `beckett task create` road. */
export type TaskBrancher = (input: {
  title: string;
  body: string;
}) => Promise<{ taskRef: string; branchRef: string }>;

/** Write one calibration record — the `beckett calibration veto` road. */
export type CalibrationRecorder = (input: {
  channel: string;
  about: string;
  reason: string;
  source: string;
}) => Promise<{ name: string }>;

export interface DecideDeps {
  proposalsDir: string;
  now?: () => Date;
}

export interface AcceptDeps extends DecideDeps {
  deployRun: RunDeployer;
  createTaskBranch: TaskBrancher;
}

export interface RejectDeps extends DecideDeps {
  recordCalibration: CalibrationRecorder;
}

export interface AcceptResult {
  proposal: Proposal;
  /** Which front door it went through. */
  route: "run" | "task";
  /** What it became, stamped onto the record (`run:run-20260810-x`, `task:#12.1`). */
  became: string;
  url: string | null;
}

/**
 * Accept a proposal: route it into the normal pipeline, then stamp the record with what it
 * became. Route-first is deliberate — if the routing fails there is simply no accepted stamp,
 * rather than a record claiming to have become something that does not exist.
 */
export async function acceptProposal(deps: AcceptDeps, id: string): Promise<AcceptResult> {
  const now = deps.now?.() ?? new Date();
  const proposal = requireOpen(deps.proposalsDir, id, now);
  const route = ACCEPT_ROUTE[proposal.kind];
  const body = filedBody(proposal);

  let became: string;
  let url: string | null = null;
  if (route === "run") {
    // A doctrine/persona change becomes a REVIEWABLE run. This is the whole design: the change to
    // my core is written, reviewed, and merged by the pipeline, never by this call.
    const run = await deps.deployRun({
      title: `${proposal.kind}: ${proposal.claim}`,
      body,
      criteria: [proposal.claim],
    });
    if (!run?.runId?.trim()) throw new Error(`proposal: deploying a run for '${id}' returned no run id`);
    became = `run:${run.runId.trim()}`;
    url = run.url?.trim() || null;
  } else {
    const branch = await deps.createTaskBranch({ title: proposal.claim, body });
    if (!branch?.branchRef?.trim()) throw new Error(`proposal: starting a task branch for '${id}' returned no ref`);
    became = `task:${branch.branchRef.trim()}`;
  }

  const settled: Proposal = { ...proposal, status: "accepted", decided: now.toISOString(), became };
  writeProposal(deps.proposalsDir, settled);
  return { proposal: settled, route, became, url };
}

export interface RejectResult {
  proposal: Proposal;
  /** The calibration record written alongside the rejection. */
  calibration: string;
}

/**
 * Reject a proposal with a required reason. The calibration record is written FIRST and the
 * rejection stamp only follows a successful write, so "a rejected proposal always moved the
 * bar" holds without a second bookkeeping pass — an unwritable calibration ledger fails the
 * whole reject loudly instead of quietly dropping the signal.
 */
export async function rejectProposal(
  deps: RejectDeps,
  id: string,
  reason: string,
  opts: { about?: string } = {},
): Promise<RejectResult> {
  const now = deps.now?.() ?? new Date();
  const why = (reason ?? "").trim();
  if (!why) throw new Error("proposal: --why <reason> is required to reject a proposal");
  const proposal = requireOpen(deps.proposalsDir, id, now);

  const record = await deps.recordCalibration({
    channel: proposal.channel ?? DREAM_CALIBRATION_CHANNEL,
    // The join key is the CLASS of proposal, not this incident — two rejections of the same
    // shape in the same room is exactly the pattern that should move the bar next time.
    about: (opts.about ?? "").trim() || `proposal-${proposal.kind}`,
    reason: `${why} (rejected proposal: ${proposal.claim})`,
    source: `proposal:${proposal.id}`,
  });
  const name = record?.name?.trim();
  if (!name) throw new Error(`proposal: the calibration record for '${id}' was not written; nothing rejected`);

  const settled: Proposal = { ...proposal, status: "rejected", decided: now.toISOString(), note: why, calibration: name };
  writeProposal(deps.proposalsDir, settled);
  return { proposal: settled, calibration: name };
}

/** Every open proposal, with the expiry sweep run first so the list is honest on disk too. */
export function pendingProposals(proposalsDir: string, now: Date = new Date()): Proposal[] {
  sweepExpiredProposals(proposalsDir, now);
  return listProposals(proposalsDir, { now });
}

// ── helpers ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an id to a proposal that can still be decided. An already-decided record is refused
 * (no re-deciding what became something), and an overdue one is expired on the spot rather than
 * quietly accepted two weeks late — a dream that still matters will propose it again.
 */
function requireOpen(proposalsDir: string, id: string, now: Date): Proposal {
  const proposal = readProposal(proposalsDir, id);
  if (!proposal) throw new Error(`proposal: no such proposal '${id}'`);
  if (pastDeadline(proposal, now)) {
    sweepExpiredProposals(proposalsDir, now);
    throw new Error(
      `proposal: '${id}' expired undecided after ${daysOpen(proposal, now)} days; file it again with \`beckett dream propose\` if it still holds`,
    );
  }
  if (proposal.status !== "open") {
    throw new Error(`proposal: '${id}' is already ${proposal.status}${proposal.became ? ` (${proposal.became})` : ""}`);
  }
  return proposal;
}

function daysOpen(proposal: Proposal, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(proposal.created)) / 86_400_000);
}

/** The body a routed proposal carries into the pipeline: the claim, the argument, the receipts. */
function filedBody(proposal: Proposal): string {
  return [
    proposal.claim,
    "",
    "## why",
    proposal.rationale,
    "",
    "## provenance",
    ...proposal.provenance.map((p) => `- ${p}`),
    "",
    `Accepted from proposal \`${proposal.id}\` (${proposal.kind}, raised ${proposal.created.slice(0, 10)} by ${proposal.origin}).`,
    "Proposals never edit anything: this is the normal pipeline doing the work, with the normal review gate.",
  ].join("\n");
}
