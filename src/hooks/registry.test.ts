import { describe, expect, test } from "bun:test";
import { renderClaudeSettings, specGateSpec } from "./registry.ts";
import { scopeGuardSpec } from "./scope-guard.ts";

describe("specGateSpec", () => {
  test("renders a Stop entry with no matcher, baking the script path and workspace into argv", () => {
    const spec = specGateSpec("/abs/spec-gate.ts", "/abs/workspace");
    expect(spec.event).toBe("Stop");
    expect(spec.matcher).toBeUndefined();
    expect(spec.command).toBe('bun "/abs/spec-gate.ts" --root "/abs/workspace"');
  });

  test("renderClaudeSettings([specGateSpec(...)]) produces the exact Stop settings shape", () => {
    const settings = renderClaudeSettings([specGateSpec("/abs/spec-gate.ts", "/abs/workspace")]);
    expect(settings).toEqual({
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: 'bun "/abs/spec-gate.ts" --root "/abs/workspace"' }],
          },
        ],
      },
    });
    // No `matcher` key on the Stop entry — Stop hooks are not tool-scoped, and W1C consumes this
    // rendered shape as-is.
    expect(settings.hooks.Stop![0]).not.toHaveProperty("matcher");
  });

  test("coexists with scope-guard's PreToolUse entry under separate event keys", () => {
    const settings = renderClaudeSettings([
      scopeGuardSpec("/abs/scope-guard.ts", "/abs/workspace", []),
      specGateSpec("/abs/spec-gate.ts", "/abs/workspace"),
    ]);
    expect(Object.keys(settings.hooks).sort()).toEqual(["PreToolUse", "Stop"]);
    expect(settings.hooks.Stop).toHaveLength(1);
  });
});
