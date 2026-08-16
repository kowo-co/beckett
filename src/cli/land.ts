/**
 * Beckett — landing a branch on a PROTECTED base (`src/cli/land.ts`)
 * =======================================================================================
 * One engine for "get these commits onto `main`" when `main` refuses a direct push. Branch
 * protection on `kowo-co/beckett` requires a pull request and the `check` status check, so a
 * `git push origin main` — from a person or from `beckett finish` —
 * cannot land anything: GitHub answers `GH006: Protected branch update failed`. The only path that
 * works is push a branch → open (or reuse) its PR → wait for CI → merge, and that path is here,
 * ONCE, rather than re-implemented per caller.
 *
 * Two callers share it: {@link runFinish} (`beckett finish`) and `GitHubCli.publishViaPullRequest`
 * (the run engine's owned-repo publish). `deploy/deploy-prod.sh` no longer lands through here —
 * since 2026-08-12 the release bump pushes straight at main under the App's ruleset bypass.
 * Both push through {@link GitHubCli} — the single credential boundary, which hands `git` the
 * GitHub App installation token as `x-access-token`, because neither `beckett finish` nor the run
 * engine's publish has ambient git credentials for kowo-co: a bare `git push` there dies with
 * `could not read Username for 'https://github.com'`.
 *
 * Everything that can stop a landing is NAMED here: {@link gateMerge} turns GitHub's collapsed
 * `mergeStateStatus` into a specific cause plus the command that clears it, and every message
 * carries the caller's own re-run command (`command`) so the operator is told to re-run the thing
 * they actually ran. The pure functions are unit-pinned (`land.test.ts`, `finish.test.ts`), so
 * these messages are decided by tests rather than discovered in production.
 */

import type { PrMergeability } from "../github/types.ts";
import type { MergeStrategy } from "../types.ts";

/** How long to keep polling GitHub for a verdict before giving up with a specific message. */
export const DEFAULT_CI_TIMEOUT_MS = 15 * 60_000;
/** Gap between mergeability reads while CI runs. */
export const POLL_INTERVAL_MS = 15_000;
/**
 * A PR that was opened seconds ago legitimately reports ZERO checks — the workflows have not
 * registered yet. Merging into that window would ship past a CI suite that never ran, so an
 * empty rollup is treated as "still pending" until this grace elapses, and only then as "this repo
 * has no CI".
 */
export const CHECKS_GRACE_MS = 60_000;

/** The default re-run command named in every blocker message. */
const DEFAULT_COMMAND = "beckett finish";

// ── the merge gate (pure: every blocker's message is pinned by tests) ────────────────────────

export type MergeGate =
  /** Already on main — skip the merge and go straight to the deploy. */
  | { kind: "merged" }
  /** Clear to merge now. */
  | { kind: "ready" }
  /** Not yet, but it may still resolve on its own — keep polling until the deadline. */
  | { kind: "wait"; why: string }
  /** It will not resolve on its own. `error` names the blocker AND the command that clears it. */
  | { kind: "blocked"; error: string };

/**
 * Decide what to do with a PR from GitHub's own verdict. Ordering is deliberate: the most SPECIFIC
 * cause wins, because `mergeStateStatus` collapses several distinct problems into `BLOCKED` and a
 * caller told "blocked" learns nothing. So failed checks are reported as failed checks, conflicts
 * as conflicts, and only a genuinely unexplained block falls through to the generic branch —
 * which still names the status GitHub returned rather than inventing a reason.
 *
 * `checksGraceElapsed` distinguishes "this repo has no CI" from "the workflows have not registered
 * yet", which look identical over the API (an empty rollup) for the first seconds of a PR's life.
 *
 * `command` is the caller's own re-run command: `beckett finish` for the end-of-ticket motion,
 * `./deploy/deploy-prod.sh` for the release-bump landing. Telling an operator mid-deploy to re-run
 * a command they never ran is how a named blocker stops being actionable.
 */
