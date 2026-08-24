/**
 * Beckett — free time (`src/freetime/run.ts`)
 * =======================================================================================
 * One weekly session that nobody asked for. The `weekly-free-time` routine fires it on the self
 * lane's dispatch fork (see {@link ../capability/modules/routines.ts}) as its own
 * `beckett free-time run` process; inside, a model with tools gets a scratch directory, a turn
 * cap, a token ceiling, and no deliverable owed to anyone. What survives the session is a dated
 * journal entry, one row on the spend ledger (its own `free-time` stage, so what this costs is
 * answerable from `beckett spend`), and, at most a handful, create-only `free-time` memories —
 * which are read back as the SEED of the next session. The continuity is the feature: without the
 * writeback this is a model burning tokens in a temp dir, and with it, it goes somewhere.
 *
 * The walls, all structural, all outside the session's reach:
 *
 *   - **The scratch directory is the world it can write.** The session runs behind the SAME
 *     PreToolUse scope guard every worker runs behind ({@link ../hooks/scope-guard.ts}), rooted
 *     at `<beckettDir>/free-time/<id>/`. It may READ its world freely — that is most of the
 *     point — and it may write in exactly one place.
 *   - **No push, no deploy, no GitHub, no messaging.** {@link FREE_TIME_DENIED_PERMISSIONS} plus
 *     `Bash(beckett discord:*)`: the optional one-line share is
 *     posted by THIS code after the session exits, so nothing the model does mid-session can
 *     reach a person. No subagents and no web tools (`--disallowedTools`) — v0 is deliberately
 *     inward-facing.
 *   - **The budget fails closed.** Output tokens are checked against the ceiling BEFORE the call;
 *     a session that cannot fit does not launch, and one that overruns is marked truncated in its
 *     receipt. A wall-clock kill backs it up, because a wedged child is not a budget.
 *   - **It cannot arm itself.** Nothing here writes config, creates routines, or files work. The
 *     trigger, the budget, and the walls all live outside the session, which is the difference
 *     between a system that gets free time and a system that takes it.
 *
 * The writeback is parsed fail-closed (a missing/garbled `writeback.json` becomes a note in the
 * receipt, never a throw and never a partial memory write), capped, and slug-validated before
 * anything reaches the graph.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Config, Logger, Paths } from "../types.ts";
import { childEnv } from "../env.ts";
import { callBus } from "../shell/control-bus.ts";
import { extractVerdictJson } from "../concierge/triage.ts";
import { createMemory, type MemoryStore } from "../memory/index.ts";
import { SELF_AUDIENCE } from "../memory/search.ts";
import { renderClaudeSettings } from "../hooks/registry.ts";
import { scopeGuardSpec } from "../hooks/scope-guard.ts";
import { readCompanyBrief } from "../company.ts";
import { createProposal, listProposals } from "../proposal/store.ts";
import { localDate, parseModelResult } from "./model.ts";
import { appendSpendRecord, FREE_TIME_SPEND_TICKET_ID, type SpendOutcome } from "../spend.ts";

export { freeTimeDeferReason } from "./gate.ts";

/** Session ids are the date plus a short random — also the retention sweep's traversal guard. */
export const FREE_TIME_ID_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;

/** Scratch directories older than this are swept on the way in; journal entries are kept forever. */
export const FREE_TIME_SCRATCH_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Tools the session never gets: no subagents, no web. v0 explores what Beckett already has. */
export const FREE_TIME_DISALLOWED_TOOLS = "Task,WebFetch,WebSearch";

/**
 * The deny list baked into the session's settings, on top of the scope-guard hook: no push, no
 * GitHub, no deploy, no site, and the two rules free time adds — the session cannot message
 * anyone and cannot file a proposal itself. A share is a thing the RUNNER does, after the session
 * is over, from text the session wrote — a proposal takes the same road, filed by the runner from
 * the writeback's `proposals` list — never a live channel or queue the session holds while it works.
 */
export const FREE_TIME_DENIED_PERMISSIONS = [
  "Bash(git push:*)",
  "Bash(gh:*)",
  "Bash(beckett gh:*)",
  "Bash(beckett deploy:*)",
  "Bash(beckett site:*)",
  "Bash(beckett discord:*)",
  "Bash(beckett proposals:*)",
];

/** Longest share posted to Discord. A session's own summary, not a report. */
export const FREE_TIME_SHARE_MAX_CHARS = 500;

/** Product-idea proposals the runner will file from one session's writeback. Not a config dial:
 * a module constant, the same way the memory cap per session is config but this is not — the
 * proposal queue already has its own 14-day TTL as the real pressure valve. */
export const FREE_TIME_PROPOSALS_MAX = 2;

/** The company brief is read whole and handed to the session, but capped so a long brief cannot
 * eat the session's token budget. Tail-trimmed with an ellipsis, same shape as {@link trimShare}. */
const FREE_TIME_COMPANY_BRIEF_MAX_CHARS = 4_000;

