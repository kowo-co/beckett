/**
 * Beckett — harness driver registry (`src/drivers/index.ts`)
 * =======================================================================================
 * The tiny lookup the {@link WorkerManager} uses to pick a concrete {@link HarnessDriver}
 * for a node's chosen harness (Spec 02 §3). Dependency inversion: the control plane and DAG
 * executor never `new` a driver — they ask the registry for one and hold only the typed
 * interface.
 *
 * Registered today: Claude for live steering, Codex for one-shot `codex exec`, Pi for one-shot
 * `pi -p`, and Cursor — an IMPLEMENTER-ONLY seat running Cursor's agent loop in local mode via
 * a spawned shim. Asking for anything else fails loudly rather than silently degrading.
 *
 * A row carries two things beyond the factory: how to preflight the harness, and whether it may
 * staff `review` ({@link DriverRegistration.reviewCapable}). The second is what makes
 * implement-only a CAPABILITY rather than a convention someone has to remember.
 */

import type { Config, Harness, HarnessDriver, Logger } from "../types.ts";
import { ClaudeDriver, claudePreflight } from "./claude.ts";
import { CodexDriver, codexPreflight } from "./codex.ts";
import { PiDriver, piPreflight } from "./pi.ts";
import { CursorDriver, cursorPreflight } from "./cursor.ts";
import { activeCooldown, clearCooldown } from "./cooldown.ts";

export { ClaudeDriver } from "./claude.ts";
export { CodexDriver } from "./codex.ts";
export { PiDriver } from "./pi.ts";
export { CursorDriver } from "./cursor.ts";

/** Builds a fresh driver instance (one driver == one harness process). */
export type DriverFactory = (config: Config, logger?: Logger) => HarnessDriver;

/** The common shape of the per-driver preflights (binary, version, auth artifact). */
export interface PreflightResult {
  ok: boolean;
  problems: string[];
  /**
   * Set (with the cooldown's expiry epoch ms) when `ok` is false BECAUSE the harness is inside a
   * persisted rate-limit cooldown (#133), not because its binary/auth/version failed. The
   * dispatcher still substitutes on `ok:false` either way; `beckett doctor` reads this to report a
   * self-healing cooldown-with-expiry instead of a hard "unusable".
   */
  cooledUntil?: number;
}

/** A driver's static "is this harness usable RIGHT NOW?" probe (issue #17). */
export type DriverPreflight = (config: Config) => Promise<PreflightResult>;

/**
 * Everything the control plane needs to know about ONE harness — how to build its driver AND how
 * to preflight it — kept in a single entry so the two never drift. Adding a harness (including an
 * out-of-tree one) is one {@link REGISTRY} row; nothing else in the tree hand-enumerates the trio.
 */
export interface DriverRegistration {
  /** Construct a fresh driver process wrapper. */
  create: DriverFactory;
  /** Static health probe consulted before casting (and by `beckett doctor`). */
  preflight: DriverPreflight;
  /**
   * Whether this harness may be cast on the `review` stage.
   *
   * A capability, not a convention. `cursor` is an implementer-only seat: it builds, it never
   * judges someone else's diff. Expressing that as a registry field rather than a hardcoded
   * `harness === "cursor"` check means the SECOND implementer-only seat needs no second check —
   * and `../run/cast.ts#validateCasting` refuses a bad cast at DEPLOY time, before a run exists,
   * with the roster in hand.
   *
   * Optional, defaulting to review-capable ({@link isReviewCapable}), so an out-of-tree driver
   * registered against the older shape keeps working unchanged.
   */
  reviewCapable?: boolean;
}

/**
 * The harness → registration table — the SINGLE SOURCE OF TRUTH for which harnesses exist.
 * `claude` (live-steerable stream), `codex` (one-shot `codex exec`, steer-via-resume), `pi`
 * (one-shot `pi -p`, steer-via-resume) and `cursor` (one-shot local-mode shim, implement only)
 * are all registered so the dispatcher can cast them per stage (Spec 02 §5;
 * specs/_legacy-v3/V3.md §7). Factory, preflight and stage capability live in the same row: no
 * separate hand-synced switch to keep aligned.
 */
const REGISTRY: Record<string, DriverRegistration> = {
  claude: { create: (config, logger) => new ClaudeDriver(config, logger), preflight: claudePreflight },
  codex: { create: (config, logger) => new CodexDriver(config, logger), preflight: codexPreflight },
  pi: { create: (config, logger) => new PiDriver(config, logger), preflight: piPreflight },
  // The cursor seat (`./cursor.ts`) — IMPLEMENT ONLY. `reviewCapable: false` is the whole guard:
  // it is what makes `--cast '{"review":{"harness":"cursor"}}'` fail loudly at deploy time.
  cursor: {
    create: (config, logger) => new CursorDriver(config, logger),
    preflight: cursorPreflight,
    reviewCapable: false,
  },
};

