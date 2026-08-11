/**
 * Beckett — per-addressee delivery anchors (`src/concierge/reply-anchors.ts`)
 * =======================================================================================
 * One turn can be answering two different people. The burst that reaches a turn is not always one
 * person's: the live message plus the unseen channel window routinely spans authors, and the reply
 * that comes back addresses each of them in turn. Delivery, however, had exactly ONE native reply
 * target — the message that triggered the turn — so ro's answer arrived pinned under SSH's
 * question and read as a reply to the wrong person (issue #235).
 *
 * This module decides, from the outbound text alone, whether that reply is really several answers.
 * It is deliberately timid: it either returns a split it is confident in, or `null` meaning
 * "deliver exactly as before". A missed split costs the old, familiar behavior. A WRONG split
 * posts a stranger's answer under someone's message, which is worse than the bug it fixes — so
 * every ambiguity resolves to `null`.
 *
 * The heuristic, in full:
 *
 *   1. The burst must span at least two distinct authors. One author → no split, ever.
 *   2. The outbound text is cut at blank-line (paragraph) boundaries.
 *   3. A paragraph "addresses" a burst author when it OPENS with `<@id>` for that author, `@name`,
 *      or `name` followed by a vocative punctuation mark (`,` `:` `—` `–` `-`). A bare name
 *      followed by a space is third person ("ro pushed the fix"), not an address, and does not
 *      count.
 *   4. A paragraph addressing nobody rides with the segment before it.
 *   5. The FIRST paragraph must address someone. Leading text aimed at no one in particular has no
 *      previous segment to ride with, and guessing which anchor it belongs to is exactly the
 *      mis-pin this fixes → `null`.
 *   6. Every segment must address a DIFFERENT author, and there must be at least two of them.
 *      A re-address ("ro … / ssh … / ro …") is ambiguous ordering → `null`.
 *   7. Each segment anchors to that author's most recent message in the burst.
 */

/** One inbound message a turn's answer could be a native reply to. */
export interface BurstAnchor {
  messageId: string;
  /** Discord user id — the authority for "same person". */
  userId: string;
  /** Display name at capture time; matched case-insensitively against an opening address. */
  name: string;
  /** Epoch ms. The most recent message per author wins the anchor. */
  ts: number;
}

/** A piece of the outbound text and the message it should be posted as a native reply to. */
export interface AnchoredSegment {
  text: string;
  anchor: BurstAnchor;
}

/** More than this many separate deliveries is not a considered answer, it is a mailshot. */
const MAX_SEGMENTS = 4;

/** Vocative punctuation: what turns a leading name into an address rather than a subject. */
const VOCATIVE = /^\s*[,:—–-]/;

/** The newest message per author, keyed by user id. */
function newestByAuthor(burst: readonly BurstAnchor[]): Map<string, BurstAnchor> {
  const newest = new Map<string, BurstAnchor>();
  for (const candidate of burst) {
    if (!candidate.userId || !candidate.messageId) continue;
    const held = newest.get(candidate.userId);
    if (!held || candidate.ts >= held.ts) newest.set(candidate.userId, candidate);
  }
  return newest;
}

/**
 * The burst author this paragraph opens by addressing, or undefined. A `<@id>` that names someone
 * OUTSIDE the burst is treated as "nobody" rather than as an ambiguity: the paragraph then rides
 * with the segment before it, which is precisely today's single-anchor behavior for that text.
 */
export function openingAddressee(
  paragraph: string,
  authors: ReadonlyMap<string, BurstAnchor>,
): BurstAnchor | undefined {
  const text = paragraph.trimStart();
  // Discord ids are snowflakes; the pattern stays permissive so a synthetic id (tests, a peer's
  // rendered mention) resolves the same way instead of silently falling through to name matching.
  const mention = text.match(/^<@!?([^>\s]+)>/);
  if (mention) return authors.get(mention[1]!);

  // Longest name first, so "ro bot" is never shadowed by a burst author called "ro".
  const byName = [...authors.values()]
    .filter((author) => author.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  for (const author of byName) {
    const name = author.name.trim().toLowerCase();
    if (lower.startsWith(`@${name}`)) {
      const after = text.slice(name.length + 1);
      // `@name` is an address on its own; only a word character glued to it means a different name.
      if (after === "" || !/^[\p{L}\p{N}_]/u.test(after)) return author;
      continue;
    }
    if (lower.startsWith(name)) {
      const after = text.slice(name.length);
      if (VOCATIVE.test(after)) return author;
    }
  }
  return undefined;
}

/**
 * Split an outbound reply into per-addressee deliveries, or return `null` to deliver it whole
 * exactly as before. See the module header for the rules; every "not sure" answer is `null`.
 */
export function splitByAddressee(
  text: string,
  burst: readonly BurstAnchor[],
): AnchoredSegment[] | null {
  const body = text.trim();
  if (!body) return null;

  const authors = newestByAuthor(burst);
  // Rule 1 — a single-author burst keeps its single delivery, untouched.
  if (authors.size < 2) return null;

  const paragraphs = body.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);
  if (paragraphs.length < 2) return null;

  const segments: AnchoredSegment[] = [];
  for (const paragraph of paragraphs) {
    const addressed = openingAddressee(paragraph, authors);
    const current = segments[segments.length - 1];
    // Rule 5 — leading text addressed to nobody has no segment to ride with.
    if (!current && !addressed) return null;
    if (addressed && (!current || current.anchor.userId !== addressed.userId)) {
      segments.push({ text: paragraph.trim(), anchor: addressed });
      continue;
    }
    // Rule 4 — an unaddressed paragraph (or a continuation of the same addressee) rides along.
    current!.text = `${current!.text}\n\n${paragraph.trim()}`;
  }

  // Rule 6 — two or more segments, each for a different person, or this is not a real split.
  if (segments.length < 2 || segments.length > MAX_SEGMENTS) return null;
  const addressees = new Set(segments.map((segment) => segment.anchor.userId));
  if (addressees.size !== segments.length) return null;
  return segments;
}
