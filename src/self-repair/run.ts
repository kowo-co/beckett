/**
 * Beckett — nightly self-repair pass (`src/self-repair/run.ts`)
 * =======================================================================================
 * Once a day, read the real error surfaces, cluster them, and file a capped number of runs
 * against Beckett's own source through the existing `beckett task deploy` path. The pass
 * never edits the running tree, never merges, never deploys/restarts the daemon, and never
 * pushes to main. A fix reaches production the same way every other change does: a PR, CI,
 * review, a human or Beckett landing it.
 *
 * Structural walls, matching free time's posture (`src/freetime/run.ts`):
 *
 *   - **Ceiling before the call.** The file-cap is applied before any deploy. Dry-run
 *     assembles clusters and prints them; it writes and deploys nothing.
 *   - **Idempotent across days.** A persisted ledger plus open-run inspection means a
 *     signature already filed is not filed again.
 *   - **Killable.** The journal entry is written first as `started` and rewritten after each
 *     successful file, so dying halfway leaves a coherent record and no half-filed run
 *     (ledger rows land only after deploy succeeds).
 *   - **It fires whether the box is busy or not.** Filing a run is a queue insert; it does
 *     not contend with a live worker, the concierge, the browser, or a deploy (ro, 2026-08-24).
 *     There is no idle gate and `--dry` is never gated on busy state either.
 *   - **One short line to the share channel.** Same channel free time uses when
 *     `[self_repair] channel_id` is empty. Never a log dump.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Config, Logger, Paths } from "../types.ts";
import { callBus } from "../shell/control-bus.ts";
import { localDate } from "../freetime/model.ts";
import { deployRun } from "../cli/task-deploy.ts";
import { RunStore } from "../run/store.ts";
import type { Run } from "../run/types.ts";
import { clusterEvents, type ErrorCluster, type RecurrenceThreshold } from "./cluster.ts";
import { collectErrorEvents, type CollectErrorOptions } from "./sources.ts";
import {
  isFiled,
  ledgerPath,
  promptCarriesSignature,
  readLedger,
  recordFiled,
  SIGNATURE_MARKER,
  writeLedger,
  type SelfRepairLedger,
} from "./ledger.ts";

const SELF_REPAIR_ID_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;

/** Longest share posted to Discord. A count, not a dump. */
const SELF_REPAIR_SHARE_MAX_CHARS = 240;

type SelfRepairSharePost = (channelId: string, text: string) => Promise<void>;

type SelfRepairFileRun = (input: {
  title: string;
  prompt: string;
}) => Promise<{ runId: string }>;

interface SelfRepairRunDeps {
  config: Config;
  paths: Paths;
  logger: Logger;
  now?: () => Date;
  dry?: boolean;
  routineId?: string;
  collect?: (paths: Paths, opts: CollectErrorOptions) => Promise<import("./cluster.ts").ErrorEvent[]>;
  fileRun?: SelfRepairFileRun;
  listLiveRuns?: () => Array<Pick<Run, "prompt" | "title" | "state">>;
  postShare?: SelfRepairSharePost;
}

interface SelfRepairFiled {
  signature: string;
  runId: string;
  title: string;
}

interface SelfRepairRunOutcome {
  id: string;
  date: string;
  entryPath: string | null;
  ran: boolean;
  dry: boolean;
  note: string | null;
  clusters: ErrorCluster[];
  skippedAlreadyFiled: string[];
  filed: SelfRepairFiled[];
  shared: string | null;
}

