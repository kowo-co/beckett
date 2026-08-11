/**
 * Beckett v7 — the Run → WorkItem projection (`src/run/adapter.ts`)
 * =======================================================================================
 * The engine changed and the worker machinery did not. `src/dispatch/stages.ts` (every worker
 * prompt and persona) and `src/dispatch/spawn.ts` (the driver composition point) speak
 * {@link WorkItem} — the narrow stage-facing shape in `./work-item.ts`. The {@link RunSupervisor}
 * projects a {@link Run} onto it here, so a change to the run model never reaches into a prompt.
 *
 * Wave A adapted a Run onto the tracker's hydrated `Ticket` (board id, deep link, assignees and
 * all, filled with honest empty values). Wave B deleted the tracker, so the target of the
 * projection is now a shape with no fictional halves left to fill.
 */
import type { ParsedSpecChecklist } from "./spec-file.ts";
import type { Run } from "./types.ts";
import type { WorkItem } from "./work-item.ts";

/** The seeded placeholder line the scaffold writes; never a real checklist item. */
const SPEC_PLACEHOLDER = "worker fills this in";

/**
 * The worker-visible body: the goal verbatim, plus the spec checklist rendered as acceptance
 * criteria when the worker has already authored one (rework and review passes see the plan the
 * implement worker committed).
 */
export function runBody(run: Run, spec?: ParsedSpecChecklist): string {
  const goal = `## Goal\n${run.prompt.trim()}`;
  const items = spec?.items.filter((i) => !i.text.includes(SPEC_PLACEHOLDER)) ?? [];
  if (items.length === 0) return goal;
  const bullets = items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n");
  return `${goal}\n\n## Acceptance criteria\n${bullets}`;
}

/**
 * Project a run into the {@link WorkItem} `stages.ts`/`spawn.ts` consume. `identifier` is the run
 * id: it is already the human-facing handle (`run-20260810-oauth`), so journals, spend rows, and
 * dispatch events key on one string end to end.
 */
export function runAsWorkItem(run: Run, spec?: ParsedSpecChecklist): WorkItem {
  const criteria = (spec?.items ?? [])
    .filter((i) => !i.text.includes(SPEC_PLACEHOLDER))
    .map((i) => i.text);
  return {
    id: run.id,
    identifier: run.id,
    title: run.title,
    description: run.prompt,
    body: runBody(run, spec),
    state: run.state,
    casting: run.cast ?? {},
    criteria,
    ...(run.repo ? { project: run.repo } : {}),
    // The run's own git ref. The supervisor passes `run.branch` to the spawner directly, so this
    // field is purely what the dispatch event rows and the publish path report as the branch
    // carrying the work.
    branchRef: run.branch,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.channelId ? { originChannel: run.channelId } : {}),
  };
}
