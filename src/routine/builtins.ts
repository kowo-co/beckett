/**
 * Beckett — Built-in routines (`src/routine/builtins.ts`)
 * =======================================================================================
 * Engine-seeded routines that exist on a fresh install. The store seeds these on load unless
 * the user explicitly removed them (tracked in `removedBuiltins`). Among them:
 *
 *   - `daily-x-shitpost` (issue #62) — once a day at a random minute in 12:00–13:00 PT, post a
 *     dumb in-voice shitpost to X @beckposting. The acceptance vehicle for humanized timing.
 *   - `weekly-deps-update` (issue #85) — Sunday mornings PT, update in-range dependencies in an
 *     isolated clone and open a PR. The acceptance vehicle for the `weekly` cadence, and the one
 *     built-in that never touches the browser.
 *   - `model-news-watch` (issue #1) — polls the ai-tracker model-news feed every 15 minutes and,
 *     on a genuinely new model release, fires an EVENT post through the same `social-media` agent
 *     path as `daily-x-shitpost`, instead of waiting for the next scheduled lane. The acceptance
 *     vehicle for the `watch` action: it has no `schedule` (see {@link ../routine/types.ts}) and
 *     is driven by its own interval loop ({@link ../routine/watch.ts}), not the fuzz-window one.
 *   - `weekly-free-time` (docs/freetime.md) — once a week in the small hours, one unprompted
 *     session inside a scratch directory on a hard token budget, whose only durable outputs are a
 *     journal entry and create-only `free-time`-namespace memories that seed the next session.
 *
 * As of issue #55/#72 the shitpost routine drives that post THROUGH the `social-media` agent rather than
 * an ad-hoc composer: its action invokes the agent (which WRITES the post — taste lives in the
 * agent's prompt, all data) and the dispatcher hands the agent-authored task to the background
 * browser lane. One path, not two. The account/voice/how-to-post all live in the agent definition
 * ({@link ../agent/builtins.ts}); this routine only says WHEN, WHICH agent, and WHICH creds entry.
 *
 * The X credentials live in the jingle keychain under `x-account`; only the entry NAME is stored
 * here — the value is resolved by the browser lane, below the transcript. No secret is hardcoded.
 * (Previously this named a dead `x.com` entry the vault never had — issue ctx-social.md; a routine
 * still carrying the old name is healed on load by `RoutineStore`'s boot-time migration.)
 * `channelId` / `requesterId` are intentionally left to env at fire time
 * (`BECKETT_ROUTINE_CHANNEL_ID` / `DISCORD_OWNER_ID`) so no id is baked into source.
 */

import type { Cadence, FuzzWindow, Routine, Weekday } from "./types.ts";
import { SOCIAL_MEDIA_AGENT_ID } from "../agent/builtins.ts";
import { MODEL_NEWS_FEED_URL } from "./model-news.ts";

/** jingle keychain entry that holds the X login (username/password/TOTP). A NAME, never a secret. */
export const X_CREDS_ENTRY = "x-account";

/**
 * Id of the model-news event-watch routine (issue #1): polls the ai-tracker model-news feed and,
 * on a genuinely new model release, dispatches the SAME `social-media` agent path
 * `daily-x-shitpost` uses — an event post instead of waiting for the next scheduled lane.
 */
export const MODEL_NEWS_WATCH_ID = "model-news-watch";

/**
 * Id of the timeline-reply routine (real-sources ticket, Half 2): ro's ask — be "relevant and
 * active in ... replying to people on the home page ... not like everything but cool posts." Runs
 * the SAME `social-media` agent path as `daily-x-shitpost`, but the agent's job for this fire is
 * to author a browser task that reads the live home timeline and replies selectively, instead of
 * composing a fresh post — see `TIMELINE_REPLY_INPUT` and the TIMELINE REPLY ROUND section of the
 * agent's prompt (`../agent/builtins.ts`).
 */
export const TIMELINE_REPLY_ID = "x-timeline-replies";

/**
 * The instruction handed to the social-media agent each fire. Deliberately terse — the agent's
 * prompt owns the voice and the browser-task shape; this only names the job.
 */
export const DAILY_SHITPOST_INPUT =
  "Compose today's shitpost — one fresh, in-voice line — and author the browser task that posts it to X.";

