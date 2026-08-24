/**
 * Beckett — Routines model (`src/routine/types.ts`)
 * =======================================================================================
 * A **routine** is a named, recurring scheduled task whose fire time is HUMANIZED, not a
 * clockwork cron tick. Instead of firing at exactly 12:00 every day, a routine fires at a
 * random time inside a WINDOW (e.g. somewhere in 12:00–13:00 America/Los_Angeles), so one
 * day it's 12:07 and the next it's 12:41 — human-irregular by design (issue #62).
 *
 * The definitions and the current period's already-chosen fire time both persist to disk
 * ({@link ./store.ts}) so a daemon restart mid-window neither double-fires nor re-rolls the
 * day's time. Firing is idempotent per period via `lastFiredPeriodKey`.
 *
 * These are the Zod-validated shapes the store reads/writes. The schedule math lives in
 * {@link ./schedule.ts}, dispatch-plan building in {@link ./plan.ts}, and the daemon tick in
 * {@link ./scheduler.ts}.
 */

import { z } from "zod";

/** "HH:MM" 24-hour wall-clock, e.g. "12:00" or "13:40". */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24h)");

/**
 * A fuzz window: pick a concrete fire time uniformly at random between `start` and `end`
 * wall-clock in the named IANA `tz` each period. `end` must be strictly after `start`.
 */
export const FuzzWindowSchema = z
  .object({
    start: HHMM,
    end: HHMM,
    tz: z.string().min(1),
  })
  .refine((w) => toMinutes(w.end) > toMinutes(w.start), {
    message: "window end must be after start",
  });
export type FuzzWindow = z.infer<typeof FuzzWindowSchema>;

/**
 * Weekday names in ISO-8601 week order (Monday first, Sunday last). The order IS load-bearing:
 * {@link ./schedule.ts} indexes into it to place a `weekly` routine's fire day inside its ISO
 * week, so Sunday is day 7 of the week it fires in, not day 1 of the next one.
 */
export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof WeekdaySchema>;

/**
 * The base cadence — the seam this discriminated union was built for (issue #85 took it):
 *
 *   - `daily`  — one period per tz-local calendar date; the period key is that date.
 *   - `weekly` — one period per ISO week, firing on `weekday`; the period key is the ISO week
 *     ("2026-W30"), so the once-per-period idempotency guard in {@link ./scheduler.ts} works
 *     EXACTLY as daily's does: a restart mid-week neither double-fires nor re-rolls the time
 *     already chosen inside that week's window.
 *
 * `interval` can still slot in the same way — a key derivation + an advance step, nothing else.
 */
export const CadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({ kind: z.literal("weekly"), weekday: WeekdaySchema }),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

