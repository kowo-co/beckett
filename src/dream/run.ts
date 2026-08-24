/**
 * Beckett — the dream pass (`src/dream/run.ts`)
 * =======================================================================================
 * The nightly, budget-capped, read-mostly review of "the day's sessions" — ro's ask: "a quick
 * dreamer agent that reviews all the sessions of the day and adds relevant comments to memory?
 * like short term to long term commitals?" Fired once a day by the `nightly-dream` routine on
 * the self lane's dispatch fork (see {@link ../capability/modules/routines.ts}), run as its own
 * `beckett dream run` process — same shape as {@link ../freetime/run.ts}, which this module
 * follows closely.
 *
 * The two properties everything here bends around, in order:
 *
 *   1. **A dream cannot launder an inference into a fact.** The reflection model never holds a
 *      tool: it reads ONE assembled document ({@link ./assemble.ts}, read-only, guild-only —
 *      DMs are never read) and returns text. Every write this pass performs happens in THIS
 *      code, through two surfaces only — the dated journal entry ({@link ./journal.ts}) and
 *      create-only `dream`-namespace memories (`MemoryStore.rememberDream`, which forces
 *      `type: dream`/`inference: true`/a provenance list and refuses to touch any existing
 *      node). A proposed memory whose provenance names a message that was not actually
 *      assembled tonight is DROPPED, counted, and noted — never written.
 *   2. **It is small enough not to need permission.** There is NO busy gate — ro ruled it out:
 *      the pass runs at its fixed time (`[dream] fire_at` / `timezone`, 00:00 America/Los_Angeles
 *      by default) whether or not the fleet is building or someone is mid-conversation. What
 *      keeps it cheap is size, not scheduling: ONE tool-less model call, capped by a hard
 *      output-token ceiling checked BEFORE it fires, on a cheap model by default (haiku), and
 *      wall-clock-killed rather than waited on. The conservatism caps bound what one pass may
 *      ever write — `[dream] memories_per_night_max` for new nodes and
 *      `[dream] prunes_per_night_max` for maintenance (update/retire/flag) — the "middle ground"
 *      ro asked for, not "remember everything".
 *
 * Dying mid-run never leaves a half-written memory: `rememberDream` is atomic per node, and the
 * journal entry is composed from whatever the outcome accumulated (`outputTokens`/
 * `memoriesWritten`/…) and written exactly once at the end (or in the `catch`, honestly noting
 * the failure) — never a partial file.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { z } from "zod";
import type { Config, Logger, Paths } from "../types.ts";
import { childEnv } from "../env.ts";
import { callBus } from "../shell/control-bus.ts";
import { extractVerdictJson } from "../concierge/triage.ts";
import { createMemory, DREAM_NAME_RE, type MemoryStore } from "../memory/index.ts";
import { createChannelContextStore, type ChannelContextStore } from "../concierge/channel-context.ts";
import { assembleDreamInputs, type DreamInputs } from "./assemble.ts";
import { DREAM_TRUNCATED_LINE, dreamEntryPath, writeDreamEntry } from "./journal.ts";
import { localDate, parseModelResult } from "../freetime/model.ts";
import { appendSpendRecord, DREAM_SPEND_TICKET_ID, type SpendOutcome } from "../spend.ts";

/** The zone "the day" rolls over in for the journal's date stamp when `[dream] timezone` is
 *  somehow blank — the same default the schema and the routine's fixed fire time carry. */
const DREAM_TZ_FALLBACK = "America/Los_Angeles";

/** Tools the one-shot reflection child is explicitly denied. The containment does NOT rest on
 *  this list (the write path is this process's code, not the child's hands) — it exists so the
 *  dream model cannot even READ outside its assembled input: no shell, no filesystem, no web. */
const DREAM_DISALLOWED_TOOLS =
  "Bash,BashOutput,KillShell,Read,Glob,Grep,LS,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite";

export interface DreamModelResult {
  text: string;
  outputTokens: number;
}
/** The one model seam: prompt in, text + output-token cost out. No tools, ever. */
export type DreamModelCall = (prompt: string) => Promise<DreamModelResult>;

/** The one line posted to `[dream] channel_id`, and how the runner is asked to say it. */
export type DreamSharePost = (channelId: string, text: string) => Promise<void>;

export interface DreamRunDeps {
  config: Config;
  paths: Paths;
  logger: Logger;
  now?: () => Date;
  /** Injectable for tests; default = the real memory graph at paths.memoryDir. */
  memory?: MemoryStore | null;
  /** Injectable for tests; default = the real channel-context store at paths.channelsDir. */
  channels?: ChannelContextStore | null;
  /** Injectable for tests; default = `paths.journalDir`. Pass null to skip worker journals. */
  journalDir?: string | null;
  /** Injectable for tests; default = the dispatch ledger under `paths.eventsDir`. Null skips it. */
  dispatchLedger?: string | null;
  /** Injectable for tests; default = a tool-less one-shot `claude -p` spawn. */
  callModel?: DreamModelCall;
  /** Injectable for tests; default = one `discord.reply` control-bus post. */
  postShare?: DreamSharePost;
  /** Routine id for provenance in the entry header ("manual" when hand-run). */
  routineId?: string;
  /** Replace an existing entry for the date (manual re-runs only). */
  force?: boolean;
  /** Build and print exactly what the pass WOULD commit: runs the review + the one model call,
   *  but writes no journal entry, touches no memory node, and posts nothing. It DOES append its
   *  one spend row — the model call is real, so the money is real (see {@link recordDreamSpend}). */
  dry?: boolean;
}

