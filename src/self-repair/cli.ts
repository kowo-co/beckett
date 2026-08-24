/**
 * `beckett self-repair` — the nightly pass body, plus the read-back verbs (docs/self-repair.md).
 *
 *   - `self-repair run`        the `nightly-self-repair` routine's BODY — spawned detached by
 *                              the self lane, or run by hand.
 *   - `self-repair run --dry`  print exactly the clusters it WOULD file; write and deploy nothing.
 *   - `self-repair ls|show`    read the journal entries back. `show` with no id is the last pass.
 *
 * `[self_repair] enabled=false` refuses a wet run here too, not only at the routine's fire.
 */

import { join } from "node:path";
import { config, paths } from "../cli/context.ts";
import { fail, out, parse, quietLogger } from "../cli/io.ts";
import { listSelfRepairEntries, readSelfRepairEntry, runSelfRepair } from "./run.ts";
import { clusterEvents } from "./cluster.ts";

const USAGE =
  "usage: beckett self-repair run [--dry] [--routine <id>] | " +
  "self-repair ls [--json] | self-repair show [id]";

export async function runSelfRepairCli(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const rootDir = join(paths.beckettDir, "self-repair");

  if (!sub || sub === "ls" || sub === "list") {
    const { flags } = parse(rest);
    const entries = listSelfRepairEntries(rootDir);
    if (flags.json) out({ entries });
    if (!entries.length) out("(no self-repair passes yet)");
    out(entries.map((e) => `- ${e.id}  ${String(e.bytes).padStart(6)}B`).join("\n"));
  }

  if (sub === "show" || sub === "last") {
    const requested = rest[0]?.trim();
    const entries = listSelfRepairEntries(rootDir);
    const id = requested || entries[0]?.id;
    if (!id) fail("no self-repair pass recorded yet");
    let content: string | null = null;
    try {
      content = readSelfRepairEntry(rootDir, id);
    } catch (err) {
      fail((err as Error).message);
    }
    if (content === null) fail(`no self-repair entry for ${id}`);
    out(content);
  }

  if (sub === "run") {
    const { flags } = parse(rest);
    const dry = Boolean(flags.dry);
    if (!dry && !config.self_repair.enabled) fail("self-repair is disabled ([self_repair] enabled=false)");
    const outcome = await runSelfRepair({
      config,
      paths,
      logger: quietLogger,
      dry,
      ...(flags.routine ? { routineId: String(flags.routine) } : {}),
    });
    if (dry) {
      out(renderDry(outcome.clusters));
    }
    out({
      id: outcome.id,
      entry: outcome.entryPath,
      ran: outcome.ran,
      dry: outcome.dry,
      clusters: outcome.clusters.length,
      filed: outcome.filed,
      skippedAlreadyFiled: outcome.skippedAlreadyFiled,
      shared: outcome.shared,
      note: outcome.note,
    });
  }

  fail(USAGE);
}

function renderDry(clusters: ReturnType<typeof clusterEvents>): string {
  const lines = [
    `# self-repair — dry run`,
    `clusters that would be eligible to file: ${clusters.length}`,
    "",
  ];
  if (!clusters.length) {
    lines.push("(none — nothing recurring above the threshold)");
    return lines.join("\n");
  }
  for (const c of clusters) {
    lines.push(
      `## ${c.signature}`,
      `count: ${c.count}  occasions: ${c.occasions}`,
      `first: ${c.firstSeen}  last: ${c.lastSeen}`,
      `site: ${c.site ?? "(none)"}`,
      `sources: ${c.sources.join(", ")}`,
      `sample: ${c.sample}`,
      "",
    );
  }
  lines.push("nothing was filed, posted, or written");
  return lines.join("\n");
}
