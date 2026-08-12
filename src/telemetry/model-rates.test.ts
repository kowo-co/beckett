import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateCost, type ModelRate, type RateTable } from "./harvest.ts";

const table = JSON.parse(readFileSync(join(process.cwd(), "config/model-rates.json"), "utf8")) as RateTable;
const claudeRows = Object.entries(table.models).filter(([name]) => name.startsWith("claude-"));

/**
 * Cache writes price at 2× input, not 1.25×.
 *
 * Claude Code writes 1-hour caches, so every cache-creation token bills at the 1h rate. A
 * least-squares fit of ccusage's own per-day, per-model costs against this table recovers exactly
 * 2.000× for every Claude model observed (haiku 4.5 $1→$2, opus 4.8 $5→$10, opus 5 $5→$10 and
 * sonnet 5 at its $2 intro rate →$4), reconciling the archive total to within 0.25%. At 1.25× the
 * same archive under-counts by ~11%. This test pins the multiplier so it cannot silently drift
 * back — see docs/token-efficiency.md.
 */
const CACHE_WRITE_MULTIPLIER = 2;

test("every Claude row prices cache writes at 2x input", () => {
  expect(claudeRows.length).toBeGreaterThan(0);
  for (const [name, rate] of claudeRows) {
    expect(`${name}: ${rate.cache_creation_multiplier}`).toBe(`${name}: ${CACHE_WRITE_MULTIPLIER}`);
    // The absolute `cache_write` column is the fallback used when no multiplier is present; keep
    // the two in agreement so either read of the row prices the same.
    expect(`${name}: ${rate.cache_write}`).toBe(`${name}: ${rate.input * CACHE_WRITE_MULTIPLIER}`);
    expect(rate.cache_read).toBeCloseTo(rate.input * (rate.cache_read_multiplier ?? 0.1), 10);
  }
});

test("calculateCost bills cache writes at 2x input for Claude models", () => {
  const haiku = table.models["claude-haiku-4-5"] as ModelRate;
  // 1M of each bucket: 1.00 in + 5.00 out + 0.10 cache read + 2.00 cache write.
  expect(calculateCost({ input: 1e6, output: 1e6, cache_read: 1e6, cache_write: 1e6 }, haiku)).toBe(8.1);
  expect(calculateCost({ input: 0, output: 0, cache_read: 0, cache_write: 1e6 }, haiku)).toBe(haiku.input * CACHE_WRITE_MULTIPLIER);
});

test("the estimate flags the Claude rows carry are preserved", () => {
  for (const [name, rate] of claudeRows) expect(`${name}: ${rate.estimate}`).toBe(`${name}: true`);
});
