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
 *
 * Incident (2026-08-18, channel 1520986792373911622, a second delivery): the leading/trailing-span
 * check above fired on a bubble that legitimately QUOTED the user's own message (`answered "for
 * jesus"`) — the rewrite was byte-identical to `originalText`, nothing was echoed, but a 4-token
 * trailing window happened to score just past the whole-bubble thresholds anyway (short windows
 * against a short `input` make Dice coefficients noisy), and the repair then stripped the matched
 * span AND everything after it, truncating the message at a dangling open quote. Three fixes:
 * the leading/trailing-span check now requires BOTH Dice scores to cross threshold, not either —
 * strictly more conservative than the whole-bubble OR, never looser (`tripsEdgeEchoThreshold`); a
 * candidate span sitting inside quote characters is never treated as an echo, quotation being
 * normal writing (`isQuotedSpan`); and — the cheapest and most direct fix — when `bubble` is
 * byte-identical to `originalText` the rewrite touched nothing, so `detectEchoedInput` returns
 * `echoed: false` unconditionally before scoring against `input` even begins.
 */

/**
 * Incident (2026-08-20, channel 1520986792373911622): a chilltext rewrite posted a fragment of
 * its OWN delivery-format instructions — "return only the rewritten chat message or messages,
 * separated by a blank line. use 1 to 4 messages total and never more than 4." — as if it were
 * one of Beckett's own bubbles, sandwiched between two legitimate ones from the same delivery.
 * That exact sentence appears nowhere in this repo: `chillTransform` (`../chilltext.ts`) only
 * ever sends `system`, `input`, `agentOutput`, and `max_bubbles` as separate JSON fields to the
 * remote chilltext service (`chilltext.ssh.codes`, a friend's homelab box this repo does not
 * own) — the concrete wording that leaked is that service's OWN wrapper prompt, assembled
 * server-side around what we send, not anything this codebase constructs or controls. A check
 * for near-copies of OUR prompt text (`detectEchoedInput` reused in `chill-gate.ts` against the
 * resolved `system` string instead of the user's `input`) is complementary but cannot catch THIS
 * incident, since the leaked text isn't a copy of anything we sent.
 *
 * `detectPromptScaffolding` instead scores a bubble against the general SHAPE of rewrite-gate
 * delivery instructions: language that specifies how many messages to return, how they're
 * delimited, an upper bound on the count, a "return only" directive, or a noun phrase naming "the
 * rewritten message(s)" as a thing being discussed rather than sent. It is deliberately NOT a
 * check for the one incident sentence — each signal targets a distinct, generic piece of
 * delivery-contract phrasing, and the check only trips when at least two independent signal
 * families converge in the same bubble. A real reply can incidentally brush one signal (an
 * offhand "never more than 5 minutes"); two landing together in one bubble is what actually
 * distinguishes instruction scaffolding from chat content.
 */
const COUNT_RANGE_MESSAGES_RE = /\b\d+\s*(?:to|-|–)\s*\d+\s+(?:messages?|bubbles?)\b/i;
const TOTAL_MESSAGES_RE = /\b\d+\s+(?:messages?|bubbles?)\s+total\b/i;
const NEVER_MORE_THAN_RE = /\bnever\s+more\s+than\s+\d+\b/i;
const RETURN_ONLY_RE = /\b(?:return|reply|respond|output)\s+only\s+(?:the|with)\b/i;
const SEPARATED_BY_DELIMITER_RE = /\bseparated\s+by\s+(?:a\s+)?(?:blank\s+lines?|newlines?|commas?)\b/i;
const REWRITTEN_MESSAGE_NOUN_RE = /\b(?:rewritten|chilled)\s+(?:chat\s+)?messages?\b/i;

const PROMPT_SCAFFOLD_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["countRangeMessages", COUNT_RANGE_MESSAGES_RE],
  ["totalMessages", TOTAL_MESSAGES_RE],
  ["neverMoreThan", NEVER_MORE_THAN_RE],
  ["returnOnly", RETURN_ONLY_RE],
  ["separatedByDelimiter", SEPARATED_BY_DELIMITER_RE],
  ["rewrittenMessageNoun", REWRITTEN_MESSAGE_NOUN_RE],
];

