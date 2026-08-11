/**
 * Beckett — review depth scaled to the diff surface (`src/run/review-depth.ts`)
 * =======================================================================================
 * WHAT KIND OF REVIEW THIS DIFF DESERVES. Issue #234: a URL typo fix bought 9m36s of opus browser
 * time because the reviewer re-ran a full five-page visual rubric on a two-character href change.
 * The rubric was right for a redesign and pure waste for a copy diff, and nothing in the prompt
 * told the reviewer which one it was holding.
 *
 * This module is the missing signal: a PURE classifier over the run's unified diff that answers
 * "what surface changed" in three explainable tiers —
 *
 *   - `content` — copy / href / docs only (.md/.txt and .html whose hunks change attributes and
 *     text but no tag structure). Cheapest rubric: read the diff, render only what it touches.
 *   - `visual`  — stylesheets, scripts, assets, structural markup churn, added/deleted pages.
 *     Today's full visual rubric.
 *   - `code`    — source / build / config. Today's code-review behavior.
 *
 * Two rules keep it honest. MIXED DIFFS TAKE THE DEEPER TIER ({@link DEPTH_RANK}: content <
 * visual < code), and ANYTHING UNRECOGNIZED IS CODE — a classifier that guesses shallow buys the
 * exact failure #234 is about, one class up the stack. A code-tier diff that ALSO touches visual
 * files says so in its instructions rather than dropping the visual rubric on the floor.
 *
 * This axis is orthogonal to `reviewTier` (`./cast.ts#HarnessSpec.reviewTier`): reviewTier picks
 * WHO reviews (self vs a fresh adversarial reviewer), depth picks HOW DEEP the rubric goes. Both
 * apply; neither replaces the other.
 *
 * PURITY IS THE CONTRACT. The link check in the content tier is an INSTRUCTION to the review
 * worker (which has network at prod runtime), never a fetch from here — the supervisor stays
 * pure and the tests stay off the network.
 *
 * Import style: explicit `.ts` extensions.
 */

// =======================================================================================
// The tiers
// =======================================================================================

/** How deep a review's rubric should go, keyed to what the diff actually touched. */
export type ReviewDepth = "content" | "visual" | "code";

/**
 * Depth ordering for mixed diffs — a diff that trips several tiers is reviewed at the DEEPEST one
 * it trips. `code` sits deepest deliberately: an unrecognized or source-level change is the one we
 * must never under-review, and the code tier's instructions re-add the visual rubric when the same
 * diff also touched rendered surfaces (see {@link reviewDepthInstructions}).
 */
export const DEPTH_RANK: Readonly<Record<ReviewDepth, number>> = { content: 0, visual: 1, code: 2 };

/** The classification of one run's diff — the whole input to the depth-scaled review prompt. */
export interface DiffSurface {
  /** The tier the review should run at (deepest tier any changed file trips). */
  depth: ReviewDepth;
  /** Changed paths in diff order (post-image path for renames). */
  files: string[];
  /** Short, human-readable justification for `depth` — the journal line's parenthetical. */
  reason: string;
  /** External (http/https) hrefs ADDED OR CHANGED by this diff, in first-seen order. */
  changedHrefs: string[];
  /** Which tiers the diff tripped at all — `depth` is the deepest of these. */
  signals: Readonly<Record<ReviewDepth, boolean>>;
}

// =======================================================================================
// Extension tables
// =======================================================================================

/** Prose files: a diff confined to these is copy, never structure. */
const DOC_EXTS = new Set(["md", "mdx", "markdown", "txt", "rst", "adoc"]);

/** Markup that MIGHT be pure copy — decided per-file by hunk inspection, not by extension. */
const MARKUP_EXTS = new Set(["html", "htm"]);

/** Styles, browser scripts, and shipped assets — anything here forces at least the visual tier. */
const VISUAL_EXTS = new Set([
  "css", "scss", "sass", "less", "styl",
  "js", "mjs", "cjs", "jsx", "vue", "svelte",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp",
  "woff", "woff2", "ttf", "otf", "eot",
]);

/** Above this many hrefs the link-check block lists a prefix and counts the rest. */
const MAX_LINK_CHECK_HREFS = 25;

// =======================================================================================
// Unified-diff parsing
// =======================================================================================

/** One file's slice of a unified diff — enough to judge its surface without touching the repo. */
interface FileDiff {
  path: string;
  added: string[];
  removed: string[];
  created: boolean;
  deleted: boolean;
}

/** `diff --git a/<old> b/<new>` — the only file boundary git guarantees in every diff we read. */
const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Split a unified diff into per-file slices. Tolerant by design: a truncated or unusual diff
 * yields whatever files it can name rather than throwing — the caller's fallback for "no files"
 * is the un-scaled review, which is exactly today's behavior.
 */
function parseUnifiedDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  let current: FileDiff | undefined;
  for (const line of diff.split("\n")) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      current = { path: header[2]!, added: [], removed: [], created: false, deleted: false };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.created = true;
    else if (line.startsWith("deleted file mode")) current.deleted = true;
    else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length).trim();
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return out;
}

