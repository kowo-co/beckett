/**
 * Beckett — `beckett finish` (`src/cli/finish.ts`)
 * =======================================================================================
 * ONE verb for the end-of-ticket motion the concierge used to run by hand: push the finished
 * branch, open (or reuse) its PR with the given message, wait for CI, merge it into main, then run
 * THE guarded redeploy (`deploy/deploy-prod.sh` — dirty-tree refusal, typecheck gate, browser
 * drain, health read-back, release tag). Five-plus separate CLI calls and a lot of back-and-forth
 * collapse into `beckett finish -m "<message>"`.
 *
 * Two properties matter more than the convenience:
 *
 *  1. **Every stop is NAMED.** A wrapper that fails with "merge failed" or hangs forever is worse
 *     than the manual sequence it replaced, because the caller can no longer see which step it was
 *     on. So each stage diagnoses its own blocker into a specific, actionable line — which PR, what
 *     GitHub says is blocking it, and the exact command that unsticks it — and CI waiting is
 *     BOUNDED (`--ci-timeout`), never an open-ended poll. {@link gateMerge} holds that logic as a
 *     pure function so the message for every blocker shape is pinned by tests, not discovered in
 *     production.
 *  2. **It reuses the existing guarded paths.** PR/merge go through `GitHubCli` (the one credential
 *     boundary — never raw `gh`/`git push`); the deploy is the existing script, spawned, never a
 *     hand-rolled restart. This command adds sequencing and diagnosis, not a second way to ship.
 *     The push → PR → CI → merge motion itself lives in {@link landBranch} (`land.ts`), shared with
 *     `beckett gh land` — which is how the deploy script lands its release-version bump on a
 *     protected `main`. One landing path, one set of named blockers.
 *
 * Idempotent by construction: re-running after a fixed blocker reuses the open PR
 * (`GitHubCli.ensurePR`), skips the merge if it already landed, and redeploys.
 *
 * Every invocation posts one line to the ops channel ({@link FINISH_AUDIT_CHANNEL_ID}) before it
 * touches anything, so the ledger records the runs that FAILED too — those are the ones worth
 * seeing. The post is best-effort: a dead daemon must never block shipping.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CI_TIMEOUT_MS, LandError, landBranch } from "./land.ts";
import { fail, out, quietLogger } from "./io.ts";
import { config, SOCK } from "./context.ts";

/**
 * The merge gate and its blocker prose live in {@link land.ts} (shared with `beckett gh land`), and
 * are re-exported here because they ARE `beckett finish`'s contract — the messages an operator
 * reads when it stops — and its test suite pins them at this address.
 */
export { CHECKS_GRACE_MS, describeMergeFailure, gateMerge } from "./land.ts";
export type { MergeGate } from "./land.ts";

export const FINISH_USAGE =
  'usage: beckett finish -m "<message>" [--dir <path>] [--repo <owner/name>] [--base <branch>] ' +
  "[--strategy squash|merge|rebase] [--bump yes|patch|minor|major] [--no-deploy] [--no-commit] " +
  "[--ci-timeout <secs>] [--json (quiet: result only, no progress narration)]";

/**
 * The ops channel every `beckett finish` run announces itself in — the same room the daemon posts
 * startup and dispatch events to, so shipping shows up in the ledger next to everything else.
 * `BECKETT_FINISH_AUDIT_CHANNEL_ID=disabled` silences it (dev boxes, tests).
 */
export const FINISH_AUDIT_CHANNEL_ID = "1520658476974735490";

/** Lines of deploy output kept for the failure message. */
const DEPLOY_TAIL_LINES = 25;

// ── argv ────────────────────────────────────────────────────────────────────────────────────

export interface FinishOptions {
  /** PR title — the first line of `-m`. */
  title: string;
  /** PR body — the remaining lines of `-m`, or `--body`. */
  body: string;
  dir: string;
  repo?: string;
  base: string;
  strategy: "squash" | "merge" | "rebase";
  /** `BECKETT_BUMP` for the guarded deploy — it must never prompt from here (no TTY). */
  bump: "yes" | "patch" | "minor" | "major";
  deploy: boolean;
  /** Commit a dirty tree with the given message instead of refusing it. */
  commit: boolean;
  ciTimeoutMs: number;
  /** Suppress the live progress/deploy narration on stderr; stdout's result object is unchanged. */
  json: boolean;
}

