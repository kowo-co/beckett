/**
 * Beckett — the cursor shim's wire protocol + error taxonomy (`src/drivers/cursor-protocol.ts`)
 * =======================================================================================
 * Shared, DEPENDENCY-FREE vocabulary between {@link CursorDriver} (`./cursor.ts`, loaded in the
 * daemon) and the shim it spawns (`./cursor-runner.ts`, the only file that imports `@cursor/sdk`).
 * Splitting it out is what keeps the ~150MB SDK out of the daemon process: the driver knows the
 * frame shapes without ever resolving the package.
 *
 * Every other harness driver parses its CLI's own NDJSON. Cursor's local mode is a LIBRARY, not a
 * binary, so the shim re-emits the SDK's stream as NDJSON in this shape and the driver's parser
 * stays the same ~150-line `type` switch every other driver has. Process isolation, kill signals,
 * and the one-child-per-run model are all preserved — the shim is a subprocess like any harness.
 *
 * ## The quota question this file exists to answer
 *
 * Cursor documents no status code, error code, or header that distinguishes "this Pro account's
 * monthly allowance is spent" from an ordinary transient 429 or a 5xx blip. Verified 2026-08-19
 * against the live API on the account this ships for: the SDK surfaces `status` (401 for a bad
 * key), a `code`, and an `isRetryable` flag, and nothing else that names quota.
 *
 * So {@link classifyCursorError} is deliberately conservative and its cost asymmetry is explicit:
 *   - calling a real quota wall "transient" wedges a run against a wall that will not move;
 *   - calling a transient blip "quota" costs one unnecessary (and free — Cursor does not bill a
 *     rejected call) handoff to a seat that also works.
 * The second is strictly cheaper, so ambiguity resolves toward `quota`. Every trigger writes the
 * raw status/code/message into the handoff file, so the FIRST real production occurrence tells us
 * the actual shape and this rule gets tightened against evidence instead of guesswork.
 */

// =======================================================================================
// Error taxonomy
// =======================================================================================

/**
 * What a Cursor API failure means for control flow.
 *   - `quota`     — the Pro allowance is spent. Hand off to Claude; do NOT retry.
 *   - `transient` — a blip (5xx, network, a retryable 429). Bounded retry, then escalate.
 *   - `auth`      — the key is bad/absent. A human fixes it; retrying burns nothing but never works.
 *   - `config`    — we asked for something invalid (a model that doesn't exist). A code bug.
 *   - `unknown`   — unclassifiable. Treated as transient by the retry policy, then escalated.
 */
export type CursorFailureKind = "quota" | "transient" | "auth" | "config" | "unknown";

/** The subset of a `CursorSdkError` this module reads. Structural, so tests need no SDK import. */
interface CursorErrorShape {
  message?: string;
  status?: number;
  code?: string;
  isRetryable?: boolean;
}

/**
 * Text that means "the allowance is gone", not "try again in a second". Matched against the
 * error message. Deliberately broad on the exhaustion side per the cost asymmetry above.
 */
const QUOTA_PATTERNS =
  /usage limit|quota|out of (usage|credits|requests)|(no|not enough) (usage|credits|requests|balance)|insufficient (credits|funds|balance)|hard limit|spend(ing)? limit|monthly limit|plan limit|limit (reached|exceeded)|exceeded your|upgrade your plan|resource.?exhausted|free tier/i;

/**
 * Text that means "the service hiccuped" — the genuinely retryable side.
 *
 * Note the deliberate specificity of the availability clauses. A bare `/unavailable/` also matches
 * `[feature_unavailable] This feature is not available for your account`, which this plan really
 * does return (for `GET agents/{id}/usage`) and which means "not included in your plan" — not
 * "try again shortly". Matching it as transient would spend two pointless retries and then
 * escalate a permanent, harmless answer into a seat change.
 */
const TRANSIENT_PATTERNS =
  /timeout|timed out|temporarily|try again|econnreset|econnrefused|etimedout|enotfound|socket hang up|network error|(service|server|currently|temporarily) unavailable|overloaded|internal error|bad gateway|502|503|504/i;

/** Text that means the key is wrong or missing. */
const AUTH_PATTERNS = /invalid.{0,12}(user )?api key|unauthorized|not logged in|authentication|forbidden/i;

/** Text that means WE sent something invalid — a code bug, never a reason to change seats. */
const CONFIG_PATTERNS = /cannot use this model|unknown (tool|model)|invalid (request|parameter|argument)/i;

