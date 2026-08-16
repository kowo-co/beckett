/**
 * Beckett — Identity & Agency: the action-class gate + GitHub agency (`src/agency/index.ts`)
 * =======================================================================================
 * Implements the {@link Agency} contract (Spec 07): the single choke point through which
 * every outward action funnels, classified as one of three classes —
 *
 *   - **FREE** — reversible/internal (branch, commit, PR-open/update, comment/review,
 *     email read/label/draft): just do it, log it. The default and the bulk of activity.
 *   - **HANDSHAKE_GATED** — outbound but expected (merge of UNREVIEWED work, email-send):
 *     do all the work up to the irreversible click, stage a {@link PendingAction}, surface
 *     the **delivery handshake** ("PR's up — review or merge?"), and execute only on a `go`.
 *     A merge whose review already passed (`ctx.reviewed`) is FREE — finished work ships.
 *   - **ALWAYS_ASK** — dangerous/irreversible-at-scale (force-push shared, repo/account
 *     admin, permanent delete, publish-at-scale/money): refused on the unattended path.
 *     `deploy` of Beckett's own surfaces is FREE — its safeguards live in the deploy flow
 *     (dirty-tree refusal, ff-only, typecheck, health read-back), not in a permission prompt.
 *
 * `classify()` is **pure and total** — an unknown action type defaults to ALWAYS_ASK
 * (fail-closed, Spec 07 §2.3). This is the security invariant: if it isn't classified FREE
 * or HANDSHAKE_GATED, it cannot happen on the autonomous path.
 *
 * GitHub agency (Spec 07 §3) rides ONE credential for both git transport (`git push` via a
 * credential helper that reads the secret from the *environment*, never argv) and the API (`gh`
 * CLI with `GH_TOKEN`). Since #114 that credential is a **GitHub App installation token**
 * (`src/github/app.ts`) — Beckett acts as `beckett[bot]`, minted fresh per installation and
 * refreshed before expiry; the legacy `GITHUB_PAT` path still works when no app is configured.
 * If NEITHER is configured, GitHub work **degrades gracefully**: branch + diff stay local, and
 * delivery reports {@link PR_PENDING_CREDS_NOTE} — that is correct behavior, not a stub.
 *
 * Gmail is OUT of v0 scope (Spec 12 §3): the taxonomy stays *aware* of `gmail.*` (classify
 * still routes draft→FREE, send→HANDSHAKE_GATED), and the send handshake string exists, but
 * no mail client is implemented here.
 */

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ActionType,
  ActionContext,
  GateActionResult,
  HandshakeSpec,
  PendingAction,
  PendingActionClass,
  GitHubClient,
  OpenPRParams,
  UpdatePRParams,
  ReviewParams,
  MergeStrategy,
  Identity,
  GmailAuth,
  Config,
  Paths,
  Logger,
} from "../types.ts";
import { ActionClass } from "../types.ts";
import type {
  BranchCardCheckSummary,
  GitHubBranchCard,
  GitHubBranchCardReader,
  GitHubPrReader,
  PrMergeability,
  PrSignals,
} from "../github/types.ts";
import type { GitHubActivityCommit, GitHubActivityReader, GitHubMergedPullRequest } from "../github/activity.ts";
import { pendingActionId } from "../ids.ts";
import { log as rootLog } from "../log.ts";
import { childEnv } from "../env.ts";
import { SCAFFOLDING_DIR } from "../worker/worktree.ts";
import { specRunId } from "../run/spec-file.ts";
import { resolveGitHubTarget } from "../github/owner.ts";
import { GitHubAppAuth, loadGitHubAppCredentials } from "../github/app.ts";

// =======================================================================================
// Errors
// =======================================================================================

/**
 * Thrown by {@link BeckettAgency.perform} for an ALWAYS_ASK action on the unattended path
 * (Spec 07 §2.4). There is no `refused` member of {@link GateActionResult} by design — the
 * gate refuses by throwing, fail-closed.
 */
export class GateRefused extends Error {
  constructor(
    readonly actionType: ActionType,
    readonly context: ActionContext,
  ) {
    super(
      `agency: action "${actionType}" is ALWAYS_ASK and cannot be performed unattended ` +
        `(Spec 07 §2.3) — it requires an explicit, specific jawrooo instruction`,
    );
    this.name = "GateRefused";
  }
}

/**
 * Thrown by the GitHub client when NO credential is configured — neither the GitHub App
 * (`GITHUB_APP_ID` + a private key) nor a legacy `GITHUB_PAT`. Callers (DELIVER) catch
 * this and degrade to a local branch + {@link PR_PENDING_CREDS_NOTE} (Spec 07 §3; v0 brief).
 */
export class GitHubUnavailableError extends Error {
  constructor(op: string) {
    super(
      `agency.github: cannot ${op} — no GitHub credentials are configured ` +
        `(set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH for the GitHub App, or a legacy GITHUB_PAT) ` +
        `— work stays local`,
    );
    this.name = "GitHubUnavailableError";
  }
}

// =======================================================================================
// Handshake prompt strings (Spec 07 §3.4 / §4.4; Spec 00 §3 DELIVER)
// =======================================================================================

/** The canonical short merge handshake from Spec 00 §3 DELIVER. */
export const MERGE_HANDSHAKE_SHORT = "PR's up — review or merge?";

/** The canonical send handshake (Gmail is out of v0 scope; kept for taxonomy awareness). */
export const SEND_EMAIL_HANDSHAKE = "drafted it — send as me, or you handle it?";

/**
 * The DELIVER note when GitHub creds are absent: the work is real and on a local branch,
 * the PR just can't be opened yet (Spec 07 §3; v0 brief — this is correct, not a failure).
 */
export const PR_PENDING_CREDS_NOTE =
  "PR pending GitHub creds — the work is committed on a local branch; " +
  "add the GitHub App credentials (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH) to " +
  "~/.beckett/.env and I'll push it and open the PR.";

/** The full, voiced merge handshake line (Spec 07 §3.4). */
export function mergeHandshakePrompt(opts: {
  prNumber: number;
  taskTitle?: string;
  base?: string;
}): string {
  const what = opts.taskTitle ? `I finished ${opts.taskTitle}. ` : "";
  const base = opts.base ?? "main";
  return `${what}PR #${opts.prNumber} is up and green — want to review it yourself, or should I merge to ${base}?`;
}

/**
 * Build the {@link HandshakeSpec} for a merge-to-main delivery handshake. The payload carries
 * everything needed to rehydrate the merge after a restart (Spec 07 §5.3 — no closure state
 * beyond `ctx`/payload).
 */
export function mergeHandshakeSpec(opts: {
  repo: string;
  prNumber: number;
  prUrl?: string;
  strategy?: MergeStrategy;
  taskTitle?: string;
  base?: string;
  expiresAt?: number;
}): HandshakeSpec {
  return {
    actionClass: "merge_pr",
    promptText: mergeHandshakePrompt(opts),
    payload: {
      repo: opts.repo,
      number: opts.prNumber,
      url: opts.prUrl,
      strategy: opts.strategy ?? "squash",
    },
    expiresAt: opts.expiresAt,
  };
}

/** Default handshake window: 24h (Spec 07 §5.4; no dedicated config key in v0 — see report). */
const DEFAULT_HANDSHAKE_MS = 24 * 60 * 60 * 1000;

// =======================================================================================
// classify — the full Spec 07 §2.3 table, pure & total, fail-closed
// =======================================================================================

/** Shared/protected branches force-push is never allowed to rewrite (Spec 07 §3.5). */
const SHARED_BRANCH = [/^main$/, /^master$/, /^release\//, /^develop$/];

/** A ref is "shared" if it matches a protected pattern or is outside Beckett's namespace. */
export function isSharedBranch(ref: string): boolean {
  if (!ref) return true; // unknown ref → treat as shared (fail-closed)
  return SHARED_BRANCH.some((re) => re.test(ref)) || !ref.startsWith("beckett/");
}

/**
 * Classify an action into its {@link ActionClass} (Spec 07 §2.3). Pure and total: every
 * input returns exactly one class, and any unrecognized type defaults to ALWAYS_ASK
 * (fail-closed). Accepts both the frozen-contract action names (`gh.branch.push`, …) and the
 * Spec 07 prose names (`git.branch.push`, `git.commit`, `git.force_push`, `gh.pr.comment`,
 * …) so callers can use either vocabulary.
 */
export function classifyAction(type: ActionType, ctx: ActionContext = {}): ActionClass {
  switch (type) {
    // ── FREE: reversible / internal (the default & the bulk) ──
    case "gh.branch.push":
    case "git.branch.push":
    case "git.commit":
    case "gh.pr.open":
    case "gh.pr.update":
    case "gh.pr.comment":
    case "gh.pr.review":
    case "gmail.read":
    case "gmail.label":
    case "gmail.draft":
    case "fs.write": // in-scope writes (the worker's owned globs)
    case "memory.write":
    case "task.spawn":
    case "model.call":
      return ActionClass.FREE;

    // ── HANDSHAKE_GATED: outbound but the expected finish line ──
    case "gh.pr.merge":
      // A green, reviewed PR is finished work — merging it IS the delivery, not a question
      // (volition doctrine). Unreviewed work keeps the handshake, fail-closed.
      return ctx.reviewed === true ? ActionClass.FREE : ActionClass.HANDSHAKE_GATED;
    case "gmail.send":
      return ActionClass.HANDSHAKE_GATED; // internal OR external (Spec 07 §4.4)

    // ── conditional: depends on the ref / merged-state (Spec 07 §2.3) ──
    case "git.force_push":
    case "gh.force_push":
      // Rewriting shared history is never unattended; own beckett/* branch is gated.
      return isSharedBranch(String(ctx.ref ?? "")) ? ActionClass.ALWAYS_ASK : ActionClass.HANDSHAKE_GATED;
    case "gh.branch.delete":
      // Deleting a merged branch is tidy-up (FREE); unmerged work needs a confirm.
      return ctx.merged === true ? ActionClass.FREE : ActionClass.HANDSHAKE_GATED;

    // ── FREE: deploying Beckett's own surfaces. The safeguards live in the deploy flow
    // itself (refuses a dirty tree, ff-only, typecheck gate, health read-back, revertable
    // via git revert + redeploy) — not in a permission prompt. Volition doctrine: finished
    // work that only matters live gets deployed, not parked awaiting a "go".
    case "deploy":
      return ActionClass.FREE;

    // ── ALWAYS_ASK: dangerous / out of remit / irreversible at scale ──
    case "gh.repo.admin":
    case "gh.branch_protection.edit":
    case "gmail.delete":
    case "gmail.account.settings":
    case "fs.write_outside_scope":
    case "publish": // making something public at scale (npm et al) — not the same as a zone deploy
    case "money":
      return ActionClass.ALWAYS_ASK;

    // ── fail-closed: unknown action types are never run unattended ──
    default:
      return ActionClass.ALWAYS_ASK;
  }
}

/** Map an action type to the persisted {@link PendingActionClass} (Spec 09 §2.11 CHECK set). */
function pendingClassFor(type: ActionType): PendingActionClass {
  switch (type) {
    case "gh.pr.merge":
      return "merge_pr";
    case "gmail.send":
      return "send_email";
    case "git.force_push":
    case "gh.force_push":
      return "force_push";
    default:
      return "other";
  }
}

// =======================================================================================
// subprocess helper — stdin always closed; forbidden API keys always stripped
// =======================================================================================

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A streaming subprocess handle — just the exit promise. The `gh` passthrough ({@link GitHubCli.raw})
 * INHERITS this process's stdio instead of capturing it (so gh's output streams live to the user), so
 * the only thing it reads back is the exit code. Kept minimal + injectable so tests can assert argv/env
 * without a real gh.
 */
interface StreamingChild {
  exited: Promise<number>;
}

/** GitHub creates a fork asynchronously — poll this many times before pushing to it. */
const FORK_READY_TRIES = 10;
/** Delay between fork-readiness polls. */
const FORK_READY_DELAY_MS = 1500;

/** Sleep helper for fork-readiness polling (real timers; publish runs off the hot path). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse `owner/repo` out of a git remote URL — https (`https://github.com/o/r.git`), ssh
 * (`git@github.com:o/r.git`), or a bare `o/r`. Returns null if it doesn't look like a GitHub repo.
 */
export function parseRepoNwo(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  const m =
    cleaned.match(/[:/]([^/:]+\/[^/:]+)$/) ?? // https or ssh: capture the trailing owner/repo
    cleaned.match(/^([^/:]+\/[^/:]+)$/); // already a bare owner/repo
  const nwo = m?.[1];
  if (!nwo) return null;
  return /^[^/]+\/[^/]+$/.test(nwo) ? nwo : null;
}