const STRATEGIES = ["squash", "merge", "rebase"] as const;
const BUMPS = ["yes", "patch", "minor", "major"] as const;
const VALUE_FLAGS = ["message", "body", "dir", "repo", "base", "strategy", "bump", "ci-timeout"];
const BOOL_FLAGS = ["no-deploy", "no-commit", "json"];

/** A usage problem, raised so {@link runFinish} owns the single `fail()` (helpers stay testable). */
export class FinishUsageError extends Error {}

function usage(msg: string): never {
  throw new FinishUsageError(`${msg}\n${FINISH_USAGE}`);
}

/**
 * Parse `beckett finish`'s argv. Hand-rolled rather than reusing `io.ts::parse` for one reason:
 * `-m` is a SINGLE-dash short flag (the shape the ticket specifies and the shape every operator
 * types), which the shared parser reads as a positional. Unknown flags are refused rather than
 * ignored — a typo'd `--ci-timeout` silently falling back to the default is exactly the kind of
 * quiet wrongness this command exists to remove.
 */
export function parseFinishArgs(argv: string[], cwd = process.cwd()): FinishOptions {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const key = token === "-m" ? "message" : token.startsWith("--") ? token.slice(2) : null;
    if (key === null) usage(`beckett finish: unexpected argument "${token}" (the message needs -m or --message)`);
    if (BOOL_FLAGS.includes(key)) {
      flags[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(key)) usage(`beckett finish: unknown flag "${token}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--") || value === "-m") usage(`beckett finish: --${key} needs a value`);
    flags[key] = value;
    i++;
  }

  const message = typeof flags.message === "string" ? flags.message.trim() : "";
  if (!message) usage('beckett finish: a message is required — beckett finish -m "what this ticket shipped"');

  // `-m` doubles as the commit message and the PR title/body: first line titles, the rest is body.
  const [firstLine, ...restLines] = message.split("\n");
  const inlineBody = restLines.join("\n").trim();
  const body = typeof flags.body === "string" ? flags.body : inlineBody;

  const strategy = typeof flags.strategy === "string" ? flags.strategy : "squash";
  if (!(STRATEGIES as readonly string[]).includes(strategy)) {
    usage(`beckett finish: --strategy must be one of ${STRATEGIES.join("|")}`);
  }
  const bump = typeof flags.bump === "string" ? flags.bump : "yes";
  if (!(BUMPS as readonly string[]).includes(bump)) {
    usage(`beckett finish: --bump must be one of ${BUMPS.join("|")}`);
  }

  let ciTimeoutMs = DEFAULT_CI_TIMEOUT_MS;
  if (typeof flags["ci-timeout"] === "string") {
    const secs = Number(flags["ci-timeout"]);
    // 0 means "don't wait": anything not already mergeable is reported as a blocker immediately.
    if (!Number.isFinite(secs) || secs < 0) usage("beckett finish: --ci-timeout must be a number of seconds (0 to refuse rather than wait)");
    ciTimeoutMs = Math.round(secs * 1000);
  }

  return {
    title: firstLine!.trim(),
    body,
    dir: typeof flags.dir === "string" ? flags.dir : cwd,
    repo: typeof flags.repo === "string" ? flags.repo : undefined,
    base: typeof flags.base === "string" ? flags.base : "main",
    strategy: strategy as FinishOptions["strategy"],
    bump: bump as FinishOptions["bump"],
    deploy: flags["no-deploy"] !== true,
    commit: flags["no-commit"] !== true,
    ciTimeoutMs,
    json: flags.json === true,
  };
}

// ── git plumbing ────────────────────────────────────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const git = (args: string[], cwd: string) => run(["git", ...args], cwd);

/**
 * `owner/name` out of any origin URL shape git hands back — HTTPS with or without `.git`, SSH
 * (`git@host:owner/name.git`), and `ssh://` — or null when it isn't a recognizable GitHub-style
 * remote (a local path remote, say), in which case the caller asks for `--repo`.
 */
export function repoFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const scp = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/); // git@github.com:owner/name
  const path = scp ? scp[1]! : trimmed.match(/^[a-z+]+:\/\/[^/]+\/(.+)$/i)?.[1] ?? null;
  if (path === null) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join("/");
}

/**
 * What `beckett finish` can actually do about the remote, decided BEFORE it touches GitHub. The
 * three cases exist because they used to collapse into one confident wrong answer: a repo with no
 * remote, and a repo whose base branch does not exist yet, both ended up at the landing engine's
 * `no commits between` translation — "this work is already merged, or nothing was committed" — on a
 * branch carrying an entire unpushed build (2026-08-14, `kowo-co/babble`). A wrong diagnosis is
 * worse than an error: it tells the operator to stop looking.
 */
export type RemotePlan =
  /** (a) Nothing to push to. `error` names the missing thing and the command that supplies it. */
  | { kind: "no-remote"; error: string }
  /** (b) The remote exists but `base` does not yet — an empty repo. Normal: do the first push. */
  | { kind: "first-push" }
  /** (c) A real comparison is possible; the landing engine's verdicts mean what they say. */
  | { kind: "land" };

/**
 * Decide which of the three cases holds. Pure so every message is pinned by tests rather than
 * discovered in production.
 *
 * `baseExists` is `null` when GitHub could not be asked at all — that is NOT evidence of an empty
 * repo, so it falls through to `land` and lets the landing engine report whatever GitHub actually
 * says, rather than inventing a first push against a repo that may well have a base branch.
 */
export function planRemote(p: {
  /** The resolved `owner/name`, or undefined when neither `--repo` nor `origin` supplied one. */
  repo?: string;
  /** `origin`'s URL, or null when the checkout has no `origin` remote at all. */
  originUrl: string | null;
  base: string;
  dir: string;
  baseExists: boolean | null;
}): RemotePlan {
  if (!p.repo) {
    const nudge =
      `Either wire the remote up — \`git remote add origin https://github.com/<owner>/<name>.git\` in ` +
      `${p.dir} — or name the repo for this run: \`beckett finish -m "…" --repo <owner/name>\`.`;
    return {
      kind: "no-remote",
      error:
        p.originUrl === null
          ? `${p.dir} has NO \`origin\` remote configured (\`git remote -v\` is empty), so there is nowhere to ` +
            `push and nothing to compare this branch against. This is not "already merged" — nothing has ` +
            `been published at all. ${nudge}`
          : `${p.dir}'s \`origin\` is \`${p.originUrl}\`, which is not a GitHub \`owner/name\` remote, so this ` +
            `command cannot work out where to push. ${nudge}`,
    };
  }
  if (p.baseExists === false) return { kind: "first-push" };
  return { kind: "land" };
}

/**
 * The repo's PRIMARY checkout, out of `git worktree list --porcelain` (its first entry, always the
 * main working tree — linked worktrees follow).
 *
 * This matters because the guarded deploy runs `git checkout main` in whatever directory it is
 * spawned from, and a LINKED worktree cannot check out a branch another worktree already holds —
 * git refuses with `fatal: 'main' is already used by worktree at …`. Ticket work happens in exactly
 * such a worktree (`.beckett/worktrees/N`), so spawning the deploy in `--dir` would fail on every
 * self-hosted finish, AFTER the merge had already landed. The deploy therefore runs where an
 * operator has always run it by hand: the checkout that holds `main`.
 */
export function primaryWorktree(porcelain: string): string | null {
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim() || null;
  }
  return null;
}

