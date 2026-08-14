/**
 * Durable GitHub publish outbox.
 *
 * A finished checkout is valuable: a GitHub hiccup must not turn it back into work or lose the
 * only worktree containing it.  Like AdvanceOutbox this is deliberately boring JSONL, but each
 * run has exactly one row (the row owns its worktree until it is removed).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkItem } from "../run/work-item.ts";
import type { Logger } from "../types.ts";

export const PUBLISH_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;
/** Longest a retry hold can legitimately be scheduled out; anything beyond is a sentinel/bug. */
export const MAX_PUBLISH_RETRY_DELAY_MS = Math.max(...PUBLISH_RETRY_DELAYS_MS);
/**
 * attempts 1..4: the first 3 failures each schedule the next delay off the ladder above; the 4th
 * failure parks for a human courier instead of scheduling a 4th delay (#227 — an unattended row
 * that never stops retrying is indistinguishable from one silently wedged forever).
 */
export const PUBLISH_MAX_ATTEMPTS = PUBLISH_RETRY_DELAYS_MS.length + 1;
export type PublishPurpose = "done" | "wip";

export interface PublishOperation {
  id: string;
  item: WorkItem;
  slug: string;
  repoRoot: string;
  messagePrefix: string;
  summary: string;
  purpose: PublishPurpose;
  /** Number of failed attempts already made (the initial synchronous attempt is 1). */
  attempt: number;
  nextAttemptAt: number;
  createdAt: string;
}

export type PublishFailureKind = "transient" | "permanent";

/** Verbatim message off an Error (or `String(error)` for a non-Error throw) — never summarized. */
export function publishErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classifier: only KNOWN unrecoverable-without-a-human failure classes are permanent — an
 * auth/permission failure, a fork PAT limit, or the repo genuinely not existing. Everything else
 * defaults to "transient".
 *
 * #227 root cause: this used to default an UNMATCHED error to "permanent" (only a recognized
 * 5xx/network/timeout pattern was "transient"). Real gh/git failure text rarely matches a
 * hand-written transient regex exactly, so almost every first failure fell through to the
 * permanent default and got `nextAttemptAt: Number.MAX_SAFE_INTEGER` — a silent park after exactly
 * one attempt, logged as "queued ... for retry". Flipping the default to "transient" means an
 * unrecognized error gets the real backoff ladder (attempts 1..4) instead of skipping straight to
 * park; the ladder itself is what bounds how long an unattended retry loop can run.
 */
export function classifyPublishError(error: unknown): PublishFailureKind {
  const message = publishErrorMessage(error);
  if (
    /\b(?:401|403|404)\b|unauthori[sz]ed|forbidden|repository not found|could not resolve to a repository|cross[- ]fork|fork.{0,80}(?:pat|token|pull request)|resource not accessible by integration/i.test(
      message,
    )
  ) return "permanent";
  return "transient";
}

/** Why a publish attempt landed where it did: a matched failure class, or the ladder running out. */
export type PublishRetryReason = PublishFailureKind | "attempts-exhausted";

export interface PublishRetryPlan {
  action: "retry" | "park";
  nextAttemptAt: number;
  reason: PublishRetryReason;
  /** Verbatim underlying error text. */
  error: string;
  /**
   * Honest one-liner for logs/trace: "publish attempt N failed — retrying in Xs" while there is
   * still a rung left on the ladder, "parked for human courier" once there is not (#227 — never
   * "queued for retry" on a row that is not actually going to be retried).
   */
  message: string;
}

/**
 * Decide what happens after `attempt` (the count of failed attempts INCLUDING this one) just
 * failed with `error`. The single source of truth for both the durable outbox row's own retry
 * scheduling (`RunSupervisor.publishRun`, attempt 1) and every replay after it
 * (`RunSupervisor.replayPublishes`, attempts 2..) — so a park decided on attempt 1 and one decided
 * on attempt 4 are reached by identical logic and logged identically.
 */
export function planPublishRetry(attempt: number, error: unknown, now: number = Date.now()): PublishRetryPlan {
  const errorMessage = publishErrorMessage(error);
  const kind = classifyPublishError(error);
  if (kind === "permanent") {
    return { action: "park", nextAttemptAt: Number.MAX_SAFE_INTEGER, reason: "permanent", error: errorMessage, message: "parked for human courier" };
  }
  if (attempt >= PUBLISH_MAX_ATTEMPTS) {
    return {
      action: "park", nextAttemptAt: Number.MAX_SAFE_INTEGER, reason: "attempts-exhausted", error: errorMessage,
      message: "parked for human courier",
    };
  }
  const delay = PUBLISH_RETRY_DELAYS_MS[attempt - 1]!;
  return {
    action: "retry", nextAttemptAt: now + delay, reason: kind, error: errorMessage,
    message: `publish attempt ${attempt} failed — retrying in ${formatDelay(delay)}`,
  };
}

