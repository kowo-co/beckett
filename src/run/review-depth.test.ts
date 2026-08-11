/**
 * Review-depth classifier tests (`src/run/review-depth.ts`).
 *
 * Issue #234: a URL typo fix bought 9m36s of opus browser time because the reviewer ran the full
 * five-page visual rubric on a two-character href change. These tests pin the three things that
 * stops: the tier a diff surface earns (with mixed diffs taking the DEEPER tier and anything
 * unrecognized landing on `code`), the changed-href extraction that feeds the content tier's
 * link check, and the journal line that makes the choice visible on the run card.
 *
 * Fixtures are real-shaped unified diffs written inline — the classifier's whole input is diff
 * TEXT, so a fixture that lies about git's output is a test that proves nothing.
 */
import { describe, expect, test } from "bun:test";
import {
  changedExternalHrefs,
  changedFilesFromDiff,
  classifyDiffSurface,
  reviewDepthInstructions,
  reviewDepthLine,
} from "./review-depth.ts";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

/** The #234 diff in miniature: one href swapped, one line of copy, tags untouched. */
const HREF_TYPO_DIFF = `diff --git a/web/public/index.html b/web/public/index.html
index 1111111..2222222 100644
--- a/web/public/index.html
+++ b/web/public/index.html
@@ -12,7 +12,7 @@
   <p>Beckett runs your work as a service.</p>
-  <a class="cta" href="https://exmaple.com/docs">Read the docs</a>
+  <a class="cta" href="https://example.com/docs">Read the docs</a>
   <span>Since 2026</span>
`;

/** Prose only — a docs edit that adds a markdown link. */
const DOCS_DIFF = `diff --git a/docs/runs.md b/docs/runs.md
index 3333333..4444444 100644
--- a/docs/runs.md
+++ b/docs/runs.md
@@ -4,3 +4,4 @@
 Runs replace tickets.
+See the [rollout notes](https://beckett.example/rollout) for the migration.
`;

/** Structure churn: a whole new section appears in the markup. */
const STRUCTURAL_HTML_DIFF = `diff --git a/web/public/index.html b/web/public/index.html
index 1111111..5555555 100644
--- a/web/public/index.html
+++ b/web/public/index.html
@@ -20,6 +20,10 @@
   <p>Beckett runs your work as a service.</p>
+  <section class="pricing">
+    <h2>Pricing</h2>
+    <p>Per run.</p>
+  </section>
`;

const CSS_DIFF = `diff --git a/web/public/app.css b/web/public/app.css
index 6666666..7777777 100644
--- a/web/public/app.css
+++ b/web/public/app.css
@@ -1,3 +1,3 @@
-.cta { padding: 8px; }
+.cta { padding: 12px; border-radius: 6px; }
`;

const TS_DIFF = `diff --git a/src/run/supervisor.ts b/src/run/supervisor.ts
index 8888888..9999999 100644
--- a/src/run/supervisor.ts
+++ b/src/run/supervisor.ts
@@ -692,6 +692,7 @@
     let reviewDiff: string | undefined;
+    const surface = classifyDiffSurface(reviewDiff);
`;

const NEW_PAGE_DIFF = `diff --git a/web/public/pricing.html b/web/public/pricing.html
new file mode 100644
index 0000000..aaaaaaa
--- /dev/null
+++ b/web/public/pricing.html
@@ -0,0 +1,3 @@
+<html>
+  <body><h1>Pricing</h1></body>
+</html>
`;

const CONFIG_DIFF = `diff --git a/package.json b/package.json
index bbbbbbb..ccccccc 100644
--- a/package.json
+++ b/package.json
@@ -3,1 +3,1 @@
-  "version": "7.0.0",
+  "version": "7.0.1",
`;

// ── the classifier table ────────────────────────────────────────────────────────────────────