export async function runSelfRepair(deps: SelfRepairRunDeps): Promise<SelfRepairRunOutcome> {
  const { config, paths, logger } = deps;
  const cfg = config.self_repair;
  const now = deps.now?.() ?? new Date();
  const date = localDate(now, cfg.tz);
  const id = `${date}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const rootDir = join(paths.beckettDir, "self-repair");

  const outcome: SelfRepairRunOutcome = {
    id,
    date,
    entryPath: null,
    ran: false,
    dry: Boolean(deps.dry),
    note: null,
    clusters: [],
    skippedAlreadyFiled: [],
    filed: [],
    shared: null,
  };

  if (!cfg.enabled && !deps.dry) {
    outcome.note = "self-repair is disabled ([self_repair] enabled=false)";
    logger.info("self-repair: disabled", { id });
    return outcome;
  }

  const threshold: RecurrenceThreshold = {
    minCount: cfg.min_count,
    minOccasions: cfg.min_occasions,
    occasionMs: 60_000,
  };
  const lookbackMs = cfg.lookback_days * 24 * 60 * 60_000;
  const collect = deps.collect ?? ((p, o) => collectErrorEvents(p, o));
  const events = await collect(paths, { now, lookbackMs });
  outcome.clusters = clusterEvents(events, threshold);
  outcome.ran = true;

  const ledgerFile = ledgerPath(rootDir);
  const ledger = deps.dry ? { version: 1 as const, filed: [] } : readLedger(ledgerFile);
  const live = deps.dry ? [] : (deps.listLiveRuns ?? defaultLiveRuns(paths))();

  const candidates: ErrorCluster[] = [];
  for (const cluster of outcome.clusters) {
    if (isFiled(ledger, cluster.signature) || live.some((run) => promptCarriesSignature(run.prompt, cluster.signature))) {
      outcome.skippedAlreadyFiled.push(cluster.signature);
      continue;
    }
    candidates.push(cluster);
  }

  if (deps.dry) {
    outcome.note = "dry run: clusters assembled; nothing filed, nothing posted";
    logger.info("self-repair: dry run", { id, clusters: outcome.clusters.length });
    return outcome;
  }

  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  outcome.entryPath = writeEntry(rootDir, id, composeEntry(outcome, deps.routineId ?? "manual"));

  const cap = cfg.file_cap;
  const toFile = candidates.slice(0, cap);
  let nextLedger: SelfRepairLedger = ledger;
  const fileRun = deps.fileRun ?? defaultFileRun(paths, logger);

  for (const cluster of toFile) {
    const title = titleFor(cluster);
    const prompt = briefFor(cluster);
    try {
      const filed = await fileRun({ title, prompt });
      const row = { signature: cluster.signature, runId: filed.runId, title };
      outcome.filed.push(row);
      nextLedger = recordFiled(nextLedger, {
        signature: cluster.signature,
        filedAt: now.toISOString(),
        runId: filed.runId,
        title,
      });
      writeLedger(ledgerFile, nextLedger);
      outcome.entryPath = writeEntry(rootDir, id, composeEntry(outcome, deps.routineId ?? "manual"));
    } catch (err) {
      logger.warn("self-repair: deploy failed; leaving the signature unfiled", {
        id,
        signature: cluster.signature,
        error: String(err),
      });
      outcome.note = `deploy failed on ${cluster.signature}: ${String(err)}`;
      outcome.entryPath = writeEntry(rootDir, id, composeEntry(outcome, deps.routineId ?? "manual"));
      break;
    }
  }

  const share = composeShare(outcome);
  const channelId = (cfg.channel_id.trim() || config.free_time.channel_id.trim());
  if (share && channelId) {
    try {
      await (deps.postShare ?? defaultSharePost(paths))(channelId, share);
      outcome.shared = share;
    } catch (err) {
      logger.warn("self-repair: share not posted", { id, error: String(err) });
    }
  }

  outcome.entryPath = writeEntry(rootDir, id, composeEntry(outcome, deps.routineId ?? "manual"));
  logger.info("self-repair: pass finished", {
    id,
    clusters: outcome.clusters.length,
    filed: outcome.filed.length,
  });
  return outcome;
}

function titleFor(cluster: ErrorCluster): string {
  const site = cluster.site ? ` ${cluster.site}` : "";
  const raw = `self-repair: ${cluster.normalized}${site}`;
  const words = raw.split(/\s+/).filter(Boolean).slice(0, 8);
  return words.join(" ").slice(0, 80) || "self-repair recurring error";
}

function briefFor(cluster: ErrorCluster): string {
  return [
    `${SIGNATURE_MARKER} ${cluster.signature}`,
    "",
    "Nightly self-repair pass. Recurring defect — fix the class, not one instance.",
    "",
    "WALLS (the pass that filed this cannot be talked out of them):",
    "- do not edit the running production tree",
    "- do not merge, do not push to main, do not force-push",
    "- do not restart or redeploy the daemon",
    "- a fix reaches production the way every other change does: a PR, CI, review, land",
    "",
    "Evidence:",
    `- signature: ${cluster.signature}`,
    `- count: ${cluster.count}`,
    `- occasions: ${cluster.occasions}`,
    `- first seen: ${cluster.firstSeen}`,
    `- last seen: ${cluster.lastSeen}`,
    `- site: ${cluster.site ?? "(none recoverable)"}`,
    `- sources: ${cluster.sources.join(", ")}`,
    `- exact error: ${cluster.sample}`,
  ].join("\n");
}

function composeShare(outcome: SelfRepairRunOutcome): string {
  if (!outcome.clusters.length) return "nightly self-repair: nothing recurring";
  const filed = outcome.filed.length;
  const found = outcome.clusters.length;
  const skipped = outcome.skippedAlreadyFiled.length;
  const extra = skipped ? `, skipped ${skipped} already filed` : "";
  const line =
    filed > 0
      ? `nightly self-repair: ${found} recurring defect${found === 1 ? "" : "s"}, filed ${filed}${extra}`
      : `nightly self-repair: ${found} recurring defect${found === 1 ? "" : "s"}, filed none${extra}`;
  return line.slice(0, SELF_REPAIR_SHARE_MAX_CHARS);
}

function composeEntry(outcome: SelfRepairRunOutcome, routineId: string): string {
  const lines = [
    `# self-repair ${outcome.id}`,
    "",
    `- date: ${outcome.date}`,
    `- routine: ${routineId}`,
    `- dry: ${outcome.dry}`,
    `- note: ${outcome.note ?? ""}`,
    `- clusters: ${outcome.clusters.length}`,
    `- filed: ${outcome.filed.map((f) => f.runId).join(", ") || "(none)"}`,
    `- skipped already filed: ${outcome.skippedAlreadyFiled.join(", ") || "(none)"}`,
    `- shared: ${outcome.shared ?? "(none)"}`,
    "",
    "## clusters",
  ];
  if (!outcome.clusters.length) lines.push("(none)");
  for (const c of outcome.clusters) {
    lines.push(
      `- ${c.signature} count=${c.count} occasions=${c.occasions} site=${c.site ?? "?"} first=${c.firstSeen} last=${c.lastSeen}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeEntry(rootDir: string, id: string, content: string): string {
  if (!SELF_REPAIR_ID_RE.test(id)) throw new Error(`self-repair: invalid pass id '${id}'`);
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const path = join(rootDir, `${id}.md`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return path;
}

export function listSelfRepairEntries(rootDir: string): Array<{ id: string; path: string; bytes: number }> {
  if (!existsSync(rootDir)) return [];
  const entries: Array<{ id: string; path: string; bytes: number }> = [];
  for (const file of readdirSync(rootDir)) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2}-[0-9a-f]{8})\.md$/);
    if (!m) continue;
    const path = join(rootDir, file);
    try {
      if (!lstatSync(path).isFile()) continue;
      entries.push({ id: m[1]!, path, bytes: Buffer.byteLength(readFileSync(path, "utf8"), "utf8") });
    } catch {
      /* listing is best-effort */
    }
  }
  return entries.sort((a, b) => b.id.localeCompare(a.id));
}

export function readSelfRepairEntry(rootDir: string, id: string): string | null {
  if (!SELF_REPAIR_ID_RE.test(id)) throw new Error(`self-repair: invalid pass id '${id}'`);
  const path = join(rootDir, `${id}.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function defaultLiveRuns(paths: Paths): () => Array<Pick<Run, "prompt" | "title" | "state">> {
  return () => {
    try {
      return new RunStore(join(paths.beckettDir, "runs.json")).live();
    } catch {
      return [];
    }
  };
}

function defaultFileRun(paths: Paths, logger: Logger): SelfRepairFileRun {
  return async ({ title, prompt }) => {
    const store = new RunStore(join(paths.beckettDir, "runs.json"), { logger });
    const result = await deployRun(["--title", title, "--prompt", prompt], {
      store,
      notifyBus: async (cmd, args) => {
        await callBus(join(paths.beckettDir, "control.sock"), cmd, args, 30_000);
      },
    });
    const runId = "runId" in result && typeof result.runId === "string" ? result.runId : (result as Run).id;
    if (!runId?.trim()) throw new Error("task deploy returned no run id");
    return { runId };
  };
}

function defaultSharePost(paths: Paths): SelfRepairSharePost {
  return async (channelId, text) => {
    await callBus(join(paths.beckettDir, "control.sock"), "discord.reply", { channelId, text }, 30_000);
  };
}
