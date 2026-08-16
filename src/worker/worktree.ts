/**
 * Beckett — git worktree allocation & integration (`src/worker/worktree.ts`)
 * =======================================================================================
 * Layer-1 of scope enforcement (Spec 02 §8.1): one isolated git worktree + branch per
 * worker, rooted under `<repoRoot>/.beckett/worktrees/<wk-id>`. This module is the only
 * place that shells `git worktree add/remove`, reads a worker's diff, commits its branch,
 * and merges it back (INTEGRATE = a real `git merge`, Spec 04 §… / Spec 01 §3 step 9).
 *
 * Everything here is mechanism: pure-ish async functions over a repo path. The WorkerManager
 * (`./manager.ts`) composes them; the orchestrator drives INTEGRATE/REVIEW on top.
 *
 * Design notes:
 *  - We keep per-worker *meta* files (the done-signal schema + the scope-guard settings) inside
 *    the worktree (so `claude` auto-loads `.claude/settings.json` from its cwd) but add them to
 *    the worktree's git exclude so they never pollute the worker's diff (Spec 02 §8.2 wiring).
 *  - Diff readouts intent-to-add untracked files (`git add -A -N`) so brand-new files show up in
 *    REVIEW/checkpoint diffs without staging their contents.
 */

import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, chmodSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "../log.ts";

const logger = log.child("worktree");

/**
 * Beckett's internal worker/dispatcher scaffolding directory, written into every worktree at spawn
 * (the done-signal schema + scope-guard settings) and also the parent of the worktrees themselves.
 * It is Beckett's bookkeeping, NOT project work, and must NEVER be staged, committed, or pushed —
 * leaking it once turned a whole PR into junk (OPS-61). Guarded three independent ways: `info/exclude`
 * (blocks `git add -A`/`git add .`), a shared `pre-commit` hook that strips it from the index under
 * ANY committer ({@link installScaffoldingGuardHook}, defeats `git add -f`), and an explicit strip in
 * {@link commitWorktree}. Beckett's own source checkout additionally `.gitignore`s it.
 */
export const SCAFFOLDING_DIR = ".beckett";

/** Result of a raw git invocation. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `git <args>` in `cwd`, capturing stdout/stderr. Never inherits a tty/stdin. */
async function runGit(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Never block on a credential/passphrase prompt — a remote op (ls-remote/clone) on a missing
    // or unauthorized repo must fail fast, not hang the daemon waiting on a tty.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** Run git and throw a descriptive error on a non-zero exit. */
async function git(args: string[], cwd: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.code}) in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

// =======================================================================================
// Types
// =======================================================================================

/** Inputs to allocate one worker's worktree (Spec 02 §8.1). */
export interface CreateWorktreeOpts {
  /** Absolute path to the project git repo root. */
  repoRoot: string;
  /** Absolute path the new worktree will live at (under `<repoRoot>/.beckett/worktrees/<id>`). */
  workspace: string;
  /** Branch to create/checkout, e.g. "beckett/<task>/<node>". */
  branch: string;
  /**
   * Base ref to branch from (origin/main or the DAG integration branch). When it doesn't resolve
   * here, {@link resolveDefaultBaseRef} supplies the remote's real default branch instead — the
   * checkout's `HEAD` is only ever a last resort, never a silent substitute.
   */
  baseRef: string;
  /** When resuming, reuse an existing worktree/branch instead of recreating (Spec 02 §4.5). */
  reuseIfExists?: boolean;
  /**
   * A now-unsafe path this ticket's worktree may still occupy on disk from a previous daemon (#134)
   * — e.g. one whose directory segment contained a raw `#`. When it exists on disk (and `workspace`
   * does not), the tree is migrated to `workspace` via `git worktree move` BEFORE any fresh cut, so
   * both committed and uncommitted work follow and git's registration is rewritten in one step (a
   * fresh `worktree add` on the same branch would otherwise fail with "branch already checked out").
   */
  legacyWorkspace?: string;
}

/** A handle to an allocated worktree. */
export interface WorktreeHandle {
  repoRoot: string;
  workspace: string;
  branch: string;
}

/** Aggregate diff size for a worktree (Spec 02 §7.4). */
export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

/** Result of committing a worktree's working tree. */
export interface CommitResult {
  committed: boolean;
  sha: string | null;
}

/** Optional author identity for commits (Beckett's identity, Spec 07). */
export interface CommitAuthor {
  name: string;
  email: string;
}

// =======================================================================================
// Worktree lifecycle
// =======================================================================================

