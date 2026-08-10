import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendSpendRecord, FREE_TIME_SPEND_TICKET_ID, formatWeeklyBill, isAttempt, parseSince, readSpendLedger, spendForTicket, summarizeSpend, summarizeSpendByTicket, summarizeSpendWindows, type SpendRecord } from "./spend.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function row(overrides: Partial<SpendRecord> = {}): SpendRecord {
  return {
    ticketId: "OPS-123", project: "beckett", stage: "implement" as const,
    harness: "pi", model: "gpt-test", effort: "medium", turns: 2, toolCalls: 3,
    tokensIn: 100, tokensOut: 20, costUsd: null, durationMs: 44, outcome: "done" as const,
    reviewTier: "self" as const, ts: "2026-07-10T00:00:00.000Z", ...overrides,
  };
}

test("spend ledger appends JSONL and ignores a crash-truncated tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-spend-")); dirs.push(dir);
  const path = join(dir, "nested", "spend.jsonl");
  appendSpendRecord(path, row());
  appendSpendRecord(path, row({ stage: "review", outcome: "rework", costUsd: 0.25 }));
  appendFileSync(path, '{"ticketId":"interrupted"');
  const rows = readSpendLedger(path);
  expect(rows).toHaveLength(2);
  expect(summarizeSpend(rows)).toMatchObject({
    totals: { records: 2, costUsd: 0.25, unknownCostRecords: 1 },
    byProject: [{ name: "beckett", records: 2 }],
  });
});

test("relative --since windows are parsed", () => {
  expect(parseSince("24h", 100_000_000)).toBe(13_600_000);
  expect(parseSince("nonsense")).toBeNull();
});

test("spend groups dynamically by harness and offers rolling 24h and 7d windows", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  const rows = [
    row({ harness: "pi", ts: "2026-07-10T11:00:00.000Z" }),
    row({ harness: "future-harness", ts: "2026-07-04T12:00:00.000Z" }),
    row({ harness: "old-harness", ts: "2026-07-01T12:00:00.000Z" }),
  ];
  expect(summarizeSpend(rows, { since: "24h", now }).byHarness).toEqual([{ name: "pi", records: 1, turns: 2, toolCalls: 3, tokensIn: 100, tokensOut: 20, costUsd: null, unknownCostRecords: 1 }]);
  const windows = summarizeSpendWindows(rows, now);
  expect(windows.last24h.totals.records).toBe(1);
  expect(windows.last7d.byHarness.map((group) => group.name)).toEqual(["future-harness", "pi"]);
});

test("spendForTicket sums a task's cost and treats unknown-cost rows as $0 (#77)", () => {
  const rows = [
    row({ ticketId: "OPS-1", costUsd: 1.5 }),
    row({ ticketId: "OPS-1", stage: "review", costUsd: 0.5 }),
    row({ ticketId: "OPS-1", costUsd: null }), // unknown cost → contributes 0, never NaN
    row({ ticketId: "OPS-2", costUsd: 9 }),
  ];
  expect(spendForTicket(rows, "OPS-1")).toBe(2);
  expect(spendForTicket(rows, "OPS-2")).toBe(9);
  // A task with no ledger rows reads as $0 — the guarantee that predating tickets never trip a cap.
  expect(spendForTicket(rows, "OPS-NEVER-SEEN")).toBe(0);
  expect(spendForTicket([], "OPS-1")).toBe(0);
});

test("summarizeSpendByTicket rolls up per task, sorted by cost desc (#77)", () => {
  const rows = [
    row({ ticketId: "OPS-1", project: "alpha", costUsd: 1 }),
    row({ ticketId: "OPS-1", project: "alpha", costUsd: 2 }),
    row({ ticketId: "OPS-2", project: "beta", costUsd: 5 }),
    row({ ticketId: "OPS-3", project: "gamma", costUsd: null }), // all-unknown → costUsd null
  ];
  const byTicket = summarizeSpendByTicket(rows);
  expect(byTicket.map((t) => t.ticketId)).toEqual(["OPS-2", "OPS-1", "OPS-3"]);
  expect(byTicket.find((t) => t.ticketId === "OPS-1")).toMatchObject({ costUsd: 3, records: 2, project: "alpha" });
  expect(byTicket.find((t) => t.ticketId === "OPS-3")).toMatchObject({ costUsd: null, unknownCostRecords: 1 });
});