/** At least this many independent signal families must match before a bubble is treated as
 * instruction scaffolding rather than chat content — see the doc above for why one alone isn't
 * enough to trip this. */
const PROMPT_SCAFFOLD_SIGNAL_THRESHOLD = 2;

export interface PromptScaffoldResult {
  /** True when `bubble` reads as delivery-format instructions rather than chat content. */
  leaked: boolean;
  /** Names of every signal family that matched — carried through to the trip's warn log so a
   * recurrence is diagnosable from which signals fired, not just that something tripped. */
  signals: string[];
}

/**
 * Score `bubble` for the general SHAPE of rewrite-gate delivery instructions (see the doc above
 * for the incident this exists to catch and why it isn't a blocklist of that incident's
 * sentence). Pure and deterministic — no network, no randomness — so a caller can unit test the
 * threshold directly, same as `detectEchoedInput`.
 */
export function detectPromptScaffolding(bubble: string): PromptScaffoldResult {
  const signals = PROMPT_SCAFFOLD_SIGNALS.filter(([, re]) => re.test(bubble)).map(([name]) => name);
  return { leaked: signals.length >= PROMPT_SCAFFOLD_SIGNAL_THRESHOLD, signals };
}

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
 * reply produces, and comfortably below the incident's ~0.8. */
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

/** Trip condition for a leading/trailing-span match (`findEdgeSpan`). The whole-bubble check
 * above trips on EITHER score alone, which is fine at whole-bubble scale where both sets are
 * large enough that a lone score crossing threshold is meaningful. A span window is much
 * smaller — often just a handful of tokens — where Dice coefficients are noisy: a couple of
 * coincidentally shared words against a short `input` can swing `contentScore` past 0.65 on its
 * own with no genuine echo behind it (2026-08-18 incident: a 4-token trailing window scored
 * content=0.67/full=0.67 off nothing but a quoted word plus two unrelated trailing words). The
 * repair path must be AT LEAST as conservative as the whole-bubble check, never looser, so it
 * requires BOTH scores to cross threshold together — strictly stricter than the OR above. A
 * genuine echo (PR #303's `"yeah merge it"` prefix) still saturates both scores near 1.0, so this
 * costs nothing against the real case it exists to catch. */
function tripsEdgeEchoThreshold(contentScore: number, fullScore: number): boolean {
  return contentScore >= CONTENT_OVERLAP_THRESHOLD && fullScore >= FULL_TOKEN_OVERLAP_THRESHOLD;
}

/** Straight and curly quote pairs a deliberately quoted span may sit inside. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
];

/** True when `text[start, end)` is immediately wrapped by a matching quote pair — i.e. the span is
 * a deliberate quotation (`answered "for jesus"`), not a prepended/appended echo. A quotation is
 * normal writing a reply is expected to contain; it is not the failure mode this guard exists to
 * catch, so a span sitting inside quotes must never count as an echo. */
function isQuotedSpan(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  if (before === undefined || after === undefined) return false;
  return QUOTE_PAIRS.some(([open, close]) => before === open && after === close);
}

/**
 * Find the leading (`edge: "start"`) or trailing (`edge: "end"`) run of `bubbleTokens` whose
 * overlap with `inputTokens` crosses `tripsEdgeEchoThreshold` on its own. Search window
 * sizes are centered on `inputTokens.length` (±`EDGE_WINDOW_SLACK`) — the "obvious" sizing for a
 * span that is supposed to BE the input, near-verbatim. The winning window is rejected outright
 * when it sits inside quote characters — see `isQuotedSpan`. Returns the token count of the best
 * matching window, or `null` when nothing in range trips (or the only match found is a quotation).
 *
 * Ranked by `fullScore`, not `contentScore`: `fullScore` counts every token including stopwords,
 * so it strictly peaks once the window's word set first covers the input's — a window one token
 * short (e.g. missing a trailing stopword the input actually ends on) scores lower on `fullScore`
 * even when `contentScore` is already saturated and can't tell the two apart.
 */
