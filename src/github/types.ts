/**
 * Beckett — GitHub PR sense: shared types (`src/github/types.ts`)
 * =======================================================================================
 * OPS-124 — Beckett's primary artifact is the PR, and it used to be WRITE-ONLY: it opened a
 * PR and went blind to review comments, CI, and the eventual merge. This module gives it eyes.
 * The {@link GitHubPrPoller} watches the PRs Beckett opened on the kowo-co org and turns the
 * raw `gh pr view` reads below into a stream of MATERIAL {@link PrPollEvent}s — the same shape
 * the run engine uses to feed the Concierge.
 *
 * Scope (v1): read-and-relay only. Nothing here replies to a review or merges a PR — those stay
 * a human handshake. Import style (whole repo, bun-native): explicit `.ts` extensions, ESM.
 */

/** A PR's lifecycle, exactly as `gh pr view --json state` reports it. */
export type PrLifecycle = "OPEN" | "CLOSED" | "MERGED";

/** The rolled-up conclusion of a PR's status checks (our own reduction of `statusCheckRollup`). */
export type CheckConclusion = "NONE" | "PENDING" | "SUCCESS" | "FAILURE";

/** A review's verdict, as `gh` reports it (uppercased). */
export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

/** One submitted PR review. */
export interface PrReview {
  id: string;
  author: string;
  state: ReviewState;
  submittedAt: string;
  body: string;
}

/** One issue comment on the PR conversation. */
export interface PrComment {
  id: string;
  author: string;
  createdAt: string;
  body: string;
}

/**
 * One live read of a PR's signals via `gh pr view --json …`. The poller diffs successive reads
 * of this against its persisted snapshot to decide what changed.
 */
export interface PrSignals {
  number: number;
  url: string;
  title: string;
  state: PrLifecycle;
  isDraft: boolean;
  /** Head commit sha — CI is keyed on this, so a new push re-arms the CI signal. */
  headRefOid: string;
  /** `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED` | "" (informational). */
  reviewDecision: string;
  reviews: PrReview[];
  comments: PrComment[];
  checkConclusion: CheckConclusion;
}

/** The read primitive the poller depends on (implemented by `GitHubCli.prSignals`). */
export interface GitHubPrReader {
  prSignals(repo: string, number: number): Promise<PrSignals>;
}

/** Counted status-check rollup for a compact branch/PR card. */
export interface BranchCardCheckSummary {
  total: number;
  passed: number;
  pending: number;
  failed: number;
  skipped: number;
  conclusion: CheckConclusion;
}

/**
 * "Can this PR merge right now, and if not, WHY" — GitHub's own verdict, read in one round-trip
 * (implemented by `GitHubCli.prMergeability`). `mergeable` is GitHub's tri-state MERGEABLE /
 * CONFLICTING / UNKNOWN (UNKNOWN while it recomputes the merge commit), and `mergeStateStatus` is
 * the finer-grained reason — BLOCKED (a required review or check is missing), DIRTY (conflicts),
 * BEHIND (base moved under a strict branch protection), UNSTABLE (checks still failing), CLEAN.
 * Kept distinct from {@link BranchCardCheckSummary}: checks are only ONE of the ways a merge blocks.
 */
export interface PrMergeability {
  number: number;
  url: string;
  title: string;
  state: PrLifecycle;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  headRefName: string;
  baseRefName: string;
  checks: BranchCardCheckSummary;
}

/**
 * GitHub's authoritative view of a published branch with a pull request. This deliberately carries
 * aggregate metadata only: Discord cards must never receive or render patch hunks.
 */
export interface GitHubBranchCard {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: PrLifecycle;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  reviewDecision: string;
  reviewCount: number;
  commentCount: number;
  checks: BranchCardCheckSummary;
}

/** On-demand published-branch read primitive, implemented by `GitHubCli.branchCard`. */
export interface GitHubBranchCardReader {
  branchCard(repo: string, ref: string | number): Promise<GitHubBranchCard>;
}

/**
 * The routing context stamped on every emitted event: enough to name the PR in voice AND to route
 * the update back to the channel the run was deployed from. A `channel` of undefined means the
 * poller found no origin channel — the Concierge drops the event silently.
 */
export interface PrRef {
  repo: string;
  number: number;
  url: string;
  title: string;
  /** The run this PR carries, when it came from one. */
  runId?: string;
  channel?: string;
}

/**
 * A material PR transition worth telling the person about. Deliberately narrow (proposal's
 * "material = new review/requested-changes, approval, CI conclusion, merged, closed") — Beckett's
 * own pushes and draft churn never become events.
 */
export type PrPollEvent =
  | { kind: "review"; pr: PrRef; review: PrReview }
  | { kind: "comment"; pr: PrRef; comment: PrComment }
  | { kind: "ci"; pr: PrRef; conclusion: "SUCCESS" | "FAILURE" }
  | { kind: "merged"; pr: PrRef }
  | { kind: "closed"; pr: PrRef };

/** Stable map key for a watched PR. */
export const prKey = (repo: string, number: number): string => `${repo}#${number}`;

/**
 * Parse `owner/repo` + PR number out of a GitHub PR web URL
 * (`https://github.com/kowo-co/foo/pull/96`). Returns null when the string isn't a PR URL, so
 * a non-PR publish (a direct push) never gets registered as something to watch.
 */
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  const repo = m[1]!.replace(/\.git$/, "");
  const number = Number(m[2]);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { repo, number };
}
