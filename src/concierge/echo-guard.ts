/**
 * Beckett — chilltext echo guard (`src/concierge/echo-guard.ts`)
 * =======================================================================================
 * Incident (2026-08-18, channel 1520986792373911622): a chilltext rewrite handed the user's OWN
 * triggering message back as Beckett's reply, with the pronouns inverted ("you're the CTO" —
 * backwards; the user had said Beckett was). `chillTransform` (`src/chilltext.ts`) receives the
 * user's message as `input` alongside the real reply as `agentOutput`, purely as writing context
 * for the rewrite model — it is never supposed to leak back out as the rewrite itself. On this
 * call it did. This is a distinct failure mode from the `<@id>` mangling `enforceMentions`
 * (`src/discord/mentions.ts`) already guards against, but the same structural principle applies:
 * an LLM rewrite is not trusted to have honored the contract, so the delivery gate checks the
 * OUTPUT, not the prompt.
 *
 * `detectEchoedInput` scores one rewritten bubble against the input it was rewritten alongside,
 * using normalized token overlap — cheap, deterministic, dependency-free. Two Dice coefficients,
 * either of which can trip the guard:
 *
 *   - `contentScore` — overlap over CONTENT words (stopwords stripped). This is the primary
 *     signal: it catches a paraphrased echo (words swapped, pronouns flipped) like the incident,
 *     where the bubble is substantially the user's own words even though no sentence is a
 *     verbatim copy.
 *   - `fullScore` — overlap over EVERY token, stopwords included. Backstop for the degenerate
 *     case a stopword-filtered score can miss: a short bubble that is nothing but function words
 *     (e.g. "that's it for now") echoed back verbatim, where `contentScore` sees two empty sets
 *     and reports zero overlap by default. Near-identical regardless of length.
 *
 * `chill-gate.ts` runs this PER BUBBLE (chilltext can hand back up to four independently-scored
 * messages, and only one may have drifted) and falls back to the un-chilled original text for
 * just the bubble that trips it.
 *
 * A later delivery surfaced a second shape of the same failure: instead of the WHOLE bubble
 * becoming a paraphrase of the user's message, the rewrite PREPENDED the user's message verbatim
 * onto the front of the real reply (real reply text following it untouched). Scored as a whole
 * bubble, the echoed span is a small fraction of the total tokens and both `contentScore` and
 * `fullScore` land far under threshold — the original whole-bubble check cannot see it. This is an
 * ADDITIONAL check, not a replacement: `detectEchoedInput` first runs the whole-bubble check
 * exactly as before, and only when that doesn't trip does it look for a leading (or trailing) span
 * of the bubble that scores as an echo of `input` on its own, using the same Dice thresholds
 * applied to a window sized off `input`'s token length. When a caller supplies `originalText` (the
 * un-chilled reply the bubble was rewritten from) and what remains after stripping the echoed edge
 * plausibly corresponds to it, `repaired` carries that stripped remainder so the caller can REPAIR
 * the bubble instead of discarding the whole thing; otherwise `repaired` is `null` and the caller
 * should fall back to `originalText`, same as the whole-bubble case.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "arent",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "cant",
  "cannot",
  "could",
  "couldnt",
  "did",
  "didnt",
  "do",
  "does",
  "doesnt",
  "doing",
  "dont",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "hadnt",
  "has",
  "hasnt",
  "have",
  "havent",
  "having",
  "he",
  "her",
  "here",
  "heres",
  "hers",
  "herself",
  "hes",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "id",
  "ill",
  "im",
  "in",
  "into",
  "is",
  "isnt",
  "it",
  "its",
  "itself",
  "ive",
  "just",
  "lets",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "ok",
  "okay",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "s",
  "same",
  "shant",
  "she",
  "shes",
  "should",
  "shouldnt",
  "so",
  "some",
  "such",
  "t",
  "than",
  "that",
  "thats",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "theres",
  "these",
  "they",
  "theyd",
  "theyll",
  "theyre",
  "theyve",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "wasnt",
  "we",
  "wed",
  "well",
  "were",
  "werent",
  "weve",
  "what",
  "whats",
  "when",
  "where",
  "wheres",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "wont",
  "would",
  "wouldnt",
  "yea",
  "yeah",
  "yep",
  "you",
  "youd",
  "youll",
  "your",
  "youre",
  "yours",
  "yourself",
  "yourselves",
  "youve",
]);

/** A rewritten bubble scored against the user's triggering message. */
interface EchoCheckResult {
  /** True when the bubble should be treated as an echo of `input` — whole-bubble or a leading/
   * trailing span — and should not ship as chilltext returned it. */
  echoed: boolean;
  /** Dice coefficient over content words (stopwords stripped) — catches a paraphrased echo. */
  contentScore: number;
  /** Dice coefficient over every token, stopwords included — catches a stopword-only echo. */
  fullScore: number;
  /**
   * The bubble with an echoed leading/trailing span stripped, when that remainder plausibly
   * corresponds to `originalText`. `null` when there is nothing to repair: the whole bubble is
   * the echo, no `originalText` was supplied to validate a repair against, or the remainder
   * doesn't plausibly correspond to it. A caller should ship `repaired` when present and fall
   * back to `originalText` wholesale when `echoed` is true but `repaired` is `null`.
   */
  repaired: string | null;
}

