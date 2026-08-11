/**
 * Beckett — spec.md codec (`src/run/spec-file.ts`)
 * =======================================================================================
 * `<workspace>/spec.md` is the enforced worker contract for a run (architecture.md "v7
 * architecture: ticketless runs"): a checklist the worker fills in as its FIRST action and ticks
 * off as it goes, gated on Stop by `../hooks/spec-gate.ts`. This module is the pure codec —
 * render the scaffold a fresh worktree starts with, and parse the `## Checklist` section back
 * out of whatever the worker leaves behind. No I/O here; the hook/CLI/supervisor own reading and
 * writing the file itself.
 */

import type { Run } from "./types.ts";

/** The literal placeholder line seeded into a fresh spec.md's Checklist section. */
export const SPEC_CHECKLIST_PLACEHOLDER = "(worker fills this in as its FIRST action: concrete, verifiable items)";

/** One `- [ ]` / `- [x]` line under `## Checklist`. */
export interface SpecChecklistItem {
  text: string;
  done: boolean;
}

export interface ParsedSpecChecklist {
  items: SpecChecklistItem[];
  total: number;
  done: number;
  /** True when the seeded placeholder line is still present, checked or not. */
  hasPlaceholder: boolean;
}

/**
 * Render the spec.md scaffold a fresh run's worktree starts with. Exact format (architecture.md):
 *
 * ```md
 * # <title>
 * > run: <id> · branch: <branch> · created: <createdAt>
 *
 * ## Goal
 * <prompt verbatim>
 *
 * ## Checklist
 * - [ ] (worker fills this in as its FIRST action: concrete, verifiable items)
 *
 * ## Notes
 * (worker scratch: decisions, blockers, handoff notes)
 * ```
 */
export function renderSpecScaffold(run: Pick<Run, "id" | "title" | "branch" | "createdAt" | "prompt">): string {
  return (
    `# ${run.title}\n` +
    `> run: ${run.id} · branch: ${run.branch} · created: ${run.createdAt}\n` +
    `\n` +
    `## Goal\n` +
    `${run.prompt}\n` +
    `\n` +
    `## Checklist\n` +
    `- [ ] ${SPEC_CHECKLIST_PLACEHOLDER}\n` +
    `\n` +
    `## Notes\n` +
    `(worker scratch: decisions, blockers, handoff notes)\n`
  );
}

/** Matches `- [ ] text` / `* [x] text` (any leading indent — nested bullets count too). */
const CHECKLIST_ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const CHECKLIST_HEADING_RE = /^##\s+checklist\s*$/i;
/** Any `## ` heading — marks the end of the Checklist section. */
const SECTION_HEADING_RE = /^##\s+/;

/**
 * Pull the `## Checklist` section's `- [ ]` / `- [x]` bullets out of a spec.md body. Only bullets
 * under that heading count — a checkbox-shaped line elsewhere in the file (Goal, Notes, or the
 * worker's own scratch) is not a checklist item. Case-insensitive `x`; indentation/nesting under
 * the heading is tolerated and every nested box is counted. No `## Checklist` heading at all
 * yields an empty, non-placeholder result (`total: 0, done: 0, hasPlaceholder: false`).
 */
export function parseSpecChecklist(text: string): ParsedSpecChecklist {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => CHECKLIST_HEADING_RE.test(line.trim()));
  const items: SpecChecklistItem[] = [];

  if (headingIndex !== -1) {
    for (let i = headingIndex + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (SECTION_HEADING_RE.test(line.trim())) break; // next section — Checklist ends here
      const match = CHECKLIST_ITEM_RE.exec(line);
      if (match) items.push({ text: match[2]!.trim(), done: match[1]!.toLowerCase() === "x" });
    }
  }

  const done = items.filter((item) => item.done).length;
  const hasPlaceholder = items.some((item) => item.text === SPEC_CHECKLIST_PLACEHOLDER);
  return { items, total: items.length, done, hasPlaceholder };
}

/** e.g. "3/7 checked" — for cards/status surfaces. */
export function specProgressLine(parsed: Pick<ParsedSpecChecklist, "done" | "total">): string {
  return `${parsed.done}/${parsed.total} checked`;
}
