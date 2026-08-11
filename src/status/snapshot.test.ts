import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSpendRecord } from "../spend.ts";
import { recordBoot, uptimeLedgerPath } from "../uptime.ts";
import { createStatusSnapshotCollector } from "./snapshot.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("snapshot collector gathers lifecycle, metrics, the run board, and rolling harness usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-status-snapshot-"));
  dirs.push(dir);
  const now = 10_000_000;
  const lifecycle = uptimeLedgerPath(dir);
  recordBoot(lifecycle, now - 20_000);
  appendSpendRecord(join(dir, "spend.jsonl"), {
    ticketId: "OPS-1", project: null, stage: "implement", harness: "claude", model: "m", effort: "low",
    turns: 2, toolCalls: 1, tokensIn: 100, tokensOut: 25, costUsd: null, durationMs: 1, outcome: "done", reviewTier: "self",
    ts: new Date(now - 1_000).toISOString(),
  });
  const collector = createStatusSnapshotCollector({
    version: "test", pollIntervalMs: 5_000,
    runs: {
      live: () => [{ state: "implementing" as const }, { state: "queued" as const }, { state: "parked" as const }],
      lastTickAt: () => now - 1_000,
    },
    metrics: { read: async () => ({ source: "proc", collectedAt: new Date(now).toISOString(), cpu: { loadPercent: 1 }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2 }, cpuLoad: 1, memoryUsed: 1, memoryTotal: 2, diskUsed: 1, diskTotal: 2 }) },
    lifecycleLedgerPath: lifecycle, spendPath: join(dir, "spend.jsonl"), now: () => now,
    ccusage: { collect: async () => ({ available: true, sessionCostUsd: 1.5, dailyCostUsd: 4.25, observedAt: new Date(now).toISOString() }) },
  });

  const snapshot = await collector.collect();
  expect(snapshot.ccusage).toEqual({ available: true, sessionCostUsd: 1.5, dailyCostUsd: 4.25, observedAt: new Date(now).toISOString() });
  expect(snapshot.uptime.currentUptimeMs).toBe(20_000);
  expect(snapshot.versions).toMatchObject({ beckett: "test" });
  expect(snapshot.runs).toEqual({ live: 3, queued: 1, parked: 1 });
  expect(snapshot.health.map((entry) => [entry.name, entry.reachable])).toEqual([["Run supervisor", true]]);
  expect(snapshot.health[0]!.detail).toBe("3 live · 1 queued · 1 parked");
  expect(snapshot.harnessUsage).toEqual([{ harness: "claude", last24h: expect.objectContaining({ turns: 2 }), last7d: expect.objectContaining({ turns: 2 }) }]);
});

test("snapshot collector degrades to unavailable ccusage spend instead of throwing when the source fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-status-snapshot-"));
  dirs.push(dir);
  const now = 10_000_000;
  const lifecycle = uptimeLedgerPath(dir);
  recordBoot(lifecycle, now - 20_000);
  const collector = createStatusSnapshotCollector({
    version: "test", pollIntervalMs: 5_000,
    runs: { live: () => [], lastTickAt: () => null },
    metrics: { read: async () => ({ source: "proc", collectedAt: new Date(now).toISOString(), cpu: { loadPercent: 1 }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2 }, cpuLoad: 1, memoryUsed: 1, memoryTotal: 2, diskUsed: 1, diskTotal: 2 }) },
    lifecycleLedgerPath: lifecycle, spendPath: join(dir, "spend.jsonl"), now: () => now,
    ccusage: { collect: async () => { throw new Error("npx ccusage failed"); } },
  });

  const snapshot = await collector.collect();
  expect(snapshot.ccusage).toEqual({ available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null });
  // Before the supervisor's first tick there is no honest liveness claim to make.
  expect(snapshot.health[0]!.reachable).toBeNull();
  expect(snapshot.runs).toEqual({ live: 0, queued: 0, parked: 0 });
});

test("a run-store read failure degrades to an empty board instead of failing the whole snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-status-snapshot-"));
  dirs.push(dir);
  const now = 10_000_000;
  const lifecycle = uptimeLedgerPath(dir);
  recordBoot(lifecycle, now - 20_000);
  const collector = createStatusSnapshotCollector({
    version: "test", pollIntervalMs: 5_000,
    runs: {
      live: () => { throw new Error("runs.json is unreadable"); },
      lastTickAt: () => { throw new Error("runs.json is unreadable"); },
    },
    metrics: { read: async () => ({ source: "proc", collectedAt: new Date(now).toISOString(), cpu: { loadPercent: 1 }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2 }, cpuLoad: 1, memoryUsed: 1, memoryTotal: 2, diskUsed: 1, diskTotal: 2 }) },
    lifecycleLedgerPath: lifecycle, spendPath: join(dir, "spend.jsonl"), now: () => now,
    ccusage: { collect: async () => ({ available: false, sessionCostUsd: null, dailyCostUsd: null, observedAt: null }) },
  });

  const snapshot = await collector.collect();
  expect(snapshot.runs).toEqual({ live: 0, queued: 0, parked: 0 });
  expect(snapshot.health[0]!.reachable).toBeNull();
});
