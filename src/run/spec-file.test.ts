import { describe, expect, test } from "bun:test";
import { SPEC_CHECKLIST_PLACEHOLDER, parseSpecChecklist, renderSpecScaffold, specProgressLine, specRunId } from "./spec-file.ts";
import type { Run } from "./types.ts";

const RUN: Pick<Run, "id" | "title" | "branch" | "createdAt" | "prompt"> = {
  id: "run-20260810-oauth-middleware",
  title: "OAuth middleware",
  branch: "beckett/run-oauth-middleware",
  createdAt: "2026-08-10T12:00:00.000Z",
  prompt: "Add OAuth middleware to the API gateway.",
};

describe("renderSpecScaffold", () => {
  test("matches the exact architecture.md format", () => {
    const text = renderSpecScaffold(RUN);
    expect(text).toBe(
      "# OAuth middleware\n" +
        "> run: run-20260810-oauth-middleware · branch: beckett/run-oauth-middleware · created: 2026-08-10T12:00:00.000Z\n" +
        "\n" +
        "## Goal\n" +
        "Add OAuth middleware to the API gateway.\n" +
        "\n" +
        "## Checklist\n" +
        `- [ ] ${SPEC_CHECKLIST_PLACEHOLDER}\n` +
        "\n" +
        "## Notes\n" +
        "(worker scratch: decisions, blockers, handoff notes)\n",
    );
  });

  test("the freshly-rendered scaffold parses as placeholder-only, all-unchecked", () => {
    const parsed = parseSpecChecklist(renderSpecScaffold(RUN));
    expect(parsed.hasPlaceholder).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.done).toBe(0);
  });

  test("specRunId reads the scaffold's run stamp, and unstamped text yields undefined", () => {
    expect(specRunId(renderSpecScaffold(RUN))).toBe(RUN.id);
    expect(specRunId("# Title\n\n## Checklist\n- [ ] a\n")).toBeUndefined();
  });

  test("with several ## Checklist sections the LAST wins — an appended own list beats an inherited stale one", () => {
    const parsed = parseSpecChecklist(
      "# Old run's spec\n" +
        "## Checklist\n- [x] stale inherited item\n\n" +
        "## Checklist\n- [ ] own item\n- [x] own done item\n",
    );
    expect(parsed.items.map((item) => item.text)).toEqual(["own item", "own done item"]);
    expect(parsed.total).toBe(2);
    expect(parsed.done).toBe(1);
  });
});

describe("parseSpecChecklist", () => {
  test("no ## Checklist heading at all → empty, non-placeholder result", () => {
    const parsed = parseSpecChecklist("# Title\n\n## Goal\ndo the thing\n\n## Notes\nnone\n");
    expect(parsed).toEqual({ items: [], total: 0, done: 0, hasPlaceholder: false });
  });

  test("mixed checked/unchecked items are counted correctly", () => {
    const text = "## Checklist\n- [x] first thing\n- [ ] second thing\n- [X] third (capital X)\n";
    const parsed = parseSpecChecklist(text);
    expect(parsed.total).toBe(3);
    expect(parsed.done).toBe(2);
    expect(parsed.items).toEqual([
      { text: "first thing", done: true },
      { text: "second thing", done: false },
      { text: "third (capital X)", done: true },
    ]);
    expect(parsed.hasPlaceholder).toBe(false);
  });

  test("nested/indented boxes under the heading are tolerated and counted", () => {
    const text = "## Checklist\n- [ ] top level\n  - [x] nested one\n    * [ ] nested two, star bullet\n";
    const parsed = parseSpecChecklist(text);
    expect(parsed.total).toBe(3);
    expect(parsed.done).toBe(1);
  });

  test("only bullets under ## Checklist count — a checkbox line elsewhere is ignored", () => {
    const text =
      "## Goal\n- [ ] this looks like a checkbox but is not under Checklist\n\n" +
      "## Checklist\n- [x] real item\n\n" +
      "## Notes\n- [ ] also not a checklist item\n";
    const parsed = parseSpecChecklist(text);
    expect(parsed.total).toBe(1);
    expect(parsed.items[0]).toEqual({ text: "real item", done: true });
  });

  test("placeholder detection matches the literal seeded line, checked or not", () => {
    const unchecked = parseSpecChecklist(`## Checklist\n- [ ] ${SPEC_CHECKLIST_PLACEHOLDER}\n`);
    expect(unchecked.hasPlaceholder).toBe(true);
    const checked = parseSpecChecklist(`## Checklist\n- [x] ${SPEC_CHECKLIST_PLACEHOLDER}\n`);
    expect(checked.hasPlaceholder).toBe(true);
    const different = parseSpecChecklist("## Checklist\n- [ ] a real item, not the placeholder\n");
    expect(different.hasPlaceholder).toBe(false);
  });

  test("all-checked real checklist has hasPlaceholder false and done === total", () => {
    const text = "## Checklist\n- [x] wrote the store\n- [x] wrote the tests\n- [X] typechecked clean\n";
    const parsed = parseSpecChecklist(text);
    expect(parsed.hasPlaceholder).toBe(false);
    expect(parsed.done).toBe(parsed.total);
    expect(parsed.total).toBe(3);
  });

  test("the Checklist section stops at the next ## heading", () => {
    const text = "## Checklist\n- [ ] a\n- [x] b\n## Notes\n- [ ] c\n";
    const parsed = parseSpecChecklist(text);
    expect(parsed.total).toBe(2);
  });
});

describe("specProgressLine", () => {
  test("formats done/total", () => {
    expect(specProgressLine({ done: 3, total: 7 })).toBe("3/7 checked");
    expect(specProgressLine({ done: 0, total: 0 })).toBe("0/0 checked");
  });
});
