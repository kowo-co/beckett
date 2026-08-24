/**
 * Beckett — Memory maintenance (`src/memory/maintain.ts`)
 * =======================================================================================
 * The routine self-healing pass over the knowledge graph (OPS-121 "better memory"): detect
 * what has rotted and either archive or merge it, so the store stays sharp without a human
 * gardening it. Three detectors:
 *
 *   1. **Expired TTL** — a node whose `ttl` passed more than {@link TTL_GRACE_MS} ago is
 *      archived. Within the grace window it stays (recall already deprioritizes stale nodes);
 *      the grace keeps a just-expired fact findable while it might still be renewed.
 *   2. **Superseded** — `supersedes: [[old]]` on a decision means `old` is replaced by
 *      construction; the old node is archived with a pointer to what replaced it.
 *   3. **Near-duplicates** — two same-type nodes whose stemmed name+description similarity
 *      is ≥ {@link MERGE_THRESHOLD} are merged (canonical keeps everything, duplicate is
 *      archived); pairs in the flag band [{@link DEDUP_THRESHOLD}, MERGE_THRESHOLD) are only
 *      REPORTED — a wrong auto-merge is hard to undo, so borderline stays a human call.
 *
 * **No data loss, ever**: nothing is deleted. Archived files move to `<memoryDir>/archive/`
 * (excluded from the graph and recall) with `archived` / `archived_reason` stamped into
 * their metadata, a merge appends the duplicate's full body to the canonical node, and the
 * memory dir is git-versioned on top — every action is reversible.
 *
 * `planMaintenance` is pure over a built graph (unit-testable, powers `--dry-run`);
 * execution lives in `MemoryStore.maintain` (index.ts) which owns the filesystem.
 * `startRoutineMaintenance` is the daemon hook: one pass shortly after boot, then daily.
 */

import type { Logger, MemoryGraph, MemoryNode, NodeType } from "../types.ts";
import { DEDUP_THRESHOLD, MERGE_THRESHOLD, nodeSimilarity, provenanceOf } from "./search.ts";
import { ageDays, AGED_OBSERVATION_DAYS } from "./freshness.ts";

/** How long past its `ttl` a node survives before the pass archives it. */
export const TTL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Move a node's file to `archive/` and stamp why. */
export interface ArchiveAction {
  name: string;
  reason: "expired-ttl" | "superseded";
  /** For `superseded`: the node whose `supersedes` edge retired this one. */
  by?: string;
  detail: string;
}

/** Fold `duplicate` into `canonical` (bodies appended, aliases merged, links rewritten). */
export interface MergeAction {
  canonical: string;
  duplicate: string;
  similarity: number;
}

/** A pair similar enough to suspect but not enough to auto-merge — surfaced, not acted on. */
export interface FlaggedPair {
  a: string;
  b: string;
  similarity: number;
}

/**
 * A no-ttl node whose last observation is {@link AGED_OBSERVATION_DAYS}+ days old. Aged does
 * NOT mean wrong, and nothing here is ever deleted for age: an old node is an observation
 * made at that point in time — the honest record of how things were, and often still are.
 * This list is the RE-OBSERVATION queue (report-only): for each entry, verify it against the
 * world and `remember` the outcome — a confirmed fact gets a fresh date, a changed one gets a
 * new observation that supersedes by construction. The archive paths above stay the explicit
 * ones (ttl expiry, supersede, merge); age alone never archives.
 */
export interface AgedObservation {
  name: string;
  type: NodeType;
  updated: string;
  ageDays: number;
}

/** What one maintenance pass decided (dry-run returns exactly this, executed or not). */
export interface MaintainReport {
  /** How many memory `.md` files the pass enumerated (the whole store — including any that
   *  failed to parse), so the total never hides that the store is bigger than the graph. */
  scanned: number;
  archives: ArchiveAction[];
  merges: MergeAction[];
  flagged: FlaggedPair[];
  /** Phantom names — referenced but never written; a to-do list, reported not pruned. */
  phantoms: string[];
  /** Long-untouched no-ttl nodes (report-only — see {@link AgedObservation}), oldest first. */
  agedObservations: AgedObservation[];
  dryRun: boolean;
}