function findEdgeSpan(
  bubble: string,
  bubbleTokens: OffsetToken[],
  inputTokens: string[],
  edge: "start" | "end",
): number | null {
  const lower = Math.max(1, inputTokens.length - EDGE_WINDOW_SLACK);
  const upper = Math.min(bubbleTokens.length, inputTokens.length + EDGE_WINDOW_SLACK);
  let best: { w: number; fullScore: number; window: OffsetToken[] } | null = null;
  for (let w = lower; w <= upper; w++) {
    const window = edge === "start" ? bubbleTokens.slice(0, w) : bubbleTokens.slice(bubbleTokens.length - w);
    const words = window.map((t) => t.word);
    const { contentScore, fullScore } = scoreTokens(words, inputTokens);
    if (tripsEdgeEchoThreshold(contentScore, fullScore) && (!best || fullScore > best.fullScore)) {
      best = { w, fullScore, window };
    }
  }
  if (!best) return null;
  // Quote-check the WINNING window only, not every candidate: a window widened by
  // `EDGE_WINDOW_SLACK` beyond the true quoted span (padded with a token or two of real,
  // unquoted reply text at the boundary) would otherwise dodge a per-candidate quote check while
  // still being fundamentally the same quotation, just measured one token off. If the best match
  // found is a deliberate quotation, the whole edge is not an echo — there is no genuine
  // second-best match hiding behind it worth falling back to.
  if (isQuotedSpan(bubble, best.window[0]!.start, best.window[best.window.length - 1]!.end)) return null;
  return best.w;
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
    const w = findEdgeSpan(bubble, bubbleTokens, inputTokens, edge);
    if (w === null) continue;
    const remainder = stripEdgeSpan(bubble, bubbleTokens, w, edge);
    return isPlausibleRepair(remainder, originalText) ? remainder : null;
  }
  return undefined;
}

/**
 * Incident (2026-08-21, channel 1520986792373911622, two confirmed deliveries plus a third found
 * on retroactive analysis of `~/.beckett/chilltext-transforms.jsonl`, 2026-08-19T05:12:08.718Z): a
 * chilltext rewrite discarded a bubble's actual input and returned a verbatim line from `persona.md`'s
 * own sample-lines section instead — a confident, fabricated claim of completed work ("pushed the
 * fix", "the deploy went about as well as you'd expect") with zero relationship to what Beckett
 * actually said. `detectEchoedInput` above cannot catch this: it compares the rewrite against the
 * USER's message, and this bug compares nothing against nothing — the rewrite just isn't a rewrite
 * of anything in the reply it was handed.
 *
 * `detectContentSubstitution` scores a bubble against the text it was SUPPOSED to be a rewrite of
 * (a blank-line block of the pre-chill reply, or the whole reply when there's only one block) using
 * a one-sided CONTAINMENT score, not `detectEchoedInput`'s symmetric Dice: what fraction of the
 * bubble's own content words (stopwords stripped) also appear in the source. Symmetric Dice
 * penalizes a short bubble scored against a much longer source it only covers a fragment of (the
 * source's own size inflates the denominator); containment doesn't, since only the bubble's own
 * word count sets the denominator. That distinction matters here because chilltext's ordinary,
 * harmless behavior is to freely re-chunk a reply — split one long paragraph into several short
 * bubbles, or merge several short ones into one — so a bubble legitimately covering only a
 * FRAGMENT of its source block is the common case, not the exception. Confirmed against a sample of
 * ~800 real bubbles in `~/.beckett/chilltext-transforms.jsonl`: legitimate bubbles (including
 * fragment-of-a-longer-block splits) score containment ≥0.65 in the overwhelming majority of cases,
 * with a single softer legitimate outlier at 0.11 (a short reactive aside chilltext appended on top
 * of an otherwise faithful rewrite); the three confirmed substitutions scored 0.00, 0.00, 0.00, and
 * 0.095 — a wide, unambiguous gap below that floor. `FIDELITY_CONTAINMENT_THRESHOLD` sits at 0.3,
 * comfortably inside that gap (full measurement and rationale: this change's PR description).
 *
 * `chill-gate.ts`'s `reconcileBubblesWithBlocks` is the caller: it walks chilltext's returned
 * bubbles against the pre-chill reply's blank-line blocks, using this score to decide, per bubble,
 * whether it belongs to the block it's positioned against — and, structurally, whether a SURPLUS
 * bubble (more bubbles than blocks) is fabricated content to drop outright, or a block got no
 * bubble at all (fewer bubbles than blocks) and its content needs to post verbatim rather than
 * silently vanish. See that function's doc for the full two-mode incident writeup.
 */
