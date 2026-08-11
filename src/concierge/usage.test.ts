/**
 * Unit coverage for the concierge's context-size accounting (issue #5 auto-compaction).
 * The one thing that must be right: context size sums ALL input-side usage fields, not just
 * `input_tokens` (which is only the uncached delta and would never reach the rotate ceiling).
 */

import { expect, test } from "bun:test";
import { ConciergeSession, contextTokensFromUsage } from "./index.ts";
import type { Config } from "../types.ts";

const config = { concierge: { model: "m", rotate_at_tokens: 160_000 }, paths: {}, harness: { claude: { bin: "claude", extra_flags: [] } } } as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

/** The private surface the live-context tests script — the real handleLine dispatch. */
interface UsageGuts {
  child: unknown;
  lastContextTokens: number;
  sawStreamedUsage: boolean;
  handleLine(line: string, from: unknown): void;
}

function usageSession(): { s: UsageGuts; child: object } {
  const s = new ConciergeSession({ config, logger: quietLog }) as unknown as UsageGuts;
  const child = { kill() {} };
  s.child = child;
  return { s, child };
}

const assistantFrame = (usage: Record<string, number>): string =>
  JSON.stringify({ type: "assistant", message: { content: [], usage } });

test("sums input + cache_creation + cache_read", () => {
  expect(
    contextTokensFromUsage({
      input_tokens: 12,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: 188_000,
    }),
  ).toBe(189_012);
});

test("warm session: nearly all mass is cache_read, tiny input delta", () => {
  // input_tokens alone (12) is far below any ceiling; the real context size is ~191k.
  const usage = { input_tokens: 12, cache_read_input_tokens: 191_000 };
  expect(contextTokensFromUsage(usage)).toBe(191_012);
});

test("output_tokens never counts toward context size", () => {
  expect(contextTokensFromUsage({ input_tokens: 100, output_tokens: 5_000 })).toBe(100);
});

test("non-usage / partial input is 0, never NaN", () => {
  expect(contextTokensFromUsage(null)).toBe(0);
  expect(contextTokensFromUsage(undefined)).toBe(0);
  expect(contextTokensFromUsage("nope")).toBe(0);
  expect(contextTokensFromUsage({})).toBe(0);
  expect(contextTokensFromUsage({ input_tokens: "x" })).toBe(0);
});

// ── issue #229: live context, not lifetime throughput ──────────────────────────────────────

test("issue #229: the result frame's CUMULATIVE usage never overwrites streamed live context", () => {
  const { s, child } = usageSession();
  // A tool-heavy turn: six API requests, each re-sending the same ~150k context.
  s.handleLine(assistantFrame({ input_tokens: 12, cache_read_input_tokens: 150_000 }), child);
  s.handleLine(assistantFrame({ input_tokens: 40, cache_read_input_tokens: 151_000 }), child);
  expect(s.lastContextTokens).toBe(151_040);

  // The `result` frame totals every request the turn made — the 905k that made the re-grounder
  // fire against a 160k watermark on a context no 200k model could even hold.
  s.handleLine(JSON.stringify({ type: "result", usage: { input_tokens: 300, cache_read_input_tokens: 905_397 } }), child);

  expect(s.lastContextTokens).toBe(151_040);
});

test("issue #229: a turn that streamed no usage still gets its size from the result frame", () => {
  const { s, child } = usageSession();
  s.handleLine(JSON.stringify({ type: "result", usage: { input_tokens: 12, cache_read_input_tokens: 88_000 } }), child);
  // One request, so the turn total IS that request's context — the honest fallback.
  expect(s.lastContextTokens).toBe(88_012);
});

test("issue #229: the newest request wins, even when the context SHRANK", () => {
  const { s, child } = usageSession();
  s.handleLine(assistantFrame({ input_tokens: 10, cache_read_input_tokens: 180_000 }), child);
  // Post-rotation the same session's next request is small again; a running sum could never
  // come back down, which is exactly why the watermark must read the latest request.
  s.handleLine(assistantFrame({ input_tokens: 10, cache_read_input_tokens: 4_000 }), child);
  expect(s.lastContextTokens).toBe(4_010);
});