/**
 * Allocate a worktree + branch for a worker (Spec 02 §8.1):
 *   git worktree add -b <branch> <workspace> <baseRef>
 * Creates the parent `.beckett/worktrees/` dir first. When `reuseIfExists` is set and the
 * worktree path already exists (resume), it is returned as-is.
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<WorktreeHandle> {
  const { repoRoot, workspace, branch, baseRef } = opts;
  const handle: WorktreeHandle = { repoRoot, workspace, branch };

  if (opts.reuseIfExists && existsSync(workspace)) {
    logger.info("reusing existing worktree", { workspace, branch });
    return handle;
  }

  // Legacy-path migration (#134): an in-flight ticket left over from a deploy may still have its
  // worktree at a now-unsafe path (e.g. a `#`-named dir). Move it to the sanitized `workspace` so
  // both committed and uncommitted work survive AND the branch is freed from its old checkout — a
  // fresh `worktree add` on the same branch would otherwise fail. On a move failure, drop the legacy
  // tree so its branch can be checked out fresh below (committed work lives on the branch).
  if (
    opts.legacyWorkspace &&
    opts.legacyWorkspace !== workspace &&
    existsSync(opts.legacyWorkspace) &&
    !existsSync(workspace)
  ) {
    mkdirSync(dirname(workspace), { recursive: true });
    const moved = await runGit(["worktree", "move", opts.legacyWorkspace, workspace], repoRoot);
    if (moved.code === 0) {
      logger.info("migrated legacy worktree to sanitized path", { from: opts.legacyWorkspace, to: workspace, branch });
      return handle;
    }
    logger.warn("legacy worktree move failed; removing it and cutting fresh (committed work is on the branch)", {
      from: opts.legacyWorkspace,
      to: workspace,
      stderr: moved.stderr.trim(),
    });
    await removeWorktree(repoRoot, opts.legacyWorkspace);
  }

  mkdirSync(dirname(workspace), { recursive: true });

  // Proactive: a fresh/empty project has nothing to branch from. Creating a repo is reversible
  // (Spec 00 — proceed on reversible), so we init it + make an initial commit rather than
  // escalating "there are no commits". No-op when a commit already exists.
  await ensureBaseRepo(repoRoot);

  // If the branch already exists (e.g. a prior failed attempt), check it out instead of -b.
  const branchExists = (await runGit(["rev-parse", "--verify", "--quiet", branch], repoRoot)).code === 0;
  // The requested baseRef may not exist here (a just-initialized repo, or a repo whose default
  // branch simply isn't called `main`). Fall back to the branch the REMOTE calls default — never
  // straight to `HEAD`, which in a shared project checkout is whatever OTHER run's branch happens
  // to be checked out there. That fallback is how a second run in flight against the same repo got
  // cut from its SIBLING's branch on 2026-08-14, and then tried to rebase its publish onto that
  // instead of the repo's real default branch. `HEAD` survives only as the last resort for a repo
  // that has no default branch to name at all (a fresh `git init` project).
  const baseOk = (await runGit(["rev-parse", "--verify", "--quiet", baseRef], repoRoot)).code === 0;
  let effectiveBase = baseRef;
  if (!baseOk) {
    const fallback = await resolveDefaultBaseRef(repoRoot);
    if (fallback) {
      logger.warn("base ref is absent — branching from the remote's default branch instead", {
        repoRoot,
        baseRef,
        fallback,
      });
    } else {
      logger.warn("no default branch could be resolved — branching from this checkout's HEAD", {
        repoRoot,
        baseRef,
        head: await currentBranch(repoRoot),
      });
    }
    effectiveBase = fallback ?? "HEAD";
  }
  const args = branchExists
    ? ["worktree", "add", workspace, branch]
    : ["worktree", "add", "-b", branch, workspace, effectiveBase];

  await git(args, repoRoot);
  logger.info("worktree created", { workspace, branch, baseRef: effectiveBase });
  return handle;
}

/** Whether a local or fetched ref is available as a safe worktree base. */
export async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  return (await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot)).code === 0;
}

/**
 * The repo's default branch NAME (`main`, `master`, `trunk`, …) as the REMOTE reports it: the
 * recorded `refs/remotes/<remote>/HEAD` first, then a live `ls-remote --symref` for a checkout that
 * never had one written (a `git init` + `remote add` provisioning). Null when no remote can answer.
 *
 * Deliberately never derived from the checkout's own `HEAD`/current branch. A shared project
 * checkout routinely sits on some run's `beckett/<run>` branch, so "whatever is checked out" is a
 * sibling's work, not the default branch — the confusion that made a second in-flight run aim its
 * publish at its sibling's branch (2026-08-14). Best-effort: never throws.
 */