const FIDELITY_CONTAINMENT_THRESHOLD = 0.3;

/** A rewritten bubble scored against the text it was supposedly rewritten FROM. */
interface ContentFidelityResult {
  /** True when `rewritten` shares essentially nothing with `source` — substituted/fabricated
   * content, not a rewrite of it. */
  unrelated: boolean;
  /** Fraction of `rewritten`'s own content words (stopwords stripped) that also appear among
   * `source`'s content words. `null` when `rewritten` or `source` has no content words at all —
   * nothing to judge, so never flagged in that case (a bare ack, an all-stopword source, …). */
  score: number | null;
}

/**
 * Score whether `rewritten` retains any substantive connection to `source` — the text it was
 * supposedly rewritten FROM. See the doc above for why this is a one-sided CONTAINMENT score
 * rather than `detectEchoedInput`'s symmetric Dice, and for the incident and real-data threshold
 * justification behind `FIDELITY_CONTAINMENT_THRESHOLD`.
 */
export function detectContentSubstitution(rewritten: string, source: string): ContentFidelityResult {
  const rewrittenContent = tokenize(rewritten).filter((word) => !STOPWORDS.has(word));
  if (rewrittenContent.length === 0) return { unrelated: false, score: null };
  const sourceContent = new Set(tokenize(source).filter((word) => !STOPWORDS.has(word)));
  if (sourceContent.size === 0) return { unrelated: false, score: null };
  let shared = 0;
  for (const word of rewrittenContent) if (sourceContent.has(word)) shared++;
  const score = shared / rewrittenContent.length;
  return { unrelated: score < FIDELITY_CONTAINMENT_THRESHOLD, score };
}

/**
 * Incident (2026-08-24, channel 1520986792373911622, 22:50:41.399Z): a second, narrower shape of
 * the 2026-08-21 persona-sample-line incident above — this time chilltext substituted only the
 * OPENING CLAUSE of an otherwise-faithful bubble with a verbatim `persona.md` sample line, leaving
 * the rest of the message untouched:
 *
 *   agentOutput: "hi booper. you got the mention right and the message wrong, which is more than
 *                 most of the pipelines around here managed today"
 *   posted:      "yeah that's broken. you got the mention right and the message wrong, which is
 *                 more than most of the pipelines around here managed today"
 *
 * `detectContentSubstitution` above cannot catch this: it is a length-weighted WHOLE-MESSAGE
 * containment score, and 90%+ of the bubble's content words survived untouched (recorded
 * fidelityScore: 0.9), which comfortably clears `FIDELITY_CONTAINMENT_THRESHOLD`. But the message
 * that reached Discord was addressed to nobody and asserted a fact ("that's broken") the agent
 * never claimed — the opening clause carries the addressee and the stance, and diluting it into a
 * whole-message average is exactly the blind spot this incident exploited.
 *
 * `detectLeadingClauseSubstitution` scores ONLY the leading clause of `rewritten` against the
 * leading clause of `source` — independent of, and strictly narrower than, the whole-message
 * check. `chill-gate.ts`'s `reconcileBubblesWithBlocks` runs this ONLY for the bubble matched to
 * the FIRST block of the reply (the one carrying the opening clause); a bubble covering the middle
 * or end of a block legitimately shares nothing with that block's own opener, so checking every
 * bubble against it would misfire on chilltext's ordinary, harmless re-chunking.
 */
