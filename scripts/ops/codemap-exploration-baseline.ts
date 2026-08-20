#!/usr/bin/env bun
/**
 * §4 baseline for the codemap capability: count Read/Grep/Glob calls before the first
 * Edit/Write/MultiEdit in ~/.beckett/journal/<run>.log, split by whether the run's brief
 * already named a target file. No new instrumentation — the journal already records this.
 *
 * Usage:
 *   bun scripts/ops/codemap-exploration-baseline.ts
 *   bun scripts/ops/codemap-exploration-baseline.ts --journal ~/.beckett/journal --runs ~/.beckett/runs.json
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  briefNamesTargetFile,
  cohortStats,
  formatReport,
  parseExploration,
  type BaselineReport,
  type ExplorationSample,
  type RunBrief,
} from "../../src/codemap/exploration.ts";

function flag(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1]!;
  return fallback;
}

function loadRuns(path: string): Map<string, RunBrief> {
  const byId = new Map<string, RunBrief>();
  if (!existsSync(path)) return byId;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { runs?: unknown };
    const runs = Array.isArray(raw.runs) ? raw.runs : [];
    for (const row of runs) {
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      if (typeof o.id !== "string") continue;
      const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string") : [];
      byId.set(o.id, {
        id: o.id,
        title: typeof o.title === "string" ? o.title : "",
        prompt: typeof o.prompt === "string" ? o.prompt : "",
        files,
      });
    }
  } catch (err) {
    console.error(`could not read runs ledger ${path}: ${(err as Error).message}`);
  }
  return byId;
}

function main(): void {
  const argv = process.argv.slice(2);
  const home = process.env.BECKETT_DIR ?? join(homedir(), ".beckett");
  const journalDir = flag(argv, "journal", join(home, "journal"));
  const runsPath = flag(argv, "runs", join(home, "runs.json"));
  const outPath = flag(argv, "out", "");

  if (!existsSync(journalDir)) {
    console.error(`no journal dir at ${journalDir}`);
    process.exit(1);
  }

  const runs = loadRuns(runsPath);
  const files = readdirSync(journalDir)
    .filter((name) => name.endsWith(".log"))
    .sort();

  const samples: ExplorationSample[] = [];
  for (const name of files) {
    const id = name.replace(/\.log$/, "");
    const text = readFileSync(join(journalDir, name), "utf8");
    // Skip journals that never issued a tool call — not a worker-implement sample.
    if (!/ · (Read|Grep|Glob|Edit|Write|MultiEdit)\b/.test(text)) continue;
    // v7 run journals are `run-*.log`. Ticket-era files (OPS-*) count too. Skip scratch `_N.log`.
    if (!/^(run-|OPS-|INT-)/i.test(id)) continue;
    const brief = runs.get(id);
    // No run record → unnamed. Do not guess from the journal body (it includes paths the worker
    // discovered, which would mis-file the "codemap can't help" cohort).
    const named = brief ? briefNamesTargetFile(brief) : false;
    samples.push(parseExploration(text, id, named));
  }

  const report: BaselineReport = {
    journalDir,
    sampleSize: samples.length,
    namedFile: cohortStats(samples.filter((s) => s.namedFile)),
    unnamedFile: cohortStats(samples.filter((s) => !s.namedFile)),
    samples,
  };

  const text = formatReport(report);
  console.log(text);
  console.log("");
  console.log("per-run:");
  for (const s of samples) {
    const named = s.namedFile ? "named-file" : "unnamed";
    const edit = s.firstEditTool ?? "none";
    const ms = s.msToFirstEdit !== null ? `${s.msToFirstEdit}ms` : "n/a";
    console.log(`  ${s.id}  ${named}  explore=${s.exploreCalls}  first-edit=${edit}  ${ms}`);
  }

  if (outPath) writeFileSync(outPath, `${text}\n`, "utf8");
}

main();
