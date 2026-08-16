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

test("#246 — a run's raw checkpoint commits squash into ONE before push, and prUrl is a real commit URL (never the bare repo root)", async () => {
  const { gh, calls } = cli((j) => {
    if (j.startsWith("git remote get-url origin")) return fail("no origin");
    if (j.startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}'); // exists
    if (j.includes("api --method PATCH")) return ok(); // setPublic
    if (j.includes("--json defaultBranchRef")) return ok("main");
    if (j.startsWith("git rev-parse --verify --quiet HEAD")) return ok("tipsha0000000");
    if (j.startsWith("git rev-parse --verify --quiet wk_base")) return ok("basesha0000000");
    if (j.startsWith("git merge-base --is-ancestor")) return ok(); // base IS an ancestor of the checkpoints
    if (j.startsWith("git rev-list --count")) return ok("5"); // five raw checkpoint commits, like f9383c0..07d1480
    if (j.startsWith("git reset --soft basesha0000000")) return ok();
    if (j.startsWith("git -c commit.gpgsign=false commit")) return ok();
    if (j.startsWith("git fetch")) return ok(); // remote tip present
    if (j.startsWith("git rebase")) return ok(); // clean rebase (the squashed commit applies cleanly)
    if (j.startsWith("git push")) return ok();
    if (j === "git rev-parse HEAD") return ok("landedsha0000000"); // the sha actually pushed
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
  // Squashed BEFORE the fetch/rebase/push — the raw checkpoint history never even reaches them.
  expect(calls.some((c) => c.startsWith("git reset --soft basesha0000000"))).toBe(true);
  const commit = calls.find((c) => c.startsWith("git -c commit.gpgsign=false commit"))!;
  expect(commit).toContain("run title");
  expect(commit).toContain("review summary / mechanism writeup");
  // Exactly one squash commit landed — not five raw "checkpoint (wk_...)" commits.
  expect(calls.filter((c) => c.startsWith("git -c commit.gpgsign=false commit")).length).toBe(1);
  // prUrl is a REAL, non-root URL (the commit), matching what the Discord publish announcement renders.
  expect(r.prUrl).toBeDefined();
  expect(r.prUrl).toContain("/commit/landedsha0000000");
  expect(r.prUrl).not.toBe(`${"https://github.com"}/0xbeckett/beckett`);
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

/**
 * A publish checkout carrying loose, uncommitted work, against a remote whose `main` moved on — so
 * the publish must genuinely rebase, and `git rebase` genuinely refuses on the dirty tree. `checkout`
 * picks WHOSE dirt it is: a run's own `git worktree add` checkout (ours to commit), or a shared
 * project clone (a human's, never ours to commit).
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

  // Main moved on while the run worked, so the publish must actually rebase (not fast-forward).
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
      calls.push(cmd.join(" "));
      if (cmd[0] === "git") return realRun(cmd, opts);
      if (cmd.join(" ").startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
      if (cmd.join(" ").includes("api --method PATCH")) return ok();
      if (cmd.join(" ").includes("--json defaultBranchRef")) return ok("main");
      return fail(`unrouted: ${cmd.join(" ")}`);
    }) as never,
  });
  (gh as unknown as { gitHost: () => string }).gitHost = () => `file://${root}`;
  return { remote, worker, gh, calls };
}

/**
 * 2026-08-14: a run's publish tripped on "cannot rebase: You have unstaged changes. error:
 * additionally, your index contains uncommitted changes." and then burned its whole retry ladder on
 * a state no retry could ever clear. The dirty tree is OUR OWN doing — it's the run's private
 * worktree — so the publish path commits that loose work before it rebases, rather than handing a
 * human an error we caused ourselves. Real git: the rebase has to genuinely refuse for this to mean
 * anything.
 */
test("a dirty publish checkout is committed BEFORE the rebase, instead of failing it (2026-08-14)", async () => {
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

    // The rebase ran and stuck — no abort, no "needs a human" park over a mess we made ourselves.
    expect(result.kind).toBe("pushed");
    expect(calls.some((call) => call.startsWith("git rebase FETCH_HEAD"))).toBe(true);
    expect(calls.some((call) => call.startsWith("git rebase --abort"))).toBe(false);
    // Every bit of the loose work shipped — committing it, not stashing it, is what delivers the run.
    expect(await git(root, "--git-dir", remote, "show", "main:feature.ts")).toBe("export const v = 2;");
    expect(await git(root, "--git-dir", remote, "show", "main:late.ts")).toBe("export const late = true;");
    expect(await git(root, "--git-dir", remote, "show", "main:elsewhere.md")).toBe("landed meanwhile");
    // …and the internal scaffolding still never leaves the machine.
    expect((await realRun(["git", "--git-dir", remote, "cat-file", "-e", "main:.beckett/notes.md"])).code).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000); // real-git: many shell-outs; needs headroom over the 5s default under full-suite parallel load

/**
 * The other side of that fix, and the reason it is gated rather than unconditional: `sourceDir` is
 * `run.workspace ?? resolveRepoRoot(run)`, so a run with no recorded workspace publishes from the
 * SHARED project checkout — a directory a human also edits in. Auto-committing there would sweep
 * someone's in-progress work into the run's commit and push it. Only a checkout we created (a linked
 * `git worktree`) is ours to tidy; anywhere else the dirty tree stays untouched and the publish fails
 * loudly, which `classifyPublishError` already treats as terminal (park on attempt 1, real reason).
 */
test("loose work in a SHARED checkout is never committed by a publish — it isn't ours", async () => {
  const root = await mkdtemp(join(tmpdir(), "beckett-publish-shared-"));
  try {
    const { remote, worker, gh } = await dirtyPublishFixture(root, "shared-clone");

    await expect(
      gh.ensurePublished({ slug: "beckett", sourceDir: worker, description: "run title", ticket: "OPS-dirty" }),
    ).rejects.toThrow(/unstaged changes|uncommitted changes|cannot rebase/i);

    // The human's loose edits are still exactly where they left them — uncommitted and unpushed.
    expect(await git(worker, "status", "--porcelain")).toContain("feature.ts");
    expect(await git(worker, "show", "HEAD:feature.ts")).toBe("export const v = 1;");
    expect((await realRun(["git", "--git-dir", remote, "cat-file", "-e", "main:late.ts"])).code).not.toBe(0);
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
        calls.push(cmd.join(" "));
        if (cmd[0] === "git") return realRun(cmd, opts);
        if (cmd.join(" ").startsWith("gh repo view 0xbeckett/beckett --json name")) return ok('{"name":"beckett"}');
        if (cmd.join(" ").includes("api --method PATCH")) return ok();
        if (cmd.join(" ").includes("--json defaultBranchRef")) return ok("main");
        return fail(`unrouted: ${cmd.join(" ")}`);
      }) as never,
    });
    (gh as unknown as { gitHost: () => string }).gitHost = () => `file://${root}`;

    const result = await gh.ensurePublished({ slug: "beckett", sourceDir: worker, description: "run title", ticket: "run-x" });

    expect(result.kind).toBe("pushed");
    expect(await git(root, "--git-dir", remote, "show", "main:feature.ts")).toBe("export const v = 1;");
    expect((await realRun(["git", "--git-dir", remote, "cat-file", "-e", "main:spec.md"])).code).not.toBe(0);
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
    if (j.startsWith("git ls-files")) return ok("spec.md\n");
    if (j.startsWith("git show :spec.md")) return ok("# A customer's own notes\nNo stamp here.\n");
    if (j.startsWith("git fetch")) return ok();
    if (j.startsWith("git rebase")) return ok();
    if (j.startsWith("git push")) return ok();
    return undefined;
  });
  const r = await gh.ensurePublished({ slug: "beckett", sourceDir: "/src", ticket: "OPS-25" });
  expect(r.kind).toBe("pushed");
  expect(calls.some((c) => c.startsWith("git rm"))).toBe(false);
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("HEAD:refs/heads/main");
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
  const push = calls.find((c) => c.startsWith("git push"))!;
  expect(push).toContain("HEAD:refs/heads/main");
  expect(push).not.toContain("refs/heads/null");
});
