/**
 * The human digest of the dispatch event feed (#4).
 *
 * `formatDispatchEvent` (./events.ts) renders one machine row — marker, UTC clock, internal stage
 * name, outcome word, elapsed, raw detail. That shape is right for `beckett task trace`, where a
 * person has asked for the forensic timeline. It was wrong for the channel, where those rows arrived
 * as a wall of `✗ 04:56:31 · #2.1 · implement · FAILED · 22m 4s 🚨 ALERT — <the worker's opening
 * narration>`: a restart-killed worker dressed as a failure, no-op `in_review → in_review`
 * transitions, and the same staff/repo/worktree batch replayed twice after every deploy.
 *
 * This module is the translation layer between the two. It turns each event into ONE plain-English
 * sentence (or nothing at all — most plumbing is invisible), coalesces a ticket's sentences into a
 * single message the caller edits in place, and drops replays. Two rules it never bends:
 *   - only a genuine failure is marked as one, and it carries the real error text;
 *   - nothing here ever renders the raw trace line — the full detail lives behind
 *     `beckett task trace "<ref>"`, which every digest names.
 *
 * It is deliberately pure: no Discord, no clock beyond an injectable `now`. {@link
 * ../dispatch/digest-feed.ts DispatchDigestFeed} owns the post/edit mechanics.
 */
import type { DispatchEvent } from "./events.ts";
import { ACTIVITY_STAGE } from "../run/activity.ts";

/** What the caller should render after an event. `null` from `observe` means "say nothing". */
export interface DigestUpdate {
  /** Stable per-ticket key; the caller anchors one editable message per key. */
  key: string;
  /** The whole digest body, ready to post or edit. Always within Discord's single-message limit. */
  text: string;
  /** Post a NEW message instead of editing the anchor (new episode, or a failure worth a ping). */
  fresh: boolean;
  /** A genuine failure is in this update. */
  alert: boolean;
}

/** One translated event, before the digest stamps a time on it. */
export interface DigestNote {
  /** Plain English, no internal ids, no timestamps — the digest adds the local clock. */
  text: string;
  /** Something actually failed. Rendered with a warning marker and pushed out as a fresh message. */
  alert?: boolean;
  /** The ticket reached a resting point; the next note starts a new digest message. */
  closes?: boolean;
}

export interface DispatchDigestOptions {
  now?: () => number;
  /** Local clock for every rendered time. Defaults to the house timezone. */
  timeZone?: string;
  /** Identical sentences inside this window are a replay, not news (restart batches, poll echoes). */
  replayWindowMs?: number;
  /** A digest untouched for this long is finished; the next note opens a new message. */
  sessionIdleMs?: number;
  /** Sentences kept in one digest before older ones fall back to the trace. */
  maxLines?: number;
  /** Hard body cap. Discord rejects an atomic message over 2000 characters. */
  maxChars?: number;
}

/** Where the operator reads these messages. Matches the dream's home timezone. */
const DEFAULT_TZ = "America/Los_Angeles";

const STATE_WORDS: Record<string, string> = {
  backlog: "the backlog",
  todo: "the to-do queue",
  design: "design",
  design_review: "design review",
  in_progress: "in progress",
  in_review: "review",
  done: "done",
  cancelled: "cancelled",
};

const STAGE_WORDS: Record<string, string> = {
  implement: "implementation",
  review: "review",
  design: "design",
  design_check: "design check",
  rework: "rework",
};

interface DigestLine {
  at: number;
  text: string;
}

interface DigestSession {
  ref: string;
  lines: DigestLine[];
  /** Wall clock of the first line — the "since" in the header. */
  startedAt: number;
  /** Wall clock of the last update — drives the idle rollover. */
  lastAt: number;
  /** Elided older lines, so the digest can say so instead of silently truncating. */
  elided: number;
  closed: boolean;
}

/**
 * Per-ticket coalescing state machine. Feed it every dispatch event; it answers with the message
 * body to show, or `null` when the event is noise (plumbing, a no-op transition, a replay).
 */
export class DispatchDigest {
  private readonly sessions = new Map<string, DigestSession>();
  /** `key\0sentence` → when it was last said, for replay suppression. */
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly replayWindowMs: number;
  private readonly sessionIdleMs: number;
  private readonly maxLines: number;
  private readonly maxChars: number;
  private formatter: Intl.DateTimeFormat | null = null;

  constructor(options: DispatchDigestOptions = {}) {
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? DEFAULT_TZ;
    this.replayWindowMs = options.replayWindowMs ?? 120_000;
    this.sessionIdleMs = options.sessionIdleMs ?? 20 * 60_000;
    this.maxLines = options.maxLines ?? 10;
    this.maxChars = options.maxChars ?? 1_800;
  }

