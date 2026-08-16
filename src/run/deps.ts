/**
 * Beckett — run dependency edges (`src/run/deps.ts`, overhaul B9)
 * =======================================================================================
 * Two runs that would fight over the same files should queue instead of racing. This module is
 * the whole policy, pure: `readiness()` decides whether a run may start, given every other run in
 * the ledger; `pathOverlaps()` is the file-matcher it (and nothing else) uses. The supervisor
 * calls in here at admission and to derive a dependent worktree's base — it never re-derives this
 * logic inline.
 *
 * OPT-IN BY DECLARATION: a run with no `deps` and no `files` is invisible to this module — every
 * loop below is gated on one of those arrays being non-empty, so an install that never uses
 * `--needs`/`--files` sees byte-identical staffing behavior.
 */
import type { Run, RunState } from "./types.ts";

/** Sibling states an in-flight file overlap is checked against. A `queued` sibling has no files
 * "in flight" yet, so it is never itself a reason to wait — only the run trying to admit is.
 * `awaiting_input` and `parked` are included: both hold a live worktree with real committed
 * edits on their declared files (they ship as LIVE everywhere else — see store.ts LIVE_STATES,
 * supervisor `live()`), so a sibling admitting against those files would still race them. */
const IN_FLIGHT_FOR_OVERLAP: ReadonlySet<RunState> = new Set([
  "implementing",
  "reviewing",
  "publishing",
  "unverified",
  "awaiting_input",
  "parked",
]);

/** Strip a leading `./` so `./src/x.ts` and `src/x.ts` compare equal. */
function normalizePath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** A trailing `/` marks a directory prefix, per the `--files` usage string (no globs). */
function isDirPrefix(path: string): boolean {
  return path.endsWith("/");
}

/**
 * The entries of `a` that collide with an entry of `b` — literal equality, or one side's
 * directory prefix containing the other side's path, checked in both directions. No globs: a
 * match is exact-or-prefix only.
 */
export function pathOverlaps(a: readonly string[], b: readonly string[]): string[] {
  const overlaps: string[] = [];
  for (const rawX of a) {
    const x = normalizePath(rawX);
    for (const rawY of b) {
      const y = normalizePath(rawY);
      if (x === y) {
        overlaps.push(x);
      } else if (isDirPrefix(x) && y.startsWith(x)) {
        overlaps.push(y);
      } else if (isDirPrefix(y) && x.startsWith(y)) {
        overlaps.push(x);
      }
    }
  }
  return overlaps;
}

/** `true` when `a` is the newer of the two — later `createdAt`, or (a tie) the greater id. */
function isNewer(a: Run, b: Run): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

/**
 * Can `run` start right now, given every other run in the ledger (`all`, which may or may not
 * include `run` itself)?
 *
 * - An explicit dep (`run.deps`) that has not reached `state === "done"` blocks admission — a
 *   FAILED dep still blocks: the dependent waits until a human resumes or cancels it, never
 *   auto-proceeds past a dep that didn't make it. A CANCELLED dep clears (it will never finish).
 * - A sibling on the SAME repo, currently `implementing|reviewing|publishing|unverified|
 *   awaiting_input|parked`, whose declared `files` overlap `run.files`, also blocks — and is
 *   reported back in `autoDeps` for tracing only; it is recomputed from `run.files` on every
 *   call, so nothing needs to be persisted for it to survive a restart. Neither side declaring
 *   `files` means no auto edge is ever considered.
 * - CYCLE GUARD: when two runs name each other in `deps` (a human-authored `--needs` mistake, or
 *   two auto edges that happened to point both ways), the NEWER of the two waits and the OLDER
 *   proceeds — an edge back to a run that is itself waiting on us is ignored rather than
 *   deadlocking both forever.
 */
export function readiness(
  run: Run,
  all: readonly Run[],
  /**
   * Run ids the supervisor is ALREADY staffing or running in memory. A run that has been admitted
   * stays `queued` in the ledger for the whole async prefix of its spawn (preflight, repo fetch,
   * worktree cut) — without this set, two runs deployed back-to-back with overlapping `files`
   * would both pass the overlap gate before either flips to `implementing`.
   */
  inFlight: ReadonlySet<string> = new Set(),
): { ready: boolean; waitsOn: string[]; autoDeps: string[] } {
  const byId = new Map(all.map((r) => [r.id, r] as const));
  const waitsOn: string[] = [];
  const autoDeps: string[] = [];

  for (const depId of run.deps) {
    if (depId === run.id) continue;
    const dep = byId.get(depId);
    if (!dep) continue; // an unresolvable dep id can never clear itself; do not wedge on a ghost
    // A done dep is satisfied; a CANCELLED one is never coming back, so it must not wedge its
    // dependent forever either. A FAILED dep still blocks — a human can resume it.
    if (dep.state === "done" || dep.state === "cancelled") continue;
    // Cycle: `dep` also names `run` as one of ITS deps. Break it by letting the older run
    // proceed — only the newer one keeps waiting.
    if (dep.deps.includes(run.id) && isNewer(dep, run)) continue;
    waitsOn.push(depId);
  }

  if (run.files.length > 0) {
    for (const sib of all) {
      if (sib.id === run.id) continue;
      if (sib.repo !== run.repo) continue;
      if (!IN_FLIGHT_FOR_OVERLAP.has(sib.state) && !inFlight.has(sib.id)) continue;
      if (sib.files.length === 0) continue;
      if (pathOverlaps(run.files, sib.files).length === 0) continue;
      if (!waitsOn.includes(sib.id)) waitsOn.push(sib.id);
      if (!run.deps.includes(sib.id)) autoDeps.push(sib.id);
    }
  }

  return { ready: waitsOn.length === 0, waitsOn, autoDeps };
}
