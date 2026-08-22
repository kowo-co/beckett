import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveTrainingStats,
  headLines,
  isSystemdUserUnitActive,
  parseJsonlRecords,
  readFileTailProgress,
  renderProgressBar,
  tailLines,
  type FileTailProgressSourceConfig,
  type TrainingStepRecord,
} from "./training-source.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-training-source-"));
  dirs.push(dir);
  return dir;
}

function record(step: number, loss: number, tokensSeen: number, tokensPerS = 300): TrainingStepRecord {
  return {
    step, loss, tokensSeen, docsConsumed: step * 2, elapsedS: step * 3, tokensPerS,
    wallClock: "2026-08-22T19:00:00+00:00", threads: 6, batchSize: 8, blockSize: 1024,
  };
}

function jsonlLine(r: TrainingStepRecord): string {
  return JSON.stringify({
    step: r.step, loss: r.loss, tokens_seen: r.tokensSeen, docs_consumed: r.docsConsumed,
    elapsed_s: r.elapsedS, tokens_per_s: r.tokensPerS, wall_clock: r.wallClock,
    threads: r.threads, batch_size: r.batchSize, block_size: r.blockSize,
  });
}

// ── bounded tail/head reads ───────────────────────────────────────────────────────────────────

test("tailLines returns the last complete lines within the byte budget, dropping a partial leading line", () => {
  const dir = tmpDir();
  const path = join(dir, "log.txt");
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  // A tight byte budget forces a mid-file start, so the first captured line may be a partial cut.
  const tail = tailLines(path, 40, 100);
  expect(tail.length).toBeGreaterThan(0);
  expect(tail.at(-1)).toBe("line-49");
  // Every returned line must be one of the real, complete lines — never a truncated fragment.
  for (const line of tail) expect(lines).toContain(line);
});

test("tailLines never reads past the byte budget even for a huge file (bounded, not a full read)", () => {
  const dir = tmpDir();
  const path = join(dir, "huge.txt");
  const many = Array.from({ length: 20_000 }, (_, i) => `step-${i}`).join("\n") + "\n";
  writeFileSync(path, many);
  const tail = tailLines(path, 200, 10);
  expect(tail.length).toBeLessThanOrEqual(10);
  expect(tail.at(-1)).toBe("step-19999");
});

test("tailLines drops an unterminated in-progress last line (mid-write)", () => {
  const dir = tmpDir();
  const path = join(dir, "mid-write.txt");
  writeFileSync(path, "complete-1\ncomplete-2\npartial-in-progr");
  expect(tailLines(path, 1024, 10)).toEqual(["complete-1", "complete-2"]);
});

test("tailLines and headLines degrade to empty for a missing file, never throw", () => {
  const missing = join(tmpDir(), "does-not-exist.txt");
  expect(tailLines(missing, 1024, 10)).toEqual([]);
  expect(headLines(missing, 1024, 10)).toEqual([]);
});

test("headLines returns the earliest complete lines, dropping a partial trailing line", () => {
  const dir = tmpDir();
  const path = join(dir, "log.txt");
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  const head = headLines(path, 40, 100);
  expect(head[0]).toBe("line-0");
  for (const line of head) expect(lines).toContain(line);
});

// ── loss.jsonl parsing ────────────────────────────────────────────────────────────────────────

test("parseJsonlRecords parses well-formed rows and drops malformed/partial ones", () => {
  const good = record(5, 6.5, 10_000);
  const lines = [jsonlLine(good), "{not json", '{"step": 6}', ""];
  expect(parseJsonlRecords(lines)).toEqual([good]);
});

// ── token-budget / trend / ETA math ───────────────────────────────────────────────────────────

test("renderProgressBar fills proportionally and clamps out-of-range percentages", () => {
  expect(renderProgressBar(0)).toBe("[--------------------]");
  expect(renderProgressBar(100)).toBe("[####################]");
  expect(renderProgressBar(50)).toBe("[##########----------]");
  expect(renderProgressBar(150)).toBe("[####################]");
  expect(renderProgressBar(-10)).toBe("[--------------------]");
});

