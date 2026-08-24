/**
 * `beckett dream` — the nightly pass's body, plus the read-back verbs (`src/dream/`).
 *
 *   - `dream run`        the `nightly-dream` routine's BODY — spawned detached by the self
 *                         lane's dispatch fork, or run by hand. Contained by construction: a
 *                         tool-less model call, a hard output-token ceiling, and two caps — how
 *                         many memories one pass may write and how many it may maintain — all
 *                         from `[dream]`. There is no busy gate: the pass runs at its time.
 *   - `dream run --dry`  build and print exactly what the pass WOULD commit and maintain:
 *                        assembles the day's logs and makes the one model call, but writes no
 *                        journal entry, touches no memory node, and posts nothing. It DOES
 *                        append its spend row — the model call is real, so the cost is real.
 *   - `dream run --force` replace tonight's entry if one already exists (manual re-runs only).
 *   - `dream ls|show`    read the journal entries back.
 *
 * `[dream] enabled=false` refuses a run here too, not only at the routine's fire: the off-switch
 * has to hold for the hand-run path or it is not an off-switch.
 */

import { join } from "node:path";
import { config, paths } from "./context.ts";
import { fail, out, parse, quietLogger } from "./io.ts";
import { listDreamEntries, readDreamEntry } from "../dream/journal.ts";
import { runDreamPass } from "../dream/run.ts";

const USAGE =
  "usage: beckett dream run [--dry] [--force] [--routine <id>] [--requester <id>] | " +
  "dream ls [--json] | dream show <YYYY-MM-DD>";

export async function runDreamCli(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const dreamsDir = join(paths.beckettDir, "dreams");

  if (!sub || sub === "ls" || sub === "list") {
    const { flags } = parse(rest);
    const entries = listDreamEntries(dreamsDir);
    if (flags.json) out({ entries });
    if (!entries.length) out("(no dreams yet)");
    out(
      entries
        .map((e) => `- ${e.date}  ${String(e.bytes).padStart(6)}B${e.truncated ? "  [truncated]" : ""}`)
        .join("\n"),
    );
  }

  if (sub === "show") {
    const date = rest[0]?.trim();
    if (!date) fail("usage: beckett dream show <YYYY-MM-DD>");
    let content: string | null = null;
    try {
      content = readDreamEntry(dreamsDir, date!);
    } catch (err) {
      fail((err as Error).message);
    }
    if (content === null) fail(`no dream entry for ${date}`);
    out(content!);
  }

  if (sub === "run") {
    const { flags } = parse(rest);
    const dry = Boolean(flags.dry);
    if (!config.dream.enabled) fail("the dream pass is disabled ([dream] enabled=false)");
    const outcome = await runDreamPass({
      config,
      paths,
      logger: quietLogger,
      dry,
      force: flags.force === true,
      ...(flags.routine ? { routineId: String(flags.routine) } : {}),
    });
    const summary = {
      date: outcome.date,
      entry: outcome.path,
      wrote: outcome.wrote,
      dry: outcome.dry,
      quiet: outcome.quiet,
      refused: outcome.refused,
      sessionsReviewed: outcome.sessionsReviewed,
      sourcesReviewed: outcome.sourcesReviewed,
      outputTokens: outcome.outputTokens,
      budget: outcome.budget,
      truncated: outcome.truncated,
      memories: outcome.memoriesWritten,
      memoriesPlanned: outcome.memoriesPlanned,
      memoriesDropped: outcome.memoriesDropped,
      memoriesUpdated: outcome.memoriesUpdated,
      memoriesRetired: outcome.memoriesRetired,
      flags: outcome.flagsWritten,
      maintenanceDropped: outcome.maintenanceDropped,
      shared: outcome.shared,
      note: outcome.note,
    };

    // `out()` exits the process — everything to print has to go out in ONE call, or a second
    // `out()` after it never runs. `--dry`'s human-readable plan and the JSON summary are both
    // printed here, in that single call.
    if (dry && !outcome.refused) {
      const plan = outcome.memoriesPlanned.length
        ? outcome.memoriesPlanned
            .map((m) => `- ${m.name}: ${m.description}${m.body ? `\n  note: ${m.body}` : ""}\n  provenance: ${m.provenance.join(", ")}`)
            .join("\n")
        : "(nothing would be committed)";
      out(
        [
          "# dream — dry run",
          "",
          "## prompt",
          outcome.prompt || "(quiet night — no sessions, no prompt built)",
          "",
          "## would commit",
          plan,
          ...(outcome.maintenancePlanned.length
            ? [
                "",
                "## would maintain",
                outcome.maintenancePlanned
                  .map((m) => `- ${m.op} ${m.target}: ${m.description}\n  provenance: ${m.provenance.join(", ")}`)
                  .join("\n"),
              ]
            : []),
          ...(outcome.memoriesDropped.length ? ["", "## dropped", outcome.memoriesDropped.map((d) => `- ${d}`).join("\n")] : []),
          ...(outcome.maintenanceDropped.length
            ? ["", "## maintenance dropped", outcome.maintenanceDropped.map((d) => `- ${d}`).join("\n")]
            : []),
          "",
          "## summary",
          JSON.stringify(summary, null, 2),
        ].join("\n"),
      );
    }

    out(summary);
  }

  fail(USAGE);
}
