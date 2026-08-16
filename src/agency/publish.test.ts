/**
 * Coverage for the hardened GitHub publish path (`GitHubCli.ensurePublished`) — the decision tree
 * that replaced the non-idempotent `gh repo create --remote origin` that stranded OPS-28 (cloned
 * checkout already had an `origin` → publish threw → ticket was already "done" → work never shipped).
 * The subprocess runner is injected, so every branch + its idempotency is exercised without touching
 * live GitHub. Each fake matches on argv and returns canned `gh`/`git` output.
 */

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubCli, parseRepoNwo } from "./index.ts";
import type { Logger } from "../types.ts";

const noopLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return noopLog;
  },
} as unknown as Logger;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
type FakeRun = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
) => Promise<RunResult>;

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1): RunResult => ({ code, stdout: "", stderr });

/** `gh repo view --json isFork,parent` response for a genuine fork of `upstream`. */
const forkView = (upstream: string): RunResult => ok(JSON.stringify({ isFork: true, parent: { nameWithOwner: upstream } }));
/** `gh repo view --json isFork,parent` response for a same-named repo that is NOT a fork of anything
 *  we're forking from (a mirror, e.g. `0xbeckett/nothing` cloned for `--project nothing`). */
const notAForkView = (): RunResult => ok(JSON.stringify({ isFork: false }));

/** `gh pr list --head <branch> --state open` response: no open PR yet. */
const noOpenPr = (): RunResult => ok("[]\n");
/** `gh pr create` response: the URL gh prints on stdout (the PR-open path parses it back out). */
const prCreated = (n: number, repo = "0xbeckett/beckett"): RunResult => ok(`https://github.com/${repo}/pull/${n}\n`);
/**
 * `gh pr view --json …mergeable…` response — the landing engine's one read of a PR's verdict.
 * Defaults to a clean, checks-green PR so `gateMerge` returns `{ kind: "ready" }` and the caller can
 * override just the field that matters for its scenario.
 */
function prView(
  n: number,
  opts: {
    repo?: string;
    state?: string;
    isDraft?: boolean;
    mergeable?: string;
    mergeStateStatus?: string;
    headRefName?: string;
    baseRefName?: string;
    statusCheckRollup?: Array<{ status?: string; conclusion?: string }>;
  } = {},
): RunResult {
  return ok(
    JSON.stringify({
      number: n,
      url: `https://github.com/${opts.repo ?? "0xbeckett/beckett"}/pull/${n}`,
      title: "t",
      state: opts.state ?? "OPEN",
      isDraft: opts.isDraft ?? false,
      mergeable: opts.mergeable ?? "MERGEABLE",
      mergeStateStatus: opts.mergeStateStatus ?? "CLEAN",
      headRefName: opts.headRefName ?? "beckett/x",
      baseRefName: opts.baseRefName ?? "main",
      statusCheckRollup: opts.statusCheckRollup ?? [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
  );
}

/** A real git runner for the squash-landing regression fixture below. */
async function realRun(cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }): Promise<RunResult> {
  const env = Object.fromEntries(Object.entries(opts?.env ?? process.env).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const proc = Bun.spawn(cmd, { cwd: opts?.cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await realRun(["git", ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Build a GitHubCli whose subprocess runner is `route`, recording every argv it sees. */
function cli(
  route: (joined: string, cmd: string[]) => RunResult | undefined,
  target: { account?: string; owner?: string; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const calls: string[] = [];
  const envs: Array<Record<string, string | undefined> | undefined> = [];
  const run: FakeRun = async (cmd, opts) => {
    const joined = cmd.join(" ");
    calls.push(joined);
    envs.push(opts?.env);
    return route(joined, cmd) ?? fail(`unrouted: ${joined}`);
  };
  const gh = new GitHubCli({
    pat: "tok",
    account: target.account ?? "0xbeckett",
    owner: target.owner,
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/src",
    logger: noopLog,
    run: run as never,
    now: target.now,
    sleep: target.sleep,
  });
  return { gh, calls, envs };
}

test("parseRepoNwo handles https, ssh, bare, and rejects junk", () => {
  expect(parseRepoNwo("https://github.com/owner/repo.git")).toBe("owner/repo");
  expect(parseRepoNwo("https://github.com/owner/repo")).toBe("owner/repo");
  expect(parseRepoNwo("git@github.com:owner/repo.git")).toBe("owner/repo");
  expect(parseRepoNwo("owner/repo")).toBe("owner/repo");
  expect(parseRepoNwo("not-a-repo")).toBeNull();
  expect(parseRepoNwo("")).toBeNull();
});

test("case 3 — fresh owned project (no origin, repo absent): create empty, then push HEAD→main", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin"); // fresh
    if (j.startsWith("gh repo view 0xbeckett/balloons")) return fail("404"); // repoExists → no
    if (j.startsWith("gh repo create")) return ok("https://github.com/0xbeckett/balloons\n");
    if (j.startsWith("git ls-files")) return ok(""); // no tracked scaffolding to strip
    if (j.startsWith("git push")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "balloons", sourceDir: "/src", description: "d", ticket: "OPS-9" });
  expect(r.kind).toBe("pushed");
  expect(r.url).toContain("0xbeckett/balloons");
  // Repo created WITHOUT --source/--push (branch-name-agnostic), then HEAD pushed to `main` by name
  // — so a worktree on `beckett/<ticket>` still yields a `main`-default repo, not a weirdly-named one.
  const create = calls.find((c) => c.startsWith("gh repo create"))!;
  expect(create).not.toContain("--push");
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("HEAD:refs/heads/main");
  expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false); // fresh project → no PR
});

test("an explicit org owns managed repos while GITHUB_ACCOUNT remains the credential identity", async () => {
  const { gh, calls, envs } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) {
      return ok("https://github.com/publisher-bot/balloons.git");
    }
    if (j.startsWith("gh repo view acme-labs/balloons")) return fail("404");
    if (j.startsWith("gh repo create acme-labs/balloons")) {
      return ok("https://github.com/acme-labs/balloons\n");
    }
    if (j.startsWith("git ls-files")) return ok("");
    if (j.startsWith("git push https://github.com/acme-labs/balloons.git")) return ok();
    return undefined;
  }, { account: "publisher-bot", owner: "acme-labs" });

  const result = await gh.ensurePublished({ slug: "balloons", sourceDir: "/src" });

  expect(result.nameWithOwner).toBe("acme-labs/balloons");
  expect(calls.some((call) => call.startsWith("gh repo create acme-labs/balloons"))).toBe(true);
  expect(calls.some((call) => call.startsWith("gh repo fork"))).toBe(false);
  expect(
    envs.some((env) => env?.GIT_CONFIG_VALUE_1?.includes("username=publisher-bot")),
  ).toBe(true);
});

test("third-party forks and PR heads stay under the authenticated account, not the managed org", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) {
      return ok("https://github.com/SSHdotCodes/probabilities.git");
    }
    if (j.startsWith("gh repo fork SSHdotCodes/probabilities")) return ok("forked");
    if (j.startsWith("gh repo view publisher-bot/probabilities --json isFork,parent")) {
      return forkView("SSHdotCodes/probabilities");
    }
    if (j.startsWith("git push https://github.com/publisher-bot/probabilities.git")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok("[]");
    if (j.startsWith("gh pr create")) {
      return ok("https://github.com/SSHdotCodes/probabilities/pull/7\n");
    }
    return undefined;
  }, { account: "publisher-bot", owner: "acme-labs" });

  await gh.ensurePublished({ slug: "probabilities", sourceDir: "/src", ticket: "OPS-28" });

  const fork = calls.find((call) => call.startsWith("gh repo fork"))!;
  expect(fork).not.toContain("--org");
  const create = calls.find((call) => call.startsWith("gh pr create"))!;
  expect(create).toContain("publisher-bot:beckett/ops-28");
  expect(create).not.toContain("acme-labs:");
});

