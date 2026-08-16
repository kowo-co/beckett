/**
 * Beckett — fake-harness scenarios (`src/test/scenarios.ts`)
 * =======================================================================================
 * The scripted "what does the worker do" half of the {@link file://./fake-harness.ts}
 * integration backbone (Spec 12 §5.2). Each scenario is a deterministic list of timed
 * **beats** the fake harness replays on stdout in the *exact* `claude -p` stream-json wire
 * format — byte-faithful to the frames the real ClaudeDriver parses (Spec 02 §7.1 and
 * my-docs/claude-code-headless.md §1). Pairing scripted frames with real filesystem effects
 * lets the WHOLE loop (spawn → tail → smoke-alarm → nudge → integrate → review → gate →
 * deliver, plus crash-recovery via `--resume`) run deterministically, fast, and at **zero
 * subscription cost**.
 *
 * Design split (one-directional dependency: harness → scenarios, never the reverse):
 *   - This file owns the *wire-format line builders* and the *scenario script registry*.
 *   - `fake-harness.ts` owns the *runtime* (arg/stdin parsing, timing, nudge draining,
 *     branch switching, performing the filesystem effects, process exit semantics).
 *
 * The six v0 fixtures (Spec 12 §5.2): happy-path, no-progress (drift alarm), scope-violation
 * (hook deny), max-turns-fail, mid-task-nudge (branches the canned output to prove the nudge
 * changed behavior), daemon-restart (crashes mid-turn, finishes on `--resume`).
 *
 * Import style: explicit `.ts` extensions (Foundation contract).
 */

import { randomUUID } from "node:crypto";
import type { DoneSignal } from "../types.ts";

// =======================================================================================
// Scenario shapes
// =======================================================================================

/** One raw NDJSON object as written to stdout (a single `claude -p` stream-json line). */
export type RawLine = Record<string, unknown>;

/** Terminal `result.subtype` values (Spec 02 §7.1 terminal-state table). */
export type ResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_during_execution"
  | "error_max_structured_output_retries";

/** A real filesystem mutation the harness performs so the worktree diff is genuine. */
export type FsEffect =
  | { op: "write"; path: string; content: string }
  | { op: "delete"; path: string };

/**
 * A single timed step in a scenario script.
 *  - `emit`   — wait `delayMs`, (optionally) perform `effect`, write `line` to stdout. When
 *               `turnBoundary` is set the harness drains queued nudges right after (and may
 *               switch to {@link Scenario.branchBeats} if a nudge landed) — modeling the fact
 *               that Claude nudges land at the *next turn boundary* (loom-desk Risk-A).
 *  - `result` — wait `delayMs`, then render + write the terminal `result` line and exit.
 *               `filesChanged`/`usage`/`session_id` are filled by the harness at runtime.
 *  - `crash`  — wait `delayMs`, then exit abruptly with `exitCode` and NO `result` line,
 *               simulating a daemon/worker crash mid-turn (recovered via `--resume`).
 */
export type Beat =
  | {
      kind: "emit";
      delayMs: number;
      line: RawLine;
      turnBoundary?: boolean;
      effect?: FsEffect;
    }
  | {
      kind: "result";
      delayMs: number;
      subtype: ResultSubtype;
      /** Done-signal summary (the `result` text). Null/omitted for error subtypes. */
      summary: string | null;
      /** Reported `num_turns`; if omitted the harness uses its live turn counter. */
      numTurns?: number;
    }
  | { kind: "crash"; delayMs: number; exitCode: number };

/** Runtime context threaded into a scenario's beat builders (filled by the harness). */
export interface ScenarioCtx {
  sessionId: string;
  model: string;
  cwd: string;
  turnCap: number;
  prompt: string;
  /** True when launched with `--resume`/`--continue` (recovery path). */
  resumed: boolean;
}

/** The canonical v0 fixture names (Spec 12 §5.2). */
export type ScenarioName =
  | "happy-path"
  | "no-progress"
  | "scope-violation"
  | "max-turns-fail"
  | "mid-task-nudge"
  | "daemon-restart";