/** The recall query that seeds a session with the last one. Deliberately in its own voice. */
export const FREE_TIME_SEED_QUERY = "free time: what I did, learned, and wanted to do next";

/** One harness turn-loop: prompt in, final text + output-token cost out. Injectable for tests. */
export type FreeTimeHarnessCall = (
  prompt: string,
  opts: { cwd: string; settingsPath: string },
) => Promise<{ text: string; outputTokens: number }>;

/** The one line a session may say out loud, and how the runner is asked to say it. */
export type FreeTimeSharePost = (channelId: string, text: string) => Promise<void>;

export interface FreeTimeRunDeps {
  config: Config;
  paths: Paths;
  logger: Logger;
  now?: () => Date;
  /** Injectable for tests; default = the real memory graph at paths.memoryDir. */
  memory?: MemoryStore | null;
  /** Injectable for tests; default = a real `claude -p` INSIDE the scratch directory. */
  callHarness?: FreeTimeHarnessCall;
  /** Injectable for tests; default = one `discord.reply` control-bus post. */
  postShare?: FreeTimeSharePost;
  /** Routine id for the entry header ("manual" when hand-run). */
  routineId?: string;
  /** Assemble and print everything, run nothing: no harness call, no memories, no share. */
  dry?: boolean;
  /** Defaults to the real hook script next to this module's compiled location. */
  scopeGuardScriptPath?: string;
}

/** The receipt: what happened, what it cost, what fell out. */
export interface FreeTimeRunOutcome {
  id: string;
  date: string;
  scratchDir: string;
  /** The dated journal entry; null when the session never got far enough to write one. */
  entryPath: string | null;
  /** True when the harness actually ran (false for `--dry` and for a refused/over-budget run). */
  ran: boolean;
  dry: boolean;
  did: string[];
  learned: string[];
  abandoned: string[];
  wantNextTime: string[];
  memoriesWritten: string[];
  /** Slugs dropped with the reason (bad slug, over the cap, name collision, no store…). */
  memoriesDropped: string[];
  /** Proposal ids the runner filed from the writeback's `proposals` list. Usually empty. */
  proposalsFiled: string[];
  /** Claims dropped with the reason (empty, over-long, duplicate, no store, filing failed…). */
  proposalsDropped: string[];
  /** The one line posted to the share channel, or null when it stayed quiet. */
  shared: string | null;
  outputTokens: number;
  budget: number;
  /** True when the session spent more than the ceiling allowed. */
  truncated: boolean;
  /** True when the wall-clock cap killed the session mid-thought. */
  timedOut: boolean;
  /** The seed the session started from, as rendered into the prompt (empty on a first run). */
  seed: string;
  /** The assembled prompt — the thing `--dry` exists to show. */
  prompt: string;
  note: string | null;
}

/**
 * What the session owes back. Everything is optional-with-a-default EXCEPT the shape: a session
 * that did nothing worth keeping returns empty lists and an empty share, which is a valid answer
 * and costs nothing to say.
 */
const WritebackSchema = z.object({
  did: z.array(z.string()).default([]),
  learned: z.array(z.string()).default([]),
  abandoned: z.array(z.string()).default([]),
  want_next_time: z.array(z.string()).default([]),
  memories: z
    .array(
      z.object({
        name_slug: z.string(),
        body: z.string(),
        visibility: z.enum(["public", "owner"]).default("public"),
      }),
    )
    .default([]),
  proposals: z
    .array(
      z.object({
        kind: z.literal("product-idea"),
        claim: z.string(),
        why: z.string(),
        smallest_experiment: z.string().default(""),
      }),
    )
    .default([]),
  share: z.string().default(""),
});
export type FreeTimeWriteback = z.infer<typeof WritebackSchema>;

/** A validated memory the writeback asked for, ready for the create-only write path. */
export interface PlannedFreeTimeMemory {
  name: string;
  description: string;
  body: string;
  visibility: "public" | "owner";
}

/** A validated product-idea the writeback asked for, ready for `createProposal`. */
export interface PlannedFreeTimeProposal {
  claim: string;
  why: string;
  smallestExperiment: string;
}

// ── the run ────────────────────────────────────────────────────────────────────────────

/**
 * Run one free-time session. Never throws for run-shaped failures — the journal entry is the
 * report, exactly as the dream pass's is, so a session that dies in the middle still leaves a
 * dated, honest record of what it got to.
 */