/**
 * The actionable half of a publish failure: what to DO about the class of error git/gh reported.
 * The verbatim error already says what broke; an operator reading a parked run needs the command
 * that clears it. Null when the error is not a shape we can name a fix for — never a guess.
 */
export function publishFixHint(error: string): string | null {
  if (/does not appear to be a git repository|no such remote|remote .+ (?:does not exist|not found)|no (?:configured )?(?:push destination|remote)/i.test(error)) {
    return (
      "the checkout has no usable `origin` remote, so there is nowhere to push. Wire one — " +
      "`git remote add origin https://github.com/<owner>/<name>.git` in the project checkout — then re-run the publish."
    );
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|resource not accessible by integration|permission denied/i.test(error)) {
    return (
      "the GitHub credential cannot write there. Check it with `beckett gh preflight --repo <owner/name>` " +
      "and make sure the App is installed on that repo."
    );
  }
  if (/\b404\b|repository not found|could not resolve to a repository|name already exists/i.test(error)) {
    return (
      "the target repo is missing or invisible to the credential. Confirm it with " +
      "`beckett gh raw -- repo view <owner/name>`, create it if it is genuinely absent, then re-run the publish."
    );
  }
  return null;
}

/**
 * The `error` string a run carries while (and after) a publish attempt fails — the fix for a run
 * that sat in `publishing` with `error: null` for half an hour and told nobody anything
 * (2026-08-14). Names the STEP, the attempt, the verbatim cause, and — when the cause is a shape we
 * recognize — the command that clears it.
 */
export function publishFailureReason(
  plan: PublishRetryPlan,
  attempt: number,
  /** The run this is about, so the hand-off commands are copy-pasteable rather than placeholders. */
  ref?: { runId: string; branch: string },
): string {
  const head =
    plan.action === "park"
      ? `publishing failed and is now parked for a human (${plan.reason === "permanent" ? "unrecoverable without a human" : `no attempts left after ${attempt} of ${PUBLISH_MAX_ATTEMPTS}`})`
      : `publishing failed on attempt ${attempt} of ${PUBLISH_MAX_ATTEMPTS} — ${plan.message.replace(/^publish attempt \d+ failed — /, "")}`;
  const cause = plan.error.trim().replace(/[.\s]+$/, "");
  const hint = publishFixHint(plan.error);
  const detail = hint ? `${cause} — ${hint}` : `${cause}.`;
  const courier =
    plan.action === "park"
      ? ` Publish it by hand (\`beckett gh push --repo <owner/name> --branch ${ref?.branch ?? "<branch>"}\`), ` +
        `then close it out with \`beckett task courier ${ref?.runId ?? "<run-id>"}\`.`
      : "";
  return `${head}: ${detail}${courier}`;
}