export async function remoteDefaultBranch(repoRoot: string, remote = "origin"): Promise<string | null> {
  const recorded = await runGit(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], repoRoot);
  const short = recorded.code === 0 ? recorded.stdout.trim() : "";
  if (short) return short.startsWith(`${remote}/`) ? short.slice(remote.length + 1) : short;
  const symref = await runGit(["ls-remote", "--symref", remote, "HEAD"], repoRoot);
  if (symref.code === 0) {
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(symref.stdout);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * A ref that resolves to the tip of the repo's default branch — {@link remoteDefaultBranch}'s answer
 * preferred as its remote-tracking ref, then the conventional names, and null if the repo has none
 * of them (a brand-new project with no commits yet). This is the ONLY safe base/rebase target when
 * the caller's requested ref is missing: every candidate here is a branch the remote named, never
 * the checkout's current position.
 */
export async function resolveDefaultBaseRef(repoRoot: string, remote = "origin"): Promise<string | null> {
  const named = await remoteDefaultBranch(repoRoot, remote);
  const candidates = [
    ...(named ? [`${remote}/${named}`, named] : []),
    `${remote}/main`,
    `${remote}/master`,
    "main",
    "master",
  ];
  for (const ref of candidates) {
    if (await refExists(repoRoot, ref)) return ref;
  }
  return null;
}

/** Compose multiple completed task branches into a dependent branch before its worker starts. */
export async function mergeBranchesIntoWorktree(workspace: string, branches: string[]): Promise<void> {
  for (const branch of branches) {
    const result = await runGit(
      ["-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", branch],
      workspace,
    );
    if (result.code === 0) continue;
    const conflicts = (await runGit(["diff", "--name-only", "--diff-filter=U"], workspace)).stdout
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
    await runGit(["merge", "--abort"], workspace);
    throw new Error(
      `cannot compose dependency branch ${branch}${conflicts.length ? `; conflicts: ${conflicts.join(", ")}` : ""}`,
    );
  }
}

/**
 * Ensure `repoRoot` is a git repo with ≥1 commit so `git worktree add` has a base to branch from.
 * Proactive self-setup: a brand-new project (or an empty ~/projects) is initialized rather than
 * failing the dispatch. Idempotent — does nothing once a commit exists. Relies on the global git
 * identity (set at provisioning to Beckett's signed identity).
 */
async function ensureBaseRepo(repoRoot: string): Promise<void> {
  mkdirSync(repoRoot, { recursive: true });
  const isRepo = (await runGit(["rev-parse", "--is-inside-work-tree"], repoRoot)).code === 0;
  if (!isRepo) {
    await git(["init"], repoRoot);
    await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], repoRoot);
    logger.info("git init (fresh project repo)", { repoRoot });
  }
  const hasCommit = (await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot)).code === 0;
  if (!hasCommit) {
    // -c commit.gpgsign=false: the bootstrap commit must never block on signing in the daemon env.
    await git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init: beckett project"], repoRoot);
    logger.info("created initial commit", { repoRoot });
  }
}

/** Canonicalize a path for comparison (resolves symlinks like macOS /var → /private/var). */
function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True if `workspace` is a registered worktree of `repoRoot` (symlink-tolerant comparison). */
export async function worktreeExists(repoRoot: string, workspace: string): Promise<boolean> {
  const r = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  if (r.code !== 0) return false;
  const target = canon(workspace);
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ") && canon(line.slice("worktree ".length)) === target) return true;
  }
  return false;
}

/**
 * Tear down a worker's worktree after its diff has been captured/merged (Spec 02 §8.1):
 *   git worktree remove <workspace> --force ; git worktree prune
 * Idempotent — a missing worktree is not an error. Attempts the git removal unconditionally
 * (git path canonicalization makes a pre-check unreliable) and falls back to an fs removal +
 * prune so the directory and registration are always cleared.
 */
export async function removeWorktree(repoRoot: string, workspace: string): Promise<void> {
  const r = await runGit(["worktree", "remove", workspace, "--force"], repoRoot);
  if (r.code !== 0 && existsSync(workspace)) {
    logger.warn("git worktree remove failed; removing directory directly", {
      workspace,
      stderr: r.stderr.trim(),
    });
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch (err) {
      logger.warn("fs worktree removal failed", { workspace, error: (err as Error).message });
    }
  }
  await runGit(["worktree", "prune"], repoRoot);
  logger.info("worktree removed", { workspace });
}

