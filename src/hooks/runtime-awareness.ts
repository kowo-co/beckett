#!/usr/bin/env bun
/**
 * Beckett — PostToolUse runtime-awareness hook (`src/hooks/runtime-awareness.ts`)
 * =======================================================================================
 * A Droid-style PostToolUse hook: when a tool call ran longer than a configured threshold,
 * it injects a short notice into the model's context via `hookSpecificOutput.additionalContext`
 * so the model can route around slow operations (a faster alternative, or backgrounding a
 * long command instead of blocking on it).
 *
 * Verified on claude 2.1.226: the PostToolUse stdin payload already carries `duration_ms`
 * (e.g. `{"session_id":..., "hook_event_name":"PostToolUse", "tool_name":"Bash",
 * "tool_input":{...}, "tool_response":{...}, "tool_use_id":"toolu_...", "duration_ms":3178}`).
 * No PreToolUse timestamp bridge is needed — the hook simply reads `duration_ms` from stdin.
 *
 * Fail-open (unlike the scope-guard's fail-closed): this hook is advisory telemetry. Any
 * internal error exits 0 with no output — it must never block or slow the tool path.
 */

/** Env var fallback carrying the slow-tool threshold in milliseconds. */
export const THRESHOLD_ENV = "BECKETT_SLOW_TOOL_MS";
/** Default threshold when neither argv nor env provides one: 30s. */
export const DEFAULT_THRESHOLD_MS = 30_000;

/** The PostToolUse event shape we consume (only the fields we need; tolerant of extras). */
export interface RuntimeHookInput {
  tool_name?: string;
  duration_ms?: number;
  [k: string]: unknown;
}

/** Null = stay silent (below threshold / no timing / disabled / any doubt). */
export type RuntimeAwarenessOutput =
  | null
  | {
      hookSpecificOutput: {
        hookEventName: "PostToolUse";
        additionalContext: string;
      };
    };

/** Format a millisecond duration for the notice: seconds under 90s, minutes after. */
export function formatDuration(ms: number): string {
  if (ms >= 90_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Resolve the slow-tool threshold from argv + env (argv wins), same precedence pattern as
 * scope-guard's `resolveConfig`. Misconfiguration (non-finite / negative) fails open to 0
 * (disabled) rather than spamming on a garbage value.
 */
export function resolveThresholdMs(argv: string[], env: Record<string, string | undefined>): number {
  let candidate: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--threshold-ms" && argv[i + 1] !== undefined) candidate = argv[++i];
  }
  if (candidate === undefined) candidate = env[THRESHOLD_ENV];
  if (candidate === undefined) return DEFAULT_THRESHOLD_MS;
  const n = Number(candidate);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * The pure decision function. Given a hook event and resolved threshold, returns the
 * PostToolUse output (or null to stay silent).
 */
export function evaluateRuntimeAwareness(
  input: RuntimeHookInput,
  thresholdMs: number,
): RuntimeAwarenessOutput {
  if (thresholdMs <= 0) return null; // disabled
  const ms = input.duration_ms;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  if (ms < thresholdMs) return null;

  const tool = typeof input.tool_name === "string" && input.tool_name ? input.tool_name : "tool";
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `Runtime notice: the ${tool} call you just made took ${formatDuration(ms)}. ` +
        `Consider a faster alternative for similar operations, or run long commands in the background instead of blocking on them.`,
    },
  };
}

/**
 * Return the {@link HookSpec} that registers this hook for a worker. Bakes the threshold into
 * the command args so the hook is self-contained (no env dependency). No `matcher` — the hook
 * watches every tool (Bash, WebFetch, MCP tools, all of them).
 */
export function runtimeAwarenessSpec(
  scriptPath: string,
  thresholdMs: number,
): import("./registry.ts").HookSpec {
  return {
    event: "PostToolUse",
    command: `bun ${JSON.stringify(scriptPath)} --threshold-ms ${thresholdMs}`,
  };
}

// =======================================================================================
// Entry point — pure stdin → stdout (the only side effect)
// =======================================================================================

if (import.meta.main) {
  // Fail-open (unlike the scope-guard's fail-closed): this hook is advisory telemetry, so ANY
  // internal error must exit 0 with no output — it must never block or delay the tool path.
  try {
    const input = (await Bun.stdin.json()) as RuntimeHookInput;
    const thresholdMs = resolveThresholdMs(Bun.argv.slice(2), process.env);
    const out = evaluateRuntimeAwareness(input, thresholdMs);
    if (out !== null) process.stdout.write(JSON.stringify(out));
  } catch {
    // silent — fail-open
  }
}