describe("classifyDiffSurface", () => {
  const table: { name: string; diff: string; depth: "content" | "visual" | "code" }[] = [
    { name: "attribute-only href change in .html → content", diff: HREF_TYPO_DIFF, depth: "content" },
    { name: "pure markdown/docs copy → content", diff: DOCS_DIFF, depth: "content" },
    { name: "structural tag churn in .html → visual", diff: STRUCTURAL_HTML_DIFF, depth: "visual" },
    { name: "a stylesheet touched → visual", diff: CSS_DIFF, depth: "visual" },
    { name: "a new page → visual", diff: NEW_PAGE_DIFF, depth: "visual" },
    { name: "src/**.ts → code", diff: TS_DIFF, depth: "code" },
    { name: "a build/config file → code", diff: CONFIG_DIFF, depth: "code" },
  ];
  for (const row of table) {
    test(row.name, () => {
      expect(classifyDiffSurface(row.diff).depth).toBe(row.depth);
    });
  }

  test("mixed diffs take the DEEPER tier", () => {
    expect(classifyDiffSurface(HREF_TYPO_DIFF + CSS_DIFF).depth).toBe("visual");
    expect(classifyDiffSurface(HREF_TYPO_DIFF + DOCS_DIFF).depth).toBe("content");
    expect(classifyDiffSurface(CSS_DIFF + TS_DIFF).depth).toBe("code");
    expect(classifyDiffSurface(HREF_TYPO_DIFF + CSS_DIFF + TS_DIFF).depth).toBe("code");
  });

  test("a deleted page is a layout change, not a copy change", () => {
    const deleted = HREF_TYPO_DIFF.replace("index 1111111..2222222 100644", "deleted file mode 100644");
    expect(classifyDiffSurface(deleted).depth).toBe("visual");
  });

  test("the changed-file list comes out of the diff's own headers", () => {
    expect(changedFilesFromDiff(HREF_TYPO_DIFF + CSS_DIFF)).toEqual([
      "web/public/index.html",
      "web/public/app.css",
    ]);
    expect(changedFilesFromDiff(undefined)).toEqual([]);
    expect(classifyDiffSurface(HREF_TYPO_DIFF + TS_DIFF).files).toEqual([
      "web/public/index.html",
      "src/run/supervisor.ts",
    ]);
  });

  test("signals record every tier the diff tripped, depth is the deepest", () => {
    const mixed = classifyDiffSurface(DOCS_DIFF + CSS_DIFF + TS_DIFF);
    expect(mixed.signals).toEqual({ content: true, visual: true, code: true });
    expect(mixed.depth).toBe("code");
  });

  test("an unrecognized extension is code — doubt biases DEEPER", () => {
    const odd = `diff --git a/deploy/thing.wat b/deploy/thing.wat
--- a/deploy/thing.wat
+++ b/deploy/thing.wat
@@ -1 +1 @@
-(module)
+(module (func))
`;
    expect(classifyDiffSurface(odd).depth).toBe("code");
  });

  test("no diff at all: no files, deepest tier, and nothing to scale", () => {
    for (const empty of [undefined, "", "   "]) {
      const surface = classifyDiffSurface(empty);
      expect(surface.files).toEqual([]);
      expect(surface.depth).toBe("code");
      expect(reviewDepthLine(surface)).toBe("");
      expect(reviewDepthInstructions(surface)).toBe("");
    }
  });

  test("a caller-supplied file list is folded in, markup without hunks counted structural", () => {
    const surface = classifyDiffSurface(DOCS_DIFF, ["web/public/about.html", "docs/runs.md"]);
    expect(surface.files).toEqual(["docs/runs.md", "web/public/about.html"]);
    expect(surface.depth).toBe("visual");
  });
});

// ── changed hrefs ───────────────────────────────────────────────────────────────────────────

describe("changedExternalHrefs", () => {
  test("picks up the typo'd href from the added line only", () => {
    expect(changedExternalHrefs(HREF_TYPO_DIFF)).toEqual(["https://example.com/docs"]);
  });

  test("markdown links count too", () => {
    expect(changedExternalHrefs(DOCS_DIFF)).toEqual(["https://beckett.example/rollout"]);
  });

  test("relative and in-page links are not external", () => {
    const local = `diff --git a/web/public/index.html b/web/public/index.html
--- a/web/public/index.html
+++ b/web/public/index.html
@@ -1 +1 @@
-<a href="/docs">Docs</a>
+<a href="#docs">Docs</a>
`;
    expect(changedExternalHrefs(local)).toEqual([]);
  });

  test("a url that merely MOVED (present on both sides) is not a changed href", () => {
    const moved = `diff --git a/web/public/index.html b/web/public/index.html
--- a/web/public/index.html
+++ b/web/public/index.html
@@ -1,2 +1,2 @@
-<a href="https://example.com/docs">Docs</a>
-<a href="https://example.com/pricing">Pricing</a>
+<a href="https://example.com/pricing">Pricing</a>
+<a href="https://example.com/docs">Docs</a>
`;
    expect(changedExternalHrefs(moved)).toEqual([]);
  });

  test("http → https on the same host still reads as a change, and duplicates collapse", () => {
    const upgraded = `diff --git a/docs/x.md b/docs/x.md
--- a/docs/x.md
+++ b/docs/x.md
@@ -1,2 +1,2 @@
-See [docs](http://example.com/docs).
+See [docs](https://example.com/docs) and [again](https://example.com/docs).
`;
    expect(changedExternalHrefs(upgraded)).toEqual(["https://example.com/docs"]);
  });

  test("src= attributes count (a broken embed is a broken link)", () => {
    const embed = `diff --git a/web/public/index.html b/web/public/index.html
--- a/web/public/index.html
+++ b/web/public/index.html
@@ -1 +1 @@
-<img src="https://cdn.example/a.png">
+<img src="https://cdn.example/b.png">
`;
    expect(changedExternalHrefs(embed)).toEqual(["https://cdn.example/b.png"]);
  });
});