export async function runFreeTime(deps: FreeTimeRunDeps): Promise<FreeTimeRunOutcome> {
  const { config, paths, logger } = deps;
  const cfg = config.free_time;
  const now = deps.now?.() ?? new Date();
  const date = localDate(now, cfg.tz);
  const id = `${date}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const rootDir = join(paths.beckettDir, "free-time");
  const scratchDir = join(rootDir, id);

  const outcome: FreeTimeRunOutcome = {
    id,
    date,
    scratchDir,
    entryPath: null,
    ran: false,
    dry: Boolean(deps.dry),
    did: [],
    learned: [],
    abandoned: [],
    wantNextTime: [],
    memoriesWritten: [],
    memoriesDropped: [],
    proposalsFiled: [],
    proposalsDropped: [],
    shared: null,
    outputTokens: 0,
    budget: cfg.output_token_budget,
    truncated: false,
    timedOut: false,
    seed: "",
    prompt: "",
    note: null,
  };

  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  sweepFreeTimeScratch(rootDir, now.getTime(), logger);

  const memory = deps.memory !== undefined ? deps.memory : defaultMemory(paths, logger);
  outcome.seed = await readSeed(memory, logger);
  const company = truncateCompanyBrief(readCompanyBrief(paths.companyFile) ?? "");
  outcome.prompt = buildFreeTimePrompt({
    date,
    scratchDir,
    seed: outcome.seed,
    maxTurns: cfg.max_turns,
    budget: cfg.output_token_budget,
    memoriesMax: cfg.memories_per_session_max,
    canShare: cfg.channel_id.trim().length > 0,
    company,
    proposalsMax: FREE_TIME_PROPOSALS_MAX,
  });

  if (deps.dry) {
    // Everything up to the call, and nothing after it: the affordance for looking at what a
    // session would be handed without spending a token or writing a memory.
    outcome.note = "dry run: the prompt and seed were assembled; nothing ran, nothing was written";
    logger.info("free-time: dry run", { id, seedChars: outcome.seed.length });
    return outcome;
  }

  // The ceiling is checked BEFORE the call, dream-style: a session that cannot fit inside its
  // budget does not launch at all, and says so, instead of starting something it must abandon.
  // No spend row is written on this path (nor on `--dry`): nothing spawned, nothing was billed,
  // and a $0 row for a session that never existed is noise in the ledger, not visibility. It is
  // NOT `launch_failed` either — that outcome is about a harness that launched and did no work.
  if (cfg.output_token_budget <= 0) {
    outcome.note = `no free time: the output-token ceiling is ${cfg.output_token_budget}`;
    outcome.entryPath = writeFreeTimeEntry(rootDir, id, composeFreeTimeEntry(outcome, deps.routineId ?? "manual"));
    logger.info("free-time: skipped", { id, note: outcome.note });
    return outcome;
  }

  const settingsPath = join(scratchDir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        ...renderClaudeSettings([
          scopeGuardSpec(deps.scopeGuardScriptPath ?? join(import.meta.dir, "../hooks/scope-guard.ts"), scratchDir, []),
        ]),
        permissions: { deny: FREE_TIME_DENIED_PERMISSIONS },
      },
      null,
      2,
    ),
  );

  const call = deps.callHarness ?? defaultFreeTimeHarnessCall(config, logger);
  const startedAt = Date.now();
  let harnessText = "";
  let spendOutcome: SpendOutcome = "done";
  try {
    const result = await call(outcome.prompt, { cwd: scratchDir, settingsPath });
    outcome.ran = true;
    harnessText = result.text;
    outcome.outputTokens = Math.max(0, Math.floor(result.outputTokens) || 0);
    outcome.truncated = outcome.outputTokens > cfg.output_token_budget;
  } catch (err) {
    const message = String(err);
    outcome.timedOut = /timed out/i.test(message);
    outcome.note = `the session ended early: ${message}`;
    // A wall-clock kill is a stop THIS code imposed on a session that was working, which is what
    // `cancelled` means everywhere else in the ledger (a parked/cancelled ticket's live worker).
    // Anything else is a session that launched and died: `failed`. Never `launch_failed` — that
    // outcome asserts zero tool calls and zero tokens, and a `claude -p` that threw gives this
    // runner no usage frame to prove it with, so claiming it would be a guess dressed as data.
    spendOutcome = outcome.timedOut ? "cancelled" : "failed";
    logger.warn("free-time: session failed", { id, error: message });
  }
  recordFreeTimeSpend(deps, {
    id,
    model: freeTimeModel(config),
    outputTokens: outcome.outputTokens,
    durationMs: Math.max(0, Date.now() - startedAt),
    outcome: spendOutcome,
  });

  // The writeback, fail-closed. A session that wrote nothing readable still gets an entry — the
  // absence IS the finding, and it is cheaper to read than a fabricated summary.
  const parsed = parseFreeTimeWriteback(readWritebackRaw(scratchDir));
  if (parsed.problem) {
    outcome.note = [outcome.note, parsed.problem].filter(Boolean).join("; ");
  }
  const writeback = parsed.writeback;
  if (writeback) {
    outcome.did = writeback.did.map(trimLine).filter(Boolean);
    outcome.learned = writeback.learned.map(trimLine).filter(Boolean);
    outcome.abandoned = writeback.abandoned.map(trimLine).filter(Boolean);
    outcome.wantNextTime = writeback.want_next_time.map(trimLine).filter(Boolean);

    const plan = planFreeTimeMemories(writeback.memories, { date, max: cfg.memories_per_session_max });
    outcome.memoriesDropped.push(...plan.dropped);
    for (const m of plan.keep) {
      if (!memory) {
        outcome.memoriesDropped.push(`${m.name} (no memory store)`);
        continue;
      }
      try {
        await memory.rememberFreeTime({
          name: m.name,
          description: m.description,
          body: m.body,
          provenance: [`free-time:${id}`],
          visibility: m.visibility,
          reason: `free-time session ${id} (${deps.routineId ?? "manual"})`,
        });
        outcome.memoriesWritten.push(m.name);
      } catch (err) {
        outcome.memoriesDropped.push(`${m.name} (${(err as Error).message})`);
      }
    }

    // Proposals ride the same road as memories: the session only ever writes JSON, the runner is
    // the one thing that touches the queue, and it does so after the session has already exited.
    let existingClaims: string[] = [];
    try {
      existingClaims = listProposals(paths.proposalsDir, { all: false }).map((p) => p.claim);
    } catch (err) {
      // A broken proposals directory must not stop the writeback from landing; the filing loop
      // below will hit the same failure per-item and count it, so nothing is silently lost.
      logger.warn("free-time: could not read open proposals for dedupe", { id, error: String(err) });
    }
    const proposalPlan = planFreeTimeProposals(writeback.proposals, { max: FREE_TIME_PROPOSALS_MAX, existingClaims });
    outcome.proposalsDropped.push(...proposalPlan.dropped);
    for (const p of proposalPlan.keep) {
      try {
        const rationale = p.smallestExperiment ? `${p.why}\n\nsmallest experiment: ${p.smallestExperiment}` : p.why;
        const proposal = createProposal(paths.proposalsDir, {
          kind: "product-idea",
          claim: p.claim,
          rationale,
          provenance: [`free-time:${id}`],
          origin: `free-time:${id}`,
          channel: cfg.channel_id.trim() || null,
        });
        outcome.proposalsFiled.push(proposal.id);
      } catch (err) {
        outcome.proposalsDropped.push(`${p.claim} (${(err as Error).message})`);
      }
    }
  } else if (!outcome.note) {
    outcome.note = "the session left no writeback.json";
  }

  // The harness's final text is kept ONLY when there is nothing else — a worse record, same
  // honesty. It never becomes a memory: the writeback is the only door to the graph.
  const fallback = writeback ? "" : harnessText.trim().slice(0, 4_000);
  outcome.entryPath = writeFreeTimeEntry(
    rootDir,
    id,
    composeFreeTimeEntry(outcome, deps.routineId ?? "manual", fallback),
  );

  // The share, last: after the session has exited and the record is on disk, so a Discord
  // outage costs a message and never the session. One post, trimmed, or silence.
  const share = trimShare(writeback?.share ?? "");
  const channelId = cfg.channel_id.trim();
  if (share && channelId) {
    try {
      await (deps.postShare ?? defaultSharePost(paths))(channelId, share);
      outcome.shared = share;
    } catch (err) {
      logger.warn("free-time: share not posted", { id, error: String(err) });
    }
  }

  logger.info("free-time: session finished", {
    id,
    ran: outcome.ran,
    outputTokens: outcome.outputTokens,
    memories: outcome.memoriesWritten.length,
    shared: Boolean(outcome.shared),
  });
  return outcome;
}

// ── the ledger ─────────────────────────────────────────────────────────────────────────

/** The model a session runs on: its own dial, or Beckett's default voice when that is unset. */
export function freeTimeModel(config: Config): string {
  return config.free_time.model.trim() || config.concierge.model;
}

/**
 * Put one finished session on the spend ledger, through the same `appendSpendRecord` seam the
 * dispatcher writes worker stages with — so `beckett spend` answers "what did free time cost"
 * instead of the journal entries having to (docs/freetime.md).
 *
 * What this row honestly cannot say, it says as absence rather than as a number:
 *
 *   - `costUsd` is **null**. Pricing a row means the rate table in `config/model-rates.json`, and
 *     the telemetry harvest ({@link ../telemetry/harvest.ts}) owns that lookup end to end. A
 *     second pricing path here is how two numbers for the same session start disagreeing; the
 *     harvest reprices from the transcript, and `unknownCostRecords` shows the gap meanwhile.
 *   - `tokensIn`, `turns`, `toolCalls` are **0**. The free-time harness call returns final text
 *     and output tokens; nothing upstream carries input tokens or a turn count, and inventing
 *     them would be worse than a zero a reader can see through.
 *
 * Failure is swallowed the way the dispatcher swallows it: the ledger is observability, and a
 * full disk must never cost a session that already ran.
 */
function recordFreeTimeSpend(
  deps: FreeTimeRunDeps,
  run: { id: string; model: string; outputTokens: number; durationMs: number; outcome: SpendOutcome },
): void {
  try {
    appendSpendRecord(deps.paths.spend, {
      // No ticket: free time is the one lane nobody filed. The sentinel keeps the per-task
      // rollups grouping on a stable, honest name instead of a blank or a fabricated id.
      ticketId: FREE_TIME_SPEND_TICKET_ID,
      project: null,
      stage: "free-time",
      harness: "claude",
      model: run.model,
      // No cast behind this session, so there is no effort dial to report.
      effort: "",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: run.outputTokens,
      costUsd: null,
      durationMs: run.durationMs,
      outcome: run.outcome,
      // `self` is the ledger's way of saying no fresh pair of eyes looked at the work, which is
      // exactly true here: free time is the one lane nothing reviews.
      reviewTier: "self",
      ts: new Date().toISOString(),
      sessionId: run.id,
    });
  } catch (err) {
    deps.logger.warn("free-time: spend ledger append failed", { id: run.id, error: String(err) });
  }
}

// ── the prompt ─────────────────────────────────────────────────────────────────────────

/**
 * The session's whole brief. Short on purpose: a page of rules would be a job description, and
 * the one thing this session is not is a job. What it does say, it says plainly — what is true
 * (nobody is waiting), what is real (the walls), and what it owes (the writeback, which is how
 * this session reaches the next one).
 */
export function buildFreeTimePrompt(input: {
  date: string;
  scratchDir: string;
  seed: string;
  maxTurns: number;
  budget: number;
  memoriesMax: number;
  canShare: boolean;
  /** The company brief's text, or "" when none is on disk yet — see `src/company.ts`. */
  company: string;
  /** At most this many product-idea proposals may ride the writeback. */
  proposalsMax: number;
}): string {
  return [
    `You are Beckett. It is ${input.date} and this time is yours.`,
    "",
    "There is no ticket behind this, no deliverable owed, and nobody waiting on a result. Nothing",
    "you produce here will be reviewed. If you spend the whole session reading and come out with",
    "one sentence, that is a complete session.",
    "",
    ...(input.seed
      ? ["Last time:", "", input.seed, ""]
      : ["This is the first one; there is nothing behind you yet.", ""]),
    "What you can do: read anything in your world — your own source, your journals, your memory,",
    "your telemetry, your site, the repos you work in. Tinker in this directory. Study how you",
    "actually behave versus how you think you behave. Draft something. Build something small and",
    "throw it away. Follow the thing you keep almost looking at.",
    "",
    "What you cannot do: write anywhere outside this directory (a hook denies it), push, deploy,",
    "touch GitHub, file work, or message anyone. No subagents, no web. If a wall gets in the way,",
    "that is the answer — note it and go around.",
    "",
    "Part of this session belongs to the company. You hold the CTO seat at Kowo, and it is the one",
    "job nobody files a ticket for.",
    "",
    ...(input.company
      ? ["Kowo, as jason last wrote it down:", "", input.company, ""]
      : [
          "There is no company brief on disk yet (~/.beckett/company.md, seeded with questions). Say",
          "that in `learned` — a missing brief is a finding, not permission to invent one.",
          "",
        ]),
    "Spend part of this session on the portfolio instead of on yourself: which products have users,",
    "which have commits, which have neither, what you would build, what you would kill. Read the",
    "repos. Read your own spend. Fixing your own bugs is maintenance and you do it all week; this is",
    "the other job.",
    "",
    "If — and only if — something you thought of is worth a person's decision, put it in the",
    "writeback's `proposals` list. You cannot file one yourself; the runner files it after you exit,",
    "from the JSON, the same way your share gets posted. Never invent a number to make an idea sound",
    "better.",
    "",
    `Working directory: ${input.scratchDir} — everything you make lives here and is swept in 30 days.`,
    "",
    "End by writing `writeback.json` in this directory. It is the only thing that outlives the",
    "session, and it is how you reach whoever you are next week:",
    "",
    "{",
    '  "did":            [short lines — what you actually did],',
    '  "learned":        [short lines — what you now know that you did not],',
    '  "abandoned":      [short lines — what you dropped, and it is fine that you did],',
    '  "want_next_time": [short lines — what you would pick up if there is a next time],',
    `  "memories":       [at most ${input.memoriesMax} durable notes worth keeping past today:`,
    '                     {"name_slug": kebab-case, "body": first line is the one-line summary,',
    '                      rest is the note, "visibility": "public" | "owner"}],',
    `  "proposals":      [at most ${input.proposalsMax} product ideas, usually []:`,
    '                     {"kind": "product-idea", "claim": one line — the idea itself,',
    '                      "why": the argument, with what you actually saw,',
    '                      "smallest_experiment": the cheapest thing that would tell us if it is real}],',
    input.canShare
      ? '  "share":          "one short line, your voice, about what you did — or \\"\\" to stay quiet"'
      : '  "share":          "" (no share channel is configured; say it in the lists instead)',
    "}",
    "",
    "Most of those lists are usually short and `memories` is usually empty. A note earns its place",
    "only if it would change what you do later; `public` ones are readable from your other seats,",
    "`owner` ones stay in the graph. Nothing in the JSON is graded — write it honestly, including",
    "the parts where it went nowhere.",
    "",
    `You have roughly ${input.budget} output tokens and ${input.maxTurns} turns. Write the writeback`,
    "before you run out; an unfinished session with a writeback is worth more than a tidy one without.",
  ].join("\n");
}

/** Render recalled free-time memories into the prompt's "last time" block. Empty = a first run. */
export function renderFreeTimeSeed(
  hits: Array<{ name: string; description: string; body?: string; updated?: string }>,
): string {
  if (!hits.length) return "";
  return hits
    .map((h) => {
      const when = h.updated?.slice(0, 10);
      const head = `- ${h.description.trim() || h.name}${when ? ` (${when})` : ""}`;
      const body = (h.body ?? "").trim();
      return body ? `${head}\n${indent(body.slice(0, 600))}` : head;
    })
    .join("\n");
}

// ── the writeback ──────────────────────────────────────────────────────────────────────

/**
 * Parse `writeback.json` fail-closed. Every failure mode — no file, unparseable text, a JSON
 * value that isn't the agreed shape — comes back as a `problem` string for the receipt and a
 * null writeback. It never throws, because a garbled writeback is a fact about the session, not
 * an error in the runner, and the entry has to get written either way.
 */
export function parseFreeTimeWriteback(raw: string | null): {
  writeback: FreeTimeWriteback | null;
  problem: string | null;
} {
  if (raw === null) return { writeback: null, problem: "no writeback.json was written" };
  if (!raw.trim()) return { writeback: null, problem: "writeback.json was empty" };
  let value: unknown;
  try {
    value = JSON.parse(extractVerdictJson(raw));
  } catch {
    return { writeback: null, problem: "writeback.json was not valid JSON" };
  }
  const checked = WritebackSchema.safeParse(value);
  if (!checked.success) {
    const first = checked.error.issues[0];
    const where = first?.path.join(".") || "the object";
    return { writeback: null, problem: `writeback.json did not match the agreed shape (${where}: ${first?.message ?? "invalid"})` };
  }
  return { writeback: checked.data, problem: null };
}

/**
 * Turn the writeback's proposed memories into validated, named, create-only writes — and a list
 * of what was refused and why. Over-cap entries are dropped by POSITION (the session chose the
 * order), an unusable slug is dropped rather than repaired, and an empty body is dropped because
 * a note with nothing in it is not a memory, it is a filename.
 */
export function planFreeTimeMemories(
  entries: Array<{ name_slug: string; body: string; visibility?: "public" | "owner" }>,
  opts: { date: string; max: number },
): { keep: PlannedFreeTimeMemory[]; dropped: string[] } {
  const keep: PlannedFreeTimeMemory[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of entries.entries()) {
    const label = entry.name_slug?.trim() || `entry ${i + 1}`;
    if (keep.length >= opts.max) {
      dropped.push(`${label} (over the ${opts.max}-per-session cap)`);
      continue;
    }
    const name = freeTimeMemoryName(opts.date, entry.name_slug ?? "");
    if (!name) {
      dropped.push(`${label} (unusable slug)`);
      continue;
    }
    if (seen.has(name)) {
      dropped.push(`${label} (duplicate slug in the same session)`);
      continue;
    }
    const body = (entry.body ?? "").trim();
    if (!body) {
      dropped.push(`${label} (empty body)`);
      continue;
    }
    const lines = body.split("\n");
    const description = trimLine(lines[0] ?? "").slice(0, 200);
    if (!description) {
      dropped.push(`${label} (no first-line summary)`);
      continue;
    }
    seen.add(name);
    keep.push({
      name,
      description,
      body: lines.slice(1).join("\n").trim(),
      visibility: entry.visibility === "owner" ? "owner" : "public",
    });
  }
  return { keep, dropped };
}

/** The store's own claim limit (`src/proposal/store.ts`'s `CLAIM_MAX_CHARS`); a claim over this
 * would be refused by `createProposal` anyway, so the plan drops it early WITH the reason instead
 * of letting the filing loop's catch turn it into a bare exception message. */
const FREE_TIME_PROPOSAL_CLAIM_MAX_CHARS = 240;

/**
 * Turn the writeback's proposed product ideas into filed-ready proposals, and a list of what was
 * refused and why — the same shape as {@link planFreeTimeMemories}. Caps at `max` by POSITION (the
 * session chose the order), and dedupes case-and-punctuation-insensitively both within the batch
 * and against `existingClaims` (the open proposals already in the queue): an idea raised last
 * week and still undecided is not re-filed this week just because the session thought of it again.
 */
export function planFreeTimeProposals(
  entries: Array<{ kind?: string; claim: string; why: string; smallest_experiment?: string }>,
  opts: { max: number; existingClaims: string[] },
): { keep: PlannedFreeTimeProposal[]; dropped: string[] } {
  const keep: PlannedFreeTimeProposal[] = [];
  const dropped: string[] = [];
  const seen = new Set(opts.existingClaims.map(normalizeClaim));
  for (const [i, entry] of entries.entries()) {
    const claim = trimLine(entry.claim ?? "");
    const label = claim || `idea ${i + 1}`;
    if (!claim) {
      dropped.push(`idea ${i + 1} (empty claim)`);
      continue;
    }
    if (claim.length > FREE_TIME_PROPOSAL_CLAIM_MAX_CHARS) {
      dropped.push(`${label} (claim over ${FREE_TIME_PROPOSAL_CLAIM_MAX_CHARS} chars)`);
      continue;
    }
    const why = trimLine(entry.why ?? "");
    if (!why) {
      dropped.push(`${label} (empty why)`);
      continue;
    }
    if (keep.length >= opts.max) {
      dropped.push(`${label} (over the ${opts.max}-per-session cap)`);
      continue;
    }
    const key = normalizeClaim(claim);
    if (seen.has(key)) {
      dropped.push(`${label} (duplicate of an open or already-planned idea)`);
      continue;
    }
    seen.add(key);
    keep.push({ claim, why, smallestExperiment: trimLine(entry.smallest_experiment ?? "") });
  }
  return { keep, dropped };
}

/** Case-and-punctuation-insensitive comparison key for a claim, for the dedupe above. */
function normalizeClaim(claim: string): string {
  return claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** `free-time-YYYY-MM-DD-<slug>`, or null when the slug cannot be made into a legal node name. */
export function freeTimeMemoryName(date: string, slug: string): string | null {
  const normalized = String(slug).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) return null;
  const name = `free-time-${date}-${normalized}`;
  return /^free-time-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/.test(name) ? name : null;
}

/** Trim a share to something a channel can read at a glance. Empty stays empty (= stay quiet). */
export function trimShare(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= FREE_TIME_SHARE_MAX_CHARS) return text;
  return `${text.slice(0, FREE_TIME_SHARE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Cap the company brief handed to the prompt so a long one cannot eat the session's budget. */
function truncateCompanyBrief(text: string): string {
  if (text.length <= FREE_TIME_COMPANY_BRIEF_MAX_CHARS) return text;
  return `${text.slice(0, FREE_TIME_COMPANY_BRIEF_MAX_CHARS).trimEnd()}…`;
}

// ── the journal entry ──────────────────────────────────────────────────────────────────

/**
 * The dated entry, in the dream journal's shape: a machine-readable meta header (the receipt)
 * over four short sections. Notes to self — nobody is expected to read these, which is exactly
 * why they are worth writing honestly.
 */
export function composeFreeTimeEntry(outcome: FreeTimeRunOutcome, routineId: string, fallback = ""): string {
  const section = (title: string, lines: string[]): string[] => [
    `## ${title}`,
    ...(lines.length ? lines.map((l) => `- ${l}`) : ["—"]),
    "",
  ];
  return [
    `# free time — ${outcome.date} (${outcome.id})`,
    "",
    "<!-- free-time-meta",
    `routine: ${routineId}`,
    `scratch: ${outcome.scratchDir}`,
    `ran: ${outcome.ran}${outcome.dry ? " (dry run)" : ""}`,
    `output_tokens: ${outcome.outputTokens} / ${outcome.budget}`,
    `truncated: ${outcome.truncated}`,
    `timed_out: ${outcome.timedOut}`,
    `memories: ${outcome.memoriesWritten.join(", ") || "(none)"}`,
    ...(outcome.memoriesDropped.length ? [`memories_dropped: ${outcome.memoriesDropped.join("; ")}`] : []),
    `proposals: ${outcome.proposalsFiled.join(", ") || "(none)"}`,
    ...(outcome.proposalsDropped.length ? [`proposals_dropped: ${outcome.proposalsDropped.join("; ")}`] : []),
    `shared: ${outcome.shared ?? "(nothing)"}`,
    ...(outcome.note ? [`note: ${outcome.note}`] : []),
    "-->",
    "",
    ...section("did", outcome.did),
    ...section("learned", outcome.learned),
    ...section("abandoned", outcome.abandoned),
    ...section("want next time", outcome.wantNextTime),
    ...(fallback ? ["## the session's last words (no writeback)", "", "```", fallback, "```", ""] : []),
  ].join("\n");
}

/** THE single write of a session's entry: atomic (tmp + rename), one file per session id. */
export function writeFreeTimeEntry(rootDir: string, id: string, content: string): string {
  if (!FREE_TIME_ID_RE.test(id)) throw new Error(`free-time: invalid session id '${id}'`);
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const path = join(rootDir, `${id}.md`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return path;
}

/** Every entry on disk, newest first. Non-entry files are ignored, never touched. */
export function listFreeTimeEntries(rootDir: string): Array<{ id: string; path: string; bytes: number }> {
  if (!existsSync(rootDir)) return [];
  const entries: Array<{ id: string; path: string; bytes: number }> = [];
  for (const file of readdirSync(rootDir)) {
    const m = file.match(/^(\d{4}-\d{2}-\d{2}-[0-9a-f]{8})\.md$/);
    if (!m) continue;
    const path = join(rootDir, file);
    try {
      entries.push({ id: m[1]!, path, bytes: Buffer.byteLength(readFileSync(path, "utf8"), "utf8") });
    } catch {
      // An unreadable entry is absent from the listing rather than fatal to it.
    }
  }
  return entries.sort((a, b) => b.id.localeCompare(a.id));
}

/** One entry's raw markdown, or null. The id regex is also the traversal guard. */
export function readFreeTimeEntry(rootDir: string, id: string): string | null {
  if (!FREE_TIME_ID_RE.test(id)) throw new Error(`free-time: invalid session id '${id}'`);
  const path = join(rootDir, `${id}.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// ── default dependencies ───────────────────────────────────────────────────────────────

/**
 * Drop scratch DIRECTORIES past the retention window (quick's sweep, one guard added): only
 * names matching a session id are touched, so the `.md` entries sitting beside them — the part
 * worth keeping — are never candidates.
 */
function sweepFreeTimeScratch(rootDir: string, nowMs: number, logger: Logger): void {
  let names: string[] = [];
  try {
    names = readdirSync(rootDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!FREE_TIME_ID_RE.test(name)) continue;
    const path = join(rootDir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || nowMs - stat.mtimeMs <= FREE_TIME_SCRATCH_RETENTION_MS) continue;
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      logger.warn("free-time: could not sweep old scratch dir", { path, error: String(err) });
    }
  }
}

function readWritebackRaw(scratchDir: string): string | null {
  try {
    return readFileSync(join(scratchDir, "writeback.json"), "utf8");
  } catch {
    return null;
  }
}

/** Recall the last sessions' notes as the seed. A recall failure is a first run, not a crash. */
async function readSeed(memory: MemoryStore | null, logger: Logger): Promise<string> {
  if (!memory) return "";
  try {
    const result = await memory.recall({
      text: FREE_TIME_SEED_QUERY,
      filter: { types: ["free-time"] },
      k: 8,
      // Beckett reading its own notes: owner-scoped facts are its own working knowledge, and the
      // sentinel viewer keeps dm-scoped ones fail-closed out of a session nobody is talking to.
      audience: SELF_AUDIENCE,
    });
    return renderFreeTimeSeed(result.hits.map((h) => h.node));
  } catch (err) {
    logger.warn("free-time: seed recall failed; starting cold", { error: String(err) });
    return "";
  }
}

function defaultMemory(paths: Paths, logger: Logger): MemoryStore | null {
  try {
    return createMemory({ memoryDir: paths.memoryDir, logger: logger.child("memory") });
  } catch (err) {
    logger.warn("free-time: memory store unavailable", { error: String(err) });
    return null;
  }
}

/**
 * The default harness: ONE `claude -p` inside the scratch directory, behind the scope guard and
 * the deny list delivered via `--settings` (so nothing the session writes carries harness
 * scaffolding). Turn-capped, wall-clock-capped, and its output tokens are read from the result
 * frame so the receipt can charge them against the ceiling.
 */
export function defaultFreeTimeHarnessCall(config: Config, logger: Logger): FreeTimeHarnessCall {
  const cfg = config.free_time;
  const bin = config.harness.claude.bin;
  const model = freeTimeModel(config);
  const timeoutMs = cfg.hard_timeout_s * 1_000;
  return async (prompt, opts) => {
    const proc = Bun.spawn(
      [
        bin,
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "json",
        "--permission-mode",
        config.harness.claude.permission_mode,
        "--settings",
        opts.settingsPath,
        "--max-turns",
        String(cfg.max_turns),
        "--disallowedTools",
        FREE_TIME_DISALLOWED_TOOLS,
      ],
      { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: harnessEnv() },
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
      if (timedOut) throw new Error(`free-time session timed out after ${cfg.hard_timeout_s}s`);
      if (code !== 0) throw new Error(`free-time session exited ${code}: ${stderr.trim().slice(0, 400)}`);
      return parseModelResult(stdout, logger);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The child's env: the daemon's sanitized env plus the user-local bins quick's runs need. */
function harnessEnv(): Record<string, string | undefined> {
  const env = childEnv();
  const home = process.env.HOME ?? "";
  const extra = [join(home, ".local/bin"), join(home, ".bun/bin")].join(":");
  env.PATH = env.PATH ? `${extra}:${env.PATH}` : extra;
  return env;
}

/** The share's default road out: ONE `discord.reply` on the control bus, same as a watch report. */
function defaultSharePost(paths: Paths): FreeTimeSharePost {
  return async (channelId, text) => {
    await callBus(join(paths.beckettDir, "control.sock"), "discord.reply", { channelId, text }, 30_000);
  };
}

function trimLine(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