export interface DreamRunOutcome {
  date: string;
  path: string | null;
  wrote: boolean;
  dry: boolean;
  /** True when there were no sessions in the window — the quiet-day short-circuit. */
  quiet: boolean;
  /** Non-null when the pass refused to start (tonight's entry already exists) and never
   *  assembled or called the model at all. There is no busy refusal — see the header. */
  refused: string | null;
  /** True when the pass hit its output-token ceiling and stopped without a model call. */
  truncated: boolean;
  outputTokens: number;
  budget: number;
  /** How many distinct channel CONVERSATIONS were reviewed this pass (never journals/ledger). */
  sessionsReviewed: number;
  /** How many distinct sources of ANY kind were reviewed — conversations, journals, ledger runs. */
  sourcesReviewed: number;
  /** Names actually written (`wrote: true`) or, on `--dry`, names that WOULD have been written. */
  memoriesWritten: string[];
  /** Slugs dropped with the reason (bad slug, over the cap, unknown provenance, name collision…). */
  memoriesDropped: string[];
  /** The full accepted plan behind `memoriesWritten`, same order — description/body/provenance
   *  preserved instead of discarded, so `--dry` can show exactly what would land and the Discord
   *  line can say what and why, not just a count. One-to-one with `memoriesWritten`. */
  memoriesPlanned: PlannedDreamMemory[];
  /** Existing dream nodes this pass rewrote in place (`wrote: true`) or would rewrite (`--dry`). */
  memoriesUpdated: string[];
  /** Dream nodes this pass archived out of the graph, or would archive on `--dry`. */
  memoriesRetired: string[];
  /** Stale-flag nodes written about NON-dream nodes, or that would be written on `--dry`. */
  flagsWritten: string[];
  /** The accepted maintenance plan behind the three lists above, in the order it was applied. */
  maintenancePlanned: PlannedDreamMaintenance[];
  /** Maintenance ops refused with the reason (unknown target, over the prune cap, no provenance…). */
  maintenanceDropped: string[];
  /** The one line posted to the share channel, or null when nothing was posted. */
  shared: string | null;
  /** The assembled synthesis prompt — the thing `--dry` exists to show. */
  prompt: string;
  note: string | null;
}

