/**
 * v3.2 worktrees — proof against REAL git (no mocks) that the per-ticket worktree path works end
 * to end: a tree cut from a freshly-fetched `origin/main`, nested under `.beckett/worktrees/<id>`
 * (and hidden from the parent's `git add -A`), a correct review-diff base, a branch that carries
 * the ticket's commits for publish, reuse across stages, best-effort fetch, and teardown. The
 * dispatcher fakes these ops in its unit tests, so this file is the only thing that exercises the
 * real git behavior the live daemon depends on.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  removeWorktree,
  fetchRemote,
  headSha,
  readDiff,
  excludeFromGit,
  refExists,
  mergeBranchesIntoWorktree,
  fastForwardCheckout,
  ensureProjectRepo,
  projectRemoteUrl,
  remoteDefaultBranch,
  resolveDefaultBaseRef,
  SCAFFOLDING_DIR,
} from "./worktree.ts";

async function run(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout };
}

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await run(["init", "-b", "main"], dir);
  await run(["config", "user.email", "beckett@test"], dir);
  await run(["config", "user.name", "Beckett"], dir);
  await run(["config", "commit.gpgsign", "false"], dir);
}

let root: string; // holds a bare "origin" + the local clone that stands in for ~/Projects/<slug>
let repo: string;
let origin: string;

/** A project repo cloned from a bare origin, shaped like a provisioned `~/Projects/<slug>`. */
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "beckett-wt-"));
  origin = join(root, "origin.git");
  const seed = join(root, "seed");
  repo = join(root, "clone");

  // Seed an origin with one commit on main.
  await initRepo(seed);
  writeFileSync(join(seed, "base.txt"), "base\n");
  await run(["add", "-A"], seed);
  await run(["commit", "-m", "base on main"], seed);
  await run(["init", "--bare", "-b", "main", origin], root);
  await run(["remote", "add", "origin", origin], seed);
  await run(["push", "origin", "main"], seed);

  // Clone it → the project repo the dispatcher would provision.
  await run(["clone", origin, repo], root);
  await run(["config", "user.email", "beckett@test"], repo);
  await run(["config", "user.name", "Beckett"], repo);
  await run(["config", "commit.gpgsign", "false"], repo);
  await excludeFromGit(repo, [`${SCAFFOLDING_DIR}/`]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const wtPath = (id: string) => join(repo, SCAFFOLDING_DIR, "worktrees", id);

describe("worktree lifecycle (real git)", () => {
  test("creates a worktree on beckett/<ticket> off origin/main, nested under .beckett", async () => {
    const ws = wtPath("t1");
    const handle = await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main", reuseIfExists: true });

    expect(handle.workspace).toBe(ws);
    expect(existsSync(ws)).toBe(true);
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], ws)).stdout.trim()).toBe("beckett/t1");
    // Branched from origin/main, not a HEAD-fallback that would mask a broken fetch.
    const wtBase = (await run(["rev-parse", "HEAD"], ws)).stdout.trim();
    const originMain = (await run(["rev-parse", "origin/main"], repo)).stdout.trim();
    expect(wtBase).toBe(originMain);
  }, 30_000); // real-git: fetch + worktree create shell-outs; needs headroom over the 5s default under full-suite parallel load

  test("the nested worktree is hidden from the parent repo's git add -A", async () => {
    await createWorktree({ repoRoot: repo, workspace: wtPath("t1"), branch: "beckett/t1", baseRef: "origin/main" });
    writeFileSync(join(repo, "real.txt"), "parent work\n");
    await run(["add", "-A"], repo);
    const staged = (await run(["diff", "--cached", "--name-only"], repo)).stdout;
    expect(staged).toContain("real.txt");
    expect(staged).not.toContain(SCAFFOLDING_DIR); // the worktree dir never leaks into the parent index
  });

  test("review diff base: work committed in the worktree shows against its base sha (publish payload)", async () => {
    const ws = wtPath("t1");
    await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main" });
    const base = await headSha(ws); // captured before any work — the review diff base
    expect(base).toBeTruthy();

    writeFileSync(join(ws, "feature.ts"), "export const shipped = true;\n");
    await run(["add", "-A"], ws);
    await run(["commit", "-m", "beckett: t1 implement"], ws);

    // What a reviewer sees, and what publish would push on beckett/t1: exactly the ticket's work.
    const diff = await readDiff(ws, base!);
    expect(diff).toContain("feature.ts");
    expect(diff).toContain("shipped");
    // The branch tip is the ticket's commit on top of the fetched base → a clean push/rebase.
    expect((await run(["rev-list", "--count", `${base}..HEAD`], ws)).stdout.trim()).toBe("1");
  });

  test("reuseIfExists returns the SAME tree across stages (implement → review), keeping its work", async () => {
    const ws = wtPath("t1");
    await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main", reuseIfExists: true });
    writeFileSync(join(ws, "wip.txt"), "in progress\n");

    // A later stage re-allocates: must NOT wipe the tree or re-cut from main.
    const again = await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main", reuseIfExists: true });
    expect(again.workspace).toBe(ws);
    expect(existsSync(join(ws, "wip.txt"))).toBe(true);
  });

  test("migrates a legacy '#'-named worktree to the sanitized path, keeping uncommitted work (#134)", async () => {
    // A pre-#134 daemon cut the tree at the raw ticket id, so the dir literally contains '#'.
    const legacy = wtPath("#131");
    await createWorktree({ repoRoot: repo, workspace: legacy, branch: "beckett/131", baseRef: "origin/main" });
    writeFileSync(join(legacy, "wip.txt"), "in progress, not yet committed\n");

    // A deploy re-staffs the ticket: workspaceByTicket is empty, so the dispatcher asks to (re)create
    // the tree at the SANITIZED path and hands over the legacy path to migrate forward.
    const sanitized = wtPath("131");
    const handle = await createWorktree({
      repoRoot: repo,
      workspace: sanitized,
      branch: "beckett/131",
      baseRef: "origin/main",
      reuseIfExists: true,
      legacyWorkspace: legacy,
    });

    expect(handle.workspace).toBe(sanitized);
    expect(existsSync(sanitized)).toBe(true);
    expect(existsSync(legacy)).toBe(false); // no orphaned '#'-named tree left behind
    expect(existsSync(join(sanitized, "wip.txt"))).toBe(true); // uncommitted work followed the move
    // git's registration points at the new path, not the old one.
    const list = (await run(["worktree", "list"], repo)).stdout;
    expect(list).toContain(sanitized);
    expect(list).not.toContain(legacy);
    // The branch is checked out exactly once — a fresh add here would have failed otherwise.
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], sanitized)).stdout.trim()).toBe("beckett/131");
  });

  test("removeWorktree tears the tree down and deregisters it", async () => {
    const ws = wtPath("t1");
    await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/main" });
    expect(existsSync(ws)).toBe(true);

    await removeWorktree(repo, ws);
    expect(existsSync(ws)).toBe(false);
    const list = (await run(["worktree", "list"], repo)).stdout;
    expect(list).not.toContain(ws);
  });

  test("a dependent worktree can compose completed local task branches", async () => {
    const first = wtPath("first");
    const second = wtPath("second");
    await createWorktree({ repoRoot: repo, workspace: first, branch: "beckett/task-1-1", baseRef: "origin/main" });
    writeFileSync(join(first, "api.ts"), "export const api = true;\n");
    await run(["add", "-A"], first);
    await run(["commit", "-m", "api"], first);
    await createWorktree({ repoRoot: repo, workspace: second, branch: "beckett/task-1-2", baseRef: "origin/main" });
    writeFileSync(join(second, "ui.ts"), "export const ui = true;\n");
    await run(["add", "-A"], second);
    await run(["commit", "-m", "ui"], second);

    expect(await refExists(repo, "beckett/task-1-1")).toBe(true);
    const dependent = wtPath("dependent");
    await createWorktree({
      repoRoot: repo,
      workspace: dependent,
      branch: "beckett/task-1-3",
      baseRef: "beckett/task-1-1",
    });
    await mergeBranchesIntoWorktree(dependent, ["beckett/task-1-2"]);
    expect(existsSync(join(dependent, "api.ts"))).toBe(true);
    expect(existsSync(join(dependent, "ui.ts"))).toBe(true);
  });

  test("fetchRemote succeeds on a real origin and is a no-op (not a throw) with none", async () => {
    expect(await fetchRemote(repo)).toBe(true); // has origin
    const noRemote = mkdtempSync(join(tmpdir(), "beckett-noremote-"));
    try {
      await initRepo(noRemote);
      expect(await fetchRemote(noRemote)).toBe(false); // best-effort, never throws
    } finally {
      rmSync(noRemote, { recursive: true, force: true });
    }
  });

  test("an absent base ref falls back to the DEFAULT BRANCH, not to a sibling run's checked-out HEAD", async () => {
    // A sibling run is in flight against the same project, so the shared checkout is sitting on ITS
    // branch, carrying ITS work. Falling back to `HEAD` here (the old behavior) cut the new run's
    // tree from the sibling and made its publish rebase replay a sibling's commits (2026-08-14).
    await run(["checkout", "-q", "-b", "beckett/run-sibling"], repo);
    writeFileSync(join(repo, "sibling.txt"), "the sibling run's in-progress work\n");
    await run(["add", "-A"], repo);
    await run(["commit", "-m", "sibling run checkpoint"], repo);

    const ws = wtPath("t1");
    const handle = await createWorktree({ repoRoot: repo, workspace: ws, branch: "beckett/t1", baseRef: "origin/does-not-exist" });

    expect(existsSync(handle.workspace)).toBe(true);
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], ws)).stdout.trim()).toBe("beckett/t1");
    const originMain = (await run(["rev-parse", "origin/main"], repo)).stdout.trim();
    expect((await run(["rev-parse", "HEAD"], ws)).stdout.trim()).toBe(originMain);
    expect(existsSync(join(ws, "sibling.txt"))).toBe(false); // the sibling's work never came along
  });

  describe("the base/rebase target is the remote's default branch, never local checkout state", () => {
    /**
     * A second project fixture whose default branch is `trunk` — so `origin/main` genuinely does not
     * exist and the supervisor's requested base ref must be replaced by something. The only correct
     * answer is what the remote calls default; the wrong one is whatever is checked out locally.
     */
    async function trunkProject(): Promise<string> {
      const seed = join(root, "trunk-seed");
      const bare = join(root, "trunk-origin.git");
      const clone = join(root, "trunk-clone");
      mkdirSync(seed, { recursive: true });
      await run(["init", "-b", "trunk"], seed);
      await run(["config", "user.email", "beckett@test"], seed);
      await run(["config", "user.name", "Beckett"], seed);
      await run(["config", "commit.gpgsign", "false"], seed);
      writeFileSync(join(seed, "base.txt"), "base\n");
      await run(["add", "-A"], seed);
      await run(["commit", "-m", "base on trunk"], seed);
      await run(["init", "--bare", "-b", "trunk", bare], root);
      await run(["remote", "add", "origin", bare], seed);
      await run(["push", "origin", "trunk"], seed);
      await run(["clone", bare, clone], root);
      await run(["config", "user.email", "beckett@test"], clone);
      await run(["config", "user.name", "Beckett"], clone);
      await run(["config", "commit.gpgsign", "false"], clone);
      return clone;
    }

    test("the default branch is read from origin/HEAD, and from a live ls-remote when none is recorded", async () => {
      const project = await trunkProject();
      expect(await remoteDefaultBranch(project)).toBe("trunk");
      expect(await resolveDefaultBaseRef(project)).toBe("origin/trunk");

      // A checkout provisioned by `git init` + `remote add` (the empty-repo path) has no recorded
      // `origin/HEAD` at all — the live symref lookup still answers, so the fallback stays remote-derived.
      await run(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], project);
      expect(await remoteDefaultBranch(project)).toBe("trunk");
      expect(await resolveDefaultBaseRef(project)).toBe("origin/trunk");
    }, 30_000);

    test("with a SIBLING run's branch checked out, a new worktree is still cut from the default branch", async () => {
      const project = await trunkProject();
      // Run A in flight: the shared checkout is on its branch, holding a commit main doesn't have.
      await run(["checkout", "-q", "-b", "beckett/run-sibling"], project);
      writeFileSync(join(project, "sibling.txt"), "run A's in-progress work\n");
      await run(["add", "-A"], project);
      await run(["commit", "-m", "run A checkpoint"], project);
      expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], project)).stdout.trim()).toBe("beckett/run-sibling");
      expect((await run(["rev-parse", "--verify", "--quiet", "origin/main"], project)).code).not.toBe(0);

      // Run B starts. The supervisor asks for `origin/main`; this repo's default is `trunk`.
      const ws = join(project, SCAFFOLDING_DIR, "worktrees", "run-mine");
      await createWorktree({ repoRoot: project, workspace: ws, branch: "beckett/run-mine", baseRef: "origin/main" });

      const trunkTip = (await run(["rev-parse", "origin/trunk"], project)).stdout.trim();
      expect((await run(["rev-parse", "HEAD"], ws)).stdout.trim()).toBe(trunkTip);
      expect(existsSync(join(ws, "sibling.txt"))).toBe(false); // never based on the sibling's branch
      expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], ws)).stdout.trim()).toBe("beckett/run-mine");
    }, 30_000);
  });

  describe("fastForwardCheckout (#91 — land keeps ~/Projects/<slug> current)", () => {
    /** Simulate a ticket landing directly on `main`: push a new commit to `origin` from a fresh clone, exactly as a direct-push publish would. */
    async function pushLandingCommit(): Promise<string> {
      const pusher = mkdtempSync(join(tmpdir(), "beckett-pusher-"));
      try {
        await run(["clone", origin, pusher], root);
        await run(["config", "user.email", "beckett@test"], pusher);
        await run(["config", "user.name", "Beckett"], pusher);
        await run(["config", "commit.gpgsign", "false"], pusher);
        writeFileSync(join(pusher, "landed.txt"), "landed\n");
        await run(["add", "-A"], pusher);
        await run(["commit", "-m", "ticket work"], pusher);
        await run(["push", "origin", "main"], pusher);
        return (await run(["rev-parse", "HEAD"], pusher)).stdout.trim();
      } finally {
        rmSync(pusher, { recursive: true, force: true });
      }
    }

    test("a clean checkout on main is fast-forwarded to the landed commit", async () => {
      const landedSha = await pushLandingCommit();
      expect((await run(["rev-parse", "HEAD"], repo)).stdout.trim()).not.toBe(landedSha); // still stale

      const result = await fastForwardCheckout(repo, origin, "main");

      expect(result.status).toBe("fast-forwarded");
      expect(result.sha).toBe(landedSha);
      expect((await run(["rev-parse", "HEAD"], repo)).stdout.trim()).toBe(landedSha);
      expect(existsSync(join(repo, "landed.txt"))).toBe(true);
    });

    test("a dirty checkout is left untouched and the skip is logged with the reason", async () => {
      const landedSha = await pushLandingCommit();
      const staleSha = (await run(["rev-parse", "HEAD"], repo)).stdout.trim();
      writeFileSync(join(repo, "uncommitted.txt"), "wip\n"); // dirty the working tree

      const result = await fastForwardCheckout(repo, origin, "main");

      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/uncommitted/i);
      // Never fast-forwarded, never merged/forced — HEAD didn't move and the dirty file survived.
      expect((await run(["rev-parse", "HEAD"], repo)).stdout.trim()).toBe(staleSha);
      expect((await run(["rev-parse", "HEAD"], repo)).stdout.trim()).not.toBe(landedSha);
      expect(existsSync(join(repo, "uncommitted.txt"))).toBe(true);
    });

    test("a checkout on another branch (incl. detached HEAD) is left untouched", async () => {
      await pushLandingCommit();
      await run(["checkout", "-b", "some-other-branch"], repo);

      const result = await fastForwardCheckout(repo, origin, "main");

      expect(result.status).toBe("skipped");
      expect(result.reason).toMatch(/some-other-branch/);
      expect((await run(["rev-parse", "--abbrev-ref", "HEAD"], repo)).stdout.trim()).toBe("some-other-branch");
    });
  });
});

