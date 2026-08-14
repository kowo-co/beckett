/**
 * `src/cli/land.ts` — the shared "land a branch on a protected base" engine.
 *
 * What these pin: the ORDER of the motion (push → PR → poll → merge), that each stop names its own
 * cause and the caller's own re-run command, and — the reason the engine exists (issue #5) — that
 * nothing here ever reaches for a bare `git push`: every write goes through the injected client,
 * which is `GitHubCli` in production and a recording fake here. The CI wait is driven by injected
 * clocks so a bounded wait can be tested without one.
 */

import { describe, expect, test } from "bun:test";
import type { PrMergeability } from "../github/types.ts";
import type { MergeStrategy } from "../types.ts";
import { LandError, type LandClient, landBranch } from "./land.ts";

function mergeability(over: Partial<PrMergeability> = {}): PrMergeability {
  return {
    number: 7,
    url: "https://github.com/kowo-co/beckett/pull/7",
    title: "beckett: release v6.25.0",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: "release-bump-v6.25.0",
    baseRefName: "main",
    checks: { total: 1, passed: 1, failed: 0, pending: 0, skipped: 0, conclusion: "SUCCESS" },
    ...over,
  };
}

interface Recorder {
  calls: string[];
  pushes: Array<{ repo: string; localRef: string; remoteBranch: string; force?: boolean }>;
  merges: Array<{ repo: string; n: number; strategy: MergeStrategy }>;
}