/**
 * The guarded deploy's exit, translated. Its own gates already print a `FATAL:` line explaining
 * themselves, so surface THAT rather than a generic non-zero exit — and recognize the host-config
 * failures whose real cause ("Author identity unknown") is several layers below the symptom.
 */
export function describeDeployFailure(code: number, tail: string): string {
  const lower = tail.toLowerCase();
  const head = `the guarded deploy failed (exit ${code}) — the merge DID land on main, only the deploy is incomplete.`;
  if (lower.includes("author identity unknown") || lower.includes("please tell me who you are")) {
    return (
      `${head} Cause: git has no commit identity on this host, so the release-version bump could not be ` +
      `committed. Fix it once with \`git config --global user.email "<address>"\` and ` +
      `\`git config --global user.name "<name>"\`, then re-run \`beckett finish\` (the PR is already merged, ` +
      `so it will go straight to the deploy).\n${tail}`
    );
  }
  if (lower.includes("is already used by worktree")) {
    return (
      `${head} Cause: the deploy ran in a LINKED git worktree, which cannot check out \`main\` while ` +
      `another checkout holds it. Re-run \`beckett finish\` (it skips the merge and retries the deploy), ` +
      `or run \`./deploy/deploy-prod.sh\` directly from the checkout that holds main.\n${tail}`
    );
  }
  if (lower.includes("checkout is dirty")) {
    return (
      `${head} Cause: the deploy checkout on the daemon host has uncommitted edits, and it refuses to ` +
      `deploy over hand edits. On the host: \`cd ~/beckett && git status --short\`, restore it to a clean ` +
      `origin/main, then re-run \`beckett finish\`.\n${tail}`
    );
  }
  if (lower.includes("no usable github credential")) {
    return (
      `${head} Cause: the deploy host has no GitHub App credential, so it can neither land the release ` +
      `bump nor push the release tag (both ride the installation token — there is no ambient-git ` +
      `fallback). Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH in ~/.beckett/.env (deploy/github-app.md), ` +
      `check it with \`beckett gh preflight --repo <owner/name>\`, then re-run \`beckett finish\` — the PR is ` +
      `already merged, so it goes straight to the deploy.\n${tail}`
    );
  }
  if (lower.includes("did not land on main")) {
    return (
      `${head} Cause: the deploy could not land its release-version bump on main — the bump goes through ` +
      `its own PR (main is branch-protected), and that PR is blocked. The FATAL lines above name the ` +
      `blocker; clear it, then re-run \`beckett finish\` (the bump PR is reused, and a bump that already ` +
      `landed is a no-op).\n${tail}`
    );
  }
  if (lower.includes("permission denied") || lower.includes("could not resolve hostname") || lower.includes("connection refused")) {
    return (
      `${head} Cause: the deploy could not reach the daemon host over ssh. Check BECKETT_HOST and the ssh ` +
      `key, then re-run \`beckett finish\`.\n${tail}`
    );
  }
  // The script's own gates shout `FATAL:`; git — whose errors reach here just as often — says
  // `fatal:`. Matching only the loud one left git's actual reason out of the message entirely.
  const fatal = tail.split("\n").find((line) => /fatal:/i.test(line));
  return `${head}${fatal ? ` Cause: ${fatal.trim()}` : ""}\n${tail}`;
}

