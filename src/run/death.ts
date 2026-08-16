/**
 * Beckett — death classification (`src/run/death.ts`, overhaul B7)
 * =======================================================================================
 * Before this module, EVERY worker death — a wall-clock cap kill, a daemon shutdown, an expired
 * credential, a launch failure — took the same road: commit WIP, write an owed-resume row, park
 * for a human. The owed row only ever paid out at the NEXT DAEMON BOOT (`requeueOwedStages`), so a
 * cap kill or a drain kill with the daemon still perfectly healthy parked a run forever until
 * someone typed `beckett task resume`.
 *
 * `classifyDeath` draws the one distinction that matters: did BECKETT stop this worker
 * (self-inflicted — the wall-clock backstop, or the daemon going down), or did something OUTSIDE
 * beckett's control kill it (external — a bad credential, a launch failure, a rate limit, a real
 * crash)? Only the self-inflicted case gets to auto-resume; an external death still parks, because
 * respawning into the same missing credential would just burn another worker on the same wall.
 *
 * Pure module — no I/O, no supervisor imports. `./supervisor.ts` calls into this; it does not
 * re-derive the policy inline.
 */

import type { ErrorClass } from "../types.ts";
import type { Blocker, BlockerClass } from "./types.ts";
import { makeBlocker } from "./blocker.ts";

export type DeathKind = "self-inflicted" | "external";

export interface DeathInput {
  /** The driver stopped this worker on the wall-clock backstop (`error_wall_clock_cap`). */
  timedOut: boolean;
  /** The daemon itself is draining (`RunSupervisor.stop()` already ran) — this death is a restart. */
  shuttingDown: boolean;
  /** The driver's own failure taxonomy (issue #17); absent on a clean success path. */
  errorClass?: ErrorClass;
}

/**
 * `self-inflicted` iff beckett itself stopped the worker — the wall-clock cap, or the daemon
 * going down. Everything else is `external`: the worker died to something outside beckett's
 * control, and re-spawning it verbatim would just re-run into the same wall.
 */
export function classifyDeath(input: DeathInput): DeathKind {
  return input.timedOut || input.shuttingDown ? "self-inflicted" : "external";
}

/** External death → the typed blocker class. Unknown/absent `errorClass` defaults to `transient`. */
const CLASS_BY_ERROR_CLASS: Record<ErrorClass, BlockerClass> = {
  auth: "credential",
  spawn: "transient",
  rate_limit: "transient",
  crash: "transient",
  // Unreachable in practice — a `timeout` errorClass always carries `timedOut: true`, which
  // `classifyDeath` already routes to `self-inflicted` before this table is ever consulted.
  timeout: "transient",
};

/**
 * The typed {@link Blocker} for an EXTERNAL death. `cause` is the caller's already-assembled
 * lifecycle message (`RunSupervisor#workerDeathReason`) — this function types it, it does not
 * re-word it.
 */
export function blockerFromDeath(
  input: DeathInput,
  cause: string,
  runId: string,
  now: () => Date = () => new Date(),
): Blocker {
  const cls: BlockerClass = input.errorClass ? CLASS_BY_ERROR_CLASS[input.errorClass] : "transient";
  return makeBlocker(
    {
      class: cls,
      reversible: true,
      remedy:
        cls === "credential"
          ? `fix the credential, then \`beckett task resume ${runId}\``
          : `\`beckett task resume ${runId}\``,
      detail: cause,
      defaultAnswer: null,
      stage: null,
    },
    now,
  );
}
