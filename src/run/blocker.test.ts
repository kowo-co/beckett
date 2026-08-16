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

    const transient: DoneBlocker = {
      class: "transient",
      detail: "the harness hiccupped",
      remedy: "retry",
      defaultAnswer: null,
    };
    expect(blockerFromDoneSignal(transient, NOW).actor).toBe("supervisor");
  });

  test("every class maps to exactly the actor the table says, not the caller's preference", () => {
    const cases: Array<[DoneBlocker["class"], "human" | "supervisor"]> = [
      ["credential", "human"],
      ["admin-permission", "human"],
      ["product-decision", "human"],
      ["money", "human"],
      ["question", "human"],
      ["transient", "supervisor"],
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
});

describe("stopsTheRun", () => {
  test("transient and continuation never stop the run", () => {
    const transient = makeBlocker(
      { class: "transient", actor: "supervisor", reversible: true, remedy: "retry", detail: "d", defaultAnswer: null },
      NOW,
    );
    const continuation = makeBlocker(
      { class: "continuation", actor: "supervisor", reversible: true, remedy: "continue", detail: "d", defaultAnswer: null },
      NOW,
    );
    expect(stopsTheRun(transient)).toBe(false);
    expect(stopsTheRun(continuation)).toBe(false);
  });

  test("a human-actor blocker stops the run", () => {
    const credential = makeBlocker(
      { class: "credential", actor: "human", reversible: true, remedy: "provide it", detail: "d", defaultAnswer: null },
      NOW,
    );
    expect(stopsTheRun(credential)).toBe(true);
  });
});

describe("renderBlocker", () => {
  test("renderBlocker puts the remedy on its own line", () => {
    const blocker = makeBlocker(
      {
        class: "credential",
        actor: "human",
        reversible: true,
        remedy: "provide a credential",
        detail: "needs a GitHub token with repo scope",
        defaultAnswer: null,
      },
      NOW,
    );
    const rendered = renderBlocker(blocker);
    expect(rendered).toContain("needs a GitHub token with repo scope");
    const lines = rendered.split("\n");
    expect(lines[lines.length - 1]).toBe("To clear this: provide a credential");
  });
});
