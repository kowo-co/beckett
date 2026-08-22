/**
 * Beckett — Routine dispatch plan (`src/routine/plan.ts`)
 * =======================================================================================
 * Turns a routine's ACTION into a concrete, inspectable dispatch plan. This is the seam shared by:
 *
 *   - the daemon scheduler, which builds a plan then hands it to a `dispatch` executor
 *     ({@link ../shell/main.ts}) — the executor runs it OFF the scheduler process; and
 *   - the CLI `--dry-run`, which builds the SAME plan and prints it WITHOUT dispatching, so the
 *     wiring is provable without a real live post.
 *
 * Five lanes:
 *   - `agent`  → invoke a registered agent with `agentInput`; the agent AUTHORS the browser task at
 *      dispatch time (its taste lives in its prompt, not here), so the plan carries the invocation,
 *      not composed text. The authored post is not knowable until the agent runs.
 *   - `browser`→ a STATIC self-contained browser task, known at plan time.
 *   - `deps-update` → the LOCAL maintenance lane (issue #85): no agent, no browser, no credentials.
 *      The executor runs the dependency-update job in a throwaway clone and its output is a PR.
 *      This lane exists precisely so a maintenance job is NOT smuggled through the privileged
 *      browser lane, which would hand a local chore a web session it has no use for.
 *   - `watch` → the event-listener lane (issue #1): no I/O happens here (this function stays
 *      pure), so the plan only carries the intent to poll. The REAL work — fetching the feed,
 *      qualifying an item, rate-limiting, and dispatching the `agent` lane on a genuine hit —
 *      happens in the dispatcher, exactly like `deps-update`'s executor. A live, feed-aware
 *      preview for `--dry-run` is built separately by `runWatchCycle`/`previewWatchCycle`
 *      ({@link ./watch.ts}), which DO perform I/O — this function is not where that happens.
 *   - `self` → the ONLY lane that wakes Beckett itself (issue #26): no agent, no browser, no
 *      credentials. The plan carries just the prompt; the dispatcher hands it to the concierge's
 *      self-wake bus command, which frames a SYSTEM turn on `SYSTEM_SCOPE` via `askUpdate`. Like
 *      `deps-update`, it exists so a self-directed wake is NEVER smuggled through the browser lane.
 *
 * The pre-#72 `x-shitpost` action is folded onto the `agent` lane here (target: the `social-media`
 * agent), so a legacy routines.json fires through exactly ONE path with no bespoke composition code.
 *
 * A plan never carries a secret value — only the jingle entry NAME.
 */

import type { Routine } from "./types.ts";
import { SOCIAL_MEDIA_AGENT_ID, X_SOCIAL_ACCOUNT } from "../agent/builtins.ts";
import { X_CREDS_ENTRY } from "./builtins.ts";

/**
 * Whether a `browser`-lane routine's STATIC task targets X/social rather than some unrelated
 * site. This is the only signal available for a `browser` routine: unlike the `agent` lane (see
 * {@link SOCIAL_MEDIA_AGENT_ID} + `needsGroundingSources` in `../capability/modules/routines.ts`),
 * a `browser` routine names no agent and carries no marker of "this is social media" other than
 * what's IN the action — its creds entry and its task text. True when either:
 *   - `credsEntry` names the X account's jingle vault entry ({@link X_CREDS_ENTRY}), the one
 *     entry that can authenticate as the account these routines post through; or
 *   - the task text references the X domain or the account handle ({@link X_SOCIAL_ACCOUNT}).
 * A `browser` routine that matches is refused at dispatch (`dispatchPlan` in
 * `../capability/modules/routines.ts`) rather than silently forced through a compose gate it was
 * never written to expect: `x-social-morning`/`x-social-evening` (removed 2026-08-22) proved that
 * lane composes AND publishes in one ungrounded step, with no SOURCES block, no `POST:` contract,
 * and no verification — refusal is the cleaner fix because retrofitting grounding onto a FREEFORM
 * task string would mean parsing prose for intent, exactly the kind of fuzzy heuristic that let
 * the bypass happen in the first place. A routine that wants to post to X belongs on the `agent`
 * lane instead, targeting {@link SOCIAL_MEDIA_AGENT_ID}, where grounding is structural.
 */
export function browserActionTargetsXSocial(task: string, credsEntry: string | null): boolean {
  if (credsEntry === X_CREDS_ENTRY) return true;
  const lower = task.toLowerCase();
  return lower.includes("x.com") || lower.includes("twitter.com") || lower.includes(X_SOCIAL_ACCOUNT.toLowerCase());
}