/**
 * The changed-file list carried by a unified diff. This is HOW the supervisor gets a file list at
 * review-cast time: it pre-reads the diff (`supervisor.ts` step 6, `git.readDiff(workspace,
 * baseRef)`) and the paths come out of that diff's own headers — the same extraction the review
 * prompt already uses to summarize an over-large diff.
 */
export function changedFilesFromDiff(diff: string | undefined): string[] {
  return diff ? parseUnifiedDiff(diff).map((f) => f.path) : [];
}

/** Lowercased extension of a path (`""` for extensionless or dotfile names → treated as config). */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

// =======================================================================================
// Structural-churn detection (the .html judgement call)
// =======================================================================================

/** Tag tokens on a line — `<a`, `</a`, `<img` — as a stable sorted key. */
function tagKey(lines: string[]): string {
  const tags: string[] = [];
  for (const line of lines) {
    for (const m of line.matchAll(/<(\/?)([a-zA-Z][\w:-]*)/g)) tags.push(`${m[1]}${m[2]!.toLowerCase()}`);
  }
  return tags.sort().join(",");
}

/**
 * Did this markup file's hunks churn TAG STRUCTURE, or only attributes and text? The heuristic is
 * deliberately blunt and explainable: compare the multiset of tag tokens on the added lines with
 * the removed ones. `<a href="old">Docs</a>` → `<a href="new">Docs</a>` keeps `a,/a` on both
 * sides (content); adding a `<section>`, deleting a `<p>`, or reordering the DOM does not (visual).
 * Anything that does not match exactly is called structural — doubt biases DEEPER.
 */
function hasStructuralChurn(file: FileDiff): boolean {
  return tagKey(file.added) !== tagKey(file.removed);
}

// =======================================================================================
// Per-file classification
// =======================================================================================

/** One file's tier plus the phrase that explains it, for the journal line. */
interface FileVerdict {
  depth: ReviewDepth;
  why: string;
}

function classifyFile(file: FileDiff): FileVerdict {
  const ext = extensionOf(file.path);
  if (DOC_EXTS.has(ext)) return { depth: "content", why: `docs: ${file.path}` };
  if (MARKUP_EXTS.has(ext)) {
    // A page that appeared or vanished is a layout change no matter how its hunks read.
    if (file.created) return { depth: "visual", why: `new page: ${file.path}` };
    if (file.deleted) return { depth: "visual", why: `deleted page: ${file.path}` };
    return hasStructuralChurn(file)
      ? { depth: "visual", why: `structural markup: ${file.path}` }
      : { depth: "content", why: `copy/href: ${file.path}` };
  }
  if (VISUAL_EXTS.has(ext)) return { depth: "visual", why: `styles/scripts/assets: ${file.path}` };
  return { depth: "code", why: `source/config: ${file.path}` };
}

// =======================================================================================
// Changed external hrefs (the content tier's link check)
// =======================================================================================

/** `href="…"` / `src='…'` in markup. */
const ATTR_URL = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
/** `[label](https://…)` in markdown, angle-bracket form included. */
const MD_URL = /\]\(\s*<?([^)>\s]+)/g;

function urlsIn(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const m of line.matchAll(ATTR_URL)) out.push(m[1]!);
    for (const m of line.matchAll(MD_URL)) out.push(m[1]!);
  }
  return out
    .map((u) => u.trim().replace(/[.,;:]+$/, ""))
    .filter((u) => /^https?:\/\//i.test(u));
}

/**
 * Every external href this diff ADDED OR CHANGED. A URL that also appears on a removed line was
 * moved, not edited, so it is dropped — the reviewer's fetch budget belongs to links that are new
 * or newly-typo'd. `http://a` → `https://a` reads as a change (different strings), as it should.
 */
