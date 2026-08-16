import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyBranchLanding,
  classifyPublishError,
  planPublishRetry,
  publishErrorMessage,
  publishFailureReason,
  publishFixHint,
  publishParkAdvice,
  publishPrAdvice,
  PublishOutbox,
  PUBLISH_MAX_ATTEMPTS,
  PUBLISH_RETRY_DELAYS_MS,
  type PublishOperation,
} from "./publish-outbox.ts";
import type { BranchVsMainRaw } from "../worker/worktree.ts";
import type { Logger } from "../types.ts";

test("publish failure classifier retries only genuinely permanent GitHub/auth failures", () => {
  for (const message of [
    "fetch failed",
    "ETIMEDOUT contacting api.github.com",
    "GitHub returned 503",
    "request timeout",
    // #227: an UNRECOGNIZED error (matching none of the old transient regex) used to fall through
    // to "permanent" and park after exactly one attempt. It must now default to "transient".
    "gh pr create failed (1): some future gh error message nobody wrote a regex for",
  ]) {
    expect(classifyPublishError(new Error(message))).toBe("transient");
  }
  for (const message of [
    "gh api failed (401): Bad credentials",
    "HTTP 403 forbidden",
    "cross-fork PAT limit reached",
    "gh repo view failed (404): Not Found",
    "GraphQL: Could not resolve to a Repository with the name 'x/y'.",
  ]) {
    expect(classifyPublishError(new Error(message))).toBe("permanent");
  }
});

// BUG 4b (2026-08-14): a publish that fails on a property of the LOCAL tree or the branch itself
// cannot be fixed by retrying — retrying "You have unstaged changes" four times fails four identical
// times and then goes quiet. Those classes must park on attempt 1 with the real reason, not burn the
// ladder. A genuinely transient GitHub/network hiccup still retries.
test("classifier treats structurally-deterministic publish failures as non-retryable (park on attempt 1)", () => {
  for (const message of [
    "publish: local work conflicts with kowo-co/babble@main and can't auto-rebase — needs a human (error: cannot rebase: You have unstaged changes.)",
    "error: cannot rebase: You have unstaged changes. error: additionally, your index contains uncommitted changes.",
    "publish: squash-apply still conflicts with main; residual conflicting files: a.ts — needs a human",
    "Please commit or stash them.",
  ]) {
    expect(classifyPublishError(new Error(message))).toBe("permanent");
  }
  // A retry could conceivably clear these — they stay transient.
  for (const message of ["fetch failed", "GitHub returned 503", "ETIMEDOUT contacting api.github.com"]) {
    expect(classifyPublishError(new Error(message))).toBe("transient");
  }
});

// ── BUG 2: the parked hand-off advice is computed from the branch's real state vs origin/main ─────

function raw(over: Partial<BranchVsMainRaw> = {}): BranchVsMainRaw {
  return { compared: true, ahead: 0, behind: 0, aheadUnlanded: 0, ...over };
}

test("classifyBranchLanding names the four shapes: ahead, diverged, already-landed, superseded", () => {
  // (a) genuinely-new work main does not have yet, and nothing new on main → a plain push works.
  expect(classifyBranchLanding(raw({ ahead: 2, aheadUnlanded: 2 }))).toEqual({ kind: "ahead", ahead: 2 });
  // (d) new work on BOTH sides → diverged, NOT plain-ahead: a push is a non-fast-forward reject and
  // forcing it would drop main's side, so this must never be advised as "just push it".
  expect(classifyBranchLanding(raw({ ahead: 1, aheadUnlanded: 1, behind: 3 }))).toEqual({
    kind: "diverged",
    ahead: 1,
    behind: 3,
  });
  // Diverged counts the UNLANDED commits, not the raw ahead: already-landed ones need no push.
  expect(classifyBranchLanding(raw({ ahead: 5, aheadUnlanded: 2, behind: 1 }))).toMatchObject({
    kind: "diverged",
    ahead: 2,
  });
  // (b) every local commit already on main under a squash sha (patch-id match, git cherry all `-`).
  expect(
    classifyBranchLanding(raw({ ahead: 1, aheadUnlanded: 0, landedCommit: "2035e51abcdef", landedSubject: "babble: post training cycles" })),
  ).toEqual({ kind: "landed", commit: "2035e51abcdef", subject: "babble: post training cycles" });
  // (c) 0 ahead, strictly behind — pushing would revert.
  expect(classifyBranchLanding(raw({ ahead: 0, behind: 3 }))).toEqual({ kind: "superseded", behind: 3 });
  // identical to main → the work IS on main → landed (courier closed, never push).
  expect(classifyBranchLanding(raw({ ahead: 0, behind: 0, landedCommit: "deadbeef0000" }))).toMatchObject({ kind: "landed" });
  // no comparison possible → unknown (generic push advice).
  expect(classifyBranchLanding({ compared: false, ahead: 0, behind: 0, aheadUnlanded: 0 })).toEqual({ kind: "unknown" });
});

