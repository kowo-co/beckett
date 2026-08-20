import { expect, test } from "bun:test";
import { briefNamesTargetFile, cohortStats, parseExploration } from "./exploration.ts";

const namedLog = `
2026-08-19T10:00:00.000Z ▸ implement worker started (sonnet)
2026-08-19T10:00:05.000Z   · Read  src/dispatch/spawn.ts
2026-08-19T10:00:12.000Z   · Edit  src/dispatch/spawn.ts
2026-08-19T10:00:20.000Z   · Grep  leftover
`.trim();

const unnamedLog = `
2026-08-19T11:00:00.000Z ▸ implement worker started (sonnet)
2026-08-19T11:00:04.000Z   · Glob  src/capability/**/*.ts
2026-08-19T11:00:08.000Z   · Grep  promptBlock
2026-08-19T11:00:15.000Z   · Read  src/capability/index.ts
2026-08-19T11:00:22.000Z   · Read  src/capability/modules/github.ts
2026-08-19T11:00:40.000Z   · Write  src/capability/modules/codemap.ts
`.trim();

test("parseExploration counts Read/Grep/Glob until the first Edit/Write/MultiEdit", () => {
  const named = parseExploration(namedLog, "run-named", true);
  expect(named.exploreCalls).toBe(1);
  expect(named.firstEditTool).toBe("Edit");
  expect(named.msToFirstEdit).toBe(12_000);

  const unnamed = parseExploration(unnamedLog, "run-unnamed", false);
  expect(unnamed.exploreCalls).toBe(4);
  expect(unnamed.firstEditTool).toBe("Write");
});

test("briefNamesTargetFile is true only when the ticket actually pointed at a file", () => {
  expect(
    briefNamesTargetFile({
      title: "Fix the spawn hang",
      prompt: "the worker dies in src/dispatch/spawn.ts after a tool call",
    }),
  ).toBe(true);
  expect(
    briefNamesTargetFile({
      title: "Codemap context capability",
      prompt: "build the smallest first slice of the plugin plan",
    }),
  ).toBe(false);
  expect(briefNamesTargetFile({ title: "Touch these", prompt: "go", files: ["src/foo.ts"] })).toBe(true);
  expect(briefNamesTargetFile({ title: "A directory", prompt: "go", files: ["src/"] })).toBe(false);
});

test("cohortStats splits means across the two groups", () => {
  const samples = [
    parseExploration(namedLog, "a", true),
    parseExploration(unnamedLog, "b", false),
    parseExploration(namedLog, "c", true),
  ];
  const named = cohortStats(samples.filter((s) => s.namedFile));
  const unnamed = cohortStats(samples.filter((s) => !s.namedFile));
  expect(named.n).toBe(2);
  expect(named.meanExplore).toBe(1);
  expect(unnamed.n).toBe(1);
  expect(unnamed.meanExplore).toBe(4);
});