/**
 * Whether `harness` may staff the `review` stage. Unregistered harnesses answer `true` so this
 * never becomes a second, quieter registration check — an unknown harness is rejected by
 * {@link isRegisteredHarness} first, and that is the error a caller should see.
 */
export function isReviewCapable(harness: string): boolean {
  const registration = isRegisteredHarness(harness) ? REGISTRY[harness] : undefined;
  return registration?.reviewCapable !== false;
}

/** The harnesses that may staff `review` — the roster a rejection message quotes. */
export function reviewCapableHarnesses(): Harness[] {
  return Object.keys(REGISTRY).filter(isReviewCapable);
}

/**
 * Whether `name` is a registered harness — the registry-driven replacement for a hardcoded
 * `claude|codex|pi` enum. Cast/preset validation calls this so a newly-registered driver becomes
 * castable with no second edit. Uses an own-property check so inherited keys (`constructor`,
 * `toString`, …) are never mistaken for a driver.
 */
export function isRegisteredHarness(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

/** Whether a driver is registered for `harness`. */
export function hasDriver(harness: Harness): boolean {
  return isRegisteredHarness(harness);
}

/** The set of harnesses with a usable driver in this build. */
export function availableHarnesses(): Harness[] {
  return Object.keys(REGISTRY);
}

/**
 * Resolve the factory for a harness. Throws a clear error for an unregistered harness so the
 * caller escalates instead of silently doing nothing.
 */
export function getDriverFactory(harness: Harness): DriverFactory {
  const registration = isRegisteredHarness(harness) ? REGISTRY[harness] : undefined;
  if (!registration) {
    throw new Error(
      `beckett: no driver registered for harness "${harness}" ` +
        `(available: ${availableHarnesses().join(", ") || "none"})`,
    );
  }
  return registration.create;
}

/** Construct a driver for the given harness. Convenience over {@link getDriverFactory}. */
export function createDriver(
  harness: Harness,
  config: Config,
  logger?: Logger,
): HarnessDriver {
  return getDriverFactory(harness)(config, logger);
}

// =======================================================================================
// Preflight (issue #17) — "is this harness usable RIGHT NOW?"
// =======================================================================================

const PREFLIGHT_TTL_MS = 5 * 60_000;
const preflightCache = new Map<Harness, { at: number; result: PreflightResult }>();

/**
 * Run (or serve from a ~5-min cache) the harness's static preflight: binary resolves, reports a
 * version, and its auth artifact exists. The concrete probe comes straight off the {@link REGISTRY}
 * row for the harness — there is no separate switch to keep in sync. The dispatcher consults this
 * BEFORE casting a worker so a dead harness produces one clear "unavailable: <reason>" substitution
 * instead of a wedged ticket; `beckett doctor` runs the same checks. The cache keeps the per-spawn
 * cost at zero while still noticing a fixed login within minutes.
 */
export async function preflightFor(
  harness: Harness,
  config: Config,
  opts: { force?: boolean } = {},
): Promise<PreflightResult> {
  // Quota cooldown (#133) gates BEFORE the binary/auth cache: a rate-limited harness passes every
  // static check yet dies on turn one, so while a cooldown is live report it unusable straight away
  // (with its expiry) and let the caller route to the substitute. Checked ahead of the cache so a
  // cooldown recorded after an earlier clean preflight still takes effect immediately.
  const cooldown = activeCooldown(harness, config);
  if (cooldown) {
    return {
      ok: false,
      cooledUntil: cooldown.until,
      problems: [
        `${harness} is on a rate-limit cooldown until ${new Date(cooldown.until).toISOString()} ` +
          `(auto-clears when quota resets)`,
      ],
    };
  }

  const cached = preflightCache.get(harness);
  let result: PreflightResult;
  if (!opts.force && cached && Date.now() - cached.at < PREFLIGHT_TTL_MS) {
    result = cached.result;
  } else {
    const registration = isRegisteredHarness(harness) ? REGISTRY[harness] : undefined;
    if (!registration) {
      result = { ok: false, problems: [`no driver registered for harness "${harness}"`] };
    } else {
      try {
        result = await registration.preflight(config);
      } catch (err) {
        result = { ok: false, problems: [`preflight crashed: ${(err as Error).message}`] };
      }
    }
    preflightCache.set(harness, { at: Date.now(), result });
  }

  // Self-heal: a clean preflight (the cooldown having expired above) drops any lingering record so
  // the harness is used again automatically once quota resets — no manual intervention (#133).
  if (result.ok) clearCooldown(harness, config);
  return result;
}