test("publishParkAdvice gives the SAFE command for each shape — push only for (a)/unknown", () => {
  const ref = { runId: "run-x", branch: "beckett/run-x" };

  const ahead = publishParkAdvice({ kind: "ahead", ahead: 4 }, ref);
  expect(ahead).toContain("beckett gh push --repo <owner/name> --branch beckett/run-x");
  expect(ahead).toContain("beckett task courier run-x");
  expect(ahead).toContain("4 unpushed commit(s)"); // (a) says WHAT is unpushed, not just "push it"

  // (d) diverged → says so, gives both counts, and must never recommend a push (plain or forced).
  const diverged = publishParkAdvice({ kind: "diverged", ahead: 2, behind: 3 }, ref);
  expect(diverged).toContain("DIVERGED from origin/main");
  expect(diverged).toContain("2 unpushed commit(s)");
  expect(diverged).toContain("3 commit(s) there");
  expect(diverged).toContain("do NOT push");
  expect(diverged).not.toContain("gh push");
  expect(diverged).not.toContain("--force");

  const landed = publishParkAdvice({ kind: "landed", commit: "2035e51abcdef01", subject: "babble: post training cycles" }, ref);
  expect(landed).toContain("ALREADY on origin/main");
  expect(landed).toContain("2035e51abcde"); // named commit, short form
  expect(landed).toContain("babble: post training cycles");
  expect(landed).toContain("DUPLICATE");
  expect(landed).toContain("beckett task courier run-x --pr-url");
  expect(landed).not.toContain("gh push"); // must NEVER tell them to push already-landed work

  const superseded = publishParkAdvice({ kind: "superseded", behind: 3 }, ref);
  expect(superseded).toContain("3 commit(s) BEHIND origin/main");
  expect(superseded).toContain("REVERT");
  expect(superseded).toContain("beckett task courier run-x");
  expect(superseded).not.toContain("gh push");

  // Comparison failed → fall back to the generic push hand-off (the pre-existing behavior).
  expect(publishParkAdvice({ kind: "unknown" }, ref)).toContain("beckett gh push");
});

test("the advice names the branch it actually compared against, on a repo whose default isn't `main`", () => {
  // `readBranchVsMain` measures against the REMOTE's default branch, so a `trunk`-default project
  // must not be told its work is "already on origin/main" — a branch that doesn't exist there.
  const ref = { runId: "run-x", branch: "beckett/run-x" };
  const landed = publishParkAdvice(
    { kind: "landed", commit: "2035e51abcdef01", subject: "trunk work", mainRef: "origin/trunk" },
    ref,
  );
  expect(landed).toContain("ALREADY on origin/trunk");
  expect(landed).not.toContain("origin/main");

  const superseded = publishParkAdvice({ kind: "superseded", behind: 2, mainRef: "origin/trunk" }, ref);
  expect(superseded).toContain("2 commit(s) BEHIND origin/trunk");
  expect(superseded).not.toContain("origin/main");

  // Unnamed (an older row, or a comparison that never got a name) still reads sensibly.
  expect(publishParkAdvice({ kind: "superseded", behind: 1 }, ref)).toContain("BEHIND origin/main");
});

test("the ladder is a visible, testable const table: attempts 1..4, 30s / 2m / 10m, then park", () => {
  expect(PUBLISH_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000]);
  expect(PUBLISH_MAX_ATTEMPTS).toBe(4);
});

test("publishErrorMessage carries the underlying message verbatim, Error or not", () => {
  expect(publishErrorMessage(new Error("gh pr create failed (1): fetch failed"))).toBe("gh pr create failed (1): fetch failed");
  expect(publishErrorMessage("a plain string throw")).toBe("a plain string throw");
});

test("planPublishRetry: a transient failure retries through attempts 1-3 on the ladder, honestly worded", () => {
  const now = 1_000_000;
  const one = planPublishRetry(1, new Error("fetch failed"), now);
  expect(one).toMatchObject({ action: "retry", nextAttemptAt: now + 30_000, reason: "transient", error: "fetch failed" });
  expect(one.message).toBe("publish attempt 1 failed — retrying in 30s");

  const two = planPublishRetry(2, new Error("fetch failed"), now);
  expect(two.nextAttemptAt).toBe(now + 120_000);
  expect(two.message).toBe("publish attempt 2 failed — retrying in 2m");

  const three = planPublishRetry(3, new Error("fetch failed"), now);
  expect(three.nextAttemptAt).toBe(now + 600_000);
  expect(three.message).toBe("publish attempt 3 failed — retrying in 10m");
});