/** A base cadence + the fuzz window applied to each of its periods. */
export const ScheduleSchema = z.object({
  cadence: CadenceSchema,
  window: FuzzWindowSchema,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/**
 * What a routine DOES when it fires. Every action runs OFF the intake/scheduler process — never
 * inline: the daemon hands the plan to a dispatch executor ({@link ../shell/main.ts}) that runs it.
 *
 * - `agent`: invoke a registered agent ({@link ../agent/registry.ts}) with `input`; the agent
 *   AUTHORS the work (its taste lives in its prompt — all data, no code here) and the dispatcher
 *   hands what it authored to the privileged background browser lane. This is how the daily shitpost
 *   is driven THROUGH the `social-media` agent (issue #55/#72). Pointing a routine at a different
 *   agent (or editing the agent's prompt) needs no code change and no redeploy.
 * - `browser`: run an arbitrary, STATIC self-contained browser task each period (issue #62).
 * - `deps-update`: the LOCAL maintenance lane (issue #85). The only action that does NOT touch the
 *   browser: it clones the source repo, applies in-range dependency updates, runs typecheck + the
 *   test suite, and opens a PR a human merges. Nothing about it wants a browser, credentials, or a
 *   privileged web session, so it must never be routed through that lane.
 * - `x-shitpost` (LEGACY): the pre-#72 shape. Still parsed so a routines.json seeded by an older
 *   build keeps loading; {@link ./plan.ts} transparently routes it through the `social-media` agent,
 *   so there is exactly ONE runtime path. New routines should use `agent`.
 * - `self` (issue #26): the ONLY lane that wakes Beckett itself instead of the browser. It runs a
 *   framed SYSTEM turn on the concierge — the seat with the doctrine, the memory graph, the Bash
 *   tool, and the ability to deploy runs — so a routine can put Beckett on its own open-loop
 *   ledger a few times a day. No agent, no browser task, no credentials: like `deps-update` it must
 *   never be routed through the privileged browser lane, which it has no use for.
 */
export const RoutineActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    /** Registry id of the agent to invoke (e.g. "social-media"). Resolved LIVE at fire time. */
    agentId: z.string().min(1),
    /** The instruction handed to the agent describing what to do (e.g. "compose today's shitpost"). */
    input: z.string().min(1),
    /** jingle keychain entry the browser lane injects creds from, for the agent-authored task. */
    credsEntry: z.string().optional(),
    /** Discord channel the browser lane reports its outcome/questions to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester the run is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("browser"),
    /** The self-contained task string handed to `beckett browser`. */
    task: z.string().min(1),
    credsEntry: z.string().optional(),
    channelId: z.string().optional(),
    requesterId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("deps-update"),
    /**
     * `owner/name` the PR is opened on. Omitted → resolved at fire time from the GitHub identity
     * (`<owner>/beckett`), so no account id is baked into a routine definition.
     */
    repo: z.string().min(1).optional(),
    /** Branch the PR TARGETS. It is never pushed to, never merged into — a human does that. */
    base: z.string().min(1).default("main"),
    /**
     * Absolute path of the checkout the update is cloned FROM, read-only. Omitted → the daemon's
     * own source root. The clone is what gets mutated; the live tree never is.
     */
    sourceRepo: z.string().min(1).optional(),
    /** Discord channel the one-line summary is posted to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester the run is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
  /**
   * `proactive-sweep` (issue #79): the SECOND local maintenance lane, cut from `deps-update`'s cloth
   * — no agent, no browser, no credentials, its own subprocess. On a schedule it looks at an EXPLICIT
   * opt-in list of repos for three kinds of rot (red default-branch CI, dependency advisories / long-
   * dead versions, broken README links) and opens ONE small PR per finding, labelled `proactive`. The
   * `repos` list is the whole allow-list: it defaults to EMPTY and nothing off it is ever touched, so
   * the sweep never runs against a repo ro didn't name (never all repos by default). Like `deps-update`
   * it only ever opens PRs — it never merges its own PR and never force-pushes.
   */
  z.object({
    kind: z.literal("proactive-sweep"),
    /**
     * The EXPLICIT opt-in list of `owner/name` repos to sweep. EMPTY by default: an un-configured
     * sweep touches no repo at all. There is no "all my repos" option — a repo is swept only if it
     * is named here.
     */
    repos: z.array(z.string().min(1)).default([]),
    /** Discord channel the one-line summary is posted to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester the run is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("x-shitpost"),
    /** Handle posted as, for the browser task narrative (e.g. "@beckposting"). */
    account: z.string().min(1),
    /** jingle keychain entry holding the X creds, passed to the browser lane via --creds. */
    credsEntry: z.string().min(1),
    /** Discord channel the browser lane reports its outcome/questions to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester the browser run is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
  /**
   * `watch` (issue #1): poll a third-party feed on an interval and, on a genuinely new item,
   * dispatch through the `agent` lane exactly like `x-shitpost`/`agent` do — an event post
   * instead of a scheduled one. Unlike every other action this one has NO `schedule`: it does
   * not fire once per humanized period, it polls on a plain interval and fires 0..n times a day
   * depending on what the feed actually says, gated by its own qualification + rate-limit rules
   * ({@link ../routine/model-news.ts}, {@link ../routine/rate-limit.ts}) rather than a fuzz
   * window. Its runtime state (seen-set, post history) lives in its own store
   * ({@link ../routine/watch-store.ts}), not in {@link RoutineState} — a restart-safe cold start
   * must seed from the LIVE feed, not from whatever `RoutineState` happened to persist.
   */
  z.object({
    kind: z.literal("watch"),
    /** The feed to poll — a plain HTTP(S) URL, checked for a `200` + `items[]` body each round. */
    feedUrl: z.string().min(1),
    /** How often to poll. Default 15 minutes. */
    pollIntervalMinutes: z.number().int().positive().default(15),
    /** Registry id of the agent a qualifying fire is dispatched to (e.g. "social-media"). */
    agentId: z.string().min(1),
    /** jingle keychain entry the browser lane injects creds from, for the agent-authored post. */
    credsEntry: z.string().optional(),
    /** Discord channel a fire (real or dry-run) reports to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester a real fire is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
    /**
     * When true, every poll runs its full qualify/dedup/rate-limit pass but the final step is a
     * one-line Discord preview instead of a real agent dispatch — "watch what it would have
     * posted" without risking a live post. Its own accounting bucket in the watch store means
     * flipping this back off never treats a simulated post as a real one.
     */
    dryRun: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("self"),
    /**
     * The instruction Beckett gives ITSELF when this fires. It is Beckett's own text from a
     * routine definition, not third-party content, so it is framed as a SYSTEM turn (never a user
     * message) but needs no untrusted-input quoting. See {@link ../concierge/index.ts}'s self-wake
     * bus command, which hands it to `askUpdate` — the same lane run updates use.
     */
    prompt: z.string().min(1),
    /** Discord channel the self turn is told to report to (optional; env fallback). */
    channelId: z.string().optional(),
    /** Authenticated requester the fire is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
  /**
   * `spend-report` (#77): the weekly bill. Forks BEFORE every browser dependency (like
   * `deps-update`) — it reads the spend ledger and posts ONE per-task cost breakdown to its
   * channel, with no agent, no browser, and no credentials. Its body runs as the
   * `beckett routine spend-report` subprocess so the ledger read + Discord post never sit inside a
   * scheduler tick, and a crash in it can't reach the daemon.
   */
  /**
   * `free-time` (docs/freetime.md): the weekly self-directed session, riding the SAME self-lane
   * fork as `deps-update`/`self` — no agent, no browser, no credentials — and executed as the
   * contained `beckett free-time run` subprocess. It has no prompt field: what the session may
   * do is decided by the scratch-directory scope guard, the deny list, and the token ceiling, all
   * in code, so a routine edit can never widen it. Unlike every other action it may DEFER: the
   * scheduler asks the dispatcher before claiming the period, and a busy fleet pushes the fire to
   * a later tick in the same week rather than competing with real work.
   */
  z.object({
    kind: z.literal("free-time"),
    /** Discord channel the fire is attributed to (optional; env fallback). Provenance only —
     *  the session's optional share posts to `[free_time] channel_id`, not to this. */
    channelId: z.string().optional(),
    /** Authenticated requester the fire is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
  /**
   * `self-repair` (docs/self-repair.md): nightly error clustering + capped run filing. Rides
   * the SAME self-lane fork as free-time — no agent, no browser, no credentials — executed as
   * `beckett self-repair run`. Does not defer when the machine is busy — a queue insert is not
   * contention.
   */
  z.object({
    kind: z.literal("self-repair"),
    channelId: z.string().optional(),
    requesterId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("spend-report"),
    /** Rolling window billed, as a `parseSince` string (e.g. "7d"). Default matches the weekly cadence. */
    since: z.string().min(1).default("7d"),
    /** Discord channel the bill posts to (optional; env fallback at fire time). */
    channelId: z.string().optional(),
    /** Authenticated requester the fire is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
  /**
   * `dream` (`src/dream/`): the nightly sessions-review pass, riding the SAME self-lane fork as
   * `free-time`/`self` — no agent, no browser, no credentials — and executed as the contained
   * `beckett dream run` subprocess. It has no prompt field: what the pass may read (the day's
   * guild channel sessions) and write (create-only `dream`-namespace memories, capped) is decided
   * in code, not by a routine edit. Like `free-time` it may DEFER: the scheduler asks the
   * dispatcher before claiming the period, and a busy fleet or an in-flight concierge turn pushes
   * the fire to a later tick the same day rather than competing with real work.
   */
  z.object({
    kind: z.literal("dream"),
    /** Discord channel the fire is attributed to (optional; env fallback). Provenance only —
     *  the pass's one-line report posts to `[dream] channel_id`, not to this. */
    channelId: z.string().optional(),
    /** Authenticated requester the fire is attributed to (optional; owner env fallback). */
    requesterId: z.string().optional(),
  }),
]);
export type RoutineAction = z.infer<typeof RoutineActionSchema>;

/**
 * Per-period runtime state — the part that must survive a restart. `periodKey` is the key of
 * the period `chosenFireAt` was rolled for; `lastFiredPeriodKey` is the key we already fired
 * for (idempotency). A restart re-reads this and does NOT re-roll while `periodKey` still
 * matches the current period.
 */
export const RoutineStateSchema = z.object({
  /** Period key the current `chosenFireAt` belongs to ("2026-07-20" daily, "2026-W30" weekly). */
  periodKey: z.string().nullable().default(null),
  /** The concrete fire instant chosen for `periodKey`, ISO-8601 UTC. */
  chosenFireAt: z.string().nullable().default(null),
  /** The period key we have already fired for — blocks a second fire in the same period. */
  lastFiredPeriodKey: z.string().nullable().default(null),
  /** ISO time of the last successful dispatch (for `inspect`). */
  lastFiredAt: z.string().nullable().default(null),
});
export type RoutineState = z.infer<typeof RoutineStateSchema>;

export const RoutineSchema = z.object({
  /** Stable id/name, kebab-case (e.g. "daily-x-shitpost"). */
  id: z.string().min(1),
  /** Human label. */
  name: z.string().min(1),
  /** True for engine-seeded routines that re-appear on boot unless explicitly removed. */
  builtin: z.boolean().default(false),
  /** Paused routines persist and inspect but never fire. */
  enabled: z.boolean().default(true),
  action: RoutineActionSchema,
  /**
   * Absent for `watch` actions ONLY — nothing else in the union fires without one. A `watch`
   * routine's timing is its own `pollIntervalMinutes`, not a humanized period/window; see the
   * action's doc comment above.
   */
  schedule: ScheduleSchema.optional(),
  state: RoutineStateSchema.default({
    periodKey: null,
    chosenFireAt: null,
    lastFiredPeriodKey: null,
    lastFiredAt: null,
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const RoutineRegistrySchema = z.object({
  version: z.literal(1),
  routines: z.array(RoutineSchema).default([]),
  /** Built-in ids the user explicitly removed, so seeding doesn't resurrect them. */
  removedBuiltins: z.array(z.string()).default([]),
});
export type RoutineRegistry = z.infer<typeof RoutineRegistrySchema>;

/** "12:34" → 754 (minutes since midnight). Used by the window validator and schedule math. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}
