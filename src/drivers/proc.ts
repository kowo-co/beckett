/**
 * Beckett — driver process-lifecycle helpers (`src/drivers/proc.ts`)
 * =======================================================================================
 * Small, driver-agnostic helpers shared by the claude/codex/pi drivers for two things the
 * three of them used to hand-roll (and drift on):
 *
 *   1. The GENEROUS, CONFIGURABLE wall-clock backstop cap the per-worker watchdog enforces
 *      ({@link hardCapSeconds}). This is a runaway-worker safety net, NOT a normal work limit —
 *      real tickets routinely need far more than the old tight per-effort caps. The old 600s
 *      "guillotine" (OPS-50) is gone; the driver watchdog now trips only at this backstop, and
 *      the backstop itself moved 1h → 4h once real runs started hitting it mid-edit.
 *
 *   2. Killing a harness AND ITS WHOLE PROCESS TREE ({@link wrapProcessGroup} + {@link
 *      killProcessTree}). A `claude`/`pi`/`codex` worker forks descendants (bash tool runs, MCP
 *      servers, sub-agent harnesses). SIGKILL on the harness pid ALONE orphans those descendants —
 *      they reparent to init and keep mutating the checkout (the OPS-45/OPS-50 "orphan stomps
 *      files" bug). Launching the harness as its own process-group leader (`setsid`) lets us signal
 *      the entire group with one `kill(-pgid)` so nothing survives the reap.
 */

import type { Config, Logger } from "../types.ts";

/**
 * Absolute path to `setsid`, resolved once at load. `null` when unavailable (non-Linux / a minimal
 * image) — in that case callers must fall back to a single-pid kill and MUST NOT group-kill (a
 * negative-pid signal would otherwise hit the daemon's own process group).
 */
const SETSID_BIN: string | null = (() => {
  try {
    return Bun.which("setsid");
  } catch {
    return null;
  }
})();

/** Default backstop wall-clock cap: 4 hours. See {@link hardCapSeconds} for why this number. */
export const DEFAULT_HARD_CAP_S = 14_400;

/** Below this, a configured cap is treated as a stray value and the default is used instead. */
export const HARD_CAP_FLOOR_S = 1_800;

/**
 * The generous, configurable backstop wall-clock cap (seconds) the per-worker watchdog enforces.
 * Reads `config.supervise.worker_hard_cap_s`. Defensive floor of 1800s (30min) so a stray config
 * value can never tighten it back into the old guillotine; defaults to {@link DEFAULT_HARD_CAP_S}
 * when unset or below the floor.
 *
 * WHY 4h and not the old 1h (2026-08-14): the 1h default was demonstrably a WORK limit, not a
 * backstop. `run-20260814-collect-an-unlabelled-pretraining-corpus` was killed at 3601s having
 * written ~4000 lines across 31 files, mid-edit and nearly done — a healthy worker, stopped for
 * being slow. A backstop must only ever fire on a worker that is not converging, and it is not
 * this layer's job to catch a merely-silent one: `supervise.worker_stall_s` (default 300s) already
 * signals a wedge in 5 minutes and the dispatcher escalates nudge → abort+retry off that. What is
 * left for the wall-clock cap is the narrow case of a worker making noise forever, so it should sit
 * far above any real run — 4h is ~4x the longest legitimate implement run observed, and still bounds
 * a runaway's burn to one session. Raise it per-install if a repo genuinely needs longer.
 */
export function hardCapSeconds(config: Config): number {
  const v = config.supervise?.worker_hard_cap_s;
  return typeof v === "number" && v >= HARD_CAP_FLOOR_S ? v : DEFAULT_HARD_CAP_S;
}

/**
 * Wrap a harness command so the launched process becomes a NEW process-group leader (via `setsid`),
 * so {@link killProcessTree} can later kill the ENTIRE tree — the harness plus every bash/MCP/
 * sub-agent child it forked — with one group signal. Returns `groupKill:false` when `setsid` is
 * unavailable; callers then fall back to a single-pid kill (never a negative-pid group kill).
 */
export function wrapProcessGroup(bin: string, args: string[]): { cmd: string[]; groupKill: boolean } {
  if (SETSID_BIN) return { cmd: [SETSID_BIN, bin, ...args], groupKill: true };
  return { cmd: [bin, ...args], groupKill: false };
}