/** What the synthesis call must return. Parsed strictly; one retry, then an honest fallback. */
const DreamSynthesisSchema = z.object({
  /** A few tight lines for the journal — never posted to Discord verbatim. */
  summary: z.string(),
  memories: z
    .array(
      z.object({
        slug: z.string(),
        description: z.string(),
        note: z.string().optional(),
        /** Message-granular source ids from the "valid provenance ids" list in the prompt. */
        provenance: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** The maintenance half (the pass prunes as well as adds): edits to the pass's OWN namespace,
   *  plus stale FLAGS about nodes outside it. Never a write to somebody else's fact. */
  maintenance: z
    .array(
      z.object({
        op: z.enum(["update", "retire", "flag"]),
        /** The node the op is about: an existing `dream-…` node for update/retire, any other
         *  existing node for flag. */
        target: z.string(),
        /** update: the replacement one-liner. flag: why it looks stale. */
        description: z.string().optional(),
        note: z.string().optional(),
        provenance: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
type DreamSynthesis = z.infer<typeof DreamSynthesisSchema>;

/** A validated memory the synthesis proposed, ready for `rememberDream`. */
export interface PlannedDreamMemory {
  name: string;
  description: string;
  body: string;
  provenance: string[];
}

/** A validated maintenance op, ready for `updateDream` / `retireDream` / `flagStaleNode`. */
export interface PlannedDreamMaintenance {
  op: "update" | "retire" | "flag";
  /** The node being updated, retired, or flagged. */
  target: string;
  /** update: the new description. flag: the reason the node looks stale. retire: the reason. */
  description: string;
  body: string;
  provenance: string[];
  /** flag only: the name of the dream node that will CARRY the flag. */
  flagName?: string;
}

/** Run one nightly pass. Never throws for run-shaped failures — the journal entry is the report. */
export async function runDreamPass(deps: DreamRunDeps): Promise<DreamRunOutcome> {
  const { config, paths, logger } = deps;
  const cfg = config.dream;
  const now = deps.now?.() ?? new Date();
  // The entry's date is stamped in the SAME zone the pass fires in, so a 00:00 fire and the
  // journal file it writes never disagree about which day it is.
  const date = localDate(now, cfg.timezone?.trim() || DREAM_TZ_FALLBACK);
  const routineId = deps.routineId ?? "manual";
  const dreamsDir = join(paths.beckettDir, "dreams");

  const outcome: DreamRunOutcome = {
    date,
    path: null,
    wrote: false,
    dry: Boolean(deps.dry),
    quiet: false,
    refused: null,
    truncated: false,
    outputTokens: 0,
    budget: cfg.output_token_budget,
    sessionsReviewed: 0,
    sourcesReviewed: 0,
    memoriesWritten: [],
    memoriesDropped: [],
    memoriesPlanned: [],
    memoriesUpdated: [],
    memoriesRetired: [],
    flagsWritten: [],
    maintenancePlanned: [],
    maintenanceDropped: [],
    shared: null,
    prompt: "",
    note: null,
  };

  // There is deliberately no busy check here — the pass runs at its time (see the header).
  // Exactly one REAL entry per night: an existing entry ends a real run before any read or model
  // call. `--dry` is inspection-only and never touches the entry file, so it is exempt.
  if (!deps.dry && !deps.force) {
    try {
      dreamEntryGuard(dreamsDir, date);
    } catch (err) {
      outcome.refused = (err as Error).message;
      logger.info("dream: skipped", { date, note: outcome.refused });
      return outcome;
    }
  }

  if (cfg.output_token_budget <= 0) {
    outcome.note = `no dream pass: the output-token ceiling is ${cfg.output_token_budget}`;
    if (!deps.dry) {
      outcome.path = writeDreamEntry(dreamsDir, date, composeEntry(outcome, routineId, []), { force: deps.force });
      outcome.wrote = true;
    }
    logger.info("dream: skipped", { date, note: outcome.note });
    return outcome;
  }

  const memory = deps.memory !== undefined ? deps.memory : defaultMemory(paths, logger);
  const channels = deps.channels !== undefined ? deps.channels : defaultChannels(config, paths, logger);
  const callModel = deps.callModel ?? defaultDreamModelCall(config, logger);

  const inputs = assembleDreamInputs({
    channels,
    // The other two logs (issue: "read the logs, plural"). Both are opt-outable by passing null
    // in deps — a test asserts the conversation-only shape that way — and both degrade to a note
    // rather than an error when the path does not exist yet on a fresh box.
    journalDir: deps.journalDir !== undefined ? deps.journalDir : paths.journalDir,
    dispatchLedger:
      deps.dispatchLedger !== undefined ? deps.dispatchLedger : join(paths.eventsDir, "dispatch.jsonl"),
    windowHours: cfg.window_hours,
    logger,
    now: () => now,
  });
  // "Channels" in the Discord line means CONVERSATIONS, not sources — a worker journal is not a
  // channel and must not inflate the count a human reads as "people talked to me in N rooms".
  outcome.sessionsReviewed = inputs.sections.filter((s) => s.kind === "channel" && s.text.trim()).length;
  outcome.sourcesReviewed = inputs.sections.filter((s) => s.text.trim()).length;

  const finish = async (
    body: string[],
    opts: { truncated?: boolean; note?: string | null } = {},
  ): Promise<DreamRunOutcome> => {
    outcome.truncated = opts.truncated ?? outcome.truncated;
    outcome.note = opts.note ?? outcome.note;
    if (deps.dry) return outcome; // inspection only — no entry, no writes, no post
    const entry = composeEntry(outcome, routineId, body);
    outcome.path = writeDreamEntry(dreamsDir, date, entry, { force: deps.force });
    outcome.wrote = true;
    await postReport(config, deps, outcome, logger);
    logger.info("dream: entry written", {
      date,
      truncated: outcome.truncated,
      quiet: outcome.quiet,
      outputTokens: outcome.outputTokens,
      memories: outcome.memoriesWritten.length,
    });
    return outcome;
  };

  // The quiet-day short-circuit: prefer a thin honest entry over spending budget to pad one.
  if (inputs.empty) {
    outcome.quiet = true;
    return finish([
      "## review",
      "Nothing in the window — no guild sessions, no worker journals, no dispatch rows. Nothing to review tonight.",
    ]);
  }

  // What the pass is allowed to MAINTAIN tonight: its own existing dream nodes (update/retire)
  // and everything outside the namespace (flag only). Read once, here, so the prompt and the
  // validation below agree on exactly one census — a target the model invents is refused.
  const census = memoryCensus(memory, logger);
  outcome.prompt = synthesisPrompt(inputs, date, cfg.memories_per_night_max, cfg.prunes_per_night_max, census);

  const startedAt = Date.now();
  let spendOutcome: SpendOutcome = "done";
  try {
    let raw = await call(callModel, outcome);
    let synthesis = parseSynthesis(raw);
    if (!synthesis && outcome.outputTokens < cfg.output_token_budget) {
      raw = await call(
        callModel,
        outcome,
        `Your previous reply could not be parsed. Return ONLY the JSON object described before — no fences, no prose.\n\n${outcome.prompt}`,
      );
      synthesis = parseSynthesis(raw);
    }
    if (!synthesis) {
      return finish(
        ["## review", "Tonight's synthesis would not parse as the expected JSON twice — nothing committed."],
        { note: "synthesis unparseable; nothing committed", truncated: outcome.outputTokens >= cfg.output_token_budget },
      );
    }

    const plan = planDreamMemories(synthesis.memories, {
      date,
      max: cfg.memories_per_night_max,
      knownSourceIds: new Set(inputs.sourceIds),
    });
    outcome.memoriesDropped.push(...plan.dropped);
    for (const m of plan.keep) {
      if (deps.dry) {
        outcome.memoriesWritten.push(m.name); // "would write", not written
        outcome.memoriesPlanned.push(m);
        continue;
      }
      if (!memory) {
        outcome.memoriesDropped.push(`${m.name} (no memory store)`);
        continue;
      }
      try {
        await memory.rememberDream({
          name: m.name,
          description: m.description,
          body: m.body,
          provenance: m.provenance,
          reason: `nightly dream pass (${routineId})`,
        });
        outcome.memoriesWritten.push(m.name);
        outcome.memoriesPlanned.push(m);
      } catch (err) {
        outcome.memoriesDropped.push(`${m.name} (${(err as Error).message})`);
      }
    }

    // The maintenance half. Same discipline as the add half: planned in a pure function that
    // validates every target against the census and every provenance id against tonight's
    // assembly, capped by `[dream] prunes_per_night_max`, then applied one op at a time so a
    // single refusal is counted and skipped rather than losing the rest of the pass.
    const upkeep = planDreamMaintenance(synthesis.maintenance, {
      date,
      max: cfg.prunes_per_night_max,
      knownSourceIds: new Set(inputs.sourceIds),
      dreamNodes: new Set(census.dreams.map((n) => n.name)),
      otherNodes: new Set(census.others.map((n) => n.name)),
      takenNames: new Set([...outcome.memoriesWritten, ...census.dreams.map((n) => n.name)]),
    });
    outcome.maintenanceDropped.push(...upkeep.dropped);
    for (const op of upkeep.keep) {
      if (!deps.dry && !memory) {
        outcome.maintenanceDropped.push(`${op.op} ${op.target} (no memory store)`);
        continue;
      }
      try {
        if (!deps.dry) await applyMaintenance(memory!, op, routineId);
        recordMaintenance(outcome, op);
      } catch (err) {
        outcome.maintenanceDropped.push(`${op.op} ${op.target} (${(err as Error).message})`);
      }
    }

    return finish(
      ["## review", synthesis.summary.trim() || "—"],
      { truncated: outcome.outputTokens >= cfg.output_token_budget },
    );
  } catch (err) {
    spendOutcome = "failed";
    logger.warn("dream: pass failed mid-run", { date, error: String(err) });
    return finish(
      ["## review", `The pass failed mid-run: ${String(err)}. Sessions were assembled; nothing was committed.`],
      { note: `failed: ${String(err)}` },
    );
  } finally {
    // Recorded once here (not per branch above) so every path that actually spent a model call —
    // success, unparseable synthesis, or a mid-run failure — lands exactly one row, whether or not
    // a memory was ultimately written. `--dry` still calls the model, so it still costs and bills.
    recordDreamSpend(deps, {
      outputTokens: outcome.outputTokens,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: spendOutcome,
    });
  }
}

async function call(callModel: DreamModelCall, outcome: DreamRunOutcome, promptOverride?: string): Promise<string> {
  const r = await callModel(promptOverride ?? outcome.prompt);
  outcome.outputTokens += Math.max(0, Math.floor(r.outputTokens) || 0);
  return r.text;
}

/**
 * Turn the synthesis's proposed memories into validated, namespaced, create-only writes — and a
 * list of what was refused and why. This IS the conservatism cap (requirement 3): entries past
 * `max` are dropped by POSITION (the model's own ordering), and an entry whose provenance names
 * nothing from tonight's assembly is refused outright — the structural guarantee that an
 * inference can only ever cite a message that was genuinely on the table.
 */
export function planDreamMemories(
  entries: Array<{ slug: string; description: string; note?: string; provenance: string[] }>,
  opts: { date: string; max: number; knownSourceIds: Set<string> },
): { keep: PlannedDreamMemory[]; dropped: string[] } {
  const keep: PlannedDreamMemory[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of entries.entries()) {
    const label = entry.slug?.trim() || `entry ${i + 1}`;
    if (keep.length >= opts.max) {
      dropped.push(`${label} (over the ${opts.max}-per-night conservatism cap)`);
      continue;
    }
    const name = dreamMemoryName(opts.date, entry.slug ?? "");
    if (!name) {
      dropped.push(`${label} (unusable slug)`);
      continue;
    }
    if (seen.has(name)) {
      dropped.push(`${label} (duplicate slug in the same pass)`);
      continue;
    }
    const description = trimLine(entry.description ?? "");
    if (!description) {
      dropped.push(`${label} (empty description)`);
      continue;
    }
    const provenance = (entry.provenance ?? []).map((p) => String(p).trim()).filter(Boolean);
    if (!provenance.length) {
      dropped.push(`${label} (no provenance)`);
      continue;
    }
    const unknown = provenance.filter((p) => !opts.knownSourceIds.has(p));
    if (unknown.length) {
      // Provenance must name REAL sources from tonight's assembly — an inference that cites
      // something that wasn't on the table is exactly the laundering this pass must refuse.
      dropped.push(`${label} (provenance names unknown sources: ${unknown.join(", ")})`);
      continue;
    }
    seen.add(name);
    keep.push({ name, description, body: trimLine(entry.note ?? ""), provenance });
  }
  return { keep, dropped };
}

/**
 * Turn the synthesis's proposed MAINTENANCE into validated ops — and a list of what was refused
 * and why. The walls, in order:
 *
 *   - the per-night prune cap (`[dream] prunes_per_night_max`), by POSITION, like the add cap;
 *   - `update`/`retire` may only ever name a node that EXISTS and is in the dream namespace, so
 *     the pass can rewrite its own inferences and nobody else's facts;
 *   - `flag` may only ever name an existing node OUTSIDE the namespace, and produces a NEW
 *     dream node carrying the reason — the target's own file is never touched;
 *   - every op, flags included, must cite real provenance from tonight's assembly. A suspicion
 *     with no evidence on the table is exactly the laundering the add half already refuses.
 */
export function planDreamMaintenance(
  entries: Array<{ op: "update" | "retire" | "flag"; target: string; description?: string; note?: string; provenance: string[] }>,
  opts: {
    date: string;
    max: number;
    knownSourceIds: Set<string>;
    dreamNodes: Set<string>;
    otherNodes: Set<string>;
    /** Names already spoken for tonight — a flag node may not collide with one. */
    takenNames: Set<string>;
  },
): { keep: PlannedDreamMaintenance[]; dropped: string[] } {
  const keep: PlannedDreamMaintenance[] = [];
  const dropped: string[] = [];
  const touched = new Set<string>();
  const taken = new Set(opts.takenNames);
  for (const [i, entry] of entries.entries()) {
    const target = String(entry.target ?? "").trim();
    const label = `${entry.op} ${target || `entry ${i + 1}`}`;
    if (keep.length >= opts.max) {
      dropped.push(`${label} (over the ${opts.max}-per-night prune cap)`);
      continue;
    }
    if (!target) {
      dropped.push(`${label} (no target)`);
      continue;
    }
    if (touched.has(target)) {
      dropped.push(`${label} (target already touched in the same pass)`);
      continue;
    }
    const provenance = (entry.provenance ?? []).map((p) => String(p).trim()).filter(Boolean);
    if (!provenance.length) {
      dropped.push(`${label} (no provenance)`);
      continue;
    }
    const unknown = provenance.filter((p) => !opts.knownSourceIds.has(p));
    if (unknown.length) {
      dropped.push(`${label} (provenance names unknown sources: ${unknown.join(", ")})`);
      continue;
    }
    const description = trimLine(entry.description ?? "");
    const body = trimLine(entry.note ?? "");

    if (entry.op === "flag") {
      if (opts.dreamNodes.has(target)) {
        dropped.push(`${label} (a dream node — update or retire it, don't flag it)`);
        continue;
      }
      if (!opts.otherNodes.has(target)) {
        dropped.push(`${label} (no such node in the memory graph)`);
        continue;
      }
      if (!description) {
        dropped.push(`${label} (a stale flag needs a reason)`);
        continue;
      }
      const flagName = dreamMemoryName(opts.date, `stale-${target}`);
      if (!flagName || taken.has(flagName)) {
        dropped.push(`${label} (${flagName ? "a flag for this node already exists tonight" : "unusable flag name"})`);
        continue;
      }
      taken.add(flagName);
      touched.add(target);
      keep.push({ op: "flag", target, description, body, provenance, flagName });
      continue;
    }

    if (!opts.dreamNodes.has(target)) {
      dropped.push(`${label} (not an existing dream node — the pass may only edit its own namespace)`);
      continue;
    }
    if (entry.op === "update" && !description) {
      dropped.push(`${label} (an update needs a replacement description)`);
      continue;
    }
    touched.add(target);
    keep.push({ op: entry.op, target, description, body, provenance });
  }
  return { keep, dropped };
}

/** Run one planned maintenance op against the store. Each op is its own narrow write path. */
async function applyMaintenance(memory: MemoryStore, op: PlannedDreamMaintenance, routineId: string): Promise<void> {
  const reason = `nightly dream pass (${routineId})`;
  if (op.op === "update") {
    await memory.updateDream({
      name: op.target,
      description: op.description,
      ...(op.body ? { body: op.body } : {}),
      provenance: op.provenance,
      reason,
    });
    return;
  }
  if (op.op === "retire") {
    await memory.retireDream(op.target, op.description || reason);
    return;
  }
  await memory.flagStaleNode({
    name: op.flagName!,
    target: op.target,
    flagReason: op.description,
    provenance: op.provenance,
    ...(op.body ? { body: op.body } : {}),
    reason,
  });
}

/** Book one applied (or, on `--dry`, would-be-applied) op onto the outcome's three splits. */
function recordMaintenance(outcome: DreamRunOutcome, op: PlannedDreamMaintenance): void {
  outcome.maintenancePlanned.push(op);
  if (op.op === "update") outcome.memoriesUpdated.push(op.target);
  else if (op.op === "retire") outcome.memoriesRetired.push(op.target);
  else outcome.flagsWritten.push(op.flagName!);
}

/** One node as the maintenance census sees it: just enough for the model to name it. */
interface CensusNode {
  name: string;
  description: string;
}

/** What tonight's pass may maintain: its own dream nodes, and everything it may only flag. */
interface DreamMemoryCensus {
  dreams: CensusNode[];
  others: CensusNode[];
}

/** How many nodes of each half the prompt lists. Bounded for the same reason the sessions are. */
const CENSUS_MAX = 60;

/**
 * Read the memory graph once for the maintenance half. Never throws — an unreadable store
 * degrades to an empty census, which makes every maintenance op the model proposes fail
 * validation and be counted, rather than being applied against a graph nobody could read.
 */
function memoryCensus(memory: MemoryStore | null, logger: Logger): DreamMemoryCensus {
  if (!memory) return { dreams: [], others: [] };
  try {
    const nodes = [...memory.buildGraph().nodes.values()].filter((n) => !n.phantom && n.path);
    const recent = (list: typeof nodes): CensusNode[] =>
      list
        .sort((a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")))
        .slice(0, CENSUS_MAX)
        .map((n) => ({ name: n.name, description: trimLine(n.description) }));
    return {
      dreams: recent(nodes.filter((n) => n.type === "dream")),
      others: recent(nodes.filter((n) => n.type !== "dream")),
    };
  } catch (err) {
    logger.warn("dream: memory census unavailable", { error: String(err) });
    return { dreams: [], others: [] };
  }
}

/** `dream-YYYY-MM-DD-<slug>`, or null when the slug cannot be made into a legal node name. */
export function dreamMemoryName(date: string, slug: string): string | null {
  const normalized = String(slug).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) return null;
  const name = `dream-${date}-${normalized}`;
  return DREAM_NAME_RE.test(name) ? name : null;
}

// ── entry composition ──────────────────────────────────────────────────────────────────

/** Compose one night's journal entry from the outcome as it stands when the pass finishes. */
function composeEntry(c: DreamRunOutcome, routineId: string, body: string[]): string {
  const lines = [
    `# dream — ${c.date}`,
    "",
    "<!-- dream-meta",
    `routine: ${routineId}`,
    `sessions_reviewed: ${c.sessionsReviewed}`,
    `sources_reviewed: ${c.sourcesReviewed}`,
    `output_tokens: ${c.outputTokens} / ${c.budget}`,
    c.truncated ? DREAM_TRUNCATED_LINE : "truncated: false",
    `memories: ${c.memoriesWritten.join(", ") || "(none)"}`,
    ...(c.memoriesDropped.length ? [`memories_dropped: ${c.memoriesDropped.join("; ")}`] : []),
    ...(c.memoriesUpdated.length ? [`memories_updated: ${c.memoriesUpdated.join(", ")}`] : []),
    ...(c.memoriesRetired.length ? [`memories_retired: ${c.memoriesRetired.join(", ")}`] : []),
    ...(c.flagsWritten.length ? [`flags: ${c.flagsWritten.join(", ")}`] : []),
    ...(c.maintenanceDropped.length ? [`maintenance_dropped: ${c.maintenanceDropped.join("; ")}`] : []),
    ...(c.note ? [`note: ${c.note}`] : []),
    "-->",
    "",
    ...body,
    "",
  ];
  if (c.truncated) {
    lines.push(
      "",
      `> ⚠ truncated: this pass hit its ${c.budget}-output-token ceiling and stopped cleanly.`,
    );
  }
  return lines.join("\n");
}

// ── the Discord report (requirement 5 — one short line, never raw session content) ────────

/**
 * Compose + post the one line this pass ever says out loud. Built entirely from validated,
 * already-capped structured data (memory descriptions this code itself accepted into the plan) —
 * never from raw model prose — so a transcript line, a session id, or tool output can never ride
 * this path into Discord. Best-effort: a Discord outage costs a message, never the pass (the
 * journal entry is already on disk by the time this runs).
 */
async function postReport(
  config: Config,
  deps: DreamRunDeps,
  outcome: DreamRunOutcome,
  logger: Logger,
): Promise<void> {
  const channelId = config.dream.channel_id.trim();
  if (!channelId) return;
  const text = renderReportLine(outcome);
  if (!text) return;
  try {
    await (deps.postShare ?? defaultSharePost(deps.paths))(channelId, text);
    outcome.shared = text;
  } catch (err) {
    logger.warn("dream: report not posted", { date: outcome.date, error: String(err) });
  }
}

/** How much of one planned memory's description the Discord line will quote — long enough to say
 *  WHAT and WHY, short enough that a handful of them still reads as one line, not a digest. */
const REPORT_ITEM_MAX_CHARS = 70;

/**
 * The ceiling on the WHOLE line, not just each item. Three accepted memories at the per-item cap
 * used to compose a 249-character paragraph — a digest, which is the one thing this line must not
 * become. The joined why-clause is cut here, once, after everything is assembled.
 */
const REPORT_LINE_MAX_CHARS = 180;

/** Strip the punctuation a model habitually ends a one-liner with — "…on fridays." / "…, right?" */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[\s.,;:!?…]+$/u, "");
}

/** One item, lowercased, de-punctuated, and cut to {@link REPORT_ITEM_MAX_CHARS}. */
function briefly(text: string): string {
  const t = stripTrailingPunctuation(trimLine(text).toLowerCase());
  return t.length > REPORT_ITEM_MAX_CHARS ? `${stripTrailingPunctuation(t.slice(0, REPORT_ITEM_MAX_CHARS - 1))}…` : t;
}

/** Cut the assembled line to {@link REPORT_LINE_MAX_CHARS}, ellipsis included in the budget. */
function capLine(line: string): string {
  if (line.length <= REPORT_LINE_MAX_CHARS) return line;
  return `${stripTrailingPunctuation(line.slice(0, REPORT_LINE_MAX_CHARS - 1))}…`;
}

/**
 * One lowercase, no-trailing-period, length-capped line — Beckett's voice, never a transcript
 * dump. Built from `memoriesPlanned`'s own already-short, already-accepted `description`s
 * (structured, validated data this code itself accepted into the plan) — never from the model's
 * raw reply — so a transcript line, a session id, or tool output can never ride this path into
 * Discord. Because those descriptions come from a model, EVERY branch here lowercases, strips
 * trailing punctuation, and caps: the shape of the line is this function's promise, not the
 * model's manners.
 *
 * Adds, updates and flags are reported as a SPLIT rather than one number — "kept 2, updated 1,
 * flagged 1" says three different things happened to memory, which one blended count hides.
 */
export function renderReportLine(outcome: DreamRunOutcome): string {
  if (outcome.quiet) return "dreamed through last night's sessions — nothing new worth keeping";
  // "channels" means CONVERSATIONS. On a night whose only material was worker journals and
  // dispatch rows there were none, and "0 channels" would be both odd and misleading — say what
  // was actually read instead.
  const sources = outcome.sourcesReviewed ?? outcome.sessionsReviewed;
  const channels =
    outcome.sessionsReviewed > 0
      ? `${outcome.sessionsReviewed} channel${outcome.sessionsReviewed === 1 ? "" : "s"}`
      : `${sources} log${sources === 1 ? "" : "s"}`;
  const counts: string[] = [];
  const n = outcome.memoriesWritten.length;
  const updated = outcome.memoriesUpdated?.length ?? 0;
  const retired = outcome.memoriesRetired?.length ?? 0;
  const flagged = outcome.flagsWritten?.length ?? 0;
  if (n) counts.push(`kept ${n} note${n === 1 ? "" : "s"}`);
  if (updated) counts.push(`updated ${updated}`);
  if (retired) counts.push(`retired ${retired}`);
  if (flagged) counts.push(`flagged ${flagged} as stale`);
  if (!counts.length) {
    return `reviewed ${channels} from yesterday — nothing durable enough to keep`;
  }
  const bits = [
    ...(outcome.memoriesPlanned ?? []).map((m) => briefly(m.description)),
    ...(outcome.maintenancePlanned ?? []).map((m) => briefly(m.description)),
  ].filter(Boolean);
  const why = bits.length ? `: ${bits.join("; ")}` : "";
  return capLine(stripTrailingPunctuation(`dreamed on ${channels} from yesterday, ${counts.join(", ")}${why}`));
}

// ── the ledger ─────────────────────────────────────────────────────────────────────────

/** Put one finished pass on the spend ledger, mirroring `recordFreeTimeSpend` in `../freetime/run.ts`. */
function recordDreamSpend(deps: DreamRunDeps, run: { outputTokens: number; durationMs: number; outcome: SpendOutcome }): void {
  try {
    appendSpendRecord(deps.paths.spend, {
      ticketId: DREAM_SPEND_TICKET_ID,
      project: null,
      stage: "dream",
      harness: "claude",
      model: dreamModel(deps.config),
      effort: "",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: run.outputTokens,
      costUsd: null,
      durationMs: run.durationMs,
      outcome: run.outcome,
      reviewTier: "self",
      ts: new Date().toISOString(),
      sessionId: `dream-${deps.now?.().toISOString() ?? new Date().toISOString()}`,
    });
  } catch (err) {
    deps.logger.warn("dream: spend ledger append failed", { error: String(err) });
  }
}

/** The model a pass runs on: its own dial, or the concierge's default when that is unset. */
export function dreamModel(config: Config): string {
  return config.dream.model.trim() || config.concierge.model;
}

// ── prompts ────────────────────────────────────────────────────────────────────────────

function synthesisPrompt(
  inputs: DreamInputs,
  date: string,
  memoriesMax: number,
  prunesMax: number,
  census: DreamMemoryCensus,
): string {
  const sections = inputs.sections
    .filter((s) => s.text.trim())
    .map((s) => `### ${s.kind}:${s.channelId}${s.channelName ? ` (${s.channelName})` : ""}\n${s.text}`)
    .join("\n\n");
  const list = (nodes: CensusNode[]): string =>
    nodes.length ? nodes.map((n) => `- ${n.name}: ${n.description}`).join("\n") : "(none)";
  return [
    `You are Beckett, privately reviewing the day's sessions (${date}) before they age out of`,
    "context — the nightly short-term-to-long-term memory pass. Nobody reads this reply directly;",
    "it is parsed as JSON and only what you put in \"memories\" ever reaches long-term memory.",
    "",
    "You have no tools and must not invent anything not present below. Every line of every",
    "source below carries a stable id in brackets — channel:<channelId>:<messageId> for a",
    "Discord message, journal:<ticket>:<line> for a worker journal line, and",
    "dispatch:<runId>:<n> for a dispatch-ledger row. Those ids are the ONLY provenance",
    "vocabulary that exists tonight.",
    "",
    "Be conservative. The point is a middle ground between remembering nothing and remembering",
    "everything: a store full of 'what did you eat' noise buries the five facts that matter and",
    "recall gets dumber. Only propose a memory for a DECISION, a stated PREFERENCE, a PROJECT",
    "STATE CHANGE, a CORRECTION, or something someone said once that will still be true next",
    "week. Never propose one for banter, per-task chatter, or a fact the repo/code already",
    `records. Most nights should propose 0–${Math.min(memoriesMax, 2)}; the hard cap tonight is`,
    `${memoriesMax} and anything past it is dropped unread.`,
    "",
    "Tonight you may also MAINTAIN what past passes wrote, not only add to it. You can rewrite",
    "or retire one of your own dream nodes when today's sessions superseded it, and you can FLAG",
    "a non-dream memory that today's sessions contradict — a flag is a note for a human, never an",
    `edit to their fact. At most ${prunesMax} maintenance ops tonight; anything past that is dropped.`,
    "",
    "Return ONLY a JSON object (no fences, no prose) with these keys:",
    '  "summary":   markdown — a few tight lines for your own private journal, not for anyone else',
    '  "memories":  array (0-' + String(memoriesMax) + ' entries) of durable inferences worth',
    '               keeping past today. Each: {"slug": kebab-case, "description": one line,',
    '               "note": short markdown body (optional), "provenance": array of the EXACT',
    "               source ids above that this inference is actually derived from — never invent",
    "               an id, never leave this empty}.",
    '  "maintenance": array (0-' + String(prunesMax) + ' entries). Each:',
    '               {"op": "update" | "retire" | "flag", "target": an EXACT node name from the',
    '               lists below, "description": the replacement one-liner (update) or the reason',
    '               it looks stale (flag) or why it is being retired, "note": optional markdown,',
    '               "provenance": the same rule as above, required}. "update"/"retire" may only',
    '               name a dream node; "flag" may only name a node from the other list.',
    "",
    "# your existing dream nodes (update / retire targets)",
    "",
    list(census.dreams),
    "",
    "# other memories (flag targets — never edited, only flagged)",
    "",
    list(census.others),
    "",
    "# the day's sessions",
    "",
    sections,
  ].join("\n");
}

function parseSynthesis(raw: string): DreamSynthesis | null {
  try {
    const parsed = JSON.parse(extractVerdictJson(raw));
    const checked = DreamSynthesisSchema.safeParse(parsed);
    return checked.success ? checked.data : null;
  } catch {
    return null;
  }
}

// ── default dependencies ───────────────────────────────────────────────────────────────

function dreamEntryGuard(dreamsDir: string, date: string): void {
  const path = dreamEntryPath(dreamsDir, date);
  if (existsSync(path)) {
    throw new Error(`dream: entry for ${date} already exists (${path}); re-run with --force to replace it`);
  }
}

function defaultMemory(paths: Paths, logger: Logger): MemoryStore | null {
  try {
    return createMemory({ memoryDir: paths.memoryDir, logger: logger.child("memory") });
  } catch (err) {
    logger.warn("dream: memory store unavailable", { error: String(err) });
    return null;
  }
}

function defaultChannels(config: Config, paths: Paths, logger: Logger): ChannelContextStore | null {
  try {
    return createChannelContextStore({
      channelsDir: paths.channelsDir,
      maxEntriesPerChannel: config.shared_context.max_entries_per_channel,
      maxAgeHours: config.shared_context.max_age_hours,
      logger: logger.child("channels"),
    });
  } catch (err) {
    logger.warn("dream: channel store unavailable", { error: String(err) });
    return null;
  }
}

/** The default model seam: a tool-less one-shot `claude -p`, usage read from its JSON result. */
export function defaultDreamModelCall(config: Config, logger: Logger): DreamModelCall {
  const bin = config.harness.claude.bin;
  const model = dreamModel(config);
  const timeoutMs = config.dream.hard_timeout_s * 1_000;
  // A scratch cwd (not the repo, not $HOME) so even an allowed relative read has nothing to see.
  const cwd = join(tmpdir(), "beckett-dream");
  return async (prompt: string): Promise<DreamModelResult> => {
    mkdirSync(cwd, { recursive: true });
    const proc = Bun.spawn(
      [bin, "-p", prompt, "--model", model, "--output-format", "json", "--disallowedTools", DREAM_DISALLOWED_TOOLS],
      { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv() },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (timedOut) throw new Error(`dream model call timed out after ${config.dream.hard_timeout_s}s`);
      if (code !== 0) throw new Error(`dream model call exited ${code}: ${stderr.trim().slice(0, 400)}`);
      return parseModelResult(stdout, logger);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The share's default road out: ONE `discord.reply` on the control bus, same as free time's. */
function defaultSharePost(paths: Paths): DreamSharePost {
  return async (channelId, text) => {
    await callBus(join(paths.beckettDir, "control.sock"), "discord.reply", { channelId, text }, 30_000);
  };
}

function trimLine(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