/** Trip threshold for `contentScore` — tuned above the ~0.5 a legitimate shared filename/number
 * reply produces, and comfortably below the incident's ~0.8. Reused for the leading/trailing-span
 * check: a genuinely echoed span is (near-)verbatim, not merely topically related, so the same bar
 * applies. */
const CONTENT_OVERLAP_THRESHOLD = 0.65;
/** Trip threshold for `fullScore` — deliberately high: two ordinary sentences share plenty of
 * stopwords by chance, so only a near-total token overlap should trip this channel. */
const FULL_TOKEN_OVERLAP_THRESHOLD = 0.85;

/** How many tokens the leading/trailing span search window may drift from `input`'s own token
 * count, to absorb a near-paraphrase adding or dropping a word or two. */
const EDGE_WINDOW_SLACK = 2;
/** A repaired remainder shorter than this (in tokens) is "trivially short" — not worth shipping
 * over a clean fallback to `originalText`. */
const MIN_REMAINDER_TOKENS = 3;
/** Trip threshold for validating a repaired remainder against `originalText` — deliberately much
 * lower than the echo thresholds above: the remainder is a REWRITE of the original, not a copy of
 * it, so only loose correspondence is expected, not near-identity. */
const PARTIAL_REPAIR_PLAUSIBILITY_THRESHOLD = 0.2;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** A word token plus its character span in the original string — needed to slice a leading/
 * trailing echoed span back out of `bubble`, since `tokenize` alone discards position. */
interface OffsetToken {
  word: string;
  start: number;
  end: number;
}