/**
 * Decide what a maintenance pass would do to a built graph. Pure: no filesystem, caller
 * passes `now`. Archive decisions are computed first; merge candidates exclude anything
 * already being archived (no point merging into a node on its way out).
 */
export function planMaintenance(
  g: MemoryGraph,
  now: number,
): Omit<MaintainReport, "dryRun" | "scanned"> {
  // Sorted by name so the plan is deterministic: node iteration order otherwise follows
  // readdir order, and in the pairwise scan below that order decides which of two eligible
  // overlapping merges wins (the loser degrades to a flag) — same tree, different plans.
  const real = [...g.nodes.values()]
    .filter((n) => !n.phantom)
    .sort((a, b) => a.name.localeCompare(b.name));
  const archives: ArchiveAction[] = [];
  const archiving = new Set<string>();

  // 1. Expired TTL (past grace).
  for (const n of real) {
    const ttl = n.metadata.ttl;
    if (typeof ttl !== "string" || ttl.trim() === "") continue;
    const t = Date.parse(ttl);
    if (Number.isFinite(t) && now - t > TTL_GRACE_MS) {
      archives.push({
        name: n.name,
        reason: "expired-ttl",
        detail: `ttl ${ttl} expired ${Math.round((now - t) / 86_400_000)}d ago`,
      });
      archiving.add(n.name);
    }
  }

  // 2. Superseded: a `supersedes` edge A→B retires B.
  for (const [from, edges] of g.out) {
    for (const e of edges) {
      if (e.field !== "supersedes") continue;
      const target = g.nodes.get(e.to);
      if (!target || target.phantom || target.name === from) continue;
      if (archiving.has(target.name)) continue;
      archives.push({
        name: target.name,
        reason: "superseded",
        by: from,
        detail: `superseded by ${from}`,
      });
      archiving.add(target.name);
    }
  }

  // 3. Near-duplicates among survivors, same type only. The store is small (tens to low
  //    hundreds of nodes) so the pairwise scan is fine.
  const merges: MergeAction[] = [];
  const flagged: FlaggedPair[] = [];
  const merging = new Set<string>();
  const survivors = real.filter((n) => !archiving.has(n.name));
  // provenanceOf re-parses a node's metadata; derive each survivor's provenance once so the
  // O(n²) pair scan below reads it from the map instead of recomputing it per comparison.
  const prov = new Map(survivors.map((n) => [n.name, provenanceOf(n)]));
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const a = survivors[i]!;
      const b = survivors[j]!;
      if (a.type !== b.type) continue;
      // Never merge (or even flag) across a visibility boundary: a public fact and an owner/dm
      // fact are different facts, and folding one into the other would leak or lose scope.
      const pa = prov.get(a.name)!;
      const pb = prov.get(b.name)!;
      if (pa.visibility !== pb.visibility || pa.dmWith !== pb.dmWith) continue;
      if (merging.has(a.name) || merging.has(b.name)) continue;
      const sim = nodeSimilarity(a, b);
      if (sim >= MERGE_THRESHOLD) {
        const [canonical, duplicate] = pickCanonical(a, b);
        merges.push({ canonical: canonical.name, duplicate: duplicate.name, similarity: round2(sim) });
        merging.add(duplicate.name);
      } else if (sim >= DEDUP_THRESHOLD) {
        flagged.push({ a: a.name, b: b.name, similarity: round2(sim) });
      }
    }
  }

  const phantoms = [...g.nodes.values()].filter((n) => n.phantom).map((n) => n.name).sort();

  // 4. Aged observations (memories are dated observations, never deleted for age): no-ttl
  //    survivors untouched for 180d+. Nodes with a ttl already have a lifecycle (detector 1
  //    owns them); nodes being archived are spoken for. Everything else this old goes on the
  //    re-observation queue — surfaced so it can be verified and re-`remember`ed, never acted on.
  const agedObservations: AgedObservation[] = [];
  for (const n of survivors) {
    if (merging.has(n.name)) continue;
    if (typeof n.metadata.ttl === "string" && n.metadata.ttl.trim() !== "") continue;
    const days = ageDays(n.updated || n.created, now);
    if (days === null || days < AGED_OBSERVATION_DAYS) continue;
    agedObservations.push({ name: n.name, type: n.type, updated: n.updated, ageDays: Math.round(days) });
  }
  agedObservations.sort((a, b) => b.ageDays - a.ageDays);
  return { archives, merges, flagged, phantoms, agedObservations };
}

