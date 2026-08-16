/**
 * Beckett — the proposal queue (`src/proposal/store.ts`)
 * =======================================================================================
 * The gate that makes dreaming safe (issue #37). A dream can PROPOSE a change to how I work,
 * and can never MAKE one. This module is the record half of that: an append-shaped queue of
 * proposal FILES, and nothing else. It is deliberately inert.
 *
 * The containment is structural, not prompted:
 *
 *   - **A proposal is a record, never an edit.** Nothing in this module — or in its sibling
 *     {@link ./decide.ts} — can write to doctrine, to `persona.md`, or to any memory node. The
 *     only path this file has to the filesystem is {@link proposalPath}, which resolves inside
 *     `<beckettDir>/proposals` and refuses any id that isn't `prop-YYYY-MM-DD-<slug>`. There is
 *     no "apply" verb here to call, so no sequence of calls can reach one.
 *   - **Records are parsed, not trusted.** {@link readProposal} rebuilds a proposal from a
 *     fixed field list; every other key in the JSON on disk is dropped on the floor. A
 *     hand-planted `{"apply": true, "target": "../persona.md"}` is read as an ordinary
 *     proposal with no extra powers, because those words are never looked up.
 *   - **Separate substrate.** Proposals live in their own directory — not in the memory graph,
 *     so they are neither real memories nor dream-inference memories. They can never be
 *     recalled as either, and a proposal write touches no memory file.
 *   - **Nothing is deleted.** A rejection keeps the record with its reason (the open-loop
 *     ledger's logic: what you dropped is signal), and an expiry keeps the claim intact so a
 *     recurring proposal reads as recurring.
 *
 * The decision surface (accept/reject) lives in {@link ./decide.ts} so that the routing — the
 * one place a proposal turns into work — is a single small file to audit.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a proposal can be about. A dream never gets a new kind by writing one into a file. */