test("deriveTrainingStats computes percent, trend, and ETA from the token budget", () => {
  const recent = [record(10, 3.0, 100_000, 200), record(11, 2.0, 110_000, 200)];
  const first = [record(1, 6.0, 1_000), record(2, 5.0, 2_000)];
  const stats = deriveTrainingStats(recent, first, 1_000_000);
  expect(stats).not.toBeNull();
  expect(stats!.latest.step).toBe(11);
  expect(stats!.recentAvgLoss).toBeCloseTo(2.5, 5);
  expect(stats!.firstAvgLoss).toBeCloseTo(5.5, 5);
  expect(stats!.tokensPct).toBeCloseTo(11, 5); // 110_000 / 1_000_000 * 100
  // remaining = 890_000 tokens at 200 tok/s = 4_450s = 4_450_000ms
  expect(stats!.etaMs).toBeCloseTo(4_450_000, 0);
});

test("deriveTrainingStats has no first-window baseline yet when the head read found nothing", () => {
  const stats = deriveTrainingStats([record(1, 4.0, 500)], [], 1_000_000);
  expect(stats!.firstAvgLoss).toBeNull();
});

test("deriveTrainingStats returns null with no recent data — 'no data yet', not a crash", () => {
  expect(deriveTrainingStats([], [], 1_000_000)).toBeNull();
});

test("deriveTrainingStats reports no ETA when the observed rate is zero", () => {
  const stats = deriveTrainingStats([record(1, 4.0, 500, 0)], [], 1_000_000);
  expect(stats!.etaMs).toBeNull();
});

test("deriveTrainingStats clamps percent at 100 once the budget is exceeded", () => {
  const stats = deriveTrainingStats([record(1, 4.0, 2_000_000, 300)], [], 1_000_000);
  expect(stats!.tokensPct).toBe(100);
  expect(stats!.etaMs).toBe(0);
});

// ── systemd unit liveness ─────────────────────────────────────────────────────────────────────

test("isSystemdUserUnitActive reflects the real box (either active or not, never throws)", () => {
  expect(typeof isSystemdUserUnitActive("this-unit-almost-certainly-does-not-exist.service")).toBe("boolean");
  expect(isSystemdUserUnitActive("this-unit-almost-certainly-does-not-exist.service")).toBe(false);
});

// ── the whole source, end to end ──────────────────────────────────────────────────────────────

function config(dir: string, overrides: Partial<FileTailProgressSourceConfig> = {}): FileTailProgressSourceConfig {
  return {
    label: "test training run",
    unit: "test-training.service",
    jsonlPath: join(dir, "loss.jsonl"),
    consoleLogPath: join(dir, "train.out"),
    tokenBudget: 1_000_000,
    channelId: "123",
    ...overrides,
  };
}

test("readFileTailProgress reports active with live numbers when the unit is active and logs exist", () => {
  const dir = tmpDir();
  const records = [record(1, 6.0, 1_000), record(2, 5.5, 2_000), record(3, 5.0, 3_000)];
  writeFileSync(join(dir, "loss.jsonl"), records.map(jsonlLine).join("\n") + "\n");
  writeFileSync(join(dir, "train.out"), "[step 1] loss 6.0\n[step 2] loss 5.5\n[step 3] loss 5.0\n");
  const snapshot = readFileTailProgress(config(dir), { isUnitActive: () => true });
  expect(snapshot.active).toBe(true);
  expect(snapshot.stats?.latest.step).toBe(3);
  expect(snapshot.consoleLines).toEqual(["[step 1] loss 6.0", "[step 2] loss 5.5", "[step 3] loss 5.0"]);
});

test("readFileTailProgress reports not-active plainly and does not fabricate live numbers", () => {
  const dir = tmpDir();
  const snapshot = readFileTailProgress(config(dir), { isUnitActive: () => false });
  expect(snapshot.active).toBe(false);
});

test("readFileTailProgress degrades to 'no data yet' when the jsonl is absent, without crashing", () => {
  const dir = tmpDir();
  const snapshot = readFileTailProgress(config(dir), { isUnitActive: () => true });
  expect(snapshot.active).toBe(true);
  expect(snapshot.stats).toBeNull();
  expect(snapshot.consoleLines).toEqual([]);
});

test("readFileTailProgress tolerates a partial final jsonl line (mid-write)", () => {
  const dir = tmpDir();
  const complete = [record(1, 6.0, 1_000), record(2, 5.5, 2_000)];
  const body = complete.map(jsonlLine).join("\n") + "\n" + '{"step": 3, "loss": 5.0, "tokens_se';
  writeFileSync(join(dir, "loss.jsonl"), body);
  const snapshot = readFileTailProgress(config(dir), { isUnitActive: () => true });
  expect(snapshot.stats?.latest.step).toBe(2);
});
