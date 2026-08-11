/**
 * Tests for user-defined cast presets (`src/run/presets.ts`) — OPS-110.
 * Covers: fresh (uncached) reads so an edit applies next call, seed-on-missing, roster validation
 * (blocked models + malformed casts throw), loud unknown-name failure, and per-stage override
 * precedence. These guard the "edit the file, no restart" contract and "never file a broken cast".
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPresets,
  requirePreset,
  resolveCasting,
  SEED_PRESETS,
  type PresetMap,
} from "./presets.ts";
import type { Casting } from "./types.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beckett-presets-"));
  file = join(dir, "presets.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadPresets — seed + fresh read", () => {
  test("missing file → created, seeded with the design-doc presets plus intensive", () => {
    expect(existsSync(file)).toBe(false);
    const presets = loadPresets(file);
    expect(existsSync(file)).toBe(true);
    expect(Object.keys(presets).sort()).toEqual(
      ["cheap-lane", "critical", "fable-review+terra-work", "intensive", "taste-lane"],
    );
    expect(presets).toEqual(SEED_PRESETS);
    // the written file round-trips back to the same map
    expect(loadPresets(file)).toEqual(SEED_PRESETS);
  });

  test("reads FRESH every call — an edit applies on the next load with no restart/cache", () => {
    loadPresets(file); // seed
    writeFileSync(
      file,
      JSON.stringify({
        "jason-review": {
          implement: { harness: "claude", model: "claude-sonnet-5", effort: "high" },
          review: { harness: "claude", model: "claude-fable-5", effort: "high" },
        },
      }),
    );
    const after = loadPresets(file);
    expect(Object.keys(after)).toEqual(["jason-review"]);
    expect(after["jason-review"]?.review?.model).toBe("claude-fable-5");
  });

  test("partial presets (only one stage) are allowed", () => {
    writeFileSync(file, JSON.stringify({ "review-only": { review: { harness: "pi", effort: "high" } } }));
    const presets = loadPresets(file);
    expect(presets["review-only"]).toEqual({ review: { harness: "pi", effort: "high" } });
  });
});

describe("loadPresets — validation (never load a broken cast)", () => {
  test("rejects SOL (hard-blocked on our tier)", () => {
    writeFileSync(file, JSON.stringify({ bad: { implement: { harness: "pi", model: "sol", effort: "high" } } }));
    expect(() => loadPresets(file)).toThrow(/hard-blocked/i);
  });

  test("rejects bare gpt-5.6 (hard-blocked)", () => {
    writeFileSync(file, JSON.stringify({ bad: { implement: { harness: "pi", model: "gpt-5.6", effort: "high" } } }));
    expect(() => loadPresets(file)).toThrow(/gpt-5\.6/);
  });

  test("allows the castable pi models terra + luna", () => {
    writeFileSync(
      file,
      JSON.stringify({
        ok: {
          implement: { harness: "pi", model: "gpt-5.6-terra", effort: "medium" },
          review: { harness: "pi", model: "gpt-5.6-luna", effort: "low" },
        },
      }),
    );
    expect(() => loadPresets(file)).not.toThrow();
  });

  test("rejects a malformed harness", () => {
    writeFileSync(file, JSON.stringify({ bad: { implement: { harness: "gpt", effort: "high" } } }));
    expect(() => loadPresets(file)).toThrow(/bad/);
  });

  test("rejects a malformed effort", () => {
    writeFileSync(file, JSON.stringify({ bad: { implement: { harness: "pi", effort: "turbo" } } }));
    expect(() => loadPresets(file)).toThrow();
  });

  test("error names the offending preset", () => {
    writeFileSync(file, JSON.stringify({ "my-flow": { implement: { harness: "pi", model: "sol" } } }));
    expect(() => loadPresets(file)).toThrow(/my-flow/);
  });

  test("not-valid-JSON throws with the path", () => {
    writeFileSync(file, "{ not json ");
    expect(() => loadPresets(file)).toThrow(/not valid JSON/);
  });

  test("a top-level array (not an object) throws", () => {
    writeFileSync(file, JSON.stringify([{ implement: { harness: "pi" } }]));
    expect(() => loadPresets(file)).toThrow(/must be a JSON object/);
  });
});

describe("requirePreset — loud unknown name", () => {
  const presets: PresetMap = {
    "cheap-lane": { implement: { harness: "pi", model: "gpt-5.6-luna", effort: "low" } },
    critical: { implement: { harness: "claude", model: "claude-fable-5", effort: "high" } },
  };

  test("known name returns its cast", () => {
    expect(requirePreset(presets, "cheap-lane")).toEqual(presets["cheap-lane"]!);
  });

  test("unknown name throws listing the available names", () => {
    let msg = "";
    try {
      requirePreset(presets, "nope");
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("nope");
    expect(msg).toContain("cheap-lane");
    expect(msg).toContain("critical");
  });
});

describe("resolveCasting — per-stage precedence", () => {
  const preset: Casting = {
    implement: { harness: "pi", effort: "high" },
    review: { harness: "claude", model: "claude-fable-5", effort: "high" },
  };

  test("no explicit override → the preset verbatim", () => {
    expect(resolveCasting(preset, {})).toEqual(preset);
  });

  test("explicit stage REPLACES the preset's stage; preset fills the rest", () => {
    const resolved = resolveCasting(preset, { implement: { harness: "pi", effort: "xhigh" } });
    // implement swapped wholesale to the explicit spec…
    expect(resolved.implement).toEqual({ harness: "pi", effort: "xhigh" });
    // …review untouched (preset fills it)
    expect(resolved.review).toEqual({ harness: "claude", model: "claude-fable-5", effort: "high" });
  });

  test("explicit adds a stage the preset omits", () => {
    const resolved = resolveCasting({ implement: { harness: "pi", effort: "medium" } }, {
      review: { harness: "pi", effort: "high" },
    });
    expect(resolved.implement).toEqual({ harness: "pi", effort: "medium" });
    expect(resolved.review).toEqual({ harness: "pi", effort: "high" });
  });

  test("undefined preset → just the explicit cast", () => {
    expect(resolveCasting(undefined, { implement: { harness: "pi", effort: "low" } })).toEqual({
      implement: { harness: "pi", effort: "low" },
    });
  });
});
