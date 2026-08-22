/**
 * Beckett v6 — the GitHub extension (`src/capability/modules/github.ts`)
 * =======================================================================================
 * The `beckett gh …` surface (stateless `gh`/`git` subprocesses, token from env — Spec 07
 * §3.2) on the v6 extension contract (Phase 4, docs/v6-architecture.md §6). Two entrypoints
 * share ONE client-construction core ({@link buildGh}: identity load + credential preflight):
 *   - the CLI verb keeps its historical flag parse + `out`/`fail` contract byte-for-byte (the
 *     CLI characterization suite pins it; thrown core errors reach stderr via
 *     `main().catch(fail)`), and
 *   - the `github.*` capabilities are the v6 dispatch surface: zod-validated structured args
 *     in, an {@link ExtensionResult} out — never `out`/`fail` (those exit the process), so the
 *     daemon can dispatch them in-process through `ext.invoke`.
 *
 * WORKING DIR (the in-daemon hazard): the CLI defaults `dir` to `process.cwd()`; an in-daemon
 * invoke has no meaningful cwd, so {@link buildGh}'s `resolveRepoDir` THROWS unless `dir` is
 * supplied — repo-local operations (`push`, `repo-create --source/--push`) require it, while the
 * API-only operations (pr merge/status/review/close, repo star) never touch it.
 *
 * The declared manifest action-class stays FREE (exactly as the CLI has always behaved, and so
 * the {@link asCapability} projection the v5 spine registers is byte-identical). The real
 * postures live PER-CAPABILITY as forward catalog metadata (pr-merge → HANDSHAKE_GATED, push →
 * ALWAYS_ASK, …): they gate `ext.invoke` upstream, never the CLI subprocess (which carries no
 * agency gate). `createGithubCapability` remains the {@link asCapability} projection for the v5
 * factory table.
 */

import { z } from "zod";
import { ActionClass, type Extension, type ExtensionFactory } from "../../ext/contract.ts";
import { asCapability } from "../../ext/compat.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import {
  GITHUB_UNCONFIGURED_NOTE,
  GitHubCli,
  type IssueState,
  githubAuth,
  githubConfigured,
  loadIdentity,
} from "../../agency/index.ts";
import { GitHubAppAuth, appInstallUrl } from "../../github/app.ts";
import { collectFlag, fail, out, parse } from "../../cli/io.ts";
import { buildGitHubPublishingGuidance } from "../../dispatch/publishing-guidance.ts";
import type { Config, Logger, MergeStrategy, ReviewParams } from "../../types.ts";

const CLI_USAGE =
  "beckett gh repo create|star|unstar | pr create|merge|close|status|review | " +
  "issue create|list|comment | push | land | " +
  "preflight | app status|installations|repos|diagnose|install-url";

const ISSUE_USAGE =
  "usage: beckett gh issue create <owner/repo> --title <t> [--body <b> | --body-stdin] [--label <l> ...] | " +
  "issue list <owner/repo> [--state open|closed|all] [--limit N] | " +
  "issue comment <owner/repo> <number> [--body <b> | --body-stdin]";

const LAND_USAGE =
  "usage: beckett gh land --repo <owner/name> --head <branch> --title <t> [--base main] [--body <b>] " +
  "[--ref <localRef>] [--strategy squash|merge|rebase] [--ci-timeout <secs>] [--force] [--dir <d>] " +
  "[--rerun-with <command>]";

/**
 * The GitHub App identity behind every `beckett gh` call ({@link GitHubAppAuth}) — the surface the
 * troubleshooting playbook queries when a repo looks unreachable. Throws the same loud message as
 * {@link buildGh} when nothing is configured, and a specific one when only a legacy PAT is.
 */
function buildAppAuth(config: Config): GitHubAppAuth {
  const identity = loadIdentity(config);
  if (!githubConfigured(identity)) throw new Error(GITHUB_UNCONFIGURED_NOTE);
  const auth = githubAuth(identity).app;
  if (!auth) {
    throw new Error(
      "this Beckett is on the legacy GITHUB_PAT path — there is no GitHub App to inspect. " +
        "Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH (see deploy/github-app.md).",
    );
  }
  return auth;
}

/**
 * The issue/comment body, from `--body <b>` or piped stdin (`--body-stdin`). Stdin is the one that
 * matters: an issue body is long markdown, which has no business travelling through argv (the same
 * reason `beckett ticket create` reads its body that way).
 */
