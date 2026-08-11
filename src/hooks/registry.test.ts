/**
 * `renderClaudeSettings` — the hook table stayed byte-identical when `extraSettings` is absent
 * (the pre-W2A baseline); `extraSettings` merges arbitrary top-level keys (e.g.
 * `crossSessionInbound: "accept"`, OPS cross-session messaging) without letting a caller smuggle
 * a `hooks` key past the real, rendered one. Plus `specGateSpec`'s Stop-event rendering (W1A).
 */
import { describe, expect, test } from "bun:test";
import { renderClaudeSettings, specGateSpec, type HookSpec } from "./registry.ts";
import { scopeGuardSpec } from "./scope-guard.ts";

const guard: HookSpec = { event: "PreToolUse", matcher: "Edit", command: "guard.ts" };

describe("renderClaudeSettings", () => {
  test("no extraSettings → just the hooks key (unchanged baseline shape)", () => {
    const out = renderClaudeSettings([guard]);
    expect(Object.keys(out)).toEqual(["hooks"]);
    expect(out.hooks.PreToolUse).toEqual([{ matcher: "Edit", hooks: [{ type: "command", command: "guard.ts" }] }]);
  });

  test("extraSettings merges at the top level alongside hooks", () => {
    const out = renderClaudeSettings([guard], { crossSessionInbound: "accept" });
    expect(out.crossSessionInbound).toBe("accept");
    expect(out.hooks.PreToolUse).toBeDefined();
  });

  test("a 'hooks' key inside extraSettings is dropped — the real rendered hook table always wins", () => {
    const out = renderClaudeSettings([guard], { hooks: "not a real hook table", crossSessionInbound: "accept" });
    expect(out.hooks).not.toBe("not a real hook table");
    expect(out.hooks.PreToolUse).toEqual([{ matcher: "Edit", hooks: [{ type: "command", command: "guard.ts" }] }]);
    expect(out.crossSessionInbound).toBe("accept");
  });

  test("extraSettings works with an empty hook list (concierge: no hooks, settings-only)", () => {
    const out = renderClaudeSettings([], { crossSessionInbound: "accept" });
    expect(out).toEqual({ crossSessionInbound: "accept", hooks: {} });
  });
});

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