/** The `deps-update` lane's parameters, resolved from the action (defaults filled at fire time). */
export interface DepsUpdateTarget {
  /** `owner/name` the PR opens on; null → the executor resolves it from the GitHub identity. */
  repo: string | null;
  /** The branch the PR TARGETS. Never pushed to, never merged into. */
  base: string;
  /** Checkout to clone FROM (read-only); null → the daemon's own source root. */
  sourceRepo: string | null;
}

/** The `proactive-sweep` lane's parameters (issue #79), resolved from the action. */
export interface ProactiveSweepTarget {
  /** The EXPLICIT opt-in list of `owner/name` repos. Empty → the executor sweeps nothing. */
  repos: string[];
}

/** The instruction handed to the social-media agent when a legacy `x-shitpost` routine fires. */
export const LEGACY_SHITPOST_INPUT =
  "Compose today's shitpost — one fresh, in-voice line — and author the browser task that posts it to X.";

export interface RoutineDispatchPlan {
  routineId: string;
  /**
   * Which lane executes this: an agent that authors a post, a static browser task, the local
   * dependency-update job, or the feed-watch poll. Only `agent`/`browser` (and, indirectly, a
   * qualifying `watch` fire) reach the browser.
   */
  lane:
    | "agent"
    | "browser"
    | "deps-update"
    | "watch"
    | "self"
    | "proactive-sweep"
    | "spend-report";
  /** agent lane: the registry id to invoke LIVE at dispatch (null for the browser lane). */
  agentId: string | null;
  /** agent lane: the instruction handed to that agent (null for the browser lane). */
  agentInput: string | null;
  /** browser lane: the static task string (null for the agent lane, which authors its task live). */
  browserTask: string | null;
  /** deps-update lane: what to update and where the PR goes (null on the other lanes). */
  depsUpdate: DepsUpdateTarget | null;
  /** proactive-sweep lane: the opt-in repo list to sweep for rot (null on the other lanes). */
  proactiveSweep: ProactiveSweepTarget | null;
  /** self lane: the instruction Beckett gives itself, framed as a SYSTEM turn (null elsewhere). */
  selfPrompt: string | null;
  /**
   * self lane, free-time variant (docs/freetime.md): true when this fire is the weekly
   * self-directed session. The dispatcher spawns the contained `beckett free-time run` body —
   * same pre-browser fork and same no-agent/no-browser/no-creds shape as a plain self wake, plus
   * the one thing no other plan has: it may be DEFERRED before the period is claimed (see
   * {@link ./scheduler.ts}) when the fleet is busy, so free time never competes with real work.
   */
  freeTime: boolean;
  /** Human-readable summary shown in a dry-run + logs. */
  preview: string;
  /** jingle keychain entry passed to the browser lane via --creds (a NAME, never a secret). */
  credsEntry: string | null;
  /** Discord channel the lane reports back to (may be filled from env by the executor). */
  channelId: string | null;
  /** Authenticated requester the run is attributed to (may be filled from env). */
  requesterId: string | null;
}

