/**
 * Tests for run casting (`src/run/cast.ts`) — the tolerant reader, the strict validator, and the
 * project-slug normalizer. These assertions came over verbatim from the tracker's cast tests: the
 * fenced-block codec died with the tracker, the roster rules did not.
 */
import { describe, expect, test } from "bun:test";
import { applySonnetFirst, isOpusModel, parseCastJson, projectSlug, validateCasting } from "./cast.ts";

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