/**
 * Delete a local branch outright (`git branch -D`). Idempotent — a branch that is already gone
 * is not an error. Used by the overnight-spike GC (issue #38): a spike branch is evidence, not
 * work, so after its TTL it is dropped while the finding text is kept.
 */
export async function deleteBranch(repoRoot: string, branch: string): Promise<void> {
  const r = await runGit(["branch", "-D", branch], repoRoot);
  if (r.code !== 0 && !/not found/i.test(r.stderr)) {
    logger.warn("git branch -D failed", { repoRoot, branch, stderr: r.stderr.trim() });
  }
}

/**
 * True if `branch` exists on `remote` (`git ls-remote --heads`). Used by the worktree sweep
 * (Task 4) to confirm a terminal run's work is durable elsewhere before its local branch and
 * worktree are removed. Any failure (network, auth, missing remote) reads as false — "not
 * provably pushed" — so the sweep only ever removes what it can prove is safe.
 */
export async function remoteBranchExists(repoRoot: string, branch: string, remote = "origin"): Promise<boolean> {
  const r = await runGit(["ls-remote", "--heads", remote, `refs/heads/${branch}`], repoRoot);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/**
 * Append ignore patterns to a worktree's git exclude file (`info/exclude`) so per-worker meta
 * files (the scope-guard settings + done schema) never appear in the worker's diff.
 */
export async function excludeFromGit(workspace: string, patterns: string[]): Promise<void> {
  const excludePathRaw = (await git(["rev-parse", "--git-path", "info/exclude"], workspace)).trim();
  // git may return a path relative to the worktree cwd; resolve via the worktree.
  const excludePath = excludePathRaw.startsWith("/") ? excludePathRaw : `${workspace}/${excludePathRaw}`;
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    /* file may not exist yet; create dir below */
  }
  mkdirSync(dirname(excludePath), { recursive: true });
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const toAdd = patterns.filter((p) => !have.has(p));
  if (toAdd.length > 0) {
    appendFileSync(excludePath, (existing.endsWith("\n") || existing === "" ? "" : "\n") + toAdd.join("\n") + "\n");
  }
}

/**
 * Install a shared `pre-commit` hook that strips {@link SCAFFOLDING_DIR} from the index before any
 * commit is created — the universal guard that makes Beckett's bookkeeping impossible to commit no
 * matter who runs `git commit` (the worker's own shell, {@link commitWorktree}, or any future path),
 * even after a deliberate `git add -f .beckett`. `info/exclude` alone can't stop a forced add; this
 * can. Resolved via `git rev-parse --git-path hooks`, which in a linked worktree points at the repo's
 * shared hooks dir, so one install protects the main repo and every worktree. We never clobber a
 * project's own pre-commit hook: if one exists that isn't ours we leave it and rely on the code-path
 * strip in {@link commitWorktree}. Idempotent.
 */
export async function installScaffoldingGuardHook(workspace: string): Promise<void> {
  const marker = "beckett-scaffolding-guard";
  const hooksDirRaw = (await git(["rev-parse", "--git-path", "hooks"], workspace)).trim();
  const hooksDir = hooksDirRaw.startsWith("/") ? hooksDirRaw : `${workspace}/${hooksDirRaw}`;
  const hookPath = `${hooksDir}/pre-commit`;
  try {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes(marker)) {
      logger.warn("pre-commit hook exists and isn't ours — leaving it; commit-path strip still guards", { hookPath });
      return;
    }
  } catch {
    /* no hook yet — install below */
  }
  mkdirSync(hooksDir, { recursive: true });
  const script =
    `#!/bin/sh\n` +
    `# ${marker}: never let Beckett's internal bookkeeping (${SCAFFOLDING_DIR}/) into a commit (OPS-61).\n` +
    `git rm -r --cached --ignore-unmatch --quiet -- ${SCAFFOLDING_DIR} >/dev/null 2>&1 || true\n`;
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
  logger.info("installed scaffolding-guard pre-commit hook", { hookPath });
}

// =======================================================================================
// Diff readout (Spec 02 §7.4) — used by REVIEW, checkpoint, abort capture
// =======================================================================================

/**
 * Read the full diff of a worktree. Intent-to-adds untracked files first so new files are
 * visible. Diffs against `baseRef` when given (worker's net contribution vs the integration
 * base), else against HEAD (uncommitted working-tree changes).
 */
