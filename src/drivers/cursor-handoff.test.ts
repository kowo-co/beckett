/**
 * Beckett — handoff artifact tests (`src/drivers/cursor-handoff.test.ts`)
 * =======================================================================================
 * The handoff file is the ONLY carrier of what git can't hold across a seat change, so what it
 * has to guarantee is narrow and testable: it always names where the work is, it never claims a
 * tick it can't back, and it never leaks the credential.
 */

import { describe, expect, test } from "bun:test";
import {
  CURSOR_HANDOFF_REL,
  handoffResumeNote,
  renderCursorHandoff,
  type CursorHandoffState,
} from "./cursor-handoff.ts";

function state(over: Partial<CursorHandoffState> = {}): CursorHandoffState {
  return {
    runId: "run-20260820-thing",
    branch: "beckett/run-thing",
    agentId: "agent-abc",
    model: "Auto",
    updatedAt: "2026-08-20T01:00:00.000Z",
    status: "working — the cursor seat holds this run",
    activity: [],
    unverifiedTicks: [],
    notes: [],
    ...over,
  };
}

describe("the handoff artifact", () => {
  test("it lives beside spec.md, under the git-excluded scaffolding", () => {
    // Load-bearing: `.beckett/` is `info/exclude`d and stripped from every commit, so this file
    // needs no commit of its own and can never leak into the run's diff.
    expect(CURSOR_HANDOFF_REL).toBe(".beckett/cursor-handoff.md");
  });

  test("it opens by telling the reader not to restart the task", () => {
    const text = renderCursorHandoff(state());
    expect(text).toContain("READ THIS FIRST");
    expect(text).toContain("do NOT");
    expect(text).toContain("restart the task from scratch");
    expect(text).toContain("beckett/run-thing");
  });

  test("an empty run says so plainly rather than implying work happened", () => {
    const text = renderCursorHandoff(state());
    expect(text).toContain("the seat was abandoned before it touched the tree");
    expect(text).toContain("no box was ticked by the cursor seat");
  });

  test("unverified ticks are named AND explained, not just listed", () => {
    const text = renderCursorHandoff(
      state({ unverifiedTicks: ["Add the driver", "Wire the registry row"] }),
    );
    expect(text).toContain("- Add the driver");
    expect(text).toContain("- Wire the registry row");
    expect(text).toContain("reset to unchecked");
    expect(text).toContain("Re-verify each against");
  });

  test("a fallback records the raw error shape and where the work landed", () => {
    const text = renderCursorHandoff(
      state({
        status: "handed over — the cursor seat ran out of quota",
        fallback: { reason: "usage limit reached", status: 429, code: "usage_limit", checkpoint: "deadbee" },
      }),
    );
    expect(text).toContain("usage limit reached");
    // The undocumented-shape problem is solved by writing the shape down every single time.
    expect(text).toContain("HTTP 429");
    expect(text).toContain("code `usage_limit`");
    expect(text).toContain("committed as `deadbee`");
    expect(text).toContain("nothing was stashed and nothing was discarded");
  });

  test("a fallback with a clean tree says so instead of implying a lost checkpoint", () => {
    const text = renderCursorHandoff(state({ fallback: { reason: "spent" } }));
    expect(text).toContain("Nothing was uncommitted at that moment");
    expect(text).toContain("Raw error shape: not reported by the SDK");
  });

  test("the status is stamped on its own line, greppable, at the top of the file", () => {
    const text = renderCursorHandoff(state({ status: "handed over — out of quota" }));
    expect(text.split("\n")[1]).toBe("> status: handed over — out of quota");
  });

  test("a pathological tool argument cannot make the file unreadable", () => {
    const text = renderCursorHandoff(
      state({ activity: [{ tool: "shell", detail: "x".repeat(5_000) }] }),
    );
    const line = text.split("\n").find((l) => l.startsWith("- shell:"))!;
    expect(line.length).toBeLessThan(400);
    expect(line.endsWith("…")).toBe(true);
  });

  test("the activity trail is bounded — a briefing, not a transcript", () => {
    const activity = Array.from({ length: 200 }, (_, i) => ({ tool: "read", detail: `f${i}.ts` }));
    const text = renderCursorHandoff(state({ activity }));
    expect(text.split("\n").filter((l) => l.startsWith("- read:")).length).toBe(40);
    // Newest kept, oldest dropped: what was in flight matters more than what happened first.
    expect(text).toContain("f199.ts");
    expect(text).not.toContain("f0.ts");
  });

  test("rendering is deterministic — the same state produces the same bytes", () => {
    expect(renderCursorHandoff(state())).toBe(renderCursorHandoff(state()));
  });

  test("the resume note points at both files and forbids a restart", () => {
    const note = handoffResumeNote("usage limit reached");
    expect(note).toContain(CURSOR_HANDOFF_REL);
    expect(note).toContain(".beckett/spec.md");
    expect(note).toContain("do NOT restart the task");
    expect(note).toContain("usage limit reached");
    expect(note).toContain("Re-verify");
  });
});
