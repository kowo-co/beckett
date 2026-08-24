#!/usr/bin/env bun
/**
 * Recall@k for the retrieval that actually builds a concierge turn.
 *
 * Run: bun run eval:recall
 *      bun run eval:recall -- --profile before      # the pre-fix parameters
 *      bun run eval:recall -- --json
 *      bun run eval:recall -- --misses              # print every miss with its top-ranked items
 *
 * WHAT IT MEASURES
 * ----------------
 * Beckett assembles a turn from several auto-selected SYSTEM blocks. Two of them are retrieval,
 * and they are the two places "you forget stuff already said" can come from:
 *
 *   1. **helpful memories** — `MemoryStore.recall` over the markdown memory graph, then
 *      {@link selectPrimerNotes}.
 *   2. **relevant context** — `ChannelContextStore.search` over the captured channel windows,
 *      then {@link selectChannelContext}.
 *
 * This runner drives BOTH through their real implementations — the same query builders, the same
 * stores, the same selectors `src/concierge/index.ts` calls — and asks one question per case: did
 * the item that should have surfaced actually land in the block, at the sizes a live turn uses?
 * That is recall@k where k is not a knob but whatever the live turn admits.
 *
 * Because it runs the selectors rather than a copy of them, a regression in admission, budget,
 * dedup or the relevance floor shows up here as a dropped number.
 *
 * PROFILES
 * --------
 * `--profile after` (default) reads the shipping config defaults. `--profile before` pins the
 * parameters as they stood before this eval existed, so the delta is reproducible from the
 * checked-in script alone rather than from a commit someone has to go find.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelContextStore, type ChannelEntry } from "../../src/concierge/channel-context.ts";
import {
  crossChannelQueryTerms,
  memoryPrimerQuery,
  selectChannelContext,
  selectPrimerNotes,
} from "../../src/concierge/turn-recall.ts";
import { createMemory } from "../../src/memory/index.ts";
import { SELF_AUDIENCE } from "../../src/memory/search.ts";
import { CASES_PATH, CORPUS_PATH, type MemoryRecallCorpus, type RecallCase } from "./memory-recall-corpus.ts";
import type { Logger } from "../../src/types.ts";

const quietLog: Logger = (() => {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l };
  return l as unknown as Logger;
})();

/**
 * Every parameter the two retrieval paths read, in one place. `before` is the state this eval
 * was first pointed at; `after` mirrors the shipping defaults in `src/capability/builtins.ts`.
 */
interface Profile {
  label: string;
  /** Memory primer. */
  primerCandidates: number;
  primerMaxNotes: number;
  primerMaxChars: number;
  primerMinScore: number;
  /** Channel store + the relevance block. */
  channelMaxAgeHours: number;
  channelMaxEntries: number;
  channelSearchLimit: number;
  channelMinScore: number;
  channelBudgetTokens: number;
  channelIncludeCurrent: boolean;
}

const PROFILES: Record<string, Profile> = {
  // Pinned by hand from the pre-fix defaults — deliberately NOT read from config, so this row
  // keeps meaning the same thing after the defaults move.
  before: {
    label: "before",
    primerCandidates: 3, // k is pinned to max_notes on both profiles — the primer was not changed
    primerMaxNotes: 3,
    primerMaxChars: 1200,
    primerMinScore: 0.5,
    channelMaxAgeHours: 72,
    channelMaxEntries: 200,
    channelSearchLimit: 5, // reused awareness_max_channels
    channelMinScore: 0.5,
    channelBudgetTokens: 1200,
    channelIncludeCurrent: false, // the current channel was filtered out
  },
  after: {
    label: "after",
    primerCandidates: 3,
    primerMaxNotes: 3,
    primerMaxChars: 1200,
    primerMinScore: 0.5,
    channelMaxAgeHours: 336,
    channelMaxEntries: 1000,
    channelSearchLimit: 24,
    channelMinScore: 0.5,
    channelBudgetTokens: 1200,
    channelIncludeCurrent: true,
  },
};

interface CaseResult {
  id: string;
  kind: RecallCase["kind"];
  question: string;
  expect: string;
  hit: boolean;
  /**
   * Memory cases only: did it still land when the session's primer block had already been spent
   * on earlier turns? A note the session was already shown counts as a hit — it is standing
   * knowledge, deliberately not re-injected.
   */
  warmHit?: boolean;
  /** Rank of the expected item among what the RETRIEVER returned (null = never retrieved). */
  retrievedRank: number | null;
  /** What actually reached the block, in order. */
  admitted: string[];
  /** Why a retrieved item still failed to reach the block, when that is what happened. */
  reason: string;
}

