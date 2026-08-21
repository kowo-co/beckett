import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLifecycleEvent } from "../uptime.ts";
import { gatherOwnHistory, recentRunIncidents, recentUptimeIncidents, recentJournalHighlights } from "./own-history.ts";

const NOW = new Date("2026-08-21T12:00:00.000Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-own-history-"));
  dirs.push(dir);
  return dir;
}

// ── recentRunIncidents ───────────────────────────────────────────────────────────────────────

test("surfaces a recent failed/bounced/interrupted run row, skipping a clean pass", () => {
  const dir = tmp();
  const path = join(dir, "dispatch.jsonl");
  const rows = [
    { ts: "2026-08-20T10:00:00.000Z", runId: "r1", runRef: "#1", branchRef: "b1", stage: "review", outcome: "passed", elapsedMs: 100 },
    {
      ts: "2026-08-20T11:00:00.000Z",
      runId: "r2",
      runRef: "#2",
      branchRef: "b2",
      stage: "implement",
      outcome: "failed",
      error: "tests red",
      elapsedMs: 100,
    },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const items = recentRunIncidents(path, NOW);
  expect(items).toHaveLength(1);
  expect(items[0]!.summary).toContain("#2");
  expect(items[0]!.summary).toContain("tests red");
  expect(items[0]!.source).toBe("run ledger");
});

test("drops a run row older than the age window", () => {
  const dir = tmp();
  const path = join(dir, "dispatch.jsonl");
  const row = {
    ts: "2026-01-01T00:00:00.000Z",
    runId: "r1",
    runRef: "#1",
    branchRef: "b1",
    stage: "implement",
    outcome: "failed",
    elapsedMs: 100,
  };
  writeFileSync(path, `${JSON.stringify(row)}\n`);
  expect(recentRunIncidents(path, NOW)).toEqual([]);
});

test("a missing dispatch ledger degrades to empty, not a throw", () => {
  expect(recentRunIncidents("/nonexistent/dispatch.jsonl", NOW)).toEqual([]);
});

// ── recentUptimeIncidents ────────────────────────────────────────────────────────────────────

test("surfaces an unclean restart and a downtime window", () => {
  const dir = tmp();
  const path = join(dir, "uptime.jsonl");
  appendLifecycleEvent(path, { kind: "boot", at: "2026-08-19T00:00:00.000Z" });
  appendLifecycleEvent(path, { kind: "clean_shutdown", at: "2026-08-19T01:00:00.000Z" });
  appendLifecycleEvent(path, { kind: "boot", at: "2026-08-19T01:05:00.000Z" });
  appendLifecycleEvent(path, { kind: "unclean_restart", at: "2026-08-19T02:00:00.000Z" });
  appendLifecycleEvent(path, { kind: "boot", at: "2026-08-19T02:00:01.000Z" });

  const items = recentUptimeIncidents(path, NOW);
  expect(items.some((i) => i.summary.includes("restarted unclean"))).toBe(true);
  expect(items.some((i) => i.summary.includes("down from"))).toBe(true);
  expect(items.every((i) => i.source === "uptime ledger")).toBe(true);
});

test("a missing uptime ledger degrades to empty, not a throw", () => {
  expect(recentUptimeIncidents("/nonexistent/uptime.jsonl", NOW)).toEqual([]);
});

// ── recentJournalHighlights ──────────────────────────────────────────────────────────────────

test("pulls one notable line from a recent ticket journal", () => {
  const dir = tmp();
  writeFileSync(
    join(dir, "run-1.log"),
    [
      "2026-08-20T09:00:00.000Z ▸ implement worker started (claude-sonnet-5)",
      "2026-08-20T09:05:00.000Z ✗ implement failed: scope guard blocked a write outside the worktree",
    ].join("\n") + "\n",
  );
  const items = recentJournalHighlights(dir, NOW);
  expect(items).toHaveLength(1);
  expect(items[0]!.summary).toContain("run-1");
  expect(items[0]!.summary).toContain("scope guard blocked");
  expect(items[0]!.at).toBe("2026-08-20T09:05:00.000Z");
});

test("a ticket journal with nothing notable contributes nothing", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run-2.log"), "2026-08-20T09:00:00.000Z ▸ implement worker started (claude-sonnet-5)\n");
  expect(recentJournalHighlights(dir, NOW)).toEqual([]);
});

test("a missing journal dir degrades to empty, not a throw", () => {
  expect(recentJournalHighlights("/nonexistent/journal", NOW)).toEqual([]);
});

// ── gatherOwnHistory — combines all three, newest first ──────────────────────────────────────

test("combines run/uptime/journal sources, sorted newest first", () => {
  const dir = tmp();
  const dispatchEventsPath = join(dir, "events", "dispatch.jsonl");
  mkdirSync(join(dir, "events"), { recursive: true });
  writeFileSync(
    dispatchEventsPath,
    `${JSON.stringify({
      ts: "2026-08-21T08:00:00.000Z",
      runId: "r1",
      runRef: "#1",
      branchRef: "b1",
      stage: "implement",
      outcome: "failed",
      error: "boom",
      elapsedMs: 1,
    })}\n`,
  );
  const uptimeLedgerPath = join(dir, "uptime.jsonl");
  appendLifecycleEvent(uptimeLedgerPath, { kind: "boot", at: "2026-08-20T00:00:00.000Z" });
  appendLifecycleEvent(uptimeLedgerPath, { kind: "unclean_restart", at: "2026-08-20T01:00:00.000Z" });
  appendLifecycleEvent(uptimeLedgerPath, { kind: "boot", at: "2026-08-20T01:00:01.000Z" });
  const journalDir = join(dir, "journal");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, "run-2.log"), "2026-08-21T10:00:00.000Z ⚠ review: something broke\n");

  const items = gatherOwnHistory({ dispatchEventsPath, uptimeLedgerPath, journalDir }, NOW);
  expect(items.length).toBeGreaterThanOrEqual(3);
  // newest first
  for (let i = 1; i < items.length; i++) {
    expect(Date.parse(items[i - 1]!.at)).toBeGreaterThanOrEqual(Date.parse(items[i]!.at));
  }
});