export function gateMerge(
  pr: PrMergeability,
  repo: string,
  checksGraceElapsed: boolean,
  command: string = DEFAULT_COMMAND,
): MergeGate {
  const ref = `PR #${pr.number}${pr.url ? ` (${pr.url})` : ""}`;
  if (pr.state === "MERGED") return { kind: "merged" };
  if (pr.state === "CLOSED") {
    return {
      kind: "blocked",
      error:
        `${ref} is CLOSED, so there is nothing to merge. Reopen it (\`beckett gh raw -- pr reopen ${pr.number} ` +
        `--repo ${repo}\`) and re-run \`${command}\`, or finish from a branch that still has an open PR.`,
    };
  }
  if (pr.isDraft) {
    return {
      kind: "blocked",
      error:
        `${ref} is a DRAFT — GitHub refuses to merge drafts. Mark it ready with ` +
        `\`beckett gh raw -- pr ready ${pr.number} --repo ${repo}\`, then re-run \`${command}\`.`,
    };
  }
  if (pr.checks.conclusion === "FAILURE") {
    return {
      kind: "blocked",
      error:
        `CI FAILED on ${ref}: ${pr.checks.failed} of ${pr.checks.total} checks red ` +
        `(${pr.checks.passed} passed, ${pr.checks.pending} still running). Refusing to merge red. ` +
        `Read them with \`beckett gh raw -- pr checks ${pr.number} --repo ${repo}\`, push the fix to ` +
        `\`${pr.headRefName || "the branch"}\`, then re-run \`${command}\`.`,
    };
  }
  if (pr.checks.conclusion === "PENDING") {
    return { kind: "wait", why: `${pr.checks.pending} of ${pr.checks.total} checks still running` };
  }
  if (pr.checks.total === 0 && !checksGraceElapsed) {
    return { kind: "wait", why: "no checks reported yet (waiting for the workflows to register)" };
  }
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return {
      kind: "blocked",
      error:
        `${ref} has MERGE CONFLICTS with ${pr.baseRefName || "the base branch"}. Nothing automatic can ` +
        `resolve these. In the branch checkout: \`git fetch origin && git rebase origin/${pr.baseRefName || "main"}\`, ` +
        `settle the conflicts, push, then re-run \`${command}\`.`,
    };
  }
  // GitHub recomputes mergeability asynchronously; UNKNOWN means "ask again", not "no".
  if (pr.mergeable === "UNKNOWN") return { kind: "wait", why: "GitHub is still computing mergeability" };
  if (pr.mergeStateStatus === "BEHIND") {
    return {
      kind: "blocked",
      error:
        `${ref} is BEHIND ${pr.baseRefName || "main"} and this repo requires branches to be up to date ` +
        `before merging. Update it (\`git fetch origin && git rebase origin/${pr.baseRefName || "main"}\` in the ` +
        `branch checkout, then push) and re-run \`${command}\`.`,
    };
  }
  if (pr.mergeStateStatus === "BLOCKED") {
    return {
      kind: "blocked",
      error:
        `${ref} is BLOCKED by branch protection — checks are ${pr.checks.conclusion.toLowerCase()}, so what is ` +
        `missing is almost certainly a required REVIEW or a required check that has not reported. ` +
        `Check with \`beckett gh raw -- pr view ${pr.number} --repo ${repo}\`; get the approval (or fix the ` +
        `protection rule), then re-run \`${command}\`.`,
    };
  }
  return { kind: "ready" };
}

/**
 * A `gh pr merge` refusal, translated. gh's own stderr is accurate but terse ("Pull request is not
 * mergeable"), and by the time it appears the caller has already lost the pre-merge read — so
 * restate what it means HERE, with the branch and repo filled in, rather than passing the raw line
 * through and letting whoever reads it guess.
 */
export function describeMergeFailure(
  err: string,
  repo: string,
  number: number,
  branch: string,
  command: string = DEFAULT_COMMAND,
  base: string = "main",
): string {
  const raw = err.trim();
  const lower = raw.toLowerCase();
  const rebase = `\`git fetch origin && git rebase origin/${base}\` in the ${branch} checkout, push, then re-run \`${command}\``;
  if (lower.includes("not mergeable") || lower.includes("conflict")) {
    return `merging PR #${number} failed: GitHub refused it as not mergeable — the base moved under the branch. Resolve with ${rebase}.\n${raw}`;
  }
  if (lower.includes("required status check") || lower.includes("review") || lower.includes("protected branch")) {
    return `merging PR #${number} failed: branch protection on ${repo} still refuses it (a required review or check). Read \`beckett gh raw -- pr view ${number} --repo ${repo}\`, clear it, then re-run \`${command}\`.\n${raw}`;
  }
  return `merging PR #${number} on ${repo} failed. ${raw}`;
}

// ── the engine ──────────────────────────────────────────────────────────────────────────────