export async function readDiff(workspace: string, baseRef?: string): Promise<string> {
  await runGit(["add", "-A", "-N"], workspace); // intent-to-add untracked (no content staged)
  const r = await runGit(["diff", baseRef ?? "HEAD"], workspace);
  return r.stdout;
}

// =======================================================================================
// Commit + merge (INTEGRATE; Spec 04 / Spec 01 §3 step 9)
// =======================================================================================

/**
 * Commit all changes in a worktree onto its branch. Returns `{committed:false, sha:null}` when
 * the tree is already clean (nothing to do). v0 single-node still needs a commit so INTEGRATE
 * can merge the branch.
 */
export async function commitWorktree(
  workspace: string,
  message: string,
  author?: CommitAuthor,
): Promise<CommitResult> {
  await git(["add", "-A"], workspace);
  // Belt-and-suspenders: strip Beckett's own scaffolding from the index before committing, even if a
  // prior `git add -f .beckett` forced it in past the exclude. The pre-commit hook does this too; we
  // repeat it here so the guarantee holds on this path independent of hook state (OPS-61).
  await runGit(["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", "--", SCAFFOLDING_DIR], workspace);
  const status = (await runGit(["status", "--porcelain"], workspace)).stdout.trim();
  if (status === "") return { committed: false, sha: null };

  const env: Record<string, string> = author
    ? {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      }
    : {};
  const proc = Bun.spawn(["git", "commit", "-m", message], {
    cwd: workspace,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stderr = await new Response(proc.stderr).text();
  await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`git commit failed in ${workspace}: ${stderr.trim()}`);
  }
  const sha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  logger.info("worktree committed", { workspace, sha });
  return { committed: true, sha };
}

/** Convenience: does this repo path have any commits yet (a valid HEAD)? */
export async function hasHead(repoRoot: string): Promise<boolean> {
  return (await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot)).code === 0;
}

/**
 * The current HEAD sha of a repo, or null if it has no commits yet. v3.1 in-place workers capture
 * this when a ticket first enters `implement` so a later REVIEW stage can diff the ticket's whole
 * contribution (`<baseSha>..HEAD`) instead of relying on a per-worker branch.
 */