export const PROPOSAL_KINDS = [
  "doctrine-change",
  "persona-change",
  "memory-correction",
  "product-idea",
  "ticket",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = ["open", "accepted", "rejected", "expired"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * The id shape, and the traversal guard: a proposal id is the date it was raised plus a slug,
 * exactly like the dream namespace's node names. `proposalPath` rejects anything else, so an id
 * read off a record can never address a file outside the proposals directory.
 */
export const PROPOSAL_ID_RE = /^prop-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

/** Days an undecided proposal survives before it is auto-expired with a note. */
export const PROPOSAL_TTL_DAYS = 14;

/** The note an auto-expired proposal carries, so an expiry always says why it happened. */
const EXPIRY_NOTE = `auto-expired: ${PROPOSAL_TTL_DAYS} days open with no decision`;

/** A claim is one line by construction (whitespace is collapsed); this bounds it. */
const CLAIM_MAX_CHARS = 240;

/**
 * Highest-signal kind first in every listing: a proposal to change my doctrine is the
 * highest-stakes thing the queue can hold, a spike idea is the lowest. A product idea outranks a
 * spike-shaped ticket — it costs a scoping memo to accept, not a build — but sits below the three
 * kinds that change Beckett's own core. Oldest first WITHIN a kind, so nothing rots at the bottom
 * of its own class.
 */
const KIND_ORDER: Record<ProposalKind, number> = {
  "doctrine-change": 0,
  "persona-change": 1,
  "memory-correction": 2,
  "product-idea": 3,
  ticket: 4,
};

/** The parsed record. Every field here is read explicitly; anything else on disk is ignored. */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** One line: the claim itself, not the argument for it. */
  claim: string;
  /** The argument. Never shown in the session block — it has to earn its tokens. */
  rationale: string;
  /** The source ids the proposal was derived from (`journal:#31`, `loop:x`, …). Non-empty. */
  provenance: string[];
  /** Where it came from: `dream:YYYY-MM-DD` for the nightly pass, `manual` by hand. */
  origin: string;
  /** Discord channel this is about, when it is about one — the calibration record's room. */
  channel: string | null;
  /** ISO stamp the proposal was raised. */
  created: string;
  status: ProposalStatus;
  /** ISO stamp of accept/reject/expiry; null while open. */
  decided: string | null;
  /** On accept: what it BECAME (`ticket:OPS-42`, `task:#12.1`). Never a file it edited. */
  became: string | null;
  /** On reject: the required reason. On expiry: the expiry note. */
  note: string | null;
  /** On reject: the name of the calibration record written alongside. */
  calibration: string | null;
}

export interface CreateProposalInput {
  kind: ProposalKind;
  claim: string;
  rationale: string;
  provenance: string[];
  origin: string;
  channel?: string | null;
  /** Explicit raise stamp (the dream passes its own night); defaults to now. */
  now?: Date;
}

// ── paths ──────────────────────────────────────────────────────────────────────────────

/** The canonical record path for an id. Throws for anything that isn't a well-formed id. */
export function proposalPath(proposalsDir: string, id: string): string {
  if (!PROPOSAL_ID_RE.test(id)) {
    throw new Error(`proposal: invalid id '${id}' (must be prop-YYYY-MM-DD-<kebab-slug>)`);
  }
  return join(proposalsDir, `${id}.json`);
}

// ── read ───────────────────────────────────────────────────────────────────────────────

/** One proposal by id, or null when there is no readable record under that name. */
export function readProposal(proposalsDir: string, id: string): Proposal | null {
  const path = proposalPath(proposalsDir, id);
  if (!existsSync(path)) return null;
  try {
    return asProposal(id, JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export interface ListProposalOptions {
  /** Include decided (accepted/rejected/expired) records too. Default: open only. */
  all?: boolean;
  /** Only this status. */
  status?: ProposalStatus;
  /** Evaluation clock — an open record past its deadline reads as expired even before a sweep. */
  now?: Date;
}

/**
 * Every readable record, highest-signal kind first and oldest first within a kind. Malformed
 * files are deliberately absent, exactly like a malformed memory: the queue degrades to the
 * records it can actually parse rather than throwing on someone else's typo.
 *
 * Expiry is evaluated at READ time as well as stamped by {@link sweepExpiredProposals} — the
 * same discipline memory uses for TTL staleness, so a queue nobody has swept never shows a
 * fifteen-day-old proposal as open.
 */
export function listProposals(proposalsDir: string, opts: ListProposalOptions = {}): Proposal[] {
  if (!existsSync(proposalsDir)) return [];
  const now = opts.now ?? new Date();
  const found: Proposal[] = [];
  for (const file of readdirSync(proposalsDir)) {
    const m = file.match(/^(prop-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*)\.json$/);
    if (!m) continue;
    const proposal = readProposal(proposalsDir, m[1]!);
    if (!proposal) continue;
    found.push(pastDeadline(proposal, now) ? { ...proposal, status: "expired", note: proposal.note ?? EXPIRY_NOTE } : proposal);
  }
  const wanted = found.filter((p) => (opts.status ? p.status === opts.status : opts.all ? true : p.status === "open"));
  return wanted.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.created.localeCompare(b.created) ||
      a.id.localeCompare(b.id),
  );
}

/** True when an open proposal has sat undecided past its TTL. Decided records never expire. */
export function pastDeadline(proposal: Proposal, now: Date): boolean {
  if (proposal.status !== "open") return false;
  const raised = Date.parse(proposal.created);
  if (!Number.isFinite(raised)) return false;
  return now.getTime() - raised >= PROPOSAL_TTL_DAYS * 86_400_000;
}

// ── the session-start block ────────────────────────────────────────────────────────────

/** Hard cap on the session block. A block that is noisy every morning gets ignored. */
export const PROPOSALS_BLOCK_MAX_LINES = 5;

/**
 * The compact, bounded session-start block — the surfacing half of the gate. Shows the CLAIM
 * and never the rationale, caps at {@link PROPOSALS_BLOCK_MAX_LINES}, and returns "" (no tag at
 * all) when nothing is pending, so a quiet queue leaves the composed prompt byte-identical.
 *
 * The `try/catch` is load-bearing, exactly as in the loop and calibration blocks: a broken or
 * absent proposals directory must never keep a chat session from launching.
 */
export function renderProposalsBlock(proposalsDir: string | null | undefined, now: Date = new Date()): string {
  if (!proposalsDir) return "";
  try {
    const open = listProposals(proposalsDir, { now });
    if (!open.length) return "";
    const shown = open.slice(0, PROPOSALS_BLOCK_MAX_LINES);
    const lines = shown.map((p) => `- ${p.id} [${p.kind}] ${p.claim}`);
    if (open.length > shown.length) {
      lines.push(`+${open.length - shown.length} more — run \`beckett proposals ls\``);
    }
    lines.push("Decide with `beckett proposals accept|reject <id>`; a proposal never applies itself.");
    return `<open-proposals>\n${lines.join("\n")}\n</open-proposals>`;
  } catch {
    // A broken proposals directory must never keep a chat session from launching.
    return "";
  }
}

// ── write ──────────────────────────────────────────────────────────────────────────────

/**
 * File a new proposal. Create-only: an id already on disk is never overwritten, it is stepped
 * past with a numeric suffix, so two proposals from one night about the same thing both survive.
 */
export function createProposal(proposalsDir: string, input: CreateProposalInput): Proposal {
  if (!PROPOSAL_KINDS.includes(input.kind)) {
    throw new Error(`proposal: kind must be one of: ${PROPOSAL_KINDS.join(", ")}`);
  }
  const claim = oneLine(input.claim ?? "");
  if (!claim) throw new Error("proposal: a one-line claim is required");
  if (claim.length > CLAIM_MAX_CHARS) {
    throw new Error(`proposal: the claim is ${claim.length} chars; it must be one line of at most ${CLAIM_MAX_CHARS}`);
  }
  const rationale = (input.rationale ?? "").trim();
  if (!rationale) throw new Error("proposal: a rationale is required");
  const provenance = (input.provenance ?? []).map((p) => String(p).trim()).filter(Boolean);
  if (!provenance.length) throw new Error("proposal: a non-empty provenance list is required");
  const origin = (input.origin ?? "").trim();
  if (!origin) throw new Error("proposal: an origin is required");

  const now = input.now ?? new Date();
  const proposal: Proposal = {
    id: allocateId(proposalsDir, now, claim),
    kind: input.kind,
    claim,
    rationale,
    provenance,
    origin,
    channel: input.channel?.trim() || null,
    created: now.toISOString(),
    status: "open",
    decided: null,
    became: null,
    note: null,
    calibration: null,
  };
  writeProposal(proposalsDir, proposal, { create: true });
  return proposal;
}

/**
 * Persist a record. `create` refuses an existing file outright; otherwise the id must already
 * name a readable record (a settlement rewrites a record, it never conjures one). Atomic
 * (tmp + rename) like every other durable write in the tree.
 */
export function writeProposal(proposalsDir: string, proposal: Proposal, opts: { create?: boolean } = {}): string {
  const path = proposalPath(proposalsDir, proposal.id);
  if (opts.create && existsSync(path)) {
    throw new Error(`proposal: '${proposal.id}' already exists — proposal records are create-only`);
  }
  if (!opts.create && !existsSync(path)) {
    throw new Error(`proposal: no such proposal '${proposal.id}'`);
  }
  mkdirSync(proposalsDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(proposal, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/**
 * Stamp every open-but-overdue proposal as expired, with its claim intact. The queue cannot
 * become another backlog to feel guilty about; a proposal that keeps coming back is visible as
 * recurring because the expired records stay. Called by the nightly pass and by `proposals ls`.
 */
export function sweepExpiredProposals(proposalsDir: string, now: Date = new Date()): Proposal[] {
  if (!existsSync(proposalsDir)) return [];
  const expired: Proposal[] = [];
  for (const proposal of listProposals(proposalsDir, { all: true, now })) {
    // listProposals reports the derived status; re-read to see what is actually stamped on disk.
    const stored = readProposal(proposalsDir, proposal.id);
    if (!stored || !pastDeadline(stored, now)) continue;
    const settled: Proposal = { ...stored, status: "expired", decided: now.toISOString(), note: EXPIRY_NOTE };
    writeProposal(proposalsDir, settled);
    expired.push(settled);
  }
  return expired;
}

// ── parsing ────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild a proposal from raw JSON, field by field. This is the trust boundary: the returned
 * object is assembled from a fixed list of keys, so no field a record author invents (an
 * `apply`, a `target`, a `path`) survives the read, let alone means anything downstream.
 */
export function asProposal(id: string, raw: unknown): Proposal | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // The filename is the id. A record claiming a different one is malformed, never followed.
  if (typeof r.id !== "string" || r.id !== id || !PROPOSAL_ID_RE.test(id)) return null;
  const kind = PROPOSAL_KINDS.includes(r.kind as ProposalKind) ? (r.kind as ProposalKind) : null;
  const status = PROPOSAL_STATUSES.includes(r.status as ProposalStatus) ? (r.status as ProposalStatus) : null;
  const claim = typeof r.claim === "string" ? oneLine(r.claim) : "";
  const rationale = typeof r.rationale === "string" ? r.rationale.trim() : "";
  const provenance = Array.isArray(r.provenance)
    ? r.provenance.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean)
    : [];
  const origin = typeof r.origin === "string" ? r.origin.trim() : "";
  const created = typeof r.created === "string" && Number.isFinite(Date.parse(r.created)) ? r.created : "";
  if (!kind || !status || !claim || !rationale || !provenance.length || !origin || !created) return null;
  // An open record with a decision stamp (or a decided one without) is malformed frontmatter's
  // equivalent here — a contradiction, never silently normalized into whichever half looks safer.
  const decided = typeof r.decided === "string" && Number.isFinite(Date.parse(r.decided)) ? r.decided : null;
  if ((status === "open") !== (decided === null)) return null;
  return {
    id,
    kind,
    claim,
    rationale,
    provenance,
    origin,
    channel: typeof r.channel === "string" && r.channel.trim() ? r.channel.trim() : null,
    created,
    status,
    decided,
    became: typeof r.became === "string" && r.became.trim() ? r.became.trim() : null,
    note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : null,
    calibration: typeof r.calibration === "string" && r.calibration.trim() ? r.calibration.trim() : null,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────────────────

/** Collapse to a single line: a claim is one line by construction, not by the author's care. */
function oneLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** `prop-<date>-<slug from the claim>`, stepped past anything already on disk. */
function allocateId(proposalsDir: string, now: Date, claim: string): string {
  const date = now.toISOString().slice(0, 10);
  const slug =
    claim.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-") ||
    "proposal";
  const base = `prop-${date}-${slug}`;
  if (!PROPOSAL_ID_RE.test(base)) throw new Error(`proposal: could not derive a usable id from '${claim}'`);
  for (let n = 1; n <= 99; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(join(proposalsDir, `${id}.json`))) return id;
  }
  throw new Error(`proposal: too many proposals already named '${base}'`);
}
