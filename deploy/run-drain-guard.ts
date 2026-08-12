#!/usr/bin/env bun
/**
 * Deploy preflight for the daemon's RUN workers (#243).
 *
 * Run against the old daemon immediately before `systemctl restart`, right beside the browser
 * guard. It waits only a finite amount of time and otherwise refuses, naming every run whose
 * implement/review worker the restart would kill. A run worker mid-flight is strictly more
 * expensive to kill than a browser session: the model's session is gone, the stage has to be
 * re-dispatched, and the run parks in the meantime.
 */

import {
  describeRunWorker,
  waitForRunDrain,
  type RunWorkerForDrain,
} from "../src/deploy/run-drain.ts";

// Longer than the browser guard's two minutes: a review pass routinely runs several minutes, and
// the whole point is to let one finish rather than throw it away for a deploy that can wait.
const DEFAULT_WAIT_SECS = 10 * 60;
const MAX_WAIT_SECS = 45 * 60;
const STATUS_TIMEOUT_MS = 35_000;

function waitSeconds(): number {
  const raw = process.env.BECKETT_RUN_DRAIN_WAIT_SECS;
  if (!raw) return DEFAULT_WAIT_SECS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("BECKETT_RUN_DRAIN_WAIT_SECS must be a non-negative number");
  }
  // An environment typo must never make deploy wait indefinitely.
  return Math.min(Math.floor(value), MAX_WAIT_SECS);
}

/** Read the old daemon's status with its own deadline so an unavailable bus fails closed. */
async function daemonStatus(): Promise<unknown> {
  const child = Bun.spawn([process.execPath, "src/cli/beckett.ts", "status"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((resolve) => {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        void child.exited.then(resolve);
      }, STATUS_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (timedOut) {
    throw new Error(`status exceeded its ${Math.ceil(STATUS_TIMEOUT_MS / 1_000)}s deadline`);
  }
  if (exitCode !== 0) {
    throw new Error(`could not read status from the running daemon: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("could not parse status from the running daemon");
  }
}

const describe = (worker: RunWorkerForDrain) => describeRunWorker(worker);

async function main(): Promise<void> {
  const seconds = waitSeconds();
  const result = await waitForRunDrain({
    status: daemonStatus,
    waitMs: seconds * 1_000,
    onWaiting: (workers, remainingMs) => {
      console.log(
        `== deploy preflight: waiting for run worker(s) ${workers.map(describe).join(", ")}; ` +
          `${Math.ceil(remainingMs / 1_000)}s remain before restart is refused ==`,
      );
    },
  });
  if (result.drained) {
    console.log("== deploy preflight: no live run workers; safe to restart ==");
    return;
  }
  throw new Error(
    `refusing to restart with live run worker(s): ${result.workers.map(describe).join(", ")}. ` +
      "Wait for the stage to finish, or `beckett task cancel <id>` deliberately, then deploy again.",
  );
}

main().catch((error) => {
  console.error(`FATAL: run-worker deploy preflight: ${(error as Error).message}`);
  process.exitCode = 1;
});