/** Longest title the audit line carries; the daemon caps an ack at 240 chars, so cap it HERE
 *  rather than letting it truncate the trailing context away. */
const AUDIT_TITLE_MAX = 90;

/**
 * The one line each invocation records in the ops channel. `at` (a wall-clock stamp) is what makes
 * two runs distinct: the daemon coalesces byte-identical posts inside a two-minute window, and
 * "fix the blocker, re-run" legitimately repeats the same message — without the stamp the second
 * invocation would silently leave no record.
 */
export function finishAuditLine(repo: string, branch: string, title: string, at: Date): string {
  const short = title.length > AUDIT_TITLE_MAX ? `${title.slice(0, AUDIT_TITLE_MAX - 1).trimEnd()}…` : title;
  const stamp = at.toISOString().slice(11, 19);
  return `\`beckett finish\` ${stamp}Z — \`${repo}\` @ \`${branch}\`: "${short}" (PR → merge → redeploy)`;
}

// ── side-effecting helpers ──────────────────────────────────────────────────────────────────

/**
 * Live narration goes to STDERR so stdout stays exactly one JSON object for the caller to parse.
 * `--json` silences the narration (and the deploy's own output) for a caller that only wants the
 * result; nothing that ends up in an error message is narration-only, so silencing it never costs
 * diagnosis.
 */
let quiet = false;
function step(msg: string): void {
  if (!quiet) process.stderr.write(`finish: ${msg}\n`);
}

function auditChannelId(): string {
  return process.env.BECKETT_FINISH_AUDIT_CHANNEL_ID?.trim() || FINISH_AUDIT_CHANNEL_ID;
}