test("case 2 — owned repo: push the run branch, open the PR, merge it with squash", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}'); // exists
    if (j.includes("api --method PATCH")) return ok(); // setPublic
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list")) return noOpenPr();
    if (j.startsWith("gh pr create")) return prCreated(42);
    if (j.startsWith("gh pr view 42")) return prView(42);
    if (j.startsWith("gh pr merge 42")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" });
  expect(r.kind).toBe("pushed"); // PublishResult is unchanged: a merged PR still reports "pushed"
  expect(r.prUrl).toBe("https://github.com/0xbeckett/beckett/pull/42");
  const pushes = calls.filter((c) => c.startsWith("git push"));
  // The run's OWN branch is pushed FIRST — durability, unconditional — then the PR/CI/merge motion.
  expect(pushes[0]).toContain("HEAD:refs/heads/beckett/ops-25");
  const prCreateIdx = calls.findIndex((c) => c.startsWith("gh pr create"));
  expect(calls.indexOf(pushes[0]!)).toBeLessThan(prCreateIdx);
  expect(calls.some((c) => c.startsWith("gh pr list"))).toBe(true);
  expect(calls.some((c) => c.startsWith("gh pr view 42"))).toBe(true);
  expect(calls.some((c) => c.startsWith("gh pr merge 42") && c.includes("--squash") && c.includes("--delete-branch"))).toBe(true);
  // No local rebase/apply anywhere — GitHub does the integration, not the sandbox.
  expect(calls.some((c) => c.startsWith("git fetch"))).toBe(false);
  expect(calls.some((c) => c.startsWith("git rebase"))).toBe(false);
  expect(calls.some((c) => c.startsWith("git apply"))).toBe(false);
});

test("the merge never runs inside the run's worktree", async () => {
  const mergeCwds: Array<string | undefined> = [];
  const gh = new (await import("./index.ts")).GitHubCli({
    pat: "tok",
    account: "0xbeckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/src",
    logger: noopLog,
    run: (async (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => {
      const j = cmd.join(" ");
      if (j.startsWith("gh pr merge")) mergeCwds.push(opts?.cwd);
      if (j.startsWith("git remote get-url origin")) return fail("no origin");
      if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
      if (j.includes("api --method PATCH")) return ok();
      if (j.includes("--json defaultBranchRef")) return ok("main");
      if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
      if (j.startsWith("git push")) return ok();
      if (j.startsWith("gh pr list")) return noOpenPr();
      if (j.startsWith("gh pr create")) return prCreated(7);
      if (j.startsWith("gh pr view 7")) return prView(7);
      if (j.startsWith("gh pr merge 7")) return ok();
      return fail(`unrouted: ${j}`);
    }) as never,
  });
  await gh.ensurePublished({ slug: "beckett", sourceDir: "/src/run-worktree", ticket: "OPS-25" });
  expect(mergeCwds.length).toBe(1);
  expect(mergeCwds[0]).not.toBe("/src/run-worktree");
  expect(mergeCwds[0]).not.toBe("/src");
});

test("an open PR is reused on a retry and a MERGED PR short-circuits to success", async () => {
  let prListed = 0;
  let prCreatedCount = 0;
  let merged = 0;
  const route = (j: string) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list")) {
      prListed++;
      return prListed === 1 ? noOpenPr() : ok(JSON.stringify([{ number: 9, url: "https://github.com/0xbeckett/beckett/pull/9" }]));
    }
    if (j.startsWith("gh pr create")) {
      prCreatedCount++;
      return prCreated(9);
    }
    if (j.startsWith("gh pr view 9")) return prListed === 1 ? prView(9) : prView(9, { state: "MERGED" });
    if (j.startsWith("gh pr merge 9")) {
      merged++;
      return ok();
    }
    return undefined;
  };
  const { gh } = cli(route);
  const first = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" });
  expect(first.prUrl).toBe("https://github.com/0xbeckett/beckett/pull/9");
  expect(prCreatedCount).toBe(1);
  expect(merged).toBe(1);
  // Retry: findOpenPR now reports the SAME PR already open — reuse it, no second `pr create`.
  // (A truly idempotent re-run also reports it MERGED — either way, no second merge call.)
  const second = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" });
  expect(second.prUrl).toBe("https://github.com/0xbeckett/beckett/pull/9");
  expect(prCreatedCount).toBe(1); // still just the one `pr create`
  expect(merged).toBe(1); // MERGED short-circuits — no second `pr merge`
});

// Review finding #14 (overhaul seams review): attempt 1 merges the PR via the API (which deletes
// the head branch); the daemon dies before finalizePublish runs; the retry re-pushes the branch and
// finds no OPEN PR (the real one is MERGED), so `gh pr create` fails "no commits between". Rather
// than degrading to a bare commit URL (mislabeling a PR landing as a direct push), look up the
// MERGED PR for the branch and report its URL.
test("a retry that finds its PR already merged and the branch deleted reports the merged PR url, not a commit url", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list") && j.includes("--state open")) return noOpenPr();
    if (j.startsWith("gh pr list") && j.includes("--state merged")) {
      return ok(JSON.stringify([{ number: 9, url: "https://github.com/0xbeckett/beckett/pull/9" }]));
    }
    if (j.startsWith("gh pr create")) return fail("no commits between main and beckett/OPS-25");
    return undefined;
  });
  const result = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" });
  expect(result.prUrl).toBe("https://github.com/0xbeckett/beckett/pull/9");
  expect(calls.some((c) => c.startsWith("git commit"))).toBe(false);
});

// Same scenario, but no merged PR is found either — this is the genuinely un-attributable case
// (nothing was ever committed, per land.ts's rewritten message), which must NOT be reported as a
// success: the old commit-url fallback would point at the base tip commit, not the run's own
// work — exactly the false-done shape B12 closed. It stays a permanent "publish blocked:" park
// instead (which classifyPublishError already keys on), so a human courier gets it.
test("a retry with no open AND no merged PR stays a permanent publish-blocked failure, not a false success", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list")) return noOpenPr(); // matches both --state open and --state merged
    if (j.startsWith("gh pr create")) return fail("no commits between main and beckett/OPS-25");
    return undefined;
  });
  const failure = await gh
    .ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" })
    .then(() => null, (err: Error) => err.message);
  expect(failure).toMatch(/^publish blocked:/);
  expect(calls.some((c) => c.startsWith("git commit"))).toBe(false);
});

test("a CONFLICTING PR fails the publish with the PR url and never touches the local checkout", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list")) return noOpenPr();
    if (j.startsWith("gh pr create")) return prCreated(11);
    if (j.startsWith("gh pr view 11")) return prView(11, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    return undefined;
  });
  const failure = await gh
    .ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" })
    .then(() => null, (err: Error) => err.message);
  expect(failure).toMatch(/^publish blocked:/);
  expect(failure).toContain("https://github.com/0xbeckett/beckett/pull/11");
  expect(calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  expect(calls.some((c) => c.startsWith("git checkout"))).toBe(false);
  expect(calls.some((c) => c.startsWith("git apply"))).toBe(false);
});