export async function headSha(repoRoot: string): Promise<string | null> {
  const r = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * True when the checkout has a committed contribution relative to the captured ticket base. When
 * there was no base commit (fresh `git init` project), any HEAD commit counts as contribution.
 */
export async function hasDiffSince(repoRoot: string, baseRef: string | null): Promise<boolean> {
  if (!baseRef) return hasHead(repoRoot);
  const r = await runGit(["diff", "--quiet", `${baseRef}..HEAD`], repoRoot);
  if (r.code === 0) return false;
  if (r.code === 1) return true;
  throw new Error(`git diff --quiet ${baseRef}..HEAD failed (${r.code}) in ${repoRoot}: ${r.stderr.trim() || r.stdout.trim()}`);
}

/** The current branch name of a repo (or a short sha when detached / "HEAD" on a fresh repo). */
export async function currentBranch(repoRoot: string): Promise<string> {
  const r = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const name = r.stdout.trim();
  return name || "HEAD";
}

/** Outcome of {@link fastForwardCheckout}. */
export interface FastForwardResult {
  status: "fast-forwarded" | "skipped";
  /** New HEAD sha, present only when `status === "fast-forwarded"`. */
  sha?: string;
  /** Why it was left alone, present only when `status === "skipped"`. */
  reason?: string;
}

/**
 * Fast-forward a project's own checkout (`~/Projects/<slug>`) to `branch`'s tip at `remoteUrl` —
 * the tunnel-served mockups read their files straight out of this working copy, so a ticket that
 * lands on a project's main must not leave that checkout stuck on the pre-land build (#91). ff-only,
 * NEVER a merge and NEVER a force: any state that would need either is left untouched, and the
 * caller gets `reason` to log rather than a thrown error. That covers a dirty tree (uncommitted
 * changes), a detached HEAD or a checkout parked on some other branch, and a diverged/behind local
 * history the remote tip doesn't contain (`git merge --ff-only` refuses cleanly without touching
 * the working tree).
 */
export async function fastForwardCheckout(
  repoRoot: string,
  remoteUrl: string,
  branch: string,
): Promise<FastForwardResult> {
  const onBranch = await currentBranch(repoRoot);
  if (onBranch !== branch) {
    return { status: "skipped", reason: `checkout is on "${onBranch}", not "${branch}"` };
  }
  const status = (await runGit(["status", "--porcelain"], repoRoot)).stdout.trim();
  if (status !== "") {
    return { status: "skipped", reason: "checkout has uncommitted changes" };
  }
  const fetch = await runGit(["fetch", "--quiet", remoteUrl, branch], repoRoot);
  if (fetch.code !== 0) {
    return { status: "skipped", reason: `fetch failed: ${fetch.stderr.trim() || fetch.stdout.trim()}` };
  }
  const merge = await runGit(["merge", "--ff-only", "--quiet", "FETCH_HEAD"], repoRoot);
  if (merge.code !== 0) {
    return { status: "skipped", reason: `fast-forward would not apply: ${merge.stderr.trim() || merge.stdout.trim()}` };
  }
  const sha = (await runGit(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  logger.info("fast-forwarded project checkout", { repoRoot, branch, sha });
  return { status: "fast-forwarded", sha };
}

/**
 * The raw, git-measured relationship between a worktree's HEAD and the repo's `main` — the facts a
 * publish-hand-off message is computed from ({@link classifyBranchLanding}). Deliberately just
 * numbers + strings so the INTERPRETATION (already-landed vs behind vs genuinely-ahead) is a pure,
 * table-tested decision rather than something discovered live against real git.
 */
export interface BranchVsMainRaw {
  /** False when no `main` ref could be resolved at all (no origin, offline, empty repo) → "unknown". */
  compared: boolean;
  /** Commits HEAD has that `main` does not (`git rev-list --count main..HEAD`). */
  ahead: number;
  /** Commits `main` has that HEAD does not (`git rev-list --count HEAD..main`). */
  behind: number;
  /**
   * Of the `ahead` commits, how many are NOT already present on `main` as an equivalent patch —
   * `git cherry`'s `+` lines (patch-id match). Zero while `ahead > 0` means every local commit has
   * ALREADY landed on main under a different sha (the squash-merge case behind every 2026-08-14 stall).
   */
  aheadUnlanded: number;
  /** When all local work is already on main: the matching `main` commit sha, if one was found by subject. */
  landedCommit?: string;
  /** HEAD's own subject line — names the work in the hand-off message, and finds its twin on main. */
  landedSubject?: string;
  /**
   * The ref the comparison was actually made against, named for the human reading the hand-off
   * (`origin/main`, `origin/trunk`, …). Absent when nothing could be compared.
   */
  mainRef?: string;
}

/**
 * Measure a worktree's HEAD against the repo's `main`, for the publish-hand-off advice
 * ({@link classifyBranchLanding} / `publishParkAdvice`). A publish that gives up must tell the human
 * the RIGHT thing to do, and that turns entirely on whether the branch (a) genuinely needs
 * publishing, (b) already landed on main under a squash sha, or (c) is behind and would revert work
 * if pushed — the three shapes that were all mis-advised as "just push it" on 2026-08-14.
 *
 * The trunk it measures against is the one the REMOTE calls default ({@link remoteDefaultBranch}),
 * not the literal name `main`: a project whose default is `trunk`/`master` otherwise resolved no ref
 * at all, fell through to "unknown", and got handed back the very generic "just push it" this exists
 * to prevent — on exactly the already-landed branches where pushing is the wrong move.
 *
 * Fetches that branch fresh so the comparison is against the true remote tip, not a stale
 * remote-tracking ref. NEVER throws: any git failure (no remote, detached HEAD, offline) returns
 * `compared: false` so the caller falls back to generic advice rather than a wrong diagnosis.
 */
export async function readBranchVsMain(workspace: string, remote = "origin"): Promise<BranchVsMainRaw> {
  const unknown: BranchVsMainRaw = { compared: false, ahead: 0, behind: 0, aheadUnlanded: 0 };
  try {
    // Prefer the freshly fetched remote tip; fall back to whatever local ref exists so an offline
    // box still gets a comparison instead of a wrong "just push it". `main` stays in the candidate
    // list as the last resort for a repo whose remote can't name a default at all.
    const trunk = (await remoteDefaultBranch(workspace, remote)) ?? "main";
    let mainRef: string | null = null;
    let named: string | null = null;
    if ((await runGit(["fetch", "--quiet", remote, trunk], workspace)).code === 0) {
      mainRef = "FETCH_HEAD";
      named = `${remote}/${trunk}`;
    } else {
      for (const cand of [`${remote}/${trunk}`, trunk, `${remote}/main`, "main"]) {
        if ((await runGit(["rev-parse", "--verify", "--quiet", `${cand}^{commit}`], workspace)).code === 0) {
          mainRef = cand;
          named = cand.includes("/") ? cand : `${remote}/${cand}`;
          break;
        }
      }
    }
    if (!mainRef) return unknown;
    if ((await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], workspace)).code !== 0) return unknown;

    const aheadR = await runGit(["rev-list", "--count", `${mainRef}..HEAD`], workspace);
    const behindR = await runGit(["rev-list", "--count", `HEAD..${mainRef}`], workspace);
    if (aheadR.code !== 0 || behindR.code !== 0) return unknown;
    const ahead = Number(aheadR.stdout.trim() || "0");
    const behind = Number(behindR.stdout.trim() || "0");

    let aheadUnlanded = ahead;
    if (ahead > 0) {
      // `git cherry` marks each local commit `+` (no equivalent upstream) or `-` (patch-id already on
      // main). All `-` ⇒ the work has already landed under a squash sha.
      const cherry = await runGit(["cherry", mainRef, "HEAD"], workspace);
      if (cherry.code === 0) {
        aheadUnlanded = cherry.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("+")).length;
      }
    }

    let landedCommit: string | undefined;
    let landedSubject: string | undefined;
    const subjR = await runGit(["log", "-1", "--format=%s", "HEAD"], workspace);
    if (subjR.code === 0 && subjR.stdout.trim()) landedSubject = subjR.stdout.trim();
    // Name the twin commit on main only when the work is actually there (identical, or all-landed).
    if (ahead === 0 || (ahead > 0 && aheadUnlanded === 0)) {
      if (landedSubject) {
        const found = await runGit(
          ["log", mainRef, "-1", "--format=%H", "--fixed-strings", `--grep=${landedSubject}`],
          workspace,
        );
        if (found.code === 0 && found.stdout.trim()) landedCommit = found.stdout.trim().split(/\s+/)[0];
      }
      if (!landedCommit) {
        const tip = await runGit(["rev-parse", "--verify", "--quiet", mainRef], workspace);
        if (tip.code === 0 && tip.stdout.trim()) landedCommit = tip.stdout.trim();
      }
    }
    return { compared: true, ahead, behind, aheadUnlanded, landedCommit, landedSubject, mainRef: named ?? undefined };
  } catch (err) {
    logger.warn("branch-vs-main comparison failed; publish hand-off falls back to generic advice", {
      workspace,
      error: (err as Error).message,
    });
    return unknown;
  }
}

