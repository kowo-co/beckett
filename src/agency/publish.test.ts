/**
 * Coverage for the hardened GitHub publish path (`GitHubCli.ensurePublished`) — the decision tree
 * that replaced the non-idempotent `gh repo create --remote origin` that stranded OPS-28 (cloned
 * checkout already had an `origin` → publish threw → ticket was already "done" → work never shipped).
 * The subprocess runner is injected, so every branch + its idempotency is exercised without touching
 * live GitHub. Each fake matches on argv and returns canned `gh`/`git` output.
 */

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  target: { account?: string; owner?: string } = {},
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

test("case 2 — repo we already own: integrate remote (fetch+rebase) then push HEAD→default branch", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}'); // exists
    if (j.includes("api --method PATCH")) return ok(); // setPublic
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git fetch")) return ok(); // remote tip present
    if (j.startsWith("git rebase")) return ok(); // clean rebase
    if (j.startsWith("git push")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" });
  expect(r.kind).toBe("pushed"); // owned repos ship straight to main
  // Fetched + rebased the remote tip FIRST (fixes the OPS-25/27 non-fast-forward reject), then pushed main.
  expect(calls.some((c) => c.startsWith("git fetch"))).toBe(true);
  expect(calls.some((c) => c.startsWith("git rebase FETCH_HEAD"))).toBe(true);
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("HEAD:refs/heads/main");
  expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false); // owned repo → no PR
});

test("case 2 — a non-main target branch publishes to THAT branch and never touches main (OPS-185)", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}'); // exists
    if (j.includes("api --method PATCH")) return ok(); // setPublic
    if (j.includes("--json defaultBranchRef")) return ok("main"); // MUST NOT be consulted for a non-main target
    if (j.startsWith("git fetch")) return ok(); // integration branch tip present
    if (j.startsWith("git rebase")) return ok(); // clean rebase onto v5-daemon
    if (j.startsWith("git push")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({
    slug: "beckett",
    sourceDir: "/src",
    ticket: "OPS-180",
    targetBranch: "v5-daemon",
  });
  expect(r.kind).toBe("pushed");
  // Integrated + pushed the INTEGRATION branch, not main.
  const fetch = calls.find((c) => c.startsWith("git fetch"))!;
  expect(fetch).toContain("v5-daemon");
  expect(calls.some((c) => c.startsWith("git rebase FETCH_HEAD"))).toBe(true);
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("HEAD:refs/heads/v5-daemon");
  // The load-bearing guarantee: NOTHING in the whole publish references `main`. No push, no fetch,
  // no rebase advances the default branch, so origin/main is provably untouched. The repo default
  // is never even queried — the target is authoritative.
  expect(calls.some((c) => c.includes("refs/heads/main"))).toBe(false);
  expect(calls.some((c) => c.startsWith("git fetch") && /\bmain\b/.test(c))).toBe(false);
  expect(calls.some((c) => c.includes("--json defaultBranchRef"))).toBe(false);
  expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false); // funnel is a push, not a PR
});

test("case 2 — an explicit `main` target keeps the default-branch publish byte-for-byte", async () => {
  // A ticket that explicitly targets `main` (or none at all) is a normal main-targeted ticket: it
  // must consult the repo default and push HEAD→main exactly as before — the guard is inert here.
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git fetch")) return ok();
    if (j.startsWith("git rebase")) return ok();
    if (j.startsWith("git push")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25", targetBranch: "main" });
  expect(r.kind).toBe("pushed");
  expect(calls.some((c) => c.includes("--json defaultBranchRef"))).toBe(true); // default branch resolved as usual
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("HEAD:refs/heads/main");
});

test("case 2 — a rebase CONFLICT aborts and throws (dispatcher then holds the ticket, no force-push)", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git fetch")) return ok();
    if (j.startsWith("git rebase --abort")) return ok();
    if (j.startsWith("git rebase")) return fail("CONFLICT (content): merge conflict in x");
    if (j.startsWith("git push")) return ok("SHOULD-NOT-PUSH");
    return undefined;
  });
  await expect(gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" })).rejects.toThrow(
    /needs a human/,
  );
  expect(calls.some((c) => c.startsWith("git rebase --abort"))).toBe(true);
  expect(calls.some((c) => c.startsWith("git push"))).toBe(false); // never force over a conflict
});

