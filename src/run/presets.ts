/**
 * Beckett — user-defined cast presets ("flows") (`src/run/presets.ts`)
 * =======================================================================================
 * OPS-110. A preset is a USER-NAMED cast: pick, say, Fable as the reviewer and Sonnet 5 as the
 * implementer, name it whatever you like, and reuse it by name via `beckett preset
 * show <name>` / a cast flag. The whole point is that presets live OUTSIDE the daemon source:
 *
 *   ~/.beckett/presets.json    { "<preset-name>": <cast-object>, ... }
 *
 * Editing or adding a preset is editing that file — it takes effect on the very next run with
 * ZERO rebuild and ZERO daemon restart, because {@link loadPresets} reads the file FRESH on every
 * invocation (no in-process cache that a restart would be needed to bust). The daemon that runs
 * workers never reads this file; presets are pure sugar over the existing `--cast` object, resolved
 * at deploy time in the CLI.
 *
 * A `<cast-object>` is exactly the `--cast` shape ({@link Casting}) — `{ "implement": {...},
 * "review": {...} }` — and PARTIAL presets are allowed (e.g. only a `review` stage). Every preset's
 * cast is validated on load against the roster ({@link validateCasting}, the shared source of
 * truth): a blocked model (SOL / bare gpt-5.6) or a malformed harness/model/effort throws a clear
 * error naming the preset, so a broken cast is never silently deployed.
 *
 * Import style: explicit `.ts` extensions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Casting } from "./cast.ts";
import { validateCasting } from "./cast.ts";

/** name → cast-object. The on-disk shape of `presets.json`, and what {@link loadPresets} returns. */
export type PresetMap = Record<string, Casting>;

/**
 * The seed presets written to a fresh `presets.json` — the four from the OPS-109 design doc
 * (`docs/design/cast-presets.md`). This is a SEED, not a compiled-in table: once the file exists,
 * it is the source of truth and these defaults are never consulted again. Users edit / add / delete
 * freely; deleting the file and re-running re-seeds it.
 */
export const SEED_PRESETS: PresetMap = {
  // INT's full three-stage chain: independent design, cheap implementation, fresh review.
  intensive: {
    design: { harness: "claude", model: "claude-opus-5", effort: "high" },
    implement: { harness: "pi", effort: "medium" },
    review: { harness: "claude", model: "claude-sonnet-5", effort: "high" },
  },
  // Mechanical grind — cheapest seat, one pass (design doc §4.1).
  "cheap-lane": { implement: { harness: "pi", model: "gpt-5.6-luna", effort: "low" } },
  // Frontend / visual / taste — Opus implements, forced one-pass (design doc §4.4).
  "taste-lane": { implement: { harness: "claude", model: "claude-opus-5", effort: "high", reviewTier: "self" } },
  // Critical but cost-aware — terra implements cheap, Fable adjudicates (design doc §4.7). ⚠ confirm Fable first.
  "fable-review+terra-work": {
    implement: { harness: "pi", effort: "high" },
    review: { harness: "claude", model: "claude-fable-5", effort: "high" },
  },
  // Hard-to-reverse AND hard-to-get-right — Fable both seats (design doc §4.8). ⚠ confirm Fable first.
  "critical": {
    implement: { harness: "claude", model: "claude-fable-5", effort: "high" },
    review: { harness: "claude", model: "claude-fable-5", effort: "high" },
  },
};

/** Serialize the seed presets to the pretty JSON we write into a fresh file. */
function seedFileContents(): string {
  return JSON.stringify(SEED_PRESETS, null, 2) + "\n";
}

/**
 * Read `presets.json` FRESH from disk and return the validated preset map. Called on every deploy —
 * NO caching, so a just-saved edit takes effect on the next run with no restart.
 *
 * - Missing file → created, seeded with {@link SEED_PRESETS}, and that seed returned.
 * - Not valid JSON, or not a top-level object → throws with the path and the parse error.
 * - Any preset whose cast fails {@link validateCasting} (blocked model, malformed harness/model/
 *   effort) → throws naming the preset and every problem. Never returns a partially-broken map.
 */
export function loadPresets(file: string): PresetMap {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, seedFileContents());
    return structuredClone(SEED_PRESETS);
  }

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read presets file ${file}: ${(err as Error).message}`);
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`presets file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error(`presets file ${file} must be a JSON object of { "<preset-name>": <cast>, ... }`);
  }

  const presets: PresetMap = {};
  for (const [name, cast] of Object.entries(obj as Record<string, unknown>)) {
    const errors = validateCasting(cast);
    if (errors.length > 0) {
      throw new Error(
        `preset "${name}" in ${file} is invalid — fix the file (no rebuild needed):\n  - ` +
          errors.join("\n  - "),
      );
    }
    presets[name] = cast as Casting;
  }
  return presets;
}

/**
 * Look a preset up by name, failing LOUDLY (throw) if it is unknown — the message lists every
 * available name so a typo is self-correcting. Names are matched exactly (case-sensitive) so
 * `critical` and `Critical` stay distinct user flows.
 */
export function requirePreset(presets: PresetMap, name: string): Casting {
  const cast = presets[name];
  if (!cast) {
    const available = Object.keys(presets);
    throw new Error(
      `unknown --preset "${name}". Available presets: ${
        available.length ? available.join(", ") : "(none — presets.json is empty)"
      }`,
    );
  }
  return cast;
}

/**
 * Resolve the final casting for a run from a preset + an explicit override. PRECEDENCE, per
 * stage: the explicit cast WINS for every stage it names (it replaces that stage's spec wholesale),
 * and the preset fills in the stages the explicit cast omits. So
 * `--preset fable-review+terra-work --cast '{"implement":{"harness":"pi","effort":"xhigh"}}'`
 * keeps the preset's Fable `review` and swaps in the explicit `implement`. This is a shallow
 * per-stage merge — an explicit stage is not deep-merged into the preset's, it replaces it.
 */
export function resolveCasting(preset: Casting | undefined, explicit: Casting): Casting {
  return { ...(preset ?? {}), ...explicit };
}