/**
 * The instruction handed to the social-media agent for a timeline-reply round. Unlike
 * `DAILY_SHITPOST_INPUT` this does not ask for a `POST:`-contract line: the agent has no browser
 * of its own ({@link ../agent/invoke.ts}'s doc comment — it authors, the dispatcher dispatches),
 * so for this job it authors the FULL self-contained browser task that reads the live timeline and
 * replies, and the dispatcher's legacy fallback (no `POST:` line ⇒ the whole output IS the task)
 * hands that straight to the background browser lane. The literal phrase "TIMELINE REPLY ROUND" is
 * what `./social-grounding.ts#needsGroundingSources` reads to skip the compose-time SOURCES block
 * — a reply's grounding is the live page the browsing agent actually reads, not a fetched feed.
 */
export const TIMELINE_REPLY_INPUT =
  "TIMELINE REPLY ROUND: open the home timeline as @beckposting, read what is genuinely there " +
  "right now, and author the self-contained browser task that reads it and replies to a SMALL " +
  "number of genuinely good posts — a handful at most, and zero is a normal, often correct " +
  "outcome. Do not use the POST: contract for this job; write out the full browser task instead.";

/**
 * Id of the weekly dependency-update routine (issue #85) — ro's ask: stop hand-bumping deps forever.
 * Exported so the executor and its tests can name it without restating the string.
 */
export const WEEKLY_DEPS_UPDATE_ID = "weekly-deps-update";

/**
 * Id of the proactive rot-sweep routine (issue #79): ro's ask — "let me open PRs on rot in repos
 * without being asked." It ships ENABLED but with an EMPTY opt-in list, so it is scheduled and
 * running yet sweeps nothing until a human names repos in `[proactive_sweep] repos` in
 * config.toml. That is the "never all repos by default" guarantee made concrete: the sweep has no
 * repos to touch until a human adds them, and config is the only place that ever happens.
 */
export const PROACTIVE_SWEEP_ID = "proactive-sweep";

/**
 * Id of the weekly spend-report routine (#77): once a week, read the spend ledger and post a
 * per-task cost breakdown — "the bill" — to the configured channel. Its own lane (never the
 * browser), run as the `beckett routine spend-report` subprocess like `deps-update`.
 */
export const WEEKLY_SPEND_REPORT_ID = "weekly-spend-report";

/**
 * Id of the weekly free-time routine (docs/freetime.md): once a week, deep night PT, Beckett
 * runs one unprompted session inside a scratch directory on a hard token budget. It is a plain
 * builtin routine and not a new timer on purpose — free time gets no scheduling machinery of its
 * own, so disabling it is the same `beckett routine disable` every other routine answers to.
 */
export const FREE_TIME_ID = "weekly-free-time";

/**
 * Config-sourced overrides for the built-in definitions. Free time's schedule ships in
 * `[free_time]` config so a fresh install can be retimed without editing source; every other
 * builtin's window is a code constant. After the seed the routine store owns the timing — that
 * one is a SEED value, not a live binding, and `beckett routine` is how a seeded schedule moves.
 * The proactive sweep's repo list is different: it is config-authoritative on EVERY load (see
 * `RoutineStore`), because it is an allow-list and a seed-only override would go stale the moment
 * config changed on an existing install.
 */
export interface BuiltinRoutineOverrides {
  freeTime?: { weekday: Weekday; window: FuzzWindow };
  /**
   * The proactive-sweep routine's opt-in repo list, from `[proactive_sweep] repos` in config.
   * Unlike `freeTime` (seed-only), this override is applied on EVERY load, not just the first
   * write — see `RoutineStore`'s doc comment for why an allow-list can't have two sources of
   * truth.
   */
  proactiveSweep?: { repos: string[] };
}

/** The free-time schedule shipped when nothing overrides it — mirrors the `[free_time]` defaults. */
const FREE_TIME_DEFAULT_SCHEDULE: { cadence: Cadence; window: FuzzWindow } = {
  cadence: { kind: "weekly", weekday: "sunday" },
  window: { start: "02:00", end: "05:00", tz: "America/Los_Angeles" },
};

/**
 * The definitions (sans timestamps/state — the store stamps those on seed). Kept as a factory
 * so the seeder gets fresh objects and can't accidentally share mutable state.
 */
