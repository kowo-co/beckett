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
import modelRates from "../../config/model-rates.json";
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
  /**
   * Why an IMPLEMENT-stage opus cast clears sonnet's bar (architecture, gnarly debugging,
   * cross-cutting integration — see {@link applySonnetFirst}). Sonnet-first (issue #249): an
   * opus implement cast with no `reason` is downgraded to sonnet at cast-resolution time; one
   * WITH a reason is kept, and the reason rides along on the persisted `run.cast` — the run
   * record — as the "why" a human or the run framer can read back later. Meaningless outside
   * the implement stage (review stays on the strongest tier by design) but harmless there.
   */
  reason?: string;
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
  reason: z.string().min(1).optional(),
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
 * The castable-model roster: exactly the models the rate table prices. A cast naming a model
 * outside it (a typo, a stale id like `claude-opus-4-8`) used to be accepted silently and only
 * surfaced as a mystery in telemetry. If it isn't priced in `config/model-rates.json`, it isn't
 * castable — and a genuinely new model earns castability by getting a rate row, which costing
 * needs anyway. Matched case-insensitively.
 */
const KNOWN_MODELS: ReadonlySet<string> = new Set(
  Object.keys(modelRates.models).map((name) => name.toLowerCase()),
);

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
    } else if (model && !KNOWN_MODELS.has(model)) {
      errors.push(
        `${stage}: unknown model "${spec.model}" — not priced in config/model-rates.json ` +
          `(known: ${[...KNOWN_MODELS].sort().join(", ")}). A new model becomes castable by ` +
          `getting a rate row there first.`,
      );
    }
  }
  return errors;
}

// =======================================================================================
// Sonnet-first (issue #249): the enforced default IMPLEMENT cast
// =======================================================================================

/** The enforced default implement model — CLAUDE.md doctrine, made structural instead of aspirational. */
export const DEFAULT_IMPLEMENT_MODEL = "claude-sonnet-5";

/** True for any opus-tier model id (`claude-opus-5`, the older `claude-opus-4-8`, future SKUs). */
export function isOpusModel(model: string | undefined): boolean {
  return typeof model === "string" && /opus/i.test(model);
}

/** What {@link applySonnetFirst} did, for the caller to log on the run record. */
export interface SonnetFirstResult {
  /** The resolved implement cast — always harness-complete, never `undefined`. */
  spec: HarnessSpec;
  /** Set only when an opus-without-reason cast was downgraded — the note to log on the run. */
  downgradeNote?: string;
}

/**
 * The sonnet-first policy for the IMPLEMENT stage (issue #249; review is untouched — it stays on
 * the strongest tier by design). Four cases:
 *   - no explicit cast at all → the enforced default, `claude-sonnet-5` (previously this fell
 *     through to whichever `harness.claude.default_model` an install's config named, which is
 *     exactly how the betterwright run defaulted onto opus with no directive behind it).
 *   - an explicit `claude` cast naming NO model → the SAME dangerous fallthrough as "no cast at
 *     all" (`{"implement":{"harness":"claude"}}` is valid per {@link validateCasting} and, left
 *     alone, falls through to `config.harness.claude.default_model` at the driver — on a
 *     betterwright-shaped install where that default is opus, this reproduces the exact
 *     un-reasoned, un-logged opus deploy the doctrine exists to prevent). Forced to the enforced
 *     default model rather than passed through model-less.
 *   - an explicit cast naming a NON-opus model (or a non-claude harness) → a requester/framer
 *     directive, honored verbatim (the "cast sonnet"/"cast codex" pass-through this must not
 *     break).
 *   - an explicit opus cast → kept ONLY when it carries a `reason` (the framer's stated case that
 *     this task clears sonnet's bar); with no reason it's downgraded to sonnet and the caller gets
 *     a human-readable note to log on the run record. Note: the CLI boundary that actually mints a
 *     run's cast (`../cli/task-deploy.ts#resolveCast`) auto-stamps a reason on a human-typed
 *     `--cast` naming opus — see that function's doc comment — so this gate in practice only ever
 *     fires for a reason-less opus cast that reached deploy some OTHER way (a raw API/library
 *     caller, a future automated framer that skips the CLI). That is exactly the case doctrine
 *     wants caught.
 */
export function applySonnetFirst(explicit: HarnessSpec | undefined): SonnetFirstResult {
  if (!explicit) return { spec: { harness: "claude", model: DEFAULT_IMPLEMENT_MODEL } };
  if (explicit.harness === "claude" && !explicit.model) {
    return { spec: { ...explicit, model: DEFAULT_IMPLEMENT_MODEL } };
  }
  if (isOpusModel(explicit.model) && !explicit.reason?.trim()) {
    return {
      spec: { ...explicit, model: DEFAULT_IMPLEMENT_MODEL },
      downgradeNote:
        `implement cast "${explicit.model}" had no stated reason — downgraded to ` +
        `${DEFAULT_IMPLEMENT_MODEL} per sonnet-first doctrine (name a reason to keep opus)`,
    };
  }
  return { spec: explicit };
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
