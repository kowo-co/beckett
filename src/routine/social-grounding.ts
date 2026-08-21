/**
 * Beckett — the social-media agent's mandatory grounding step (`src/routine/social-grounding.ts`)
 * =======================================================================================
 * The real-sources ticket's Half 1, made concrete: the social-media agent (`../agent/builtins.ts`)
 * is banned from inventing an event, so every ordinary "compose a post" fire must hand it a
 * SOURCES block built from things actually fetched/read THIS run — general tech news
 * (`./tech-news.ts`), the model-news feed (`./model-news.ts`), and Beckett's own real history
 * (`./own-history.ts`). This is the ONE place that assembles those into the text appended to the
 * agent's input (wired at `../capability/modules/routines.ts#dispatchAgentLane`); the prompt's
 * GROUNDING RULE (`../agent/builtins.ts`) is what actually forces the agent to use it.
 *
 * An EVENT-triggered fire (the `watch` lane's `./watch.ts#buildAgentSubject`) is already grounded
 * in the specific feed item that fired it, and a TIMELINE REPLY round (`./builtins.ts`'s
 * `TIMELINE_REPLY_INPUT`) is grounded in whatever the browsing agent actually reads live — neither
 * needs this block, so {@link needsGroundingSources} tells the caller when to skip it.
 */

import { join } from "node:path";
import { fetchModelNewsFeed, MODEL_NEWS_FEED_URL, type ModelNewsFetchResult } from "./model-news.ts";
import { fetchAllTechNewsFeeds, type TechNewsItem } from "./tech-news.ts";
import { gatherOwnHistory, type OwnHistoryItem, type OwnHistoryPaths } from "./own-history.ts";
import { uptimeLedgerPath } from "../uptime.ts";

/** A watch-lane event fire names the item itself in its subject (see `./watch.ts`), and a
 *  timeline-reply round is grounded by the live page it reads — neither needs the general
 *  SOURCES block, so this is the gate `dispatchAgentLane` checks before fetching one. */
export function needsGroundingSources(agentInput: string): boolean {
  return !agentInput.startsWith("EVENT TRIGGER") && !agentInput.includes("TIMELINE REPLY ROUND");
}

/** How stale a general tech-news item is allowed to be before it stops being "this run's news". */
const GROUNDING_NEWS_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function recentEnough(publishedAt: string, now: Date, maxAgeMs: number): boolean {
  const ts = Date.parse(publishedAt);
  return Number.isFinite(ts) && now.getTime() - ts <= maxAgeMs;
}

export interface GroundingDeps {
  fetchModelNews: (url: string) => Promise<ModelNewsFetchResult>;
  fetchTechNews: () => Promise<{ items: TechNewsItem[]; errors: string[] }>;
  ownHistory: () => OwnHistoryItem[];
  now: () => Date;
}

/** Shown to the agent when every feed came back empty/broken — honesty over silently vanishing. */
export const GROUNDING_UNAVAILABLE_NOTE = [
  "SOURCES FOR THIS RUN: none available — every feed failed or came back empty, and there is",
  "nothing notable in Beckett's own recent history either. Do NOT invent an event to fill the gap.",
  "Pick BAD OPINION, STUPID ON PURPOSE, PING SOMEONE, or OVERLY INVESTED instead — a real opinion",
  "about a real, generally-known thing needs no fetched source.",
].join("\n");

/**
 * Build the SOURCES block handed to the social-media agent before it composes. Never throws: a
 * feed failure just shrinks the pool, and an empty pool becomes the honest fallback note above.
 */
export async function buildGroundingBlock(deps: GroundingDeps): Promise<string> {
  const now = deps.now();
  const [modelNews, techNews] = await Promise.all([
    deps.fetchModelNews(MODEL_NEWS_FEED_URL).catch((err): ModelNewsFetchResult => ({ ok: false, reason: String(err) })),
    deps.fetchTechNews().catch((err) => ({ items: [] as TechNewsItem[], errors: [String(err)] })),
  ]);

  const newsLines: string[] = [];
  const errors: string[] = [...(modelNews.ok ? [] : [modelNews.reason]), ...techNews.errors];

  if (modelNews.ok) {
    for (const item of modelNews.items) {
      if (!recentEnough(item.publishedAt, now, GROUNDING_NEWS_MAX_AGE_MS)) continue;
      newsLines.push(
        `- [model news] ${item.title || "(untitled)"} — ${item.summary || "(no summary)"} (${item.source?.url ?? "no url"})`,
      );
    }
  }
  for (const item of techNews.items) {
    if (!recentEnough(item.publishedAt, now, GROUNDING_NEWS_MAX_AGE_MS)) continue;
    newsLines.push(`- [${item.source}] ${item.title} — ${item.summary} (${item.url ?? "no url"})`);
  }

  let ownHistory: OwnHistoryItem[];
  try {
    ownHistory = deps.ownHistory();
  } catch {
    ownHistory = [];
  }
  const historyLines = ownHistory.slice(0, 8).map((h) => `- [${h.source}, ${h.at}] ${h.summary}`);

  if (newsLines.length === 0 && historyLines.length === 0) {
    return errors.length
      ? `${GROUNDING_UNAVAILABLE_NOTE}\n(feed errors this round: ${errors.join("; ")})`
      : GROUNDING_UNAVAILABLE_NOTE;
  }

  return [
    "SOURCES FOR THIS RUN (read before you write anything) — the ONLY grounding pool for a",
    "factual claim. If you state something happened — an event, an outage, a CVE, a maintainer",
    "change, a company statement, a thing that happened to you — it must trace to one of these.",
    "If nothing here fits the lane you wanted, pick a different lane instead of inventing.",
    "",
    "— real tech news, fetched this run —",
    ...(newsLines.length ? newsLines : ["(none fetched this run)"]),
    "",
    "— Beckett's own real history (run ledger / deploy-uptime ledger / journal) —",
    ...(historyLines.length ? historyLines : ["(nothing notable recorded recently)"]),
    ...(errors.length ? ["", `(some feeds were unavailable this round: ${errors.join("; ")})`] : []),
  ].join("\n");
}

/** Paths the daemon has on hand (`../paths.ts`'s `Paths`) — only the three fields this needs. */
interface GroundingPaths {
  eventsDir: string;
  beckettDir: string;
  journalDir: string;
}

/**
 * The REAL production implementation, wired explicitly by `../shell/main.ts`. Deliberately not the
 * default inside `dispatchAgentLane` itself: an unwired caller (a test harness that predates this
 * dependency) must never make a live network call by accident — it degrades to
 * {@link GROUNDING_UNAVAILABLE_NOTE} instead, and the daemon is the only process that calls this.
 */
export function createDefaultGrounding(paths: GroundingPaths): () => Promise<string> {
  return () =>
    buildGroundingBlock({
      fetchModelNews: (url) => fetchModelNewsFeed(url),
      fetchTechNews: () => fetchAllTechNewsFeeds(),
      ownHistory: () =>
        gatherOwnHistory(
          {
            dispatchEventsPath: join(paths.eventsDir, "dispatch.jsonl"),
            uptimeLedgerPath: uptimeLedgerPath(paths.beckettDir),
            journalDir: paths.journalDir,
          } satisfies OwnHistoryPaths,
          new Date(),
        ),
      now: () => new Date(),
    });
}