/**
 * Best-effort `git fetch origin` so a fresh per-ticket worktree can branch from an up-to-date
 * `origin/main` instead of a stale local checkout (the drift that stranded OPS-59/61). Project
 * repos are public, so this is unauthenticated. NEVER throws — a missing origin, offline box, or
 * private repo just leaves the worktree to branch from whatever local base exists (createWorktree
 * falls back to HEAD). Returns whether the fetch actually succeeded (for logging only).
 */
export async function fetchRemote(repoRoot: string, remote = "origin"): Promise<boolean> {
  const hasRemote = (await runGit(["remote", "get-url", remote], repoRoot)).code === 0;
  if (!hasRemote) return false;
  const r = await runGit(["fetch", "--quiet", remote], repoRoot);
  if (r.code !== 0) {
    logger.warn("git fetch failed; worktree will branch from local base", {
      repoRoot,
      remote,
      error: r.stderr.trim() || r.stdout.trim(),
    });
    return false;
  }
  return true;
}

/**
 * Pin repo-local `user.name`/`user.email` to the bot identity. Applied on EVERY
 * {@link ensureProjectRepo} call — including for existing checkouts — so commits cannot inherit a
 * developer's ambient identity. The noreply address uses the validated project owner supplied by
 * the dispatcher; it never guesses a maintainer account.
 */
async function applyRepoIdentity(repoRoot: string, owner: string): Promise<void> {
  const gitName = process.env.BECKETT_GIT_NAME?.trim() || "Beckett";
  const gitEmail = process.env.BECKETT_GIT_EMAIL?.trim() || `${owner}@users.noreply.github.com`;
  for (const [key, value] of [
    ["user.name", gitName],
    ["user.email", gitEmail],
  ] as const) {
    const r = await runGit(["config", key, value], repoRoot);
    if (r.code !== 0) {
      logger.warn("could not pin repo git identity", { repoRoot, key, stderr: r.stderr.trim() });
    }
  }
}