test("CI still pending at the budget hands the wait back to the retry ladder", async () => {
  // A fake clock that jumps well past PUBLISH_CI_TIMEOUT_MS (5min) on the SECOND read — the first
  // read establishes `startedAt`, so `landBranch`'s loop sees "still pending" once, then "over budget".
  let clock = 0;
  const now = () => clock;
  const sleep = async () => {
    clock += 6 * 60_000;
  };
  const { gh } = cli(
    (j) => {
      if (j.startsWith("git remote get-url origin")) return fail("no origin");
      if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
      if (j.includes("api --method PATCH")) return ok();
      if (j.includes("--json defaultBranchRef")) return ok("main");
      if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
      if (j.startsWith("git push")) return ok();
      if (j.startsWith("gh pr list")) return noOpenPr();
      if (j.startsWith("gh pr create")) return prCreated(13);
      if (j.startsWith("gh pr view 13")) return prView(13, { statusCheckRollup: [{ status: "IN_PROGRESS" }] });
      return undefined;
    },
    { now, sleep },
  );
  const failure = await gh
    .ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" })
    .then(() => null, (err: Error) => err.message);
  expect(failure).toContain("still waiting on CI");
  expect(failure).toContain("https://github.com/0xbeckett/beckett/pull/13");
  expect(failure).toMatch(/^publish: still waiting on CI/);
});

test("a non-main integration target opens the PR against THAT branch and never names main", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main"); // must never be consulted
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/v5-daemon")) return ok("v5-daemon");
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list")) return noOpenPr();
    if (j.startsWith("gh pr create")) return prCreated(21);
    if (j.startsWith("gh pr view 21")) return prView(21, { baseRefName: "v5-daemon" });
    if (j.startsWith("gh pr merge 21")) return ok();
    return undefined;
  });
  await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-180", targetBranch: "v5-daemon" });
  expect(calls.some((c) => c.includes("--json defaultBranchRef"))).toBe(false);
  expect(calls.some((c) => c.startsWith("gh api repos/0xbeckett/beckett/branches/v5-daemon"))).toBe(true);
  const create = calls.find((c) => c.startsWith("gh pr create"))!;
  expect(create).toContain("--base v5-daemon");
  expect(calls.some((c) => c.includes("refs/heads/main"))).toBe(false);
});

test("a default branch that is itself a beckett/run-* branch is refused, and nothing is pushed", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view kowo-co/babble --json name")) return ok('{"name":"babble"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("beckett/run-20260814-oauth");
    if (j.startsWith("git push")) return ok("SHOULD-NOT-PUSH");
    return undefined;
  }, { owner: "kowo-co" });
  await expect(
    gh.ensurePublished({ slug: "babble", sourceDir: "/src", ticket: "OPS-25" }),
  ).rejects.toThrow(/needs a human/);
  expect(calls.some((c) => c.startsWith("git push"))).toBe(false);
});

// Review finding (must, 2026-08-15): on a branchless repo (`trunk.exists === false`), pushing the
// run branch FIRST would make GitHub set it as the repo's new default — the same kowo-co/babble
// misconfiguration `resolveTrunk` exists to refuse. The trunk push must land first in that case.
test("case 2 — when the trunk does not exist yet, the trunk is pushed BEFORE the run branch", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/babble --json name")) return ok('{"name":"babble"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/babble/branches/main")) return fail("gh: Not Found (HTTP 404)", 1);
    if (j.startsWith("git fetch")) return fail("fatal: couldn't find remote ref main", 128); // no base yet
    if (j.startsWith("git push")) return ok();
    return undefined;
  });
  await gh.ensurePublished({ slug: "babble", sourceDir: "/src", ticket: "run-y" });
  const pushes = calls.filter((c) => c.startsWith("git push"));
  expect(pushes[0]).toContain("HEAD:refs/heads/main");
  expect(pushes[1]).toContain("HEAD:refs/heads/beckett/run-y");
});

// Review finding (should, 2026-08-15): a retry after a partial success can find the run branch
// already at an earlier tip on the remote — a plain non-force push then rejects non-fast-forward.
// That must read as "durability already satisfied", not a hard failure that wedges the retry ladder
// before the trunk push is ever reattempted.
test("a non-fast-forward reject on the durability push is swallowed, and the PR/merge motion still happens", async () => {
  // The durability push (`pushRunBranch`) and `landBranch`'s own re-push of the SAME branch both
  // target `refs/heads/beckett/run-x`; only the FIRST (the durability push) is made to reject here —
  // by the time `landBranch` re-pushes the identical, already-current tip, a real remote would report
  // "Everything up-to-date" (no reject at all), which this fixture models as a plain success.
  let branchPushes = 0;
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git push")) {
      branchPushes++;
      if (branchPushes === 1) {
        return fail("! [rejected] refs/heads/beckett/run-x -> refs/heads/beckett/run-x (non-fast-forward)", 1);
      }
      return ok();
    }
    if (j.startsWith("gh pr list")) return noOpenPr();
    if (j.startsWith("gh pr create")) return prCreated(55);
    if (j.startsWith("gh pr view 55")) return prView(55);
    if (j.startsWith("gh pr merge 55")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "run-x" });
  expect(r.kind).toBe("pushed");
  expect(r.prUrl).toBe("https://github.com/0xbeckett/beckett/pull/55");
  expect(branchPushes).toBeGreaterThanOrEqual(2);
  expect(calls.some((c) => c.startsWith("gh pr merge 55"))).toBe(true);
});

test("#246 — a run's raw checkpoint commits squash into ONE before the branch push, and the PR carries the review write-up", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}'); // exists
    if (j.includes("api --method PATCH")) return ok(); // setPublic
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git rev-parse --verify --quiet HEAD")) return ok("tipsha0000000");
    if (j.startsWith("git rev-parse --verify --quiet wk_base")) return ok("basesha0000000");
    if (j.startsWith("git merge-base --is-ancestor")) return ok(); // base IS an ancestor of the checkpoints
    if (j.startsWith("git rev-list --count")) return ok("5"); // five raw checkpoint commits, like f9383c0..07d1480
    if (j.startsWith("git reset --soft basesha0000000")) return ok();
    if (j.startsWith("git -c commit.gpgsign=false commit")) return ok();
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list")) return noOpenPr();
    if (j.startsWith("gh pr create")) return prCreated(88);
    if (j.startsWith("gh pr view 88")) return prView(88);
    if (j.startsWith("gh pr merge 88")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({
    slug: "beckett",
    sourceDir: "/src",
    ticket: "run-20260812-fix-double-posting",
    baseSha: "wk_base",
    commitMessage: "run title\n\nreview summary / mechanism writeup",
  });
  expect(r.kind).toBe("pushed");
  // Squashed BEFORE the branch push — the raw checkpoint history never even reaches the remote.
  expect(calls.some((c) => c.startsWith("git reset --soft basesha0000000"))).toBe(true);
  const commit = calls.find((c) => c.startsWith("git -c commit.gpgsign=false commit"))!;
  expect(commit).toContain("run title");
  // Exactly one squash commit landed — not five raw "checkpoint (wk_...)" commits.
  expect(calls.filter((c) => c.startsWith("git -c commit.gpgsign=false commit")).length).toBe(1);
  // The review write-up now lives in the PR body (#246's squash commit was the only carrier before).
  const create = calls.find((c) => c.startsWith("gh pr create"))!;
  expect(create).toContain("review summary / mechanism writeup");
  // prUrl is the merged PR's URL, matching what the Discord publish announcement renders.
  expect(r.prUrl).toBe("https://github.com/0xbeckett/beckett/pull/88");
});

