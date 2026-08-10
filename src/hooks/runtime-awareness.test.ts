import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_THRESHOLD_MS,
  THRESHOLD_ENV,
  evaluateRuntimeAwareness,
  formatDuration,
  resolveThresholdMs,
  runtimeAwarenessSpec,
} from "./runtime-awareness.ts";

describe("evaluateRuntimeAwareness", () => {
  test("above threshold → non-null notice mentioning the tool and formatted duration", () => {
    const out = evaluateRuntimeAwareness({ tool_name: "Bash", duration_ms: 45_000 }, 30_000);
    expect(out).not.toBeNull();
    expect(out!.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out!.hookSpecificOutput.additionalContext).toContain("Bash");
    expect(out!.hookSpecificOutput.additionalContext).toContain("45s");
  });

  test("below threshold is silent", () => {
    expect(evaluateRuntimeAwareness({ tool_name: "Bash", duration_ms: 29_999 }, 30_000)).toBeNull();
  });

  test("threshold is inclusive (>=)", () => {
    expect(evaluateRuntimeAwareness({ tool_name: "Bash", duration_ms: 30_000 }, 30_000)).not.toBeNull();
  });

  test("missing / non-numeric / NaN duration is silent", () => {
    expect(evaluateRuntimeAwareness({ tool_name: "Bash" }, 30_000)).toBeNull();
    expect(
      evaluateRuntimeAwareness({ tool_name: "Bash", duration_ms: "3178" as unknown as number }, 30_000),
    ).toBeNull();
    expect(evaluateRuntimeAwareness({ duration_ms: NaN }, 30_000)).toBeNull();
  });

  test("threshold 0 is always silent (disabled)", () => {
    expect(evaluateRuntimeAwareness({ tool_name: "Bash", duration_ms: 999_999 }, 0)).toBeNull();
  });

  test("missing/empty tool_name falls back to the word 'tool'", () => {
    const out = evaluateRuntimeAwareness({ duration_ms: 999_999 }, 30_000);
    expect(out).not.toBeNull();
    expect(out!.hookSpecificOutput.additionalContext).toContain("tool");

    const out2 = evaluateRuntimeAwareness({ tool_name: "", duration_ms: 999_999 }, 30_000);
    expect(out2).not.toBeNull();
    expect(out2!.hookSpecificOutput.additionalContext).toContain("tool");
  });
});

describe("formatDuration", () => {
  test("seconds under 90s", () => {
    expect(formatDuration(31_000)).toBe("31s");
    expect(formatDuration(89_000)).toBe("89s");
  });

  test("minutes at/above 90s", () => {
    expect(formatDuration(200_000)).toBe("3.3m");
  });
});

describe("resolveThresholdMs", () => {
  test("argv wins over env", () => {
    expect(resolveThresholdMs(["--threshold-ms", "5000"], {})).toBe(5000);
    expect(resolveThresholdMs(["--threshold-ms", "5000"], { [THRESHOLD_ENV]: "9000" })).toBe(5000);
  });

  test("env alone", () => {
    expect(resolveThresholdMs([], { [THRESHOLD_ENV]: "9000" })).toBe(9000);
  });

  test("neither → default", () => {
    expect(resolveThresholdMs([], {})).toBe(DEFAULT_THRESHOLD_MS);
  });

  test("garbage fails open to 0", () => {
    expect(resolveThresholdMs(["--threshold-ms", "abc"], {})).toBe(0);
    expect(resolveThresholdMs(["--threshold-ms", "-5"], {})).toBe(0);
  });
});

describe("runtimeAwarenessSpec", () => {
  test("PostToolUse, no matcher, command carries the script path and threshold", () => {
    const spec = runtimeAwarenessSpec("/x/runtime-awareness.ts", 30_000);
    expect(spec.event).toBe("PostToolUse");
    expect(spec.matcher).toBeUndefined();
    expect(spec.command).toContain("/x/runtime-awareness.ts");
    expect(spec.command).toContain("--threshold-ms 30000");
  });
});

describe("end-to-end script invocation", () => {
  const hook = join(import.meta.dir, "runtime-awareness.ts");

  test("slow tool call → non-empty stdout notice", () => {
    const r = Bun.spawnSync(["bun", hook, "--threshold-ms", "1000"], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: "s",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "sleep 45" },
          tool_response: { stdout: "", stderr: "" },
          tool_use_id: "toolu_x",
          duration_ms: 45_000,
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString());
    expect(out.hookSpecificOutput.additionalContext).toContain("Bash");
  });

  test("fast tool call → empty stdout", () => {
    const r = Bun.spawnSync(["bun", hook, "--threshold-ms", "1000"], {
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: "s",
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
          tool_response: { stdout: "", stderr: "" },
          tool_use_id: "toolu_x",
          duration_ms: 500,
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });

  test("malformed stdin fails open: exit 0, empty stdout", () => {
    const r = Bun.spawnSync(["bun", hook, "--threshold-ms", "1000"], {
      stdin: new TextEncoder().encode("not json"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });
});