/** The URL a managed project repo's `origin` points at — one place, so every path agrees. */
export function projectRemoteUrl(owner: string, slug: string): string {
  return `https://github.com/${owner}/${slug}.git`;
}

/**
 * Point `origin` at `remote` when the checkout has NONE — the fix for a run that could never
 * publish (2026-08-14, `babble`). A project repo that is EMPTY on GitHub (or momentarily
 * unreadable) fails the `ls-remote` probe below, so {@link ensureProjectRepoUncached} took the
 * `git init` path — which wired no remote at all. Everything downstream then had nowhere to push:
 * `git remote -v` was empty in the checkout AND in every worktree cut from it (linked worktrees
 * share `.git/config`, so a missing remote is missing for all of them), the run sat in `publishing`
 * forever, and `beckett finish` had nothing to compare against.
 *
 * Deliberately NEVER clobbers an existing `origin`: a checkout cloned from a third-party upstream
 * publishes through that upstream (`GitHubCli.ensurePublished` case 1), and rewriting its origin to
 * `<owner>/<slug>` would silently retarget the whole publish. Idempotent, and applied to EXISTING
 * checkouts too, so repos an older code path left remote-less repair themselves on the next run.
 */
export async function ensureOriginRemote(repoRoot: string, remote: string): Promise<void> {
  const existing = await runGit(["remote", "get-url", "origin"], repoRoot);
  if (existing.code === 0 && existing.stdout.trim()) return;
  const added = await runGit(["remote", "add", "origin", remote], repoRoot);
  if (added.code !== 0) {
    logger.warn("could not wire the project origin remote", { repoRoot, remote, stderr: added.stderr.trim() });
    return;
  }
  logger.info("wired project origin remote", { repoRoot, remote });
}

const projectRepoEnsures = new Map<string, Promise<void>>();

/**
 * Ensure a ticket's project repo exists at `repoRoot` — v3.1. A ticket builds its OWN repo under
 * `~/Projects/<slug>`, decoupled from Beckett's source. If `<owner>/<slug>` already exists on
 * GitHub (a continuing project, or Beckett's own source when a self-improvement ticket sets
 * `project: beckett`) it is **cloned**; otherwise a fresh repo is `git init`-ed on `main`. The
 * worker then commits in place and (if the ticket calls for it) creates/pushes the GitHub repo via
 * the github skill. Idempotent — a no-op once `repoRoot/.git` exists.
 *
 * BOTH provisioning paths end with a usable `origin` ({@link ensureOriginRemote}): the clone path
 * gets one from git itself, and the init path — taken whenever `<owner>/<slug>` is empty or
 * unreadable on GitHub — is wired explicitly, because a project repo with no remote is a run that
 * silently cannot publish. `remote` is injectable so the real-git tests can point at a local bare
 * repo instead of reaching github.com.
 */
export async function ensureProjectRepo(
  repoRoot: string,
  slug: string,
  owner: string,
  remote: string = projectRemoteUrl(owner, slug),
): Promise<void> {
  const existing = projectRepoEnsures.get(repoRoot);
  if (existing) return existing;

  const ensure = ensureProjectRepoUncached(repoRoot, slug, owner, remote).finally(() => {
    projectRepoEnsures.delete(repoRoot);
  });
  projectRepoEnsures.set(repoRoot, ensure);
  return ensure;
}

async function ensureProjectRepoUncached(
  repoRoot: string,
  slug: string,
  owner: string,
  remote: string,
): Promise<void> {
  if (existsSync(`${repoRoot}/.git`)) {
    await applyRepoIdentity(repoRoot, owner); // re-pin every call — existing checkouts predate this
    await ensureOriginRemote(repoRoot, remote); // repair checkouts an older init path left remote-less
    return;
  }
  const parent = dirname(repoRoot);
  mkdirSync(parent, { recursive: true });

  const onGitHub = (await runGit(["ls-remote", remote, "HEAD"], parent)).code === 0;
  if (onGitHub) {
    await git(["clone", remote, repoRoot], parent);
    await applyRepoIdentity(repoRoot, owner);
    await ensureOriginRemote(repoRoot, remote); // clone sets it; assert it rather than assume it
    logger.info("provisioned project repo by clone", { repoRoot, remote });
    return;
  }

  mkdirSync(repoRoot, { recursive: true });
  await git(["init", "-b", "main"], repoRoot);
  await applyRepoIdentity(repoRoot, owner);
  await ensureOriginRemote(repoRoot, remote);
  logger.info("provisioned new project repo (git init)", { repoRoot, slug, remote });
}
