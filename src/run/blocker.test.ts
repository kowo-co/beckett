import { describe, expect, test } from "bun:test";
import { blockerFromDoneSignal, makeBlocker, renderBlocker, stopsTheRun } from "./blocker.ts";
import type { DoneBlocker } from "../types.ts";

const NOW = () => new Date("2026-08-15T12:00:00.000Z");

describe("blockerFromDoneSignal", () => {
  test("the class decides the actor — a worker cannot declare itself human-blocked", () => {
    // A worker's `DoneBlocker` has no `actor` field at all — this asserts the actor comes from
    // the class table regardless of what class the worker names, human or supervisor-owned.
    const credential: DoneBlocker = {
      class: "credential",
      detail: "needs a GitHub token",
      remedy: "provide a credential",
      defaultAnswer: null,
    };
    expect(blockerFromDoneSignal(credential, NOW).actor).toBe("human");

    const continuation: DoneBlocker = {
      class: "continuation",
      detail: "ran out of turn",
      remedy: "continue",
      defaultAnswer: null,
    };
    expect(blockerFromDoneSignal(continuation, NOW).actor).toBe("supervisor");
  });

  test("a plain question routes to the concierge, not straight to ro", () => {
    // Worker questions route to the concierge by default (most are answerable from the spec, the
    // repo, or the original ask) — only the owner-class blockers below still name "human".
    const question: DoneBlocker = {
      class: "question",
      detail: "should the retry limit be 3 or 5?",
      remedy: "answer it",
      defaultAnswer: "3",
    };
    expect(blockerFromDoneSignal(question, NOW).actor).toBe("concierge");
  });

  test("every class maps to exactly the actor the table says, not the caller's preference", () => {
    const cases: Array<[DoneBlocker["class"], "human" | "concierge" | "supervisor"]> = [
      // Owner-class: only ro can clear these — a credential, an admin grant, a product call, or
      // money — so they must still name "human", exactly as before this change.
      ["credential", "human"],
      ["admin-permission", "human"],
      ["product-decision", "human"],
      ["money", "human"],
      // A plain question is the concierge's to answer first (see the test above).
      ["question", "concierge"],
      // "transient" maps to "human" (not "supervisor") for now: nothing in this PR gives the
      // supervisor a real auto-resume transition, so a worker-emitted transient blocker must
      // still stop the run rather than tripping hold()'s missing-transition guard on every
      // routine harness crash. See ./blocker.ts's ACTOR_BY_CLASS comment.
      ["transient", "human"],
      ["continuation", "supervisor"],
    ];
    for (const [cls, actor] of cases) {
      const blocker = blockerFromDoneSignal(
        { class: cls, detail: "d", remedy: "r", defaultAnswer: null },
        NOW,
      );
      expect(blocker.actor).toBe(actor);
    }
  });

  test("a worker-emitted transient blocker does not trip hold()'s missing-transition log", () => {
    // Regression: ACTOR_BY_CLASS used to map "transient" -> "supervisor", so every harness-exit
    // done-signal (src/drivers/pi.ts's exitFinishStructuredOutput, always class "transient")
    // produced a blocker that `stopsTheRun` said should NOT stop the run — hold()'s own guard
    // logs an error whenever that happens, so a routine crash logged a false "missing transition."
    const transient = blockerFromDoneSignal(
      { class: "transient", detail: "the harness hiccupped", remedy: "retry", defaultAnswer: null },
      NOW,
    );
    expect(stopsTheRun(transient)).toBe(true);
  });
});

describe("stopsTheRun", () => {
  test("continuation never stops the run", () => {
    const continuation = makeBlocker(
      { class: "continuation", reversible: true, remedy: "continue", detail: "d", defaultAnswer: null, stage: null },
      NOW,
    );
    expect(stopsTheRun(continuation)).toBe(false);
  });

  test("a human-actor blocker stops the run", () => {
    const credential = makeBlocker(
      { class: "credential", reversible: true, remedy: "provide it", detail: "d", defaultAnswer: null, stage: null },
      NOW,
    );
    expect(stopsTheRun(credential)).toBe(true);
  });

  test("a concierge-actor blocker also stops the run — it still needs someone to decide", () => {
    // A "question" reaching hold() (the timeout-with-no-default path, `supervisor.ts`'s
    // onQuestionTimeout) must still park the run rather than trip hold()'s missing-transition
    // guard: "concierge" is a stop, exactly like "human", just a different decider.
    const question = makeBlocker(
      { class: "question", reversible: true, remedy: "answer it", detail: "d", defaultAnswer: null, stage: null },
      NOW,
    );
    expect(question.actor).toBe("concierge");
    expect(stopsTheRun(question)).toBe(true);
  });
});

describe("renderBlocker", () => {
  test("renderBlocker puts the remedy on its own line", () => {
    const blocker = makeBlocker(
      {
        class: "credential",
        reversible: true,
        remedy: "provide a credential",
        detail: "needs a GitHub token with repo scope",
        defaultAnswer: null,
        stage: null,
      },
      NOW,
    );
    const rendered = renderBlocker(blocker);
    expect(rendered).toContain("needs a GitHub token with repo scope");
    const lines = rendered.split("\n");
    expect(lines[lines.length - 1]).toBe("To clear this: provide a credential");
  });
});