test("formatWeeklyBill renders per-task totals, honoring the window (#77)", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  const rows = [
    row({ ticketId: "OPS-1", project: "alpha", costUsd: 2, ts: "2026-07-09T12:00:00.000Z" }),
    row({ ticketId: "OPS-2", project: "beta", costUsd: 5, ts: "2026-07-08T12:00:00.000Z" }),
    row({ ticketId: "OPS-OLD", costUsd: 99, ts: "2026-06-01T12:00:00.000Z" }), // outside the 7d window
  ];
  const bill = formatWeeklyBill(rows, { now, since: "7d" });
  expect(bill).toContain("Weekly bill");
  expect(bill).toContain("$7.00"); // total of the two in-window tasks, not the old $99
  expect(bill).toContain("OPS-2 (beta)");
  expect(bill).toContain("OPS-1 (alpha)");
  expect(bill).not.toContain("OPS-OLD");
});

test("formatWeeklyBill reports an empty ledger without throwing (#77)", () => {
  expect(formatWeeklyBill([])).toContain("no worker spend recorded");
});

// ── the free-time lane (docs/freetime.md) ──────────────────────────────────────────────

test("the row guard accepts the free-time stage and still rejects a stage it does not know", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-spend-")); dirs.push(dir);
  const path = join(dir, "spend.jsonl");
  appendSpendRecord(path, row({ ticketId: FREE_TIME_SPEND_TICKET_ID, project: null, stage: "free-time", sessionId: "2026-08-09-deadbeef" }));
  // Garbage in the stage column is dropped on read, exactly as a truncated line is: a widened
  // union is still a closed one.
  appendFileSync(path, `\n${JSON.stringify({ ...row(), stage: "deploy" })}\n`);
  appendFileSync(path, `\n${JSON.stringify({ ...row(), stage: 7 })}\n`);
  appendFileSync(path, `\n${JSON.stringify({ ...row(), stage: undefined })}\n`);
  const rows = readSpendLedger(path);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ stage: "free-time", sessionId: "2026-08-09-deadbeef" });
});

test("a free-time run is not an attempt at anything — only launch failures share that (#159)", () => {
  expect(isAttempt(row())).toBe(true);
  expect(isAttempt(row({ outcome: "failed" }))).toBe(true);
  expect(isAttempt(row({ outcome: "launch_failed" }))).toBe(false);
  // Nothing was owed and nothing reviewed it, so it is not a run any cast should be scored on.
  expect(isAttempt(row({ stage: "free-time", outcome: "done" }))).toBe(false);
});

test("a free-time row rolls up as its own stage and one honest line on the weekly bill", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  const freeTime = (over: Partial<SpendRecord> = {}) =>
    row({ ticketId: FREE_TIME_SPEND_TICKET_ID, project: null, stage: "free-time",
      harness: "claude", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 900, costUsd: null,
      ts: "2026-07-09T12:00:00.000Z", ...over });
  const rows = [
    row({ ticketId: "OPS-1", project: "alpha", costUsd: 2, ts: "2026-07-09T12:00:00.000Z" }),
    freeTime(),
    freeTime({ ts: "2026-07-08T12:00:00.000Z", tokensOut: 100 }),
  ];

  const summary = summarizeSpend(rows, { since: "7d", now });
  expect(summary.byStage.map((s) => s.name)).toEqual(["free-time", "implement"]);
  expect(summary.byStage.find((s) => s.name === "free-time")).toMatchObject({ records: 2, tokensOut: 1000, costUsd: null, unknownCostRecords: 2 });
  // A lane with no ticket has no project either; it lands in the same bucket every unattributed
  // row does rather than inventing one.
  expect(summary.byProject.map((p) => p.name)).toEqual(["(unknown)", "alpha"]);

  // The per-task rollup collapses every session onto the sentinel: one line, two runs, no cost.
  const byTicket = summarizeSpendByTicket(rows, { since: "7d", now });
  expect(byTicket.map((t) => t.ticketId)).toEqual(["OPS-1", "free-time"]);
  expect(byTicket.find((t) => t.ticketId === "free-time")).toMatchObject({ records: 2, costUsd: null, project: null, unknownCostRecords: 2 });

  const bill = formatWeeklyBill(rows, { now, since: "7d" });
  expect(bill).toContain("**free-time** — — · 2 run(s) · 2 run(s) w/o cost data");
  expect(bill).toContain("$2.00"); // the unpriced sessions do not pretend to be $0 in the total
});