async function readIssueBody(flags: Record<string, string | boolean>): Promise<string> {
  if (flags["body-stdin"]) return (await Bun.stdin.text()).trim();
  return typeof flags.body === "string" ? flags.body : "";
}

function quietLogger(): Logger {
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return quiet;
}

/**
 * The one client-construction core both surfaces share: load the identity, PREFLIGHT the PAT
 * (throws the exact message the CLI has always printed), and build a {@link GitHubCli} whose
 * `resolveRepoDir` throws when a repo-local op needs a working dir the caller did not pass.
 * The token rides GH_TOKEN/the git credential helper per-invocation, so the parent never needs
 * `gh auth login`/`gh auth status`. (Spec 07 §3.2)
 */
function buildGh(config: Config, dir: string | undefined): GitHubCli {
  const identity = loadIdentity(config);
  if (!githubConfigured(identity)) throw new Error(GITHUB_UNCONFIGURED_NOTE);
  return new GitHubCli({
    ...githubAuth(identity),
    account: identity.github.account,
    owner: identity.github.owner,
    apiBase: identity.github.apiBase,
    resolveRepoDir: () => {
      if (!dir) throw new Error("github: this operation needs a working dir (pass `dir`)");
      return dir;
    },
    logger: quietLogger(),
  });
}

/** Resolve `ref` to a commit sha inside `dir`, or throw a `beckett gh push`-flavored error. */
function resolveLocalCommit(dir: string, ref: string): string {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--verify", `${ref}^{commit}`]);
  if (!r.success) {
    throw new Error(
      `beckett gh push: could not resolve --ref ${JSON.stringify(ref)} to a commit in ${dir}: ` +
        (r.stderr.toString().trim() || "not a valid ref"),
    );
  }
  return r.stdout.toString().trim();
}

/** The branch `dir`'s checkout currently sits on, or `null` for a detached HEAD. */
function currentLocalBranch(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "symbolic-ref", "--short", "-q", "HEAD"]);
  if (!r.success) return null;
  const name = r.stdout.toString().trim();
  return name || null;
}

/**
 * `beckett gh push --branch`'s core (2026-08-22 fix): a push that reports success without moving
 * the remote branch to the intended commit cost a courier run three rework cycles — the CLI ran
 * `--repo <o/n> --branch <remoteBranch>` from the daemon checkout (defaulting `--ref` to `HEAD`
 * and `--dir` to `cwd`) while the run's actual commits sat in an unrelated worktree, uploaded the
 * WRONG commit under the run's branch name, and printed `{ pushed: true }` with nothing to
 * contradict it.
 *
 * Two changes close that hole:
 *  - GUARD: when `--ref` is left to its HEAD default, the checkout in `dir` must already be ON the
 *    named `--branch` — otherwise this refuses rather than guess. An explicit `--ref` (the courier
 *    shape: `--dir <worktree> --ref <branch> --branch <branch>`) always bypasses the guard, since
 *    the caller has said exactly what they mean. `--tag` publishing never reaches this function.
 *  - VERIFY: after pushing, the remote branch is read back and compared to the sha resolved
 *    locally BEFORE the push ran. A mismatch — nothing moved, or it moved to the wrong place — is
 *    an error, not a success.
 */
export async function pushBranchVerified(
  gh: GitHubCli,
  opts: { repo: string; branch: string; dir: string; ref?: string },
): Promise<{ pushed: true; repo: string; branch: string; ref: string; sha: string }> {
  const ref = opts.ref ?? "HEAD";
  const sha = resolveLocalCommit(opts.dir, ref);
  if (opts.ref === undefined) {
    const current = currentLocalBranch(opts.dir);
    if (current !== opts.branch) {
      throw new Error(
        `beckett gh push: --ref was not given, so it defaults to HEAD — but the checkout in ${opts.dir} is on ` +
          `${current ? `branch '${current}'` : "a detached HEAD"}, not '${opts.branch}'. Pushing HEAD there would ` +
          `silently upload the wrong commit under that branch name. Pass --ref ${opts.branch} (or the local ` +
          `ref/sha you actually mean) to push explicitly.`,
      );
    }
  }
  await gh.pushBranch(opts.repo, ref, opts.branch);
  const remoteSha = await gh.remoteBranchSha(opts.repo, opts.branch);
  if (remoteSha !== sha) {
    throw new Error(
      `beckett gh push: pushed ${ref} (${sha}) toward ${opts.repo}:${opts.branch}, but the remote branch now reads ` +
        `${remoteSha ?? "(no such branch)"} — the push did not land the intended commit.`,
    );
  }
  return { pushed: true, repo: opts.repo, branch: opts.branch, ref, sha };
}