/**
 * Classify one Cursor API failure. Order matters: config and auth are checked before quota so a
 * "cannot use this model" or "invalid api key" is never mistaken for an exhausted allowance and
 * never triggers a pointless seat change.
 *
 * `feature_unavailable` deserves a note: this account returns it for `GET agents/{id}/usage`, and
 * it means "your plan doesn't include this endpoint", NOT "you are out of quota". It is matched by
 * neither pattern set and lands in `unknown`, which is correct — the caller for that endpoint
 * degrades to token counts rather than changing seats.
 */
export function classifyCursorError(err: CursorErrorShape | null | undefined): CursorFailureKind {
  if (!err) return "unknown";
  const text = err.message ?? "";
  const status = err.status;

  // A bad model id / malformed request is OUR bug. Checked first: its message ("Cannot use this
  // model: …") lists the available models, which happens to contain none of the quota words, but
  // being explicit here means a future message change can't reroute a code bug into a seat change.
  if (CONFIG_PATTERNS.test(text)) return "config";
  if (status === 400 || status === 404) return "config";

  // Auth beats quota on ambiguous text, matching `./failure.ts`'s posture: retrying (or reseating)
  // an expired credential burns a worker start and can never succeed.
  if (status === 401 || status === 403) return "auth";
  if (AUTH_PATTERNS.test(text)) return "auth";

  // 402 Payment Required is the one status that can only mean "the money/allowance ran out".
  if (status === 402) return "quota";

  if (QUOTA_PATTERNS.test(text)) return "quota";

  // A 429 with the backend's own retry flag explicitly OFF is a hard cap, not a speed bump —
  // that is precisely the distinction `isRetryable` exists to carry.
  if (status === 429) return err.isRetryable === false ? "quota" : "transient";

  if (typeof status === "number" && status >= 500) return "transient";
  if (TRANSIENT_PATTERNS.test(text)) return "transient";
  if (err.isRetryable === true) return "transient";
  return "unknown";
}

/** Whether the retry loop should spend another attempt on this failure. */
export function isRetryableKind(kind: CursorFailureKind): boolean {
  return kind === "transient" || kind === "unknown";
}

// =======================================================================================
// The shim's stdout frames
// =======================================================================================

/**
 * One NDJSON line from the shim. The driver's parser is a switch over `type` and tolerates
 * anything it doesn't recognize (routed to `unknown`, never a throw) — same contract as every
 * other driver in this tree.
 */
export type CursorFrame =
  /** The handshake. Emitted the instant the agent exists, before any model call. */
  | { type: "session"; agentId: string; model: string; modelNote?: string }
  /** One model turn began. */
  | { type: "turn_start" }
  /** Assistant output. Local mode streams these as deltas; `partial` says which. */
  | { type: "assistant"; text: string; partial: boolean }
  /** A tool call started. */
  | { type: "tool_start"; id: string; name: string; args?: unknown }
  /** A tool call ended. `path` is set for the edit/write family so the driver can emit file_change. */
  | { type: "tool_end"; id: string; name: string; isError: boolean; path?: string }
  /** Per-turn token usage. */
  | { type: "usage"; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
  /** The run reached a terminal state on its own. `text` is the final assistant message. */
  | { type: "result"; status: "finished" | "error" | "cancelled"; text: string; durationMs?: number }
  /**
   * The seat is out of quota. The shim has ALREADY committed whatever was on disk, reset any
   * unverified checklist tick, and written the handoff file — this frame is a report, not a
   * request. The driver turns it into a terminal `finished` the supervisor keys on.
   */
  | { type: "quota"; reason: string; status?: number; code?: string; checkpoint?: string }
  /** A non-terminal problem worth surfacing. */
  | { type: "error"; message: string }
  /** Shim-level diagnostics that belong in the daemon log, not the event stream. */
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

/** Serialize one frame as a single NDJSON line (trailing newline included). */
export function encodeFrame(frame: CursorFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Tool names whose successful completion means a file on disk changed. */
export const CURSOR_EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "delete", "apply_agent_diff"]);

/**
 * The argument key that names the file a tool touched, in the order the SDK actually populates
 * them. Verified 2026-08-19 against a live local-mode run: the `edit` tool reports `{ path }`.
 */
const CURSOR_PATH_ARG_KEYS = ["path", "file_path", "target_file", "relative_workspace_path"] as const;

/** Pull the touched path out of a tool call's arguments, or undefined when it named none. */
export function pathFromToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of CURSOR_PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
