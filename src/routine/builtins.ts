/**
 * Beckett — Built-in routines (`src/routine/builtins.ts`)
 * =======================================================================================
 * Engine-seeded routines that exist on a fresh install. The store seeds these on load unless
 * the user explicitly removed them (tracked in `removedBuiltins`). Among them:
 *
 *   - `daily-x-shitpost` (issue #62; cranked per ro's 2026-08-21 "boost the frequency" ask) — FOUR
 *     fuzzed fires a day (`DAILY_SHITPOST_IDS`), each its own routine with its own non-overlapping
 *     fuzz window, spread across the waking day so a human sees several dumb in-voice shitposts to
 *     X @beckposting, never on a predictable clock. Multiple SIBLING routines, not a new cadence
 *     kind — see the doc comment on `DAILY_SHITPOST_IDS` below for why. Still the acceptance
 *     vehicle for humanized timing; there are just several windows now instead of one.
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
import { SOCIAL_MEDIA_AGENT_ID, TIMELINE_REPLY_CAP } from "../agent/builtins.ts";
import { MODEL_NEWS_FEED_URL } from "./model-news.ts";

/** America/Los_Angeles, shared by every builtin below that fires on PT wall-clock. */
const PT_TZ = "America/Los_Angeles";

/** jingle keychain entry that holds the X login (username/password/TOTP). A NAME, never a secret. */
export const X_CREDS_ENTRY = "x-account";

/**
 * Id of the model-news event-watch routine (issue #1): polls the ai-tracker model-news feed and,
 * on a genuinely new model release, dispatches the SAME `social-media` agent path
 * `daily-x-shitpost` uses — an event post instead of waiting for the next scheduled lane.
 */
export const MODEL_NEWS_WATCH_ID = "model-news-watch";

/**
 * Id of the FIRST timeline-reply routine (real-sources ticket, Half 2): ro's ask — be "relevant
 * and active in ... replying to people on the home page ... not like everything but cool posts."
 * Runs the SAME `social-media` agent path as `daily-x-shitpost`, but the agent's job for this fire
 * is to author a browser task that reads the live For You feed and replies to everything it
 * genuinely has a line for, instead of composing a fresh post — see `TIMELINE_REPLY_INPUT` and the
 * TIMELINE REPLY ROUND section of the agent's prompt (`../agent/builtins.ts`). See
 * `TIMELINE_REPLY_IDS` below for the other two rounds this fires alongside.
 */
export const TIMELINE_REPLY_ID = "x-timeline-replies";

/**
 * Ids of all THREE timeline-reply rounds a day (crank-the-frequency ticket, 2026-08-21): sibling
 * routines sharing one `TIMELINE_REPLY_INPUT`/agent, each with its own non-overlapping fuzz
 * window, exactly like `DAILY_SHITPOST_IDS` below — see that constant's doc comment for why
 * sibling routines were picked over a new cadence kind or the `watch` poll-loop precedent.
 */
export const TIMELINE_REPLY_IDS = [TIMELINE_REPLY_ID, "x-timeline-replies-2", "x-timeline-replies-3"] as const;

/**
 * Id of the FIRST daily-shitpost fire. See `DAILY_SHITPOST_IDS` below for the other three.
 */
export const DAILY_SHITPOST_ID = "daily-x-shitpost";

/**
 * Ids of all FOUR daily-shitpost fires a day (crank-the-frequency ticket, 2026-08-21: ro asked,
 * verbatim, to "boost the frequency of posting to be more frequent"). The routine engine's
 * `schedule` is one `cadence` + ONE fuzz window fired once per period (`./types.ts`) — there is no
 * "N fires a day" cadence kind. Three ways to get several fires a day out of that shape:
 *
 *   1. extend `Cadence`/`Schedule` with a multi-window/N-per-day kind, touching the shared
 *      schedule math (`./schedule.ts`) and every consumer of it;
 *   2. seed several SIBLING routines, each a plain `daily` cadence with its own non-overlapping
 *      fuzz window — no engine change at all, every existing per-routine idempotency/restart/fuzz
 *      guarantee applies unmodified to each sibling;
 *   3. follow the `watch` action's precedent (`./watch.ts`) — a `pollIntervalMinutes` loop instead
 *      of a fuzz window.
 *
 * (2) is what ships here: it needed zero changes to `./types.ts`/`./schedule.ts`/`./scheduler.ts`,
 * each fire keeps the exact fuzz/restart-safety/once-per-period guarantees the single routine
 * already had, and disjoint windows make a same-day collision between two fires structurally
 * impossible rather than something a scheduler has to avoid at runtime. (3) was rejected because
 * `watch` polls on a genuine external trigger (a new model release) — there is no equivalent
 * "new event" to poll for here, so a poll loop would just be a fuzz window with extra state. (1)
 * was rejected as more engine surface than four cron-shaped routines justify.
 */
