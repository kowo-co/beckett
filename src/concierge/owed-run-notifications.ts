/**
 * Beckett — the owed-run-notification ledger (`src/concierge/owed-run-notifications.ts`)
 * =======================================================================================
 * Issue #233. `RunSupervisor` tells the concierge about every run transition (`onStateChange` →
 * `concierge.notify`), and `notify` fires a best-effort, fire-and-forget system turn that MAY end
 * with the model running `beckett discord reply` to tell the person who asked. That whole path —
 * from "the run just reached done" to "a message actually landed in Discord" — was ephemeral:
 * nothing durable knew a ping was owed until it was paid.
 *
 * Verified prod loss (#233): `run done` logged at 06:58:46, the concierge crashed resuming a
 * session at 06:58:47, the deploy restarted it at 06:59:14. Zero delivery attempts logged after
 * "run done" — the promised "I'll ping you when it lands" alert never went out, and nothing on
 * disk knew it was still owed. This module is that record, mirroring `owed-mentions.ts`'s shape
 * and file hygiene exactly, applied to the other direction of debt: not "a question owed an
 * answer" but "a finished run owes its requester a word."
 *
 * ── THE ONE INVARIANT: NEVER CLAIM A PING PAID THAT NEVER WENT OUT ─────────────────────────
 * Exactly like the mention ledger, an entry moves to `delivering` BEFORE the delivery attempt
 * (the queued system turn that may run `beckett discord reply`), and `settle` is called ONLY once
 * a post is CONFIRMED — the same signal `recordBeckettPost` already exists to record (OPS-80): a
 * Discord message actually went out. An attempt that completes without a confirmed post (the
 * model judged it not worth a ping, the turn errored, the daemon died mid-turn) leaves the record
 * exactly where it was: owed.
 *
 * ── WHERE THIS DELIBERATELY DIVERGES FROM owed-mentions ────────────────────────────────────
 * `owed-mentions`' boot-time `alreadyAnswered` check is biased toward "yes, already answered"
 * when it can't verify — a duplicate answer to a live human question is worse than an occasional
 * miss. A run-completion ping has the opposite cost structure: nobody is mid-conversation waiting
 * on this exact reply, and a run that finished silently is a worse failure than one that gets
 * mentioned twice. So {@link runNotificationAlreadyAnnounced} is biased the OTHER way — replay
 * unless there is positive evidence Beckett already spoke in that channel since the record was
 * created. Replaying twice is better than never.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../types.ts";

/** The three run-lifecycle states a person is owed a word about (issue #233). */
export type OwedRunNotificationState = "done" | "failed" | "parked";

const OWED_RUN_NOTIFICATION_STATES: ReadonlySet<string> = new Set<OwedRunNotificationState>([
  "done",
  "failed",
  "parked",
]);

/**
 * Where an owed run notification is in its life. Same two phases, same meaning, as
 * {@link "./owed-mentions.ts".OwedMentionPhase}.
 *
 * `queued` — claimed, no delivery attempt (queued system turn) has started yet. Safe to replay
 * blind: nothing has been said to anyone about this run finishing.
 *
 * `delivering` — a delivery attempt (the queued system turn that may run `beckett discord reply`)
 * was STARTED for this run. It may have posted; the process may simply have died first. Not safe
 * to replay blind without checking — see {@link runNotificationAlreadyAnnounced}.
 */
export type OwedRunNotificationPhase = "queued" | "delivering";

/** What {@link OwedRunNotificationStore.claim} needs to open a debt. */
export interface OwedRunNotificationClaim {
  runId: string;
  state: OwedRunNotificationState;
  /** Discord channel/thread this run's update routes to (the resolved destination, not raw origin). */
  channelId: string;
  /** The user(s) who should be pinged, when known. May be empty. */
  requesterIds: string[];
}

/** One unpaid debt: a run reached a terminal state and nobody has confirmed the person was told. */
export interface OwedRunNotification {
  runId: string;
  state: OwedRunNotificationState;
  channelId: string;
  requesterIds: string[];
  /** Epoch ms of the first claim. Drives the age bound; never reset by a re-claim. */
  createdAt: number;
  /** Boot/re-drive replays already SPENT on this notification (incremented before the attempt). */
  replays: number;
  phase: OwedRunNotificationPhase;
  /** Epoch ms the debt was confirmed paid, or null while still owed. Never reset once set. */
  settledAt: number | null;
}

