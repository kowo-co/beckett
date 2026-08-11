/**
 * Before/after sample for the dispatch feed digest (#4): `bun scripts/ops/dispatch-digest-sample.ts`.
 *
 * Replays a real feed sequence — the 2026-08-04 04:56Z run, where a deploy killed a live implement
 * worker mid-run — through both renderers: the raw trace rows the channel used to get, and the
 * digest it gets now. Kept as a script so the comparison is reproducible rather than a screenshot.
 */
import { DispatchDigest } from "../../src/dispatch/digest.ts";
import { formatDispatchEvent, type DispatchEvent, type DispatchOutcome } from "../../src/dispatch/events.ts";

const t0 = Date.parse("2026-08-04T04:34:27.000Z");

/**
 * The run as the OLD code recorded it — note the drain-killed worker at 04:56 is a plain `failed`,
 * because `interrupted` did not exist and the dispatcher had no idea it was the one doing the
 * killing. That row is the bug: its "error text" is the worker's own opening narration.
 *
 * [seconds after t0, stage, outcome, message, error]
 */
const rows: Array<[number, string, DispatchOutcome, string?, string?]> = [
  [0, "state:in_progress", "info", "todo → in_progress"],
  [1, "implement:staff", "started", "staffing admitted"],
  [2, "worktree", "started", "creating isolated worktree"],
  [3, "worktree", "passed", "/home/beckett/Projects/beckett/.beckett/worktrees/4"],
  [4, "repo", "started", "provisioning/cloning project repository"],
  [6, "repo", "passed", "repository ready (cloned or initialized)"],
  [7, "implement", "started", "worker wk_8220548c on claude"],
  // The deploy lands: the drain kills the live worker, whose "error" is its own opening narration.
  [1_324, "implement", "failed", "worker exited with error", "I'll start by getting oriented in the repo and understanding the existing CLI structure."],
  // The new daemon boots and replays its recovery batch — then replays it again 20s later.
  [1_340, "restart-restaff", "started", "recovering interrupted worker; re-staff will resume only if ticket remains active"],
  [1_341, "restart-restaff", "passed", "restart recovery complete"],
  [1_342, "implement:staff", "started", "staffing admitted"],
  [1_343, "worktree", "started", "reusing isolated worktree"],
  [1_344, "repo", "passed", "repository ready (cloned or initialized)"],
  [1_345, "implement", "started", "worker wk_31f0ab77 on claude"],
  [1_360, "restart-restaff", "started", "recovering interrupted worker; re-staff will resume only if ticket remains active"],
  [1_361, "restart-restaff", "passed", "restart recovery complete"],
  [1_362, "implement:staff", "started", "staffing admitted"],
  [1_363, "worktree", "started", "reusing isolated worktree"],
  [1_364, "repo", "passed", "repository ready (cloned or initialized)"],
  [2_100, "state:in_review", "info", "in_review → in_review"],
  [2_101, "state:in_review", "info", "in_review → in_review"],
  [2_400, "implement", "passed", "worker finished"],
  [2_405, "pr", "passed", "https://github.com/kowo-co/beckett/pull/204"],
  [2_410, "state:in_review", "passed", "in_progress → in_review"],
  [3_000, "review", "started", "worker wk_a91c2e40 on claude"],
  // A genuine failure, for contrast: real error text, promptly, in its own message.
  [3_600, "review", "failed", "worker exited with error", "review harness exited 1: ENOSPC: no space left on device, write"],
];

/**
 * Seconds-after-t0 of every row emitted while the old daemon was draining. In the real dispatcher
 * this is the `draining` flag {@link ../../src/dispatch/dispatcher.ts drainForShutdown} latches;
 * here it is spelled out so the sample can show the SAME raw run through both code paths.
 */
const DRAINING = new Set([1_324]);

/** The dispatcher's drain rule (#4): while shutting down, a "failure" is our own kill. */
function applyDrainRule(event: DispatchEvent): DispatchEvent {
  if (!DRAINING.has(event.elapsedMs / 1000) || event.outcome !== "failed") return event;
  return {
    ...event,
    outcome: "interrupted",
    message: event.message ? `${event.message} (stopped by a daemon restart)` : "stopped by a daemon restart",
  };
}

const events: DispatchEvent[] = rows.map(([offset, stage, outcome, message, error]) => ({
  ts: new Date(t0 + offset * 1000).toISOString(),
  runId: "ticket-21",
  runRef: "#2.1",
  branchRef: "beckett/task-2-1",
  stage,
  outcome,
  elapsedMs: offset * 1000,
  ...(message ? { message } : {}),
  ...(error ? { error } : {}),
}));

console.log(`=== BEFORE — ${events.length} messages in the channel, one per row ===\n`);
for (const event of events) console.log(formatDispatchEvent(event));

console.log("\n\n=== AFTER — the same run, digested ===\n");
let clock = t0;
const digest = new DispatchDigest({ now: () => clock, timeZone: "America/Los_Angeles" });
let messages = 0;
for (const raw of events) {
  const event = applyDrainRule(raw);
  clock = Date.parse(event.ts);
  const update = digest.observe(event);
  if (!update) continue;
  if (update.fresh) messages++;
  console.log(`--- ${update.fresh ? "POST" : "EDIT"} message ${messages} ---`);
  console.log(update.text);
  console.log();
}
console.log(`(${events.length} events → ${messages} Discord message${messages === 1 ? "" : "s"}, edited in place)`);