test("planPublishRetry: attempt 4 parks for a human courier instead of scheduling a 4th delay", () => {
  const plan = planPublishRetry(4, new Error("fetch failed"), 1_000_000);
  expect(plan.action).toBe("park");
  expect(plan.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
  expect(plan.reason).toBe("attempts-exhausted");
  expect(plan.message).toBe("parked for human courier");
  // Never the old dishonest wording — a parked row must never claim it will retry.
  expect(plan.message).not.toContain("retry");
});

test("planPublishRetry: a permanent class parks immediately, even on attempt 1", () => {
  const plan = planPublishRetry(1, new Error("HTTP 403 forbidden"), 1_000_000);
  expect(plan.action).toBe("park");
  expect(plan.reason).toBe("permanent");
  expect(plan.message).toBe("parked for human courier");
  expect(plan.error).toBe("HTTP 403 forbidden");
});

// ── PublishOutbox.append: logs the plan's decision verbatim, every time ──────────────────────

function fakeLogger(): { logger: Logger; warns: { msg: string; fields: unknown }[] } {
  const warns: { msg: string; fields: unknown }[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (msg: string, fields?: unknown) => void warns.push({ msg, fields }),
    error() {},
    child: () => logger,
  } as unknown as Logger;
  return { logger, warns };
}

function op(over: Partial<PublishOperation> = {}): PublishOperation {
  return {
    id: "op-1",
    item: { id: "run-1", identifier: "run-1" } as PublishOperation["item"],
    slug: "gateway",
    repoRoot: "/repo",
    messagePrefix: "Review passed → **done**.",
    summary: "did the thing",
    purpose: "done",
    attempt: 1,
    nextAttemptAt: Date.now() + 30_000,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

let dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-outbox-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("append logs the plan's honest wording plus the verbatim error — not the old contentless line", () => {
  const dir = scratch();
  const { logger, warns } = fakeLogger();
  const outbox = new PublishOutbox(join(dir, "outbox.jsonl"), logger);
  const plan = planPublishRetry(1, new Error("fetch failed"), Date.now());
  const row = op({ attempt: 1, nextAttemptAt: plan.nextAttemptAt });
  outbox.append(row, plan);
  expect(warns).toHaveLength(1);
  expect(warns[0]!.msg).toBe("publish attempt 1 failed — retrying in 30s");
  expect(warns[0]!.fields).toMatchObject({ id: "op-1", item: "run-1", attempt: 1, error: "fetch failed", reason: "transient" });
});

test("append logs 'parked for human courier' — never 'queued for retry' — once the plan parks", () => {
  const dir = scratch();
  const { logger, warns } = fakeLogger();
  const outbox = new PublishOutbox(join(dir, "outbox.jsonl"), logger);
  const plan = planPublishRetry(1, new Error("HTTP 403 forbidden"), Date.now());
  const row = op({ attempt: 1, nextAttemptAt: plan.nextAttemptAt });
  outbox.append(row, plan);
  expect(warns[0]!.msg).toBe("parked for human courier");
  expect(warns[0]!.fields).toMatchObject({ error: "HTTP 403 forbidden", reason: "permanent" });
  const persisted = JSON.parse(readFileSync(join(dir, "outbox.jsonl"), "utf8").trim());
  expect(persisted.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
});

// A run that cannot publish must carry a reason an operator can ACT on. Before this, the reason
// lived only in the durable row and the run itself said `error: null` (2026-08-14: 30+ minutes of
// `publishing`, no error, no channel message, no push).
test("publishFixHint names the fix for the failure classes we can recognize, and guesses at none", () => {
  expect(publishFixHint("fatal: 'origin' does not appear to be a git repository")).toContain(
    "git remote add origin",
  );
  expect(publishFixHint("git push failed (128): No configured push destination")).toContain(
    "no usable `origin` remote",
  );
  expect(publishFixHint("gh api failed (403): Resource not accessible by integration")).toContain(
    "beckett gh preflight",
  );
  expect(publishFixHint("gh repo view failed (404): Not Found")).toContain("beckett gh raw -- repo view");
  expect(publishFixHint("connection reset by peer")).toBeNull();
});

test("publishFailureReason names the step, the attempt, the cause, and what to do about it", () => {
  const retrying = planPublishRetry(2, new Error("fetch failed"), 1_000);
  const whileRetrying = publishFailureReason(retrying, 2);
  expect(whileRetrying).toContain("publishing failed on attempt 2 of 4");
  expect(whileRetrying).toContain("retrying in 2m");
  expect(whileRetrying).toContain("fetch failed");

  const parked = publishFailureReason(planPublishRetry(4, new Error("fatal: 'origin' does not appear to be a git repository"), 1_000), 4);
  expect(parked).toContain("parked for a human");
  expect(parked).toContain("no attempts left after 4 of 4");
  expect(parked).toContain("git remote add origin"); // the actionable half
  expect(parked).toContain("beckett task courier");

  // A permanent class parks on attempt 1 and says WHY it will not be retried.
  const permanent = publishFailureReason(planPublishRetry(1, new Error("HTTP 403 forbidden"), 1_000), 1);
  expect(permanent).toContain("unrecoverable without a human");
  expect(permanent).toContain("beckett gh preflight");

  // A parked reason appends the caller's branch-aware hand-off advice VERBATIM (BUG 2) — a retry
  // never does (there's nothing to hand off yet).
  const advice = "This branch's work is ALREADY on origin/main — do NOT push.";
  const withAdvice = publishFailureReason(planPublishRetry(4, new Error("fetch failed"), 1_000), 4, advice);
  expect(withAdvice).toContain(advice);
  expect(withAdvice).not.toContain("beckett gh push");
  const retryWithAdvice = publishFailureReason(planPublishRetry(2, new Error("fetch failed"), 1_000), 2, advice);
  expect(retryWithAdvice).not.toContain(advice);
});

// ── Task 3: publish-opens-a-pr — the classifier learns the new prefixes, and a PR url wins the hand-off ──

test("publish blocked: is permanent, still waiting on CI is transient", () => {
  expect(
    classifyPublishError(new Error("publish blocked: PR #11 (https://github.com/o/r/pull/11) has MERGE CONFLICTS")),
  ).toBe("permanent");
  expect(
    classifyPublishError(new Error("refusing to publish: harness state is still tracked (.beckett) — needs a human")),
  ).toBe("permanent");
  expect(
    classifyPublishError(
      new Error("publish: still waiting on CI for https://github.com/o/r/pull/13 — gave up waiting on PR #13"),
    ),
  ).toBe("transient");
});

test("a `read`/non-fast-forward LandError stays transient — it's a blip, not a GitHub verdict", () => {
  expect(
    classifyPublishError(
      new Error(
        "publish: GitHub did not settle this attempt — could not read PR #11 on o/r — cannot tell whether it is safe to merge.\nHTTP 502",
      ),
    ),
  ).toBe("transient");
  expect(
    classifyPublishError(
      new Error(
        "publish: GitHub did not settle this attempt — could not push beckett/run-x to o/r: ! [rejected] (non-fast-forward)",
      ),
    ),
  ).toBe("transient");
});

test("publishPrAdvice tells a human to clear the PR, never to push by hand", () => {
  const advice = publishPrAdvice("https://github.com/o/r/pull/9", "run-20260815-x");
  expect(advice).toContain("https://github.com/o/r/pull/9");
  expect(advice).toContain("beckett task courier run-20260815-x --pr-url https://github.com/o/r/pull/9");
  expect(advice).toContain("Do NOT push anything by hand");
});

test("a failure carrying a PR url gets PR advice, not push-it-by-hand advice", () => {
  const branchAdvice = "This branch's work is ALREADY on origin/main — do NOT push.";
  const plan = planPublishRetry(
    1,
    new Error("publish blocked: PR #11 (https://github.com/o/r/pull/11) has MERGE CONFLICTS with main"),
    1_000,
  );
  const reason = publishFailureReason(plan, 1, branchAdvice, "run-20260815-x");
  expect(reason).toContain("https://github.com/o/r/pull/11");
  expect(reason).toContain("beckett task courier run-20260815-x --pr-url https://github.com/o/r/pull/11");
  expect(reason).not.toContain(branchAdvice);
  expect(reason).not.toContain("Publish it by hand");

  // No PR url in the error → the branch-vs-main advice is still the fallback.
  const noPrPlan = planPublishRetry(4, new Error("fetch failed"), 1_000);
  const fallback = publishFailureReason(noPrPlan, 4, branchAdvice, "run-20260815-x");
  expect(fallback).toContain(branchAdvice);
});