/** Which issues the list verb asks for (GitHub's own `state` filter). */
export type IssueState = "open" | "closed" | "all";

/**
 * Validate `owner/name` and hand back the normalized slug for a REST path — the same shape check
 * {@link GitHubCli.setRepoStar} makes, so `beckett gh issue create ./typo` is refused locally
 * rather than turned into a request for a repo nobody owns.
 */
function splitRepo(repo: string): string {
  const match = repo
    .trim()
    .match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/);
  if (!match) throw new Error("repo must be in owner/name form");
  return `${match[1]}/${match[2]}`;
}

/** GitHub's own `message` for a failed response, falling back to the body then the status text. */
async function githubErrorMessage(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).trim();
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body?.message === "string" && body.message) return body.message;
  } catch {
    /* non-JSON error body — fall through to the raw text */
  }
  return text || res.statusText || "unknown error";
}

/** A copy of `process.env` with API-auth/endpoint overrides removed (src/env.ts). */
function sanitizedEnv(): Record<string, string | undefined> {
  return childEnv();
}

/** Run a subprocess to completion with stdin closed. Captures stdout/stderr (Spec 07 §3.6). */
async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: (opts.env ?? sanitizedEnv()) as Record<string, string>,
    stdin: "ignore", // never let git/gh block on a prompt
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// =======================================================================================
// GitHubClient — gh CLI for PR/review ops, plain git for transport (Spec 07 §3.2/§3.6)
// =======================================================================================

export interface GitHubClientOptions {
  /** The PAT (env GITHUB_PAT). Empty string = unavailable → methods throw gracefully. */
  pat: string;
  /**
   * GitHub App auth (the identity since #114 — `kowo-co/beckett[bot]`). When present it WINS over
   * `pat`: every op resolves the installation covering its target repo/owner and mints a fresh
   * one-hour installation token (cached, auto-refreshed). Absent → the legacy PAT path, unchanged.
   */
  app?: GitHubAppAuth;
  /** GitHub login the commits/PRs are attributed to (Identity.github.account). */
  account: string;
  /** Account or organization that owns managed project repos. Defaults to `account`. */
  owner?: string;
  /** API base (https://api.github.com or a GHE base). */
  apiBase: string;
  /** Resolve a repo "org/name" to its local working dir (for `git push`). */
  resolveRepoDir: (repo: string) => string;
  logger: Logger;
  /** Subprocess runner — injectable so the publish decision tree is unit-testable (defaults to the
   *  real {@link run}). Tests pass a fake that matches on argv and returns canned `gh`/`git` output. */
  run?: (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => Promise<RunResult>;
  /** Injectable STREAMING spawner for the `gh` passthrough ({@link GitHubCli.raw}) — defaults to a
   *  stdio-inheriting Bun.spawn. Separate from `run` because the passthrough streams stdout/stderr
   *  (never captures) and only reads the exit code. Tests inject a fake to assert argv/env/cwd. */
  spawn?: (cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }) => StreamingChild;
  /** Injectable authenticated REST transport (defaults to the global fetch). */
  fetchImpl?: typeof fetch;
}

/** The outcome of {@link GitHubCli.ensurePublished} — carries HOW the work shipped so callers can
 *  word "done" honestly: `pushed` = landed on the repo's default branch; `pr` = a PR is open and
 *  still needs a human merge (a cloned upstream, or an existing shared repo). */
export interface PublishResult {
  nameWithOwner: string;
  url: string;
  /** `pushed` → merged to the default branch; `pr` → PR opened, awaiting a human merge. */
  kind: "pushed" | "pr";
  /** The PR's web URL when `kind === "pr"` (the thing a human reviews/merges). */
  prUrl?: string;
}

/** What `beckett gh issue create` sends — a title, an (optionally long, markdown) body, labels. */
export interface IssueCreateParams {
  title: string;
  body?: string;
  labels?: string[];
}

/** One issue as the list verb reports it (pull requests are filtered out — they are not issues). */
export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
}

/** The result of opening an issue — the two things a caller actually needs back. */
export interface CreatedIssue {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
}

/** The result of commenting on an issue. */
export interface IssueCommentResult {
  repo: string;
  number: number;
  commentId: number;
  url: string;
}

/**
 * Beckett's GitHub agency surface (Spec 07 §3). The PR/review ops shell out to the
 * `gh` CLI with `GH_TOKEN` set per-invocation (stateless, single credential — Spec 07 §3.2);
 * the star and issue ops call the REST API directly with the same resolved credential (no
 * subprocess: the token is already in hand, and a long markdown body never belongs in argv);
 * `git push` uses plain git with a credential helper that reads the PAT from the *environment*
 * (`$GITHUB_PAT`) so the token never appears in argv. Most ops are FREE; the caller GATES
 * `mergePR` behind {@link Agency.perform}.
 */
export class GitHubCli implements GitHubClient, GitHubPrReader, GitHubBranchCardReader, GitHubActivityReader {
  /** Paths the harness authors that must never reach a remote. */
  private static readonly HARNESS_PATHS: readonly string[] = [SCAFFOLDING_DIR, "spec.md"];

