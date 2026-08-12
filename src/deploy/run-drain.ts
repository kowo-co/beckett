/**
 * Bounded RUN-worker preflight used by production deploys before restarting the daemon (#243).
 *
 * A run's implement/review worker owns a volatile Claude session. The session does not survive a
 * `systemctl restart`: on 2026-08-12 the v7.0.5 deploy killed a reviewer four minutes into its
 * pass, and the run parked holding work nobody was driving. This is `./browser-drain.ts`'s
 * mechanism applied to the strictly more expensive case — same shape, same finite deadline, same
 * fail-closed posture — so the deploy script gates on one familiar contract for both.
 *
 * WHAT BLOCKS A RESTART IS A LIVE WORKER, not a live run. A queued, parked, or publishing run has
 * no session to lose: the boot scan re-admits it, and the durable publish outbox drains itself on
 * boot. Only a row with a `workerId` has a model mid-thought. Blocking on anything wider would
 * make a parked run — the very thing a bad restart creates — permanently un-deployable-over.
 */

/** One live-worker row off `beckett status`'s `runs` array (`RunSupervisor.live()`). */
export interface RunWorkerForDrain {
  runId: string;
  state: string;
  /** "implement" | "review" — what the worker is doing, so the log line names it. */
  stage: string | null;
  workerId: string;
  /** Epoch ms the worker spawned; null when the daemon predates the field. */
  startedAt: number | null;
}

export interface RunDrainResult {
  drained: boolean;
  workers: RunWorkerForDrain[];
}

export interface RunDrainOptions {
  /** Reads the JSON emitted by `beckett status` from the still-running daemon. */
  status: () => Promise<unknown>;
  /** Maximum time to wait. Callers must cap this at a safe operational limit. */
  waitMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each bounded sleep while a run worker is still live. */
  onWaiting?: (workers: RunWorkerForDrain[], remainingMs: number) => void;
}

/**
 * Extract the run workers a restart would kill. `beckett status` prints the bus `data` directly
 * while a direct control-bus caller receives `{ ok, data }`; accepting both prevents the preflight
 * from reading a live CLI result as idle — the same tolerance `./browser-drain.ts` needed.
 */
export function restartBlockingRunWorkers(status: unknown): RunWorkerForDrain[] {
  if (!status || typeof status !== "object") return [];
  const envelope = status as { data?: unknown };
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : status;
  const runs = (data as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  const blocking: RunWorkerForDrain[] = [];
  for (const row of runs) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    if (typeof value.runId !== "string") continue;
    // The whole test: a worker id means a harness process with a live session. No id, no loss.
    if (typeof value.workerId !== "string" || value.workerId.length === 0) continue;
    blocking.push({
      runId: value.runId,
      state: typeof value.state === "string" ? value.state : "unknown",
      stage: typeof value.stage === "string" ? value.stage : null,
      workerId: value.workerId,
      startedAt: typeof value.startedAt === "number" ? value.startedAt : null,
    });
  }
  return blocking;
}

/** "run-2026… (review worker wk_7f3a, age 247s)" — a refusal a human can act on immediately. */
export function describeRunWorker(worker: RunWorkerForDrain, now: number = Date.now()): string {
  const age =
    worker.startedAt === null ? "age unknown" : `age ${Math.max(0, Math.floor((now - worker.startedAt) / 1_000))}s`;
  return `${worker.runId} (${worker.stage ?? worker.state} worker ${worker.workerId}, ${age})`;
}

/** Poll until every run worker is gone, or return the blockers at a finite deadline. */
export async function waitForRunDrain(options: RunDrainOptions): Promise<RunDrainResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollMs = Math.max(1, options.pollMs ?? 10_000);
  const deadline = now() + Math.max(0, options.waitMs);

  while (true) {
    const workers = restartBlockingRunWorkers(await options.status());
    if (workers.length === 0) return { drained: true, workers: [] };

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { drained: false, workers };
    options.onWaiting?.(workers, remainingMs);
    await sleep(Math.min(pollMs, remainingMs));
  }
}
