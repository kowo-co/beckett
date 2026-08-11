import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPEC_CHECKLIST_PLACEHOLDER, renderSpecScaffold } from "../run/spec-file.ts";
import {
  MAX_STRIKES,
  SPEC_PATH_ENV,
  buildBlockReason,
  evaluateSpecGate,
  readStrikeCount,
  resolveConfig,
  writeStrikeCount,
} from "./spec-gate.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-spec-gate-"));
  dirs.push(dir);
  return dir;
}

const SCAFFOLD = renderSpecScaffold({
  id: "run-20260810-widget",
  title: "Widget",
  branch: "beckett/run-widget",
  createdAt: "2026-08-10T12:00:00.000Z",
  prompt: "Build the widget.",
});

const ALL_CHECKED = "## Checklist\n- [x] wrote the store\n- [x] wrote the tests\n";
const SOME_UNCHECKED = "## Checklist\n- [x] wrote the store\n- [ ] wrote the tests\n";

describe("resolveConfig", () => {
  test("argv --root wins over env, which wins over eventCwd", () => {
    expect(resolveConfig(["--root", "/from/argv"], { [SPEC_PATH_ENV]: "/from/env" }, "/from/cwd").workspace).toBe(
      "/from/argv",
    );
    expect(resolveConfig([], { [SPEC_PATH_ENV]: "/from/env" }, "/from/cwd").workspace).toBe("/from/env");
    expect(resolveConfig([], {}, "/from/cwd").workspace).toBe("/from/cwd");
  });
});

describe("evaluateSpecGate", () => {
  test("missing spec.md blocks", () => {
    const result = evaluateSpecGate(null, 0);
    expect(result.decision).toMatchObject({ decision: "block" });
    if ("reason" in result.decision) expect(result.decision.reason).toContain("spec.md not found");
    expect(result.nextCount).toBe(1);
    expect(result.warned).toBe(false);
  });

  test("still-placeholder spec.md blocks and names the placeholder line", () => {
    const result = evaluateSpecGate(SCAFFOLD, 0);
    expect(result.decision).toMatchObject({ decision: "block" });
    if ("reason" in result.decision) {
      expect(result.decision.reason).toContain("1 unchecked item(s)");
      expect(result.decision.reason).toContain(SPEC_CHECKLIST_PLACEHOLDER);
    }
    expect(result.nextCount).toBe(1);
  });

  test("unchecked real items block, listing only the unchecked ones", () => {
    const result = evaluateSpecGate(SOME_UNCHECKED, 0);
    expect(result.decision).toMatchObject({ decision: "block" });
    if ("reason" in result.decision) {
      expect(result.decision.reason).toContain("1 unchecked item(s)");
      expect(result.decision.reason).toContain("wrote the tests");
      expect(result.decision.reason).not.toContain("wrote the store");
    }
  });

  test("all real items checked, no placeholder → allow", () => {
    const result = evaluateSpecGate(ALL_CHECKED, 0);
    expect(result.decision).toEqual({});
    expect(result.nextCount).toBe(0);
    expect(result.warned).toBe(false);
  });

  test("no ## Checklist section at all (total 0, no placeholder) → allow", () => {
    const result = evaluateSpecGate("# Title\n\n## Goal\ndo it\n", 0);
    expect(result.decision).toEqual({});
  });

  test("3-strikes: blocks the first MAX_STRIKES times, then allows with a warning", () => {
    let count = 0;
    for (let i = 0; i < MAX_STRIKES; i++) {
      const result = evaluateSpecGate(SOME_UNCHECKED, count);
      expect(result.decision).toMatchObject({ decision: "block" });
      expect(result.warned).toBe(false);
      count = result.nextCount;
    }
    expect(count).toBe(MAX_STRIKES);

    const escaped = evaluateSpecGate(SOME_UNCHECKED, count);
    expect(escaped.decision).toEqual({});
    expect(escaped.warned).toBe(true);
    expect(escaped.nextCount).toBe(MAX_STRIKES); // does not keep climbing once escaped
  });

  test("a passing spec resets exposure even with a nonzero prior count (no further blocks)", () => {
    const result = evaluateSpecGate(ALL_CHECKED, 2);
    expect(result.decision).toEqual({});
    expect(result.nextCount).toBe(2);
  });
});

describe("buildBlockReason", () => {
  test("follows the exact message template", () => {
    const reason = buildBlockReason({
      items: [{ text: "wire the CLI", done: false }],
      total: 1,
      done: 0,
      hasPlaceholder: false,
    });
    expect(reason).toBe(
      "spec.md gate: 1 unchecked item(s): wire the CLI — finish them, tick them off, " +
        "or move deliberately-dropped items to ## Notes with a reason, then finish.",
    );
  });
});

describe("strike-count sidecar", () => {
  test("readStrikeCount defaults to 0 when the sidecar is absent", () => {
    expect(readStrikeCount(makeWorkspace())).toBe(0);
  });

  test("writeStrikeCount then readStrikeCount round-trips", () => {
    const workspace = makeWorkspace();
    writeStrikeCount(workspace, 2);
    expect(readStrikeCount(workspace)).toBe(2);
    expect(readFileSync(join(workspace, ".beckett", "spec-gate-count"), "utf8")).toBe("2");
  });

  test("a garbage sidecar value reads as 0 rather than throwing", () => {
    const workspace = makeWorkspace();
    writeStrikeCount(workspace, 1);
    // Overwrite with garbage directly, bypassing the writer.
    writeStrikeCount(workspace, Number.NaN as unknown as number);
    expect(readStrikeCount(workspace)).toBe(0);
  });
});