/** The slice of {@link GitHubCli} a landing needs — narrow so tests can fake it without gh/git. */
export interface LandClient {
  pushBranch(repo: string, localRef: string, remoteBranch: string, opts?: { force?: boolean }): Promise<void>;
  ensurePR(p: { repo: string; base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  prMergeability(repo: string, n: number): Promise<PrMergeability>;
  mergePR(repo: string, n: number, strategy: MergeStrategy): Promise<void>;
}

export interface LandOptions {
  repo: string;
  /** The remote branch that carries the work (also the default local ref). */
  head: string;
  /** Local ref to push as `head` — `HEAD` when the caller is sitting on the branch. */
  localRef?: string;
  base: string;
  title: string;
  body: string;
  strategy: MergeStrategy;
  ciTimeoutMs: number;
  /**
   * Force-update the remote branch. ONLY for machine-owned, single-purpose branches that this
   * process is the sole author of — the deploy's `release-bump-vX.Y.Z`, which a re-run legitimately
   * rebuilds from scratch (a fresh commit with the same content but a different sha, which a
   * fast-forward push would reject as non-fast-forward and wedge every retry).
   */
  force?: boolean;
  /** The checkout the push runs in — used in messages only; the client resolves the real dir. */
  dir?: string;
  /** The caller's own re-run command, named in every blocker message. */
  command?: string;
  /**
   * A clause appended to the timeout's "Nothing was merged" sentence, so the caller can state what
   * ELSE did not happen (`beckett finish` adds " and nothing was deployed"). A timeout is the one
   * stop where the operator most needs to know how far the motion got.
   */
  timeoutAlso?: string;
  /** Live narration (stderr in the CLIs, a collector in tests). */
  step?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LandResult {
  pr: { number: number; url: string };
  /** `already-merged` when the PR had landed before this run reached the merge. */
  merge: "merged" | "already-merged";
}

/**
 * A landing that stopped. `message` is already a complete, named explanation — the caller prefixes
 * its own command name and prints it verbatim rather than re-describing the failure.
 */
export class LandError extends Error {
  constructor(
    message: string,
    /** Which stage stopped: `push` | `pr` | `read` | `blocked` | `timeout` | `merge`. */
    readonly stage: "push" | "pr" | "read" | "blocked" | "timeout" | "merge",
  ) {
    super(message);
    this.name = "LandError";
  }
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Push `head`, open (or reuse) its PR into `base`, wait — BOUNDED — for CI, and merge. Idempotent
 * by construction: a re-run reuses the open PR, and a PR that already merged short-circuits to
 * `already-merged` instead of failing, so "re-run after clearing the blocker" is always safe.
 */
export async function landBranch(gh: LandClient, opts: LandOptions): Promise<LandResult> {
  const command = opts.command ?? DEFAULT_COMMAND;
  const step = opts.step ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const where = opts.dir ? ` in ${opts.dir}` : "";

  step(`pushing ${opts.head} to ${opts.repo}`);
  try {
    await gh.pushBranch(opts.repo, opts.localRef ?? opts.head, opts.head, { force: opts.force });
  } catch (err) {
    const raw = (err as Error).message;
    const hint = /non-fast-forward|fetch first|rejected/i.test(raw)
      ? ` The remote branch has commits yours does not. Reconcile with \`git fetch origin && git rebase origin/${opts.head}\`${where}, then re-run.`
      : "";
    throw new LandError(`pushing ${opts.head} to ${opts.repo} failed.${hint}\n${raw}`, "push");
  }

  step(`opening (or reusing) the PR into ${opts.base}`);
  let pr: { number: number; url: string };
  try {
    pr = await gh.ensurePR({ repo: opts.repo, base: opts.base, head: opts.head, title: opts.title, body: opts.body });
  } catch (err) {
    const raw = (err as Error).message;
    if (/no commits between/i.test(raw)) {
      throw new LandError(
        `${opts.head} has no commits that ${opts.base} does not already have, so there is no PR to open — ` +
          `this work is already merged, or nothing was committed. Check with ` +
          `\`git log origin/${opts.base}..${opts.head}\`${where}. ` +
          `(This is a REAL comparison against ${opts.repo}: a base branch that does not exist yet — an empty ` +
          `repo — is a first push, which \`beckett finish\` detects and performs before it ever gets here.)`,
        "pr",
      );
    }
    throw new LandError(`opening the PR for ${opts.head} on ${opts.repo} failed.\n${raw}`, "pr");
  }
  step(`PR #${pr.number} — ${pr.url}`);

  const startedAt = now();
  let gate: MergeGate = { kind: "wait", why: "reading the PR" };
  for (;;) {
    let state: PrMergeability;
    try {
      state = await gh.prMergeability(opts.repo, pr.number);
    } catch (err) {
      throw new LandError(
        `could not read PR #${pr.number} on ${opts.repo} — cannot tell whether it is safe to merge.\n${(err as Error).message}`,
        "read",
      );
    }
    gate = gateMerge(state, opts.repo, now() - startedAt >= CHECKS_GRACE_MS, command);
    if (gate.kind === "blocked") throw new LandError(gate.error, "blocked");
    if (gate.kind !== "wait") break;
    const elapsed = now() - startedAt;
    if (elapsed >= opts.ciTimeoutMs) {
      throw new LandError(
        `gave up waiting on PR #${pr.number} (${pr.url}) after ${Math.round(elapsed / 1000)}s — ${gate.why}. ` +
          `Nothing was merged${opts.timeoutAlso ?? ""}. Watch it with \`beckett gh pr status ${pr.number} --repo ${opts.repo}\` and ` +
          `re-run \`${command}\` once it settles, or raise the budget with --ci-timeout <secs>.`,
        "timeout",
      );
    }
    step(`waiting on CI — ${gate.why} (${Math.round(elapsed / 1000)}s of ${Math.round(opts.ciTimeoutMs / 1000)}s)`);
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, opts.ciTimeoutMs - elapsed)));
  }

  if (gate.kind === "merged") {
    step(`PR #${pr.number} is already merged`);
    return { pr, merge: "already-merged" };
  }
  step(`merging PR #${pr.number} into ${opts.base} (${opts.strategy})`);
  try {
    await gh.mergePR(opts.repo, pr.number, opts.strategy);
  } catch (err) {
    throw new LandError(describeMergeFailure((err as Error).message, opts.repo, pr.number, opts.head, command, opts.base), "merge");
  }
  return { pr, merge: "merged" };
}
