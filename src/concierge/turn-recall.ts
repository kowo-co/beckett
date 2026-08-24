/**
 * Beckett — the turn's retrieval selection core (`src/concierge/turn-recall.ts`)
 * =======================================================================================
 * Everything that decides WHICH remembered items reach a concierge turn, factored out of
 * `Concierge` so it can be measured without booting a daemon. Two selectors live here:
 *
 *   - {@link selectPrimerNotes} — the "helpful memories" block over the markdown memory
 *     graph (`~/.beckett/memory`), fed by `MemoryStore.recall`.
 *   - {@link selectChannelContext} — the "relevant context" block over the channel store,
 *     fed by `ChannelContextStore.search`.
 *
 * Plus the two query builders that gate whether a store is read at all.
 *
 * The point of the split is honesty: `scripts/eval/memory-recall.ts` scores recall@k by
 * calling exactly these functions with exactly the live config, so the number it prints is
 * the number the turn gets — not a reimplementation that drifts from it.
 */

import { STOP_WORDS } from "../moss-local/index.ts";
import type { ChannelEntry } from "./channel-context.ts";
import { renderEntryLine } from "./channel-context.ts";
import type { ScoredNode } from "../types.ts";

// =======================================================================================
// Query builders — the "is this message worth a store read at all?" gate
// =======================================================================================

/**
 * The distinct content words in an inbound message that the channel-context injector (#74)
 * scores windows against: lowercased, stopwords and sub-3-char tokens dropped, deduped. Empty
 * when the message is all filler ("ok thanks!") — the caller then omits the block rather than
 * scoring on noise. The channel search strips stopwords again for its own keyword pass;
 * stripping here keeps the "any meaningful terms at all?" gate honest.
 */
export function crossChannelQueryTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOP_WORDS.has(raw)) terms.add(raw);
  }
  return [...terms];
}

/** Pure acknowledgments too short/thin to be worth a recall query (overhaul B — memory-primer). */
const MEMORY_PRIMER_STOPLIST = new Set([
  "ok", "okay", "thanks", "thank you", "thx", "ty", "yes", "no", "sure", "cool", "nice", "k",
  "np", "lol", "got it", "great", "perfect", "awesome", "yep", "yup", "nope", "gotcha",
  "thanks a lot", "thank you so much", "sounds good to me", "got it, thanks", "ok sounds good",
  "perfect, thank you", "great, thanks a lot",
]);

/**
 * The memory primer's query text (overhaul B — memory-primer): mentions and urls stripped (they
 * carry no lexical signal for the retriever), then "" for anything too short or a pure
 * command/acknowledgment to be worth a recall — the caller skips the store read entirely.
 */
export function memoryPrimerQuery(text: string): string {
  const stripped = text
    .replace(/<@[!&]?\d+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  if (stripped.length < 12) return "";
  const bare = stripped.toLowerCase().replace(/[!.?]+$/, "");
  if (MEMORY_PRIMER_STOPLIST.has(bare)) return "";
  return stripped;
}

/** First ~`maxLen` chars of `text`, cut at the nearest sentence boundary when one is close enough. */
function truncateAtSentence(text: string, maxLen: number): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (!flat) return "";
  if (flat.length <= maxLen) return flat;
  const cut = flat.slice(0, maxLen);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastStop > maxLen * 0.4) return cut.slice(0, lastStop + 1);
  return `${cut.trimEnd()}…`;
}

// =======================================================================================
// The memory-graph primer block
// =======================================================================================

interface PrimerSelectOptions {
  maxNotes: number;
  maxChars: number;
  /** Fraction-of-top-hit relevance floor. */
  minScore: number;
  /** Note names already shown to this session — suppressed. */
  seen?: ReadonlySet<string>;
}

interface PrimerSelection {
  /** Rendered lines, in rank order, already budget-trimmed. */
  lines: string[];
  /** The note names behind {@link lines}, same order. */
  names: string[];
}