  observe(event: DispatchEvent): DigestUpdate | null {
    const note = describeDispatchEvent(event);
    if (!note) return null;
    const now = this.now();
    const key = event.runId || event.runRef;
    this.prune(now);

    // Replay suppression. A restart replays the same staff/repo/worktree batch, and the poller can
    // re-emit a transition it already saw; either way the SAME sentence within the window is not
    // news. Failures dedupe on the same rule — a real second failure reads differently (new error
    // text) or arrives later than the window.
    const seenKey = `${key}\u0000${note.text}`;
    const last = this.seen.get(seenKey);
    this.seen.set(seenKey, now);
    if (last !== undefined && now - last < this.replayWindowMs) return null;

    const at = Date.parse(event.ts);
    const ts = Number.isFinite(at) ? at : now;
    const prior = this.sessions.get(key);
    const stale = !prior || prior.closed || now - prior.lastAt > this.sessionIdleMs;
    // A failure gets a message of its own so it lands at the BOTTOM of the channel rather than as a
    // silent edit to a message that scrolled away — but it keeps a little context above it.
    const fresh = stale || !!note.alert;
    const session: DigestSession = fresh
      ? {
          ref: event.runRef || key,
          lines: stale ? [] : prior!.lines.slice(-2),
          startedAt: stale ? ts : prior!.startedAt,
          lastAt: now,
          elided: 0,
          closed: false,
        }
      : prior!;

    session.ref = event.runRef || session.ref;
    session.lastAt = now;
    session.lines.push({ at: ts, text: `${note.alert ? "⚠️ " : ""}${note.text}` });
    if (note.closes) session.closed = true;
    this.sessions.set(key, session);
    return { key, text: this.render(session), fresh, alert: !!note.alert };
  }

  /** The rendered body for a session: header, the recent sentences, and the trace pointer. */
  private render(session: DigestSession): string {
    let lines = session.lines;
    if (lines.length > this.maxLines) {
      session.elided += lines.length - this.maxLines;
      lines = lines.slice(-this.maxLines);
      session.lines = lines;
    }
    const trace = `_full detail: \`beckett task trace "${session.ref}"\`_`;
    const build = () =>
      [
        `**${session.ref}** · since ${this.time(session.startedAt)}`,
        ...(session.elided > 0 ? [`_…${session.elided} earlier step${session.elided === 1 ? "" : "s"} in the trace_`] : []),
        ...lines.map((line) => `• ${this.time(line.at)} — ${line.text}`),
        trace,
      ].join("\n");
    let text = build();
    // Never hand Discord a body it will refuse: shed oldest sentences until it fits.
    while (text.length > this.maxChars && lines.length > 1) {
      session.elided += 1;
      lines = lines.slice(1);
      session.lines = lines;
      text = build();
    }
    return text.length > this.maxChars ? `${text.slice(0, this.maxChars - 1)}…` : text;
  }

  private time(ms: number): string {
    this.formatter ??= new Intl.DateTimeFormat("en-US", {
      timeZone: this.timeZone,
      hour: "numeric",
      minute: "2-digit",
    });
    return this.formatter.format(new Date(ms));
  }

  /** Bound both maps: a long-lived daemon must not accumulate a row per ticket it ever touched. */
  private prune(now: number): void {
    for (const [k, ts] of this.seen) if (now - ts > this.replayWindowMs) this.seen.delete(k);
    if (this.sessions.size <= 200) return;
    for (const [k, s] of this.sessions) {
      if (now - s.lastAt > this.sessionIdleMs) this.sessions.delete(k);
    }
  }
}

/**
 * One dispatch event → one plain-English sentence, or `null` when a person gains nothing from it
 * (worktree/repo plumbing, a no-op transition, the second half of a two-part transition). Exported
 * for the tests that pin each phrasing.
 */
