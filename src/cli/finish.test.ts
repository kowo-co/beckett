/**
 * Coverage for `beckett finish`'s decision logic (`src/cli/finish.ts`).
 * =======================================================================================
 * The value of this command is that it never leaves the caller guessing, so what is pinned here is
 * exactly that: for every shape of blocker GitHub can report, does the command produce a SPECIFIC,
 * actionable line naming the PR, the cause, and the command that clears it — and does it correctly
 * separate "keep waiting" from "this will never resolve"? A wrapper that answered "merge failed"
 * would pass a happy-path test and still be worse than the manual sequence it replaced.
 *
 * The orchestration around these helpers pushes, merges, and deploys, so it is deliberately NOT
 * exercised here (the CLI characterization suite covers the argv contract, which refuses before it
 * reads a repo). Every decision that HAS a right answer lives in a pure function so it can be.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrMergeability } from "../github/types.ts";
import {
  FINISH_AUDIT_CHANNEL_ID,
  FinishUsageError,
  describeDeployFailure,
  describeMergeFailure,
  finishAuditLine,
  gateMerge,
  parseFinishArgs,
  planRemote,
  primaryWorktree,
  repoFromRemoteUrl,
  runGuardedDeploy,
} from "./finish.ts";

function pr(over: Partial<PrMergeability> = {}): PrMergeability {
  return {
    number: 42,
    url: "https://github.com/kowo-co/beckett/pull/42",
    title: "ship it",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefName: "beckett/task-2-1",
    baseRefName: "main",
    checks: { total: 3, passed: 3, pending: 0, failed: 0, skipped: 0, conclusion: "SUCCESS" },
    ...over,
  };
}

describe("parseFinishArgs", () => {
  test("-m is the message and the defaults are the end-of-ticket motion", () => {
    const opts = parseFinishArgs(["-m", "wrap the finish flow"], "/repo");
    expect(opts.title).toBe("wrap the finish flow");
    expect(opts.body).toBe("");
    expect(opts.dir).toBe("/repo");
    expect(opts.base).toBe("main");
    expect(opts.strategy).toBe("squash");
    expect(opts.deploy).toBe(true);
    expect(opts.commit).toBe(true);
    // The deploy has no TTY to prompt on, so the bump is always pre-decided.
    expect(opts.bump).toBe("yes");
  });

  test("--message is the same flag, and a multi-line message splits into title + body", () => {
    const opts = parseFinishArgs(["--message", "add finish\n\nwraps PR + merge + redeploy"], "/repo");
    expect(opts.title).toBe("add finish");
    expect(opts.body).toBe("wraps PR + merge + redeploy");
  });

  test("an explicit --body wins over the inline remainder", () => {
    expect(parseFinishArgs(["-m", "title\nignored", "--body", "chosen"], "/r").body).toBe("chosen");
  });

  test("a missing message names the flag to use rather than printing bare usage", () => {
    expect(() => parseFinishArgs([], "/r")).toThrow(FinishUsageError);
    expect(() => parseFinishArgs([], "/r")).toThrow(/a message is required/);
    expect(() => parseFinishArgs(["-m", "   "], "/r")).toThrow(/a message is required/);
  });

  test("-m with no value is refused instead of swallowing the next flag", () => {
    expect(() => parseFinishArgs(["-m"], "/r")).toThrow(/--message needs a value/);
    expect(() => parseFinishArgs(["-m", "--json"], "/r")).toThrow(/--message needs a value/);
  });

  test("unknown flags and stray positionals are refused, never silently ignored", () => {
    expect(() => parseFinishArgs(["-m", "x", "--ci-timout", "10"], "/r")).toThrow(/unknown flag "--ci-timout"/);
    expect(() => parseFinishArgs(["ship", "-m", "x"], "/r")).toThrow(/unexpected argument "ship"/);
  });

  test("the enum flags are validated up front", () => {
    expect(() => parseFinishArgs(["-m", "x", "--strategy", "octopus"], "/r")).toThrow(/--strategy must be one of/);
    expect(() => parseFinishArgs(["-m", "x", "--bump", "huge"], "/r")).toThrow(/--bump must be one of/);
    expect(() => parseFinishArgs(["-m", "x", "--ci-timeout", "soon"], "/r")).toThrow(/--ci-timeout must be a number/);
  });

  test("--ci-timeout is seconds, and 0 means do not wait at all", () => {
    expect(parseFinishArgs(["-m", "x", "--ci-timeout", "90"], "/r").ciTimeoutMs).toBe(90_000);
    expect(parseFinishArgs(["-m", "x", "--ci-timeout", "0"], "/r").ciTimeoutMs).toBe(0);
  });

  test("--no-deploy and --no-commit turn the two side effects off", () => {
    const opts = parseFinishArgs(["-m", "x", "--no-deploy", "--no-commit"], "/r");
    expect(opts.deploy).toBe(false);
    expect(opts.commit).toBe(false);
  });

  test("--json is the quiet switch (stdout is a result object either way)", () => {
    expect(parseFinishArgs(["-m", "x"], "/r").json).toBe(false);
    expect(parseFinishArgs(["-m", "x", "--json"], "/r").json).toBe(true);
  });
});

describe("repoFromRemoteUrl", () => {
  test("reads owner/name out of every remote shape git hands back", () => {
    expect(repoFromRemoteUrl("https://github.com/kowo-co/beckett.git")).toBe("kowo-co/beckett");
    expect(repoFromRemoteUrl("https://github.com/kowo-co/beckett")).toBe("kowo-co/beckett");
    expect(repoFromRemoteUrl("git@github.com:kowo-co/beckett.git\n")).toBe("kowo-co/beckett");
    expect(repoFromRemoteUrl("ssh://git@github.com/kowo-co/beckett.git")).toBe("kowo-co/beckett");
  });

  test("an unusable remote is null so the caller can ask for --repo instead of guessing", () => {
    expect(repoFromRemoteUrl("")).toBeNull();
    expect(repoFromRemoteUrl("/srv/git/mirror")).toBeNull();
    expect(repoFromRemoteUrl("https://github.com/lonely")).toBeNull();
  });
});

// The 2026-08-14 regression (`kowo-co/babble`): a run whose project repo had no remote, and a
// GitHub repo that existed but was EMPTY, both ended at "this work is already merged, or nothing
// was committed" — on a branch carrying the entire build. Three distinguishable cases, three
// answers, and only ONE of them is "nothing to do".
describe("planRemote — the three remote cases", () => {
  const base = { base: "main", dir: "/home/beckett/Projects/babble" };

  test("(a) no remote at all is said out loud, and never mistaken for already-merged", () => {
    const plan = planRemote({ ...base, repo: undefined, originUrl: null, baseExists: null });
    expect(plan.kind).toBe("no-remote");
    const error = plan.kind === "no-remote" ? plan.error : "";
    expect(error).toContain("NO `origin` remote configured");
    expect(error).toContain('This is not "already merged"');
    // Names the missing thing AND both commands that supply it.
    expect(error).toContain("git remote add origin https://github.com/<owner>/<name>.git");
    expect(error).toContain("--repo <owner/name>");
  });

  test("(a) an origin that is not a GitHub owner/name remote is its own message, quoting the URL", () => {
    const plan = planRemote({ ...base, repo: undefined, originUrl: "/srv/mirrors/babble.git", baseExists: null });
    expect(plan.kind).toBe("no-remote");
    const error = plan.kind === "no-remote" ? plan.error : "";
    expect(error).toContain("/srv/mirrors/babble.git");
    expect(error).toContain("--repo <owner/name>");
    expect(error).not.toContain("already merged");
  });

  test("(b) a remote whose base branch does not exist yet is a first push, not an error", () => {
    expect(
      planRemote({ ...base, repo: "kowo-co/babble", originUrl: null, baseExists: false }).kind,
    ).toBe("first-push");
    // …including when `--repo` supplied the name and the checkout still has no origin: an empty
    // repo is exactly the shape that leaves a checkout remote-less in the first place.
    expect(
      planRemote({ ...base, repo: "kowo-co/babble", originUrl: null, baseExists: false }).kind,
    ).toBe("first-push");
  });

  test("(c) a base that really exists lands normally — the landing engine's verdicts mean what they say", () => {
    expect(
      planRemote({ ...base, repo: "kowo-co/babble", originUrl: "https://github.com/kowo-co/babble.git", baseExists: true }).kind,
    ).toBe("land");
  });

  test("an unanswerable probe lands rather than inventing a first push", () => {
    // `baseExists: null` means GitHub could not be asked — NOT evidence that the repo is empty.
    expect(
      planRemote({ ...base, repo: "kowo-co/babble", originUrl: "https://github.com/kowo-co/babble.git", baseExists: null }).kind,
    ).toBe("land");
  });
});

describe("gateMerge", () => {
  test("a clean, green PR is ready", () => {
    expect(gateMerge(pr(), "kowo-co/beckett", true)).toEqual({ kind: "ready" });
  });

  test("an already-merged PR skips the merge instead of erroring", () => {
    expect(gateMerge(pr({ state: "MERGED" }), "kowo-co/beckett", true)).toEqual({ kind: "merged" });
  });

  test("running checks are a wait, and the reason says what is outstanding", () => {
    const gate = gateMerge(
      pr({ checks: { total: 4, passed: 2, pending: 2, failed: 0, skipped: 0, conclusion: "PENDING" } }),
      "kowo-co/beckett",
      true,
    );
    expect(gate.kind).toBe("wait");
    expect(gate).toMatchObject({ why: expect.stringContaining("2 of 4 checks still running") });
  });

  test("an empty rollup waits through the grace, then reads as a repo with no CI", () => {
    const none = pr({ checks: { total: 0, passed: 0, pending: 0, failed: 0, skipped: 0, conclusion: "NONE" } });
    // Seconds after the PR opened, zero checks means "the workflows have not registered yet" —
    // merging here would ship past a suite that was about to run.
    expect(gateMerge(none, "kowo-co/beckett", false).kind).toBe("wait");
    expect(gateMerge(none, "kowo-co/beckett", true).kind).toBe("ready");
  });

  test("failed checks block with the counts and the command that shows them", () => {
    const gate = gateMerge(
      pr({
        checks: { total: 5, passed: 3, pending: 0, failed: 2, skipped: 0, conclusion: "FAILURE" },
        mergeStateStatus: "BLOCKED",
      }),
      "kowo-co/beckett",
      true,
    );
    expect(gate.kind).toBe("blocked");
    if (gate.kind !== "blocked") throw new Error("unreachable");
    expect(gate.error).toContain("CI FAILED");
    expect(gate.error).toContain("2 of 5 checks red");
    expect(gate.error).toContain("pr checks 42 --repo kowo-co/beckett");
    // A red required check also reads as mergeStateStatus BLOCKED; the check message is the more
    // specific of the two, so it must win.
    expect(gate.error).not.toContain("branch protection");
  });

  test("a conflict blocks with the rebase, not a generic refusal", () => {
    const gate = gateMerge(pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), "kowo-co/beckett", true);
    expect(gate.kind).toBe("blocked");
    if (gate.kind !== "blocked") throw new Error("unreachable");
    expect(gate.error).toContain("MERGE CONFLICTS");
    expect(gate.error).toContain("git rebase origin/main");
  });

  test("an in-flight mergeability computation is a wait, never a refusal", () => {
    expect(gateMerge(pr({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }), "kowo-co/beckett", true).kind).toBe("wait");
  });

  test("branch protection, behind-base, draft and closed each get their own instruction", () => {
    const blocked = gateMerge(pr({ mergeStateStatus: "BLOCKED" }), "kowo-co/beckett", true);
    expect(blocked).toMatchObject({ kind: "blocked", error: expect.stringContaining("branch protection") });

    const behind = gateMerge(pr({ mergeStateStatus: "BEHIND" }), "kowo-co/beckett", true);
    expect(behind).toMatchObject({ kind: "blocked", error: expect.stringContaining("BEHIND main") });

    const draft = gateMerge(pr({ isDraft: true }), "kowo-co/beckett", true);
    expect(draft).toMatchObject({ kind: "blocked", error: expect.stringContaining("pr ready 42") });

    const closed = gateMerge(pr({ state: "CLOSED" }), "kowo-co/beckett", true);
    expect(closed).toMatchObject({ kind: "blocked", error: expect.stringContaining("pr reopen 42") });
  });

  test("every blocker names the PR it is talking about", () => {
    const blockers = [
      pr({ state: "CLOSED" }),
      pr({ isDraft: true }),
      pr({ checks: { total: 1, passed: 0, pending: 0, failed: 1, skipped: 0, conclusion: "FAILURE" } }),
      pr({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
      pr({ mergeStateStatus: "BEHIND" }),
      pr({ mergeStateStatus: "BLOCKED" }),
    ];
    for (const state of blockers) {
      const gate = gateMerge(state, "kowo-co/beckett", true);
      expect(gate.kind).toBe("blocked");
      if (gate.kind !== "blocked") throw new Error("unreachable");
      expect(gate.error).toContain("42");
      expect(gate.error).toContain("beckett finish");
    }
  });
});

describe("describeMergeFailure", () => {
  test("gh's terse refusals are restated with the fix", () => {
    const conflict = describeMergeFailure("gh pr merge failed (1): Pull request is not mergeable", "kowo-co/beckett", 42, "task-2-1");
    expect(conflict).toContain("not mergeable");
    expect(conflict).toContain("git rebase origin/main");

    const protectedBranch = describeMergeFailure("At least 1 approving review is required", "kowo-co/beckett", 42, "task-2-1");
    expect(protectedBranch).toContain("branch protection");
    expect(protectedBranch).toContain("pr view 42 --repo kowo-co/beckett");
  });

  test("an unrecognized failure still names the PR and repo and carries gh's own words", () => {
    const other = describeMergeFailure("gh: HTTP 502", "kowo-co/beckett", 42, "task-2-1");
    expect(other).toContain("PR #42");
    expect(other).toContain("kowo-co/beckett");
    expect(other).toContain("HTTP 502");
  });
});

describe("describeDeployFailure", () => {
  test("an unset git identity is named as the host-config problem it is", () => {
    const msg = describeDeployFailure(1, "*** Please tell me who you are.\nfatal: unable to auto-detect email address");
    expect(msg).toContain("git has no commit identity");
    expect(msg).toContain('git config --global user.email');
    // The merge already landed — saying otherwise would send the caller looking in the wrong place.
    expect(msg).toContain("merge DID land");
  });

  test("a dirty deploy checkout points at the host, not the local branch", () => {
    const msg = describeDeployFailure(1, "FATAL: deploy checkout is dirty — ~/beckett must never be edited by hand:");
    expect(msg).toContain("uncommitted edits");
    expect(msg).toContain("cd ~/beckett");
  });

  test("an unreachable host is distinguished from a failing gate", () => {
    expect(describeDeployFailure(255, "ssh: Could not resolve hostname desktop")).toContain("over ssh");
  });

  test("any other failure surfaces the script's own FATAL line plus the tail", () => {
    const msg = describeDeployFailure(1, "== gating origin/main ==\nFATAL: bubblewrap is required\nbye");
    expect(msg).toContain("FATAL: bubblewrap is required");
    expect(msg).toContain("bye");
  });

  // git shouts in lower case, and its errors reach this function as often as the script's own do.
  test("git's own lower-case fatal line is surfaced as the cause too", () => {
    const msg = describeDeployFailure(1, "== computing version bump ==\nfatal: could not read Username for 'https://github.com'");
    expect(msg).toContain("Cause: fatal: could not read Username");
  });

  // Both writes the deploy makes ride the GitHub App token (issue #5), so its two new host-config
  // stops need names of their own rather than falling through to "here is a FATAL line".
  test("a missing GitHub App credential on the deploy host is named as host config", () => {
    const msg = describeDeployFailure(
      1,
      "FATAL: no usable GitHub credential for kowo-co/beckett — this deploy cannot publish anything.",
    );
    expect(msg).toContain("no GitHub App credential");
    expect(msg).toContain("beckett gh preflight");
    expect(msg).toContain("merge DID land");
  });

  test("a blocked release-bump PR says the bump is what did not land", () => {
    const msg = describeDeployFailure(1, "FATAL: the release bump for v6.25.0 did not land on main (cause above).");
    expect(msg).toContain("release-version bump");
    expect(msg).toContain("branch-protected");
  });

  test("a linked-worktree checkout clash is named, not left as a bare exit code", () => {
    const msg = describeDeployFailure(1, "fatal: 'main' is already used by worktree at '/home/beckett/Projects/beckett'");
    expect(msg).toContain("LINKED git worktree");
    expect(msg).toContain("deploy-prod.sh");
    // Re-running is the fix, and it must be clear the merge is not at risk.
    expect(msg).toContain("merge DID land");
  });
});

describe("primaryWorktree", () => {
  // The deploy runs `git checkout main`, which a linked worktree cannot do while the primary
  // checkout holds that branch — so the deploy must be spawned in the FIRST entry, not `--dir`.
  const PORCELAIN = [
    "worktree /home/beckett/Projects/beckett",
    "HEAD 5f165862f3eff6f0ee1af7bfa0c5315626014927",
    "branch refs/heads/main",
    "",
    "worktree /home/beckett/Projects/beckett/.beckett/worktrees/2",
    "HEAD f804fa5f3eff6f0ee1af7bfa0c5315626014927",
    "branch refs/heads/beckett/task-2-1",
    "",
  ].join("\n");

  test("picks the main working tree, never the linked worktree the ticket was built in", () => {
    expect(primaryWorktree(PORCELAIN)).toBe("/home/beckett/Projects/beckett");
  });

  test("a single-checkout repo is its own primary worktree", () => {
    expect(primaryWorktree("worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n")).toBe("/srv/app");
  });

  test("unparseable output is null so the caller falls back rather than deploying somewhere wrong", () => {
    expect(primaryWorktree("")).toBeNull();
    expect(primaryWorktree("not porcelain at all")).toBeNull();
  });
});

describe("runGuardedDeploy", () => {
  const sandboxes: string[] = [];
  afterAll(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for `deploy/deploy-prod.sh` — the real one ships code to a live host. */
  function fakeDeploy(body: string): { script: string; cwd: string } {
    const cwd = mkdtempSync(join(tmpdir(), "beckett-finish-deploy-"));
    sandboxes.push(cwd);
    const script = join(cwd, "deploy-prod.sh");
    writeFileSync(script, `#!/usr/bin/env bash\n${body}\n`);
    return { script, cwd };
  }

  test("a clean deploy exits 0 and its output is captured", async () => {
    const { script, cwd } = fakeDeploy('echo "== deploy complete =="');
    const result = await runGuardedDeploy(script, cwd, "yes");
    expect(result.code).toBe(0);
    expect(result.tail).toContain("deploy complete");
  });

  test("the bump is pre-decided in the environment (the script must never prompt from here)", async () => {
    const { script, cwd } = fakeDeploy('echo "bump=${BECKETT_BUMP}"');
    expect((await runGuardedDeploy(script, cwd, "minor")).tail).toContain("bump=minor");
  });

  test("a failing gate returns its exit code, and stderr survives into the tail", async () => {
    const { script, cwd } = fakeDeploy('echo "FATAL: deploy checkout is dirty" >&2\nexit 3');
    const result = await runGuardedDeploy(script, cwd, "yes");
    expect(result.code).toBe(3);
    // The tail is what the operator-facing error is built from, so it must survive the pipe.
    expect(describeDeployFailure(result.code, result.tail)).toContain("cd ~/beckett");
  });

  test("mirroring the log live does not change what is captured for the error message", async () => {
    // The deploy is the slowest stage, so an ordinary run narrates it as it arrives; the tail the
    // failure message is built from must be identical either way.
    const { script, cwd } = fakeDeploy('echo "FATAL: bubblewrap is required" >&2\nexit 1');
    const silent = await runGuardedDeploy(script, cwd, "yes");
    const echoed = await runGuardedDeploy(script, cwd, "yes", true);
    expect(echoed).toEqual(silent);
    expect(echoed.tail).toContain("FATAL: bubblewrap is required");
  });

  test("a long deploy log is truncated to a readable tail, keeping the END", async () => {
    const { script, cwd } = fakeDeploy("seq 1 500\nexit 1");
    const { tail } = await runGuardedDeploy(script, cwd, "yes");
    expect(tail.split("\n").length).toBeLessThanOrEqual(25);
    expect(tail).toContain("500");
    expect(tail).not.toContain("\n1\n");
  });
});

describe("the audit line", () => {
  const at = new Date("2026-08-04T21:07:03.000Z");

  test("names the repo, branch and message so the ops channel reads as a ledger", () => {
    const line = finishAuditLine("kowo-co/beckett", "beckett/task-2-1", "wrap the finish flow", at);
    expect(line).toContain("beckett finish");
    expect(line).toContain("kowo-co/beckett");
    expect(line).toContain("beckett/task-2-1");
    expect(line).toContain("wrap the finish flow");
  });

  test("carries a timestamp, so a re-run with the same message is not coalesced away", () => {
    const first = finishAuditLine("o/r", "b", "same message", at);
    const second = finishAuditLine("o/r", "b", "same message", new Date("2026-08-04T21:09:41.000Z"));
    expect(first).toContain("21:07:03Z");
    expect(first).not.toBe(second);
  });

  test("stays inside the daemon's 240-char ack cap even with a long message", () => {
    const line = finishAuditLine("kowo-co/beckett", "beckett/task-2-1", "x".repeat(400), at);
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line).toContain("…");
  });

  test("targets the ops channel the ticket specifies", () => {
    expect(FINISH_AUDIT_CHANNEL_ID).toBe("1520658476974735490");
  });
});