/** Write the fixture notes out as the markdown files MemoryStore parses. */
function stageMemory(corpus: MemoryRecallCorpus, dir: string): void {
  for (const n of corpus.notes) {
    const sub = join(dir, n.type);
    mkdirSync(sub, { recursive: true });
    const front = [
      "---",
      `name: ${n.name}`,
      `description: >`,
      `  ${n.description.replace(/\n/g, " ")}`,
      "metadata:",
      `  type: ${n.type}`,
      `  visibility: public`,
      `  created: ${n.updated}`,
      `  updated: ${n.updated}`,
      "---",
      "",
    ].join("\n");
    writeFileSync(join(sub, `${n.name}.md`), `${front}${n.body}\n`, "utf8");
  }
}

async function runMemoryCases(
  corpus: MemoryRecallCorpus,
  cases: readonly RecallCase[],
  profile: Profile,
  dir: string,
): Promise<CaseResult[]> {
  stageMemory(corpus, dir);
  const memory = createMemory({ memoryDir: dir, logger: quietLog, git: false, warm: true });
  const results: CaseResult[] = [];
  const memCases = cases.filter((x) => x.kind === "memory");
  // A live session's primer is change-suppressed: a note already shown is never re-injected.
  // So the honest question is not only "does it rank" but "does it still land once earlier turns
  // in this session have spent the block on other things". `seen` carries forward exactly that,
  // seeded from the previous case's admissions — the same session, several questions deep.
  let carriedSeen = new Set<string>();
  for (const c of memCases) {
    const query = memoryPrimerQuery(c.question);
    if (!query) {
      results.push({
        id: c.id, kind: c.kind, question: c.question, expect: c.expect, hit: false,
        warmHit: false, retrievedRank: null, admitted: [],
        reason: "query-gate: message judged not worth a recall",
      });
      continue;
    }
    const { hits } = await memory.recall({
      text: query,
      k: Math.max(profile.primerMaxNotes, profile.primerCandidates),
      hops: 0,
      audience: SELF_AUDIENCE,
    });
    const rank = hits.findIndex((h) => h.node.name === c.expect);
    const opts = {
      maxNotes: profile.primerMaxNotes,
      maxChars: profile.primerMaxChars,
      minScore: profile.primerMinScore,
    };
    const { names } = selectPrimerNotes(hits, opts);
    // The same query, but into a session whose block has already been spent on earlier turns.
    const warm = selectPrimerNotes(hits, { ...opts, seen: carriedSeen });
    const hit = names.includes(c.expect);
    results.push({
      id: c.id, kind: c.kind, question: c.question, expect: c.expect, hit,
      warmHit: warm.names.includes(c.expect) || carriedSeen.has(c.expect),
      retrievedRank: rank >= 0 ? rank + 1 : null,
      admitted: names,
      reason: hit
        ? ""
        : rank < 0
          ? "retriever never returned it"
          : rank + 1 > profile.primerMaxNotes
            ? `ranked ${rank + 1}, past max_notes=${profile.primerMaxNotes}`
            : `ranked ${rank + 1} but cut by the min_score=${profile.primerMinScore} floor`,
    });
    carriedSeen = new Set([...carriedSeen, ...names]);
  }
  return results;
}