/** A scripted worker behavior the fake harness can replay. */
export interface Scenario {
  name: ScenarioName;
  /** Model id reported in `system/init` when the spawn passed no `--model`. */
  defaultModel: string;
  /** The main beat script (fresh spawn, or resume when no `resumeBeats` is defined). */
  beats: (ctx: ScenarioCtx) => Beat[];
  /**
   * Alternate continuation taken when ≥1 nudge is drained at a turn boundary. Receiving
   * the nudge text here is what lets a scenario PROVE the nudge changed behavior (Spec 03;
   * loom-desk Risk-A) — e.g. it stops the default file sequence and writes a sentinel.
   */
  branchBeats?: (ctx: ScenarioCtx, nudges: string[]) => Beat[];
  /** Continuation replayed on a `--resume` launch (daemon-restart recovery, Spec 04 §10). */
  resumeBeats?: (ctx: ScenarioCtx) => Beat[];
}

// =======================================================================================
// Wire-format line builders — byte-faithful to claude -p stream-json (Spec 02 §7.1)
// =======================================================================================

/** A short, prefixed, claude-style id (`msg_…` / `toolu_…`). */
function rid(prefix: string, len = 24): string {
  return prefix + randomUUID().replace(/-/g, "").slice(0, len);
}

/** Per-step token usage block (snake_case, exactly as the real `assistant`/`result` carry). */
function stepUsage(input = 1200, output = 90, cacheRead = 800): RawLine {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
  };
}

/** `system`/`init` — the first line of every stream (carries `session_id`, Spec 02 §7.1). */
export function lineInit(ctx: ScenarioCtx): RawLine {
  return {
    type: "system",
    subtype: "init",
    session_id: ctx.sessionId,
    cwd: ctx.cwd,
    model: ctx.model,
    permissionMode: "bypassPermissions",
    tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    mcp_servers: [],
    plugins: [],
    plugin_errors: [],
    uuid: randomUUID(),
  };
}

/** An `assistant` line carrying a single text block (→ `assistant_text`, partial:false). */
export function lineAsstText(ctx: ScenarioCtx, text: string): RawLine {
  return {
    type: "assistant",
    message: {
      id: rid("msg_"),
      role: "assistant",
      model: ctx.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: stepUsage(),
    },
    parent_tool_use_id: null,
    session_id: ctx.sessionId,
    uuid: randomUUID(),
  };
}

/** An `assistant` line carrying a single `tool_use` block (→ `tool_call`, Spec 02 §7.1). */
export function lineToolUse(
  ctx: ScenarioCtx,
  tool: string,
  input: unknown,
  toolId: string,
): RawLine {
  return {
    type: "assistant",
    message: {
      id: rid("msg_"),
      role: "assistant",
      model: ctx.model,
      content: [{ type: "tool_use", id: toolId, name: tool, input }],
      stop_reason: "tool_use",
      usage: stepUsage(900, 140, 600),
    },
    parent_tool_use_id: null,
    session_id: ctx.sessionId,
    uuid: randomUUID(),
  };
}

/** A `user` line carrying a `tool_result` block (→ `tool_result`, Spec 02 §7.1). */
export function lineToolResult(
  ctx: ScenarioCtx,
  toolId: string,
  content: string,
  isError = false,
): RawLine {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolId, content, is_error: isError },
      ],
    },
    parent_tool_use_id: null,
    session_id: ctx.sessionId,
    uuid: randomUUID(),
  };
}

/**
 * A `user` line re-emitting an injected steering message (→ `user_echo`). This is the
 * `--replay-user-messages` ACK channel (Spec 02 §4.4; loom-desk Risk-A): content is a bare
 * string (vs the tool_result *array* of {@link lineToolResult}) so the driver can tell an
 * echoed nudge from a tool result.
 */
export function lineUserEcho(ctx: ScenarioCtx, text: string): RawLine {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: ctx.sessionId,
    uuid: randomUUID(),
  };
}

/**
 * A `PreToolUse` hook decision surfaced by `--include-hook-events` (→ `hook_decision`,
 * Spec 02 §7.1; my-docs/claude-code-headless.md §5.2). The decision + reason live in
 * `hookSpecificOutput` exactly as a real hook return value, and are also mirrored at the top
 * level so a tolerant parser can find them either way.
 */
export function lineHookDecision(
  ctx: ScenarioCtx,
  decision: "allow" | "deny" | "ask" | "defer",
  reason: string,
  tool: string,
  toolInput: unknown,
): RawLine {
  return {
    type: "system",
    subtype: "hook_event",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
    permissionDecision: decision,
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
    session_id: ctx.sessionId,
    uuid: randomUUID(),
  };
}

/**
 * An "extra" `system` subtype beyond init/result (e.g. `thinking_tokens`, `task_started`,
 * `task_notification`). Sprinkled into scenarios specifically to exercise the contract that
 * the telemetry parser MUST tolerate unknown `system` subtypes (Spec 02 §7.2; loom-desk
 * Risk-A) — switch on what you know, ignore the rest, never throw.
 */
