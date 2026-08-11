/**
 * Run → WorkItem projection tests (`src/run/adapter.ts`).
 * Everything `stages.ts`/`spawn.ts` read off a work item must be present and honest.
 */
import { describe, expect, test } from "bun:test";
import { runAsWorkItem, runBody } from "./adapter.ts";
import { parseSpecChecklist, renderSpecScaffold } from "./spec-file.ts";
import type { Run } from "./types.ts";

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: "run-20260810-oauth-middleware",
    slug: "oauth-middleware",
    title: "Add OAuth middleware",
    prompt: "Add OAuth middleware to the API gateway.",
    channelId: "chan-1",
    requesterId: "user-1",
    taskRef: null,
    ultracode: false,
    cast: null,
    repo: null,
    state: "queued",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    workspace: null,
    branch: "beckett/run-oauth-middleware",
    baseSha: null,
    sessionIds: {},
    sessionName: "beckett-run-oauth-middleware",
    reviewCycles: 0,
    prUrl: null,
    error: null,
    ...over,
  };
}

describe("runAsWorkItem", () => {
  test("maps identity, cast, branch and origin channel onto the WorkItem shape", () => {
    const run = makeRun({ cast: { implement: { harness: "codex" } }, repo: "gateway", channelId: "c9" });
    const item = runAsWorkItem(run);
    expect(item.id).toBe(run.id);
    expect(item.identifier).toBe(run.id);
    expect(item.title).toBe(run.title);
    expect(item.casting).toEqual({ implement: { harness: "codex" } });
    expect(item.branchRef).toBe(run.branch);
    expect(item.project).toBe("gateway");
    expect(item.originChannel).toBe("c9");
    expect(item.createdAt).toBe(run.createdAt);
    expect(item.description).toBe(run.prompt);
  });

  test("the run's own state rides through — the stage registry keys off it directly", () => {
    expect(runAsWorkItem(makeRun({ state: "implementing" })).state).toBe("implementing");
    expect(runAsWorkItem(makeRun({ state: "reviewing" })).state).toBe("reviewing");
  });

  test("body carries the goal verbatim and no criteria before the worker writes a checklist", () => {
    const item = runAsWorkItem(makeRun());
    expect(item.body).toBe("## Goal\nAdd OAuth middleware to the API gateway.");
    expect(item.criteria).toEqual([]);
  });

  test("a written checklist becomes acceptance criteria in body AND criteria", () => {
    const spec = parseSpecChecklist(
      "## Checklist\n- [x] wire the middleware\n- [ ] add tests\n\n## Notes\n- [ ] scratch line",
    );
    const item = runAsWorkItem(makeRun(), spec);
    expect(item.criteria).toEqual(["wire the middleware", "add tests"]);
    expect(item.body).toContain("## Acceptance criteria");
    expect(item.body).toContain("- [x] wire the middleware");
    expect(item.body).toContain("- [ ] add tests");
    // Notes bullets are scratch, never criteria.
    expect(item.criteria).not.toContain("scratch line");
  });

  test("the seeded placeholder never reaches the worker as a criterion", () => {
    const run = makeRun();
    const spec = parseSpecChecklist(renderSpecScaffold(run));
    expect(spec.hasPlaceholder).toBe(true);
    const item = runAsWorkItem(run, spec);
    expect(item.criteria).toEqual([]);
    expect(runBody(run, spec)).toBe("## Goal\nAdd OAuth middleware to the API gateway.");
  });
});
