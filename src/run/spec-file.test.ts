import { describe, expect, test } from "bun:test";
import { SCAFFOLDING_DIR } from "../worker/worktree.ts";
import {
  SPEC_CHECKLIST_PLACEHOLDER,
  SPEC_FILE_REL,
  parseSpecChecklist,
  renderSpecScaffold,
  specProgressLine,
  specRunId,
  tickedItemTexts,
  untickItems,
} from "./spec-file.ts";
import type { Run } from "./types.ts";

test("SPEC_FILE_REL lives under the scaffolding dir", () => {
  expect(SPEC_FILE_REL).toBe(`${SCAFFOLDING_DIR}/spec.md`);
});

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

// =======================================================================================
// Checklist mutation — the cursor seat's handoff (`../drivers/cursor-runner.ts`)
// =======================================================================================

describe("tickedItemTexts", () => {
  test("returns only the CHECKED items under ## Checklist, in order", () => {
    const text = "## Checklist\n- [x] one\n- [ ] two\n- [X] three\n\n## Notes\n- [x] not a checklist item\n";
    expect(tickedItemTexts(text)).toEqual(["one", "three"]);
  });

  test("a spec with no checklist yields nothing rather than throwing", () => {
    expect(tickedItemTexts("# just a title\n")).toEqual([]);
    expect(tickedItemTexts("")).toEqual([]);
  });
});

describe("untickItems", () => {
  test("resets only the named checked items and reports what it changed", () => {
    const text = "## Checklist\n- [x] one\n- [x] two\n- [ ] three\n";
    const result = untickItems(text, ["two"]);
    expect(result.changed).toEqual(["two"]);
    expect(result.text).toBe("## Checklist\n- [x] one\n- [ ] two\n- [ ] three\n");
  });

  test("the ITEMS survive — only the unverified tick marks are cleared", () => {
    // "without losing the checklist state" means the work items stay; what is dropped is a claim
    // of completion nobody can verify. Both halves matter, so both are asserted.
    const text = "## Checklist\n- [x] wrote the driver\n- [x] wired the registry\n";
    const result = untickItems(text, ["wrote the driver", "wired the registry"]);
    expect(parseSpecChecklist(result.text).items.map((i) => i.text)).toEqual([
      "wrote the driver",
      "wired the registry",
    ]);
    expect(parseSpecChecklist(result.text).done).toBe(0);
    expect(parseSpecChecklist(result.text).total).toBe(2);
  });

  test("indentation, bullet marker and the rest of the file survive byte-for-byte", () => {
    const text =
      "# Title\n> run: run-1 \u00b7 branch: b\n\n## Goal\ndo a thing\n\n## Checklist\n  * [x] nested item\n\n## Notes\nkeep me\n";
    const result = untickItems(text, ["nested item"]);
    expect(result.text).toContain("  * [ ] nested item");
    expect(result.text).toContain("> run: run-1");
    expect(result.text).toContain("## Notes\nkeep me\n");
    expect(specRunId(result.text)).toBe("run-1");
  });

  test("an item outside ## Checklist is never touched", () => {
    const text = "## Checklist\n- [ ] real\n\n## Notes\n- [x] decoy\n";
    expect(untickItems(text, ["decoy"]).changed).toEqual([]);
    expect(untickItems(text, ["decoy"]).text).toBe(text);
  });

  test("an empty target list, an unknown item, and an already-unchecked item are all no-ops", () => {
    const text = "## Checklist\n- [x] one\n- [ ] two\n";
    expect(untickItems(text, []).text).toBe(text);
    expect(untickItems(text, ["nope"]).text).toBe(text);
    expect(untickItems(text, ["two"]).changed).toEqual([]);
  });
});