test("case 2 — an explicit `main` target keeps the default-branch publish byte-for-byte", async () => {
  // A ticket that explicitly targets `main` (or none at all) is a normal main-targeted ticket: it
  // must consult the repo default and push HEAD→main exactly as before — the guard is inert here.
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list")) return noOpenPr();
    if (j.startsWith("gh pr create")) return prCreated(66);
    if (j.startsWith("gh pr view 66")) return prView(66);
    if (j.startsWith("gh pr merge 66")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25", targetBranch: "main" });
  expect(r.kind).toBe("pushed");
  expect(calls.some((c) => c.includes("--json defaultBranchRef"))).toBe(true); // default branch resolved as usual
  const pushes = calls.filter((c) => c.startsWith("git push"));
  expect(pushes[0]).toContain("HEAD:refs/heads/beckett/ops-25");
});

/**
 * Acceptance gate for Task 2+3 (push-the-branch-first / publish-opens-a-pr): a REAL remote and a
 * REAL branch push, with the PR/merge motion faked to report CONFLICTING — proof that the run's own
 * work is durable on the remote (and trunk stays untouched) even when GitHub can't integrate it. No
 * local rebase/apply runs at all; the integration verdict comes ONLY from the (faked) `gh pr view`.
 */
test("a CONFLICTING publish still leaves beckett/run-<id> on the remote and trunk untouched (acceptance gate)", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-push-first-"));
  try {
    const remoteParent = join(root, "0xbeckett");
    const remote = join(remoteParent, "beckett.git");
    const seed = join(root, "seed");
    const worker = join(root, "worker");
    const other = join(root, "other");
    await mkdir(remoteParent, { recursive: true });
    await git(root, "init", "--bare", remote);
    await git(root, "init", "--initial-branch=main", seed);
    await git(seed, "config", "user.email", "test@example.com");
    await git(seed, "config", "user.name", "Test");
    await writeFile(join(seed, "shared.txt"), "root\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "root");
    await git(seed, "remote", "add", "origin", `file://${remote}`);
    await git(seed, "push", "origin", "main");

    // The run's own checkout: one commit, its own edit to the shared file.
    await git(root, "clone", "-b", "main", `file://${remote}`, worker);
    await git(worker, "config", "user.email", "test@example.com");
    await git(worker, "config", "user.name", "Test");
    await writeFile(join(worker, "shared.txt"), "the run's own change\n");
    await git(worker, "add", ".");
    await git(worker, "commit", "-m", "run checkpoint");
    const runTip = await git(worker, "rev-parse", "HEAD");

    // Main moves on with a conflicting edit to the same line — GitHub will report CONFLICTING.
    await git(root, "clone", "-b", "main", `file://${remote}`, other);
    await git(other, "config", "user.email", "test@example.com");
    await git(other, "config", "user.name", "Test");
    await writeFile(join(other, "shared.txt"), "someone else's conflicting change\n");
    await git(other, "add", ".");
    await git(other, "commit", "-m", "landed meanwhile, conflicts with the run");
    await git(other, "push", "origin", "main");

    const calls: string[] = [];
    const gh = new GitHubCli({
      pat: "tok",
      account: "0xbeckett",
      apiBase: "https://api.github.com",
      resolveRepoDir: () => worker,
      logger: noopLog,
      run: (async (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => {
        const j = cmd.join(" ");
        calls.push(j);
        if (cmd[0] === "git") return realRun(cmd, opts);
        if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
        if (j.includes("api --method PATCH")) return ok();
        if (j.includes("--json defaultBranchRef")) return ok("main");
        if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
        if (j.startsWith("gh pr list")) return noOpenPr();
        if (j.startsWith("gh pr create")) return prCreated(19);
        if (j.startsWith("gh pr view 19")) return prView(19, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
        return fail(`unrouted: ${j}`);
      }) as never,
    });
    (gh as unknown as { gitHost: () => string }).gitHost = () => `file://${root}`;

    const failure = await gh
      .ensurePublished({ slug: "beckett", sourceDir: worker, ticket: "run-20260815-conflict" })
      .then(() => null, (err: Error) => err.message);
    expect(failure).toMatch(/^publish blocked:/);
    expect(failure).toContain("https://github.com/0xbeckett/beckett/pull/19");

    // The trunk (main) never moved past the seed's push — nothing local ever touched it.
    expect(await git(root, "--git-dir", remote, "log", "-1", "--format=%s", "main")).toBe(
      "landed meanwhile, conflicts with the run",
    );
    // ...but the run's OWN branch is durable on the remote, at the run's own tip.
    const remoteBranchTip = await git(root, "--git-dir", remote, "rev-parse", "beckett/run-20260815-conflict");
    expect(remoteBranchTip).toBe(runTip);
    expect(calls.some((c) => c.startsWith("git rebase") || c.startsWith("git apply"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

/**
 * A publish checkout carrying loose, uncommitted work, against a remote whose `main` moved on.
 * `checkout` picks WHOSE dirt it is: a run's own `git worktree add` checkout (ours to commit), or a
 * shared project clone (a human's, never ours to commit). The PR/merge motion is faked to succeed
 * (PR #1) — these fixtures exist to prove what gets COMMITTED and PUSHED, not to exercise GitHub's
 * integration verdict.
 */
async function dirtyPublishFixture(root: string, checkout: "run-worktree" | "shared-clone") {
  const remoteParent = join(root, "0xbeckett");
  const remote = join(remoteParent, "beckett.git");
  const seed = join(root, "seed");
  const project = join(root, "project");
  const worker = join(root, "worker");
  const other = join(root, "other");
  await mkdir(remoteParent, { recursive: true });
  await git(root, "init", "--bare", remote);
  await git(root, "init", "--initial-branch=main", seed);
  await git(seed, "config", "user.email", "test@example.com");
  await git(seed, "config", "user.name", "Test");
  await writeFile(join(seed, "README.md"), "root\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "root");
  await git(seed, "remote", "add", "origin", `file://${remote}`);
  await git(seed, "push", "origin", "main");

  // The publish checkout: one committed turn, plus loose work no stage got around to committing (an
  // edit to a tracked file AND a brand-new file) — exactly what makes `git rebase` refuse.
  if (checkout === "run-worktree") {
    await git(root, "clone", "-b", "main", `file://${remote}`, project);
    await git(project, "config", "user.email", "test@example.com");
    await git(project, "config", "user.name", "Test");
    await git(project, "worktree", "add", "-b", "beckett/ops-dirty", worker, "main");
  } else {
    await git(root, "clone", "-b", "main", `file://${remote}`, worker);
    await git(worker, "config", "user.email", "test@example.com");
    await git(worker, "config", "user.name", "Test");
  }
  await writeFile(join(worker, "feature.ts"), "export const v = 1;\n");
  await git(worker, "add", ".");
  await git(worker, "commit", "-m", "run checkpoint");
  await writeFile(join(worker, "feature.ts"), "export const v = 2;\n"); // unstaged edit
  await writeFile(join(worker, "late.ts"), "export const late = true;\n"); // untracked addition
  await mkdir(join(worker, ".beckett"), { recursive: true });
  await writeFile(join(worker, ".beckett", "notes.md"), "internal scaffolding\n");

  // Main moved on while the run worked (proves the run's OWN branch, not main, is what publish touches).
  await git(root, "clone", "-b", "main", `file://${remote}`, other);
  await git(other, "config", "user.email", "test@example.com");
  await git(other, "config", "user.name", "Test");
  await writeFile(join(other, "elsewhere.md"), "landed meanwhile\n");
  await git(other, "add", ".");
  await git(other, "commit", "-m", "someone else landed");
  await git(other, "push", "origin", "main");

  const calls: string[] = [];
  const gh = new GitHubCli({
    pat: "tok",
    account: "0xbeckett",
    apiBase: "https://api.github.com",
    resolveRepoDir: () => worker,
    logger: noopLog,
    run: (async (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => {
      const j = cmd.join(" ");
      calls.push(j);
      if (cmd[0] === "git") return realRun(cmd, opts);
      if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
      if (j.includes("api --method PATCH")) return ok();
      if (j.includes("--json defaultBranchRef")) return ok("main");
      if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
      if (j.startsWith("gh pr list")) return noOpenPr();
      if (j.startsWith("gh pr create")) return prCreated(1);
      if (j.startsWith("gh pr view 1")) return prView(1);
      if (j.startsWith("gh pr merge 1")) return ok();
      return fail(`unrouted: ${j}`);
    }) as never,
  });
  (gh as unknown as { gitHost: () => string }).gitHost = () => `file://${root}`;
  return { remote, worker, gh, calls };
}

/**
 * 2026-08-14: a run's publish tripped on "cannot rebase: You have unstaged changes. error:
 * additionally, your index contains uncommitted changes." — a stall no retry could ever clear,
 * because the dirty state was our own doing (the run's private worktree). The publish path commits
 * that loose work up front so it actually ships, rather than leaving it stranded uncommitted. Real
 * git: the branch that lands on the remote must actually carry the committed content.
 */
test("a dirty publish checkout is committed, and the committed work is what reaches the remote branch (2026-08-14)", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-dirty-"));
  try {
    const { remote, worker, gh, calls } = await dirtyPublishFixture(root, "run-worktree");

    const result = await gh.ensurePublished({
      slug: "beckett",
      sourceDir: worker,
      description: "run title",
      ticket: "OPS-dirty",
      commitMessage: "the run's summary",
    });

    expect(result.kind).toBe("pushed");
    expect(result.prUrl).toBe("https://github.com/0xbeckett/beckett/pull/1");
    // No local rebase/apply ever runs — GitHub does the integration.
    expect(calls.some((call) => call.startsWith("git rebase") || call.startsWith("git apply"))).toBe(false);
    // Every bit of the loose work shipped on the run's OWN branch — committing it, not stashing it,
    // is what delivers the run. Main itself is never touched (the merge is GitHub's, faked here).
    expect(await git(root, "--git-dir", remote, "show", "beckett/ops-dirty:feature.ts")).toBe("export const v = 2;");
    expect(await git(root, "--git-dir", remote, "show", "beckett/ops-dirty:late.ts")).toBe("export const late = true;");
    // …and the internal scaffolding still never leaves the machine.
    expect(
      (await realRun(["git", "--git-dir", remote, "cat-file", "-e", "beckett/ops-dirty:.beckett/notes.md"])).code,
    ).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000); // real-git: many shell-outs; needs headroom over the 5s default under full-suite parallel load

/**
 * #15 (overhaul seams review): a worker can write a root `spec.md` mid-run (the legacy location —
 * the spawn-time migration only fires when `.beckett/spec.md` does not already exist), and it is
 * UNTRACKED, so `commitStrayWorkingTree`'s dirty-tree commit would previously stage and commit it
 * (only `.beckett/` was excluded), landing it on the pushed branch before `stripHarnessState`'s
 * follow-up cleanup commit ever ran. `assertNoHarnessState`, which existed to catch exactly this,
 * ran BEFORE `commitStrayWorkingTree` and so never saw it. Both must now be fixed: the stray
 * `spec.md` is excluded from the commit (same as `.beckett/`) and never reaches the pushed branch
 * at all — assert against real git that the pushed tree carries no `spec.md`.
 */
test("a stray run-stamped root spec.md written mid-run never reaches the pushed branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-stray-spec-"));
  try {
    const { remote, worker, gh } = await dirtyPublishFixture(root, "run-worktree");
    await writeFile(
      join(worker, "spec.md"),
      "# Fixture\n> run: run-x · branch: beckett/run-x · created: yesterday\n\n## Checklist\n- [x] done\n",
    );

    const result = await gh.ensurePublished({
      slug: "beckett",
      sourceDir: worker,
      description: "run title",
      ticket: "OPS-dirty",
      commitMessage: "the run's summary",
    });

    expect(result.kind).toBe("pushed");
    expect((await realRun(["git", "--git-dir", remote, "cat-file", "-e", "beckett/ops-dirty:spec.md"])).code).not.toBe(0);
    // Never committed at all — it's still sitting untracked in the worktree, not merely stripped
    // in a follow-up commit after already having been pushed.
    expect(await git(worker, "status", "--porcelain", "--", "spec.md")).toContain("spec.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000); // real-git: many shell-outs; needs headroom over the 5s default under full-suite parallel load

/**
 * The flip side of the fix above (review finding on B15's "should" half): the exclusion is only
 * ever ours to apply to a RUN-STAMPED spec.md. An UNSTAMPED root spec.md — the customer's own
 * file, never rendered by `renderSpecScaffold` — edited mid-run must still reach the pushed
 * branch: excluding it unconditionally would silently drop that edit from the publish commit.
 */
test("an unstamped root spec.md edited mid-run still reaches the pushed branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-unstamped-spec-"));
  try {
    const { remote, worker, gh } = await dirtyPublishFixture(root, "run-worktree");
    await writeFile(join(worker, "spec.md"), "# A customer's own notes\nNo stamp here.\nEdited mid-run.\n");

    const result = await gh.ensurePublished({
      slug: "beckett",
      sourceDir: worker,
      description: "run title",
      ticket: "OPS-dirty",
      commitMessage: "the run's summary",
    });

    expect(result.kind).toBe("pushed");
    expect(await git(root, "--git-dir", remote, "show", "beckett/ops-dirty:spec.md")).toContain("Edited mid-run.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000); // real-git: many shell-outs; needs headroom over the 5s default under full-suite parallel load

/**
 * The other side of that fix: `sourceDir` is `run.workspace ?? resolveRepoRoot(run)`, so a run with
 * no recorded workspace publishes from the SHARED project checkout — a directory a human also edits
 * in. Auto-committing there would sweep someone's in-progress work into the run's commit and push it.
 * Only a checkout we created (a linked `git worktree`) is ours to tidy; a shared clone's loose edits
 * stay untouched, and (since `git push` only ever sends committed history) never reach the remote —
 * the publish still succeeds on whatever WAS already committed.
 */
test("loose work in a SHARED checkout is never committed by a publish — it isn't ours", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-shared-"));
  try {
    const { remote, worker, gh } = await dirtyPublishFixture(root, "shared-clone");

    const result = await gh.ensurePublished({
      slug: "beckett",
      sourceDir: worker,
      description: "run title",
      ticket: "OPS-dirty",
    });
    expect(result.kind).toBe("pushed");

    // The human's loose edits are still exactly where they left them — uncommitted and unpushed.
    expect(await git(worker, "status", "--porcelain")).toContain("feature.ts");
    expect(await git(worker, "show", "HEAD:feature.ts")).toBe("export const v = 1;");
    expect((await realRun(["git", "--git-dir", remote, "cat-file", "-e", "beckett/ops-dirty:late.ts"])).code).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000); // real-git: many shell-outs; needs headroom over the 5s default under full-suite parallel load

/**
 * `spec.md` moved from `<workspace>/spec.md` to `.beckett/spec.md` (harness state, structurally
 * uncommittable). A legacy tracked, run-stamped `spec.md` (a trunk poisoned by an older beckett, or
 * a worker that force-added past the exclude) must never reach a remote — `stripHarnessState`
 * strips it with a cleanup commit, same as `.beckett/` itself. Real git: the strip's deletion must
 * actually land on the pushed tip, not just pass a fake's argv assertions.
 */
test("publish strips a tracked, run-stamped spec.md and pushes its deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-strip-spec-"));
  try {
    const remoteParent = join(root, "0xbeckett");
    const remote = join(remoteParent, "beckett.git");
    const seed = join(root, "seed");
    const worker = join(root, "worker");
    await mkdir(remoteParent, { recursive: true });
    await git(root, "init", "--bare", remote);
    await git(root, "init", "--initial-branch=main", seed);
    await git(seed, "config", "user.email", "test@example.com");
    await git(seed, "config", "user.name", "Test");
    await writeFile(join(seed, "README.md"), "root\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "root");
    await git(seed, "remote", "add", "origin", `file://${remote}`);
    await git(seed, "push", "origin", "main");

    await git(root, "clone", "-b", "main", `file://${remote}`, worker);
    await git(worker, "config", "user.email", "test@example.com");
    await git(worker, "config", "user.name", "Test");
    await writeFile(join(worker, "feature.ts"), "export const v = 1;\n");
    await writeFile(
      join(worker, "spec.md"),
      "# Fixture\n> run: run-x · branch: beckett/run-x · created: yesterday\n\n## Checklist\n- [x] done\n",
    );
    await git(worker, "add", ".");
    await git(worker, "commit", "-m", "run checkpoint (with a tracked, run-stamped spec.md)");

    const calls: string[] = [];
    const gh = new GitHubCli({
      pat: "tok",
      account: "0xbeckett",
      apiBase: "https://api.github.com",
      resolveRepoDir: () => worker,
      logger: noopLog,
      run: (async (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => {
        const j = cmd.join(" ");
        calls.push(j);
        if (cmd[0] === "git") return realRun(cmd, opts);
        if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
        if (j.includes("api --method PATCH")) return ok();
        if (j.includes("--json defaultBranchRef")) return ok("main");
        if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
        if (j.startsWith("gh pr list")) return noOpenPr();
        if (j.startsWith("gh pr create")) return prCreated(1);
        if (j.startsWith("gh pr view 1")) return prView(1);
        if (j.startsWith("gh pr merge 1")) return ok();
        return fail(`unrouted: ${j}`);
      }) as never,
    });
    (gh as unknown as { gitHost: () => string }).gitHost = () => `file://${root}`;

    const result = await gh.ensurePublished({ slug: "beckett", sourceDir: worker, description: "run title", ticket: "run-x" });

    expect(result.kind).toBe("pushed");
    // Main is untouched (the merge is GitHub's own, faked here) — the strip's deletion must land on
    // the run's OWN pushed branch, the thing that's actually reviewed and merged.
    expect(await git(root, "--git-dir", remote, "show", "beckett/run-x:feature.ts")).toBe("export const v = 1;");
    expect((await realRun(["git", "--git-dir", remote, "cat-file", "-e", "beckett/run-x:spec.md"])).code).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000); // real-git: many shell-outs; needs headroom over the 5s default under full-suite parallel load

/**
 * A customer's own `spec.md` (no `> run:` stamp — never rendered by `renderSpecScaffold`) is not
 * ours to delete: `stripHarnessState`/`assertNoHarnessState` only ever touch a spec.md they can
 * PROVE is Beckett's own bookkeeping.
 */
test("a tracked spec.md with no run stamp is left alone", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh api repos/0xbeckett/beckett/branches/main")) return ok("main");
    if (j.startsWith("git ls-files")) return ok("spec.md\n");
    if (j.startsWith("git show :spec.md")) return ok("# A customer's own notes\nNo stamp here.\n");
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("gh pr list")) return noOpenPr();
    if (j.startsWith("gh pr create")) return prCreated(3);
    if (j.startsWith("gh pr view 3")) return prView(3);
    if (j.startsWith("gh pr merge 3")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" });
  expect(r.kind).toBe("pushed");
  expect(calls.some((c) => c.startsWith("git rm"))).toBe(false);
  const pushes = calls.filter((c) => c.startsWith("git push"));
  expect(pushes[0]).toContain("HEAD:refs/heads/beckett/ops-25");
});

/**
 * `assertNoHarnessState` is the belt-and-suspenders check right after the strip: if `git rm` ran
 * but the tree STILL reports the path tracked (a bug in the strip, or a filesystem the runner lied
 * about), publish must refuse rather than ship it — `classifyPublishError` treats `needs a human`
 * as permanent, so this parks on attempt 1 instead of burning the retry ladder.
 */
test("publish refuses when .beckett is still tracked after the strip", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    // `git rm` reports success, but ls-files STILL names the path — the strip didn't take.
    if (j.startsWith("git ls-files")) return ok(".beckett/notes.md\n");
    if (j.startsWith("git rm")) return ok();
    if (j.startsWith("git -c commit.gpgsign=false commit")) return ok();
    return undefined;
  });
  await expect(gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" })).rejects.toThrow(
    /needs a human/,
  );
  expect(calls.some((c) => c.startsWith("git push"))).toBe(false);
});

/**
 * The limit of "commit the loose work": loose means work no stage got around to committing, NOT a
 * half-finished merge. `git status --porcelain` reports an unmerged file as `UU`, and `git add -A`
 * stages it verbatim — conflict markers and all — so an unguarded auto-commit would have pushed
 * `<<<<<<<`/`>>>>>>>` to trunk under the run's own summary, which is strictly worse than the stall
 * it was fixing. A conflicted tree is a human's call: park on attempt 1 naming the files.
 */
test("a publish checkout with UNRESOLVED conflicts parks — it never commits conflict markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-conflict-"));
  try {
    const { remote, worker, gh, calls } = await dirtyPublishFixture(root, "run-worktree");

    // Turn the loose work into a genuine unmerged index: commit our side, then merge a branch that
    // touched the same lines. Real git, real `UU` — not a hand-written status string.
    await git(worker, "add", "feature.ts", "late.ts");
    await git(worker, "commit", "-m", "run work"); // our side: feature.ts = 2
    await git(worker, "checkout", "-b", "sidecar", "HEAD~1");
    await writeFile(join(worker, "feature.ts"), "export const v = 99;\n");
    await git(worker, "add", "feature.ts");
    await git(worker, "commit", "-m", "conflicting edit");
    await git(worker, "checkout", "beckett/ops-dirty");
    await realRun(["git", "merge", "sidecar"], { cwd: worker }); // expected to conflict
    expect(await git(worker, "status", "--porcelain")).toMatch(/^UU |\nUU /);
    expect(await readFile(join(worker, "feature.ts"), "utf8")).toContain("<<<<<<<");

    const failure = await gh.ensurePublished({
      slug: "beckett",
      sourceDir: worker,
      description: "run title",
      ticket: "OPS-conflict",
      commitMessage: "the run's summary",
    }).then(() => null, (err: Error) => err.message);

    // "needs a human" is what `classifyPublishError` keys on to park on attempt 1 rather than burn
    // the retry ladder, and the message names the file so the human knows what to resolve.
    expect(failure).toMatch(/unresolved merge conflicts/i);
    expect(failure).toMatch(/needs a human/i);
    expect(failure).toContain("feature.ts");

    // Nothing was committed over the conflict, and nothing reached the remote.
    expect(await readFile(join(worker, "feature.ts"), "utf8")).toContain("<<<<<<<");
    expect(calls.some((call) => call.startsWith("git push"))).toBe(false);
    // The remote is untouched: main still carries only what landed before this run.
    for (const path of ["feature.ts", "late.ts"]) {
      expect((await realRun(["git", "--git-dir", remote, "cat-file", "-e", `main:${path}`])).code).not.toBe(0);
    }
    expect(await git(root, "--git-dir", remote, "show", "main:elsewhere.md")).toBe("landed meanwhile");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000); // real-git: many shell-outs; needs headroom over the 5s default under full-suite parallel load

test("case 1 — cloned third-party upstream: fork → push to fork → PR to upstream", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/SSHdotCodes/probabilities.git");
    if (j.startsWith("gh repo fork")) return ok("forked");
    if (j.startsWith("gh repo view 0xbeckett/probabilities --json isFork,parent")) {
      return forkView("SSHdotCodes/probabilities"); // fork ready, verified
    }
    if (j.startsWith("git push")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok("[]");
    if (j.startsWith("gh pr create")) return ok("https://github.com/SSHdotCodes/probabilities/pull/7\n");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "probabilities", sourceDir: "/src", ticket: "OPS-28" });
  expect(r.kind).toBe("pr");
  expect(r.nameWithOwner).toBe("SSHdotCodes/probabilities");
  expect(r.prUrl).toContain("/pull/7");
  expect(calls.some((c) => c.startsWith("gh repo fork SSHdotCodes/probabilities"))).toBe(true);
  // PR is opened against the UPSTREAM with a cross-fork head (0xbeckett:beckett/ops-28).
  const create = calls.find((c) => c.startsWith("gh pr create"))!;
  expect(create).toContain("--repo SSHdotCodes/probabilities");
  expect(create).toContain("0xbeckett:beckett/ops-28");
});

test("case 1a — third-party origin we can push to (collaborator): push to origin, in-repo PR (base main)", async () => {
  // #12/#13: origin is a third-party repo and 0xbeckett is a collaborator there. Publish must derive the
  // head repo + push target from origin (NOT 0xbeckett/<slug>), push the branch to origin, and open
  // a plain in-repo PR — no fork, head is the bare branch, base is origin's default branch.
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/frgmt0/upstream-tool.git");
    if (j.startsWith("gh repo view frgmt0/upstream-tool --json viewerPermission")) return ok("WRITE\n"); // collaborator
    if (j.startsWith("git ls-files")) return ok(""); // no scaffolding to strip
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git push https://github.com/frgmt0/upstream-tool.git")) return ok();
    if (j.startsWith("gh pr list")) return ok("[]");
    if (j.startsWith("gh pr create")) return ok("https://github.com/frgmt0/upstream-tool/pull/3\n");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "upstream-tool", sourceDir: "/src", ticket: "task-7-1" });
  expect(r.kind).toBe("pr");
  expect(r.nameWithOwner).toBe("frgmt0/upstream-tool");
  expect(r.prUrl).toContain("/pull/3");
  // No fork was created — we pushed straight to origin.
  expect(calls.some((c) => c.startsWith("gh repo fork"))).toBe(false);
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("frgmt0/upstream-tool.git");
  expect(push).toContain("HEAD:refs/heads/beckett/task-7-1");
  // The branch is pushed BEFORE the PR is opened.
  const pushIdx = calls.findIndex((c) => c.startsWith("git push"));
  const prIdx = calls.findIndex((c) => c.startsWith("gh pr create"));
  expect(pushIdx).toBeLessThan(prIdx);
  // PR is in-repo: --repo frgmt0/upstream-tool, --base main, --head is the bare branch (no `owner:` prefix).
  const create = calls.find((c) => c.startsWith("gh pr create"))!;
  expect(create).toContain("--repo frgmt0/upstream-tool");
  expect(create).toContain("--base main");
  expect(create).toContain("--head beckett/task-7-1");
  expect(create).not.toContain("0xbeckett:");
});

test("case 1b — third-party upstream we can only read: still forks and opens a cross-fork PR", async () => {
  // The collaborator check reports READ (or is unroutable) → we can't push to origin, so the
  // genuine-fork-of-upstream path is preserved: fork → push to fork → cross-fork PR to upstream.
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/SSHdotCodes/probabilities.git");
    if (j.startsWith("gh repo view SSHdotCodes/probabilities --json viewerPermission")) return ok("READ\n");
    if (j.startsWith("gh repo fork")) return ok("forked");
    if (j.startsWith("gh repo view 0xbeckett/probabilities --json isFork,parent")) {
      return forkView("SSHdotCodes/probabilities");
    }
    if (j.startsWith("git push")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok("[]");
    if (j.startsWith("gh pr create")) return ok("https://github.com/SSHdotCodes/probabilities/pull/7\n");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "probabilities", sourceDir: "/src", ticket: "OPS-28" });
  expect(r.kind).toBe("pr");
  expect(r.nameWithOwner).toBe("SSHdotCodes/probabilities");
  expect(calls.some((c) => c.startsWith("gh repo fork SSHdotCodes/probabilities"))).toBe(true);
  const create = calls.find((c) => c.startsWith("gh pr create"))!;
  expect(create).toContain("--repo SSHdotCodes/probabilities");
  expect(create).toContain("0xbeckett:beckett/ops-28");
});

test("ensureFork: verifies the candidate is a real fork, not just same-named — genuine fork is reused as-is", async () => {
  // 0xbeckett/probabilities really IS a fork of SSHdotCodes/probabilities (parent matches) — no
  // fallback name needed, and `gh repo fork` is never called with `--fork-name`.
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/SSHdotCodes/probabilities.git");
    if (j.startsWith("gh repo view SSHdotCodes/probabilities --json viewerPermission")) return ok("READ\n");
    if (j.startsWith("gh repo fork SSHdotCodes/probabilities --clone=false")) return ok("forked");
    if (j.startsWith("gh repo view 0xbeckett/probabilities --json isFork,parent")) {
      return forkView("SSHdotCodes/probabilities");
    }
    if (j.startsWith("git push")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok("[]");
    if (j.startsWith("gh pr create")) return ok("https://github.com/SSHdotCodes/probabilities/pull/7\n");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "probabilities", sourceDir: "/src", ticket: "OPS-28" });
  expect(r.kind).toBe("pr");
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("0xbeckett/probabilities.git");
  expect(calls.some((c) => c.includes("--fork-name"))).toBe(false);
});

test("ensureFork: same-named repo exists but is NOT a fork of upstream — forks under <name>-fork instead (#110)", async () => {
  // frgmt0/nothing is the genuine upstream; 0xbeckett/nothing is an unrelated mirror we own, cloned
  // so `--project nothing` gets real code (the name collision is deliberate and permanent — #110).
  // ensureFork must never hand back the mirror: pushing there and opening a cross-fork PR against it
  // fails outright, since GitHub has no fork relationship between the two repos.
  let forkedUnderDistinctName = false; // flips once `--fork-name nothing-fork` actually runs
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/frgmt0/nothing.git");
    if (j.startsWith("gh repo view frgmt0/nothing --json viewerPermission")) return ok("READ\n");
    if (j.startsWith("gh repo fork frgmt0/nothing --clone=false --fork-name nothing-fork")) {
      forkedUnderDistinctName = true;
      return ok("forked");
    }
    if (j.startsWith("gh repo fork frgmt0/nothing --clone=false")) return ok("forked");
    if (j.startsWith("gh repo view 0xbeckett/nothing --json isFork,parent")) return notAForkView(); // the mirror
    if (j.startsWith("gh repo view 0xbeckett/nothing-fork --json isFork,parent")) {
      // Only queryable AFTER the distinct-name fork actually ran — proves ensureFork doesn't just
      // assume success, and that the earlier reuse-check (before forking) correctly saw "not found".
      return forkedUnderDistinctName ? forkView("frgmt0/nothing") : fail("404");
    }
    if (j.startsWith("git push")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok("[]");
    if (j.startsWith("gh pr create")) return ok("https://github.com/frgmt0/nothing/pull/5\n");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "nothing", sourceDir: "/src", ticket: "task-72-2" });
  expect(r.kind).toBe("pr");
  expect(r.prUrl).toContain("/pull/5");
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("0xbeckett/nothing-fork.git"); // pushed to the FORK, never the mirror
  const create = calls.find((c) => c.startsWith("gh pr create"))!;
  expect(create).toContain("0xbeckett:beckett/task-72-2");
  expect(
    calls.some((c) => c.startsWith("gh repo fork frgmt0/nothing --clone=false --fork-name nothing-fork")),
  ).toBe(true);
});

test("ensureFork: a pre-existing <name>-fork that IS a real fork of upstream is reused, never re-created", async () => {
  // 0xbeckett/nothing-fork already exists from a prior run and is verified as a real fork. The
  // fallback fork call (`gh repo fork ... --fork-name nothing-fork`) must NOT fire again.
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/frgmt0/nothing.git");
    if (j.startsWith("gh repo view frgmt0/nothing --json viewerPermission")) return ok("READ\n");
    if (j.startsWith("gh repo fork frgmt0/nothing --clone=false")) return ok("forked");
    if (j.startsWith("gh repo view 0xbeckett/nothing --json isFork,parent")) return notAForkView(); // the mirror
    if (j.startsWith("gh repo view 0xbeckett/nothing-fork --json isFork,parent")) return forkView("frgmt0/nothing");
    if (j.startsWith("git push")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok("[]");
    if (j.startsWith("gh pr create")) return ok("https://github.com/frgmt0/nothing/pull/6\n");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "nothing", sourceDir: "/src", ticket: "task-72-3" });
  expect(r.kind).toBe("pr");
  expect(r.prUrl).toContain("/pull/6");
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("0xbeckett/nothing-fork.git");
  // Reused the existing fork — no `--fork-name` fork call was ever made.
  expect(calls.some((c) => c.includes("--fork-name"))).toBe(false);
});

test("idempotent (upstream PR) — an already-open PR is reused, gh pr create is NOT called again", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/SSHdotCodes/probabilities.git");
    if (j.startsWith("gh repo fork")) return ok("forked");
    if (j.startsWith("gh repo view 0xbeckett/probabilities --json isFork,parent")) {
      return forkView("SSHdotCodes/probabilities");
    }
    if (j.startsWith("git push")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("gh pr list")) return ok('[{"number":99,"url":"https://github.com/SSHdotCodes/probabilities/pull/99"}]');
    if (j.startsWith("gh pr create")) return ok("SHOULD-NOT-BE-CALLED");
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "probabilities", sourceDir: "/src", ticket: "OPS-28" });
  expect(r.prUrl).toContain("/pull/99");
  expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
  // The check happens before fork/push/create, so an outbox replay does not race into another PR.
  expect(calls.some((c) => c.startsWith("git push"))).toBe(false);
  expect(calls.some((c) => c.startsWith("gh repo fork"))).toBe(false);
});