export function lineSysSubtype(
  ctx: ScenarioCtx,
  subtype: string,
  extra: RawLine = {},
): RawLine {
  return {
    type: "system",
    subtype,
    session_id: ctx.sessionId,
    uuid: randomUUID(),
    ...extra,
  };
}

/** A `stream_event` partial text delta (→ `assistant_text`, partial:true; Spec 02 §7.1). */
export function lineStreamDelta(ctx: ScenarioCtx, text: string): RawLine {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    parent_tool_use_id: null,
    session_id: ctx.sessionId,
    uuid: randomUUID(),
    ttft_ms: 380,
  };
}

/**
 * The terminal `result` line (→ `finished`, Spec 02 §7.1). On `success` it carries the
 * `result` text and a validated `structured_output` done-signal (Spec 02 §5.5 / §6); error
 * subtypes carry no `result` text and a null `structured_output`, but always keep
 * `session_id`/`usage`/`num_turns` so the run is resumable and accountable.
 */
export function renderResult(
  ctx: ScenarioCtx,
  args: {
    subtype: ResultSubtype;
    summary: string | null;
    numTurns: number;
    filesChanged: string[];
    usage: RawLine;
    durationMs: number;
  },
): RawLine {
  const isError = args.subtype !== "success";
  const done: DoneSignal | null = isError
    ? null
    : {
        done: true,
        summary: args.summary ?? "Done.",
        filesChanged: args.filesChanged,
        blocker: null,
      };
  const line: RawLine = {
    type: "result",
    subtype: args.subtype,
    is_error: isError,
    duration_ms: args.durationMs,
    duration_api_ms: Math.round(args.durationMs * 0.8),
    num_turns: args.numTurns,
    session_id: ctx.sessionId,
    stop_reason: isError ? null : "end_turn",
    total_cost_usd: 0,
    usage: args.usage,
    modelUsage: {
      [ctx.model]: {
        inputTokens: args.usage.input_tokens,
        outputTokens: args.usage.output_tokens,
        cacheReadInputTokens: args.usage.cache_read_input_tokens,
        cacheCreationInputTokens: args.usage.cache_creation_input_tokens,
        costUSD: 0,
      },
    },
    structured_output: done,
    uuid: randomUUID(),
  };
  if (!isError) line.result = args.summary ?? "Done.";
  return line;
}

// =======================================================================================
// Beat construction helpers (keep the scenario scripts readable)
// =======================================================================================

/** An `emit` beat. */
function E(
  delayMs: number,
  line: RawLine,
  opts: { turnBoundary?: boolean; effect?: FsEffect } = {},
): Beat {
  return { kind: "emit", delayMs, line, ...opts };
}

/** A say-then-think micro-sequence: one assistant text line. */
function say(ctx: ScenarioCtx, text: string, delayMs = 120): Beat {
  return E(delayMs, lineAsstText(ctx, text));
}

/**
 * A full "do a file write" turn: `tool_use(Write)` → `tool_result`, with the tool_result
 * carrying the real {@link FsEffect} and marking a turn boundary (nudge-drain point).
 */
function writeTurn(
  ctx: ScenarioCtx,
  path: string,
  content: string,
  opts: { useDelay?: number; resDelay?: number } = {},
): Beat[] {
  const toolId = rid("toolu_");
  return [
    E(opts.useDelay ?? 220, lineToolUse(ctx, "Write", { file_path: path, content }, toolId)),
    E(opts.resDelay ?? 160, lineToolResult(ctx, toolId, `Wrote ${path} (${content.length} bytes).`), {
      turnBoundary: true,
      effect: { op: "write", path, content },
    }),
  ];
}

/** A "read a file" turn with NO filesystem effect (used to build drift / no-progress). */
function readTurn(ctx: ScenarioCtx, path: string, delay = 200): Beat[] {
  const toolId = rid("toolu_");
  return [
    E(delay, lineToolUse(ctx, "Read", { file_path: path }, toolId)),
    E(140, lineToolResult(ctx, toolId, `(contents of ${path})`), { turnBoundary: true }),
  ];
}

// =======================================================================================
// The six v0 scenario fixtures (Spec 12 §5.2)
// =======================================================================================

