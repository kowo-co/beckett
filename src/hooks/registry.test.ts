/**
 * `renderClaudeSettings` — the hook table stayed byte-identical when `extraSettings` is absent
 * (the pre-W2A baseline); `extraSettings` merges arbitrary top-level keys (e.g.
 * `crossSessionInbound: "accept"`, OPS cross-session messaging) without letting a caller smuggle
 * a `hooks` key past the real, rendered one.
 */
import { describe, expect, test } from "bun:test";
import { renderClaudeSettings, type HookSpec } from "./registry.ts";

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