/**
 * Record this invocation in the ops channel. Best-effort BY DESIGN: the audit trail is worth a
 * couple of seconds, never worth refusing to ship because the daemon is restarting. A failure is
 * reported in the result rather than swallowed, so a silently-broken ledger stays visible.
 *
 * `discord.ack`, NOT `discord.reply` — and that difference is load-bearing. The concierge runs
 * `beckett finish` from INSIDE a live turn, and a `discord.reply` into the channel that turn is
 * running in CLAIMS it (`repliedViaCli`), which would make this bookkeeping line swallow the
 * concierge's actual answer. An ack posts without claiming anything.
 */
async function postAuditLine(text: string): Promise<{ posted: boolean; channel: string; note?: string }> {
  const channelId = auditChannelId();
  if (channelId === "disabled") return { posted: false, channel: channelId, note: "audit posting disabled" };
  try {
    const { callBus } = await import("../shell/control-bus.ts");
    const res = await callBus(SOCK, "discord.ack", { channelId, text }, 20_000);
    return res.ok
      ? { posted: true, channel: channelId }
      : { posted: false, channel: channelId, note: res.error ?? "the daemon refused the audit post" };
  } catch (err) {
    return { posted: false, channel: channelId, note: (err as Error).message };
  }
}

/** Build the one credentialed GitHub client this command uses (never raw `gh`/`git push`). */
async function buildGh(dir: string) {
  const { GITHUB_UNCONFIGURED_NOTE, GitHubCli, githubAuth, githubConfigured, loadIdentity } = await import("../agency/index.ts");
  const identity = loadIdentity(config);
  if (!githubConfigured(identity)) fail(`beckett finish: ${GITHUB_UNCONFIGURED_NOTE}`);
  return new GitHubCli({
    ...githubAuth(identity),
    account: identity.github.account,
    owner: identity.github.owner,
    apiBase: identity.github.apiBase,
    resolveRepoDir: () => dir,
    logger: quietLogger,
  });
}

/** Pump a child's stream to stderr live while keeping the last {@link DEPLOY_TAIL_LINES} lines. */
async function teeToStderr(stream: ReadableStream<Uint8Array> | null, tail: string[], echo: boolean): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    if (echo) process.stderr.write(text);
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      tail.push(line);
      if (tail.length > DEPLOY_TAIL_LINES) tail.shift();
    }
  }
  if (pending) tail.push(pending);
  while (tail.length > DEPLOY_TAIL_LINES) tail.shift();
}

/**
 * Run THE guarded deploy script as a child, narrating it live and keeping its tail for the failure
 * message. Nothing here reimplements any part of the deploy — it is spawned exactly as an operator
 * would run it, with the two things a non-interactive caller must supply: the toolchain on PATH
 * (bun lives in `~/.bun/bin`, which a non-login shell does not add) and a pre-decided
 * `BECKETT_BUMP`, since the script prompts for the version bump on a TTY and there is nobody here
 * to answer.
 *
 * `echo` mirrors the deploy's output to stderr as it arrives — a deploy is the slowest stage by far
 * and silence for minutes reads as a hang. It defaults OFF so tests (and `--json`) capture the tail
 * without narrating it; {@link runFinish} turns it on for an ordinary interactive run.
 */
export async function runGuardedDeploy(
  script: string,
  cwd: string,
  bump: string,
  echo = false,
): Promise<{ code: number; tail: string }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const home = process.env.HOME ?? "";
  const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
  env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
  env.BECKETT_BUMP = bump;
  const proc = Bun.spawn(["bash", script], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const tail: string[] = [];
  await Promise.all([teeToStderr(proc.stdout, tail, echo), teeToStderr(proc.stderr, tail, echo)]);
  return { code: await proc.exited, tail: tail.join("\n").trim() };
}

// ── the verb ────────────────────────────────────────────────────────────────────────────────