/**
 * How many replays one run-completion ping gets before it is abandoned quietly. Mirrors
 * {@link "./owed-mentions.ts".OWED_MENTION_MAX_REPLAYS} for the same reason: one restart is the
 * common case, a second restart minutes later still deserves the ping, and past that the failure
 * is structural (a channel Beckett was removed from, a dead requester) rather than transient.
 */
export const OWED_RUN_NOTIFICATION_MAX_REPLAYS = 2;

/**
 * Age past which an owed run notification is dropped unannounced. Mirrors
 * {@link "./owed-mentions.ts".OWED_MENTION_MAX_AGE_MS} — a run that finished half a day ago
 * getting an unprompted "hey, that thing you asked about finished" reads as a malfunction, not
 * recovery.
 */
export const OWED_RUN_NOTIFICATION_MAX_AGE_MS = 12 * 60 * 60_000;

/** Hard cap on stored entries (settled or not); the oldest are dropped first. A bound, not a policy. */
export const OWED_RUN_NOTIFICATION_MAX_ENTRIES = 200;

export interface OwedRunNotificationStoreOptions {
  /**
   * `<beckettDir>/concierge-owed-run-notifications.json`, created lazily on the first write —
   * same directory family and JSON hygiene as `concierge-owed-mentions.json`. Undefined when the
   * beckett dir can't resolve (partial test configs): the store then runs purely in memory.
   */
  file?: string;
  logger: Logger;
  /** Injectable clock for deterministic tests (default Date.now). */
  now?: () => number;
  maxEntries?: number;
  maxAgeMs?: number;
}

export interface OwedRunNotificationStore {
  /**
   * Record a run's terminal state as owed a ping. Idempotent while the debt is still open: a
   * re-claim of the same runId never resets age or replay budget. Once a prior debt for this
   * runId has been SETTLED, a fresh claim opens a genuinely new one (a run can reach `parked`,
   * get restaffed, and later reach `done` — two distinct debts, not one).
   */
  claim(entry: OwedRunNotificationClaim): void;
  /** Stamp "a delivery attempt for this run notification has STARTED" — call BEFORE the attempt. */
  markDelivering(runId: string): void;
  /** The debt is paid: a post was CONFIRMED (see `recordBeckettPost`). No-op if already settled. */
  settle(runId: string): void;
  /** Spend one replay on this notification and return how many have now been spent (1 = the first). */
  noteReplay(runId: string): number;
  /** True when `runId` has an open (unsettled) debt on the books. */
  has(runId: string): boolean;
  /** Everything still owed, oldest first — settled entries are excluded. */
  list(): OwedRunNotification[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Accept only rows that are actually replayable: a live runId and channelId, and a recognized
 * terminal state. A row missing any of those is dropped silently rather than carried as a shape
 * that would post to nobody or crash a boot replay.
 */
function parseEntry(raw: unknown): OwedRunNotification | null {
  if (!isRecord(raw)) return null;
  const runId = typeof raw.runId === "string" ? raw.runId : "";
  const channelId = typeof raw.channelId === "string" ? raw.channelId : "";
  const state = typeof raw.state === "string" && OWED_RUN_NOTIFICATION_STATES.has(raw.state) ? (raw.state as OwedRunNotificationState) : null;
  if (!runId || !channelId || !state) return null;
  const requesterIds = Array.isArray(raw.requesterIds)
    ? raw.requesterIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return {
    runId,
    state,
    channelId,
    requesterIds,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    replays: typeof raw.replays === "number" && raw.replays > 0 ? Math.floor(raw.replays) : 0,
    phase: raw.phase === "delivering" ? "delivering" : "queued",
    settledAt: typeof raw.settledAt === "number" ? raw.settledAt : null,
  };
}

export function createOwedRunNotificationStore(opts: OwedRunNotificationStoreOptions): OwedRunNotificationStore {
  const now = opts.now ?? Date.now;
  const maxEntries = Math.max(1, opts.maxEntries ?? OWED_RUN_NOTIFICATION_MAX_ENTRIES);
  const maxAgeMs = Math.max(0, opts.maxAgeMs ?? OWED_RUN_NOTIFICATION_MAX_AGE_MS);
  const log = opts.logger;
  /** Insertion-ordered by claim. Keyed by runId — one open debt per run at a time. */
  let entries: Map<string, OwedRunNotification> | null = null;

  function load(): Map<string, OwedRunNotification> {
    if (entries) return entries;
    const loaded = new Map<string, OwedRunNotification>();
    try {
      if (opts.file && existsSync(opts.file)) {
        const parsed: unknown = JSON.parse(readFileSync(opts.file, "utf8"));
        if (Array.isArray(parsed)) {
          for (const row of parsed) {
            const entry = parseEntry(row);
            if (entry) loaded.set(entry.runId, entry);
          }
        }
      }
    } catch (error) {
      // A corrupt ledger loses the queue; it must never lose the daemon.
      log.warn("owed-run-notification ledger unreadable — starting empty", { error: String(error) });
    }
    entries = loaded;
    prune();
    return entries;
  }

  /** Age first (from createdAt if still owed, from settledAt once paid), then count. */
  function prune(): void {
    const map = entries;
    if (!map) return;
    const cutoff = now() - maxAgeMs;
    for (const [id, entry] of map) {
      const age = entry.settledAt ?? entry.createdAt;
      if (age < cutoff) map.delete(id);
    }
    while (map.size > maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  function persist(): void {
    const map = entries;
    if (!map) return;
    prune();
    const file = opts.file;
    if (!file) return; // memory-only (see OwedRunNotificationStoreOptions.file)
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify([...map.values()], null, 2) + "\n", { mode: 0o600 });
        renameSync(temp, file);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          /* absent */
        }
        throw error;
      }
    } catch (error) {
      // Degrade to the in-memory map: this run still won't lose track of an open debt, and the
      // next boot simply has nothing to replay — never worse than the pre-ledger behavior.
      log.warn("owed-run-notification ledger write failed — queue is in-memory only for this run", {
        error: String(error),
      });
    }
  }