const LEADING_CLAUSE_OVERLAP_THRESHOLD = 0.2;

/** The leading sentence/clause of `text` — everything up to and including the first `.`, `!`, or
 * `?` — or `null` when `text` carries no such terminator at all. `.` does not cross a newline in
 * this regex by design — a multi-block `text` with no early terminator on its first line must not
 * spill the "leading clause" into a LATER block. No fallback to the whole string on a miss: a
 * short, genuinely-terminated source clause ("stopped.") scored against an untermined bubble that
 * merged it into a longer sentence would compare a 1-word fragment against the bubble's ENTIRE
 * text — a size mismatch that produces a low score on ordinary, faithful rewording, not a
 * substitution. Requiring BOTH sides to carry a real terminator (see the caller below) keeps the
 * comparison to genuinely comparable units. */
function leadingClause(text: string): string | null {
  const match = /^(.*?[.!?])(?:\s|$)/.exec(text.trim());
  return match ? match[1]!.trim() : null;
}

/** A rewritten bubble's OPENING clause scored against the source block's opening clause. */
interface LeadingClauseResult {
  /** True when the two opening clauses share essentially nothing — a substitution of the opener,
   * not a rewrite of it. */
  unrelated: boolean;
  /** Dice content-word overlap between the two leading clauses. `null` when either clause has no
   * content words to score (e.g. a bare "ok." opener). */
  score: number | null;
}

/**
 * Score `rewritten`'s opening clause against `source`'s. Runs only when BOTH carry a genuine
 * sentence terminator early on — see {@link leadingClause}'s doc for why an untermined side (the
 * whole string standing in for "the leading clause") makes the comparison meaningless rather than
 * conservative. Threshold sits at 0.2 — well below `FIDELITY_CONTAINMENT_THRESHOLD`'s 0.3 because a
 * genuine rewrite of a short opener ("hey" → "yo there") can legitimately share zero tokens with
 * the original while still being a faithful restyle, so this is deliberately loose; it exists only
 * to catch the degenerate case of NO shared content at all, which a real rewrite of the same clause
 * essentially never produces (the evidence pair scores exactly 0.0 — "hi booper" and "yeah that's
 * broken" share not one content word).
 */
export function detectLeadingClauseSubstitution(rewritten: string, source: string): LeadingClauseResult {
  const rewrittenLead = leadingClause(rewritten);
  const sourceLead = leadingClause(source);
  if (rewrittenLead === null || sourceLead === null) return { unrelated: false, score: null };
  const rewrittenClause = tokenize(rewrittenLead).filter((word) => !STOPWORDS.has(word));
  const sourceClause = tokenize(sourceLead).filter((word) => !STOPWORDS.has(word));
  if (rewrittenClause.length === 0 || sourceClause.length === 0) return { unrelated: false, score: null };
  const score = dice(new Set(rewrittenClause), new Set(sourceClause));
  return { unrelated: score < LEADING_CLAUSE_OVERLAP_THRESHOLD, score };
}

/** A persona sample-line clause must be at least this many words before a bubble is checked
 * against it — see the doc below for the false-positive tradeoff. A 2-word fragment like "moving
 * on" or "skill issue" is common enough in ordinary chat that a coincidental match isn't a leak; a
 * 3-word fragment like "yeah that's broken" or "i know why" is distinctive enough that a verbatim
 * match is the persona line itself, not chance. */
const PERSONA_CLAUSE_MIN_WORDS = 3;