/**
 * Provisioning a project repo (`ensureProjectRepo`) — the 2026-08-14 defect. `babble` existed on
 * GitHub but was completely EMPTY, so the `ls-remote` probe below did not resolve it, provisioning
 * took the `git init` path, and that path wired NO remote at all. `git remote -v` was empty in the
 * checkout and in every worktree cut from it, so the finished run had nowhere to push: it sat in
 * `publishing` forever and `beckett finish` had nothing to compare against.
 *
 * `remote` is injected here so this runs against a local bare repo instead of github.com — the
 * assertions are about which remote ends up configured, not about who is hosting it.
 */
describe("ensureProjectRepo wires a usable origin on BOTH provisioning paths", () => {
  let projects: string;
  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), "beckett-projects-"));
  });
  afterEach(() => rmSync(projects, { recursive: true, force: true }));

  const originOf = async (dir: string) => (await run(["remote", "get-url", "origin"], dir)).stdout.trim();

  test("the init path (repo empty/unreachable on GitHub) still ends with origin configured", async () => {
    const target = join(projects, "babble");
    const remote = join(projects, "unreachable", "babble.git"); // nothing there → ls-remote fails

    await ensureProjectRepo(target, "babble", "kowo-co", remote);

    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(await originOf(target)).toBe(remote);
    // …and it is on `main`, so the first push creates the branch publishing expects.
    expect((await run(["symbolic-ref", "--short", "HEAD"], target)).stdout.trim()).toBe("main");
  });

  test("a worktree cut from an init-provisioned repo inherits that remote (they share .git/config)", async () => {
    const target = join(projects, "babble");
    const remote = join(projects, "unreachable", "babble.git");
    await ensureProjectRepo(target, "babble", "kowo-co", remote);

    const ws = join(target, SCAFFOLDING_DIR, "worktrees", "run-1");
    await createWorktree({ repoRoot: target, workspace: ws, branch: "beckett/run-1", baseRef: "origin/main", reuseIfExists: true });

    expect(await originOf(ws)).toBe(remote);
  });

  test("the clone path keeps the origin git itself configured", async () => {
    const target = join(projects, "cloned");
    await ensureProjectRepo(target, "cloned", "kowo-co", origin);

    expect(await originOf(target)).toBe(origin);
    expect(existsSync(join(target, "base.txt"))).toBe(true); // really cloned, not re-inited
  });

  test("an EXISTING checkout left remote-less by the old code path is repaired in place", async () => {
    const target = join(projects, "legacy");
    await initRepo(target); // a checkout with commits and no remote — exactly the babble shape
    writeFileSync(join(target, "work.txt"), "built\n");
    await run(["add", "-A"], target);
    await run(["commit", "-m", "the whole build"], target);
    const before = (await run(["rev-parse", "HEAD"], target)).stdout.trim();

    await ensureProjectRepo(target, "legacy", "kowo-co", join(projects, "unreachable", "legacy.git"));

    expect(await originOf(target)).toBe(join(projects, "unreachable", "legacy.git"));
    expect((await run(["rev-parse", "HEAD"], target)).stdout.trim()).toBe(before); // history untouched
  });

  test("an existing origin is NEVER clobbered — a third-party upstream still publishes upstream", async () => {
    const target = join(projects, "fork-of-someones-repo");
    await initRepo(target);
    await run(["remote", "add", "origin", "https://github.com/someone-else/their-repo.git"], target);

    await ensureProjectRepo(target, "fork-of-someones-repo", "kowo-co", join(projects, "unreachable", "x.git"));

    expect(await originOf(target)).toBe("https://github.com/someone-else/their-repo.git");
  });

  test("projectRemoteUrl is the one place the GitHub URL is spelled", () => {
    expect(projectRemoteUrl("kowo-co", "babble")).toBe("https://github.com/kowo-co/babble.git");
  });
});
