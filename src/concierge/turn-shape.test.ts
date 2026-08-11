/**
 * Turn-shape observability (log-only, no behavior change): a filing/staffing-shaped tool_use
 * block sets `liveTurnFilingShaped`, and `onResult` logs — never aborts — when the turn's
 * duration exceeds `FILING_TURN_BUDGET_MS`. A cheap, independent, complementary lever to the
 * mid-flow injection wiring (turn-interrupt.test.ts): that fix steers a long tool-heavy turn
 * that's already running; this one is just a signal for noticing HOW long those turns actually
 * run, before reaching for anything heavier (see index.ts's `FILING_TURN_BUDGET_MS` docstring).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConciergeSession, filingTurnBudgetExceeded, isFilingShapedToolUse } from "./index.ts";
import type { Config } from "../types.ts";

const config = {
  concierge: { model: "m", rotate_at_tokens: 190_000 },
  paths: {},
  harness: { claude: { bin: "claude", extra_flags: [] } },
} as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempBeckettDir(): void {
  const dir = mkdtempSync(join(tmpdir(), "beckett-turn-shape-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
}

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

// ── pure helpers ────────────────────────────────────────────────────────────────────────

test("isFilingShapedToolUse matches the filing/staffing marker list, not arbitrary commands", () => {
  expect(isFilingShapedToolUse('beckett task deploy --prompt "add rate limiting" --channel 1')).toBe(true);
  expect(isFilingShapedToolUse("beckett task create --title 'ship it'")).toBe(true);
  expect(isFilingShapedToolUse("beckett task start '#42.1' --title x")).toBe(true);
  expect(isFilingShapedToolUse("beckett ticket create --title y --project beckett")).toBe(true);
  expect(isFilingShapedToolUse("beckett ticket state OPS-1 in_progress")).toBe(true);
  expect(isFilingShapedToolUse("beckett plan --file wave.json")).toBe(true);
  expect(isFilingShapedToolUse("echo hi")).toBe(false);
  expect(isFilingShapedToolUse("git status")).toBe(false);
  expect(isFilingShapedToolUse("bun test src/concierge/")).toBe(false);
});

test("filingTurnBudgetExceeded is a strict boundary check on duration vs budget", () => {
  expect(filingTurnBudgetExceeded(19_999, 20_000)).toBe(false);
  expect(filingTurnBudgetExceeded(20_000, 20_000)).toBe(false); // exactly at budget: not exceeded
  expect(filingTurnBudgetExceeded(20_001, 20_000)).toBe(true);
  expect(filingTurnBudgetExceeded(5_000)).toBe(false); // default budget (20s) — well under
});

// ── onAssistant wiring ─────────────────────────────────────────────────────────────────────

interface SessionGuts {
  pending: {
    parts: string[];
    timer: ReturnType<typeof setTimeout>;
    timedOut: boolean;
    resolve: (output: unknown) => void;
    reject: (error: Error) => void;
  } | null;
  liveTurnFilingShaped: boolean;
  onAssistant(obj: Record<string, unknown>): void;
}

function makeSession(): SessionGuts {
  return new ConciergeSession({ config, logger: quietLog }) as unknown as SessionGuts;
}

function pendingStub() {
  return {
    parts: [] as string[],
    timer: setTimeout(() => undefined, 60_000),
    timedOut: false,
    resolve: () => {},
    reject: () => {},
  };
}

function assistantToolUse(command: string): Record<string, unknown> {
  return {
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  };
}

test("a filing-shaped tool_use block sets liveTurnFilingShaped", () => {
  tempBeckettDir();
  const s = makeSession();
  s.pending = pendingStub();
  expect(s.liveTurnFilingShaped).toBe(false);

  s.onAssistant(assistantToolUse("beckett task create --title 'ship it'"));

  expect(s.liveTurnFilingShaped).toBe(true);
  clearTimeout(s.pending!.timer);
});

test("a non-filing tool_use block leaves liveTurnFilingShaped false", () => {
  tempBeckettDir();
  const s = makeSession();
  s.pending = pendingStub();

  s.onAssistant(assistantToolUse("ls -la"));

  expect(s.liveTurnFilingShaped).toBe(false);
  clearTimeout(s.pending!.timer);
});

test("onAssistant with no live turn is a no-op (pending stays null)", () => {
  tempBeckettDir();
  const s = makeSession();
  s.pending = null;

  s.onAssistant(assistantToolUse("beckett task create --title 'ship it'"));

  expect(s.liveTurnFilingShaped).toBe(false);
  expect(s.pending).toBeNull();
});