function tokenizeWithOffsets(text: string): OffsetToken[] {
  const tokens: OffsetToken[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Dice coefficient: 2×|A∩B| / (|A|+|B|). Zero when either set is empty — an empty set carries
 * no overlap signal, it is not "fully different" or "fully the same." */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Score one token list against another with the same two Dice coefficients `detectEchoedInput`
 * trips on: content-word overlap (stopwords stripped) and full-token overlap. */
function scoreTokens(a: string[], b: string[]): { contentScore: number; fullScore: number } {
  const contentScore = dice(
    new Set(a.filter((word) => !STOPWORDS.has(word))),
    new Set(b.filter((word) => !STOPWORDS.has(word))),
  );
  const fullScore = dice(new Set(a), new Set(b));
  return { contentScore, fullScore };
}

function tripsEchoThreshold(contentScore: number, fullScore: number): boolean {
  return contentScore >= CONTENT_OVERLAP_THRESHOLD || fullScore >= FULL_TOKEN_OVERLAP_THRESHOLD;
}

/**
 * Find the leading (`edge: "start"`) or trailing (`edge: "end"`) run of `bubbleTokens` whose
 * overlap with `inputTokens` crosses the whole-bubble echo bar on its own. Search window
 * sizes are centered on `inputTokens.length` (±`EDGE_WINDOW_SLACK`) — the "obvious" sizing for a
 * span that is supposed to BE the input, near-verbatim. Returns the token count of the best
 * matching window, or `null` when nothing in range trips.
 *
 * Ranked by `fullScore`, not `contentScore`: `fullScore` counts every token including stopwords,
 * so it strictly peaks once the window's word set first covers the input's — a window one token
 * short (e.g. missing a trailing stopword the input actually ends on) scores lower on `fullScore`
 * even when `contentScore` is already saturated and can't tell the two apart.
 */
function findEdgeSpan(bubbleTokens: OffsetToken[], inputTokens: string[], edge: "start" | "end"): number | null {
  const lower = Math.max(1, inputTokens.length - EDGE_WINDOW_SLACK);
  const upper = Math.min(bubbleTokens.length, inputTokens.length + EDGE_WINDOW_SLACK);
  let best: { w: number; fullScore: number } | null = null;
  for (let w = lower; w <= upper; w++) {
    const window = edge === "start" ? bubbleTokens.slice(0, w) : bubbleTokens.slice(bubbleTokens.length - w);
    const words = window.map((t) => t.word);
    const { contentScore, fullScore } = scoreTokens(words, inputTokens);
    if (tripsEchoThreshold(contentScore, fullScore) && (!best || fullScore > best.fullScore)) {
      best = { w, fullScore };
    }
  }
  return best ? best.w : null;
}

/** Trailing/leading punctuation and whitespace left dangling once the echoed span next to it is
 * stripped out — e.g. the ". " joining a prepended echo to the real reply that followed it. */
const DANGLING_LEADING = /^[\s.,;:!?\-–—]+/;
const DANGLING_TRAILING = /[\s.,;:!?\-–—]+$/;

/** Slice the matched `w`-token span off `bubble`'s start or end and trim the punctuation/
 * whitespace left dangling at the new edge. */
function stripEdgeSpan(bubble: string, bubbleTokens: OffsetToken[], w: number, edge: "start" | "end"): string {
  if (edge === "start") {
    return bubble.slice(bubbleTokens[w - 1]!.end).replace(DANGLING_LEADING, "");
  }
  return bubble.slice(0, bubbleTokens[bubbleTokens.length - w]!.start).replace(DANGLING_TRAILING, "");
}

/** A repaired remainder is only worth shipping when it's long enough to be substantive and, when
 * `originalText` is available to check against, plausibly a rewrite of it rather than leftover
 * noise. With no `originalText` to validate against, repair is never offered — the caller falls
 * back to shipping `originalText` wholesale, same fail-safe posture as the whole-bubble case. */
function isPlausibleRepair(remainder: string, originalText: string | undefined): boolean {
  if (!originalText) return false;
  const remainderTokens = tokenize(remainder);
  if (remainderTokens.length < MIN_REMAINDER_TOKENS) return false;
  const originalTokens = tokenize(originalText);
  if (originalTokens.length === 0) return false;
  const { contentScore, fullScore } = scoreTokens(remainderTokens, originalTokens);
  return contentScore >= PARTIAL_REPAIR_PLAUSIBILITY_THRESHOLD || fullScore >= PARTIAL_REPAIR_PLAUSIBILITY_THRESHOLD;
}

/** Look for a leading, then trailing, echoed span in `bubble`. Returns `null` when neither edge
 * trips (no partial echo detected); otherwise the stripped remainder when it plausibly repairs to
 * `originalText`, or `null` (repair unavailable, caller should fall back wholesale) when it doesn't. */
function findPartialEcho(bubble: string, inputTokens: string[], originalText: string | undefined): string | null | undefined {
  const bubbleTokens = tokenizeWithOffsets(bubble);
  if (bubbleTokens.length === 0) return undefined;

  for (const edge of ["start", "end"] as const) {
    const w = findEdgeSpan(bubbleTokens, inputTokens, edge);
    if (w === null) continue;
    const remainder = stripEdgeSpan(bubble, bubbleTokens, w, edge);
    return isPlausibleRepair(remainder, originalText) ? remainder : null;
  }
  return undefined;
}

/**
 * Score a rewritten bubble against the user's triggering message and decide whether it has
 * drifted into being substantially the user's own words — either the whole bubble, or a leading/
 * trailing span of it. Pure and deterministic — no network, no randomness — so a caller can unit
 * test the threshold directly.
 *
 * `originalText`, when supplied, is the un-chilled reply the bubble was rewritten from. It is used
 * ONLY to validate a leading/trailing-span repair (does what's left over plausibly correspond to
 * it?) — it plays no part in the whole-bubble check, which is unchanged from before this parameter
 * existed.
 */
export function detectEchoedInput(bubble: string, input: string, originalText?: string): EchoCheckResult {
  const bubbleTokens = tokenize(bubble);
  const inputTokens = tokenize(input);
  if (bubbleTokens.length === 0 || inputTokens.length === 0) {
    return { echoed: false, contentScore: 0, fullScore: 0, repaired: null };
  }

  const { contentScore, fullScore } = scoreTokens(bubbleTokens, inputTokens);
  if (tripsEchoThreshold(contentScore, fullScore)) {
    return { echoed: true, contentScore, fullScore, repaired: null };
  }

  const partial = findPartialEcho(bubble, inputTokens, originalText);
  if (partial !== undefined) {
    return { echoed: true, contentScore, fullScore, repaired: partial };
  }

  return { echoed: false, contentScore, fullScore, repaired: null };
}
