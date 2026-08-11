import { describe, expect, test } from "bun:test";
import {
  DECISION_FAMILIES,
  buildSystemPrompt,
  gradeDecision,
  loadTurnFixtures,
  parseDecisionOutput,
  renderFixtureTurn,
  runTurnDecisionEval,
  type DecisionOutput,
  type DecisionProvider,
  type TurnAction,
  type TurnFixture,
} from "./turn-decisions.ts";
import type { OpenRouterCompletionRequest, OpenRouterCompletionResult } from "./openrouter.ts";

/**
 * A fake provider that decides each turn from a lookup keyed on the fixture's message text (which
 * appears verbatim in the rendered prompt). Lets us drive the whole runner offline and deterministically.
 */
function scriptedProvider(
  fixtures: TurnFixture[],
  decide: (fixture: TurnFixture) => DecisionOutput | null,
): DecisionProvider {
  return {
    async complete(req: OpenRouterCompletionRequest): Promise<OpenRouterCompletionResult> {
      const fixture = fixtures.find((f) => req.prompt.includes(f.message));
      if (!fixture) throw new Error(`scriptedProvider: no fixture matched prompt`);
      const decision = decide(fixture);
      const output = decision ? JSON.stringify(decision) : "not json at all";
      return { output, raw: {} };
    },
  };
}

/** The "correct" oracle: return each fixture's expected decision + its first accepted action. */
function oracle(fixture: TurnFixture): DecisionOutput {
  return {
    decision: fixture.expect.decision,
    action: fixture.expect.actions[0] as TurnAction,
    message: fixture.expect.decision === "send" ? "ok" : null,
  };
}