function fakeClient(
  reads: PrMergeability[],
  over: Partial<LandClient> = {},
): { gh: LandClient; rec: Recorder } {
  const rec: Recorder = { calls: [], pushes: [], merges: [] };
  const queue = [...reads];
  const gh: LandClient = {
    async pushBranch(repo, localRef, remoteBranch, opts) {
      rec.calls.push("push");
      rec.pushes.push({ repo, localRef, remoteBranch, force: opts?.force });
    },
    async ensurePR() {
      rec.calls.push("ensurePR");
      return { number: 7, url: "https://github.com/kowo-co/beckett/pull/7" };
    },
    async prMergeability() {
      rec.calls.push("read");
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    async mergePR(repo, n, strategy) {
      rec.calls.push("merge");
      rec.merges.push({ repo, n, strategy });
    },
    ...over,
  };
  return { gh, rec };
}

/** A clock that jumps by `step` on every read — a bounded wait without a real one. */
function clock(step: number): () => number {
  let t = 0;
  return () => (t += step);
}

const OPTS = {
  repo: "kowo-co/beckett",
  head: "release-bump-v6.25.0",
  base: "main",
  title: "beckett: release v6.25.0",
  body: "the bump",
  strategy: "squash" as MergeStrategy,
  ciTimeoutMs: 60_000,
  command: "./deploy/deploy-prod.sh",
  sleep: async () => {},
};

describe("landBranch", () => {
  test("pushes, opens the PR, waits for CI, then merges — in that order", async () => {
    const { gh, rec } = fakeClient([
      mergeability({ checks: { total: 1, passed: 0, failed: 0, pending: 1, skipped: 0, conclusion: "PENDING" } }),
      mergeability(),
    ]);
    const steps: string[] = [];
    const result = await landBranch(gh, { ...OPTS, now: clock(1_000), step: (m) => steps.push(m) });

    expect(rec.calls).toEqual(["push", "ensurePR", "read", "read", "merge"]);
    expect(result).toEqual({ pr: { number: 7, url: "https://github.com/kowo-co/beckett/pull/7" }, merge: "merged" });
    expect(rec.merges).toEqual([{ repo: "kowo-co/beckett", n: 7, strategy: "squash" }]);
    expect(steps.some((s) => s.includes("waiting on CI"))).toBe(true);
  });

  test("the branch is pushed by name (and force only when asked)", async () => {
    const { gh, rec } = fakeClient([mergeability()]);
    await landBranch(gh, { ...OPTS, now: clock(1_000) });
    expect(rec.pushes).toEqual([
      { repo: "kowo-co/beckett", localRef: "release-bump-v6.25.0", remoteBranch: "release-bump-v6.25.0", force: undefined },
    ]);

    const forced = fakeClient([mergeability()]);
    await landBranch(forced.gh, { ...OPTS, localRef: "HEAD", force: true, now: clock(1_000) });
    expect(forced.rec.pushes[0]).toMatchObject({ localRef: "HEAD", force: true });
  });

  test("a PR that already merged is a clean no-op, not a failure (the re-run case)", async () => {
    const { gh, rec } = fakeClient([mergeability({ state: "MERGED" })]);
    const result = await landBranch(gh, { ...OPTS, now: clock(1_000) });
    expect(result.merge).toBe("already-merged");
    expect(rec.calls).not.toContain("merge");
  });

  test("a blocker names the cause AND the caller's own re-run command", async () => {
    const { gh, rec } = fakeClient([
      mergeability({ checks: { total: 3, passed: 1, failed: 2, pending: 0, skipped: 0, conclusion: "FAILURE" } }),
    ]);
    const err = (await landBranch(gh, { ...OPTS, now: clock(1_000) }).catch((e) => e)) as LandError;
    expect(err).toBeInstanceOf(LandError);
    expect(err.stage).toBe("blocked");
    expect(err.message).toContain("CI FAILED");
    expect(err.message).toContain("./deploy/deploy-prod.sh"); // not "beckett finish"
    expect(rec.calls).not.toContain("merge");
  });

  test("the CI wait is bounded, and a timeout merges nothing", async () => {
    const pending = mergeability({ checks: { total: 2, passed: 0, failed: 0, pending: 2, skipped: 0, conclusion: "PENDING" } });
    const { gh, rec } = fakeClient([pending]);
    const err = (await landBranch(gh, {
      ...OPTS,
      ciTimeoutMs: 30_000,
      timeoutAlso: " and nothing was deployed",
      now: clock(20_000),
    }).catch((e) => e)) as LandError;
    expect(err.stage).toBe("timeout");
    expect(err.message).toContain("gave up waiting on PR #7");
    expect(err.message).toContain("Nothing was merged and nothing was deployed.");
    expect(rec.calls).not.toContain("merge");
  });

  test("a rejected push explains the reconcile, and never reaches the PR", async () => {
    const { gh, rec } = fakeClient([mergeability()], {
      async pushBranch() {
        throw new Error("git push failed (1): ! [rejected] main -> main (non-fast-forward)");
      },
    });
    const err = (await landBranch(gh, { ...OPTS, dir: "/home/beckett/beckett", now: clock(1_000) }).catch((e) => e)) as LandError;
    expect(err.stage).toBe("push");
    expect(err.message).toContain("git rebase origin/release-bump-v6.25.0");
    expect(err.message).toContain("/home/beckett/beckett");
    expect(rec.calls).not.toContain("ensurePR");
  });

  test("'no commits between' is reported as already-landed work, not a GitHub error", async () => {
    const { gh } = fakeClient([mergeability()], {
      async ensurePR() {
        throw new Error("gh pr create failed (1): No commits between main and release-bump-v6.25.0");
      },
    });
    const err = (await landBranch(gh, { ...OPTS, now: clock(1_000) }).catch((e) => e)) as LandError;
    expect(err.stage).toBe("pr");
    expect(err.message).toContain("has no commits that main does not already have");
    // …and it says so as a REAL comparison. This verdict is only reachable once the base branch is
    // known to exist (`beckett finish` probes first); an empty repo is a first push, never this.
    expect(err.message).toContain("This is a REAL comparison");
    expect(err.message).toContain("first push");
  });

  test("an unreadable PR stops rather than guessing it is safe to merge", async () => {
    const { gh, rec } = fakeClient([mergeability()], {
      async prMergeability() {
        throw new Error("gh pr view (mergeability) failed (1): could not resolve to a PullRequest");
      },
    });
    const err = (await landBranch(gh, { ...OPTS, now: clock(1_000) }).catch((e) => e)) as LandError;
    expect(err.stage).toBe("read");
    expect(err.message).toContain("cannot tell whether it is safe to merge");
    expect(rec.calls).not.toContain("merge");
  });

  test("a merge GitHub refuses is translated, with the repo and the PR named", async () => {
    const { gh } = fakeClient([mergeability()], {
      async mergePR() {
        throw new Error("gh pr merge failed (1): Protected branch update failed");
      },
    });
    const err = (await landBranch(gh, { ...OPTS, now: clock(1_000) }).catch((e) => e)) as LandError;
    expect(err.stage).toBe("merge");
    expect(err.message).toContain("branch protection on kowo-co/beckett");
    expect(err.message).toContain("./deploy/deploy-prod.sh");
  });
});
