import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPublishError,
  planPublishRetry,
  publishErrorMessage,
  PublishOutbox,
  PUBLISH_MAX_ATTEMPTS,
  PUBLISH_RETRY_DELAYS_MS,
  type PublishOperation,
} from "./publish-outbox.ts";
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