  return {
    claim(input: OwedRunNotificationClaim): void {
      const map = load();
      const existing = map.get(input.runId);
      if (existing && existing.settledAt === null) return; // idempotent: still an open debt
      map.set(input.runId, {
        runId: input.runId,
        state: input.state,
        channelId: input.channelId,
        requesterIds: [...input.requesterIds],
        createdAt: now(),
        replays: 0,
        phase: "queued",
        settledAt: null,
      });
      persist();
    },

    markDelivering(runId: string): void {
      const map = load();
      const entry = map.get(runId);
      if (!entry || entry.settledAt !== null || entry.phase === "delivering") return;
      entry.phase = "delivering";
      persist();
    },

    settle(runId: string): void {
      const map = load();
      const entry = map.get(runId);
      if (!entry || entry.settledAt !== null) return;
      entry.settledAt = now();
      persist();
    },

    noteReplay(runId: string): number {
      const map = load();
      const entry = map.get(runId);
      if (!entry || entry.settledAt !== null) return 0;
      entry.replays += 1;
      // Persisted BEFORE the replay runs, so a replay that itself dies mid-attempt still spends
      // its budget — otherwise a channel that reliably kills the daemon replays forever.
      persist();
      return entry.replays;
    },

    has(runId: string): boolean {
      const entry = load().get(runId);
      return !!entry && entry.settledAt === null;
    },

    list(): OwedRunNotification[] {
      return [...load().values()].filter((e) => e.settledAt === null);
    },
  };
}

/** The minimal shape of a channel-history entry {@link runNotificationAlreadyAnnounced} reads. */
export interface AnnouncementProbeEntry {
  authorId: string;
  ts: number;
}

/**
 * Circumstantial dedupe for a `delivering`-phase entry the boot scan can't otherwise verify: did
 * Beckett post ANYTHING at all in this channel since the record was created? That's weaker than
 * `owed-mentions`' `alreadyAnswered` (which checks for a reply AFTER a specific target message),
 * but there is no target message here — a run-completion ping is an outbound announcement, not a
 * reply. Deliberately biased toward REPLAY (returns false) when there's nothing to check or
 * nothing matches: for a run ping, a duplicate mention costs far less than a silent finish. See
 * the module header for why this is the opposite bias from `owed-mentions`.
 */
export function runNotificationAlreadyAnnounced(
  recentChannelEntries: readonly AnnouncementProbeEntry[],
  createdAt: number,
): boolean {
  return recentChannelEntries.some((e) => e.authorId === "beckett" && e.ts > createdAt);
}