export function describeDispatchEvent(event: DispatchEvent): DigestNote | null {
  const [base = "", qualifier = ""] = event.stage.split(":");
  const message = clip(event.message);
  const error = clip(event.error);
  const detail = error || message;
  const stageWord = STAGE_WORDS[base] ?? base.replace(/[-_]/g, " ");

  // The live activity blurb (`../run/activity.ts`) repaints a progress card every ~20s while a
  // worker runs. It is card decoration, not news: it says nothing a person reading the digest
  // wants a sentence about, and relaying it would post a Discord message per tool burst.
  if (base === ACTIVITY_STAGE) return null;

  // A restart is not a failure — the single loudest thing this digest exists to fix.
  if (event.outcome === "interrupted") {
    return { text: `a restart stopped the ${stageWord} worker mid-run — it gets picked back up` };
  }
  if (base === "restart-restaff") {
    // The recovery batch is two events per interrupted worker plus a re-staff; one sentence covers
    // the whole thing and the replay window collapses the repeats.
    return event.outcome === "started" ? { text: "the daemon restarted — resuming interrupted work" } : null;
  }

  // Ticket lifecycle.
  if (base === "state") {
    const to = event.stage.slice("state:".length);
    const transition = message.match(/^(\S+)\s*(?:→|->)\s*(\S+)$/);
    if (transition && transition[1] === transition[2]) return null; // no-op: X → X is not an event
    if (event.outcome === "started") return null; // the request; its `passed` twin is the fact
    if (event.outcome === "failed") return { text: `couldn't move the ticket to ${stateWord(to)} — ${detail}`, alert: true };
    if (event.outcome === "bounced") {
      const won = message.match(/^human terminal state (\w+)/);
      return { text: `left ${stateWord(won?.[1] ?? "as it was")} — a human's change won over the queued move to ${stateWord(to)}` };
    }
    if (to === "done") return { text: "finished — moved to done", closes: true };
    if (to === "cancelled") return { text: "cancelled", closes: true };
    return { text: `moved to ${stateWord(to)}` };
  }

  // Plumbing: only its failures are worth a person's attention.
  if (base === "worktree" || base === "repo") {
    if (event.outcome !== "failed") return null;
    return {
      text: base === "repo" ? `couldn't set up the repository — ${detail}` : `couldn't set up the workspace — ${detail}`,
      alert: true,
    };
  }

  if (qualifier === "staff") {
    if (event.outcome === "held") return { text: "waiting for a free worker slot" };
    if (event.outcome === "failed") return { text: `the ${stageWord} worker couldn't start — ${detail}`, alert: true };
    return null; // "staffing admitted" — the worker-started sentence below says it better
  }

  // The silent-worker ladder. Handled automatically, so it is reported, not alarmed.
  if (qualifier === "wedge") {
    const idle = message.match(/(\d+)m/)?.[1];
    const quiet = `the ${stageWord} worker has been quiet${idle ? ` for ${idle}m` : ""}`;
    return message.includes("aborting")
      ? { text: `${quiet} — stopping it and picking the work back up from its last commit` }
      : { text: `${quiet} — sent it a status check` };
  }

  if (base === "watchdog") {
    if (event.outcome === "held") return { text: "re-staffing didn't take — parked for a human", closes: true };
    return { text: "nothing was running on this — re-staffing it" };
  }

  if (base === "restaff") return { text: "re-staffing on request" };
  if (base === "cancel") return { text: "cancellation received", closes: true };
  if (base === "park") {
    return event.outcome === "held" ? { text: "parked for a human", closes: true } : null;
  }
  if (base === "preview") {
    return event.outcome === "passed" && message ? { text: `preview is up: ${message}` } : null;
  }

  // Publishing. Both only ever carry a URL, and a URL-less one has nothing to show a person.
  if (base === "pr") return message ? { text: `opened a pull request: ${message}` } : null;
  if (base === "git-push") return message ? { text: `pushed the branch: ${message}` } : null;
  if (base === "publish" || base === "publish-retry") {
    if (event.outcome === "failed") {
      if (qualifier === "empty") return { text: "the publish had no ticket changes in it — nothing shipped", alert: true };
      if (qualifier === "verify") return { text: `couldn't verify what was about to be published — ${detail}`, alert: true };
      return { text: `publishing failed — ${detail}`, alert: true };
    }
    if (event.outcome === "passed") {
      return message.includes("publishing unavailable") ? { text: "no remote to publish to — the work stayed local" } : null;
    }
    const attempt = message.match(/attempt (\d+)/)?.[1];
    return base === "publish-retry" ? { text: `retrying the publish${attempt ? ` (attempt ${attempt})` : ""}` } : null;
  }

  if (base === "dispatch" && event.outcome === "failed") {
    return { text: `the dispatcher hit an error ${message || "handling this ticket"} — ${error}`, alert: true };
  }
  if (base === "dependency-promotion" && event.outcome === "failed") {
    return { text: `couldn't promote the tickets waiting on this one — ${detail}`, alert: true };
  }

  // A worker stage: implement / review / design / design_check / rework, and anything a future
  // stage registers.
  if (event.outcome === "started") {
    const harness = message.match(/ on (\S+)$/)?.[1];
    return { text: `a worker started the ${stageWord}${harness ? ` (${harness})` : ""}` };
  }
  if (event.outcome === "passed") return { text: `finished the ${stageWord}` };
  if (event.outcome === "cancelled") return { text: `${stageWord} cancelled`, closes: true };
  if (event.outcome === "held") {
    // Restart-interrupted work that could not resume its session is a restart, not a failure.
    if (message.startsWith("interrupted mid-")) {
      return { text: "a restart interrupted this and its session couldn't resume — parked for a human", closes: true };
    }
    const inactive = message.match(/^ticket is (\w+); not (?:spawning|retrying)$/);
    if (inactive) return { text: `not staffing a worker — the ticket is ${stateWord(inactive[1]!)}` };
    return { text: `${stageWord} on hold${message ? ` — ${message}` : ""}` };
  }
  if (event.outcome === "failed") {
    if (qualifier === "timeout") return { text: `the ${stageWord} worker ${message || "hit its safety cap"}`, alert: true };
    if (qualifier === "launch") return { text: `the ${stageWord} worker ${message || "never started work"}`, alert: true };
    if (qualifier === "verdict") return { text: `the ${stageWord} couldn't return a verdict — ${detail}`, alert: true };
    return { text: `the ${stageWord} worker failed — ${detail || "no error text"}`, alert: true };
  }
  return detail ? { text: `${stageWord}: ${detail}` } : null;
}

function stateWord(state: string): string {
  return STATE_WORDS[state] ?? state.replace(/_/g, " ");
}

/** One line, no code-fence escapes, short enough that one sentence can't crowd out the digest. */
function clip(value: string | undefined, max = 240): string {
  if (!value) return "";
  const flat = value.replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
