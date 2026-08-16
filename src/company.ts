/**
 * Beckett — the company brief (`src/company.ts`)
 * =======================================================================================
 * The CTO seat's only input about the business (`src/concierge/playbooks/the-cto-seat.md`). A
 * flat markdown file, not a memory node or a config key, on purpose: a memory graph node nobody
 * populates is worse than nothing, and a config key implies Beckett is allowed to set its own
 * answers. This file is a human's — jason writes it, Beckett only reads it — so the seed ships
 * with questions and nothing else. A brief Beckett wrote for itself would be Beckett's own
 * assumptions handed back with more confidence, which defeats the entire point of having one.
 *
 * Modeled on `src/pause.ts`: a path helper, a fail-safe reader that never throws, and a seed that
 * refuses to ever overwrite an existing file. EXISTENCE of an answered brief is what makes the
 * seat useful; the seed's only job is to make sure a fresh install has somewhere to write one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "./types.ts";

/** Absolute path of the company brief — `<beckettDir>/company.md` (also `Paths.companyFile`). */
export function companyFilePath(beckettDir: string): string {
  return join(beckettDir, "company.md");
}

/** The brief as written, or null when it is absent, unreadable, or blank. Never throws. */
export function readCompanyBrief(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    return raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Seed the brief with questions on first boot. Existing file → untouched, always: this file
 * is a human's, and the seed must never be able to overwrite an answered brief. Returns true
 * only when it actually wrote one. A failure logs and returns false; a brief nobody can write
 * is not a reason a daemon fails to boot.
 */
export function seedCompanyBrief(file: string, logger?: Logger): boolean {
  if (existsSync(file)) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, DEFAULT_COMPANY_BRIEF);
    return true;
  } catch (err) {
    logger?.warn(`could not seed company brief at ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** The template a fresh install gets: the questions, and no answers. */
export const DEFAULT_COMPANY_BRIEF = `# Kowo — the company brief

This file is the CTO seat's only input about the business
(\`src/concierge/playbooks/the-cto-seat.md\`). Beckett reads it. A human writes it. It is seeded with
questions and nothing else, on purpose: a brief Beckett wrote for itself would be Beckett's own
assumptions handed back with more confidence.

Answer what you can and leave the rest. An unanswered question here is a real finding — Beckett is
told to say "I don't know what X is and this decision turns on it" rather than invent a number.
Edit this file whenever the answers change; nothing caches it.

## What Kowo is

<!-- One paragraph. What the company does, for whom, and why it exists. -->

## The portfolio

<!-- One row per product, including the ones you are not proud of.
     Status: shipped / in build / experiment / dormant / dead.
     Users and Revenue: a number if you have one, the word "unknown" if you don't. Never a guess. -->

| Product | What it is | Status | Users | Revenue | Owner |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## Who the customers are

<!-- Who actually uses this, who pays, how they found it. Named accounts if there are any. -->

## The next 90 days

<!-- What is supposed to happen, in order, and what is already committed to somebody. -->

## Off-limits

<!-- What Beckett must not propose, touch, or discuss publicly: work under NDA, a product being
     wound down quietly, anything with a legal or partner constraint. -->

## What a win looks like

<!-- How you would know the next quarter went well — the one or two numbers that decide it. -->

## Open questions

<!-- What you don't know yet. Beckett reads these as standing questions and may answer one with
     evidence, in channel, instead of guessing. -->
`;