/**
 * Pick the memory-graph notes that ride this turn. `minScore` is a fraction of the TOP hit's
 * score, not an absolute — recall's scorer (moss hybrid (0,1], or unbounded lexical on the
 * fallback path) has no fixed scale, so an absolute floor either admits everything or excludes
 * everything depending on the query. Keeping only hits within `minScore` of the best match
 * enforces the real bar: competitive-with-the-best, not merely "matched at all".
 */
export function selectPrimerNotes(hits: readonly ScoredNode[], opts: PrimerSelectOptions): PrimerSelection {
  const maxNotes = Math.max(1, opts.maxNotes);
  const maxChars = Math.max(1, opts.maxChars);
  const seen = opts.seen ?? new Set<string>();
  const topScore = hits.length > 0 ? hits[0]!.score : 0;
  const floor = topScore * opts.minScore;
  const fresh = hits.filter((h) => h.score >= floor && !seen.has(h.node.name)).slice(0, maxNotes);

  const lines: string[] = [];
  const names: string[] = [];
  let usedChars = 0;
  for (const h of fresh) {
    const date = h.node.updated.slice(0, 10);
    const excerpt = truncateAtSentence(h.node.body, 300);
    const line = `- ${h.node.name} (${date}): ${h.node.description}${excerpt ? ` — ${excerpt}` : ""}`;
    const cost = line.length + 1;
    if (lines.length > 0 && usedChars + cost > maxChars) break;
    lines.push(line);
    names.push(h.node.name);
    usedChars += cost;
  }
  return { lines, names };
}

// =======================================================================================
// The channel-context block
// =======================================================================================

/** The shape {@link selectChannelContext} needs from a `ChannelContextStore.search` hit. */
interface ChannelHitLike {
  channelId: string;
  channelName: string | null;
  entry: ChannelEntry;
  context: ChannelEntry[];
  score: number;
}

interface ChannelSelectOptions {
  /** Relevance floor on the blended keyword+semantic score. */
  minScore: number;
  /** Token budget for the rendered block (chars/4 heuristic). */
  budgetTokens: number;
  /** `channelId:messageId` keys already injected this session — suppressed. */
  seen?: ReadonlySet<string>;
  /**
   * When set, hits from this channel are DROPPED. Left undefined the current channel is
   * eligible, which is what lets a turn re-surface something said here but long since aged
   * out of the unseen window.
   */
  excludeChannelId?: string;
}

interface ChannelSelection {
  /** Rendered `[channel:…]` blocks, highest-scoring first, budget-trimmed. */
  blocks: string[];
  /** `channelId:messageId` keys of the entries behind {@link blocks}. */
  keys: string[];
  /** How many qualifying hits were dropped for budget. */
  droppedForBudget: number;
}

/**
 * Pick the channel-store windows that ride this turn: relevance-gated, session-deduped, then
 * budget-trimmed highest-score-first. Each hit renders its ±radius window behind a channel
 * header; a hit whose header alone would overflow is dropped rather than shown headerless.
 */
export function selectChannelContext(
  hits: readonly ChannelHitLike[],
  opts: ChannelSelectOptions,
): ChannelSelection {
  const seen = opts.seen ?? new Set<string>();
  const qualifying = hits.filter(
    (h) =>
      h.score >= opts.minScore &&
      h.channelId !== opts.excludeChannelId &&
      !seen.has(`${h.channelId}:${h.entry.messageId}`),
  );
  const budgetChars = Math.max(1, opts.budgetTokens) * 4;
  const blocks: string[] = [];
  const keys: string[] = [];
  let usedChars = 0;
  for (const h of qualifying) {
    const label = h.channelName ? ` #${h.channelName}` : "";
    const header = `[channel:${h.channelId}${label}]`;
    const body = h.context.map((e) => renderEntryLine(e, { withDate: true })).join("\n");
    const block = `${header}\n${body}`;
    const cost = block.length + 1;
    if (blocks.length > 0 && usedChars + cost > budgetChars) break;
    blocks.push(block);
    keys.push(`${h.channelId}:${h.entry.messageId}`);
    usedChars += cost;
  }
  return { blocks, keys, droppedForBudget: qualifying.length - blocks.length };
}