/**
 * Best-effort: tell the running daemon to watch a just-opened PR (#31). The `gh` surface is a
 * stateless subprocess with no handle on the in-daemon poller, so it forwards over the control bus
 * — the same one-shot dial `beckett ticket create` uses for workspace routing. A dead/busy socket
 * is swallowed: the PR is already open on GitHub, and re-arm on the next daemon restart re-loads it
 * from the poller's persisted registry regardless. Lazy-imports keep the CLI cold-start minimal.
 */
async function notifyWatchPr(
  config: Config,
  req: { repo: string; number: number; url: string; title: string; channel?: string; author?: string },
): Promise<void> {
  try {
    const { join } = await import("node:path");
    const { buildPaths } = await import("../../paths.ts");
    const { callBus } = await import("../../shell/control-bus.ts");
    const sock = join(buildPaths(config).beckettDir, "control.sock");
    await callBus(sock, "pr.watch", req, 5_000);
  } catch {
    /* best-effort: no daemon / busy bus — the PR is already open and survives via the poller's file */
  }
}

// ── v6 invocation schemas (one per gh operation, for routing prose + per-op posture) ─────────

const RepoCreateArgs = z.object({
  name: z.string().trim().min(1, "github.repo-create needs a repo name"),
  /** Private by default; pass true to create a public repo. */
  public: z.boolean().optional(),
  description: z.string().optional(),
  /** Local dir to initialize/push from (required if `push`). */
  dir: z.string().optional(),
  /** Push the local dir up after creating. */
  push: z.boolean().optional(),
});

const RepoStarArgs = z.object({
  repo: z.string().trim().min(1, "github.repo-star needs an owner/name repo"),
  /** true to star, false to unstar. */
  starred: z.boolean(),
});

const PrOpenArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-open needs a repo"),
  base: z.string().trim().min(1, "github.pr-open needs a base branch"),
  head: z.string().trim().min(1, "github.pr-open needs a head branch"),
  title: z.string().trim().min(1, "github.pr-open needs a title"),
  body: z.string(),
  draft: z.boolean().optional(),
});

const PrMergeArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-merge needs a repo"),
  number: z.number().int().positive("github.pr-merge needs a PR number"),
  strategy: z.enum(["squash", "merge", "rebase"]).optional(),
});

const PrCloseArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-close needs a repo"),
  number: z.number().int().positive("github.pr-close needs a PR number"),
});

const PrStatusArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-status needs a repo"),
  number: z.number().int().positive("github.pr-status needs a PR number"),
});

const PrReviewArgs = z.object({
  repo: z.string().trim().min(1, "github.pr-review needs a repo"),
  number: z.number().int().positive("github.pr-review needs a PR number"),
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).optional(),
  body: z.string().optional(),
});