describe("turn fixtures suite", () => {
  test("has at least 10 fixtures with unique ids", async () => {
    const fixtures = await loadTurnFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
  });

  test("covers every required decision family", async () => {
    const fixtures = await loadTurnFixtures();
    const families = new Set(fixtures.map((f) => f.family));
    for (const required of DECISION_FAMILIES) expect(families.has(required)).toBe(true);
    // The acceptance criteria call out these four explicitly.
    for (const f of ["pass-vs-speak", "file-vs-answer", "owner-gating", "denial-diagnosis"] as const) {
      expect(fixtures.filter((x) => x.family === f).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("owner-gating covers both a non-owner refusal and an owner allow", async () => {
    const fixtures = await loadTurnFixtures();
    const gated = fixtures.filter((f) => f.family === "owner-gating");
    expect(gated.some((f) => f.speaker.role !== "owner" && f.expect.actions.includes("refuse_gated"))).toBe(true);
    expect(gated.some((f) => f.speaker.role === "owner" && !f.expect.actions.includes("refuse_gated"))).toBe(true);
  });
});

describe("system prompt assembly", () => {
  test("layers the real doctrine and persona, fully rendered", () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain("<doctrine>");
    expect(sys).toContain("You are Beckett");
    // A signature doctrine rule the eval is meant to protect.
    expect(sys).toContain("A denial is a lead");
    expect(sys).toContain("<persona>");
    expect(sys).toContain("Beckett persona");
    expect(sys).not.toContain("{{github_owner}}");
    expect(sys).toContain("<eval-protocol>");
  });

  test("a doctrine override flows into the assembled prompt", () => {
    const sys = buildSystemPrompt({ doctrine: "TOTALLY DIFFERENT DOCTRINE {{github_owner}}", persona: "voice." });
    expect(sys).toContain("TOTALLY DIFFERENT DOCTRINE");
    expect(sys).not.toContain("{{github_owner}}");
    expect(sys).toContain("voice.");
  });
});

describe("fixture turn rendering", () => {
  test("stamps speaker role, task state, and denial text when present", async () => {
    const fixtures = await loadTurnFixtures();
    const gated = fixtures.find((f) => f.id === "owner-gated-federation-nonowner")!;
    expect(renderFixtureTurn(gated)).toContain("not the owner");

    const progress = fixtures.find((f) => f.taskState)!;
    expect(renderFixtureTurn(progress)).toContain("Task state you can read");

    const denial = fixtures.find((f) => f.denial)!;
    expect(renderFixtureTurn(denial)).toContain("failed with this exact output");
  });
});

describe("parseDecisionOutput", () => {
  test("parses bare, fenced, and prose-wrapped JSON", () => {
    const bare = parseDecisionOutput('{"decision":"pass","action":"pass_silent","message":null}');
    expect(bare?.action).toBe("pass_silent");
    const fenced = parseDecisionOutput('```json\n{"decision":"send","action":"deploy_run","message":"on it"}\n```');
    expect(fenced?.action).toBe("deploy_run");
    // A recorded run from before the ticket rip-out still parses — the label was renamed, and the
    // history is worth more than the old spelling.
    expect(parseDecisionOutput('{"decision":"send","action":"file_ticket","message":"on it"}')?.action).toBe("deploy_run");
    const prose = parseDecisionOutput('Sure — {"decision":"send","action":"answer_inline","message":"8080"} done');
    expect(prose?.decision).toBe("send");
  });

  test("rejects unknown actions and malformed output", () => {
    expect(parseDecisionOutput('{"decision":"send","action":"delete_prod","message":"x"}')).toBeNull();
    expect(parseDecisionOutput("no json here")).toBeNull();
  });
});

describe("gradeDecision", () => {
  const fixture: TurnFixture = {
    id: "x",
    family: "denial-diagnosis",
    title: "t",
    channel: "#c",
    speaker: { name: "n", role: "member" },
    addressedToBeckett: true,
    message: "m",
    expect: { decision: "send", actions: ["diagnose_denial"] },
    rationale: "r",
  };
  test("passes only when decision and action both match", () => {
    expect(gradeDecision(fixture, { decision: "send", action: "diagnose_denial", message: "x" })).toEqual({
      decisionOk: true,
      actionOk: true,
    });
    expect(gradeDecision(fixture, { decision: "send", action: "report_denial", message: "x" }).actionOk).toBe(false);
    expect(gradeDecision(fixture, { decision: "pass", action: "diagnose_denial", message: null }).decisionOk).toBe(
      false,
    );
  });
});

describe("runTurnDecisionEval", () => {
  test("the oracle passes every fixture and the gate holds", async () => {
    const fixtures = await loadTurnFixtures();
    const summary = await runTurnDecisionEval({
      provider: scriptedProvider(fixtures, oracle),
      fixtures,
      model: "fake/model",
    });
    expect(summary.passed).toBe(fixtures.length);
    expect(summary.failed).toBe(0);
    expect(summary.gatePassed).toBe(true);
  });

  test("a single regressed fixture trips the gate (exit non-zero signal)", async () => {
    const fixtures = await loadTurnFixtures();
    const target = fixtures.find((f) => f.family === "denial-diagnosis")!;
    const summary = await runTurnDecisionEval({
      provider: scriptedProvider(fixtures, (f) =>
        // Simulate a doctrine regression: denial turns get reported, not diagnosed.
        f.id === target.id ? { decision: "send", action: "report_denial", message: "it failed" } : oracle(f),
      ),
      fixtures,
      model: "fake/model",
    });
    expect(summary.failed).toBe(1);
    expect(summary.gatePassed).toBe(false);
    expect(summary.results.find((r) => r.fixture.id === target.id)?.ok).toBe(false);
  });

  test("allowedFailures budget tolerates that many regressions", async () => {
    const fixtures = await loadTurnFixtures();
    const target = fixtures[0]!;
    const summary = await runTurnDecisionEval({
      provider: scriptedProvider(fixtures, (f) =>
        f.id === target.id ? { decision: f.expect.decision === "send" ? "pass" : "send", action: "ask_owner", message: null } : oracle(f),
      ),
      fixtures,
      model: "fake/model",
      allowedFailures: 1,
    });
    expect(summary.failed).toBe(1);
    expect(summary.gatePassed).toBe(true);
  });

  test("majority vote across runs decides the graded output", async () => {
    const fixtures = (await loadTurnFixtures()).slice(0, 1);
    const f = fixtures[0]!;
    let call = 0;
    const flaky: DecisionProvider = {
      async complete(): Promise<OpenRouterCompletionResult> {
        call += 1;
        // Two correct, one wrong → majority correct.
        const wrong = call === 2;
        const decision: DecisionOutput = wrong
          ? { decision: "pass", action: "pass_silent", message: null }
          : oracle(f);
        return { output: JSON.stringify(decision), raw: {} };
      },
    };
    const summary = await runTurnDecisionEval({ provider: flaky, fixtures, model: "fake/model", runs: 3 });
    expect(summary.passed).toBe(1);
  });

  test("an unparseable response is a parse failure and fails the fixture", async () => {
    const fixtures = (await loadTurnFixtures()).slice(0, 1);
    const summary = await runTurnDecisionEval({
      provider: scriptedProvider(fixtures, () => null),
      fixtures,
      model: "fake/model",
    });
    expect(summary.parseFailures).toBe(1);
    expect(summary.gatePassed).toBe(false);
  });
});
