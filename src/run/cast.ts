/**
 * Beckett v7 — casting (`src/run/cast.ts`)
 * =======================================================================================
 * WHICH HARNESS/MODEL RUNS EACH STAGE. This module is what survived the ticket rip-out: the
 * `--cast` concept outlived the tracker it used to be smuggled through. Under the ticket system a
 * cast travelled inside a ticket description as a ```beckett-cast``` fenced block, so this file's
 * ancestor (`src/tracker/cast.ts`) was half zod schema and half markdown codec. A run carries its
 * cast as a first-class field ({@link Run.cast}, persisted in `runs.json`) and its brief as
 * `spec.md`, so the codec half has no reader left and is gone; the schema half — the SINGLE source
 * of truth for "is this cast fileable" — moved here intact.
 *
 * The two entry points differ in posture on purpose:
 *   - {@link parseCastJson} is TOLERANT (a malformed persisted cast degrades to `{}`),
 *   - {@link validateCasting} is STRICT (a human-typed `--cast` / a preset file must be refused
 *     loudly rather than silently deployed on defaults).
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions.
 */

import { z } from "zod";
import { availableHarnesses, isRegisteredHarness } from "../drivers/index.ts";

// =======================================================================================
// Casting — which harness/model runs each stage
// =======================================================================================

/**
 * A coding-agent CLI Beckett drives as a worker (matches root `Harness`). Open toward a
 * registry-validated string: the in-tree core `claude`/`codex`/`pi` stay literals for autocomplete,
 * but which harness names are actually castable is decided at runtime by the driver registry
 * (`isRegisteredHarness`), not by this type — see {@link validateCasting}.
 */
export type HarnessName = "claude" | "codex" | "pi" | (string & {});

/** One stage's harness selection: which CLI, optionally which model + reasoning effort. */
export interface HarnessSpec {
  harness: HarnessName;
  model?: string;
  // "ultracode" (claude-only, 2.1.203+) — automatic workflow orchestration on top of xhigh
  // reasoning. See root `Effort` (src/types.ts) for the shared union this mirrors.
  effort?: "low" | "medium" | "high" | "xhigh" | "ultracode";
  /**
   * Review gate (set on the `implement` cast). `self` = the implement worker self-verifies inline
   * and the work goes straight to publish (one pass, no separate reviewer). `fresh` = a separate
   * adversarial reviewer runs. Unset ⇒ derived from `effort` (low/medium → self; otherwise fresh).
   */
  reviewTier?: "self" | "fresh";
}

/**
 * Per-stage casting for a run. `implement` staffs the implementing worker and `review` staffs the
 * reviewer. Open-ended by shape (future stages key in by name), though `beckett task deploy`
 * refuses anything but implement/review — see `../cli/task-deploy.ts#resolveCast`.
 */
export interface Casting {
  implement?: HarnessSpec;
  review?: HarnessSpec;
  [stage: string]: HarnessSpec | undefined;
}

// =======================================================================================
// zod schema for cast JSON (external input — validate, never trust)
// =======================================================================================

/**
 * `harness` is validated against the driver REGISTRY (`src/drivers/index.ts`), not a hardcoded
 * `claude|codex|pi` enum — so registering a new driver makes it castable with no edit here. With
 * only the three in-tree drivers registered this accepts exactly `claude|codex|pi`, as before.
 */
const HarnessSpecSchema: z.ZodType<HarnessSpec> = z.object({
  harness: z.string().refine(isRegisteredHarness, {
    message: `unknown harness — must be one of: ${availableHarnesses().join(", ")}`,
  }),
  model: z.string().min(1).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "ultracode"]).optional(),
  reviewTier: z.enum(["self", "fresh"]).optional(),
}).refine((spec) => spec.effort !== "ultracode" || spec.harness === "claude", {
  // "ultracode" is claude-only — codex/pi don't implement it; without this the fail-fast a plain
  // effort enum used to give at parse time is lost, and an "ultracode" cast on another harness only
  // fails opaquely at harness runtime (codex.ts writes model_reasoning_effort="ultracode"; pi.ts
  // passes --thinking ultracode).
  message: `effort "ultracode" is claude-only — cast harness "claude", not another harness`,
});

/** A casting object is a map of stage-name → HarnessSpec (implement/review + open-ended). */
const CastingSchema = z.record(z.string(), HarnessSpecSchema);

/**
 * Parse + validate a raw cast JSON string into a {@link Casting}. Returns an empty casting (`{}`)
 * on any parse/validation failure — a corrupted persisted cast must not crash a read.
 */
export function parseCastJson(raw: string): Casting {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = CastingSchema.safeParse(obj);
  return result.success ? (result.data as Casting) : {};
}

/**
 * pi-tier models hard-blocked on our ChatGPT-account tier ("not supported with a ChatGPT
 * account"). Only `gpt-5.6-terra` (default) and `gpt-5.6-luna` are castable on `pi`; SOL and bare
 * `gpt-5.6` must never reach a worker. Matched case-insensitively against a stage's `model`.
 */
export const BLOCKED_MODELS: ReadonlySet<string> = new Set(["sol", "gpt-5.6"]);

/**
 * Validate a {@link Casting} against the roster rules, returning a list of human-readable errors
 * (`[]` ⇒ valid, deployable). The SINGLE SOURCE OF TRUTH for "is this cast fileable": it reuses the
 * same {@link CastingSchema} the tolerant reader trusts for SHAPE (harness ∈ the driver registry,
 * effort ∈ low|medium|high|xhigh|ultracode, `model` a non-empty string) and layers on the doctrine
 * BLOCKLIST (SOL / bare `gpt-5.6` are not on our tier). Callers that must not silently deploy a
 * broken cast (the preset loader, `beckett task deploy`) run this and refuse when it returns errors.
 */
export function validateCasting(casting: unknown): string[] {
  const parsed = CastingSchema.safeParse(casting);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => {
      const where = issue.path.length ? issue.path.join(".") : "(root)";
      return `${where}: ${issue.message}`;
    });
  }
  const errors: string[] = [];
  for (const [stage, spec] of Object.entries(parsed.data)) {
    if (!spec) continue;
    const model = spec.model?.trim().toLowerCase();
    if (model && BLOCKED_MODELS.has(model)) {
      errors.push(
        `${stage}: model "${spec.model}" is hard-blocked on our tier (not supported with a ` +
          `ChatGPT account) — cast gpt-5.6-terra or gpt-5.6-luna instead`,
      );
    }
  }
  return errors;
}

// =======================================================================================
// Project slugs
// =======================================================================================

/**
 * Normalize a project name into a filesystem/GitHub-safe slug (lowercase, hyphenated). Lives here
 * rather than in a git/path module because every caller reaches it through the same door a cast
 * does: `--repo`/`--project` is external input resolved at deploy time.
 */
export function projectSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  // `path.join(root, "." | "..")` normalizes outside the per-project directory. Dot-only names
  // are not useful GitHub repo names either, so collapse the two special path segments to a safe
  // deterministic slug at the shared normalization boundary.
  return slug === "" || slug === "." || slug === ".." ? "project" : slug;
}