/** Split `line` into its sentence-level clauses and normalize each: lowercase, trailing `.`/`!`/`?`
 * stripped, whitespace trimmed. The 2026-08-24 incident substituted a single CLAUSE out of a
 * multi-clause sample line ("yeah that's broken. i know why. gimme 10" → only "yeah that's broken."
 * leaked), not the whole line, so the check has to operate at clause granularity to catch it. */
function normalizePersonaClauses(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+/)
    .map((clause) => clause.toLowerCase().replace(/[.!?]+$/, "").trim())
    .filter(Boolean);
}

/** A rewritten bubble scored against `persona.md`'s sample lines. */
export interface PersonaLeakResult {
  /** True when `bubble` contains a persona sample-line clause the agent's own output did not. */
  leaked: boolean;
  /** The normalized clause that matched, for the trip's warn log. `null` when nothing matched. */
  matchedClause: string | null;
}

/**
 * Detect a chilltext rewrite substituting a verbatim `persona.md` sample-line clause into a bubble
 * that the agent's own output never contained (the 2026-08-21 and 2026-08-24 incidents — see the
 * docs above `detectContentSubstitution` and `detectLeadingClauseSubstitution` for the two shapes
 * this has taken). Trivially detectable once the sample lines are in hand: normalize (lowercase,
 * strip trailing punctuation) each clause of each sample line, and check whether `bubble` contains
 * one that `agentOutput` does not. A clause the agent's own output ALSO contains is not a leak —
 * it's either a coincidence or (more likely) the agent legitimately writing in its own established
 * voice, and this guard's whole purpose is catching FABRICATED content, not policing style.
 */
export function detectPersonaSampleLineLeak(
  bubble: string,
  agentOutput: string,
  sampleLines: readonly string[],
): PersonaLeakResult {
  const bubbleNorm = bubble.toLowerCase();
  const agentOutputNorm = agentOutput.toLowerCase();
  for (const sampleLine of sampleLines) {
    for (const clause of normalizePersonaClauses(sampleLine)) {
      if (clause.split(/\s+/).length < PERSONA_CLAUSE_MIN_WORDS) continue;
      if (!bubbleNorm.includes(clause)) continue;
      if (agentOutputNorm.includes(clause)) continue;
      return { leaked: true, matchedClause: clause };
    }
  }
  return { leaked: false, matchedClause: null };
}

/**
 * Score a rewritten bubble against the user's triggering message and decide whether it has
 * drifted into being substantially the user's own words — either the whole bubble, or a leading/
 * trailing span of it. Pure and deterministic — no network, no randomness — so a caller can unit
 * test the threshold directly.
 *
 * `originalText`, when supplied, is the un-chilled reply the bubble was rewritten from. It is used
 * to validate a leading/trailing-span repair (does what's left over plausibly correspond to it?),
 * and — before any scoring happens at all — as an invariant: when `bubble` is byte-identical to
 * `originalText`, the rewrite service returned the reply untouched, so there is nothing it could
 * have corrupted. No overlap with `input`, however high, is grounds to touch a bubble the rewrite
 * didn't change; a legitimate reply is free to quote the user's own words at length.
 */
export function detectEchoedInput(bubble: string, input: string, originalText?: string): EchoCheckResult {
  const bubbleTokens = tokenize(bubble);
  const inputTokens = tokenize(input);
  if (bubbleTokens.length === 0 || inputTokens.length === 0) {
    return { echoed: false, contentScore: 0, fullScore: 0, repaired: null };
  }

  const { contentScore, fullScore } = scoreTokens(bubbleTokens, inputTokens);

  if (originalText !== undefined && bubble === originalText) {
    return { echoed: false, contentScore, fullScore, repaired: null };
  }

  if (tripsEchoThreshold(contentScore, fullScore)) {
    return { echoed: true, contentScore, fullScore, repaired: null };
  }

  const partial = findPartialEcho(bubble, inputTokens, originalText);
  if (partial !== undefined) {
    return { echoed: true, contentScore, fullScore, repaired: partial };
  }

  return { echoed: false, contentScore, fullScore, repaired: null };
}