async function runChannelCases(
  corpus: MemoryRecallCorpus,
  cases: readonly RecallCase[],
  profile: Profile,
  dir: string,
): Promise<CaseResult[]> {
  // The corpus stores ages, not timestamps. Anchor "now" here so the retention bound is
  // exercised identically on every run, forever.
  const nowMs = Date.parse("2026-08-24T00:00:00.000Z");
  const store = createChannelContextStore({
    channelsDir: dir,
    maxEntriesPerChannel: profile.channelMaxEntries,
    maxAgeHours: profile.channelMaxAgeHours,
    logger: quietLog,
    now: () => nowMs,
  });
  const guildOf = new Map<string, string | null>();
  for (const ch of corpus.channels) {
    guildOf.set(ch.channelId, ch.guildId);
    store.noteMeta(ch.channelId, { name: ch.name, guildId: ch.guildId });
    for (const e of ch.entries) {
      const entry: ChannelEntry = {
        messageId: e.messageId,
        ts: nowMs - e.ageMinutes * 60_000,
        authorId: e.authorId,
        authorName: e.authorName,
        content: e.content,
        kind: e.kind,
      };
      store.append(ch.channelId, entry);
    }
  }
  await store.ensureIndexed();

  const results: CaseResult[] = [];
  for (const c of cases.filter((x) => x.kind === "channel")) {
    const channelId = c.channelId!;
    const terms = crossChannelQueryTerms(c.question);
    // The live path scopes the search to the asking channel's guild.
    const hits = terms.length === 0
      ? []
      : store.search(terms.join(" "), {
          guildId: guildOf.get(channelId) ?? undefined,
          contextRadius: 1,
          limit: profile.channelSearchLimit,
        });
    // A hit carries a ±radius window; the fact reaches the prompt if it is anywhere in one.
    const rank = hits.findIndex((h) => h.context.some((e) => e.messageId === c.expect));
    const selection = selectChannelContext(hits, {
      minScore: profile.channelMinScore,
      budgetTokens: profile.channelBudgetTokens,
      excludeChannelId: profile.channelIncludeCurrent ? undefined : channelId,
    });
    const byKey = new Map(hits.map((h) => [`${h.channelId}:${h.entry.messageId}`, h]));
    const reached = new Set<string>();
    for (const key of selection.keys) {
      for (const e of byKey.get(key)?.context ?? []) reached.add(e.messageId);
    }
    const hit = reached.has(c.expect);
    const inWindow = store.recent(channelId).some((e) => e.messageId === c.expect)
      || corpus.channels.some((ch) => store.recent(ch.channelId).some((e) => e.messageId === c.expect));
    results.push({
      id: c.id, kind: c.kind, question: c.question, expect: c.expect, hit,
      retrievedRank: rank >= 0 ? rank + 1 : null,
      admitted: selection.keys,
      reason: hit
        ? ""
        : !inWindow
          ? `entry aged out of the ${profile.channelMaxAgeHours}h retention window`
          : rank < 0
            ? "search never returned it"
            : !profile.channelIncludeCurrent && hits[rank]!.channelId === channelId
              ? "dropped: the current channel was excluded from the block"
              : `ranked ${rank + 1} but cut by the min_score/budget trim`,
    });
  }
  return results;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`;
}

function summarize(results: CaseResult[]): { total: number; hits: number } {
  return { total: results.length, hits: results.filter((r) => r.hit).length };
}

async function runProfile(corpus: MemoryRecallCorpus, cases: readonly RecallCase[], profile: Profile): Promise<CaseResult[]> {
  const root = mkdtempSync(join(tmpdir(), `beckett-recall-eval-${profile.label}-`));
  try {
    const mem = await runMemoryCases(corpus, cases, profile, join(root, "memory"));
    const chan = await runChannelCases(corpus, cases, profile, join(root, "channels"));
    return [...mem, ...chan];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// =======================================================================================
// main
// =======================================================================================

const argv = process.argv.slice(2);
let json = false;
let showMisses = false;
let only: string | null = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") json = true;
  else if (a === "--misses") showMisses = true;
  else if (a === "--profile") only = argv[++i] ?? null;
  else if (a === "--help" || a === "-h") {
    console.log("usage: bun run eval:recall [-- --profile before|after] [--json] [--misses]");
    process.exit(0);
  } else throw new Error(`unknown argument: ${a}`);
}
if (only && !PROFILES[only]) throw new Error(`unknown profile '${only}' (before|after)`);

const corpus: MemoryRecallCorpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
const cases: RecallCase[] = JSON.parse(readFileSync(CASES_PATH, "utf8"));
if (cases.length === 0) throw new Error("no cases — nothing to measure");

const wanted = only ? [PROFILES[only]!] : [PROFILES.before!, PROFILES.after!];
const byProfile: Record<string, CaseResult[]> = {};
for (const p of wanted) byProfile[p.label] = await runProfile(corpus, cases, p);

if (json) {
  console.log(JSON.stringify({ corpus: CORPUS_PATH, profiles: byProfile }, null, 2));
} else {
  const notes = corpus.notes.length;
  const entries = corpus.channels.reduce((n, c) => n + c.entries.length, 0);
  console.log(`memory recall eval — ${cases.length} cases over ${notes} notes and ${entries} channel entries\n`);
  const rows: string[] = [];
  for (const p of wanted) {
    const all = byProfile[p.label]!;
    const memRows = all.filter((r) => r.kind === "memory");
    const mem = summarize(memRows);
    const warm = { total: memRows.length, hits: memRows.filter((r) => r.warmHit).length };
    const chan = summarize(all.filter((r) => r.kind === "channel"));
    const tot = summarize(all);
    rows.push(
      `  ${p.label.padEnd(7)} memory-graph ${String(mem.hits).padStart(2)}/${mem.total} (${pct(mem.hits, mem.total).padStart(4)})` +
        `   channel ${String(chan.hits).padStart(2)}/${chan.total} (${pct(chan.hits, chan.total).padStart(4)})` +
        `   overall ${String(tot.hits).padStart(2)}/${tot.total} (${pct(tot.hits, tot.total).padStart(4)})`,
    );
    rows.push(
      `          memory-graph, block already spent by earlier turns: ` +
        `${String(warm.hits).padStart(2)}/${warm.total} (${pct(warm.hits, warm.total)})`,
    );
  }
  console.log(rows.join("\n"));
  if (showMisses) {
    for (const p of wanted) {
      const misses = byProfile[p.label]!.filter((r) => !r.hit);
      if (misses.length === 0) continue;
      console.log(`\n  ${p.label} misses (${misses.length}):`);
      for (const m of misses) console.log(`    [${m.id}] ${m.question}\n        want ${m.expect} — ${m.reason}`);
    }
  }
  console.log("");
}