test("a residual squash-apply conflict names only the remaining files, not the rebase transcript", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git fetch")) return ok();
    if (j.startsWith("git rebase --abort")) return ok();
    if (j.startsWith("git rebase")) return fail("could not apply ancient checkpoint transcript");
    if (j.startsWith("git rev-parse") && j.includes("HEAD")) return ok("tip");
    if (j.startsWith("git rev-parse")) return ok("base");
    if (j.startsWith("git merge-base")) return ok();
    if (j.startsWith("git diff --quiet")) return fail(); // nonempty worker delta
    if (j.startsWith("git diff --name-status")) return ok(); // no deletions
    if (j.startsWith("git branch --show-current")) return ok("beckett/24-3");
    if (j.startsWith("git checkout -B")) return ok();
    if (j.startsWith("git diff --binary")) return ok("diff --git a/a b/a\n");
    if (j.startsWith("git apply --3way")) return fail("conflict internals that a courier does not need");
    if (j.startsWith("git diff --name-only --diff-filter=U")) return ok("snapshot.test.ts\ngenerated-cli.txt\n");
    return undefined;
  });
  let error: Error | undefined;
  try {
    await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", baseSha: "base" });
  } catch (err) {
    error = err as Error;
  }
  expect(error?.message).toContain("snapshot.test.ts, generated-cli.txt");
  expect(error?.message).not.toContain("ancient checkpoint transcript");
  expect(calls.some((call) => call.startsWith("git rebase --abort"))).toBe(true);
});

test("unsafe squash-apply metadata keeps the existing human hold instead of guessing", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
    if (j.includes("api --method PATCH")) return ok();
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git fetch")) return ok();
    if (j.startsWith("git rebase --abort")) return ok();
    if (j.startsWith("git rebase")) return fail("original rebase failure");
    if (j.startsWith("git rev-parse") && j.includes("HEAD")) return ok("tip");
    if (j.startsWith("git rev-parse")) return ok("base");
    if (j.startsWith("git merge-base")) return ok();
    if (j.startsWith("git diff --quiet")) return fail();
    if (j.startsWith("git diff --name-status")) return ok("D\tnever-touched.txt\n");
    if (j.startsWith("git log --format=%H")) return ok(); // no deletion commit in the worker range
    return undefined;
  });
  await expect(gh.ensurePublished({ slug: "beckett", sourceDir: "/src", baseSha: "base" })).rejects.toThrow(
    /original rebase failure/,
  );
  expect(calls.some((call) => call.startsWith("git apply --3way"))).toBe(false);
});

test("a dependent cut from pre-squash predecessor history squash-applies only its own delta", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-squash-"));
  try {
    const remoteParent = join(root, "0xbeckett");
    const remote = join(remoteParent, "beckett.git");
    const seed = join(root, "seed");
    const worker = join(root, "worker");
    const land = join(root, "land");
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
    // These are the predecessor's local checkpoints. The dependent starts at its tip.
    await writeFile(join(worker, "shared.txt"), "checkpoint one\n");
    await git(worker, "add", ".");
    await git(worker, "commit", "-m", "predecessor checkpoint one");
    await writeFile(join(worker, "shared.txt"), "predecessor final\n");
    await git(worker, "add", ".");
    await git(worker, "commit", "-m", "predecessor checkpoint two");
    const predecessorTip = await git(worker, "rev-parse", "HEAD");
    await writeFile(join(worker, "dependent.txt"), "the dependent's only change\n");
    await git(worker, "add", ".");
    await git(worker, "commit", "-m", "dependent checkpoint");

    // Main receives equivalent predecessor content as one squash commit, not the checkpoints.
    await git(root, "clone", "-b", "main", `file://${remote}`, land);
    await git(land, "config", "user.email", "test@example.com");
    await git(land, "config", "user.name", "Test");
    await writeFile(join(land, "shared.txt"), "predecessor final\n");
    await git(land, "add", ".");
    await git(land, "commit", "-m", "squashed predecessor");
    await git(land, "push", "origin", "main");

    const calls: string[] = [];
    const gh = new GitHubCli({
      pat: "tok",
      account: "0xbeckett",
      apiBase: "https://api.github.com",
      resolveRepoDir: () => worker,
      logger: noopLog,
      run: (async (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "git") return realRun(cmd, opts);
        if (cmd.join(" ").startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
        if (cmd.join(" ").includes("api --method PATCH")) return ok();
        if (cmd.join(" ").includes("--json defaultBranchRef")) return ok("main");
        return fail(`unrouted: ${cmd.join(" ")}`);
      }) as never,
    });
    // The client normally derives an HTTPS host. The test keeps all real git transport local.
    (gh as unknown as { gitHost: () => string }).gitHost = () => `file://${root}`;

    const result = await gh.ensurePublished({
      slug: "beckett",
      sourceDir: worker,
      description: "ticket title (not the worker summary)",
      ticket: "24.3",
      baseSha: predecessorTip,
      commitMessage: "dependent worker summary",
    });

    expect(result.kind).toBe("pushed");
    expect(calls.some((call) => call.startsWith("git rebase --abort"))).toBe(true);
    expect(calls.some((call) => call.startsWith("git apply --3way"))).toBe(true);
    expect(await git(root, "--git-dir", remote, "show", "main:dependent.txt")).toBe("the dependent's only change");
    expect(await git(root, "--git-dir", remote, "log", "-1", "--format=%s", "main")).toBe("dependent worker summary");
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