/** Canonical = the older node (its name is what other memories already link to); ties break
 *  to the one with more content, then lexicographically for determinism. */
function pickCanonical(a: MemoryNode, b: MemoryNode): [MemoryNode, MemoryNode] {
  const ca = Date.parse(a.created);
  const cb = Date.parse(b.created);
  if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca < cb ? [a, b] : [b, a];
  if (a.body.length !== b.body.length) return a.body.length > b.body.length ? [a, b] : [b, a];
  return a.name <= b.name ? [a, b] : [b, a];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// =======================================================================================
// Routine scheduling (the daemon hook)
// =======================================================================================

/** Default cadence: one pass a day keeps a chatty store from rotting between deploys. */
export const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** First pass waits out the boot burst (pollers priming, concierge starting). */
export const MAINTENANCE_BOOT_DELAY_MS = 90_000;

/** The scheduling primitives `startRoutineMaintenance` needs — injectable so a test can drive
 *  the boot pass / interval ticks / stop() deterministically instead of racing real wall-clock
 *  timers (a `setTimeout(5ms)`/`setInterval(20ms)` pair asserted against real `setTimeout` waits
 *  is exactly the kind of race that only shows up under CI contention). Defaults to the real
 *  global timers, unreffed so neither a test process nor a shutting-down daemon is kept alive. */
interface MaintenanceScheduler {
  setTimeout(cb: () => void | Promise<void>, ms: number): unknown;
  setInterval(cb: () => void | Promise<void>, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  clearInterval(handle: unknown): void;
}

const REAL_SCHEDULER: MaintenanceScheduler = {
  setTimeout(cb, ms) {
    const t = setTimeout(cb, ms);
    t.unref?.();
    return t;
  },
  setInterval(cb, ms) {
    const t = setInterval(cb, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  clearInterval: (h) => clearInterval(h as Parameters<typeof clearInterval>[0]),
};

export interface RoutineMaintenanceDeps {
  /** `MemoryStore.maintain` (or anything with its shape). */
  maintain: (opts?: { dryRun?: boolean }) => Promise<MaintainReport>;
  logger: Logger;
  intervalMs?: number;
  initialDelayMs?: number;
  /** Test seam — see {@link MaintenanceScheduler}. Defaults to the real global timers. */
  scheduler?: MaintenanceScheduler;
}

/** Run maintenance shortly after boot and then on a daily timer. Failures are logged and
 *  swallowed — a broken pass must never take the daemon down. Returns a stopper. */
export function startRoutineMaintenance(deps: RoutineMaintenanceDeps): { stop(): void } {
  const interval = deps.intervalMs ?? MAINTENANCE_INTERVAL_MS;
  const initial = deps.initialDelayMs ?? MAINTENANCE_BOOT_DELAY_MS;
  const scheduler = deps.scheduler ?? REAL_SCHEDULER;

  const run = async () => {
    try {
      const r = await deps.maintain();
      const summary = {
        scanned: r.scanned,
        archived: r.archives.length,
        merged: r.merges.length,
        flagged: r.flagged.length,
        phantoms: r.phantoms.length,
        agedObservations: r.agedObservations.length,
      };
      if (r.archives.length || r.merges.length || r.flagged.length || r.agedObservations.length) {
        deps.logger.info("memory maintenance pass", {
          ...summary,
          actions: [
            ...r.archives.map((a) => `archive ${a.name} (${a.detail})`),
            ...r.merges.map((m) => `merge ${m.duplicate} → ${m.canonical} (sim ${m.similarity})`),
            ...r.agedObservations.map((s) => `re-observe? ${s.name} (last observed ${s.ageDays}d ago)`),
          ].join("; "),
        });
      } else {
        deps.logger.debug("memory maintenance pass: store is clean", summary);
      }
    } catch (err) {
      deps.logger.warn("memory maintenance pass failed", { err: String(err) });
    }
  };

  const first = scheduler.setTimeout(run, initial);
  const timer = scheduler.setInterval(run, interval);
  return {
    stop() {
      scheduler.clearTimeout(first);
      scheduler.clearInterval(timer);
    },
  };
}
