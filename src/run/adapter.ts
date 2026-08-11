/**
 * Beckett v7 — the Run → Ticket adapter (`src/run/adapter.ts`)
 * =======================================================================================
 * The whole point of wave A is that the ENGINE changes and the worker machinery does not.
 * `src/dispatch/stages.ts` (every worker prompt and persona) and `src/dispatch/spawn.ts`
 * (the driver composition point) both speak {@link Ticket}. Rather than fork them — the
 * one change guaranteed to drift the prompts — the {@link RunSupervisor} adapts a
 * {@link Run} into the exact Ticket shape those two modules read, and they keep working
 * byte-identically. Wave B renames the shape; until then this is the seam.
 *
 * What the stage code actually reads off a Ticket: `id`, `identifier`, `title`, `body`,
 * `criteria`, `casting`, `state`, `project`, `branchRef`, `targetBranch`, `createdAt`,
 * `originChannel`. Everything else on the interface is filled with an honest empty value —
 * a run has no tracker board, no URL, and no assignees, and pretending otherwise would put
 * fiction into worker prompts.
 */
import type { Ticket, TicketState } from "../tracker/types.ts";
import type { ParsedSpecChecklist } from "./spec-file.ts";
import type { Run, RunState } from "./types.ts";

/** How a run's lifecycle projects onto the ticket states the stage registry keys off. */
export function ticketStateForRun(state: RunState): TicketState {
  switch (state) {
    case "implementing":
      return "in_progress";
    case "reviewing":
    case "publishing":
      return "in_review";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "parked":
      return "todo";
    case "failed":
      return "todo";
    default:
      return "todo"; // queued — admitted but not yet staffed
  }
}

/**
 * The worker-visible body: the goal verbatim, plus the spec checklist rendered as
 * acceptance criteria when the worker has already authored one (rework and review passes
 * see the plan the implement worker committed).
 */
export function runBody(run: Run, spec?: ParsedSpecChecklist): string {
  const goal = `## Goal\n${run.prompt.trim()}`;
  const items = spec?.items.filter((i) => !i.text.includes("worker fills this in")) ?? [];
  if (items.length === 0) return goal;
  const bullets = items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n");
  return `${goal}\n\n## Acceptance criteria\n${bullets}`;
}

/**
 * Adapt a run into the Ticket shape `stages.ts`/`spawn.ts` consume. `identifier` and the
 * public refs are the run id: it is already the human-facing handle (`run-20260810-oauth`),
 * so journals, spend rows, and dispatch events key on one string end to end.
 */
export function runAsTicket(run: Run, spec?: ParsedSpecChecklist): Ticket {
  const criteria = (spec?.items ?? [])
    .filter((i) => !i.text.includes("worker fills this in"))
    .map((i) => i.text);
  return {
    id: run.id,
    identifier: run.id,
    title: run.title,
    description: run.prompt,
    body: runBody(run, spec),
    state: ticketStateForRun(run.state),
    assignees: [],
    casting: run.cast ?? {},
    criteria,
    blockedBy: [],
    ...(run.repo ? { project: run.repo } : {}),
    // The run's own git ref. The supervisor never routes through `gitBranchForTicket` (it
    // passes `run.branch` to spawnWorker directly), so this field is purely what the dispatch
    // event rows and the publish path report as the branch carrying the work.
    branchRef: run.branch,
    projectId: "runs",
    url: "",
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.channelId ? { originChannel: run.channelId } : {}),
  };
}