// The signal `beckett finish` uses to tell "already merged" apart from "the base branch does not
// exist yet" (2026-08-14, `kowo-co/babble`: an EMPTY GitHub repo, so no `main` at all).
test("branchExists reports a real branch, a 404 branch, and an empty repo distinctly", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("gh api repos/kowo-co/beckett/branches/main")) return ok("main\n");
    if (j.startsWith("gh api repos/kowo-co/babble/branches/main")) return fail("gh: Not Found (HTTP 404)", 1);
    return undefined;
  });
  expect(await gh.branchExists("kowo-co/beckett", "main")).toBe(true);
  // An empty repo has no branches at all — a 404, which must read as "does not exist", never as an
  // error the caller has to guess about.
  expect(await gh.branchExists("kowo-co/babble", "main")).toBe(false);
  // A read, not a write: nothing here creates or pushes anything.
  expect(calls.every((c) => c.startsWith("gh api repos/"))).toBe(true);
});

// An EMPTY repo (exists, no commits) has no default branch, and `gh -q .defaultBranchRef.name`
// prints the literal `null` for it — exit 0. Publishing a project's first commits to a branch
// called `null` is how "the repo existed but nothing ever landed on main" happens.
test("case 2 — an owned repo that is EMPTY publishes to main, never to a branch called `null`", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return ok("https://github.com/0xbeckett/babble.git");
    if (j.startsWith("gh repo view 0xbeckett/babble --json name")) return ok('{"name":"babble"}'); // repoExists → yes
    if (j.startsWith("gh api --method PATCH")) return ok(); // setPublic
    if (j.includes("--json defaultBranchRef")) return ok("null\n"); // ← the empty-repo answer
    if (j.startsWith("git ls-files")) return ok("");
    if (j.startsWith("git fetch")) return fail("fatal: couldn't find remote ref main", 128); // no base yet
    if (j.startsWith("git push")) return ok();
    if (j.startsWith("git rev-parse HEAD")) return ok("abc1234\n");
    return undefined;
  });

  const r = await gh.ensurePublished({ slug: "babble", sourceDir: "/src", ticket: "run-1" });

  expect(r.kind).toBe("pushed");
  // Trunk goes FIRST here, run branch second: a branchless repo takes its default branch from
  // whichever ref lands first on GitHub, so pushing `beckett/run-1` first would make IT the repo's
  // new default — the exact kowo-co/babble misconfiguration this whole path exists to close. See
  // "must" finding in the Task 2 review (2026-08-15).
  const pushes = calls.filter((c) => c.startsWith("git push"));
  expect(pushes[0]).toContain("HEAD:refs/heads/main");
  expect(pushes[0]).not.toContain("refs/heads/null");
  expect(pushes[1]).toContain("HEAD:refs/heads/beckett/run-1");
});