export const DAILY_SHITPOST_IDS = [
  DAILY_SHITPOST_ID,
  "daily-x-shitpost-2",
  "daily-x-shitpost-3",
  "daily-x-shitpost-4",
] as const;

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
 *
 * FOR YOU ONLY (ro, 2026-08-21, verbatim: "don't reply to random people outside of your For You
 * Page"): every candidate reply must come from a post the browsing agent actually scrolled past on
 * its OWN For You feed — never X's search, never a hashtag/trends page, never a profile opened to
 * go hunting for something to reply to. `TIMELINE_REPLY_CAP` (`../agent/builtins.ts`) is the
 * shared per-round cap, restated here so the routine's own instruction carries the same number the
 * agent's prompt enforces, not a second, driftable copy of it.
 */
export const TIMELINE_REPLY_INPUT =
  "TIMELINE REPLY ROUND: open the FOR YOU tab of the home timeline (x.com/home, For You — never " +
  "Following) as @beckposting, scroll it, and read what is genuinely there right now. Only react " +
  "to a post you actually scrolled past on that feed — never use X's search, never open a hashtag " +
  "or trends page, never open a stranger's profile hunting for something to reply to. Author the " +
  `self-contained browser task that reads the For You feed and replies to up to ${TIMELINE_REPLY_CAP} ` +
  "posts you genuinely have a real line for this round — replying is the default outcome now, not " +
  "the exception, and zero replies is only correct when the feed truly has nothing worth reacting " +
  "to. Do not use the POST: contract for this job; write out the full browser task instead.";

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
 * Every window below, shitpost and timeline-reply alike, laid out on the same PT wall-clock —
 * together with the pre-existing `proactive-sweep` window (09:00–10:30 PT, unchanged) — so the gap
 * between ANY two is visible at a glance. Every gap is exactly 30 minutes, so no two fires can ever
 * land at the same minute regardless of what each one's independent fuzz roll picks:
 *
 *   09:00–10:30  proactive-sweep       (pre-existing, unrelated to this ticket — left in place)
 *   11:00–11:30  daily-x-shitpost-2
 *   12:00–13:00  daily-x-shitpost      (the original window, unmoved — pinned by existing tests)
 *   13:30–14:15  x-timeline-replies-2
 *   14:45–15:30  daily-x-shitpost-3
 *   16:00–16:45  x-timeline-replies    (was 16:00–17:00; still the original START time)
 *   17:15–18:00  x-timeline-replies-3
 *   18:30–19:15  daily-x-shitpost-4
 *
 * Four shitpost fires + three reply rounds spread across an 09:00–19:15 PT waking day. Ceilings
 * (stated here, not just in the PR body, so a reader hits them next to the schedule that makes
 * them true): up to 4 fresh posts/day (hard — each of `DAILY_SHITPOST_IDS` fires at most once/day,
 * the same idempotency guarantee every daily routine already has) and up to 3 ×
 * `TIMELINE_REPLY_CAP` replies/day (a prompt-enforced ceiling per round, since a browsing agent's
 * own judgment — not a code path — is what actually stops at the cap). Both are well inside what a
 * human-paced, non-bursty account can do across a 10-hour window without tripping X's automation
 * heuristics; model-news-watch's independent 1/hour + 3/24h event-post cap is untouched by any of
 * this.
 */
const DAILY_SHITPOST_WINDOWS: Record<(typeof DAILY_SHITPOST_IDS)[number], FuzzWindow> = {
  [DAILY_SHITPOST_ID]: { start: "12:00", end: "13:00", tz: PT_TZ },
  "daily-x-shitpost-2": { start: "11:00", end: "11:30", tz: PT_TZ },
  "daily-x-shitpost-3": { start: "14:45", end: "15:30", tz: PT_TZ },
  "daily-x-shitpost-4": { start: "18:30", end: "19:15", tz: PT_TZ },
};

const TIMELINE_REPLY_WINDOWS: Record<(typeof TIMELINE_REPLY_IDS)[number], FuzzWindow> = {
  [TIMELINE_REPLY_ID]: { start: "16:00", end: "16:45", tz: PT_TZ },
  "x-timeline-replies-2": { start: "13:30", end: "14:15", tz: PT_TZ },
  "x-timeline-replies-3": { start: "17:15", end: "18:00", tz: PT_TZ },
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
    ...DAILY_SHITPOST_IDS.map((id) => ({
      id,
      name: id === DAILY_SHITPOST_ID ? "daily X shitpost" : `daily X shitpost (${DAILY_SHITPOST_WINDOWS[id].start} PT)`,
      builtin: true,
      enabled: true,
      action: {
        kind: "agent" as const,
        agentId: SOCIAL_MEDIA_AGENT_ID,
        input: DAILY_SHITPOST_INPUT,
        credsEntry: X_CREDS_ENTRY,
      },
      schedule: {
        cadence: { kind: "daily" as const },
        window: DAILY_SHITPOST_WINDOWS[id],
      },
    })),
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
    ...TIMELINE_REPLY_IDS.map((id) => ({
      id,
      name: id === TIMELINE_REPLY_ID ? "X timeline replies" : `X timeline replies (${TIMELINE_REPLY_WINDOWS[id].start} PT)`,
      builtin: true,
      enabled: true,
      action: {
        kind: "agent" as const,
        agentId: SOCIAL_MEDIA_AGENT_ID,
        input: TIMELINE_REPLY_INPUT,
        credsEntry: X_CREDS_ENTRY,
      },
      // THREE rounds a day now (crank-the-frequency ticket, 2026-08-21) — the "before the
      // selectivity bar has a track record" caveat that justified a single conservative daily
      // round is spent: ro explicitly asked to raise the frequency of replies, including to posts
      // Beckett isn't mentioned in. Each round keeps its own non-overlapping fuzz window (see the
      // schedule laid out above `DAILY_SHITPOST_WINDOWS`), so three rounds is three independent
      // once-per-day fires, not a new cadence kind.
      schedule: {
        cadence: { kind: "daily" as const },
        window: TIMELINE_REPLY_WINDOWS[id],
      },
    })),
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
