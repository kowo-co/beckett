/**
 * Tests for run casting (`src/run/cast.ts`) — the tolerant reader, the strict validator, and the
 * project-slug normalizer. These assertions came over verbatim from the tracker's cast tests: the
 * fenced-block codec died with the tracker, the roster rules did not.
 */
import { describe, expect, test } from "bun:test";
import {
  applySonnetFirst,
  CURSOR_IMPLEMENT_SPEC,
  DEFAULT_IMPLEMENT_MODEL,
  implementDefaultFor,
  isOpusModel,
  parseCastJson,
  projectSlug,
  reviewOnlyErrors,
  validateCasting,
} from "./cast.ts";

describe("parseCastJson (tolerant reader — never throws)", () => {
  test("valid cast parses through", () => {
    expect(parseCastJson('{"implement":{"harness":"codex"},"review":{"harness":"claude","model":"claude-opus-5"}}')).toEqual({
      implement: { harness: "codex" },
      review: { harness: "claude", model: "claude-opus-5" },
    });
  });

  test("malformed JSON → empty casting, does not throw", () => {
    let parsed!: ReturnType<typeof parseCastJson>;
    expect(() => (parsed = parseCastJson("{ not valid json ,, }"))).not.toThrow();
    expect(parsed).toEqual({});
  });

  test("rejects non-harness shapes", () => {
    expect(parseCastJson("{}")).toEqual({});
    expect(() => parseCastJson('{"implement": 42}')).not.toThrow();
    expect(parseCastJson('{"implement": 42}')).toEqual({});
  });
});

