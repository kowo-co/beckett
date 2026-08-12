/**
 * Tests for run casting (`src/run/cast.ts`) — the tolerant reader, the strict validator, and the
 * project-slug normalizer. These assertions came over verbatim from the tracker's cast tests: the
 * fenced-block codec died with the tracker, the roster rules did not.
 */
import { describe, expect, test } from "bun:test";
import { parseCastJson, projectSlug, validateCasting } from "./cast.ts";

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
