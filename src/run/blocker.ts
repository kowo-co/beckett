/**
 * Beckett — the typed blocker (`src/run/blocker.ts`, overhaul B5)
 * =======================================================================================
 * Before this module, `park(run, freeText)` was the universal exception handler: ten call sites
 * across the supervisor, each writing its own free-text reason, with no policy distinguishing
 * "wait for a human" from "beckett should just retry this." A `Blocker` replaces the free text
 * with a typed reason, and its `class` — NOT the caller — decides who can clear it
 * ({@link ACTOR_BY_CLASS}). That is the whole point: a worker's own done-signal names a
 * `BlockerClass`, never an `actor`, so a model cannot talk itself (or the run) into stopping.
 *
 * Pure module — no I/O, no supervisor imports. `./supervisor.ts` calls into this; it does not
 * re-derive the actor policy inline.
 */

import type { DoneBlocker } from "../types.ts";
import type { Blocker, BlockerActor, BlockerClass } from "./types.ts";

/**
 * Who can clear each blocker class. The supervisor treats this as the single source of truth:
 * `hold()` logs an error (never silently trusts the caller) if a blocker's `actor` disagrees with
 * this table, because that disagreement means something upstream tried to grant itself a stop.
 */
const ACTOR_BY_CLASS: Record<BlockerClass, BlockerActor> = {
  credential: "human",
  "admin-permission": "human",
  "product-decision": "human",
  money: "human",
  question: "human",
  // "human" for now (not "supervisor") because nothing in this PR gives the supervisor a real
  // auto-resume transition for a transient failure — every harness-exit done-signal comes through
  // here with class "transient" (`src/drivers/pi.ts`), and an actor the run cannot itself clear
  // would trip `hold()`'s missing-transition guard on every routine crash. Flips to "supervisor"
  // once Task 3 gives it somewhere real to go.
  transient: "human",
  continuation: "supervisor",
};

/**
 * Mint a {@link Blocker}. `actor` is NOT part of the input — it is looked up from
 * {@link ACTOR_BY_CLASS} by `class`, so no call site (worker-driven or supervisor-driven) can
 * pass its own opinion of who should clear it. `at` is stamped from `now` (injectable for tests).
 */
export function makeBlocker(
  input: Omit<Blocker, "at" | "actor">,
  now: () => Date = () => new Date(),
): Blocker {
  return { ...input, actor: ACTOR_BY_CLASS[input.class], at: now().toISOString() };
}

/** Only a human-actor blocker stops a run. Everything else is the supervisor's own business. */
export function stopsTheRun(b: Blocker): boolean {
  return b.actor === "human";
}

/**
 * A worker's own `DoneBlocker` (its `class`, `detail`, `remedy`, `defaultAnswer` — never an
 * `actor`) becomes a supervisor-typed `Blocker` here. The actor comes ONLY from
 * {@link ACTOR_BY_CLASS} — the worker's opinion of who should clear it is not consulted.
 */
export function blockerFromDoneSignal(s: DoneBlocker, now: () => Date = () => new Date()): Blocker {
  return makeBlocker(
    {
      class: s.class,
      reversible: true,
      remedy: s.remedy,
      detail: s.detail,
      defaultAnswer: s.defaultAnswer,
      stage: null,
    },
    now,
  );
}

/** The long form a human reads: the detail, then the one-line remedy on its own line. */
export function renderBlocker(b: Blocker): string {
  return `${b.detail}\n\nTo clear this: ${b.remedy}`;
}
