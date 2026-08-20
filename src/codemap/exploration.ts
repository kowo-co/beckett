/**
 * §4 baseline: exploration-tool calls before the first edit, split by whether the run's brief
 * already named a target file. Readable from journal logs with no new instrumentation.
 */

const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

const TOOL_LINE = /^\S+\s+·\s+(\S+)(?:\s{2}(.*))?$/;
const FILE_IN_BRIEF =
  /(?:^|[\s`"'(\[])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|md|json)|(?:\.\/)?[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))(?:$|[\s`'"),:\]])/;

export interface RunBrief {
  id: string;
  title: string;
  prompt: string;
  /** Explicit `--files` footprint from the run record, when present. */
  files?: string[];
}

export interface ExplorationSample {
  id: string;
  namedFile: boolean;
  exploreCalls: number;
  msToFirstEdit: number | null;
  firstEditTool: string | null;
  firstExploreHint: string | null;
}

interface CohortStats {
  n: number;
  meanExplore: number | null;
  medianExplore: number | null;
  p90Explore: number | null;
  meanMsToFirstEdit: number | null;
  noEdit: number;
}

export interface BaselineReport {
  journalDir: string;
  sampleSize: number;
  namedFile: CohortStats;
  unnamedFile: CohortStats;
  samples: ExplorationSample[];
}

export function briefNamesTargetFile(brief: Pick<RunBrief, "title" | "prompt" | "files">): boolean {
  if (brief.files && brief.files.some((f) => f.trim().length > 0 && !f.endsWith("/"))) return true;
  const text = `${brief.title}\n${brief.prompt}`;
  return FILE_IN_BRIEF.test(text);
}

export function parseExploration(logText: string, id: string, namedFile: boolean): ExplorationSample {
  const lines = logText.split(/\n/).filter((l) => l.length > 0);
  let exploreCalls = 0;
  let firstExploreHint: string | null = null;
  let firstEditTool: string | null = null;
  let startMs: number | null = null;
  let firstEditMs: number | null = null;

  for (const line of lines) {
    const stamp = Date.parse(line.slice(0, 24));
    if (!Number.isNaN(stamp) && startMs === null) startMs = stamp;
    const match = TOOL_LINE.exec(line);
    if (!match) continue;
    const tool = match[1]!;
    const hint = match[2]?.trim() || null;
    if (EDIT_TOOLS.has(tool)) {
      firstEditTool = tool;
      if (!Number.isNaN(stamp)) firstEditMs = stamp;
      break;
    }
    if (EXPLORE_TOOLS.has(tool)) {
      exploreCalls += 1;
      firstExploreHint ??= hint;
    }
  }

  return {
    id,
    namedFile,
    exploreCalls,
    msToFirstEdit: startMs !== null && firstEditMs !== null ? firstEditMs - startMs : null,
    firstEditTool,
    firstExploreHint,
  };
}

export function cohortStats(samples: ExplorationSample[]): CohortStats {
  const n = samples.length;
  if (n === 0) {
    return { n: 0, meanExplore: null, medianExplore: null, p90Explore: null, meanMsToFirstEdit: null, noEdit: 0 };
  }
  const explores = samples.map((s) => s.exploreCalls).sort((a, b) => a - b);
  const timed = samples.filter((s) => s.msToFirstEdit !== null).map((s) => s.msToFirstEdit!);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const percentile = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]!;
  return {
    n,
    meanExplore: round1(mean(explores)),
    medianExplore: explores[Math.floor((explores.length - 1) / 2)]!,
    p90Explore: percentile(explores, 0.9),
    meanMsToFirstEdit: timed.length ? Math.round(mean(timed)) : null,
    noEdit: samples.filter((s) => s.firstEditTool === null).length,
  };
}

export function formatReport(report: BaselineReport): string {
  const fmt = (c: CohortStats) =>
    c.n === 0
      ? "n=0"
      : `n=${c.n}  mean=${c.meanExplore}  median=${c.medianExplore}  p90=${c.p90Explore}` +
        (c.meanMsToFirstEdit !== null ? `  mean-ms-to-first-edit=${c.meanMsToFirstEdit}` : "") +
        (c.noEdit ? `  no-edit=${c.noEdit}` : "");
  return [
    `codemap §4 baseline — exploration calls (Read/Grep/Glob) before first Edit/Write/MultiEdit`,
    `journal: ${report.journalDir}`,
    `sample: ${report.sampleSize} runs`,
    `named a target file:    ${fmt(report.namedFile)}`,
    `did not name a file:    ${fmt(report.unnamedFile)}`,
    ``,
    `A codemap can only help the "did not name a file" cohort (plan §2).`,
  ].join("\n");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