  private readonly runner: (
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined> },
  ) => Promise<RunResult>;
  private readonly spawner: (
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string | undefined> },
  ) => StreamingChild;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GitHubClientOptions) {
    this.runner = opts.run ?? run;
    this.spawner =
      opts.spawn ??
      ((cmd, o) =>
        Bun.spawn(cmd, {
          cwd: o.cwd,
          env: (o.env ?? sanitizedEnv()) as Record<string, string>,
          // STREAM, don't capture: gh's output goes straight to the user's terminal and its
          // exit code is propagated. stdin is inherited so a piped body reaches gh verbatim.
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }));
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Whether GitHub agency is usable (a GitHub App or a PAT is configured). */
  get available(): boolean {
    return this.opts.app !== undefined || this.opts.pat.length > 0;
  }

  /**
   * The credential every `gh`/`git` subprocess rides. With the App this is a fresh installation
   * token (the git username MUST be `x-access-token` — installation tokens are rejected under any
   * other username); with a PAT it is the PAT under Beckett's login. Refreshed by
   * {@link ensureCreds} at the top of each operation, so a long-running daemon never hands a
   * subprocess an expired token.
   */
  private resolved: {
    token: string;
    username: string;
    /**
     * The permissions the minted installation token actually carries (App auth only — a PAT
     * reports none). Kept so a write can refuse with "the installation lacks Issues: Write"
     * BEFORE GitHub answers with an opaque 403 "Resource not accessible by integration".
     */
    permissions?: Record<string, string>;
  } | null = null;

  /**
   * Availability check + token resolution in one. `target` (a repo, or an owner) selects WHICH
   * installation to mint for — the app can be installed on many accounts, and using the wrong
   * installation's token is how an agent ends up reaching into a stranger's repo.
   * Throws {@link GitHubUnavailableError} when nothing is configured (never a silent no-op), and
   * the underlying `GitHubAppApiError` — install link included — when no installation covers the
   * target.
   */
  private async ensureCreds(op: string, target?: { repo?: string; owner?: string }): Promise<void> {
    if (!this.available) throw new GitHubUnavailableError(op);
    if (this.opts.app) {
      const scope = target ?? { owner: this.publishingOwner() };
      const minted = await this.opts.app.token(scope);
      this.resolved = { token: minted.token, username: "x-access-token", permissions: minted.permissions };
      return;
    }
    this.resolved = { token: this.opts.pat, username: this.opts.account };
  }

  /** The token/username resolved by {@link ensureCreds} (falls back to the PAT for pure reads). */
  private get credential(): { token: string; username: string } {
    if (this.resolved) return this.resolved;
    if (this.opts.pat) return { token: this.opts.pat, username: this.opts.account };
    // App-configured but nothing resolved yet: the caller reached a subprocess without going
    // through ensureCreds. Fail loudly rather than shipping an empty token to `git`/`gh`.
    throw new GitHubUnavailableError("authenticate (no installation token resolved)");
  }

  /** Managed project-repository destination; authentication still uses `account`. */
  private publishingOwner(): string {
    return this.opts.owner?.trim() || this.opts.account;
  }

  /** The git host derived from the API base (github.com for the public API). */
  private gitHost(): string {
    return this.opts.apiBase.includes("api.github.com")
      ? "https://github.com"
      : this.opts.apiBase.replace(/\/api\/v3\/?$/, "").replace(/\/$/, "");
  }

  /** Env for `gh`: GH_TOKEN/GITHUB_TOKEN carry the token; forbidden keys stripped. */
  private ghEnv(): Record<string, string | undefined> {
    const { token } = this.credential;
    return { ...sanitizedEnv(), GH_TOKEN: token, GITHUB_TOKEN: token };
  }

  /**
   * Env for `git`: an inline credential helper that echoes the username + `$GITHUB_PAT`.
   * Configured via GIT_CONFIG_* so the secret stays in the environment, never in argv or
   * `~/.git-credentials` (Spec 07 §3.2). The first (empty) helper clears any inherited one.
   *
   * `GITHUB_PAT` is the *carrier slot*, not a claim about which credential is in it: under App
   * auth it holds the short-lived installation token and the username is `x-access-token` (the
   * only username GitHub accepts for an installation token over HTTPS).
   */
  private gitEnv(): Record<string, string | undefined> {
    const { token, username } = this.credential;
    return {
      ...sanitizedEnv(),
      GITHUB_PAT: token,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: `!f() { echo username=${username}; echo "password=$GITHUB_PAT"; }; f`,
    };
  }

  /**
   * Env for the `gh` passthrough ({@link raw}): {@link gitEnv} (the inline credential helper, so gh
   * subcommands that shell out to git — clone/checkout/sync — authenticate) with GH_TOKEN/GITHUB_TOKEN
   * layered on top (so gh's own API calls authenticate). The gh keys are layered EXPLICITLY rather than
   * spreading {@link ghEnv} — ghEnv re-spreads {@link sanitizedEnv}, which would re-introduce (and win
   * over) any ambient GH_TOKEN/GITHUB_PAT from the host, so the injected PAT must be applied last to
   * always win. Every key carries the PAT through the environment only — never argv, never
   * `~/.git-credentials` — so the passthrough opens the full gh surface without widening where the
   * token can leak.
   */
  private rawEnv(): Record<string, string | undefined> {
    const { token } = this.credential;
    return { ...this.gitEnv(), GH_TOKEN: token, GITHUB_TOKEN: token };
  }

  /**
   * Belt-and-suspenders before any push (OPS-61): Beckett's internal harness state — `.beckett/`
   * (the done-signal schema, scope-guard settings, worker state) and a run-stamped root `spec.md`
   * (the legacy pre-v7 location, `../run/spec-file.ts`'s `SPEC_FILE_REL` moved it under `.beckett/`)
   * — must never reach a remote or a PR diff. `.beckett/` is excluded + hook-stripped at the commit
   * boundary, but if a prior code path somehow committed either path we strip it here with a
   * cleanup commit so the pushed branch is clean. A tracked `spec.md` with NO run stamp is left
   * alone — it may be the customer's own file, never ours to delete. Almost always a no-op. Uses
   * `this.runner` so an injected fake keeps unit tests off real git. Was `stripTrackedScaffolding`
   * (`.beckett/`-only); generalized to cover the legacy spec.md path too.
   */
  private async stripHarnessState(cwd: string): Promise<void> {
    const tracked = await this.runner(["git", "ls-files", "--", ...GitHubCli.HARNESS_PATHS], { cwd, env: this.gitEnv() });
    if (tracked.code !== 0) return;
    const paths = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const toStrip = new Set<string>();
    for (const path of paths) {
      if (path === "spec.md") {
        // Only a run-stamped spec.md is ours to strip — an unstamped/customer-authored one is not.
        // Read the INDEX blob (`:path`), not HEAD:path — `ls-files` reports the index, and a
        // staged-but-uncommitted spec.md would otherwise fail `HEAD:path` and slip through unstripped.
        const content = await this.runner(["git", "show", `:${path}`], { cwd, env: this.gitEnv() });
        if (content.code === 0 && specRunId(content.stdout) !== undefined) toStrip.add(path);
      } else {
        toStrip.add(SCAFFOLDING_DIR);
      }
    }
    if (toStrip.size === 0) return; // nothing tracked that's ours to strip → clean already
    this.opts.logger.warn("harness state was tracked in the branch — stripping before push", { cwd, paths: [...toStrip] });
    const rm = await this.runner(["git", "rm", "-r", "--cached", "--quiet", "--", ...toStrip], { cwd, env: this.gitEnv() });
    if (rm.code !== 0) {
      throw new Error(`refusing to push: could not strip ${[...toStrip].join(", ")} (${rm.code}): ${rm.stderr.trim()}`);
    }
    const commit = await this.runner(
      ["git", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "beckett: strip internal harness state"],
      { cwd, env: this.gitEnv() },
    );
    if (commit.code !== 0) {
      throw new Error(`refusing to push: could not commit harness-state strip (${commit.code}): ${commit.stderr.trim()}`);
    }
  }

  /**
   * Throw if any harness path ({@link GitHubCli.HARNESS_PATHS}) is still tracked after
   * {@link stripHarnessState} ran. Publish-path only — called from `ensurePublished`, never from
   * {@link gitPush} (the release lane's `beckett gh push --branch main` must keep working
   * unconditionally). `"needs a human"` in the message makes `classifyPublishError` treat this as
   * permanent — deliberate: a strip that didn't take is a bug, not something a retry will fix.
   */
  private async assertNoHarnessState(cwd: string): Promise<void> {
    const tracked = await this.runner(["git", "ls-files", "--", ...GitHubCli.HARNESS_PATHS], { cwd, env: this.gitEnv() });
    if (tracked.code !== 0) return;
    const paths = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const offending: string[] = [];
    for (const path of paths) {
      if (path === "spec.md") {
        // Same index-vs-HEAD reasoning as stripHarnessState above.
        const content = await this.runner(["git", "show", `:${path}`], { cwd, env: this.gitEnv() });
        if (content.code === 0 && specRunId(content.stdout) !== undefined) offending.push(path);
      } else {
        offending.push(path);
      }
    }
    if (offending.length === 0) return;
    throw new Error(`refusing to publish: harness state is still tracked (${offending.join(", ")}) — needs a human`);
  }

  /**
   * Authenticated `git push <repo-url> <localRef>:refs/heads/<remoteBranch>` from an explicit working
   * dir. The publish flow pushes the SAME checkout to different remotes (a fork for a cross-fork PR),
   * so the cwd is passed in rather than derived from `resolveRepoDir` (which would guess the wrong dir
   * for a fork). Low-level: callers gate FREE-ness. Strips any accidentally-tracked internal
   * scaffolding first (OPS-61), so neither a direct branch push nor a cross-fork PR push can leak
   * `.beckett/` — a checked-out `HEAD`/branch ref can be cleaned; a bare sha can't, so it's skipped.
   */
  private async gitPush(
    cwd: string,
    repo: string,
    localRef: string,
    remoteBranch: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    // Re-resolve for THIS remote: the publish flow pushes the same checkout to a fork and an
    // upstream, which under App auth are two different installations (and two different tokens).
    await this.ensureCreds("push branch", { repo });
    if (localRef === "HEAD" || !/^[0-9a-f]{7,40}$/i.test(localRef)) await this.stripHarnessState(cwd);
    const url = `${this.gitHost()}/${repo}.git`;
    const r = await this.runner(
      ["git", "push", ...(opts?.force ? ["--force"] : []), url, `${localRef}:refs/heads/${remoteBranch}`],
      { cwd, env: this.gitEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`git push failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("branch pushed", { repo, remoteBranch });
  }

  /**
   * Push a local ref to a remote branch over authenticated HTTPS (Spec 07 §3.3). FREE caller.
   *
   * `force` is deliberately opt-in and narrow: it exists for MACHINE-OWNED, single-purpose branches
   * this process is the sole author of — the deploy's `release-bump-vX.Y.Z`, which a re-run rebuilds
   * from scratch (same content, new sha) and could otherwise never re-push (`non-fast-forward`),
   * wedging every retry. It is not exposed on `beckett gh push`; only `beckett gh land --force`
   * reaches it. Never point it at a branch a human is also pushing to.
   */
  async pushBranch(repo: string, localRef: string, remoteBranch: string, opts?: { force?: boolean }): Promise<void> {
    await this.ensureCreds("push branch", { repo });
    await this.gitPush(this.opts.resolveRepoDir(repo), repo, localRef, remoteBranch, opts);
  }

  /**
   * Prove a usable credential exists for `repo` WITHOUT writing anything — the fail-fast preflight
   * `deploy/deploy-prod.sh` runs before it commits a version bump it would then be unable to land.
   * Under App auth this actually mints the installation token for the target (so "the app isn't
   * installed here" surfaces as its own named error, install link included) rather than merely
   * checking that an app id is configured. The token itself is never returned or printed.
   */
  async verifyCredential(repo?: string): Promise<{
    mode: "app" | "pat";
    /** The git username the token rides under (`x-access-token` for an installation token). */
    username: string;
    account: string;
    repo?: string;
  }> {
    await this.ensureCreds("verify the GitHub credential", repo ? { repo } : undefined);
    return {
      mode: this.opts.app ? "app" : "pat",
      username: this.credential.username,
      account: this.opts.account,
      ...(repo ? { repo } : {}),
    };
  }

  /**
   * Push a local tag to `refs/tags/<tag>` on the remote — the release-tag path (v6.0.4). {@link gitPush}
   * hardcodes `refs/heads/*` as the destination, so a tag was structurally impossible through
   * {@link pushBranch}; this pushes the tag ref explicitly (`refs/tags/<tag>:refs/tags/<tag>`) so a tag
   * lands as a tag, not a same-named branch. Same credential helper as every transport op (PAT in the
   * environment, never argv). No scaffolding strip: a tag ref is immutable and points at an existing
   * commit — there is nothing to rewrite. FREE caller.
   */
  async pushTag(repo: string, tag: string): Promise<void> {
    await this.ensureCreds("push tag", { repo });
    const name = tag.replace(/^refs\/tags\//, "").trim();
    if (!name) throw new Error("push tag: a tag name is required");
    const cwd = this.opts.resolveRepoDir(repo);
    const url = `${this.gitHost()}/${repo}.git`;
    const r = await this.runner(["git", "push", url, `refs/tags/${name}:refs/tags/${name}`], {
      cwd,
      env: this.gitEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`git push (tag ${name}) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("tag pushed", { repo, tag: name });
  }

  /**
   * Passthrough to the real `gh` binary (Spec 07 §3.2): run it VERBATIM with the PAT injected via
   * {@link rawEnv}, inheriting this process's stdio so stdout/stderr stream live, and return gh's exit
   * code for the caller to propagate. The token never touches argv. This is the escape hatch for the
   * full gh surface the curated verbs don't cover — and, like every op here, it means gh never needs
   * `gh auth login`/`gh auth status`. FREE caller (the passthrough carries no agency gate; the CLI is
   * the sanctioned entrypoint).
   */
  async raw(args: string[], cwd?: string): Promise<number> {
    await this.ensureCreds("run gh");
    const child = this.spawner(["gh", ...args], { cwd, env: this.rawEnv() });
    return await child.exited;
  }

  /**
   * Create a repo under Beckett's account (Spec 07 §3.3). New repos are reversible (deletable)
   * and within remit, so this is a FREE op — Beckett spins up project repos on its own. With
   * `sourceDir` (+ `push`) it wires the local dir as `origin` and pushes the initial commits in
   * one shot. Token rides `GH_TOKEN` per-invocation, so `gh` never needs `gh auth login/status`.
   */
  async createRepo(p: {
    name: string; // "name" (under the account) or "owner/name"
    private?: boolean; // default true
    description?: string;
    sourceDir?: string; // an existing git repo to wire as origin
    push?: boolean; // push sourceDir's commits after creating
  }): Promise<{ nameWithOwner: string; url: string }> {
    await this.ensureCreds("create repo", {
      owner: p.name.includes("/") ? p.name.split("/")[0]! : this.publishingOwner(),
    });
    const args = ["gh", "repo", "create", p.name, p.private === false ? "--public" : "--private"];
    if (p.description) args.push("--description", p.description);
    if (p.sourceDir) {
      args.push("--source", p.sourceDir, "--remote", "origin");
      if (p.push) args.push("--push");
    }
    const r = await this.runner(args, { cwd: p.sourceDir, env: this.ghEnv() });
    if (r.code !== 0) {
      throw new Error(`gh repo create failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const url = (r.stdout.match(/https?:\/\/\S+/) ?? [
      `${this.gitHost()}/${p.name.includes("/") ? p.name : `${this.opts.account}/${p.name}`}`,
    ])[0].trim();
    // Trust the URL gh printed for the real owner/name (the token's account may differ from config).
    const owned = url.match(/[^/]+\/[^/]+$/);
    const nameWithOwner = owned ? owned[0].replace(/\.git$/, "") : p.name;
    this.opts.logger.info("repo created", { repo: nameWithOwner, url });
    return { nameWithOwner, url };
  }

  /**
   * Star or unstar an explicitly named GitHub repository through the authenticated REST API.
   * This intentionally uses the same PAT as the rest of this client, rather than depending on
   * a separately logged-in `gh` installation.
   */
  async setRepoStar(repo: string, starred: boolean): Promise<void> {
    // Starring is a USER action: an installation token gets 403 "Resource not accessible by
    // integration" here. Resolve the home installation anyway so the failure is GitHub's honest one.
    await this.ensureCreds(starred ? "star repo" : "unstar repo");
    const match = repo.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/);
    if (!match) throw new Error("repo must be in owner/name form");
    const owner = match[1]!;
    const name = match[2]!;
    const apiBase = this.opts.apiBase.replace(/\/$/, "");
    const url = `${apiBase}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const response = await this.fetchImpl(url, {
      method: starred ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bearer ${this.credential.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (response.status !== 204) {
      const detail = (await response.text()).trim();
      throw new Error(`GitHub ${starred ? "star" : "unstar"} repo failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    this.opts.logger.info(starred ? "repo starred" : "repo unstarred", { repo });
  }

  /** Whether `owner/name` (or `name` under the account) already exists on GitHub. FREE: a read. */
  async repoExists(nameWithOwner: string): Promise<boolean> {
    if (!this.available) return false;
    const repo = nameWithOwner.includes("/") ? nameWithOwner : `${this.opts.account}/${nameWithOwner}`;
    // A read, but still credentialed: under App auth an unresolved token is a throw, and a repo
    // no installation covers is honestly "I can't see it" — which `gh repo view` reports as false.
    try {
      await this.ensureCreds("check repo exists", { repo });
    } catch {
      return false;
    }
    const r = await this.runner(["gh", "repo", "view", repo, "--json", "name"], { env: this.ghEnv() });
    return r.code === 0;
  }

  /**
   * Whether `branch` exists on `repo` RIGHT NOW. The one signal that separates "this work is
   * already merged" from "the base branch does not exist yet" — a brand-new repo with no commits
   * has no `main`, and GitHub answers a PR against it with the same `No commits between …` text it
   * uses for genuinely-landed work. `beckett finish` asks this BEFORE opening a PR so it can do the
   * first push instead of reporting a confident wrong diagnosis (2026-08-14, `kowo-co/babble`).
   *
   * A 404 (no such branch, or an empty repo with no branches at all) is `false`; any other failure
   * is also `false` — the caller treats "cannot confirm the base exists" the same as "it doesn't"
   * only when it is about to CREATE it, which is a first push either way. FREE: a read.
   */
  async branchExists(repo: string, branch: string): Promise<boolean> {
    await this.ensureCreds("read a branch", { repo });
    const r = await this.runner(["gh", "api", `repos/${repo}/branches/${branch}`, "--jq", ".name"], {
      env: this.ghEnv(),
    });
    return r.code === 0 && r.stdout.trim() === branch;
  }

  /**
   * Make a repo publicly visible (idempotent — a no-op if it's already public). Project repos are
   * public so the links Beckett hands out resolve; this self-heals repos an older code path left
   * private (the cause of the `<owner>/<slug>` 404s). Uses the REST `private=false` field, which
   * is stable across `gh` versions (the `repo edit --visibility` flag is not). FREE: a metadata edit.
   */
  async setPublic(nameWithOwner: string): Promise<void> {
    const repo = nameWithOwner.includes("/") ? nameWithOwner : `${this.opts.account}/${nameWithOwner}`;
    await this.ensureCreds("set repo visibility", { repo });
    const r = await this.runner(["gh", "api", "--method", "PATCH", `repos/${repo}`, "-F", "private=false"], {
      env: this.ghEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`gh api set-public failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /**
   * Idempotently publish a done ticket's checkout to GitHub, returning HOW it shipped (a
   * {@link PublishResult}). Three cases, each detect-and-continue so a re-run never throws on
   * "already exists" (the original bug: `gh repo create` blew up because the cloned checkout already
   * had an `origin`, and the ticket had already been marked done, so the work silently never shipped):
   *
   *   1. **Origin outside our account/managed owner** — the head repo and push target come from
   *      `origin`, never a hardcoded `<owner>/<slug>`. If we're a collaborator (write access) we
   *      push the ticket branch straight to origin and open a plain in-repo PR; otherwise we fork
   *      the upstream, push to the fork, and open a cross-fork PR. Merging is a human call → `kind: "pr"`.
   *   2. **A repo we already own** (a continuing/shared project, e.g. the beckett self-repo) → push a
   *      ticket branch and open a PR against its default branch. NEVER `HEAD→main` (that's the
   *      non-fast-forward "fetch first" reject that stranded shared-repo tickets) → `kind: "pr"`.
   *   3. **Brand-new project we own** → create it from `sourceDir` and push `HEAD→main` in one shot →
   *      `kind: "pushed"`.
   */
  async ensurePublished(p: {
    slug: string;
    sourceDir: string;
    description?: string;
    /** Ticket identifier — names the PR branch (`beckett/<ticket>`) + the PR body. Defaults to slug. */
    ticket?: string;
    /**
     * Non-main integration/target branch to publish onto (e.g. `v5-daemon`). When set to a branch
     * other than `main`, an owned-repo publish (Case 2) ships to THIS branch and NEVER touches the
     * repo's default branch (`main`): no fetch, no rebase, no push against it. Absent (or `main`) ⇒
     * publish to the repo default exactly as before, so a normal ticket is byte-for-byte unchanged
     * (OPS-185).
     */
    targetBranch?: string;
    /** Original worker base, captured when its worktree was created. Used only to recover from a
     * rebase that tries to replay a predecessor which has since squash-landed. */
    baseSha?: string;
    /** The worker's completion summary; used as the single squash-apply commit subject. */
    commitMessage?: string;
  }): Promise<PublishResult> {
    await this.ensureCreds("publish repo");
    // Clean the source tree once up front (OPS-61) so NO publish path — including the brand-new-repo
    // `gh repo create --push`, which bypasses gitPush — can leak Beckett's internal harness state.
    // Then assert it actually took: a strip that silently failed to remove a tracked harness path
    // must never publish quietly (publish-path only — never called from gitPush).
    await this.stripHarnessState(p.sourceDir);
    await this.assertNoHarnessState(p.sourceDir);
    const ref = (p.ticket ?? p.slug).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const branch = `beckett/${ref}`;
    const title = p.description?.trim() || `beckett: ${p.slug}`;
    const body =
      `Automated contribution by Beckett${p.ticket ? ` for ${p.ticket}` : ""}.` +
      (p.description ? `\n\n${p.description}` : "");

    // Case 1 — origin points to a repo outside our own account/managed owner. The head repo and
    // push target are read from THAT origin, never a hardcoded `<owner>/<slug>` — the assumption
    // that stranded #12 (origin was a third-party upstream, but publish tried to open a cross-fork
    // PR from a stale fork that was never pushed). Two sub-shapes, distinguished by whether we can push:
    //   1a — we're a collaborator on origin (write access): push the branch STRAIGHT to origin and
    //        open a plain in-repo PR (base = origin's default branch, head = branch). No fork.
    //   1b — a genuine third-party upstream we can only read: fork it, push the branch to our fork,
    //        and open a cross-fork PR (head `<account>:branch`) against the upstream — as before.
    const foreignOrigin = await this.originUpstream(p.sourceDir);
    if (foreignOrigin) {
      if (await this.canPush(foreignOrigin)) {
        // 1a — collaborator on origin: push there and open an in-repo PR. A retry after a lost
        // response reuses the branch's already-open PR (publish-outbox idempotency).
        const existing = await this.findOpenPR(foreignOrigin, branch);
        if (existing) {
          this.opts.logger.info("reused existing in-repo PR", { repo: foreignOrigin, branch, pr: existing.url });
          return { nameWithOwner: foreignOrigin, url: `${this.gitHost()}/${foreignOrigin}`, kind: "pr", prUrl: existing.url };
        }
        await this.gitPush(p.sourceDir, foreignOrigin, "HEAD", branch);
        const base = await this.defaultBranch(foreignOrigin);
        const pr = await this.ensurePR({ repo: foreignOrigin, base, head: branch, title, body });
        this.opts.logger.info("published via in-repo PR", { repo: foreignOrigin, branch, pr: pr.url });
        return { nameWithOwner: foreignOrigin, url: `${this.gitHost()}/${foreignOrigin}`, kind: "pr", prUrl: pr.url };
      }
      // 1b — cloned third-party upstream: fork → push branch to fork → cross-fork PR to upstream.
      // A retry after a lost response must not even start the create path: look for the ticket
      // branch's open PR before forking/pushing/opening. This is the publish-outbox idempotency
      // boundary (and avoids cross-fork PAT churn once a PR already exists).
      const existing = await this.findOpenPR(foreignOrigin, `${this.opts.account}:${branch}`);
      if (existing) {
        this.opts.logger.info("reused existing upstream PR", { upstream: foreignOrigin, branch, pr: existing.url });
        return { nameWithOwner: foreignOrigin, url: `${this.gitHost()}/${foreignOrigin}`, kind: "pr", prUrl: existing.url };
      }
      const fork = await this.ensureFork(foreignOrigin);
      await this.gitPush(p.sourceDir, fork, "HEAD", branch);
      const base = await this.defaultBranch(foreignOrigin);
      const pr = await this.ensurePR({ repo: foreignOrigin, base, head: `${this.opts.account}:${branch}`, title, body });
      this.opts.logger.info("published via upstream PR", { upstream: foreignOrigin, fork, branch, pr: pr.url });
      return { nameWithOwner: foreignOrigin, url: `${this.gitHost()}/${foreignOrigin}`, kind: "pr", prUrl: pr.url };
    }

    const repo = `${this.publishingOwner()}/${p.slug}`;

    // Case 2 — a repo we already own (a continuing project, incl. beckett's own repos): ship straight
    // to its default branch. Integrate the remote tip FIRST (fetch + rebase) so this isn't the
    // non-fast-forward "fetch first" reject that stranded OPS-25/27; keeping the branch current also
    // keeps it visible to DAG dependents that clone fresh. A rebase CONFLICT throws → the dispatcher
    // holds the ticket for a human (never a silent false-done).
    if (await this.repoExists(repo)) {
      await this.setPublicSafe(repo);
      const commitSummary = p.commitMessage ?? title;
      // Finish the commit BEFORE anything leaves the machine: the branch pushed below (durability)
      // must already be the run's single finished commit, not a scratch draft a later squash still
      // has to touch (#261/#246 stay correct under the new push-first order).
      await this.commitStrayWorkingTree(p.sourceDir, commitSummary);
      await this.squashLocalCommits(p.sourceDir, p.baseSha, commitSummary);
      // Resolve + validate the trunk before any network action — refuses outright if the repo's
      // default branch is itself a sibling run's branch (`kowo-co/babble`, 2026-08-14).
      const trunk = await this.resolveTrunk(repo, p.targetBranch);
      // FIRST network action of the publish, unconditional: the run's finished work leaves this
      // machine before the trunk integration that might fail. A publish that dies after this line
      // still has `beckett/<ticket>` durable on GitHub instead of stranded on one disk.
      await this.pushRunBranch(p.sourceDir, repo, branch);
      const sha = await this.pushToBranch(p.sourceDir, repo, trunk.base, p.baseSha, commitSummary);
      this.opts.logger.info("published via push to branch", { repo, branch: trunk.base });
      // #246: `prUrl` is what the Discord publish announcement renders — it must point at something
      // real (the landed commit), never the bare repo root. `url` stays the repo root for callers
      // that want the repo itself (e.g. the task registry's publication link).
      return {
        nameWithOwner: repo,
        url: `${this.gitHost()}/${repo}`,
        kind: "pushed",
        ...(sha ? { prUrl: `${this.gitHost()}/${repo}/commit/${sha}` } : {}),
      };
    }

    // Case 3 — brand-new project we own: create the empty repo, then push the source tree's HEAD to
    // an explicit `main`. Under v3.2 worktrees HEAD rides the ticket's branch (`beckett/<ticket>`),
    // so we must name the remote branch `main` rather than let `gh repo create --push` make the
    // local branch name the repo's default. gitPush also strips any tracked scaffolding first.
    const created = await this.createRepo({
      name: repo,
      private: false, // project repos are public so links Beckett hands out actually resolve
      description: p.description,
    });
    await this.gitPush(p.sourceDir, created.nameWithOwner, "HEAD", "main");
    // Leave a plain (credential-free) origin behind: gitPush authenticates via an ad-hoc URL, so
    // without this the freshly created project has NO origin remote at all — and `beckett finish`
    // resolves its repo from `git remote get-url origin`, failing with "could not work out which
    // GitHub repo …" on the very repos Beckett itself created (beckett-metrics, 2026-08-12).
    try {
      const setUrl = await this.runner(
        ["git", "remote", "set-url", "origin", `${this.gitHost()}/${created.nameWithOwner}.git`],
        { cwd: p.sourceDir },
      );
      if (setUrl.code !== 0) {
        await this.runner(
          ["git", "remote", "add", "origin", `${this.gitHost()}/${created.nameWithOwner}.git`],
          { cwd: p.sourceDir },
        );
      }
    } catch (err) {
      this.opts.logger.warn("could not record origin remote on the new project (publish succeeded)", {
        repo: created.nameWithOwner,
        error: String(err),
      });
    }
    return { ...created, kind: "pushed" };
  }

  /**
   * The explicit non-default branch an owned-repo publish should land on, or `null` to use the repo
   * default. A ticket cast onto an integration branch (e.g. `v5-daemon`) funnels there; an unset
   * value or an explicit `main` both mean "the default branch", so a normal ticket's publish is
   * byte-for-byte unchanged (OPS-185).
   */
  private integrationTarget(targetBranch?: string): string | null {
    const b = targetBranch?.trim();
    if (!b || b.toLowerCase() === "main") return null;
    return b;
  }

  /**
   * The remote trunk an owned-repo publish (case 2) integrates onto, resolved and validated BEFORE
   * any push. `base` is the explicit integration target when the ticket carries one (OPS-185 — the
   * repo default is never even consulted in that case), else the repo's actual default branch.
   *
   * Refuses outright when the resolved base looks like a run's own branch
   * (`beckett/run-<date>-<slug>`): a repo whose GitHub-side default branch has been left pointed at a
   * sibling run's branch turns every subsequent publish into a rebase onto that run's private work
   * instead of trunk (`kowo-co/babble`, 2026-08-14) — a misconfiguration only a human can fix, so this
   * is a permanent failure (`needs a human`), never a retry target.
   */
  private async resolveTrunk(repo: string, targetBranch?: string): Promise<{ base: string; exists: boolean }> {
    const base = this.integrationTarget(targetBranch) ?? (await this.defaultBranch(repo));
    if (/^beckett\/run-/i.test(base)) {
      throw new Error(
        `refusing to publish onto \`${base}\`: that is a run branch, not a trunk — the repo's default ` +
          `branch is misconfigured (fix it on GitHub with \`gh repo edit ${repo} --default-branch main\`) ` +
          `— needs a human`,
      );
    }
    const exists = await this.branchExists(repo, base);
    return { base, exists };
  }

  /**
   * Push the run's OWN branch (`beckett/<ticket>`) to `repo` as a pure durability checkpoint —
   * unconditional, no rebase, no force. This is the FIRST network action of an owned-repo publish
   * (case 2), run before trunk is ever touched: once it lands, the run's finished work exists on
   * GitHub even if the trunk integration that follows fails and the run parks. A repo we cannot push
   * to has nothing else to try, so a failure here propagates as-is.
   */
  private async pushRunBranch(cwd: string, repo: string, branch: string): Promise<void> {
    await this.gitPush(cwd, repo, "HEAD", branch);
    this.opts.logger.info("run branch pushed (durability)", { repo, branch });
  }

  /**
   * Push the checkout's HEAD to a repo we own, on `base`, WITHOUT a non-fast-forward reject: fetch
   * that branch's remote tip and rebase local commits onto it first, then push. `base` is resolved
   * and validated by {@link resolveTrunk} before this is called — a ticket cast onto a non-main
   * integration branch passes ITS resolved base so `main` is never fetched, rebased, or pushed. If
   * the remote branch doesn't exist yet (a just-created/empty repo, or a fresh integration branch)
   * the fetch fails harmlessly and the push creates it. On a rebase conflict, a dependent worker may
   * be carrying a predecessor's pre-squash commits. In that one shape, retry its recorded *own*
   * base..tip delta as one patch over a freshly fetched remote tip; this avoids replaying
   * already-landed checkpoints.
   *
   * The checkout's finished commit — {@link commitStrayWorkingTree} + {@link squashLocalCommits} —
   * is the caller's job now (case 2 runs them once, before the branch push, so the branch pushed for
   * durability is already the finished single commit); this only re-touches history on the conflict
   * fallback below. Returns the pushed commit's sha (for a real, non-root `prUrl`), or `undefined` if
   * it couldn't be determined.
   */
  private async pushToBranch(
    cwd: string,
    repo: string,
    base: string,
    workerBaseSha?: string,
    summary?: string,
  ): Promise<string | undefined> {
    const url = `${this.gitHost()}/${repo}.git`;
    const fetch = await this.runner(["git", "fetch", url, base], { cwd, env: this.gitEnv() });
    if (fetch.code === 0) {
      const rebase = await this.runner(["git", "rebase", "FETCH_HEAD"], { cwd, env: this.gitEnv() });
      if (rebase.code !== 0) {
        await this.runner(["git", "rebase", "--abort"], { cwd, env: this.gitEnv() });
        try {
          if (await this.squashApplyWorkerDelta(cwd, url, base, workerBaseSha, summary)) {
            await this.gitPush(cwd, repo, "HEAD", base);
            return await this.currentSha(cwd);
          }
        } catch (err) {
          // A failed apply reports only the remaining files. Do not bury the useful answer under
          // the original 20-commit rebase transcript.
          throw err;
        }
        throw new Error(
          `publish: local work conflicts with ${repo}@${base} and can't auto-rebase — needs a human ` +
            `(${rebase.stderr.trim() || rebase.stdout.trim()})`,
        );
      }
    }
    await this.gitPush(cwd, repo, "HEAD", base);
    return await this.currentSha(cwd);
  }

  /**
   * Commit whatever is still loose in the publish checkout, BEFORE the squash and the fetch/rebase
   * below. `git rebase` refuses outright on a dirty tree ("cannot rebase: You have unstaged changes.
   * error: additionally, your index contains uncommitted changes."), and that is not a transient
   * fault — it fails identically on every attempt, so a run that hits it burns its retry ladder and
   * parks without ever publishing (2026-08-14). The dirty state is our OWN doing: the run's private
   * worktree holds only its own work, so loose changes are its own, that no stage got around to
   * committing. Committing ships that work; stashing would silently drop it from the very push meant
   * to deliver it, and {@link squashLocalCommits} then folds this commit into the run's single
   * publish commit.
   *
   * ONLY in a run's own worktree ({@link isRunWorktree}), and that gate is the point rather than a
   * formality: `sourceDir` falls back to the SHARED project checkout when a run carries no workspace
   * (`run.workspace ?? resolveRepoRoot(run)`), and loose edits there are a human's in-progress work,
   * not ours to commit and push. Undecidable ⇒ treated as not ours, so the worst case is the old
   * behavior (the rebase reports the dirty tree) rather than shipping someone else's changes.
   *
   * Internal scaffolding is kept OUT of the index (`:(exclude)`) exactly as
   * {@link stripHarnessState} keeps it out of the push — leaving it untracked, which a rebase
   * does not mind. Best-effort throughout: a `git status` we can't read, or an add/commit that
   * fails, leaves the working tree exactly as it was and lets the rebase report the real problem.
   *
   * The ONE state it refuses outright is an unmerged path (a half-finished merge/rebase left in the
   * worktree). "Loose work" means work no stage got around to committing, NOT a file full of
   * conflict markers: `git add -A` stages `<<<<<<<`/`>>>>>>>` verbatim, and the commit below would
   * carry that wreckage to trunk under the run's own summary. That throws a `needs a human` error
   * instead, which `classifyPublishError` calls permanent, so the run parks on attempt 1 naming the
   * conflicted files rather than shipping them.
   */
  private async commitStrayWorkingTree(cwd: string, summary: string | undefined): Promise<void> {
    if (!(await this.isRunWorktree(cwd))) return;
    const status = await this.runner(["git", "status", "--porcelain"], { cwd, env: this.gitEnv() });
    if (status.code !== 0 || status.stdout.trim() === "") return;
    const lines = status.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    // UNMERGED paths are never ours to commit. `git add -A` stages a conflicted file verbatim —
    // `<<<<<<<`/`=======`/`>>>>>>>` markers and all — and the commit below would then push that
    // wreckage straight to trunk under the run's own summary. A half-finished merge is exactly the
    // "belongs to a human immediately" shape item 1 exists to park on, so name the files and stop.
    const conflicted = lines.filter((line) => {
      const [x, y] = [line[0], line[1]];
      return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    }).map((line) => line.slice(3).trim());
    if (conflicted.length > 0) {
      throw new Error(
        `publish: the run's checkout has unresolved merge conflicts and can't be committed or ` +
          `rebased — needs a human (${conflicted.slice(0, 20).join(", ")})`,
      );
    }
    const dirty = lines.map((line) => line.slice(3).trim()).filter(Boolean);
    this.opts.logger.warn("publish checkout was dirty — committing its loose work before the rebase", {
      cwd,
      paths: dirty.slice(0, 20),
    });
    const add = await this.runner(["git", "add", "-A", "--", ".", `:(exclude)${SCAFFOLDING_DIR}`], {
      cwd,
      env: this.gitEnv(),
    });
    if (add.code !== 0) {
      this.opts.logger.warn("could not stage the loose publish work (rebase will report the dirty tree)", {
        cwd,
        stderr: add.stderr.trim(),
      });
      return;
    }
    // Nothing staged ⇒ the only dirt was scaffolding/ignored noise, which never blocks a rebase.
    const staged = await this.runner(["git", "diff", "--cached", "--quiet"], { cwd, env: this.gitEnv() });
    if (staged.code === 0) return;
    const commit = await this.runner(
      ["git", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", summary?.trim() || "beckett: commit loose publish work"],
      { cwd, env: this.gitEnv() },
    );
    if (commit.code !== 0) {
      this.opts.logger.warn("could not commit the loose publish work (rebase will report the dirty tree)", {
        cwd,
        stderr: commit.stderr.trim(),
      });
    }
  }

  /**
   * Is `cwd` a checkout Beckett created for a run, rather than a checkout a human also works in?
   * Run worktrees are made with `git worktree add` ({@link createWorktree}), so their `--git-dir` is
   * `<repo>/.git/worktrees/<name>` while the shared project clone's is the common `<repo>/.git` —
   * the one property that distinguishes them without pattern-matching a path. `--path-format` makes
   * both answers absolute, so this never compares a relative `.git` against an absolute one.
   * Anything unreadable answers false: only a checkout we can PROVE is ours may be auto-committed.
   */
  private async isRunWorktree(cwd: string): Promise<boolean> {
    const gitDir = await this.runner(["git", "rev-parse", "--path-format=absolute", "--git-dir"], { cwd, env: this.gitEnv() });
    const commonDir = await this.runner(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, env: this.gitEnv() });
    if (gitDir.code !== 0 || commonDir.code !== 0) return false;
    const own = gitDir.stdout.trim();
    const common = commonDir.stdout.trim();
    return own !== "" && common !== "" && own !== common;
  }

  /**
   * Collapse `workerBaseSha..HEAD` into a single commit whose message is `summary` (falling back to
   * the run/ticket title callers already pass as `summary` when there's no review write-up) — the
   * squash-on-publish half of #246. Best-effort and silent: an absent/invalid `workerBaseSha`, a base
   * that isn't actually an ancestor of HEAD, or a range that's already a single commit all leave the
   * checkout untouched rather than guess. Runs BEFORE the fetch/rebase below, so the normal path never
   * even sees the raw checkpoint history.
   */
  private async squashLocalCommits(cwd: string, workerBaseSha: string | undefined, summary: string | undefined): Promise<void> {
    if (!workerBaseSha?.trim()) return;
    const tip = await this.runner(["git", "rev-parse", "--verify", "--quiet", "HEAD"], { cwd, env: this.gitEnv() });
    const base = await this.runner(["git", "rev-parse", "--verify", "--quiet", `${workerBaseSha}^{commit}`], { cwd, env: this.gitEnv() });
    if (tip.code !== 0 || base.code !== 0) return;
    const baseSha = base.stdout.trim();
    const tipSha = tip.stdout.trim();
    if (!baseSha || !tipSha || baseSha === tipSha) return;
    // A non-ancestor base makes this a guess, not a squash — never gamble with history.
    const ancestor = await this.runner(["git", "merge-base", "--is-ancestor", baseSha, tipSha], { cwd, env: this.gitEnv() });
    if (ancestor.code !== 0) return;
    const count = await this.runner(["git", "rev-list", "--count", `${baseSha}..${tipSha}`], { cwd, env: this.gitEnv() });
    if (count.code !== 0 || Number(count.stdout.trim() || "0") <= 1) return; // already one commit (or none)
    const reset = await this.runner(["git", "reset", "--soft", baseSha], { cwd, env: this.gitEnv() });
    if (reset.code !== 0) return;
    const commit = await this.runner(
      ["git", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", summary?.trim() || "beckett: squash run checkpoints"],
      { cwd, env: this.gitEnv() },
    );
    if (commit.code !== 0) {
      // Restore the original tip rather than leave the checkout mid-squash with nothing committed.
      await this.runner(["git", "reset", "--hard", tipSha], { cwd, env: this.gitEnv() });
    }
  }

  /** `HEAD`'s sha, or `undefined` if it can't be read — never throws, callers treat it as best-effort. */
  private async currentSha(cwd: string): Promise<string | undefined> {
    const r = await this.runner(["git", "rev-parse", "HEAD"], { cwd, env: this.gitEnv() });
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  }

  /**
   * Apply exactly the worker's recorded base..tip contribution as one commit. False means the
   * metadata is not safe enough to make this transformation, so the caller preserves the old human
   * hold. A conflicting apply throws a deliberately compact residual-conflict error for the courier.
   */
  private async squashApplyWorkerDelta(
    cwd: string,
    url: string,
    remoteBranch: string,
    workerBaseSha: string | undefined,
    summary: string | undefined,
  ): Promise<boolean> {
    if (!workerBaseSha?.trim()) return false;
    const tip = await this.runner(["git", "rev-parse", "--verify", "--quiet", "HEAD"], { cwd, env: this.gitEnv() });
    const base = await this.runner(["git", "rev-parse", "--verify", "--quiet", `${workerBaseSha}^{commit}`], { cwd, env: this.gitEnv() });
    if (tip.code !== 0 || base.code !== 0) return false;
    const baseSha = base.stdout.trim();
    const tipSha = tip.stdout.trim();
    if (!baseSha || !tipSha) return false;

    // A non-ancestor base makes a two-dot diff a tree comparison rather than the worker's history.
    // Never guess in that case.
    const ancestor = await this.runner(["git", "merge-base", "--is-ancestor", baseSha, tipSha], { cwd, env: this.gitEnv() });
    if (ancestor.code !== 0) return false;
    const nonempty = await this.runner(["git", "diff", "--quiet", `${baseSha}..${tipSha}`], { cwd, env: this.gitEnv() });
    if (nonempty.code === 0 || nonempty.code > 1) return false;

    // A deletion must have been made in this exact worker range. This catches a stale/wrong base
    // whose snapshot comparison would otherwise remove a file the worker never changed.
    const deletions = await this.runner(["git", "diff", "--name-status", "--diff-filter=D", `${baseSha}..${tipSha}`], {
      cwd,
      env: this.gitEnv(),
    });
    if (deletions.code !== 0) return false;
    for (const line of deletions.stdout.split(/\r?\n/)) {
      const path = line.split("\t")[1]?.trim();
      if (!path) continue;
      const touched = await this.runner(
        ["git", "log", "--format=%H", "--diff-filter=D", `${baseSha}..${tipSha}`, "--", path],
        { cwd, env: this.gitEnv() },
      );
      if (touched.code !== 0 || !touched.stdout.trim()) return false;
    }

    // Fetch again after aborting the rebase: FETCH_HEAD is the precise landing point for the patch.
    const refreshed = await this.runner(["git", "fetch", url, remoteBranch], { cwd, env: this.gitEnv() });
    if (refreshed.code !== 0) return false;
    const current = await this.runner(["git", "branch", "--show-current"], { cwd, env: this.gitEnv() });
    const landingBranch = `${current.stdout.trim() || "beckett/squash-apply"}-land`;
    const checkout = await this.runner(["git", "checkout", "-B", landingBranch, "FETCH_HEAD"], { cwd, env: this.gitEnv() });
    if (checkout.code !== 0) return false;

    const patchPath = join(tmpdir(), `beckett-squash-apply-${randomUUID()}.patch`);
    try {
      const diff = await this.runner(["git", "diff", "--binary", `${baseSha}..${tipSha}`], { cwd, env: this.gitEnv() });
      if (diff.code !== 0 || !diff.stdout) return false;
      await writeFile(patchPath, diff.stdout);
      const apply = await this.runner(["git", "apply", "--3way", patchPath], { cwd, env: this.gitEnv() });
      if (apply.code !== 0) {
        const conflicts = await this.runner(["git", "diff", "--name-only", "--diff-filter=U"], { cwd, env: this.gitEnv() });
        const files = conflicts.stdout.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
        throw new Error(
          `publish: squash-apply still conflicts with ${remoteBranch}; residual conflicting files: ` +
            `${files.length ? files.join(", ") : "(none reported)"} — needs a human`,
        );
      }
      const commit = await this.runner(
        ["git", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", summary?.trim() || "beckett: squash apply worker delta"],
        { cwd, env: this.gitEnv() },
      );
      if (commit.code !== 0) return false;
      return true;
    } finally {
      await unlink(patchPath).catch(() => {});
    }
  }

  /** `setPublic` that never throws — visibility is cosmetic and must not block shipping the code. */
  private async setPublicSafe(repo: string): Promise<void> {
    try {
      await this.setPublic(repo);
    } catch (err) {
      this.opts.logger.warn("could not make repo public (left as-is)", { repo, err: (err as Error).message });
    }
  }

  /**
   * The upstream `owner/repo` when `sourceDir`'s `origin` points outside both the authenticated
   * account and managed project owner. Null for a fresh repo or either kind of owned checkout.
   */
  private async originUpstream(sourceDir: string): Promise<string | null> {
    const r = await this.runner(["git", "remote", "get-url", "origin"], { cwd: sourceDir });
    if (r.code !== 0) return null; // no origin remote → fresh/owned project
    const nwo = parseRepoNwo(r.stdout.trim());
    if (!nwo) return null;
    const owner = nwo.split("/")[0] ?? "";
    const ownOrigins = new Set([
      this.opts.account.toLowerCase(),
      this.publishingOwner().toLowerCase(),
    ]);
    if (ownOrigins.has(owner.toLowerCase())) return null;
    return nwo;
  }

  /**
   * Whether the authenticated account has write access to `repo` — the signal that decides how a
   * third-party origin publishes: with push access we're a collaborator and open a plain in-repo PR
   * (Case 1a); without it we can only fork and open a cross-fork PR (Case 1b). `viewerPermission`
   * is `ADMIN`/`MAINTAIN`/`WRITE`/`TRIAGE`/`READ`; anything below WRITE — or an unqueryable repo —
   * means "can't push". FREE: a metadata read.
   */
  private async canPush(repo: string): Promise<boolean> {
    const r = await this.runner(
      ["gh", "repo", "view", repo, "--json", "viewerPermission", "-q", ".viewerPermission"],
      { env: this.ghEnv() },
    );
    if (r.code !== 0) return false;
    return /^(ADMIN|MAINTAIN|WRITE)$/i.test(r.stdout.trim());
  }

  /**
   * A repo's default branch (`main`/`master`/…) via the API; falls back to `main` if unknown.
   *
   * An EMPTY repo — one that exists with no commits — has NO default branch, and `gh -q` prints the
   * literal string `null` for that (jq indexing a null object), exit code 0. Taken at face value
   * that publishes a project's first commits to a branch called `null` instead of creating `main`
   * (2026-08-14, `kowo-co/babble`). `null` means "there isn't one yet", which is exactly the case
   * the `main` fallback exists for.
   */
  private async defaultBranch(repo: string): Promise<string> {
    const r = await this.runner(
      ["gh", "repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
      { env: this.ghEnv() },
    );
    const name = r.code === 0 ? r.stdout.trim() : "";
    return name && name !== "null" ? name : "main";
  }

  /**
   * Ensure a fork of `upstream` exists under our account and return its `owner/repo`. `gh repo fork`
   * is idempotent (a no-op when the fork already exists) but GitHub creates the fork ASYNC, so we
   * poll until it's queryable — and, critically, verify the candidate actually IS a fork of
   * `upstream` rather than just a same-named repo. A same-named repo we already own can be an
   * unrelated mirror (e.g. cloned under `--project <name>` for a different upstream with the same
   * name); pushing the ticket branch there and opening a cross-fork PR against it fails outright
   * (`gh pr create`: "Head sha can't be blank" — no fork relationship exists). When the default-named
   * candidate isn't a genuine fork, fork under `<name>-fork` instead, reusing one from a prior run.
   */
  private async ensureFork(upstream: string): Promise<string> {
    const name = upstream.split("/")[1]!;
    const candidate = `${this.opts.account}/${name}`;
    if (await this.forkUntilReady(candidate, upstream)) return candidate;

    const distinct = `${this.opts.account}/${name}-fork`;
    if ((await this.checkFork(distinct, upstream)) === "match") return distinct; // reuse, don't re-create
    await this.forkUntilReady(distinct, upstream, `${name}-fork`);
    return distinct; // let the subsequent push surface any genuine "fork not ready" error
  }

  /**
   * Whether `candidate` is a verified fork of `upstream` — `"match"`, a confirmed non-fork (a
   * same-named repo whose `parent` is absent or points elsewhere) — `"mismatch"`, or not yet
   * queryable at all — `"pending"` (either it doesn't exist, or GitHub's async fork creation
   * hasn't caught up). The distinction matters: `"mismatch"` is definitive and retrying it is
   * pointless, whereas `"pending"` is worth polling.
   */
  private async checkFork(candidate: string, upstream: string): Promise<"match" | "mismatch" | "pending"> {
    const r = await this.runner(["gh", "repo", "view", candidate, "--json", "isFork,parent"], {
      env: this.ghEnv(),
    });
    if (r.code !== 0) return "pending";
    try {
      const data = JSON.parse(r.stdout) as { isFork?: boolean; parent?: { nameWithOwner?: string } };
      return data.isFork && data.parent?.nameWithOwner === upstream ? "match" : "mismatch";
    } catch {
      return "pending";
    }
  }

  /** Run `gh repo fork` (optionally under `forkName`) and poll until `candidate` is a verified fork
   *  of `upstream`. Returns false (without throwing) if it definitively isn't one, or never becomes
   *  queryable — the caller then falls back to a distinct fork name. */
  private async forkUntilReady(candidate: string, upstream: string, forkName?: string): Promise<boolean> {
    const r = await this.runner(
      ["gh", "repo", "fork", upstream, "--clone=false", ...(forkName ? ["--fork-name", forkName] : [])],
      { env: this.ghEnv() },
    );
    if (r.code !== 0 && !/already exists|forked|exists/i.test(`${r.stderr}${r.stdout}`)) {
      throw new Error(`gh repo fork failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    for (let i = 0; i < FORK_READY_TRIES; i++) {
      const check = await this.checkFork(candidate, upstream);
      if (check === "match") return true;
      if (check === "mismatch") return false; // a same-named non-fork repo — retrying won't change that
      await delay(FORK_READY_DELAY_MS);
    }
    return false;
  }

  /**
   * Open a PR, but return an already-open one instead of failing (idempotent publish re-runs).
   * Public because `beckett finish` (`src/cli/finish.ts`) re-runs the same end-of-ticket motion
   * after a transient failure and must reuse the PR it already filed rather than erroring on
   * "a pull request already exists".
   */
  async ensurePR(p: OpenPRParams): Promise<{ number: number; url: string }> {
    const existing = await this.findOpenPR(p.repo, p.head);
    if (existing) return existing;
    try {
      return await this.openPR(p);
    } catch (err) {
      const again = await this.findOpenPR(p.repo, p.head); // racy/pre-existing → re-query, don't fail
      if (again) return again;
      throw err;
    }
  }

  /** The open PR for `head` on `repo` (matches on the branch name, cross-fork `owner:branch` too). */
  private async findOpenPR(repo: string, head: string): Promise<{ number: number; url: string } | null> {
    const branch = head.includes(":") ? (head.split(":").pop() ?? head) : head;
    const r = await this.runner(
      ["gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url", "--limit", "1"],
      { env: this.ghEnv() },
    );
    if (r.code !== 0) return null;
    try {
      const arr = JSON.parse(r.stdout) as Array<{ number: number; url: string }>;
      const first = arr[0];
      return first ? { number: first.number, url: first.url } : null;
    } catch {
      return null;
    }
  }

  /** Open a PR as itself (Spec 07 §3.3). FREE: a proposal, not a change to main. */
  async openPR(p: OpenPRParams): Promise<{ number: number; url: string }> {
    await this.ensureCreds("open PR", { repo: p.repo });
    const args = [
      "gh", "pr", "create",
      "--repo", p.repo,
      "--base", p.base,
      "--head", p.head,
      "--title", p.title,
      "--body", p.body,
    ];
    if (p.draft) args.push("--draft");
    // Labels applied at creation (e.g. `proactive`). gh takes `--label` once per name; an unknown
    // label makes gh fail the create, so callers pass only labels the repo actually has.
    for (const label of p.labels ?? []) if (label.trim()) args.push("--label", label.trim());
    const r = await this.runner(args, { cwd: this.opts.resolveRepoDir(p.repo), env: this.ghEnv() });
    if (r.code !== 0) {
      throw new Error(`gh pr create failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    // gh prints the PR URL on stdout; the trailing path segment is the number.
    const url = (r.stdout.match(/https?:\/\/\S+\/pull\/\d+/) ?? [r.stdout.trim()])[0].trim();
    const num = url.match(/\/pull\/(\d+)/);
    if (!num) throw new Error(`gh pr create: could not parse PR number from "${r.stdout.trim()}"`);
    const number = Number(num[1]);
    this.opts.logger.info("PR opened", { repo: p.repo, number, url });
    return { number, url };
  }

  /** Update a PR (push more commits handled by pushBranch; this edits metadata). FREE. */
  async updatePR(repo: string, n: number, p: UpdatePRParams): Promise<void> {
    await this.ensureCreds("update PR", { repo });
    const args = ["gh", "pr", "edit", String(n), "--repo", repo];
    if (p.title !== undefined) args.push("--title", p.title);
    if (p.body !== undefined) args.push("--body", p.body);
    if (p.base !== undefined) args.push("--base", p.base);
    if (args.length === 5) return; // nothing to change
    const r = await this.runner(args, { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() });
    if (r.code !== 0) {
      throw new Error(`gh pr edit failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /** Comment / approve / request-changes on a PR (Spec 07 §3.3). FREE: speech, not state. */
  async reviewPR(repo: string, n: number, rv: ReviewParams): Promise<void> {
    await this.ensureCreds("review PR", { repo });
    const flag =
      rv.event === "APPROVE" ? "--approve" : rv.event === "REQUEST_CHANGES" ? "--request-changes" : "--comment";
    const r = await this.runner(
      ["gh", "pr", "review", String(n), "--repo", repo, flag, "--body", rv.body],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr review failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /**
   * Merge a PR (Spec 07 §3.4). The IRREVERSIBLE step — callers MUST route this through
   * {@link Agency.perform}("gh.pr.merge", …); this method assumes the handshake already said go.
   */
  async mergePR(repo: string, n: number, strategy: MergeStrategy): Promise<void> {
    await this.ensureCreds("merge PR", { repo });
    const flag = strategy === "merge" ? "--merge" : strategy === "rebase" ? "--rebase" : "--squash";
    const r = await this.runner(
      ["gh", "pr", "merge", String(n), "--repo", repo, flag, "--delete-branch"],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr merge failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("PR merged", { repo, number: n, strategy });
  }

  /**
   * The lifecycle state of a PR — `"OPEN" | "CLOSED" | "MERGED"` (Spec 07 §3.4). Throws a clear
   * error (via `gh`) if the PR number doesn't exist or auth can't see it. When `repo` is empty
   * the current repo (cwd) is used, matching how the other pr verbs resolve their target.
   */
  async prState(repo: string, n: number): Promise<string> {
    await this.ensureCreds("view PR", repo ? { repo } : undefined);
    const repoArgs = repo ? ["--repo", repo] : [];
    const r = await run(
      ["gh", "pr", "view", String(n), ...repoArgs, "--json", "state"],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr view failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    try {
      return String((JSON.parse(r.stdout) as { state?: string }).state ?? "").toUpperCase();
    } catch {
      throw new Error(`gh pr view returned unparseable JSON for PR #${n}`);
    }
  }

  /**
   * Close an OPEN PR without merging (Spec 07 §3.4). Unlike {@link mergePR} this is reversible
   * (a closed PR can be reopened), but it is still an outward-facing state change. We check the
   * current state first so the caller gets a deterministic, human-legible error when the PR is
   * already closed/merged or doesn't exist — independent of `gh`'s exit-code quirks. Returns the
   * resulting state on success. When `repo` is empty the current repo (cwd) is used.
   */
  async closePR(repo: string, n: number): Promise<{ repo: string; number: number; state: string }> {
    await this.ensureCreds("close PR", repo ? { repo } : undefined);
    const state = await this.prState(repo, n); // throws clearly if the PR doesn't exist / is invisible
    if (state === "MERGED") throw new Error(`PR #${n} is already merged — cannot close`);
    if (state === "CLOSED") throw new Error(`PR #${n} is already closed`);
    const repoArgs = repo ? ["--repo", repo] : [];
    const r = await run(
      ["gh", "pr", "close", String(n), ...repoArgs],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr close failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    this.opts.logger.info("PR closed", { repo, number: n });
    return { repo, number: n, state: "CLOSED" };
  }

  /**
   * The one authenticated REST round-trip every issue verb makes (#14). Issues ride the same
   * credential chain as the PR verbs — {@link ensureCreds} resolves the installation covering
   * `repo` and mints ITS token — but go straight to the API rather than through a `gh` subprocess:
   * the token is already in hand, and a long markdown body has no business travelling via argv.
   *
   * Two things the pr verbs don't need happen here, because GitHub's own answers are useless to a
   * human: a permission PRE-check (the app can be installed with Issues unset, which GitHub reports
   * as a bare `403 Resource not accessible by integration`), and {@link issueFailure}, which turns
   * the remaining 403/404s into a sentence naming which of the two causes it actually was.
   */
  private async issuesApi<T>(
    op: string,
    repo: string,
    path: string,
    init: { method?: string; body?: unknown; notFound?: string } = {},
  ): Promise<T> {
    const slug = splitRepo(repo);
    await this.ensureCreds(op, { repo: slug });
    const method = init.method ?? "GET";
    const permissions = this.resolved?.permissions;
    if (permissions && method !== "GET" && permissions.issues !== "write") {
      throw new Error(
        `cannot ${op}: the GitHub App installation covering ${slug} does not have Issues: Write ` +
          `(its issues permission is ${permissions.issues ?? "not granted"}). Grant "Issues — Read and ` +
          `write" in the app's settings, then accept the updated permissions on the installation.`,
      );
    }
    const res = await this.fetchImpl(`${this.opts.apiBase.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.credential.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "beckett",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!res.ok) throw await this.issueFailure(op, slug, res, init.notFound);
    return (await res.json()) as T;
  }

  /**
   * GitHub's refusal, translated. The failures that actually happen on the issues API are "the app
   * isn't installed on this repo (or the repo isn't in its selection)" and "the installation has no
   * Issues: Write" — reported as a bare `404 Not Found` and a bare `403 Resource not accessible by
   * integration`, which tell a human nothing about which one to fix. For the 404 we ask the app
   * itself ({@link GitHubAppAuth.diagnoseAccess}, the same triage `beckett gh app diagnose` runs).
   */
  private async issueFailure(op: string, repo: string, res: Response, notFound?: string): Promise<Error> {
    const detail = await githubErrorMessage(res);
    if (res.status === 401) {
      return new Error(`cannot ${op}: GitHub rejected Beckett's credential (401: ${detail})`);
    }
    if (res.status === 403) {
      return new Error(
        this.opts.app
          ? `cannot ${op}: the GitHub App installation covering ${repo} is not allowed to write issues ` +
            `there (403: ${detail}). Grant "Issues — Read and write" in the app's settings, then accept ` +
            `the updated permissions on the installation.`
          : `cannot ${op}: the configured GITHUB_PAT is not allowed to write issues on ${repo} ` +
            `(403: ${detail}) — it needs the repo/issues scope, and write access to that repository.`,
      );
    }
    if (res.status === 404) {
      const access = await this.describeUnreachable(repo);
      return new Error(`cannot ${op}: ${notFound ? `${notFound}, or ` : ""}${access}`);
    }
    if (res.status === 410) {
      return new Error(`cannot ${op}: issues are disabled on ${repo} (410: ${detail})`);
    }
    return new Error(`cannot ${op}: GitHub returned ${res.status}${detail ? ` — ${detail}` : ""}`);
  }

  /**
   * Why a repo came back 404 to an installation token, in words. Best-effort: the diagnosis is
   * itself a network call, so a failure there falls back to naming both possibilities rather than
   * masking the original error.
   */
  private async describeUnreachable(repo: string): Promise<string> {
    const owner = repo.split("/")[0]!;
    const generic =
      `Beckett's GitHub App cannot see ${repo} — it is either not installed on ${owner} or ${repo} ` +
      `is not in the installation's repository selection`;
    if (!this.opts.app) return generic;
    try {
      const diagnosis = await this.opts.app.diagnoseAccess({ owner, repo });
      switch (diagnosis.status) {
        case "not-installed":
          return `Beckett's GitHub App is not installed on ${owner} — install it: ${diagnosis.installUrl}`;
        case "repo-not-selected":
          return (
            `Beckett's GitHub App is installed on ${owner} but ${repo} is not in its repository ` +
            `selection — add it: ${diagnosis.installUrl}`
          );
        case "repo-not-selected-or-missing":
          return (
            `Beckett's GitHub App is installed on ${owner}, but ${repo} is not in its repository ` +
            `selection (or does not exist) — add it: ${diagnosis.installUrl}`
          );
        case "no-such-owner":
          return `there is no GitHub account called ${owner}`;
        case "ok":
          return (
            `the installation covers ${repo}, so this is not an access problem — the issue number ` +
            `may not exist, or issues may be turned off on that repository`
          );
      }
    } catch {
      /* the diagnosis is a courtesy; never let it replace the failure it was explaining */
    }
    return generic;
  }

  /**
   * Open an issue (#14). FREE at this layer, like {@link openPR}: an issue is speech on someone
   * else's repo, and the CLI/capability surface above decides who may say it. Returns the two
   * things a caller needs back — the number and the html_url.
   */
  async createIssue(repo: string, p: IssueCreateParams): Promise<CreatedIssue> {
    const title = p.title.trim();
    if (!title) throw new Error("create issue: a title is required");
    const labels = (p.labels ?? []).map((l) => l.trim()).filter(Boolean);
    const slug = splitRepo(repo);
    const created = await this.issuesApi<{ number: number; html_url: string; title: string; state: string }>(
      `create an issue on ${slug}`,
      slug,
      `/repos/${slug}/issues`,
      { method: "POST", body: { title, body: p.body ?? "", ...(labels.length ? { labels } : {}) } },
    );
    this.opts.logger.info("issue opened", { repo: slug, number: created.number, url: created.html_url });
    return { repo: slug, number: created.number, url: created.html_url, title: created.title, state: created.state };
  }

  /**
   * List a repo's issues (#14). A pure read. GitHub's issues endpoint also returns pull requests
   * (a PR IS an issue there) — they are dropped, because nobody asking for issues means PRs.
   */
  async listIssues(repo: string, p: { state?: IssueState; limit?: number } = {}): Promise<IssueSummary[]> {
    const slug = splitRepo(repo);
    const state = p.state ?? "open";
    const limit = Number.isFinite(p.limit) ? Math.min(Math.max(Math.trunc(p.limit!), 1), 100) : 30;
    const raw = await this.issuesApi<
      Array<{
        number: number;
        title?: string;
        state?: string;
        html_url?: string;
        user?: { login?: string };
        labels?: Array<{ name?: string } | string>;
        comments?: number;
        created_at?: string;
        updated_at?: string;
        pull_request?: unknown;
      }>
    >(`list issues on ${slug}`, slug, `/repos/${slug}/issues?state=${state}&per_page=${limit}`);
    return raw
      .filter((i) => i.pull_request === undefined)
      .map((i) => ({
        number: i.number,
        title: i.title ?? "",
        state: i.state ?? "",
        url: i.html_url ?? "",
        author: i.user?.login ?? "",
        labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
        comments: i.comments ?? 0,
        createdAt: i.created_at ?? "",
        updatedAt: i.updated_at ?? "",
      }));
  }

  /** Comment on an existing issue (#14) — speech, like {@link reviewPR}, so FREE at this layer. */
  async commentOnIssue(repo: string, n: number, body: string): Promise<IssueCommentResult> {
    if (!body.trim()) throw new Error("comment on issue: a body is required (pass --body or --body-stdin)");
    const slug = splitRepo(repo);
    const posted = await this.issuesApi<{ id: number; html_url: string }>(
      `comment on ${slug}#${n}`,
      slug,
      `/repos/${slug}/issues/${n}/comments`,
      { method: "POST", body: { body }, notFound: `issue #${n} does not exist on ${slug}` },
    );
    this.opts.logger.info("issue commented", { repo: slug, number: n, url: posted.html_url });
    return { repo: slug, number: n, commentId: posted.id, url: posted.html_url };
  }

  /** Whether a PR's status checks are all green (Spec 07 §3.6) — the pre-handshake gate. */
  async isGreen(repo: string, n: number): Promise<boolean> {
    await this.ensureCreds("check PR status", { repo });
    const r = await this.runner(
      ["gh", "pr", "view", String(n), "--repo", repo, "--json", "statusCheckRollup"],
      { cwd: this.opts.resolveRepoDir(repo), env: this.ghEnv() },
    );
    if (r.code !== 0) {
      throw new Error(`gh pr view failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let parsed: { statusCheckRollup?: CheckRollupEntry[] };
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return false; // unparseable → not provably green → fail-closed
    }
    const checks = summarizeCheckRollup(parsed.statusCheckRollup);
    return checks.total === 0 || checks.conclusion === "SUCCESS";
  }

  /**
   * Everything a caller needs to decide "can this PR be merged right now, and if not, WHY" in ONE
   * `gh pr view` round-trip: lifecycle, draft flag, GitHub's own `mergeable` verdict, the
   * `mergeStateStatus` (BLOCKED / DIRTY / BEHIND / CLEAN …), and the rolled-up checks. Read only, so
   * it's FREE. {@link isGreen} answers only "green?" — which collapses "still running" and "failed"
   * into one `false` and says nothing about conflicts, so a caller that must report a SPECIFIC
   * blocker (`beckett finish`) cannot build one from it. Throws with a clear message on an
   * unreadable/missing PR rather than reporting a falsely-unmergeable one.
   */
  async prMergeability(repo: string, n: number): Promise<PrMergeability> {
    await this.ensureCreds("check PR mergeability", { repo });
    const fields = "number,url,title,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,statusCheckRollup";
    const r = await this.runner(["gh", "pr", "view", String(n), "--repo", repo, "--json", fields], {
      env: this.ghEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`gh pr view (mergeability) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let p: {
      number?: number;
      url?: string;
      title?: string;
      state?: string;
      isDraft?: boolean;
      mergeable?: string;
      mergeStateStatus?: string;
      headRefName?: string;
      baseRefName?: string;
      statusCheckRollup?: CheckRollupEntry[];
    };
    try {
      p = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh pr view (mergeability) returned unparseable JSON for PR #${n}`);
    }
    const state = String(p.state ?? "OPEN").toUpperCase();
    return {
      number: typeof p.number === "number" ? p.number : n,
      url: String(p.url ?? ""),
      title: String(p.title ?? ""),
      state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
      isDraft: Boolean(p.isDraft),
      // GitHub computes both asynchronously; an in-flight computation reports UNKNOWN, which is a
      // "ask again in a moment", never a refusal.
      mergeable: String(p.mergeable ?? "UNKNOWN").toUpperCase(),
      mergeStateStatus: String(p.mergeStateStatus ?? "UNKNOWN").toUpperCase(),
      headRefName: String(p.headRefName ?? ""),
      baseRefName: String(p.baseRefName ?? ""),
      checks: summarizeCheckRollup(p.statusCheckRollup),
    };
  }

  /**
   * The full signal read the PR poller diffs (OPS-124): lifecycle, draft flag, head sha, reviews,
   * conversation comments, and the rolled-up CI conclusion — in ONE `gh pr view` round-trip. Read
   * only (no state change), so it's FREE. Throws with a clear message on an unreadable/missing PR
   * so the poller can skip it for the tick and retry, exactly like the tracker poller's read failures.
   */
  /**
   * Recent commits on one branch for the external activity relay. This stays behind GitHubCli so
   * pollers reuse Beckett's credential boundary instead of invoking gh/git themselves.
   */
  async mainCommits(repo: string, branch: string): Promise<GitHubActivityCommit[]> {
    await this.ensureCreds("read repository commits", { repo });
    const r = await this.runner(
      ["gh", "api", "--method", "GET", `repos/${repo}/commits`, "-f", `sha=${branch}`, "-f", "per_page=100"],
      { env: this.ghEnv() },
    );
    if (r.code !== 0) throw new Error(`gh api (commits) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    let commits: Array<{ sha?: string; author?: { login?: string }; committer?: { login?: string }; commit?: { message?: string; author?: { name?: string } } }>;
    try {
      commits = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh api (commits) returned unparseable JSON for ${repo}`);
    }
    if (!Array.isArray(commits)) throw new Error(`gh api (commits) returned a non-list for ${repo}`);
    return commits.map((commit) => ({
      sha: String(commit.sha ?? ""),
      author: commit.author?.login ?? commit.committer?.login ?? commit.commit?.author?.name ?? "",
      message: String(commit.commit?.message ?? "").split("\n")[0] ?? "",
    }));
  }

  /** Recently merged pull requests for the external activity relay (read-only). */
  async mergedPullRequests(repo: string): Promise<GitHubMergedPullRequest[]> {
    await this.ensureCreds("read merged pull requests", { repo });
    const r = await this.runner(
      ["gh", "api", "--method", "GET", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`],
      { env: this.ghEnv() },
    );
    if (r.code !== 0) throw new Error(`gh api (pulls) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    let prs: Array<{ number?: number; title?: string; user?: { login?: string }; merged_at?: string | null }>;
    try {
      prs = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh api (pulls) returned unparseable JSON for ${repo}`);
    }
    if (!Array.isArray(prs)) throw new Error(`gh api (pulls) returned a non-list for ${repo}`);
    return prs
      .filter((pr) => Boolean(pr.merged_at))
      .map((pr) => ({
        number: Number(pr.number ?? 0),
        title: String(pr.title ?? ""),
        author: pr.user?.login ?? "",
        mergedAt: String(pr.merged_at ?? ""),
      }));
  }

  /**
   * Read the aggregate metadata for one published branch/PR in a single `gh pr view` call. The
   * selected JSON fields intentionally exclude `files` and patch text: cards show scale and health,
   * never a wall of diff lines.
   */
  async branchCard(repo: string, ref: string | number): Promise<GitHubBranchCard> {
    await this.ensureCreds("read branch card", { repo });
    const selector = String(ref).trim();
    if (!repo.trim() || !selector) throw new Error("branch card needs both repo and branch/PR ref");
    const fields =
      "number,url,title,state,isDraft,headRefName,baseRefName,headRefOid,updatedAt," +
      "additions,deletions,changedFiles,commits,reviewDecision,latestReviews,comments,statusCheckRollup";
    const r = await this.runner(["gh", "pr", "view", selector, "--repo", repo, "--json", fields], {
      env: this.ghEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`gh pr view (branch card) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let p: {
      number?: unknown;
      url?: unknown;
      title?: unknown;
      state?: unknown;
      isDraft?: unknown;
      headRefName?: unknown;
      baseRefName?: unknown;
      headRefOid?: unknown;
      updatedAt?: unknown;
      additions?: unknown;
      deletions?: unknown;
      changedFiles?: unknown;
      commits?: unknown;
      reviewDecision?: unknown;
      latestReviews?: unknown;
      comments?: unknown;
      statusCheckRollup?: CheckRollupEntry[];
    };
    try {
      p = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh pr view (branch card) returned unparseable JSON for ${repo}@${selector}`);
    }
    const number = positiveInteger(p.number);
    if (number === null) {
      throw new Error(`gh pr view (branch card) returned no valid PR number for ${repo}@${selector}`);
    }
    const state = String(p.state ?? "OPEN").toUpperCase();
    return {
      repo,
      number,
      url: String(p.url ?? ""),
      title: String(p.title ?? ""),
      state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
      isDraft: Boolean(p.isDraft),
      headRefName: String(p.headRefName ?? ""),
      baseRefName: String(p.baseRefName ?? ""),
      headRefOid: String(p.headRefOid ?? ""),
      updatedAt: String(p.updatedAt ?? ""),
      additions: nonNegativeInteger(p.additions),
      deletions: nonNegativeInteger(p.deletions),
      changedFiles: nonNegativeInteger(p.changedFiles),
      commits: Array.isArray(p.commits) ? p.commits.length : 0,
      reviewDecision: String(p.reviewDecision ?? "").toUpperCase(),
      reviewCount: Array.isArray(p.latestReviews) ? p.latestReviews.length : 0,
      commentCount: Array.isArray(p.comments) ? p.comments.length : 0,
      checks: summarizeCheckRollup(p.statusCheckRollup),
    };
  }

  async prSignals(repo: string, n: number): Promise<PrSignals> {
    await this.ensureCreds("read PR signals", { repo });
    const fields =
      "number,url,title,state,isDraft,headRefOid,reviewDecision,reviews,comments,statusCheckRollup";
    const r = await this.runner(["gh", "pr", "view", String(n), "--repo", repo, "--json", fields], {
      env: this.ghEnv(),
    });
    if (r.code !== 0) {
      throw new Error(`gh pr view (signals) failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let p: {
      number?: number;
      url?: string;
      title?: string;
      state?: string;
      isDraft?: boolean;
      headRefOid?: string;
      reviewDecision?: string;
      reviews?: Array<{ id?: string | number; author?: { login?: string }; state?: string; submittedAt?: string; body?: string }>;
      comments?: Array<{ id?: string | number; author?: { login?: string }; createdAt?: string; body?: string }>;
      statusCheckRollup?: CheckRollupEntry[];
    };
    try {
      p = JSON.parse(r.stdout);
    } catch {
      throw new Error(`gh pr view (signals) returned unparseable JSON for PR #${n}`);
    }
    const state = String(p.state ?? "OPEN").toUpperCase();
    return {
      number: typeof p.number === "number" ? p.number : n,
      url: p.url ?? "",
      title: p.title ?? "",
      state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
      isDraft: Boolean(p.isDraft),
      headRefOid: String(p.headRefOid ?? ""),
      reviewDecision: String(p.reviewDecision ?? "").toUpperCase(),
      reviews: (p.reviews ?? []).map((rv) => ({
        id: String(rv.id ?? `${rv.author?.login ?? "?"}@${rv.submittedAt ?? ""}`),
        author: rv.author?.login ?? "",
        state: String(rv.state ?? "").toUpperCase() as PrSignals["reviews"][number]["state"],
        submittedAt: rv.submittedAt ?? "",
        body: rv.body ?? "",
      })),
      comments: (p.comments ?? []).map((c) => ({
        id: String(c.id ?? `${c.author?.login ?? "?"}@${c.createdAt ?? ""}`),
        author: c.author?.login ?? "",
        createdAt: c.createdAt ?? "",
        body: c.body ?? "",
      })),
      checkConclusion: summarizeCheckRollup(p.statusCheckRollup).conclusion,
    };
  }
}

interface CheckRollupEntry {
  status?: string;
  conclusion?: string;
  state?: string;
}

/**
 * Reduce GitHub's mixed CheckRun/StatusContext rollup into exact card counts and the existing loud
 * conclusion. Neutral and skipped checks are healthy but remain separate from genuinely passed
 * checks so the card never overstates what ran.
 */
export function summarizeCheckRollup(rollup?: CheckRollupEntry[]): BranchCardCheckSummary {
  const checks = rollup ?? [];
  const summary: BranchCardCheckSummary = {
    total: checks.length,
    passed: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    conclusion: "NONE",
  };
  for (const check of checks) {
    const status = String(check.status ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const contextState = String(check.state ?? "").toUpperCase();

    if (!status && contextState) {
      if (contextState === "SUCCESS") summary.passed += 1;
      else if (contextState === "NEUTRAL" || contextState === "SKIPPED") summary.skipped += 1;
      else if (contextState === "PENDING" || contextState === "EXPECTED") summary.pending += 1;
      else summary.failed += 1;
      continue;
    }
    if (status && status !== "COMPLETED") {
      summary.pending += 1;
      continue;
    }
    if (conclusion === "SUCCESS") summary.passed += 1;
    else if (conclusion === "NEUTRAL" || conclusion === "SKIPPED") summary.skipped += 1;
    else if (!conclusion) summary.pending += 1;
    else summary.failed += 1;
  }
  summary.conclusion = summary.total === 0
    ? "NONE"
    : summary.failed > 0
      ? "FAILURE"
      : summary.pending > 0
        ? "PENDING"
        : "SUCCESS";
  return summary;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

// =======================================================================================
// Identity loading (Spec 07 §2.1)
// =======================================================================================

/**
 * Load Beckett's {@link Identity} from config + `.env` (already loaded into `process.env` by
 * `loadConfig`). Read-mostly: the only runtime-mutable field is the Gmail OAuth access token
 * (Gmail is out of v0 scope; the auth shape is populated for forward-compat). The GitHub PAT
 * is read here but MUST NEVER be logged (Spec 07 §7.1).
 */
export function loadIdentity(config: Config, env: NodeJS.ProcessEnv = process.env): Identity {
  const github = resolveGitHubTarget(config, env);
  const apiBase = env.GITHUB_API_BASE ?? "https://api.github.com";

  let gmailAuth: GmailAuth;
  if (env.GMAIL_OAUTH_REFRESH_TOKEN) {
    gmailAuth = {
      kind: "oauth",
      clientId: env.GMAIL_OAUTH_CLIENT_ID ?? "",
      clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET ?? "",
      refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN,
    };
  } else {
    gmailAuth = { kind: "app-password", appPassword: env.GMAIL_APP_PASSWORD ?? "" };
  }

  // GitHub App credentials win when configured; a HALF-configured app throws here (loud by
  // design — a missing key must never look like "GitHub isn't set up on this box").
  const app = loadGitHubAppCredentials(env) ?? undefined;

  return {
    name: "Beckett",
    github: {
      account: github.account,
      owner: github.owner,
      pat: env.GITHUB_PAT ?? "",
      app,
      apiBase,
      noreplyEmail: `${github.account}@users.noreply.github.com`,
    },
    gmail: {
      account: env.GMAIL_ACCOUNT ?? config.identity.gmail_address,
      auth: gmailAuth,
    },
    discord: {
      botUser: env.DISCORD_BOT_USER ?? "",
    },
    // Portable: the daemon IS OS user "beckett" on loom-desk; honor an override on dev boxes.
    osUser: env.BECKETT_OS_USER ?? "beckett",
  };
}

/**
 * One {@link GitHubAppAuth} per (app id, api base) for the life of the process, so the daemon's
 * installation-token cache is shared by every client it builds instead of re-minting a token on
 * each `gh` call. Keyed on the app id, not the identity object, because callers re-`loadIdentity`
 * freely.
 */
const appAuthCache = new Map<string, GitHubAppAuth>();

/**
 * The auth half of {@link GitHubClientOptions}, derived from an {@link Identity}. Spread it into
 * every `new GitHubCli({ ... })` so the App path and the legacy PAT path are decided in ONE place:
 *
 * ```ts
 * new GitHubCli({ ...githubAuth(identity), account, owner, apiBase, resolveRepoDir, logger })
 * ```
 */
export function githubAuth(identity: Identity): { pat: string; app?: GitHubAppAuth } {
  if (!identity.github.app) return { pat: identity.github.pat };
  const key = `${identity.github.app.appId}@${identity.github.apiBase}`;
  let auth = appAuthCache.get(key);
  if (!auth) {
    auth = new GitHubAppAuth(identity.github.app, { apiBase: identity.github.apiBase });
    appAuthCache.set(key, auth);
  }
  return { pat: identity.github.pat, app: auth };
}

/** Whether this Beckett can reach GitHub at all — an App **or** a legacy PAT. */
export function githubConfigured(identity: Identity): boolean {
  return identity.github.app !== undefined || identity.github.pat.length > 0;
}

/** The one sentence to say when GitHub is not configured. Used by every caller that degrades. */
export const GITHUB_UNCONFIGURED_NOTE =
  "no GitHub credentials in ~/.beckett/.env — set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH " +
  "(the kowo-co GitHub App; see deploy/github-app.md) or a legacy GITHUB_PAT — GitHub is unavailable";
