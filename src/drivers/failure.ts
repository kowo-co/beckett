/**
 * Beckett — harness failure taxonomy (`src/drivers/failure.ts`)
 * =======================================================================================
 * A harness can die for four totally different reasons — binary missing, auth expired, rate
 * limit, real crash — and each needs a DIFFERENT dispatcher response (hold for a human, back
 * off / fall back, bounded retry). Issue #17: before this module they all collapsed into one
 * opaque string, one wedged ticket, and days of journalctl archaeology.
 *
 * The classifier is heuristic by necessity (harnesses report failures as free text on stderr /
 * error events), so it is deliberately conservative: it only names a class when the text
 * clearly matches, and returns undefined otherwise (callers default to "crash").
 */

import type { ErrorClass } from "../types.ts";

/** Auth failures: expired OAuth, missing login, 401s. The fix is a human running `<bin> login`. */
const AUTH_PATTERNS =
  /not logged in|please (run )?.{0,20}login|log in|credential|unauthorized|401|invalid.{0,10}(api key|token)|no api key|authentication|auth.{0,10}(fail|error|expired)|token.{0,10}expired|oauth/i;

/** Rate limits / capacity: the fix is waiting (backoff) or moving load to another harness. */
const RATE_LIMIT_PATTERNS =
  /rate.?limit|too many requests|429|overloaded|capacity|quota|usage limit|limit (reached|exceeded)|resource.?exhausted|529/i;

/** Spawn-class failures: the harness never became a process worth supervising. */
const SPAWN_PATTERNS =
  /no such file or directory|command not found|enoent|failed to execute|cannot execute|not runnable|preflight failed|exited.{0,30}before (init|session|thread)/i;

/**
 * Classify a harness failure from its diagnostic text (stderr tail, error-event message, or a
 * launch-failure Error message). Returns undefined when the text doesn't clearly match any
 * class — callers should treat that as "crash" (the bounded-retry default).
 */
export function classifyHarnessFailure(text: string | null | undefined): ErrorClass | undefined {
  if (!text) return undefined;
  // Auth wins over rate-limit on ambiguous text ("401 rate limited" is an auth problem first):
  // retrying an expired login burns nothing but never succeeds, so holding is the safer call.
  if (AUTH_PATTERNS.test(text)) return "auth";
  if (RATE_LIMIT_PATTERNS.test(text)) return "rate_limit";
  if (SPAWN_PATTERNS.test(text)) return "spawn";
  return undefined;
}

/**
 * Ring buffer of the last N stderr lines — the self-diagnosing tail for failure messages.
 *
 * `maxBytes` adds a SECOND bound for callers that care about how much text they retain rather than
 * how many lines (the concierge keeps ~8KB of a chat child's stderr — issue #226 — where a handful
 * of lines can each be a whole stack trace). It defaults to 0 = "line bound only", which is
 * byte-for-byte the historic behavior every driver relies on.
 */
export class StderrRing {
  private readonly lines: string[] = [];
  /** Retained size, counting the newline each line contributes to {@link tail}. */
  private bytes = 0;
  constructor(private readonly max = 20, private readonly maxBytes = 0) {}

  record(text: string): void {
    for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      this.lines.push(line);
      this.bytes += line.length + 1;
      // Never drop the newest line to satisfy the byte bound — a single oversized line is still
      // the most useful thing we have, and dropping it would leave an empty tail.
      while (
        this.lines.length > this.max ||
        (this.maxBytes > 0 && this.bytes > this.maxBytes && this.lines.length > 1)
      ) {
        const dropped = this.lines.shift();
        this.bytes -= (dropped?.length ?? 0) + 1;
      }
    }
  }

  tail(): string {
    return this.lines.join("\n").trim();
  }
}