export function changedExternalHrefs(diff: string | undefined): string[] {
  if (!diff) return [];
  const files = parseUnifiedDiff(diff);
  const before = new Set(files.flatMap((f) => urlsIn(f.removed)));
  const out: string[] = [];
  for (const url of files.flatMap((f) => urlsIn(f.added))) {
    if (before.has(url) || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

// =======================================================================================
// The classifier
// =======================================================================================

/**
 * Classify a run's diff surface. PURE: no IO, no network, no repo access — everything it knows
 * comes from the unified diff text (and, optionally, a changed-file list a caller already holds
 * from another source, e.g. a done-signal's `filesChanged`; those files are classified by PATH
 * alone, so a markup file named there counts as structural — doubt biases deeper).
 *
 * An absent or fileless diff yields `code` with `files: []`, and the prompt/journal helpers below
 * both no-op on that — a run whose diff pre-read failed reviews exactly as it does today.
 */
export function classifyDiffSurface(diff: string | undefined, extraFiles: string[] = []): DiffSurface {
  const parsed = diff ? parseUnifiedDiff(diff) : [];
  const seen = new Set(parsed.map((f) => f.path));
  const verdicts: FileVerdict[] = parsed.map(classifyFile);
  for (const path of extraFiles) {
    if (seen.has(path)) continue;
    seen.add(path);
    // No hunks to inspect: a markup path with unknown hunks is treated as structural.
    const ext = extensionOf(path);
    const bare: FileDiff = { path, added: [], removed: [], created: false, deleted: false };
    verdicts.push(
      MARKUP_EXTS.has(ext) ? { depth: "visual", why: `markup (no hunks): ${path}` } : classifyFile(bare),
    );
  }

  const files = [...seen];
  const signals = { content: false, visual: false, code: false };
  for (const v of verdicts) signals[v.depth] = true;

  let depth: ReviewDepth = "content";
  let why = "copy/href only";
  for (const v of verdicts) {
    if (DEPTH_RANK[v.depth] > DEPTH_RANK[depth]) {
      depth = v.depth;
      why = v.why;
    }
  }
  if (files.length === 0) return { depth: "code", files, reason: "no diff available", changedHrefs: [], signals };
  // The content tier's justification is the ABSENCE of anything deeper — naming one of twelve
  // touched files would be noise, so it keeps the categorical phrase.
  const reason = depth === "content" ? "copy/href only" : why;
  return { depth, files, reason, changedHrefs: changedExternalHrefs(diff), signals };
}

// =======================================================================================
// The journal line
// =======================================================================================

/**
 * The one line the supervisor journals at review-cast time, e.g.
 * `review depth: content (12 files, copy/href only)` — so the choice to skip the five-page rubric
 * is visible on the run card instead of being an invisible prompt difference. Empty string when
 * there is nothing to report (no diff), which the caller treats as "log nothing".
 */
export function reviewDepthLine(surface: DiffSurface): string {
  if (surface.files.length === 0) return "";
  const n = surface.files.length;
  return `review depth: ${surface.depth} (${n} file${n === 1 ? "" : "s"}, ${surface.reason})`;
}

// =======================================================================================
// The depth-scaled review instructions
// =======================================================================================

/** The link-check bullet — the #234 fix proper: verify every href this diff added or changed. */
function linkCheckBlock(hrefs: string[]): string {
  if (hrefs.length === 0) {
    return `- LINK CHECK: no external href was added or changed in this diff — nothing to fetch.`;
  }
  const shown = hrefs.slice(0, MAX_LINK_CHECK_HREFS);
  const more = hrefs.length - shown.length;
  const list = shown.map((h) => `  - ${h}`).join("\n") + (more > 0 ? `\n  - (+${more} more in the diff)` : "");
  return (
    `- LINK CHECK (required): every external href ADDED OR CHANGED below must RESOLVE. Request each ` +
    `one and confirm it lands on HTTP 200 (a 30x that ends in a 200 is fine). A 404, a timeout, a ` +
    `DNS failure, or a redirect to something unrelated FAILS the review — quote the offending URL ` +
    `in your verdict. Hrefs added or changed in this diff:\n${list}`
  );
}

/**
 * The `<review-depth>` block appended to a review brief: what rubric to run, scaled to the surface
 * the diff actually touched. Returns `""` when the diff is unknown, so a review with no pre-read
 * diff keeps today's un-scaled behavior verbatim.
 */
export function reviewDepthInstructions(surface: DiffSurface): string {
  if (surface.files.length === 0) return "";
  const head = `Review depth: ${surface.depth.toUpperCase()} — ${surface.files.length} file${
    surface.files.length === 1 ? "" : "s"
  }, ${surface.reason}.`;

  if (surface.depth === "content") {
    return (
      `\n\n<review-depth>\n${head}\n` +
      `This diff changes copy, links, and docs only — no stylesheets, no scripts, no source, no ` +
      `structural markup. Scale the review to that surface, and do NOT run the full visual browser ` +
      `rubric:\n` +
      `- Judge the diff itself: wording, factual accuracy, typos, and the validity of the markup on ` +
      `the touched lines.\n` +
      `- Render at most the pages this diff touches, and only when a rendered view is the ONLY way ` +
      `to judge the change. For pure copy and link fixes, skip rendering entirely.\n` +
      `${linkCheckBlock(surface.changedHrefs)}\n` +
      `</review-depth>`
    );
  }

  if (surface.depth === "visual") {
    return (
      `\n\n<review-depth>\n${head}\n` +
      `This diff touches stylesheets, scripts, assets, structural markup, or pages that were added ` +
      `or deleted. Run the FULL visual rubric: render every affected page and judge layout, ` +
      `spacing, typography, contrast, responsive behavior, and interactive states against the ` +
      `acceptance criteria.\n` +
      `</review-depth>`
    );
  }

  const alsoVisual = surface.signals.visual
    ? `\nPart of this diff also touches stylesheets/scripts/markup — run the visual rubric on those ` +
      `files too.`
    : "";
  return (
    `\n\n<review-depth>\n${head}\n` +
    `This diff touches source, build, or config files. Review it as CODE: correctness, edge cases, ` +
    `error paths, test coverage, and every acceptance criterion. No page-by-page visual rubric is ` +
    `needed for the parts that render nothing.${alsoVisual}\n` +
    `</review-depth>`
  );
}
