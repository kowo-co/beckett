/**
 * Beckett v7 — the run spec file (`src/run/spec-file.ts`)
 * =======================================================================================
 * `spec.md` at the worktree root IS the v7 replacement for the ticket body: the goal
 * verbatim, a checklist the worker authors as its first action, and a notes section it can
 * move an item into with a reason. It is committed with the work, so the artifact a human
 * reads afterwards contains the plan the worker actually followed.
 *
 * The Stop hook in `src/hooks/spec-gate.ts` enforces it: a worker may not end its turn with
 * an unticked checklist (or with the seeded placeholder still in place).
 */
import type { Run } from "./types.ts";

/** The seeded first checklist line; its presence means the worker never wrote a plan. */
export const SPEC_PLACEHOLDER = "(worker fills this in as its FIRST action: concrete, verifiable items)";

/** One parsed checklist row. */
export interface SpecChecklistItem {
  text: string;
  done: boolean;
}

/** The parsed shape of a spec.md checklist. */
export interface ParsedChecklist {
  items: SpecChecklistItem[];
  total: number;
  done: number;
  /** True while the seeded "(worker fills…" line is still present. */
  hasPlaceholder: boolean;
}

/** The scaffold written into a fresh worktree BEFORE the implement worker spawns. */
export function renderSpecScaffold(run: Run): string {
  return (
    `# ${run.title}\n` +
    `> run: ${run.id} · branch: ${run.branch} · created: ${run.createdAt}\n\n` +
    `## Goal\n${run.prompt}\n\n` +
    `## Checklist\n- [ ] ${SPEC_PLACEHOLDER}\n\n` +
    `## Notes\n(worker scratch: decisions, blockers, handoff notes)\n`
  );
}

/**
 * Parse the `## Checklist` section of a spec.md. Only rows inside that section count — a
 * `- [ ]` bullet in Notes is scratch, not a gate. A file with no Checklist section reads as
 * zero items and no placeholder, which the gate treats as "nothing to enforce".
 */
export function parseSpecChecklist(text: string): ParsedChecklist {
  const items: SpecChecklistItem[] = [];
  let inChecklist = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inChecklist = heading[1]!.trim().toLowerCase() === "checklist";
      continue;
    }
    if (!inChecklist) continue;
    const row = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (!row) continue;
    items.push({ text: row[2]!.trim(), done: row[1]!.toLowerCase() === "x" });
  }
  return {
    items,
    total: items.length,
    done: items.filter((i) => i.done).length,
    hasPlaceholder: items.some((i) => i.text.includes(SPEC_PLACEHOLDER)),
  };
}

/** The unchecked items, in file order — what the gate lists back at the worker. */
export function uncheckedItems(parsed: ParsedChecklist): string[] {
  return parsed.items.filter((i) => !i.done).map((i) => i.text);
}
