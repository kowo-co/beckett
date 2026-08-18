/**
 * `detectEchoedInput` (`src/concierge/echo-guard.ts`): pure scoring, no network, no gateway.
 * `chill-gate.test.ts` covers the wiring (per-bubble fallback, logging); this file covers the
 * threshold itself against real and plausible bubble/input pairs.
 */

import { describe, expect, test } from "bun:test";
import { detectEchoedInput } from "./echo-guard.ts";

describe("detectEchoedInput — the 2026-08-18 incident", () => {
  // Channel 1520986792373911622, message 1539063244914950257. The user's triggering message
  // (`input`) and the bad bubble chilltext handed back as Beckett's own reply — a paraphrase of
  // the user's words with the pronouns inverted ("you're the CTO" instead of "I'm the CTO").
  const INPUT =
    "right thats the correct flow. questions or like 90% of things should go to you, not me. " +
    "cuz imagine bothering the ceo with every task, you da cto so you gotta step up and be a leader lol.";
  const ECHOED_BUBBLE =
    "yeah that's the right flow. questions or like 90% of stuff should go to you, not me. " +
    "imagine bothering the ceo with every task, you're the cto, so you gotta step up and lead lol.";

  test("trips on the real echoed bubble", () => {
    const result = detectEchoedInput(ECHOED_BUBBLE, INPUT);
    expect(result.echoed).toBe(true);
    expect(result.contentScore).toBeGreaterThanOrEqual(0.65);
  });

  test("the other two bubbles from the same delivery do not trip", () => {
    const goodBubbles = ["wrote three, they're in the graph now", "want me to walk you through them?"];
    for (const bubble of goodBubbles) {
      expect(detectEchoedInput(bubble, INPUT).echoed).toBe(false);
    }
  });
});

describe("detectEchoedInput — legitimate replies that quote or partially echo the user", () => {
  const LONG_INPUT =
    "can you check page 42 of the report and make sure the numbers from last quarter still line up " +
    "before we send it out, thanks";

  test("a short confirmation does not trip", () => {
    expect(detectEchoedInput("yeah, agreed", LONG_INPUT).echoed).toBe(false);
    expect(detectEchoedInput("sounds good", LONG_INPUT).echoed).toBe(false);
    expect(detectEchoedInput("on it", LONG_INPUT).echoed).toBe(false);
  });

  test("a reply that repeats a page number the user gave does not trip", () => {
    const result = detectEchoedInput("yep, page 42 looks right to me", LONG_INPUT);
    expect(result.echoed).toBe(false);
  });

  test("a reply that repeats a filename the user gave does not trip", () => {
    const input = "can you check config.yaml please, something looks off in there";
    const result = detectEchoedInput("yeah, config.yaml looks good to me", input);
    expect(result.echoed).toBe(false);
  });

  test("a topical reply sharing a few nouns with the input does not trip", () => {
    const input = "should we deploy the payment service now or wait for the freeze to lift";
    const result = detectEchoedInput("deploying the payment service now, give me a sec", input);
    expect(result.echoed).toBe(false);
  });
});

describe("detectEchoedInput — degenerate near-identical case, regardless of length", () => {
  test("a short bubble that is a verbatim copy of a short input trips", () => {
    expect(detectEchoedInput("np im on it", "np im on it").echoed).toBe(true);
  });

  test("an all-stopword echo trips even though the content-word score is zero", () => {
    const result = detectEchoedInput("that's not for me", "that's not for me");
    expect(result.contentScore).toBe(0);
    expect(result.fullScore).toBeGreaterThanOrEqual(0.85);
    expect(result.echoed).toBe(true);
  });

  test("a long verbatim copy trips", () => {
    const text =
      "the deploy finished about ten minutes ago and everything on the dashboard looks green so far";
    expect(detectEchoedInput(text, text).echoed).toBe(true);
  });
});

describe("detectEchoedInput — edge inputs", () => {
  test("an empty input never trips", () => {
    expect(detectEchoedInput("anything at all", "").echoed).toBe(false);
  });

  test("an empty bubble never trips", () => {
    expect(detectEchoedInput("", "anything at all").echoed).toBe(false);
  });

  test("punctuation-only strings never trip", () => {
    expect(detectEchoedInput("...", "!!!").echoed).toBe(false);
  });
});
