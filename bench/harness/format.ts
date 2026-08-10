/**
 * Beckett — bench harness result formatting (`bench/harness/format.ts`)
 * =======================================================================================
 * Pure result/compare rendering for the eval harness. NO I/O, no `src/` imports, no driver
 * imports — everything here is a total function of its arguments so it can be unit-tested
 * under the repo's `bun test` without spawning a worker or spending a token.
 *
 * The runner (`run.ts`) owns every side effect: spawning workers, staging workspaces, and
 * appending one JSON line per task to `results/<runId>.jsonl`. This module only turns those
 * lines back into records and renders the two human-facing views: a single-run table and a
 * run-to-run comparison.
 */

/** One task's outcome from one bench run — the JSONL record shape. */
export interface TaskResult {
  runId: string;
  suite: string; // suite dir basename, e.g. "default"
  taskId: string;
  model: string; // resolved model actually requested
  effort: string;
  solved: boolean; // check.sh exit 0
  timedOut: boolean; // runner timeout fired before a finished event
  spawnFailed: boolean; // driver.spawn() rejected
  finishedStatus: string | null; // "success" | "error" | null (timeout/spawn-fail)
  finishedSubtype: string | null;
  errorClass: string | null;
  turns: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  usd: number | null;
  wallClockMs: number;
  sessionId: string | null;
  startedAt: string; // ISO 8601
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** How a task's outcome reads in a table cell — failure MODE beats a bare "no". */
function solvedCell(r: TaskResult): string {
  if (r.spawnFailed) return "SPAWN-FAIL";
  if (r.timedOut) return "TIMEOUT";
  return r.solved ? "yes" : "no";
}

function usdCell(usd: number | null): string {
  return usd === null ? "-" : usd.toFixed(4);
}

function wallSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function signed(n: number, digits = 0): string {
  const body = digits > 0 ? Math.abs(n).toFixed(digits) : String(Math.abs(n));
  return (n < 0 ? "-" : "+") + body;
}

function renderRows(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Parse a results JSONL file. Blank lines are skipped (a crashed run can leave one); a
 * malformed line is fatal and names its 1-based line number so a human can go fix it.
 */
export function parseResultsJsonl(text: string): TaskResult[] {
  const out: TaskResult[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as TaskResult);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`bench: malformed results line ${i + 1}: ${message}`);
    }
  }
  return out;
}

/** One run at a glance: a row per task plus a one-line total. */
export function renderRunTable(results: TaskResult[]): string {
  const rows: string[][] = [
    ["task", "solved", "turns", "tools", "tok in", "tok out", "usd", "wall s"],
  ];
  for (const r of results) {
    rows.push([
      r.taskId,
      solvedCell(r),
      String(r.turns),
      String(r.toolCalls),
      String(r.tokens.input),
      String(r.tokens.output),
      usdCell(r.usd),
      wallSeconds(r.wallClockMs),
    ]);
  }

  const solvedCount = results.filter((r) => r.solved).length;
  const tokens = results.reduce((s, r) => s + r.tokens.input + r.tokens.output, 0);
  const anyUsd = results.some((r) => r.usd !== null);
  const usd = anyUsd ? "$" + results.reduce((s, r) => s + (r.usd ?? 0), 0).toFixed(4) : "$-";
  const wall = results.reduce((s, r) => s + r.wallClockMs, 0) / 1000;

  return (
    renderRows(rows) +
    `\n\n${solvedCount}/${results.length} solved · ${tokens} tokens · ${usd} · ${wall.toFixed(1)}s`
  );
}

/**
 * Two runs side by side. This is the whole point of the harness: a harness change is judged
 * by what it moved (solved flips, turns, tokens, wall clock), not by one run's absolute numbers.
 * Deltas are `b - a` and always carry an explicit sign so direction is never ambiguous.
 */
export function renderCompareTable(
  a: TaskResult[],
  b: TaskResult[],
  labels: { a: string; b: string },
): string {
  const byId = (rs: TaskResult[]): Map<string, TaskResult> => {
    const m = new Map<string, TaskResult>();
    for (const r of rs) m.set(r.taskId, r); // last record wins
    return m;
  };
  const aMap = byId(a);
  const bMap = byId(b);

  const order: string[] = [];
  for (const r of a) if (!order.includes(r.taskId)) order.push(r.taskId);
  for (const r of b) if (!order.includes(r.taskId)) order.push(r.taskId);

  const rows: string[][] = [["task", "solved", "Δturns", "Δtok", "Δwall s", "Δusd"]];
  for (const id of order) {
    const ra = aMap.get(id);
    const rb = bMap.get(id);
    if (!ra || !rb) {
      rows.push([id, `(only in ${ra ? labels.a : labels.b})`, "", "", "", ""]);
      continue;
    }
    const dTok = rb.tokens.input + rb.tokens.output - (ra.tokens.input + ra.tokens.output);
    const dUsd = ra.usd === null || rb.usd === null ? "-" : signed(rb.usd - ra.usd, 4);
    rows.push([
      id,
      `${solvedCell(ra)} -> ${solvedCell(rb)}`,
      signed(rb.turns - ra.turns),
      signed(dTok),
      signed((rb.wallClockMs - ra.wallClockMs) / 1000, 1),
      dUsd,
    ]);
  }

  const aSolved = a.filter((r) => r.solved).length;
  const bSolved = b.filter((r) => r.solved).length;

  return (
    `compare: ${labels.a} -> ${labels.b}\n` +
    renderRows(rows) +
    `\n\nsolved: ${aSolved}/${a.length} -> ${bSolved}/${b.length}`
  );
}