const IssueCreateArgs = z.object({
  repo: z.string().trim().min(1, "github.issue-create needs an owner/name repo"),
  title: z.string().trim().min(1, "github.issue-create needs a title"),
  /** Markdown body; optional because a one-line issue is a legitimate issue. */
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

const IssueListArgs = z.object({
  repo: z.string().trim().min(1, "github.issue-list needs an owner/name repo"),
  state: z.enum(["open", "closed", "all"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const IssueCommentArgs = z.object({
  repo: z.string().trim().min(1, "github.issue-comment needs an owner/name repo"),
  number: z.number().int().positive("github.issue-comment needs an issue number"),
  body: z.string().trim().min(1, "github.issue-comment needs a body"),
});

const PushArgs = z.object({
  repo: z.string().trim().min(1, "github.push needs an owner/name repo"),
  branch: z.string().trim().min(1, "github.push needs a remote branch"),
  /** Local ref to push (default HEAD). */
  ref: z.string().optional(),
  /** The worktree/checkout to push FROM — required in-daemon (no meaningful cwd). */
  dir: z.string().trim().min(1, "github.push needs a working dir (`dir`)"),
});

export const createGithubExtension: ExtensionFactory = ({ config }): Extension => {
  // The former `cli/beckett.ts::runGh`, observable behavior unchanged: flag parsing and every
  // usage failure stay here; client construction + the PAT preflight come from the shared
  // {@link buildGh} core, whose throws surface via main().catch(fail) with the same message.
  async function runGh(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;

    // `beckett gh raw [--dir <d>] -- <gh args>` — the passthrough escape hatch (opens the full gh
    // surface without a per-verb reimplementation). Handled BEFORE the generic flag parse: everything
    // after `--` is gh's own argv (verbatim, INCLUDING gh's own `--flags`), so it must never run
    // through `parse` (which would swallow gh's flags as ours). The PAT rides the env, never argv.
    if (sub === "raw") {
      let rawArgs = rest;
      let dir: string | undefined;
      if (rawArgs[0] === "--dir") {
        dir = rawArgs[1];
        if (dir === undefined) fail("usage: beckett gh raw [--dir <d>] -- <gh args>");
        rawArgs = rawArgs.slice(2);
      }
      if (rawArgs[0] === "--") rawArgs = rawArgs.slice(1);
      if (rawArgs.length === 0) fail("usage: beckett gh raw [--dir <d>] -- <gh args>");
      // buildGh runs the PAT preflight (its throw reaches stderr via main().catch(fail)); raw never
      // touches resolveRepoDir, so an absent --dir is fine. gh runs in --dir or the caller's cwd.
      const gh = buildGh(config, dir);
      process.exit(await gh.raw(rawArgs, dir ?? process.cwd()));
    }

    // `beckett gh app …` — Beckett asking GitHub about ITSELF: which app it is, who has installed
    // it, what those installations can reach, and why a given repo is out of reach. Handled before
    // the shared client build because none of it touches a repo working dir.
    if (sub === "app") {
      const { _: appArgs, flags: appFlags } = parse(rest);
      const action = appArgs[0] ?? "status";
      const auth = buildAppAuth(config);

      if (action === "status") {
        const meta = await auth.appMetadata();
        const installs = await auth.listInstallations();
        out({
          appId: auth.appId,
          slug: meta.slug,
          name: meta.name,
          owner: meta.owner,
          actsAs: `${meta.slug}[bot]`,
          installUrl: appInstallUrl(meta.slug),
          pinnedInstallationId: auth.pinnedInstallationId ?? null,
          installations: installs.length,
          accounts: installs.map((i) => i.account),
        });
      }

      if (action === "installations") {
        out({ installations: await auth.listInstallations() });
      }

      if (action === "repos") {
        let id = appFlags.installation ? Number(appFlags.installation) : undefined;
        if (!id && appFlags.owner) {
          const found = await auth.installationForOwner(String(appFlags.owner));
          if (!found) fail(`the app is not installed on ${String(appFlags.owner)}`);
          id = found!.id;
        }
        if (!id) id = auth.pinnedInstallationId;
        if (!id) fail("usage: beckett gh app repos [--owner <login> | --installation <id>]");
        out({ installation: id, repositories: await auth.installationRepositories(id!) });
      }

      if (action === "diagnose") {
        const repo = appFlags.repo ? String(appFlags.repo) : "";
        const owner = appFlags.owner ? String(appFlags.owner) : repo.split("/")[0] ?? "";
        if (!owner) fail("usage: beckett gh app diagnose --repo <owner/name> | --owner <login>");
        out(await auth.diagnoseAccess({ owner, repo: repo || undefined }));
      }

      if (action === "install-url") {
        out({ installUrl: await auth.installUrl() });
      }

      fail("usage: beckett gh app status|installations|repos|diagnose|install-url");
    }

    const { _, flags } = parse(rest);
    // The CLI's historical default: repo-local ops run against the caller's cwd unless --dir.
    const gh = buildGh(config, flags.dir ? String(flags.dir) : process.cwd());

    if (sub === "repo" && _[0] === "create") {
      const name = _[1];
      if (!name) fail("usage: beckett gh repo create <name> [--public] [--desc <d>] [--source <dir>] [--push]");
      out(await gh.createRepo({
        name,
        private: !flags.public,
        description: flags.desc ? String(flags.desc) : undefined,
        sourceDir: flags.source ? String(flags.source) : undefined,
        push: Boolean(flags.push),
      }));
    }

    if (sub === "repo" && (_[0] === "star" || _[0] === "unstar")) {
      const repo = _[1];
      if (!repo) fail(`usage: beckett gh repo ${_[0]} <owner/name>`);
      const starred = _[0] === "star";
      await gh.setRepoStar(repo, starred);
      out({ starred, repo });
    }

    if (sub === "pr") {
      const action = _[0];
      const repo = flags.repo ? String(flags.repo) : "";
      const n = Number(_[1]);
      if (action === "create") {
        for (const k of ["repo", "base", "head", "title", "body"]) if (!flags[k]) fail(`gh pr create needs --${k}`);
        // `--label a,b` (comma-separated) applies each label at creation. gh fails the create if a
        // named label doesn't exist on the repo, so the caller ensures it first (see proactive-sweep).
        const labels = flags.label
          ? String(flags.label).split(",").map((l) => l.trim()).filter(Boolean)
          : undefined;
        const created = await gh.openPR({
          repo, base: String(flags.base), head: String(flags.head),
          title: String(flags.title), body: String(flags.body), draft: Boolean(flags.draft), labels,
        });
        // #31: a PR opened by hand from the concierge seat has no dispatcher `onPrOpened` to
        // register it, so tell the daemon's poller to watch it too — including a cross-org upstream
        // PR the poller now watches. Best-effort over the control bus (`--channel <id>` stamps the
        // origin room when the caller knows it); a missing/busy daemon must never fail a create that
        // already succeeded on GitHub.
        await notifyWatchPr(config, {
          repo,
          number: created.number,
          url: created.url,
          title: String(flags.title),
          channel: flags.channel ? String(flags.channel) : undefined,
          author: loadIdentity(config).github.account,
        });
        out(created);
      }
      if (action === "merge") {
        if (!repo || !n) fail("usage: beckett gh pr merge <num> --repo <owner/name> [--strategy squash|merge|rebase]");
        const strategy = (flags.strategy ? String(flags.strategy) : "squash") as MergeStrategy;
        await gh.mergePR(repo, n, strategy);
        out({ merged: true, repo, number: n, strategy });
      }
      if (action === "close") {
        if (!n) fail("usage: beckett gh pr close <num> [--repo <owner/name>]");
        out(await gh.closePR(repo, n));
      }
      if (action === "status") {
        if (!repo || !n) fail("usage: beckett gh pr status <num> --repo <owner/name>");
        out({ repo, number: n, green: await gh.isGreen(repo, n) });
      }
      if (action === "review") {
        if (!repo || !n) fail("usage: beckett gh pr review <num> --repo <r> --event APPROVE|REQUEST_CHANGES|COMMENT --body <b>");
        await gh.reviewPR(repo, n, { event: String(flags.event ?? "COMMENT") as ReviewParams["event"], body: String(flags.body ?? "") });
        out({ reviewed: true, repo, number: n });
      }
      fail("usage: beckett gh pr create|merge|close|status|review <num> --repo <owner/name> ...");
    }

    // `beckett gh issue …` — file/read/answer issues on any repo the app is installed on (#14).
    // The repo is POSITIONAL here (not the pr verbs' `--repo`): an issue is always opened somewhere
    // named out loud, never "whatever repo this cwd happens to be".
    if (sub === "issue") {
      const action = _[0];
      const repo = _[1] ? String(_[1]) : "";
      if (action === "create") {
        if (!repo || typeof flags.title !== "string") fail(ISSUE_USAGE);
        // `--label a --label b` and `--label a,b` both work; `parse` keeps only a flag's LAST value,
        // so the repeats come straight off argv (the same read `collectFlag` exists for).
        const labels = collectFlag(rest, "label").flatMap((l) => l.split(",")).map((l) => l.trim()).filter(Boolean);
        out(await gh.createIssue(repo, { title: String(flags.title), body: await readIssueBody(flags), labels }));
      }
      if (action === "list") {
        if (!repo) fail(ISSUE_USAGE);
        const state = flags.state === undefined ? "open" : String(flags.state);
        if (!["open", "closed", "all"].includes(state)) fail("beckett gh issue list: --state must be one of open|closed|all");
        let limit = 30;
        if (flags.limit !== undefined) {
          limit = Number(flags.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("beckett gh issue list: --limit must be an integer from 1 to 100");
        }
        const issues = await gh.listIssues(repo, { state: state as IssueState, limit });
        out({ repo, state, count: issues.length, issues });
      }
      if (action === "comment") {
        const n = Number(_[2]);
        if (!repo || !Number.isInteger(n) || n < 1) fail(ISSUE_USAGE);
        out(await gh.commentOnIssue(repo, n, await readIssueBody(flags)));
      }
      fail(ISSUE_USAGE);
    }

    if (sub === "push") {
      // `--tag <tag>` publishes a release tag (refs/tags/*) — the ref-shape the branch push can't reach.
      // Checked before the branch path so `push` with neither flag still prints the exact same usage.
      if (flags.tag !== undefined) {
        const tag = typeof flags.tag === "string" ? flags.tag : "";
        if (!flags.repo || !tag) fail("usage: beckett gh push --repo <owner/name> --tag <tag> [--dir <d>]");
        await gh.pushTag(String(flags.repo), tag);
        out({ pushed: true, repo: String(flags.repo), tag });
      }
      if (!flags.repo || !flags.branch) fail("usage: beckett gh push --repo <owner/name> --branch <remoteBranch> [--ref <localRef>] [--dir <d>]");
      out(
        await pushBranchVerified(gh, {
          repo: String(flags.repo),
          branch: String(flags.branch),
          dir: flags.dir ? String(flags.dir) : process.cwd(),
          ref: flags.ref !== undefined ? String(flags.ref) : undefined,
        }),
      );
    }

    // `beckett gh land` — get a branch's commits ONTO a protected base the only way protection
    // allows: push it, open (or reuse) its PR, wait for CI, merge. `beckett finish` runs the same
    // engine (`src/cli/land.ts`) for the end-of-ticket motion, as does `GitHubCli.publishViaPullRequest`
    // (the run engine's owned-repo publish). `deploy/deploy-prod.sh` no longer lands through here —
    // since 2026-08-12 the release bump pushes straight at main under the App's ruleset bypass.
    if (sub === "land") {
      for (const k of ["repo", "head", "title"]) if (!flags[k]) fail(LAND_USAGE);
      const { DEFAULT_CI_TIMEOUT_MS, LandError, landBranch } = await import("../../cli/land.ts");
      let ciTimeoutMs = DEFAULT_CI_TIMEOUT_MS;
      if (flags["ci-timeout"] !== undefined) {
        const secs = Number(flags["ci-timeout"]);
        if (!Number.isFinite(secs) || secs < 0) fail("beckett gh land: --ci-timeout must be a number of seconds (0 to refuse rather than wait)");
        ciTimeoutMs = Math.round(secs * 1000);
      }
      const strategy = (flags.strategy ? String(flags.strategy) : "squash") as MergeStrategy;
      if (!["squash", "merge", "rebase"].includes(strategy)) fail("beckett gh land: --strategy must be one of squash|merge|rebase");
      const head = String(flags.head);
      try {
        const landed = await landBranch(gh, {
          repo: String(flags.repo),
          head,
          localRef: flags.ref ? String(flags.ref) : head,
          base: flags.base ? String(flags.base) : "main",
          title: String(flags.title),
          body: flags.body ? String(flags.body) : "",
          strategy,
          ciTimeoutMs,
          force: flags.force === true,
          dir: flags.dir ? String(flags.dir) : process.cwd(),
          command: flags["rerun-with"] ? String(flags["rerun-with"]) : "beckett gh land",
          // Narration on stderr: stdout stays exactly one JSON object for the caller to parse.
          step: (msg) => process.stderr.write(`land: ${msg}\n`),
        });
        out({ landed: true, repo: String(flags.repo), head, base: flags.base ? String(flags.base) : "main", pr: landed.pr, merge: landed.merge });
      } catch (err) {
        if (err instanceof LandError) fail(`beckett gh land: ${err.message}`);
        throw err;
      }
    }

    // `beckett gh preflight` — "is there a usable credential for this repo, right now?", asked
    // BEFORE a caller does work it could not then publish. Mints the installation token (a real
    // check, not a config read) and prints what it resolved; the token never leaves the process.
    if (sub === "preflight") {
      out(await gh.verifyCredential(flags.repo ? String(flags.repo) : undefined));
    }

    fail(`usage: ${CLI_USAGE}`);
  }

  return {
    manifest: {
      id: "github",
      version: "1.0.0",
      summary: "stateless gh/git subprocesses, token from env (Spec 07 §3.2)",
      // FREE at the manifest layer so the asCapability projection stays byte-identical; the
      // real postures ride per-capability (below) as ext.invoke catalog metadata.
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // --- v6 discovery + dispatch (per-op capabilities → precise routing + per-op posture) ---
    capabilities: [
      {
        id: "github.repo-create",
        description:
          "Create a new GitHub repository under Beckett's account (private by default). Optionally " +
          "initialize and push a local directory up in the same call. Reach for it when someone " +
          "asks to publish a project or start a new repo.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: RepoCreateArgs,
        examples: ["create a private repo called my-tool and push this folder"],
      },
      {
        id: "github.repo-star",
        description:
          "Star (or unstar) a GitHub repository as Beckett — a small, reversible endorsement. " +
          "Use for \"star anthropics/claude-code\" / \"unstar that repo\".",
        input: RepoStarArgs,
        examples: ["star anthropics/claude-code"],
      },
      {
        id: "github.pr-open",
        description:
          "Open a pull request from a head branch into a base branch on a repo. Use when work on " +
          "a branch is ready for review and someone asks to open/raise a PR.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: PrOpenArgs,
        examples: ["open a PR from feature/x into main on kowo-co/beckett"],
      },
      {
        id: "github.pr-merge",
        description:
          "Merge an open pull request (squash by default; merge/rebase available). This lands code " +
          "on the base branch — reach for it only when explicitly asked to merge a specific PR.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: PrMergeArgs,
        examples: ["merge PR 42 on kowo-co/beckett with squash"],
      },
      {
        id: "github.pr-close",
        description:
          "Close a pull request WITHOUT merging it. Use for \"close PR 42\" / \"drop that PR\".",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: PrCloseArgs,
        examples: ["close PR 42 on kowo-co/beckett"],
      },
      {
        id: "github.pr-status",
        description:
          "Read whether a pull request's checks are green. A pure read — use to answer \"is PR 42 " +
          "passing?\" before deciding to merge.",
        input: PrStatusArgs,
        examples: ["is PR 42 green on kowo-co/beckett?"],
      },
      {
        id: "github.pr-review",
        description:
          "Post a review on a pull request — APPROVE, REQUEST_CHANGES, or COMMENT with a body. " +
          "Use when asked to approve, request changes on, or comment-review a specific PR.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: PrReviewArgs,
        examples: ["approve PR 42 with a note that it looks good"],
      },
      {
        id: "github.issue-create",
        description:
          "Open an issue on a GitHub repository — a title, a markdown body, optional labels. Use " +
          "when someone asks to file/report something on a repo (a bug, feedback, a request) " +
          "rather than to change its code.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: IssueCreateArgs,
        examples: ["open an issue on frgmt0/pixe about the methodology feedback"],
      },
      {
        id: "github.issue-list",
        description:
          "List a repository's issues, filtered by state (open by default). A pure read — use to " +
          "answer \"what's open on that repo?\" before filing or commenting.",
        input: IssueListArgs,
        examples: ["what issues are open on frgmt0/pixe?"],
      },
      {
        id: "github.issue-comment",
        description:
          "Post a comment on an existing issue. Use when asked to reply to, follow up on, or add " +
          "detail to a specific issue number.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: IssueCommentArgs,
        examples: ["comment on issue 7 of frgmt0/pixe that the fix is out"],
      },
      {
        id: "github.push",
        description:
          "Push a local worktree's ref up to a remote branch on a repo. The most consequential gh " +
          "action — it must name the working directory to push FROM (`dir`). Use when a checkout " +
          "has commits that need to reach a branch on GitHub.",
        actionClass: ActionClass.ALWAYS_ASK,
        input: PushArgs,
        examples: ["push this worktree's HEAD to the branch feature/x on kowo-co/beckett"],
      },
    ],
    invoke: async (call) => {
      try {
        switch (call.capabilityId) {
          case "github.repo-create": {
            if (!call.origin?.userId) return { ok: false, error: "github: creating a repo needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof RepoCreateArgs>;
            const gh = buildGh(config, a.dir);
            const data = await gh.createRepo({
              name: a.name,
              private: !a.public,
              description: a.description,
              sourceDir: a.dir,
              push: Boolean(a.push),
            });
            return { ok: true, data };
          }
          case "github.repo-star": {
            const a = call.args as z.infer<typeof RepoStarArgs>;
            await buildGh(config, undefined).setRepoStar(a.repo, a.starred);
            return { ok: true, data: { starred: a.starred, repo: a.repo } };
          }
          case "github.pr-open": {
            if (!call.origin?.userId) return { ok: false, error: "github: opening a PR needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PrOpenArgs>;
            const data = await buildGh(config, undefined).openPR({
              repo: a.repo, base: a.base, head: a.head, title: a.title, body: a.body, draft: Boolean(a.draft),
            });
            return { ok: true, data };
          }
          case "github.pr-merge": {
            if (!call.origin?.userId) return { ok: false, error: "github: merging a PR needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PrMergeArgs>;
            const strategy = (a.strategy ?? "squash") as MergeStrategy;
            await buildGh(config, undefined).mergePR(a.repo, a.number, strategy);
            return { ok: true, data: { merged: true, repo: a.repo, number: a.number, strategy } };
          }
          case "github.pr-close": {
            if (!call.origin?.userId) return { ok: false, error: "github: closing a PR needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PrCloseArgs>;
            const data = await buildGh(config, undefined).closePR(a.repo, a.number);
            return { ok: true, data };
          }
          case "github.pr-status": {
            const a = call.args as z.infer<typeof PrStatusArgs>;
            const green = await buildGh(config, undefined).isGreen(a.repo, a.number);
            return { ok: true, data: { repo: a.repo, number: a.number, green } };
          }
          case "github.pr-review": {
            if (!call.origin?.userId) return { ok: false, error: "github: reviewing a PR needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PrReviewArgs>;
            await buildGh(config, undefined).reviewPR(a.repo, a.number, {
              event: (a.event ?? "COMMENT") as ReviewParams["event"],
              body: a.body ?? "",
            });
            return { ok: true, data: { reviewed: true, repo: a.repo, number: a.number } };
          }
          case "github.issue-create": {
            if (!call.origin?.userId) return { ok: false, error: "github: opening an issue needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof IssueCreateArgs>;
            const data = await buildGh(config, undefined).createIssue(a.repo, {
              title: a.title, body: a.body ?? "", labels: a.labels,
            });
            return { ok: true, data };
          }
          case "github.issue-list": {
            const a = call.args as z.infer<typeof IssueListArgs>;
            const issues = await buildGh(config, undefined).listIssues(a.repo, { state: a.state, limit: a.limit });
            return { ok: true, data: { repo: a.repo, state: a.state ?? "open", count: issues.length, issues } };
          }
          case "github.issue-comment": {
            if (!call.origin?.userId) return { ok: false, error: "github: commenting on an issue needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof IssueCommentArgs>;
            const data = await buildGh(config, undefined).commentOnIssue(a.repo, a.number, a.body);
            return { ok: true, data };
          }
          case "github.push": {
            if (!call.origin?.userId) return { ok: false, error: "github: pushing needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof PushArgs>;
            await buildGh(config, a.dir).pushBranch(a.repo, a.ref ?? "HEAD", a.branch);
            return { ok: true, data: { pushed: true, repo: a.repo, branch: a.branch } };
          }
          default:
            return { ok: false, error: `github: unknown capability "${call.capabilityId}"` };
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    // --- v5 facets, carried through unchanged ---
    cliHelp: "gh repo|pr|issue|push|app",
    skillDoc: ".claude/skills/github/SKILL.md",
    cliVerbs: [
      {
        name: "gh",
        summary:
          "repo create/star, PR create/merge/close/status/review, issue create/list/comment, " +
          "branch push, app identity/installations",
        usage: CLI_USAGE,
        run: runGh,
      },
    ],
    busCommands: [],
    // The GitHub ownership contract in every worker persona (composed into the system append by
    // `stages.ts::workerSystemAppend`). Priority 10 keeps the historical persona order:
    // guidance → stage extras (20) → the deploy recipe (30). asCapability projects it, so the
    // factory-table wrapper keeps the worker-append composition intact.
    promptBlock: {
      id: "github",
      priority: 10,
      render: ({ config: liveConfig, slug, env }) =>
        slug ? buildGitHubPublishingGuidance(slug, liveConfig, env ?? process.env) : "",
    },
  };
};

/** The v5 factory-table shape: the {@link asCapability} projection of the extension above. */
export function createGithubCapability(deps: CapabilityDeps): Capability {
  return asCapability(createGithubExtension(deps));
}