/** "30s" / "2m" / "10m" — the ladder's own delays are round numbers, so this stays simple. */
function formatDelay(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m${remainder}s` : `${minutes}m`;
}

export type PublishDrainResult =
  | { action: "remove" }
  | { action: "keep"; operation: PublishOperation };

export class PublishOutbox {
  /**
   * `drain()` can be entered by boot recovery and a poll tick at the same time.  One in-process
   * drainer prevents both from reading the same JSONL row and publishing it twice.  GitHub-side
   * idempotency is still the last line of defence for a process crash.
   */
  private draining: Promise<number> | undefined;
  /** Rows cancelled while an in-flight drain is awaiting I/O must never be written back. */
  private readonly cancelled = new Set<string>();

  constructor(private readonly path: string, private readonly logger: Logger) {}

  /**
   * Replaces an existing row for the run: an outbox row has exclusive publish ownership.
   * `plan` is the {@link planPublishRetry} decision that produced `op` — logged VERBATIM (#227:
   * the old log here carried no error field at all, just attempt/nextAttemptAt) with the honest
   * retry-vs-park wording the plan already computed, so this can never drift from what `op` says.
   */
  append(op: PublishOperation, plan: Pick<PublishRetryPlan, "message" | "error" | "reason">): void {
    // A genuinely new operation after a previous courier handoff owns the ticket anew.
    this.cancelled.delete(op.item.id);
    const ops = this.read().filter((existing) => existing.item.id !== op.item.id);
    ops.push(op);
    this.writeAll(ops);
    this.logger.warn(plan.message, {
      id: op.id, item: op.item.identifier, attempt: op.attempt, nextAttemptAt: op.nextAttemptAt,
      reason: plan.reason, error: plan.error,
    });
  }

  has(itemId: string): boolean {
    return this.read().some((op) => op.item.id === itemId);
  }

  /**
   * The row that owns `itemId`, or undefined. `has()` answers "is something holding this run",
   * which is not enough for the publishing-stall guard: a row parked at
   * {@link Number.MAX_SAFE_INTEGER} is holding the run and is NEVER going to run again, and a run
   * held by one of those is exactly the silent forever-`publishing` wedge the guard exists to end.
   */
  get(itemId: string): PublishOperation | undefined {
    return this.read().find((op) => op.item.id === itemId);
  }

  /** A human courier owns publishing from this point; never race them with a stale retry. */
  cancel(itemId: string): boolean {
    const ops = this.read();
    // Record the cancellation before an async drain can resume and rewrite its stale snapshot.
    this.cancelled.add(itemId);
    const kept = ops.filter((op) => op.item.id !== itemId);
    if (kept.length === ops.length) return false;
    this.writeAll(kept);
    this.logger.info("cancelled queued GitHub publish for human courier", { itemId });
    return true;
  }

  drain(
    apply: (op: PublishOperation) => Promise<PublishDrainResult>,
    now = Date.now(),
    /** Reconcile durable ownership/state without spending an early retry attempt. */
    reconcile?: (op: PublishOperation) => Promise<PublishDrainResult | null>,
  ): Promise<number> {
    if (this.draining) return this.draining;
    const active = this.drainNow(apply, now, reconcile);
    this.draining = active;
    void active.then(
      () => { if (this.draining === active) this.draining = undefined; },
      () => { if (this.draining === active) this.draining = undefined; },
    );
    return active;
  }

  private async drainNow(
    apply: (op: PublishOperation) => Promise<PublishDrainResult>,
    now: number,
    reconcile?: (op: PublishOperation) => Promise<PublishDrainResult | null>,
  ): Promise<number> {
    const ops = this.read();
    if (!ops.length) return 0;
    const kept: PublishOperation[] = [];
    let applied = 0;
    for (const op of ops) {
      if (op.nextAttemptAt > now) {
        // A row can survive a crash after it is appended but before the tracker is moved to in_review.
        // Reconcile that ownership immediately; never turn a scheduled retry into an early GitHub
        // call merely to repair its visible hold.
        try {
          const result = await reconcile?.(op);
          if (result?.action === "remove") applied++;
          else kept.push(result?.operation ?? op);
        } catch (err) {
          kept.push(op);
          this.logger.warn("queued GitHub publish reconciliation still failing", {
            id: op.id, item: op.item.identifier, error: (err as Error).message,
          });
        }
        continue;
      }
      try {
        const result = await apply(op);
        if (result.action === "keep") kept.push(result.operation);
        else applied++;
      } catch (err) {
        // A dispatcher crash/ticket-comment failure must not erase the ownership row.
        kept.push(op);
        this.logger.warn("queued GitHub publish still failing", {
          id: op.id, item: op.item.identifier, error: (err as Error).message,
        });
      }
    }
    // `cancel()` is allowed while apply() awaits the tracker/GitHub. Do not resurrect a row the
    // concierge just relinquished to a human courier. Likewise preserve a newly appended row:
    // its synchronous append may have happened while this async drain held an old snapshot.
    const newlyAppended = this.read().filter((current) => !ops.some((original) => original.id === current.id));
    const final = [
      ...kept.filter((op) => !newlyAppended.some((newer) => newer.item.id === op.item.id)),
      ...newlyAppended,
    ].filter((op) => !this.cancelled.has(op.item.id));
    this.writeAll(final);
    return applied;
  }

  private read(): PublishOperation[] {
    if (!existsSync(this.path)) return [];
    const out: PublishOperation[] = [];
    for (const line of readFileSync(this.path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Partial<PublishOperation>;
        if (
          typeof raw.id === "string" && raw.item && typeof raw.item.id === "string" &&
          typeof raw.item.identifier === "string" && typeof raw.slug === "string" &&
          typeof raw.repoRoot === "string" && typeof raw.messagePrefix === "string" &&
          typeof raw.summary === "string" && (raw.purpose === "done" || raw.purpose === "wip") &&
          Number.isInteger(raw.attempt) && typeof raw.nextAttemptAt === "number" && typeof raw.createdAt === "string"
        ) out.push(raw as PublishOperation);
      } catch (err) {
        this.logger.warn("discarding malformed GitHub publish outbox line", { error: (err as Error).message });
      }
    }
    return out;
  }

  private writeAll(ops: PublishOperation[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!ops.length) {
      writeFileSync(this.path, "", "utf8");
      return;
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, ops.map((op) => JSON.stringify(op)).join("\n") + "\n", "utf8");
    renameSync(tmp, this.path);
  }
}
