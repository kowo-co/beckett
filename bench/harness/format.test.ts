import { describe, expect, test } from "bun:test";
import { parseResultsJsonl, renderCompareTable, renderRunTable, type TaskResult } from "./format.ts";

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    runId: "abc1234",
    suite: "default",
    taskId: "fix-bug",
    model: "claude-sonnet-5",
    effort: "low",
    solved: true,
    timedOut: false,
    spawnFailed: false,
    finishedStatus: "success",
    finishedSubtype: "success",
    errorClass: null,
    turns: 5,
    toolCalls: 9,
    tokens: { input: 1000, output: 200, cacheRead: 0, cacheCreate: 0 },
    usd: 0.05,
    wallClockMs: 30_000,
    sessionId: "sess-1",
    startedAt: "2026-08-09T12:00:00.000Z",
    ...overrides,
  };
}

describe("parseResultsJsonl", () => {
  test("parses records and skips blank lines", () => {
    const text =
      JSON.stringify(makeResult()) +
      "\n\n" +
      JSON.stringify(makeResult({ taskId: "refactor", tokens: { input: 42, output: 7, cacheRead: 0, cacheCreate: 0 } })) +
      "\n";

    const parsed = parseResultsJsonl(text);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.taskId).toBe("fix-bug");
    expect(parsed[0]!.tokens.input).toBe(1000);
    expect(parsed[1]!.taskId).toBe("refactor");
    expect(parsed[1]!.tokens.input).toBe(42);
  });

  test("throws with the line number on malformed input", () => {
    const text = JSON.stringify(makeResult()) + "\nnot json\n";
    expect(() => parseResultsJsonl(text)).toThrow(/line 2/);
  });
});

describe("renderRunTable", () => {
  test("shows each task, its outcome, and a summary", () => {
    const out = renderRunTable([
      makeResult(),
      makeResult({ taskId: "refactor", solved: false, timedOut: true }),
    ]);

    expect(out).toContain("fix-bug");
    expect(out).toContain("refactor");
    expect(out).toContain("yes");
    expect(out).toContain("TIMEOUT");
    expect(out).toContain("1/2 solved");
  });
});

describe("renderCompareTable", () => {
  test("shows solved flips, signed deltas, and one-sided tasks", () => {
    const a = [
      makeResult({ solved: false, turns: 8 }),
      makeResult({ taskId: "refactor" }),
    ];
    const b = [makeResult({ solved: true, turns: 6 })];

    const out = renderCompareTable(a, b, { a: "a", b: "b" });

    expect(out).toContain("no -> yes");
    expect(out).toContain("-2");
    expect(out).toContain("(only in a)");
    expect(out).toContain("solved:");
  });
});