describe("validateCasting (strict — a human-typed cast is refused, not degraded)", () => {
  test("a valid cast has no errors", () => {
    expect(validateCasting({ implement: { harness: "claude", model: "claude-opus-5", effort: "high" } })).toEqual([]);
  });

  test("an unknown harness is named with its path", () => {
    const errors = validateCasting({ implement: { harness: "nope" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("implement.harness");
    expect(errors[0]).toContain("unknown harness");
  });

  test("ultracode is claude-only", () => {
    expect(validateCasting({ implement: { harness: "pi", effort: "ultracode" } })).not.toEqual([]);
  });

  test("a model absent from the rate table is refused (typos / unpriced ids never reach a worker)", () => {
    const errors = validateCasting({ implement: { harness: "claude", model: "claude-opsu-5" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown model "claude-opsu-5"');
    // Priced models — including deliberately-cast older tiers — stay castable.
    expect(validateCasting({ implement: { harness: "claude", model: "claude-opus-4-8" } })).toEqual([]);
    expect(validateCasting({ implement: { harness: "claude", effort: "ultracode" } })).toEqual([]);
  });

  test("off-tier models are blocked by name", () => {
    const errors = validateCasting({ implement: { harness: "pi", model: "SOL" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("hard-blocked on our tier");
    expect(validateCasting({ implement: { harness: "pi", model: "gpt-5.6" } })).toHaveLength(1);
    expect(validateCasting({ implement: { harness: "pi", model: "gpt-5.6-terra" } })).toEqual([]);
  });
});

describe("isOpusModel", () => {
  test("matches any opus SKU case-insensitively", () => {
    expect(isOpusModel("claude-opus-5")).toBe(true);
    expect(isOpusModel("claude-opus-4-8")).toBe(true);
    expect(isOpusModel("CLAUDE-OPUS-5")).toBe(true);
    expect(isOpusModel("claude-sonnet-5")).toBe(false);
    expect(isOpusModel(undefined)).toBe(false);
  });
});

describe("applySonnetFirst (issue #249 — the enforced default implement cast)", () => {
  test("an un-cast run defaults to sonnet", () => {
    expect(applySonnetFirst(undefined)).toEqual({ spec: { harness: "claude", model: "claude-sonnet-5" } });
  });

  test("an explicit non-opus directive is honored verbatim", () => {
    const explicit = { harness: "codex" as const, effort: "medium" as const };
    expect(applySonnetFirst(explicit)).toEqual({ spec: explicit });
    const sonnetDirective = { harness: "claude" as const, model: "claude-sonnet-5" };
    expect(applySonnetFirst(sonnetDirective)).toEqual({ spec: sonnetDirective });
  });

  test("an opus cast with no reason is downgraded to sonnet, with a note for the caller to log", () => {
    const result = applySonnetFirst({ harness: "claude", model: "claude-opus-5" });
    expect(result.spec).toEqual({ harness: "claude", model: "claude-sonnet-5" });
    expect(result.downgradeNote).toContain("claude-opus-5");
    expect(result.downgradeNote).toContain("downgraded");
    // A blank/whitespace-only "reason" doesn't count as stating one.
    expect(applySonnetFirst({ harness: "claude", model: "claude-opus-5", reason: "   " }).downgradeNote).toBeDefined();
  });

  test("an opus cast WITH a stated reason is kept, reason intact on the spec", () => {
    const explicit = { harness: "claude" as const, model: "claude-opus-5", reason: "gnarly cross-service debugging" };
    const result = applySonnetFirst(explicit);
    expect(result.spec).toEqual(explicit);
    expect(result.downgradeNote).toBeUndefined();
  });

  // PR #252 review finding 3: a model-less explicit claude cast (`{"implement":{"harness":
  // "claude"}}` — valid per `validateCasting`) must not fall through to an install's
  // `harness.claude.default_model`, which reproduces the un-reasoned, un-logged opus deploy on a
  // betterwright-shaped install where that default is opus.
  test("an explicit claude cast naming NO model is defaulted to sonnet, not passed through", () => {
    expect(applySonnetFirst({ harness: "claude" })).toEqual({
      spec: { harness: "claude", model: "claude-sonnet-5" },
    });
    // effort/reviewTier on a model-less cast survive the default.
    expect(applySonnetFirst({ harness: "claude", effort: "high" })).toEqual({
      spec: { harness: "claude", effort: "high", model: "claude-sonnet-5" },
    });
  });

  test("a model-less NON-claude cast is untouched (only claude falls through to an install default)", () => {
    const explicit = { harness: "pi" as const, effort: "medium" as const };
    expect(applySonnetFirst(explicit)).toEqual({ spec: explicit });
  });

  // Task 2 (overhaul B-P16): `task-deploy.ts#resolveCast` now strips any `reason` an opus
  // implement cast arrives with unless a human supplied `--cast-quote`, so a reason-less opus
  // cast reaching this gate is the NORMAL path, not a rare raw-API edge case — pin the
  // end-to-end contract the CLI now relies on.
  test("a reason-stripped opus cast is what applySonnetFirst now normally sees", () => {
    const result = applySonnetFirst({ harness: "claude", model: "claude-opus-5", effort: "high" });
    expect(result.spec).toEqual({ harness: "claude", model: "claude-sonnet-5", effort: "high" });
    expect(result.downgradeNote).toBeTruthy();
  });
});

describe("project slug safety", () => {
  test("dot path segments cannot escape the projects root", () => {
    expect(projectSlug(".")).toBe("project");
    expect(projectSlug("..")).toBe("project");
    expect(projectSlug("../")).toBe("project");
    expect(projectSlug("/")).toBe("project");
    expect(projectSlug("!!!")).toBe("project");
    expect(projectSlug("---")).toBe("project");
  });

  test("ordinary dots in project names remain intact", () => {
    expect(projectSlug("Beckett.Web v2")).toBe("beckett.web-v2");
  });
});

// =======================================================================================
// The implementer-only guard (the cursor seat)
// =======================================================================================

describe("implementer-only seats can never be cast on review", () => {
  test("a cursor review cast is REFUSED, with a message that says what to do instead", () => {
    const errors = validateCasting({ review: { harness: "cursor" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("implementer-only seat");
    expect(errors[0]).toContain("cast it under implement, not review");
    // The roster is quoted so the reader does not have to go looking for the legal answers.
    expect(errors[0]).toContain("claude, codex, pi");
  });

  test("cursor on IMPLEMENT is perfectly fine — that is the whole point of the seat", () => {
    expect(validateCasting({ implement: { harness: "cursor" } })).toEqual([]);
    expect(validateCasting({ implement: { harness: "cursor", model: "cursor-auto" } })).toEqual([]);
  });

  test("the guard is registry-driven, so review-capable harnesses pass untouched", () => {
    for (const harness of ["claude", "codex", "pi"]) {
      expect(reviewOnlyErrors("review", { harness })).toEqual([]);
    }
    expect(reviewOnlyErrors("implement", { harness: "cursor" })).toEqual([]);
    expect(reviewOnlyErrors("review", { harness: "cursor" })).toHaveLength(1);
  });

  test("a mixed cast reports the review problem and keeps the implement half legal", () => {
    const errors = validateCasting({
      implement: { harness: "cursor", model: "cursor-auto" },
      review: { harness: "cursor" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("review:");
  });

  test("cursor-auto is a priced, castable model (an unpriced one would be refused)", () => {
    expect(validateCasting({ implement: { harness: "cursor", model: "cursor-auto" } })).toEqual([]);
    expect(validateCasting({ implement: { harness: "cursor", model: "cursor-magic" } })[0]).toContain(
      "not priced in config/model-rates.json",
    );
  });
});

// =======================================================================================
// Cursor-first routing (config-gated)
// =======================================================================================

describe("implementDefaultFor — cursor first, sonnet as the fallback seat", () => {
  test("with the cursor block enabled, the zero-cast implement seat is cursor", () => {
    expect(implementDefaultFor({ harness: { cursor: { enabled: true } } })).toEqual(CURSOR_IMPLEMENT_SPEC);
  });

  test("with it off — or absent entirely — the sonnet-first default is unchanged", () => {
    // The second case is the one that matters for blast radius: an install whose config.toml
    // predates this seat must behave exactly as it did before, not crash and not opt itself in.
    const sonnet = { harness: "claude", model: DEFAULT_IMPLEMENT_MODEL };
    expect(implementDefaultFor({ harness: { cursor: { enabled: false } } })).toEqual(sonnet);
    expect(implementDefaultFor({ harness: {} })).toEqual(sonnet);
    expect(implementDefaultFor({})).toEqual(sonnet);
  });

  test("applySonnetFirst with no default argument is byte-identical to before", () => {
    expect(applySonnetFirst(undefined)).toEqual({
      spec: { harness: "claude", model: DEFAULT_IMPLEMENT_MODEL },
    });
  });

  test("the cursor default ONLY replaces the no-explicit-cast branch", () => {
    const cursorFirst = implementDefaultFor({ harness: { cursor: { enabled: true } } });
    // No cast → cursor.
    expect(applySonnetFirst(undefined, cursorFirst).spec).toEqual(CURSOR_IMPLEMENT_SPEC);
    // An explicit non-opus cast is still honoured verbatim.
    expect(applySonnetFirst({ harness: "claude", model: "claude-sonnet-5" }, cursorFirst).spec).toEqual({
      harness: "claude",
      model: "claude-sonnet-5",
    });
    // A model-less claude cast still gets the enforced sonnet model, NOT cursor.
    expect(applySonnetFirst({ harness: "claude" }, cursorFirst).spec).toEqual({
      harness: "claude",
      model: DEFAULT_IMPLEMENT_MODEL,
    });
    // An un-reasoned opus cast still downgrades to SONNET — the case for a heavier seat is a
    // claude-tier judgement, and answering it with cursor would be a different decision entirely.
    const downgraded = applySonnetFirst({ harness: "claude", model: "claude-opus-5" }, cursorFirst);
    expect(downgraded.spec).toEqual({ harness: "claude", model: DEFAULT_IMPLEMENT_MODEL });
    expect(downgraded.downgradeNote).toContain("sonnet-first doctrine");
  });
});
