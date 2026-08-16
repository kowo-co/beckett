/**
 * Beckett — Discord presence deriver (`src/discord/presence.ts`)
 * =======================================================================================
 * Turns the live board into a one-line "what Beckett is doing right now", so anyone in the
 * server can read the state of the board from the bot's presence without asking (#132).
 *
 * ONE deriver, ONE sink: the gateway bot presence (discord.js `client.user.setPresence`).
 *
 * The line is a CUSTOM status (activity type 4), not Playing/Watching: a bot's board state is a
 * caption, not an activity, and the custom type renders the text verbatim with no forced verb.
 * Every ACTIVE fact is composed into the one line ("a deploy in flight · 2 branches build")
 * rather than showing only the highest-priority one, so a busy board reads as a busy board.
 *
 * The inputs come from the existing 60-second status-snapshot tick (see `shell/main.ts`); this
 * module never polls anything itself. Rate safety is the one real risk: Discord allows ~5 presence
 * updates per 20s per connection, so {@link PresenceController} only emits when the derived line
 * actually changes AND never faster than one send per {@link PresenceControllerOptions.minSendIntervalMs}
 * (default 15s). Every failure — deriving or the sink — is caught and logged; presence is a
 * read-out, never a reason to take down the gateway or the daemon.
 */

import { ActivityType, type PresenceData } from "discord.js";
import { log as rootLog } from "../log.ts";
import type { Logger } from "../types.ts";

/**
 * The live board facts a presence line is derived from. Assembled once per status-snapshot tick;
 * this module treats them as a pure input — it does not read them itself.
 */
export interface PresenceInputs {
  /** A core operation is unreachable / the daemon is degraded (highest priority). */
  degraded: boolean;
  /** A deploy is currently in flight. */
  deployInFlight: boolean;
  /** At least one background browser run is live. */
  browserRunLive: boolean;
  /** How many branch builds are in flight right now (clamped to >= 0). */
  branchesInFlight: number;
}

export type PresenceStatus = "online" | "idle" | "dnd";

export interface DerivedPresence {
  status: PresenceStatus;
  /** The custom-status state text Discord renders verbatim, e.g. `a deploy in flight · 2 branches build`. */
  text: string;
  /** The full rendered line — the RPC detail line + the change anchor. Identical to `text` (no verb). */
  line: string;
}

function make(text: string, status: PresenceStatus): DerivedPresence {
  return { status, text, line: text };
}

/**
 * Degraded dominates everything (dnd + its own line). Otherwise every active fact joins the line,
 * highest-priority first; an empty board reads idle. The strings are the frozen contract from
 * #132 — do not paraphrase them. Plural is correct at N=1 (`1 branch build`) and N>1 (`3 branches
 * build`).
 */
export function derivePresence(inputs: PresenceInputs): DerivedPresence {
  if (inputs.degraded) return make("something break", "dnd");
  const facts: string[] = [];
  if (inputs.deployInFlight) facts.push("a deploy in flight");
  if (inputs.browserRunLive) facts.push("a browser run live");
  const branches = Math.max(0, Math.floor(inputs.branchesInFlight));
  if (branches >= 1) facts.push(`${branches} ${branches === 1 ? "branch" : "branches"} build`);
  if (facts.length === 0) return make("an empty board", "idle");
  return make(facts.join(" · "), "online");
}

/** The change anchor: two derived presences are "the same" iff status and text both match. */
export function presenceKey(derived: DerivedPresence): string {
  return `${derived.status}|${derived.text}`;
}

/** The discord.js payload for a derived presence: one Custom activity, text carried in `state`. */
export function toPresenceData(derived: DerivedPresence): PresenceData {
  return {
    status: derived.status,
    activities: [{ type: ActivityType.Custom, name: "custom", state: derived.text }],
  };
}

/**
 * The static presence Discord shows the instant the bot connects, before the first snapshot tick
 * has run. Deliberately equal to the "nothing running" state so connect → first tick is seamless.
 */
export function initialPresenceData(): PresenceData {
  return toPresenceData(
    derivePresence({ degraded: false, deployInFlight: false, browserRunLive: false, branchesInFlight: 0 }),
  );
}

/** The one place a derived presence is written. May throw. */
export interface PresenceSinks {
  /** Push presence to the gateway bot user (discord.js `setPresence`). */
  setPresence: (data: PresenceData) => void | Promise<void>;
}

export interface PresenceControllerOptions {
  sinks: PresenceSinks;
  logger?: Logger;
  now?: () => number;
  /** Hard floor between presence sends (Discord ~5 updates / 20s). Default 15_000. */
  minSendIntervalMs?: number;
}

/**
 * Owns the send decision. Fed the current board on every snapshot tick, it emits to the sink ONLY
 * when the derived line actually changes from the last one sent, and never more often than
 * `minSendIntervalMs`. When a change is rate-floored it is simply retried on the next tick (the
 * snapshot cadence is 60s, comfortably above the floor). Never throws.
 */
export class PresenceController {
  private readonly sinks: PresenceSinks;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly minSendIntervalMs: number;
  private lastKey: string | null = null;
  private lastSentAt: number | null = null;

  constructor(opts: PresenceControllerOptions) {
    this.sinks = opts.sinks;
    this.logger = opts.logger ?? rootLog.child("discord.presence");
    this.now = opts.now ?? Date.now;
    this.minSendIntervalMs = opts.minSendIntervalMs ?? 15_000;
  }

  /**
   * Derive from the current board and, only on a real change within the rate floor, push to the
   * sink. A derive failure, or the sink throwing, is caught and logged — the tick and the gateway
   * carry on unaffected.
   */
  async update(inputs: PresenceInputs): Promise<void> {
    try {
      const derived = derivePresence(inputs);
      const key = presenceKey(derived);
      if (key === this.lastKey) return; // unchanged — no send
      const now = this.now();
      if (this.lastSentAt !== null && now - this.lastSentAt < this.minSendIntervalMs) {
        // Rate-floored: leave lastKey untouched so the next tick re-attempts this pending change.
        return;
      }
      await this.emit(derived);
      this.lastKey = key;
      this.lastSentAt = now;
    } catch (err) {
      this.logger.warn("presence update failed; carrying on", { error: String(err) });
    }
  }

  /** Write the sink. */
  private async emit(derived: DerivedPresence): Promise<void> {
    try {
      await this.sinks.setPresence(toPresenceData(derived));
    } catch (err) {
      this.logger.warn("presence: setPresence sink failed", { line: derived.line, error: String(err) });
    }
  }
}