/**
 * Boot-time sweep of a worker process recorded in the crash-recovery ledger (issue #20): when the
 * DAEMON died (kill -9, OOM, crash), its setsid'd workers survive as orphans with no watchdog and
 * keep editing the checkout — this reaps them before any re-staff. UNLIKE {@link killGroup}, the
 * daemon that spawned this pid is gone, so the pid may have been RECYCLED by an unrelated process:
 * we first verify via `ps` that the command line still looks like the recorded harness, and skip
 * (loudly) when it doesn't. Returns true when a live orphan was found and killed.
 */
export function sweepLedgeredWorker(pid: number, expectedBin: string, log?: Logger): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let command: string;
  try {
    const ps = Bun.spawnSync({ cmd: ["ps", "-o", "command=", "-p", String(pid)], stdout: "pipe", stderr: "pipe" });
    command = ps.stdout.toString().trim();
  } catch {
    return false; // no ps available — never blind-kill a possibly-recycled pid
  }
  if (!command) return false; // already gone
  if (!command.includes(expectedBin)) {
    log?.warn("ledgered pid is alive but is NOT the recorded harness (pid recycled?) — not killing", {
      pid,
      expectedBin,
      command: command.slice(0, 120),
    });
    return false;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the whole group (harness + descendants)
  } catch {
    try {
      process.kill(pid, "SIGKILL"); // not a group leader (setsid unavailable at spawn)
    } catch {
      return false; // gone between the ps check and the kill
    }
  }
  log?.warn("swept orphaned worker process group from a previous daemon", { pid, command: command.slice(0, 120) });
  return true;
}

/**
 * Best-effort SIGKILL sweep of a harness's process group AFTER its leader has already exited (the
 * crash / clean-exit path, where we no longer hold a live child handle). Reaps any descendant the
 * harness left behind so a subsequent retry worker can't collide with a still-running orphan
 * (the OPS-45 "orphan stomps index.html" bug). Safe against PID reuse: the kernel keeps the leader's
 * PID reserved as a PGID while the group is non-empty, so `-pid` only ever targets our own group.
 * A no-op unless the harness was launched as a group leader (see {@link wrapProcessGroup}).
 */
export function killGroup(pid: number, groupKill: boolean, log?: Logger): void {
  if (!groupKill || !Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
    log?.info("swept lingering process group after harness exit", { pid });
  } catch {
    // group already empty / gone — nothing to sweep
  }
}

/** The minimal subprocess surface {@link killProcessTree} needs (Bun.Subprocess satisfies it). */
interface Killable {
  pid: number;
  kill: (sig?: number | NodeJS.Signals) => void;
  exited: Promise<number>;
}

/**
 * Kill a spawned harness and ALL its descendants, escalating SIGTERM→SIGKILL after a grace. When
 * the child was launched as a group leader (see {@link wrapProcessGroup}), signals the whole
 * process group (`-pid`) so no orphan survives; otherwise falls back to the single pid. Idempotent
 * and best-effort — every syscall is guarded (ESRCH once the process is already gone) and the final
 * wait is time-boxed so a wedged descendant can never hang the daemon.
 */
export async function killProcessTree(
  child: Killable,
  opts: { groupKill: boolean; graceMs: number; log?: Logger },
): Promise<void> {
  const pid = child.pid;
  const signal = (sig: NodeJS.Signals): void => {
    try {
      if (opts.groupKill) process.kill(-pid, sig);
      else child.kill(sig);
    } catch {
      // already gone (ESRCH) or not permitted — best-effort by contract
    }
  };

  signal("SIGTERM");
  const exitedInTime = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), opts.graceMs)),
  ]);
  if (exitedInTime) {
    // A cooperative harness leader can exit on SIGTERM while one of its children ignores it.
    // The leader's exit does NOT mean its setsid process group is empty: the surviving child keeps
    // the old PGID and becomes an orphan. Always sweep that group before reporting abort complete.
    // For a non-group launch this intentionally falls back to the already-exited leader only.
    if (opts.groupKill) {
      opts.log?.info("harness leader exited on SIGTERM — sweeping remaining process group", { pid });
      signal("SIGKILL");
    }
    return;
  }

  opts.log?.warn("harness did not exit on SIGTERM — SIGKILL the process tree", { pid });
  signal("SIGKILL");
  // SIGKILL on the group leader is fatal, but time-box the wait so we never block on a stuck
  // descendant holding the group open.
  await Promise.race([
    child.exited,
    new Promise<void>((r) => setTimeout(r, opts.graceMs)),
  ]);
}
