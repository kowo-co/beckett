# Codemap §4 baseline (before the capability ships)

Exploration-tool calls (`Read` / `Grep` / `Glob`) between run start and first `Edit` / `Write` / `MultiEdit`, from `~/.beckett/journal/<run>.log`. Split by whether the run's brief already named a target file (plan §2: a codemap can only help the unnamed cohort).

Regenerate: `bun scripts/ops/codemap-exploration-baseline.ts`

```
sample: 85 runs  (run-* journals with at least one of those tools)
named a target file:    n=59  mean=7.2  median=6  p90=19  mean-ms-to-first-edit=238053  no-edit=1
did not name a file:    n=26  mean=7.2  median=3  p90=19  mean-ms-to-first-edit=209822  no-edit=3
```

The unnamed cohort's *median* (3) is half the named-file median (6); the means match because a few unnamed runs explore heavily (p90=19 on both sides). `run-20260819-ci-hangs-6h-on-apt-get` is the plan's example class (1 Read before first Edit) and lands unnamed in this sample.

The §7 after-measurement (same split, after this module is on by default) is follow-on work, not this slice.

## Map sample (this repo, trimmed)

```
CODEMAP — file-level hint of this tree, not ground truth.
Generated from <sha> on <branch>. Your own uncommitted edits after this point are invisible to it.
Purpose lines are sourced from each file's header doc-comment, or from exported names when there is no header.

Entry points:
- src/cli/beckett.ts
- src/shell/main.ts

Tests live:
- src/ — 261 test files (`*.test.*` / `*.spec.*`)

## src/capability
src/capability/index.ts — Beckett v5 — the capability spine (`src/capability/index.ts`)
src/capability/builtins.ts — Beckett v5 — builtin capability config fragments (`src/capability/builtins.ts`)

## src/capability/modules
src/capability/modules/codemap.ts — Beckett — the codemap capability (`src/capability/modules/codemap.ts`)
src/capability/modules/github.ts — Beckett v6 — the GitHub extension (`src/capability/modules/github.ts`)

## src/browser
src/browser/attachments.ts — exports: BrowserAttachmentKind, MAX_BROWSER_ATTACHMENT_BYTES, …
```

Header purposes are copied from the file; files without a header degrade to `exports: …` and never invent a sentence.
