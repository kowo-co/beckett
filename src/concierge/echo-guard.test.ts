/**
 * `detectEchoedInput` (`src/concierge/echo-guard.ts`): pure scoring, no network, no gateway.
 * `chill-gate.test.ts` covers the wiring (per-bubble fallback, logging); this file covers the
 * threshold itself against real and plausible bubble/input pairs.
 */

import { describe, expect, test } from "bun:test";
import {
  detectContentSubstitution,
  detectEchoedInput,
  detectLeadingClauseSubstitution,
  detectPersonaSampleLineLeak,
  detectPromptScaffolding,
} from "./echo-guard.ts";

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

describe("detectEchoedInput — a leading (prepended) echo, not a whole-bubble replacement", () => {
  // The user's message to ro: "yeah merge it". What Beckett actually wrote for that bubble, and
  // what chilltext's rewrite handed back — the user's own words prepended verbatim onto the front
  // of the real reply, joined by ". ". Scored as a whole bubble this is nowhere near threshold
  // (the echoed span is 3 tokens out of ~25), which is exactly why the whole-bubble check alone
  // missed it.
  const INPUT = "yeah merge it";
  const ORIGINAL_TEXT =
    "all three are on main already, the deploy was just stuck. it's armed now and fires the second " +
    "those two workers finish, no babysitting needed.";
  const PREPENDED_BUBBLE = `${INPUT}. ${ORIGINAL_TEXT}`;

  test("trips on the real prepended bubble and repairs it when given the original text", () => {
    const result = detectEchoedInput(PREPENDED_BUBBLE, INPUT, ORIGINAL_TEXT);
    expect(result.echoed).toBe(true);
    expect(result.repaired).toBe(ORIGINAL_TEXT);
  });

  test("whole-bubble scores stay low — this trips ONLY via the new leading-span check", () => {
    const result = detectEchoedInput(PREPENDED_BUBBLE, INPUT, ORIGINAL_TEXT);
    expect(result.contentScore).toBeLessThan(0.65);
    expect(result.fullScore).toBeLessThan(0.85);
  });

  test("still trips without the original text, but offers nothing to repair — caller falls back", () => {
    const result = detectEchoedInput(PREPENDED_BUBBLE, INPUT);
    expect(result.echoed).toBe(true);
    expect(result.repaired).toBeNull();
  });

  test("a bubble that merely starts with a shared short word does not trip", () => {
    const input = "it looks fine";
    const bubble = "it took a while but the migration finished clean and everything checks out now";
    expect(detectEchoedInput(bubble, input).echoed).toBe(false);
  });
});

describe("detectEchoedInput — a trailing (appended) echo, mirrored", () => {
  const INPUT = "thanks appreciate it";
  const ORIGINAL_TEXT = "all set, ship it now";
  const APPENDED_BUBBLE = `${ORIGINAL_TEXT}. ${INPUT}`;

  test("trips on a trailing echo and repairs it when given the original text", () => {
    const result = detectEchoedInput(APPENDED_BUBBLE, INPUT, ORIGINAL_TEXT);
    expect(result.echoed).toBe(true);
    expect(result.repaired).toBe(ORIGINAL_TEXT);
  });
});

