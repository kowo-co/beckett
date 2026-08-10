/**
 * `beckett free-time` — the session body, plus the read-back verbs (docs/freetime.md).
 *
 *   - `free-time run`        the `weekly-free-time` routine's BODY — spawned detached by the self
 *                            lane's dispatch fork, or run by hand. Contained by construction: a
 *                            scratch directory it cannot write outside of, a deny list, a turn
 *                            cap, and a hard output-token ceiling, all from `[free_time]`.
 *   - `free-time run --dry`  assemble the seed and the prompt and print them; call nothing, write
 *                            nothing, spend nothing. The way to see what a session would be
 *                            handed without handing it to one.
 *   - `free-time ls|show`    read the journal entries back.
 *
 * `[free_time] enabled=false` refuses a run here too, not only at the routine's fire: the
 * off-switch has to hold for the hand-run path or it is not an off-switch.
 */

import { join } from "node:path";
import { config, paths } from "../cli/context.ts";
import { fail, out, parse, quietLogger } from "../cli/io.ts";
import { listFreeTimeEntries, readFreeTimeEntry, runFreeTime } from "./run.ts";

const USAGE =
  "usage: beckett free-time run [--dry] [--routine <id>] [--requester <id>] | " +
  "free-time ls [--json] | free-time show <id>";

export async function runFreeTimeCli(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const rootDir = join(paths.beckettDir, "free-time");

  if (!sub || sub === "ls" || sub === "list") {
    const { flags } = parse(rest);
    const entries = listFreeTimeEntries(rootDir);
    if (flags.json) out({ entries });
    if (!entries.length) out("(no free time yet)");
    out(entries.map((e) => `- ${e.id}  ${String(e.bytes).padStart(6)}B`).join("\n"));
  }

  if (sub === "show") {
    const id = rest[0]?.trim();
    if (!id) fail("usage: beckett free-time show <id>");
    let content: string | null = null;
    try {
      content = readFreeTimeEntry(rootDir, id!);
    } catch (err) {
      fail((err as Error).message);
    }
    if (content === null) fail(`no free-time entry for ${id}`);
    out(content!);
  }

  if (sub === "run") {
    const { flags } = parse(rest);
    const dry = Boolean(flags.dry);
    if (!config.free_time.enabled) fail("free time is disabled ([free_time] enabled=false)");
    const outcome = await runFreeTime({
      config,
      paths,
      logger: quietLogger,
      dry,
      ...(flags.routine ? { routineId: String(flags.routine) } : {}),
    });
    if (dry) {
      out([
        `# free time — dry run (${outcome.id})`,
        `scratch: ${outcome.scratchDir}`,
        "",
        "## seed",
        outcome.seed || "(nothing recalled — this would be a first session)",
        "",
        "## prompt",
        outcome.prompt,
      ].join("\n"));
    }
    out({
      id: outcome.id,
      entry: outcome.entryPath,
      ran: outcome.ran,
      outputTokens: outcome.outputTokens,
      budget: outcome.budget,
      truncated: outcome.truncated,
      timedOut: outcome.timedOut,
      memories: outcome.memoriesWritten,
      memoriesDropped: outcome.memoriesDropped,
      shared: outcome.shared,
      note: outcome.note,
    });
  }

  fail(USAGE);
}