export async function runFinish(argv: string[]): Promise<void> {
  let opts: FinishOptions;
  try {
    opts = parseFinishArgs(argv);
  } catch (err) {
    if (err instanceof FinishUsageError) fail(err.message);
    throw err;
  }
  quiet = opts.json;

  // ── repo/branch context ──────────────────────────────────────────────────────────────────
  const top = await git(["rev-parse", "--show-toplevel"], opts.dir);
  if (top.code !== 0) {
    fail(
      `beckett finish: ${opts.dir} is not a git checkout, so there is no finished branch to ship. ` +
        `Run it from the ticket's worktree (e.g. ~/Projects/beckett) or pass --dir <path>.`,
    );
  }
  const repoRoot = top.stdout.trim();

  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const branch = head.stdout.trim();
  if (head.code !== 0 || !branch || branch === "HEAD") {
    fail(
      `beckett finish: ${repoRoot} has no checked-out branch (detached HEAD), so there is nothing to open a ` +
        `PR from. Check the ticket's branch out first: \`git checkout <branch>\`.`,
    );
  }
  if (branch === opts.base) {
    fail(
      `beckett finish: you are on ${opts.base} — that is the merge TARGET, not a finished branch. Check out ` +
        `the ticket's branch (\`git checkout <branch>\`), or pass --base <other-branch> if you meant a ` +
        `different target. To redeploy what is already on ${opts.base}, run ./deploy/deploy-prod.sh.`,
    );
  }

  const remote = await git(["remote", "get-url", "origin"], repoRoot);
  const originUrl = remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : null;
  const repo = opts.repo ?? (originUrl ? repoFromRemoteUrl(originUrl) ?? undefined : undefined);
  // Case (a) is decidable with no network at all, so say it here rather than after a pointless
  // audit post and commit.
  const unresolved = planRemote({ repo, originUrl, base: opts.base, dir: repoRoot, baseExists: null });
  if (unresolved.kind === "no-remote") fail(`beckett finish: ${unresolved.error}`);
  if (!repo) throw new Error("unreachable: planRemote accepted a missing repo");

  // Announce FIRST: the ledger should record the runs that go on to fail, not only the clean ones.
  const audit = await postAuditLine(finishAuditLine(repo, branch, opts.title, new Date()));
  if (audit.channel === "disabled") step("audit posting is disabled for this host — continuing");
  else if (!audit.posted) step(`audit post to ${audit.channel} did not land (${audit.note}) — continuing`);

  // ── the working tree ─────────────────────────────────────────────────────────────────────
  const status = await git(["status", "--porcelain"], repoRoot);
  if (status.code !== 0) fail(`beckett finish: could not read git status in ${repoRoot}: ${status.stderr.trim()}`);
  const dirty = status.stdout.trim();
  let committed = false;
  if (dirty) {
    if (!opts.commit) {
      fail(
        `beckett finish: ${repoRoot} has uncommitted changes and --no-commit was passed, so they would be ` +
          `left behind by the merge:\n${dirty}\nCommit them yourself and re-run, or drop --no-commit to let ` +
          `finish commit them with the given message.`,
      );
    }
    const identity = await gitIdentityProblem(repoRoot);
    if (identity) fail(`beckett finish: ${identity}`);
    step(`committing ${dirty.split("\n").length} pending change(s) with the given message`);
    const add = await git(["add", "-A"], repoRoot);
    if (add.code !== 0) fail(`beckett finish: \`git add -A\` failed in ${repoRoot}: ${add.stderr.trim()}`);
    const message = opts.body ? `${opts.title}\n\n${opts.body}` : opts.title;
    const commit = await git(["commit", "-m", message], repoRoot);
    if (commit.code !== 0) {
      fail(`beckett finish: committing the pending changes failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
    }
    committed = true;
  }

  const gh = await buildGh(repoRoot);

  // ── which of the three remote cases is this? ─────────────────────────────────────────────
  // Ask GitHub whether the base branch exists BEFORE opening anything. A brand-new repo with no
  // commits has no `main`, and a PR against it fails with the very same `No commits between …`
  // text GitHub uses for genuinely-landed work — which is how a branch carrying an entire build
  // got reported as "already merged, or nothing was committed" (2026-08-14).
  let baseExists: boolean | null = null;
  try {
    baseExists = await gh.branchExists(repo, opts.base);
  } catch (err) {
    step(`could not read ${repo}'s ${opts.base} branch (${(err as Error).message}) — treating this as an ordinary landing`);
  }
  const plan = planRemote({ repo, originUrl, base: opts.base, dir: repoRoot, baseExists });
  if (plan.kind === "no-remote") fail(`beckett finish: ${plan.error}`); // re-checked: nothing changed above
  const firstPush = plan.kind === "first-push";
  if (firstPush) step(`${repo} has no \`${opts.base}\` branch yet — this is a first push, not a PR`);

  // ── already landed? ──────────────────────────────────────────────────────────────────────
  // Re-running finish on a branch whose commits are all on the target used to die inside the
  // landing engine ("this work is already merged, or nothing was committed") — a hard failure
  // for a state that is actually success, and exactly what the concierge kept hitting when its
  // belief about ship-state lagged reality (2026-08-12, twice). Answer the question cheaply
  // HERE: when origin/<base> already has every commit on this branch, exit clean without
  // landing, deploying, or touching GitHub. (A commit made just above makes the branch ahead
  // again, so freshly committed work never takes this exit.)
  //
  // Skipped entirely on a first push: there is no remote base to compare against, and a failed
  // `git fetch` must never be read as "nothing to do".
  if (!firstPush) {
    const fetched = await git(["fetch", "origin", opts.base], repoRoot);
    if (fetched.code === 0) {
      const ahead = await git(["log", `origin/${opts.base}..HEAD`, "--oneline"], repoRoot);
      if (ahead.code === 0 && !ahead.stdout.trim()) {
        step(`nothing to land — origin/${opts.base} already has every commit on ${branch}`);
        out({
          ok: true,
          repo,
          branch,
          base: opts.base,
          committed,
          alreadyLanded: true,
          deploy: { ran: false, reason: "nothing to land — the branch is already on the target" },
          audit,
        });
      }
    }
  }

  // Only Beckett's own repo ships a guarded deploy. Resolving that here (not after the merge) is
  // what lets the preflights below run ONLY when a deploy is actually going to happen — and lets
  // them fail while nothing has been pushed or merged yet.
  //
  // The deploy runs in the repo's PRIMARY checkout, not necessarily the branch's: see
  // {@link primaryWorktree}. `--dir` picks the branch to ship; it does not relocate the deploy.
  const worktrees = await git(["worktree", "list", "--porcelain"], repoRoot);
  const deployRoot = (worktrees.code === 0 ? primaryWorktree(worktrees.stdout) : null) ?? repoRoot;
  const script = join(deployRoot, "deploy", "deploy-prod.sh");
  const willDeploy = opts.deploy && existsSync(script);

  if (willDeploy) {
    // The deploy commits the release bump in the DEPLOY checkout, so a missing identity blocks it
    // just as surely as it blocks the commit above — catch it here, before the PR, not 10 minutes
    // in and on the far side of a merge.
    const identity = await gitIdentityProblem(deployRoot);
    if (identity) fail(`beckett finish: ${identity} (the guarded deploy commits the release version bump)`);
    // Likewise a dirty deploy checkout: `git checkout main` there would fail after the merge landed.
    if (deployRoot !== repoRoot) {
      const deployStatus = await git(["status", "--porcelain"], deployRoot);
      const deployDirty = deployStatus.code === 0 ? deployStatus.stdout.trim() : "";
      if (deployDirty) {
        fail(
          `beckett finish: the deploy checkout ${deployRoot} has uncommitted changes, so the guarded ` +
            `deploy could not check out ${opts.base} there:\n${deployDirty}\nClean it up (\`cd ${deployRoot} && ` +
            `git status --short\`) and re-run \`beckett finish\`, or pass --no-deploy to land the PR ` +
            `without shipping. Nothing has been pushed or merged yet.`,
        );
      }
    }
  }

  // ── (b) the first push ───────────────────────────────────────────────────────────────────
  // An empty repo is a SUPPORTED case, not an error: push the branch (so the history has a name)
  // and then push the same commits to the base, which creates it. There is nothing to open a PR
  // against and nothing to merge — the work IS the base branch after this.
  let pr: { number: number; url: string } | null = null;
  let merged: "merged" | "already-merged" | "first-push";
  if (firstPush) {
    try {
      step(`pushing ${branch} to ${repo}`);
      await gh.pushBranch(repo, "HEAD", branch);
      step(`creating ${opts.base} on ${repo} from ${branch} (first push — the repo is empty)`);
      await gh.pushBranch(repo, "HEAD", opts.base);
    } catch (err) {
      fail(
        `beckett finish: the first push to ${repo} failed, so ${opts.base} still does not exist there. ` +
          `Check the credential with \`beckett gh preflight --repo ${repo}\`, then re-run \`beckett finish\`.\n` +
          `${(err as Error).message}`,
      );
    }
    merged = "first-push";
    step(`${opts.base} on ${repo} now carries this work — nothing to merge`);
  } else {
    // ── push → PR → CI → merge ─────────────────────────────────────────────────────────────
    // The shared landing engine (`land.ts`): the same motion `beckett gh land` runs for the
    // deploy's release bump, so a protected `main` is satisfied the one way that works and every
    // blocker is named once, in one place.
    try {
      const landed = await landBranch(gh, {
        repo,
        head: branch,
        localRef: "HEAD",
        base: opts.base,
        title: opts.title,
        body: opts.body,
        strategy: opts.strategy,
        ciTimeoutMs: opts.ciTimeoutMs,
        dir: repoRoot,
        command: "beckett finish",
        timeoutAlso: " and nothing was deployed",
        step,
      });
      pr = landed.pr;
      merged = landed.merge;
    } catch (err) {
      if (err instanceof LandError) fail(`beckett finish: ${err.message}`);
      throw err;
    }
  }

  // ── the guarded redeploy ─────────────────────────────────────────────────────────────────
  let deploy: { ran: boolean; reason?: string } = { ran: false };
  if (!opts.deploy) {
    deploy = { ran: false, reason: "--no-deploy" };
    step("skipping the deploy (--no-deploy)");
  } else if (!willDeploy) {
    // Refusing here would strand every OTHER project's finish at the merge, and hand-rolling a
    // restart for them would be worse. Say plainly that there was nothing to redeploy.
    deploy = { ran: false, reason: `no guarded deploy path in this repo (${script} does not exist)` };
    step(`merged, but ${deploy.reason} — nothing to redeploy`);
  } else {
    step(`running the guarded redeploy (${script} in ${deployRoot}, BECKETT_BUMP=${opts.bump})`);
    const { code, tail } = await runGuardedDeploy(script, deployRoot, opts.bump, !quiet);
    if (code !== 0) fail(`beckett finish: ${describeDeployFailure(code, tail)}`);
    deploy = { ran: true };
  }

  out({
    ok: true,
    repo,
    branch,
    base: opts.base,
    committed,
    // A first push has no PR — the base branch did not exist, so there was nothing to open one
    // against. Reporting `pr: null` is the honest shape; inventing one would be worse than none.
    pr: pr ? { number: pr.number, url: pr.url } : null,
    merge: merged === "first-push"
      ? { state: merged, strategy: "first-push", note: `${opts.base} was created on ${repo} by this push` }
      : { state: merged, strategy: opts.strategy },
    deploy: deploy.ran ? { ran: true, script, cwd: deployRoot, bump: opts.bump } : { ran: false, reason: deploy.reason },
    audit,
  });
}

/**
 * The commit identity `git commit` needs, checked BEFORE anything is pushed or merged. Git's own
 * failure ("Author identity unknown") surfaces deep inside the deploy, minutes after the merge has
 * already landed — exactly the "blocked by host config" case this command must name up front.
 */
async function gitIdentityProblem(cwd: string): Promise<string | null> {
  const [email, name] = await Promise.all([
    git(["config", "--get", "user.email"], cwd),
    git(["config", "--get", "user.name"], cwd),
  ]);
  const missing = [
    email.code === 0 && email.stdout.trim() ? null : "user.email",
    name.code === 0 && name.stdout.trim() ? null : "user.name",
  ].filter((v): v is string => v !== null);
  if (missing.length === 0) return null;
  return (
    `git has no commit identity in ${cwd} (${missing.join(" and ")} unset), so nothing here can be ` +
    `committed. Set it once: ` +
    missing.map((key) => `\`git config --global ${key} "<value>"\``).join(" and ") +
    `, then re-run \`beckett finish\`.`
  );
}
