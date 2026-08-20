/**
 * Beckett — the codemap capability (`src/capability/modules/codemap.ts`)
 * =======================================================================================
 * First slice of docs/plans/codemap-context-plugin.md: a file-level structural map of the
 * worker's tree, injected via `promptBlock` into every worker persona (`workerSystemAppend`).
 * No per-run opt-in. No general "context provider" seam — this spine slot already is that seam.
 *
 * The map is regenerated at worktree-cut (`src/worker/worktree.ts`) and read from
 * `.beckett/codemap.txt`. The block is a hint, not ground truth: a worker's own uncommitted
 * edits are invisible to it. Pull this module out of `availableCapabilityModules()` if the §7
 * after-measurement gate fails.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ActionClass } from "../../ext/contract.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import { fail, out, parse } from "../../cli/io.ts";
import { generateCodemap, readCodemap } from "../../codemap/generate.ts";

const USAGE = "usage: beckett codemap [--dir <path>] [--out <file>]";

async function runCodemap(argv: string[]): Promise<void> {
  const { flags } = parse(argv);
  const dir = flags.dir === undefined || flags.dir === true ? process.cwd() : String(flags.dir);
  const map = generateCodemap(dir);
  if (flags.out && flags.out !== true) {
    mkdirSync(dirname(String(flags.out)), { recursive: true });
    writeFileSync(String(flags.out), map.endsWith("\n") ? map : `${map}\n`, "utf8");
  }
  out(map);
}

/**
 * Factory registered in `availableCapabilityModules()`. The prompt block is empty when no
 * workspace (or map file) is in the compose context — tests that don't pass a worktree keep
 * the historical persona snapshot — and renders the cut-time map when spawn threads `workspace`.
 */
export function createCodemapCapability(_deps: CapabilityDeps): Capability {
  return {
    id: "codemap",
    summary:
      "file-level structural map of the worker's tree (header-doc purpose or export names), " +
      "injected into every worker persona",
    actionClass: ActionClass.FREE,
    cliVerbs: [
      {
        name: "codemap",
        summary: "print a file-level structural map of a repo (static parse, no LLM)",
        usage: USAGE,
        run: async (argv) => {
          try {
            await runCodemap(argv);
          } catch (err) {
            fail((err as Error).message);
          }
        },
      },
    ],
    busCommands: [],
    // Ahead of github (10) / deploy (30): orientation before operational contracts.
    promptBlock: {
      id: "codemap",
      priority: 5,
      render: ({ workspace }) => {
        if (!workspace) return "";
        const existing = readCodemap(workspace);
        const map = existing ?? generateCodemap(workspace);
        const text = map.trim();
        if (!text) return "";
        return (
          `CODEMAP: a compact file-level hint of this worktree, regenerated at worktree-cut. ` +
          `It is not ground truth once you start editing — your uncommitted changes are invisible to it.\n` +
          `<codemap>\n${text}\n</codemap>`
        );
      },
    },
  };
}
