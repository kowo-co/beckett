/**
 * `beckett gh push`'s wrong-commit guard + read-back verification (2026-08-22).
 *
 * Prior behavior: `--repo <o/n> --branch <remoteBranch>` pushed `--ref` (default `HEAD`) from
 * `--dir` (default cwd) and unconditionally printed `{ pushed: true }` — no sha, no check that
 * the remote actually moved. Run from a checkout on the wrong branch, it silently uploaded the
 * wrong commit under the run's branch name. These tests pin the fix: {@link pushBranchVerified}
 * refuses the footgun case, verifies the remote landed on the intended sha, and still allows the
 * courier's explicit-`--ref` shape and a normal same-named push.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubCli } from "../../agency/index.ts";
import type { Logger } from "../../types.ts";
import { pushBranchVerified } from "./github.ts";

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
type FakeRun = (cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => Promise<RunResult>;

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** Build a GitHubCli whose git/gh subprocesses are routed to canned responses. */
function fakeGh(route: (joined: string, cmd: string[]) => RunResult | undefined): { gh: GitHubCli; calls: string[] } {
  const calls: string[] = [];
  const run: FakeRun = async (cmd) => {
    const joined = cmd.join(" ");
    calls.push(joined);
    if (joined.startsWith("git ls-files")) return ok(""); // no tracked scaffolding to strip
    const routed = route(joined, cmd);
    if (routed) return routed;
    throw new Error(`unrouted: ${joined}`);
  };
  const gh = new GitHubCli({
    pat: "tok",
    account: "0xbeckett",
    owner: undefined,
    apiBase: "https://api.github.com",
    resolveRepoDir: () => "/unused",
    logger: noopLog,
    run: run as never,
  });
  return { gh, calls };
}

/** A real temp git repo, checked out on `branch`, with one commit. Returns { dir, sha }. */
async function makeRepo(branch: string): Promise<{ dir: string; sha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gh-push-test-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args]);
    if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  git("init", "-q", "-b", branch);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(dir, "f.txt"), "1");
  git("add", "f.txt");
  git("commit", "-q", "-m", "one");
  const sha = git("rev-parse", "HEAD");
  return { dir, sha };
}

test("courier call (--dir <worktree> --ref <branch> --branch <branch>) pushes and reports the sha", async () => {
  const { dir, sha } = await makeRepo("run-20260822-example");
  try {
    const { gh, calls } = fakeGh((j) => {
      if (j.startsWith("git push")) return ok();
      if (j.startsWith("git ls-remote")) return ok(`${sha}\trefs/heads/run-20260822-example\n`);
      return undefined;
    });
    const result = await pushBranchVerified(gh, {
      repo: "kowo-co/beckett",
      branch: "run-20260822-example",
      dir,
      ref: "run-20260822-example",
    });
    expect(result).toEqual({ pushed: true, repo: "kowo-co/beckett", branch: "run-20260822-example", ref: "run-20260822-example", sha });
    expect(calls.some((c) => c.startsWith("git push") && c.includes(`run-20260822-example:refs/heads/run-20260822-example`))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pushing the current branch under its own name (no --ref) works and reports the sha", async () => {
  const { dir, sha } = await makeRepo("main");
  try {
    const { gh } = fakeGh((j) => {
      if (j.startsWith("git push")) return ok();
      if (j.startsWith("git ls-remote")) return ok(`${sha}\trefs/heads/main\n`);
      return undefined;
    });
    const result = await pushBranchVerified(gh, { repo: "kowo-co/beckett", branch: "main", dir });
    expect(result).toEqual({ pushed: true, repo: "kowo-co/beckett", branch: "main", ref: "HEAD", sha });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a defaulted --ref when the checkout is on a different branch than --branch", async () => {
  const { dir } = await makeRepo("main");
  try {
    const { gh, calls } = fakeGh(() => ok()); // any git push/ls-remote would be a bug here
    await expect(
      pushBranchVerified(gh, { repo: "kowo-co/beckett", branch: "run-20260822-example", dir }),
    ).rejects.toThrow(/is on branch 'main', not 'run-20260822-example'/);
    expect(calls.some((c) => c.startsWith("git push"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a push that does not move the remote to the intended sha is reported as a failure, not a success", async () => {
  const { dir, sha } = await makeRepo("main");
  const staleSha = "0".repeat(40);
  try {
    const { gh } = fakeGh((j) => {
      if (j.startsWith("git push")) return ok(); // exit 0, but nothing actually moved (wrong dir/ref upstream)
      if (j.startsWith("git ls-remote")) return ok(`${staleSha}\trefs/heads/main\n`);
      return undefined;
    });
    await expect(pushBranchVerified(gh, { repo: "kowo-co/beckett", branch: "main", dir })).rejects.toThrow(
      new RegExp(`pushed HEAD \\(${sha}\\).*remote branch now reads ${staleSha}`),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a push that leaves the remote branch missing entirely is reported as a failure", async () => {
  const { dir, sha } = await makeRepo("main");
  try {
    const { gh } = fakeGh((j) => {
      if (j.startsWith("git push")) return ok();
      if (j.startsWith("git ls-remote")) return ok(""); // branch not found on remote
      return undefined;
    });
    await expect(pushBranchVerified(gh, { repo: "kowo-co/beckett", branch: "main", dir })).rejects.toThrow(
      new RegExp(`pushed HEAD \\(${sha}\\).*no such branch`),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit --ref bypasses the branch-name guard even from a differently-named checkout", async () => {
  const { dir, sha } = await makeRepo("main");
  try {
    const { gh } = fakeGh((j) => {
      if (j.startsWith("git push")) return ok();
      if (j.startsWith("git ls-remote")) return ok(`${sha}\trefs/heads/run-20260822-example\n`);
      return undefined;
    });
    // Explicit --ref (HEAD, spelled out) on a "main" checkout, targeting a differently-named
    // remote branch: the caller said exactly what they mean, so the guard does not fire.
    const result = await pushBranchVerified(gh, { repo: "kowo-co/beckett", branch: "run-20260822-example", dir, ref: "HEAD" });
    expect(result.sha).toBe(sha);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
