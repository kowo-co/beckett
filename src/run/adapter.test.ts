/**
 * Run → Ticket adapter tests (`src/run/adapter.ts`).
 * The adapter is the wave-A seam: everything `stages.ts`/`spawn.ts` read off a Ticket must be
 * present and honest, and a run's lifecycle must project onto the ticket states the stage
 * registry keys off.
 */
import { describe, expect, test } from "bun:test";
import { runAsTicket, runBody, ticketStateForRun } from "./adapter.ts";
import { parseSpecChecklist, renderSpecScaffold } from "./spec-file.ts";
import type { Run, RunState } from "./types.ts";

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

describe("runAsTicket", () => {
  test("maps identity, cast, branch and origin channel onto the Ticket shape", () => {
    const run = makeRun({ cast: { implement: { harness: "codex" } }, repo: "gateway", channelId: "c9" });
    const ticket = runAsTicket(run);
    expect(ticket.id).toBe(run.id);
    expect(ticket.identifier).toBe(run.id);
    expect(ticket.title).toBe(run.title);
    expect(ticket.casting).toEqual({ implement: { harness: "codex" } });
    expect(ticket.branchRef).toBe(run.branch);
    expect(ticket.project).toBe("gateway");
    expect(ticket.originChannel).toBe("c9");
    expect(ticket.createdAt).toBe(run.createdAt);
    // A run has no board and no tracker URL — the adapter must not invent either.
    expect(ticket.url).toBe("");
    expect(ticket.assignees).toEqual([]);
    expect(ticket.blockedBy).toEqual([]);
  });

  test("body carries the goal verbatim and no criteria before the worker writes a checklist", () => {
    const ticket = runAsTicket(makeRun());
    expect(ticket.body).toBe("## Goal\nAdd OAuth middleware to the API gateway.");
    expect(ticket.criteria).toEqual([]);
  });

  test("a written checklist becomes acceptance criteria in body AND criteria", () => {
    const spec = parseSpecChecklist(
      "## Checklist\n- [x] wire the middleware\n- [ ] add tests\n\n## Notes\n- [ ] scratch line",
    );
    const ticket = runAsTicket(makeRun(), spec);
    expect(ticket.criteria).toEqual(["wire the middleware", "add tests"]);
    expect(ticket.body).toContain("## Acceptance criteria");
    expect(ticket.body).toContain("- [x] wire the middleware");
    expect(ticket.body).toContain("- [ ] add tests");
    // Notes bullets are scratch, never criteria.
    expect(ticket.criteria).not.toContain("scratch line");
  });

  test("the seeded placeholder never reaches the worker as a criterion", () => {
    const run = makeRun();
    const spec = parseSpecChecklist(renderSpecScaffold(run));
    expect(spec.hasPlaceholder).toBe(true);
    const ticket = runAsTicket(run, spec);
    expect(ticket.criteria).toEqual([]);
    expect(runBody(run, spec)).toBe("## Goal\nAdd OAuth middleware to the API gateway.");
  });
});

describe("ticketStateForRun", () => {
  test("implementing→in_progress, reviewing/publishing→in_review, parked→todo", () => {
    const cases: [RunState, string][] = [
      ["queued", "todo"],
      ["implementing", "in_progress"],
      ["reviewing", "in_review"],
      ["publishing", "in_review"],
      ["done", "done"],
      ["cancelled", "cancelled"],
      ["parked", "todo"],
      ["failed", "todo"],
    ];
    for (const [state, expected] of cases) expect(ticketStateForRun(state)).toBe(expected as never);
  });

  test("the mapped state staffs the stage the supervisor expects", () => {
    // The stage registry keys off ticket state; this is the contract the adapter must honor.
    expect(runAsTicket(makeRun({ state: "implementing" })).state).toBe("in_progress");
    expect(runAsTicket(makeRun({ state: "reviewing" })).state).toBe("in_review");
  });
});