/** Shared sample content (real, self-consistent TS — `bun test` actually passes). */
const SUM_SRC = `export function sum(a: number, b: number): number {\n  return a + b;\n}\n`;
const SUM_TEST = [
  `import { test, expect } from "bun:test";`,
  `import { sum } from "./sum.ts";`,
  ``,
  `test("sum adds two numbers", () => {`,
  `  expect(sum(2, 3)).toBe(5);`,
  `});`,
  ``,
].join("\n");

const happyPath: Scenario = {
  name: "happy-path",
  defaultModel: "claude-sonnet-4-5",
  beats: (ctx) => [
    say(ctx, "I'll add the pure `sum` function plus a passing test, scoped to this worktree."),
    E(60, lineStreamDelta(ctx, "Writing sum.ts")),
    E(40, lineSysSubtype(ctx, "thinking_tokens", { delta: 64 })),
    ...writeTurn(ctx, "sum.ts", SUM_SRC),
    say(ctx, "Now the test."),
    E(30, lineSysSubtype(ctx, "task_started", { task: "write test" })),
    ...writeTurn(ctx, "sum.test.ts", SUM_TEST),
    E(40, lineSysSubtype(ctx, "task_notification", { note: "tests green" })),
    say(ctx, "Done — `sum` added and its test passes."),
    {
      kind: "result",
      delayMs: 80,
      subtype: "success",
      summary: "Added a pure sum() function and a passing bun test.",
    },
  ],
};

const noProgress: Scenario = {
  name: "no-progress",
  defaultModel: "claude-sonnet-4-5",
  beats: (ctx) => [
    say(ctx, "Let me explore the codebase before changing anything."),
    // Repeated identical reads, zero file writes → trips no_diff_progress AND
    // repeated_tool_calls smoke alarms (Spec 03 §2; config defaults: 3 turns / 4 calls).
    ...readTurn(ctx, "README.md"),
    say(ctx, "Hmm, let me re-read that."),
    ...readTurn(ctx, "README.md"),
    E(40, lineSysSubtype(ctx, "thinking_tokens", { delta: 128 })),
    ...readTurn(ctx, "README.md"),
    say(ctx, "Still orienting…"),
    ...readTurn(ctx, "README.md"),
    ...readTurn(ctx, "README.md"),
    say(ctx, "I have not yet made any changes."),
    {
      kind: "result",
      delayMs: 80,
      subtype: "success",
      summary: "Explored the repo but produced no diff.",
    },
  ],
};

const scopeViolation: Scenario = {
  name: "scope-violation",
  defaultModel: "claude-sonnet-4-5",
  beats: (ctx) => {
    const badId = rid("toolu_");
    return [
      say(ctx, "I'll update the system config."),
      // Out-of-scope Write attempt → PreToolUse hook DENY (no effect performed).
      E(180, lineToolUse(ctx, "Write", { file_path: "/etc/passwd", content: "x" }, badId)),
      E(80, lineHookDecision(
        ctx,
        "deny",
        "write outside owned scope: /etc/passwd is not within the worker's file scope",
        "Write",
        { file_path: "/etc/passwd" },
      )),
      E(60, lineToolResult(ctx, badId, "Permission denied by scope guard.", true), {
        turnBoundary: true,
      }),
      say(ctx, "That path is out of scope — staying inside the worktree instead."),
      ...writeTurn(ctx, "notes.txt", "in-scope change after the denied attempt\n"),
      {
        kind: "result",
        delayMs: 80,
        subtype: "success",
        summary: "Recovered from a scope denial and wrote an in-scope file.",
      },
    ];
  },
};

const maxTurnsFail: Scenario = {
  name: "max-turns-fail",
  defaultModel: "claude-sonnet-4-5",
  beats: (ctx) => [
    say(ctx, "Starting a long, looping task."),
    ...writeTurn(ctx, "attempt-1.txt", "partial work\n"),
    say(ctx, "That did not work, trying again."),
    ...readTurn(ctx, "attempt-1.txt"),
    say(ctx, "Still iterating…"),
    ...readTurn(ctx, "attempt-1.txt"),
    {
      // No `result` text, null structured_output — the turn cap was hit (Spec 02 §7.1).
      kind: "result",
      delayMs: 80,
      subtype: "error_max_turns",
      summary: null,
      numTurns: ctx.turnCap,
    },
  ],
};