export function builtinRoutineDefs(
  overrides: BuiltinRoutineOverrides = {},
): Array<Omit<Routine, "createdAt" | "updatedAt" | "state">> {
  const freeTime = overrides.freeTime
    ? { cadence: { kind: "weekly" as const, weekday: overrides.freeTime.weekday }, window: overrides.freeTime.window }
    : FREE_TIME_DEFAULT_SCHEDULE;
  return [
    {
      id: "daily-x-shitpost",
      name: "daily X shitpost",
      builtin: true,
      enabled: true,
      action: {
        kind: "agent",
        agentId: SOCIAL_MEDIA_AGENT_ID,
        input: DAILY_SHITPOST_INPUT,
        credsEntry: X_CREDS_ENTRY,
      },
      schedule: {
        cadence: { kind: "daily" },
        window: { start: "12:00", end: "13:00", tz: "America/Los_Angeles" },
      },
    },
    {
      id: WEEKLY_DEPS_UPDATE_ID,
      name: "weekly dependency update",
      builtin: true,
      enabled: true,
      // `repo` / `sourceRepo` are deliberately ABSENT: the executor resolves them at fire time from
      // the GitHub identity and the daemon's own source root, so no account name or filesystem path
      // is baked into source. `base` is `main` and stays a TARGET — the job opens a PR and stops.
      action: { kind: "deps-update", base: "main" },
      // Sunday mornings PT: a PR can sit unmerged over the weekend without blocking anyone, and the
      // week's own work isn't competing for the test suite the update has to pass.
      schedule: {
        cadence: { kind: "weekly", weekday: "sunday" },
        window: { start: "08:00", end: "10:00", tz: "America/Los_Angeles" },
      },
    },
    {
      id: MODEL_NEWS_WATCH_ID,
      name: "model news event watch",
      builtin: true,
      enabled: true,
      // No `schedule`: this action polls on its own interval (`pollIntervalMinutes`), not a
      // once-per-humanized-period fuzz window — see the action's doc comment in types.ts.
      action: {
        kind: "watch",
        feedUrl: MODEL_NEWS_FEED_URL,
        pollIntervalMinutes: 15,
        agentId: SOCIAL_MEDIA_AGENT_ID,
        credsEntry: X_CREDS_ENTRY,
        dryRun: false,
      },
    },
    {
      id: TIMELINE_REPLY_ID,
      name: "X timeline replies",
      builtin: true,
      enabled: true,
      action: {
        kind: "agent",
        agentId: SOCIAL_MEDIA_AGENT_ID,
        input: TIMELINE_REPLY_INPUT,
        credsEntry: X_CREDS_ENTRY,
      },
      // Once a day, a few hours off the shitpost window so the two fires never collide. Daily —
      // not hourly — is the conservative choice: this job reads a live timeline and decides on its
      // own who to reply to, so a small daily blast radius (and a human able to see one round's
      // worth of replies at a glance) beats a chattier cadence, especially before the selectivity
      // bar has a track record.
      schedule: {
        cadence: { kind: "daily" },
        window: { start: "16:00", end: "17:00", tz: "America/Los_Angeles" },
      },
    },
    {
      id: PROACTIVE_SWEEP_ID,
      name: "proactive rot sweep",
      builtin: true,
      // Enabled but DORMANT: the empty `repos` list means it sweeps nothing until a human opts a
      // repo in. It never defaults to "all repos" — there is no such option. A repo is swept only
      // once it is named in this list.
      enabled: true,
      action: { kind: "proactive-sweep", repos: [] },
      // Weekday mornings PT: like the weekly deps update, a proactive PR can sit for a human to look
      // at without competing with active work, but a rot sweep earns a daily cadence so a freshly
      // red default branch or a new advisory is surfaced within a day, not a week.
      schedule: {
        cadence: { kind: "daily" },
        window: { start: "09:00", end: "10:30", tz: "America/Los_Angeles" },
      },
    },
    {
      id: WEEKLY_SPEND_REPORT_ID,
      name: "weekly spend report",
      builtin: true,
      enabled: true,
      // No channel/requester baked in: attribution comes from env at fire time. `since` bills the
      // trailing week, matching the weekly cadence.
      action: { kind: "spend-report", since: "7d" },
      // Sunday mornings PT — the week's bill lands where a human reads it before the next week starts.
      schedule: {
        cadence: { kind: "weekly", weekday: "sunday" },
        window: { start: "09:00", end: "10:00", tz: "America/Los_Angeles" },
      },
    },
    {
      id: FREE_TIME_ID,
      name: "weekly free time",
      builtin: true,
      enabled: true,
      // No prompt, no creds, no channel baked in: the
      // session's shape (its walls, its budget, its writeback contract) lives in code under
      // `src/freetime/`, so editing the routine can never widen what free time is allowed to do.
      action: { kind: "free-time" },
      // Deep night on a weekly cadence, from `[free_time]` config at seed time. The weekly period
      // key doubles as the once-per-week guard; the idle gate defers a busy night's fire WITHOUT
      // claiming the period, so a fleet that works through the window costs the week, not the fire.
      schedule: freeTime,
    },
  ];
}

/** Ids of the built-ins (for `remove` bookkeeping and tests). */
export function builtinRoutineIds(): string[] {
  return builtinRoutineDefs().map((r) => r.id);
}
