/**
 * Turn-shape observability (log-only, no behavior change): a deploy-shaped tool_use
 * block sets `liveTurnDeployShaped`, and `onResult` logs — never aborts — when the turn's
 * duration exceeds `DEPLOY_TURN_BUDGET_MS`. A cheap, independent, complementary lever to the
 * mid-flow injection wiring (turn-interrupt.test.ts): that fix steers a long tool-heavy turn
 * that's already running; this one is just a signal for noticing HOW long those turns actually
 * run, before reaching for anything heavier (see index.ts's `DEPLOY_TURN_BUDGET_MS` docstring).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConciergeSession, deployTurnBudgetExceeded, isDeployShapedToolUse } from "./index.ts";
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

test("isDeployShapedToolUse matches the filing/staffing marker list, not arbitrary commands", () => {
  expect(isDeployShapedToolUse('beckett task deploy --prompt "add rate limiting" --channel 1')).toBe(true);
  expect(isDeployShapedToolUse("beckett task create --title 'ship it'")).toBe(true);
  expect(isDeployShapedToolUse("beckett task start '#42.1' --title x")).toBe(true);
  expect(isDeployShapedToolUse("beckett ticket create --title y --project beckett")).toBe(true);
  expect(isDeployShapedToolUse("beckett ticket state OPS-1 in_progress")).toBe(true);
  expect(isDeployShapedToolUse("beckett plan --file wave.json")).toBe(true);
  expect(isDeployShapedToolUse("echo hi")).toBe(false);
  expect(isDeployShapedToolUse("git status")).toBe(false);
  expect(isDeployShapedToolUse("bun test src/concierge/")).toBe(false);
});

test("deployTurnBudgetExceeded is a strict boundary check on duration vs budget", () => {
  expect(deployTurnBudgetExceeded(19_999, 20_000)).toBe(false);
  expect(deployTurnBudgetExceeded(20_000, 20_000)).toBe(false); // exactly at budget: not exceeded
  expect(deployTurnBudgetExceeded(20_001, 20_000)).toBe(true);
  expect(deployTurnBudgetExceeded(5_000, 240_000)).toBe(false); // well under the default budget
});

test("deployTurnBudgetExceeded at the real default (240s): a 3min turn does not warn, a 5min turn does", () => {
  expect(deployTurnBudgetExceeded(3 * 60_000)).toBe(false); // p95 of a good deploy turn
  expect(deployTurnBudgetExceeded(5 * 60_000)).toBe(true); // actually runaway
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
  liveTurnDeployShaped: boolean;
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

test("a deploy-shaped tool_use block sets liveTurnDeployShaped", () => {
  tempBeckettDir();
  const s = makeSession();
  s.pending = pendingStub();
  expect(s.liveTurnDeployShaped).toBe(false);

  s.onAssistant(assistantToolUse("beckett task create --title 'ship it'"));

  expect(s.liveTurnDeployShaped).toBe(true);
  clearTimeout(s.pending!.timer);
});

test("a non-deploy tool_use block leaves liveTurnDeployShaped false", () => {
  tempBeckettDir();
  const s = makeSession();
  s.pending = pendingStub();

  s.onAssistant(assistantToolUse("ls -la"));

  expect(s.liveTurnDeployShaped).toBe(false);
  clearTimeout(s.pending!.timer);
});

test("onAssistant with no live turn is a no-op (pending stays null)", () => {
  tempBeckettDir();
  const s = makeSession();
  s.pending = null;

  s.onAssistant(assistantToolUse("beckett task create --title 'ship it'"));

  expect(s.liveTurnDeployShaped).toBe(false);
  expect(s.pending).toBeNull();
});
