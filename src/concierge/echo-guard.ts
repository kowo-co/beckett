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
  /** True when the bubble should be treated as an echo of `input` and replaced with the original. */
  echoed: boolean;
  /** Dice coefficient over content words (stopwords stripped) — catches a paraphrased echo. */
  contentScore: number;
  /** Dice coefficient over every token, stopwords included — catches a stopword-only echo. */
  fullScore: number;
}

/** Trip threshold for `contentScore` — tuned above the ~0.5 a legitimate shared filename/number
 * reply produces, and comfortably below the incident's ~0.8. */
const CONTENT_OVERLAP_THRESHOLD = 0.65;
/** Trip threshold for `fullScore` — deliberately high: two ordinary sentences share plenty of
 * stopwords by chance, so only a near-total token overlap should trip this channel. */
const FULL_TOKEN_OVERLAP_THRESHOLD = 0.85;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Dice coefficient: 2×|A∩B| / (|A|+|B|). Zero when either set is empty — an empty set carries
 * no overlap signal, it is not "fully different" or "fully the same." */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Score a rewritten bubble against the user's triggering message and decide whether it has
 * drifted into being substantially the user's own words. Pure and deterministic — no network, no
 * randomness — so a caller can unit test the threshold directly.
 */
export function detectEchoedInput(bubble: string, input: string): EchoCheckResult {
  const bubbleTokens = tokenize(bubble);
  const inputTokens = tokenize(input);
  if (bubbleTokens.length === 0 || inputTokens.length === 0) {
    return { echoed: false, contentScore: 0, fullScore: 0 };
  }

  const bubbleContent = new Set(bubbleTokens.filter((word) => !STOPWORDS.has(word)));
  const inputContent = new Set(inputTokens.filter((word) => !STOPWORDS.has(word)));
  const contentScore = dice(bubbleContent, inputContent);
  const fullScore = dice(new Set(bubbleTokens), new Set(inputTokens));

  const echoed = contentScore >= CONTENT_OVERLAP_THRESHOLD || fullScore >= FULL_TOKEN_OVERLAP_THRESHOLD;
  return { echoed, contentScore, fullScore };
}
