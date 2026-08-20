/**
 * Beckett — driver registry tests (`src/drivers/index.test.ts`)
 * =======================================================================================
 * Locks in the single-source-of-truth property (issue #145): the factory AND the preflight for a
 * harness live in ONE registry row, and harness validity is decided by that registry rather than a
 * hand-synced enum. If someone re-splits preflight into a separate switch, or hardcodes the trio
 * again, these break.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableHarnesses,
  createDriver,
  getDriverFactory,
  hasDriver,
  isRegisteredHarness,
  isReviewCapable,
  preflightFor,
  reviewCapableHarnesses,
} from "./index.ts";
import { activeCooldown, recordCooldown } from "./cooldown.ts";
import { defaultConfig } from "../config.ts";

describe("driver registry — single source of truth", () => {
  test("the in-tree drivers are registered", () => {
    expect(availableHarnesses().sort()).toEqual(["claude", "codex", "cursor", "pi"]);
    for (const h of ["claude", "codex", "cursor", "pi"]) {
      expect(hasDriver(h)).toBe(true);
      expect(isRegisteredHarness(h)).toBe(true);
      expect(typeof getDriverFactory(h)).toBe("function");
    }
  });

  // The implementer-only axis (`./cursor.ts`). A capability on the registry row, not a hardcoded
  // `harness === "cursor"` check somewhere downstream — so a SECOND implementer-only seat needs no
  // second edit anywhere. `../run/cast.ts#reviewOnlyErrors` is the consumer with teeth.
  test("reviewCapable is a registry capability: cursor implements, it never reviews", () => {
    expect(isReviewCapable("cursor")).toBe(false);
    for (const h of ["claude", "codex", "pi"]) expect(isReviewCapable(h)).toBe(true);
    expect(reviewCapableHarnesses().sort()).toEqual(["claude", "codex", "pi"]);
  });

  test("an unregistered harness is not treated as review-incapable (it is rejected earlier)", () => {
    // `isRegisteredHarness` refuses it first, and THAT is the error a caller should see — answering
    // "cannot review" here would turn an unknown-harness typo into a confusing capability message.
    expect(isReviewCapable("gpt")).toBe(true);
  });

  test("registry membership is an own-property check, not an enum or prototype key", () => {
    expect(isRegisteredHarness("gpt")).toBe(false);
    expect(isRegisteredHarness("constructor")).toBe(false);
    expect(isRegisteredHarness("toString")).toBe(false);
    expect(hasDriver("gpt")).toBe(false);
  });

  test("an unregistered harness fails loudly, listing the registered set", () => {
    expect(() => getDriverFactory("gpt")).toThrow(/no driver registered for harness "gpt"/);
    expect(() => createDriver("gpt", defaultConfig())).toThrow(/available: claude, codex, pi, cursor/);
  });

  test("preflight is served off the registry row (no separate switch)", async () => {
    // An unregistered harness has no preflight and reports exactly that — proving preflightFor
    // reads the same table getDriverFactory does, not a parallel hand-maintained switch.
    const pf = await preflightFor("gpt", defaultConfig());
    expect(pf.ok).toBe(false);
    expect(pf.problems.join(" ")).toMatch(/no driver registered for harness "gpt"/);
  });
});

// #133: a live rate-limit cooldown gates preflight BEFORE the binary/auth checks, so a
// quota-capped harness reports unusable (with its expiry) instead of passing preflight and dying
// on turn one. The BECKETT_DIR override relocates the state layout into a scratch dir.
describe("preflight — rate-limit cooldown gate (#133)", () => {
  const config = defaultConfig();
  let dir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "beckett-preflight-cooldown-"));
    prevDir = process.env.BECKETT_DIR;
    process.env.BECKETT_DIR = dir;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.BECKETT_DIR;
    else process.env.BECKETT_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a live cooldown makes preflight report unusable with the expiry, no driver probe", async () => {
    const rec = recordCooldown("pi", config);
    // force:true skips the cache — the cooldown still fires because it gates ahead of the cache.
    const pf = await preflightFor("pi", config, { force: true });
    expect(pf.ok).toBe(false);
    expect(pf.cooledUntil).toBe(rec.until);
    expect(pf.problems.join(" ")).toMatch(/rate-limit cooldown until/);
  });

  test("an expired cooldown no longer gates preflight (self-heals on quota reset)", async () => {
    // Record a cooldown already in the past: the gate must NOT fire, so the result carries no
    // cooldown marker and the store no longer reports it live. We assert against an UNREGISTERED
    // harness so the fall-through is the instant "no driver" path — proving the gate is purely
    // time-based without spawning a real (slow, environment-dependent) harness CLI probe. The
    // dispatcher suite covers a real pi cast resuming once its window passes.
    recordCooldown("gpt", config, { now: 1_000, durationMs: 1 });
    const pf = await preflightFor("gpt", config, { force: true });
    expect(pf.cooledUntil).toBeUndefined();
    expect(pf.problems.join(" ")).toMatch(/no driver registered/);
    expect(activeCooldown("gpt", config)).toBeNull();
  });
});