describe("detectEchoedInput — the 2026-08-18 quote-truncation incident", () => {
  // Channel 1520986792373911622. ro said "for jesus"; the reply legitimately quoted it back as
  // part of the joke. chilltext returned the bubble byte-identical to `before` (nothing was
  // corrupted), but the repair path stripped the quoted span and everything after it anyway,
  // posting a message that dead-ends at an open quote.
  const INPUT = "for jesus";
  const BUBBLE = 'asked if it likes cake, answered "for jesus". no notes';

  test("a legitimate quote of the user's own words is passed through unchanged, no repair", () => {
    const result = detectEchoedInput(BUBBLE, INPUT);
    expect(result.echoed).toBe(false);
    expect(result.repaired).toBeNull();
  });

  test("the rewritten === before invariant is an explicit early-out, independent of overlap with input", () => {
    // A bubble that is byte-identical to `originalText` must pass through untouched even when it
    // scores well past the whole-bubble echo thresholds against `input` — the rewrite service did
    // not corrupt anything, so there is nothing for the guard to repair.
    const text = "yeah for sure, for jesus is right, jesus take the wheel";
    const result = detectEchoedInput(text, INPUT, text);
    expect(result.echoed).toBe(false);
    expect(result.repaired).toBeNull();
  });

  test("a quoted span sitting at the true edge of the bubble does not trip, even at saturated overlap", () => {
    // Without the quote guard this trailing window ("shut it down") would score 1.0 on both
    // Dice coefficients — a textbook trip — but it's a deliberate quotation, not an echo.
    const input = "shut it down";
    const bubble = 'honestly rude but he did say "shut it down"';
    const result = detectEchoedInput(bubble, input);
    expect(result.echoed).toBe(false);
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

describe("detectPromptScaffolding — the 2026-08-20 incident", () => {
  // Channel 1520986792373911622, 2026-08-20 01:16: chilltext posted a fragment of its OWN
  // delivery-format instructions as one of Beckett's bubbles. This exact sentence appears nowhere
  // in this repo (it's the remote chilltext service's own wrapper prompt) — the guard has to
  // recognize the SHAPE of delivery-contract language, not this one sentence.
  const LEAKED_INSTRUCTIONS =
    "return only the rewritten chat message or messages, separated by a blank line. use 1 to 4 " +
    "messages total and never more than 4.";

  test("trips on the real leaked instruction text, with multiple signals converging", () => {
    const result = detectPromptScaffolding(LEAKED_INSTRUCTIONS);
    expect(result.leaked).toBe(true);
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  test("trips when the same instruction fragment is embedded inside otherwise-normal prose", () => {
    // The other real-world shape of this incident: not a standalone bubble, but scaffolding mixed
    // into what would otherwise be a legitimate reply.
    const bubble = `hey so about that — anyway, ${LEAKED_INSTRUCTIONS} let me know if you need more`;
    expect(detectPromptScaffolding(bubble).leaked).toBe(true);
  });

  test("a paraphrase of the same delivery contract, worded differently, still trips", () => {
    // Not the incident's literal wording — proves this isn't a blocklist of one sentence.
    const paraphrase = "reply only with the rewritten text. send 2 to 3 messages total, never more than 3.";
    const result = detectPromptScaffolding(paraphrase);
    expect(result.leaked).toBe(true);
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });
});

describe("detectContentSubstitution — the 2026-08-21 incident", () => {
  // Channel 1520986792373911622, 04:57:58.516Z: chilltext discarded the first block's content
  // entirely and returned a verbatim `persona.md` sample line instead. The second bubble was a
  // faithful rewrite (verbatim, in this case) of the second block.
  const BLOCK_1 =
    "classifier's actually going now — comedy counts as a reason to speak, serious rooms stay locked down";
  const BLOCK_2 = "also correcting myself from earlier: the image fix IS live, has been since 23:49. i said it wasn't";
  const FABRICATED_BUBBLE = "yeah that's broken. i know why. gimme 10";

  test("the fabricated bubble is unrelated to the block it replaced", () => {
    const result = detectContentSubstitution(FABRICATED_BUBBLE, BLOCK_1);
    expect(result.unrelated).toBe(true);
    expect(result.score).toBe(0);
  });

  test("the fabricated bubble is also unrelated to the OTHER block — it isn't just misaligned", () => {
    expect(detectContentSubstitution(FABRICATED_BUBBLE, BLOCK_2).unrelated).toBe(true);
  });

  test("the faithful second bubble scores maximal containment against its own block", () => {
    const result = detectContentSubstitution(BLOCK_2, BLOCK_2);
    expect(result.unrelated).toBe(false);
    expect(result.score).toBe(1);
  });

  // A third, previously undetected occurrence found on retroactive analysis of
  // `~/.beckett/chilltext-transforms.jsonl` (2026-08-19T05:12:08.718Z) — same shape, different
  // persona sample line.
  test("a second confirmed real substitution also scores unrelated", () => {
    const block = "last time we rushed this we shipped a green test suite and a browser that couldn't open. you'll get it in a minute";
    const fabricated = "yeah, that's broken. i know why. gimme 10";
    expect(detectContentSubstitution(fabricated, block).unrelated).toBe(true);
  });
});

describe("detectContentSubstitution — legitimate rewrites, including fragments of a longer block", () => {
  test("a faithful paraphrase, heavily reworded, still scores related", () => {
    const block =
      "the giveaway form got filled and submitted, page came back with \"Unable to accept this submission.\" and nothing else";
    const rewrite = "the giveaway form got filled and submitted, then it just came back with \"unable to accept this submission\"";
    expect(detectContentSubstitution(rewrite, block).unrelated).toBe(false);
  });

  test("a bubble covering only a FRAGMENT of a much longer block is not flagged — chilltext splitting one paragraph into several bubbles is normal, not drift", () => {
    const longBlock =
      "grug get email. grug read email. grug not happy. grug write code because grug like write code. " +
      "grug not want robot go find people for grug. grug ask with much respect: no send more email.";
    const fragment = "grug get email. grug read email. grug not happy.";
    expect(detectContentSubstitution(fragment, longBlock).unrelated).toBe(false);
  });

  test("a bare acknowledgment with no content words at all is never flagged", () => {
    const result = detectContentSubstitution("ok", "the deploy finished and everything looks green");
    expect(result.unrelated).toBe(false);
    expect(result.score).toBeNull();
  });
});

describe("detectPromptScaffolding — legitimate replies that brush a single signal", () => {
  test("an offhand number range about something other than messages does not trip", () => {
    expect(detectPromptScaffolding("i'll send 2 to 3 logs your way in a bit").leaked).toBe(false);
  });

  test("a casual 'never more than' about an unrelated thing needs a second signal to trip", () => {
    expect(detectPromptScaffolding("never more than 5 minutes, promise").leaked).toBe(false);
  });

  test("ordinary chat never trips", () => {
    for (const bubble of ["yeah, agreed", "on it", "sounds good, talk soon", "pushed the fix, tests are green"]) {
      expect(detectPromptScaffolding(bubble).leaked).toBe(false);
    }
  });
});

describe("detectLeadingClauseSubstitution — the 2026-08-24 incident", () => {
  // Channel 1520986792373911622, 22:50:41.399Z: only the OPENING clause was substituted; the rest
  // of the bubble is untouched. The whole-message containment score (`detectContentSubstitution`)
  // scored this 0.9 — comfortably "related" — because it's length-weighted and 90%+ of the tokens
  // survived. This check looks only at the part that changed.
  const AGENT_OUTPUT =
    "hi booper. you got the mention right and the message wrong, which is more than most of the " +
    "pipelines around here managed today";
  const CORRUPTED_BUBBLE =
    "yeah that's broken. you got the mention right and the message wrong, which is more than most " +
    "of the pipelines around here managed today";

  test("trips on the real evidence pair — zero shared content in the opening clause", () => {
    const result = detectLeadingClauseSubstitution(CORRUPTED_BUBBLE, AGENT_OUTPUT);
    expect(result.unrelated).toBe(true);
    expect(result.score).toBe(0);
  });

  test("the whole-message containment score alone would NOT have caught this — confirming the blind spot", () => {
    const result = detectContentSubstitution(CORRUPTED_BUBBLE, AGENT_OUTPUT);
    expect(result.unrelated).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(0.85);
  });

  test("a faithful rewording of the opening clause does not trip", () => {
    const rewritten = "yo booper. you got the mention right and the message wrong, more than most pipelines today";
    expect(detectLeadingClauseSubstitution(rewritten, AGENT_OUTPUT).unrelated).toBe(false);
  });

  test("an unchanged bubble (byte-identical) does not trip", () => {
    expect(detectLeadingClauseSubstitution(AGENT_OUTPUT, AGENT_OUTPUT).unrelated).toBe(false);
  });

  test("neither side carries an early sentence terminator: the check declines rather than guessing", () => {
    // Neither `.`/`!`/`?` appears early in either string — comparing "the whole bubble" against
    // "the whole source" here would just be a worse version of the whole-message check, and a size
    // mismatch (one side terminated, one not) is exactly the false-positive shape this guards
    // against — see the doc on `leadingClause`.
    const result = detectLeadingClauseSubstitution("yeah all good, nothing running", "sounds good no worries");
    expect(result.unrelated).toBe(false);
    expect(result.score).toBeNull();
  });

  test("only the SOURCE has an early terminator (a short first sentence merged into an untermined rewrite): declines, does not misfire", () => {
    // Regression: comparing a genuine short source clause ("stopped.") against an entire untermined
    // bubble ("yeah all good, nothing running") produced a spurious near-zero score even though the
    // bubble is a faithful, if restructured, rewrite of the same reply.
    const bubble = "yeah all good, nothing running";
    const source = "stopped. nothing deployed, nothing running, we're clean.";
    const result = detectLeadingClauseSubstitution(bubble, source);
    expect(result.unrelated).toBe(false);
    expect(result.score).toBeNull();
  });

  test("a bare-stopword opener has no content words to score and does not trip", () => {
    const result = detectLeadingClauseSubstitution("ok. sure thing", "so. anyway here's the update");
    expect(result.unrelated).toBe(false);
    expect(result.score).toBeNull();
  });
});

describe("detectPersonaSampleLineLeak — the 2026-08-21 / 2026-08-24 incidents", () => {
  const SAMPLE_LINES = [
    "yeah that's broken. i know why. gimme 10",
    "pushed the fix. the bug was in your commit btw, not mine. skill issue",
    "the deploy went about as well as you'd expect",
    "ok fair, i was wrong about the cache. moving on",
  ];

  test("trips when a bubble contains a persona clause the agent's own output never said", () => {
    const bubble =
      "yeah that's broken. you got the mention right and the message wrong, which is more than most " +
      "of the pipelines around here managed today";
    const agentOutput =
      "hi booper. you got the mention right and the message wrong, which is more than most of the " +
      "pipelines around here managed today";
    const result = detectPersonaSampleLineLeak(bubble, agentOutput, SAMPLE_LINES);
    expect(result.leaked).toBe(true);
    expect(result.matchedClause).toBe("yeah that's broken");
  });

  test("trips on a whole verbatim sample-line bubble (the 2026-08-21 shape)", () => {
    const result = detectPersonaSampleLineLeak(
      "yeah that's broken. i know why. gimme 10",
      "the classifier is going now",
      SAMPLE_LINES,
    );
    expect(result.leaked).toBe(true);
  });

  test("a clause the agent's own output ALSO contains is not a leak", () => {
    const agentOutput = "yeah that's broken. i know why. gimme 10 and it'll be fixed";
    const result = detectPersonaSampleLineLeak(agentOutput, agentOutput, SAMPLE_LINES);
    expect(result.leaked).toBe(false);
  });

  test("short, common clauses under the word-count floor never trip (false-positive guard)", () => {
    // "moving on" and "skill issue" are real sample-line fragments but only 2 words — common enough
    // in ordinary chat that a coincidental match isn't a leak.
    const result = detectPersonaSampleLineLeak("cool, moving on then", "totally unrelated agent output", SAMPLE_LINES);
    expect(result.leaked).toBe(false);
  });

  test("no sample lines to check against: never trips", () => {
    const result = detectPersonaSampleLineLeak("yeah that's broken. i know why. gimme 10", "hi there", []);
    expect(result.leaked).toBe(false);
  });

  test("ordinary chat sharing no persona clauses never trips", () => {
    const result = detectPersonaSampleLineLeak("sounds good, talk soon", "sounds good, talk soon", SAMPLE_LINES);
    expect(result.leaked).toBe(false);
  });
});