// ── the journal line ────────────────────────────────────────────────────────────────────────

describe("reviewDepthLine", () => {
  test("reads exactly like the issue asked", () => {
    expect(reviewDepthLine(classifyDiffSurface(HREF_TYPO_DIFF))).toBe(
      "review depth: content (1 file, copy/href only)",
    );
    expect(reviewDepthLine(classifyDiffSurface(HREF_TYPO_DIFF + DOCS_DIFF))).toBe(
      "review depth: content (2 files, copy/href only)",
    );
  });

  test("a deeper tier names the file that forced it", () => {
    expect(reviewDepthLine(classifyDiffSurface(HREF_TYPO_DIFF + CSS_DIFF))).toBe(
      "review depth: visual (2 files, styles/scripts/assets: web/public/app.css)",
    );
    expect(reviewDepthLine(classifyDiffSurface(TS_DIFF))).toBe(
      "review depth: code (1 file, source/config: src/run/supervisor.ts)",
    );
  });
});

// ── the depth-scaled instructions ───────────────────────────────────────────────────────────

describe("reviewDepthInstructions", () => {
  test("content tier: no visual rubric, targeted render, and the link check with the hrefs", () => {
    const text = reviewDepthInstructions(classifyDiffSurface(HREF_TYPO_DIFF));
    expect(text).toContain("Review depth: CONTENT");
    expect(text).toContain("do NOT run the full visual browser");
    expect(text).toContain("Render at most the pages this diff touches");
    expect(text).toContain("LINK CHECK (required)");
    expect(text).toContain("HTTP 200");
    expect(text).toContain("- https://example.com/docs");
  });

  test("content tier with no changed hrefs says there is nothing to fetch", () => {
    const text = reviewDepthInstructions(classifyDiffSurface(DOCS_DIFF.replace(/\(https:[^)]+\)/, "(./x.md)")));
    expect(text).toContain("Review depth: CONTENT");
    expect(text).toContain("no external href was added or changed");
    expect(text).not.toContain("LINK CHECK (required)");
  });

  test("visual tier orders the full rubric", () => {
    const text = reviewDepthInstructions(classifyDiffSurface(CSS_DIFF));
    expect(text).toContain("Review depth: VISUAL");
    expect(text).toContain("Run the FULL visual rubric");
    expect(text).not.toContain("LINK CHECK");
  });

  test("code tier reviews code, and re-adds the visual rubric when the diff also touched it", () => {
    const pure = reviewDepthInstructions(classifyDiffSurface(TS_DIFF));
    expect(pure).toContain("Review depth: CODE");
    expect(pure).toContain("Review it as CODE");
    expect(pure).not.toContain("also touches stylesheets");

    const mixed = reviewDepthInstructions(classifyDiffSurface(TS_DIFF + CSS_DIFF));
    expect(mixed).toContain("Review depth: CODE");
    expect(mixed).toContain("also touches stylesheets/scripts/markup");
  });

  test("a long href list is truncated with a count rather than flooding the brief", () => {
    const links = Array.from({ length: 30 }, (_, i) => `+<a href="https://example.com/${i}">x</a>`).join("\n");
    const diff = `diff --git a/web/public/links.html b/web/public/links.html
--- a/web/public/links.html
+++ b/web/public/links.html
@@ -1 +1,30 @@
${links}
`;
    // 30 added anchors is tag churn, so this is a VISUAL diff — the extraction still holds.
    expect(changedExternalHrefs(diff)).toHaveLength(30);
    const surface = { ...classifyDiffSurface(diff), depth: "content" as const };
    const text = reviewDepthInstructions(surface);
    expect(text).toContain("https://example.com/24");
    expect(text).not.toContain("https://example.com/25");
    expect(text).toContain("(+5 more in the diff)");
  });
});