const midTaskNudge: Scenario = {
  name: "mid-task-nudge",
  defaultModel: "claude-sonnet-4-5",
  // Default (un-nudged) path: create a.txt, b.txt, c.txt across three turns. Mirrors the
  // verified loom-desk Risk-A probe so the integration test can assert the nudge branch.
  beats: (ctx) => [
    say(ctx, "Creating the three files one at a time, pausing between each.", 200),
    ...writeTurn(ctx, "a.txt", "a\n", { useDelay: 350, resDelay: 250 }),
    say(ctx, "Created a.txt. Next: b.txt.", 200),
    ...writeTurn(ctx, "b.txt", "b\n", { useDelay: 350, resDelay: 250 }),
    say(ctx, "Created b.txt. Next: c.txt.", 200),
    ...writeTurn(ctx, "c.txt", "c\n", { useDelay: 350, resDelay: 250 }),
    {
      kind: "result",
      delayMs: 120,
      subtype: "success",
      summary: "Created a.txt, b.txt, and c.txt.",
    },
  ],
  // Nudged path: stop the sequence and write a sentinel that quotes the nudge — proving the
  // injected steer was ingested and changed behavior (c.txt is never created).
  branchBeats: (ctx, nudges) => [
    say(ctx, "Understood — stopping the file sequence as instructed.", 160),
    ...writeTurn(
      ctx,
      "stop.txt",
      `STOPPED early per nudge\nnudge: ${nudges.join(" | ")}\n`,
      { useDelay: 200, resDelay: 160 },
    ),
    {
      kind: "result",
      delayMs: 100,
      subtype: "success",
      summary: "Stopped early on the nudge and wrote stop.txt instead of c.txt.",
    },
  ],
};

const daemonRestart: Scenario = {
  name: "daemon-restart",
  defaultModel: "claude-sonnet-4-5",
  // Fresh spawn: write step-1, begin step-2, then CRASH mid-turn (no result line).
  beats: (ctx) => [
    say(ctx, "Multi-step task. Step 1 of 3.", 150),
    ...writeTurn(ctx, "step-1.txt", "step 1 complete\n", { useDelay: 250, resDelay: 200 }),
    say(ctx, "Step 2 of 3…", 150),
    { kind: "crash", delayMs: 250, exitCode: 137 }, // SIGKILL-style mid-turn death
  ],
  // Recovery (`--resume <session>`): same session id, finish steps 2 and 3, then succeed.
  resumeBeats: (ctx) => [
    say(ctx, "Resumed after restart — continuing from step 2.", 150),
    ...writeTurn(ctx, "step-2.txt", "step 2 complete\n", { useDelay: 220, resDelay: 180 }),
    say(ctx, "Step 3 of 3.", 150),
    ...writeTurn(ctx, "step-3.txt", "step 3 complete\n", { useDelay: 220, resDelay: 180 }),
    {
      kind: "result",
      delayMs: 100,
      subtype: "success",
      summary: "Recovered via --resume and completed all three steps.",
    },
  ],
};

// =======================================================================================
// Registry + lookup
// =======================================================================================

/** The full scenario registry, keyed by canonical name. */
export const SCENARIOS: Record<ScenarioName, Scenario> = {
  "happy-path": happyPath,
  "no-progress": noProgress,
  "scope-violation": scopeViolation,
  "max-turns-fail": maxTurnsFail,
  "mid-task-nudge": midTaskNudge,
  "daemon-restart": daemonRestart,
};

/** All valid scenario names (for validation / help text). */
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

/** Narrow an arbitrary string to a {@link ScenarioName} (null if unknown). */
export function asScenarioName(name: string | undefined | null): ScenarioName | null {
  return name && name in SCENARIOS ? (name as ScenarioName) : null;
}

/** Look up a scenario by name, or undefined if the name is not registered. */
export function getScenario(name: string | undefined | null): Scenario | undefined {
  const n = asScenarioName(name);
  return n ? SCENARIOS[n] : undefined;
}

/**
 * Extract a scenario name embedded in a task prompt, so a scenario can be selected without
 * an env var when the orchestrator drives the harness with a tagged prompt. Recognized
 * forms (case-insensitive): `[[scenario:happy-path]]` or `scenario=happy-path`.
 */
export function parsePromptScenario(prompt: string | undefined): ScenarioName | null {
  if (!prompt) return null;
  const m =
    prompt.match(/\[\[\s*scenario\s*:\s*([a-z0-9-]+)\s*\]\]/i) ??
    prompt.match(/\bscenario\s*=\s*([a-z0-9-]+)/i);
  return m && m[1] ? asScenarioName(m[1].toLowerCase()) : null;
}