/** Build the dispatch plan for a routine firing now. Pure — no I/O, no dispatch, no composition. */
export function buildDispatchPlan(routine: Routine): RoutineDispatchPlan {
  const action = routine.action;

  if (action.kind === "agent") {
    return {
      routineId: routine.id,
      lane: "agent",
      agentId: action.agentId,
      agentInput: action.input,
      browserTask: null,
      depsUpdate: null,
      proactiveSweep: null,
      selfPrompt: null,
      freeTime: false,
      preview: `invoke agent ${action.agentId}: ${action.input}`,
      credsEntry: action.credsEntry ?? null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "deps-update") {
    // Its own lane, deliberately: nothing here names an agent, a browser task, or a creds entry,
    // so there is no shape a dispatcher could mistake for browser work.
    return {
      routineId: routine.id,
      lane: "deps-update",
      agentId: null,
      agentInput: null,
      browserTask: null,
      depsUpdate: {
        repo: action.repo ?? null,
        base: action.base,
        sourceRepo: action.sourceRepo ?? null,
      },
      proactiveSweep: null,
      selfPrompt: null,
      freeTime: false,
      preview:
        `update in-range dependencies in an isolated clone, run typecheck + tests, ` +
        `open a PR against ${action.base}${action.repo ? ` on ${action.repo}` : ""}`,
      credsEntry: null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "proactive-sweep") {
    // Its own lane, cut from `deps-update`'s cloth (issue #79): nothing here names an agent, a
    // browser task, or a creds entry, so — like deps-update — there is no shape a dispatcher could
    // mistake for browser work. The plan carries only the EXPLICIT opt-in repo list; the executor
    // (its own subprocess) reads each repo, detects rot, and opens at most one labelled PR per
    // finding. An empty list is carried faithfully and sweeps nothing.
    const repos = [...action.repos];
    return {
      routineId: routine.id,
      lane: "proactive-sweep",
      agentId: null,
      agentInput: null,
      browserTask: null,
      depsUpdate: null,
      proactiveSweep: { repos },
      selfPrompt: null,
      freeTime: false,
      preview:
        repos.length === 0
          ? "sweep for rot — but no repos are opted in, so nothing is swept (add them to [proactive_sweep] repos in config.toml)"
          : `sweep ${repos.join(", ")} for red CI / dependency advisories / broken README links, ` +
            "opening at most one proactive-labelled PR per finding (never merges, never force-pushes)",
      credsEntry: null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "watch") {
    // Pure by construction: this is a DESCRIPTION of the poll, not a run of it. It carries
    // `agentId` (mirroring the `agent` lane, since a qualifying fire dispatches through it) but
    // `agentInput` is null — nobody knows which item, if any, will qualify until fire time.
    return {
      routineId: routine.id,
      lane: "watch",
      agentId: action.agentId,
      agentInput: null,
      browserTask: null,
      depsUpdate: null,
      proactiveSweep: null,
      selfPrompt: null,
      freeTime: false,
      preview:
        `poll ${action.feedUrl} every ${action.pollIntervalMinutes}m; on a genuinely new, ` +
        `unseen, rate-limit-clear model release, dispatch agent ${action.agentId} with the item ` +
        `as the subject` +
        (action.dryRun ? " (dry-run: would post, does not post)" : ""),
      credsEntry: action.credsEntry ?? null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "self") {
    // Its own lane, deliberately (issue #26): the ONLY plan that wakes Beckett itself. Like
    // `deps-update` it names no agent, no browser task, and no creds entry — there is no shape a
    // dispatcher could mistake for browser work, so a self routine can never resolve a web session.
    return {
      routineId: routine.id,
      lane: "self",
      agentId: null,
      agentInput: null,
      browserTask: null,
      depsUpdate: null,
      proactiveSweep: null,
      selfPrompt: action.prompt,
      freeTime: false,
      preview: `wake the concierge on its own ledger: ${action.prompt}`,
      credsEntry: null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "free-time") {
    // Free time (docs/freetime.md) rides the SELF lane: it shares the lane's "never the browser,
    // never an agent, never a credential" structure but runs as the contained `beckett free-time
    // run` subprocess, so the scratch-directory scope guard, the deny list, and the token ceiling
    // stay enforced in code rather than in a prompt.
    return {
      routineId: routine.id,
      lane: "self",
      agentId: null,
      agentInput: null,
      browserTask: null,
      depsUpdate: null,
      proactiveSweep: null,
      selfPrompt: null,
      freeTime: true,
      preview:
        "one self-directed session on the self lane (free time): a scratch directory it may not " +
        "write outside of, a hard output-token ceiling, and a writeback that seeds the next one",
      credsEntry: null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "spend-report") {
    // The weekly bill (#77) gets its OWN lane, deliberately: like `deps-update` it names no
    // agent, no browser task, and no creds entry, so there is no shape a dispatcher could mistake
    // for browser work. Its body reads the spend ledger and posts one per-task breakdown to the
    // channel, run as the `beckett routine spend-report` subprocess off the scheduler tick.
    return {
      routineId: routine.id,
      lane: "spend-report",
      agentId: null,
      agentInput: null,
      browserTask: null,
      depsUpdate: null,
      proactiveSweep: null,
      selfPrompt: null,
      freeTime: false,
      preview: `post the per-task spend bill for the last ${action.since} to the channel`,
      credsEntry: null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  if (action.kind === "x-shitpost") {
    // Legacy shape → the same agent lane. The account/voice/how-to-post now live in the agent's
    // prompt; the routine only supplies the creds entry the browser lane injects.
    return {
      routineId: routine.id,
      lane: "agent",
      agentId: SOCIAL_MEDIA_AGENT_ID,
      agentInput: LEGACY_SHITPOST_INPUT,
      browserTask: null,
      depsUpdate: null,
      proactiveSweep: null,
      selfPrompt: null,
      freeTime: false,
      preview: `invoke agent ${SOCIAL_MEDIA_AGENT_ID}: ${LEGACY_SHITPOST_INPUT}`,
      credsEntry: action.credsEntry ?? null,
      channelId: action.channelId ?? null,
      requesterId: action.requesterId ?? null,
    };
  }

  // kind === "browser"
  return {
    routineId: routine.id,
    lane: "browser",
    agentId: null,
    agentInput: null,
    browserTask: action.task,
    depsUpdate: null,
    proactiveSweep: null,
    selfPrompt: null,
    freeTime: false,
    preview: action.task,
    credsEntry: action.credsEntry ?? null,
    channelId: action.channelId ?? null,
    requesterId: action.requesterId ?? null,
  };
}
