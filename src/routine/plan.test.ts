/** Routine dispatch-plan building: agent lane, browser lane, and the legacy x-shitpost fold. */

import { expect, test } from "bun:test";
import { buildDispatchPlan, browserActionTargetsXSocial, LEGACY_SHITPOST_INPUT } from "./plan.ts";
import type { Routine, RoutineAction } from "./types.ts";
import { SOCIAL_MEDIA_AGENT_ID } from "../agent/builtins.ts";

function routine(action: RoutineAction): Routine {
  return {
    id: "r",
    name: "r",
    builtin: true,
    enabled: true,
    action,
    schedule: { cadence: { kind: "daily" }, window: { start: "12:00", end: "13:00", tz: "America/Los_Angeles" } },
    state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
    createdAt: "t",
    updatedAt: "t",
  };
}

test("agent action → agent lane carrying the invocation, not composed text", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "agent", agentId: "social-media", input: "compose today's shitpost", credsEntry: "x-account" }),
  );
  expect(plan.lane).toBe("agent");
  expect(plan.agentId).toBe("social-media");
  expect(plan.agentInput).toBe("compose today's shitpost");
  expect(plan.browserTask).toBeNull(); // authored live by the agent, not knowable at plan time
  expect(plan.credsEntry).toBe("x-account");
});

test("browser action → browser lane with the static task known at plan time", () => {
  const plan = buildDispatchPlan(routine({ kind: "browser", task: "go do the thing", credsEntry: "x-account" }));
  expect(plan.lane).toBe("browser");
  expect(plan.browserTask).toBe("go do the thing");
  expect(plan.agentId).toBeNull();
  expect(plan.agentInput).toBeNull();
});

// ── close the browser-action grounding bypass: a `browser` routine that targets X/social must ──
// ── never reach the browser lane with a compose-and-post task that skipped grounding ────────────
// REGRESSION (2026-08-22): `x-social-morning`/`x-social-evening` were `action: "browser"` routines
// whose static task was dispatched straight to the background browser lane — no SOURCES block, no
// `POST:` contract, no verification gate — and one of them fabricated a live post. Before this fix
// `buildDispatchPlan` carried no `refusalReason` field at all, so every case below FAILED (the
// field was `undefined` for every plan, including one whose creds/task plainly named the X
// account). After this fix, a `browser` action whose creds or task target X/social is refused at
// plan-build time; anything else keeps building an ordinary, undispatch-refused plan.

test("a browser routine authenticated as the X account (credsEntry names the vault entry) is refused", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "browser", task: "check the timeline and reply to anything interesting", credsEntry: "x-account" }),
  );
  expect(plan.lane).toBe("browser"); // still builds — the executor is what refuses to dispatch it
  expect(plan.refusalReason).toBeTruthy();
  expect(plan.preview).toContain("REFUSED");
});

test("a browser routine whose task names the X domain is refused even with no credsEntry", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "browser", task: "Compose one fresh post in voice and post it to x.com" }),
  );
  expect(plan.refusalReason).toBeTruthy();
});

test("a browser routine whose task names the account handle is refused", () => {
  const plan = buildDispatchPlan(routine({ kind: "browser", task: "post something fun as @beckposting" }));
  expect(plan.refusalReason).toBeTruthy();
});

test("an unrelated browser routine (no X creds, no X text) is NOT refused — the general browser lane keeps working", () => {
  const plan = buildDispatchPlan(routine({ kind: "browser", task: "check the status page and post a summary" }));
  expect(plan.refusalReason).toBeFalsy();
  expect(plan.preview).toBe("check the status page and post a summary");
});

test("browserActionTargetsXSocial: the exact detection rules, unit-tested in isolation", () => {
  expect(browserActionTargetsXSocial("go check the weather", null)).toBe(false);
  expect(browserActionTargetsXSocial("go check the weather", "x-account")).toBe(true);
  expect(browserActionTargetsXSocial("browse to X.COM and look around", null)).toBe(true); // case-insensitive
  expect(browserActionTargetsXSocial("check twitter.com/home", null)).toBe(true);
  expect(browserActionTargetsXSocial("DM @beckposting's followers", null)).toBe(true);
  expect(browserActionTargetsXSocial("check the status page", "some-other-vault-entry")).toBe(false);
});

test("browserActionTargetsXSocial: widened after cycle-1 review — tweet, bare twitter, bare X, no credsEntry needed", () => {
  // Review finding: the original rules only matched `x-account` creds, `x.com`, `twitter.com`, and
  // `@beckposting` — a routine phrased "tweet something" or "post it to X" with no credsEntry and
  // no domain slipped through onto the ungrounded browser lane despite the browser holding a
  // persistent logged-in X session.
  expect(browserActionTargetsXSocial("compose a tweet about the release", null)).toBe(true);
  expect(browserActionTargetsXSocial("go retweet anything interesting", null)).toBe(true);
  expect(browserActionTargetsXSocial("check twitter for replies", null)).toBe(true); // bare, no ".com"
  expect(browserActionTargetsXSocial("Compose one fresh post in voice... Post it to X", null)).toBe(true);
  expect(browserActionTargetsXSocial("post something fun as X", null)).toBe(true);
  // Still permissive for text that merely contains the letter "x" as part of another word.
  expect(browserActionTargetsXSocial("check the exchange rate and summarize it", null)).toBe(false);
});

test("legacy x-shitpost action folds onto the social-media agent lane — one runtime path", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "x-shitpost", account: "@beckposting", credsEntry: "x-account" }),
  );
  expect(plan.lane).toBe("agent");
  expect(plan.agentId).toBe(SOCIAL_MEDIA_AGENT_ID);
  expect(plan.agentInput).toBe(LEGACY_SHITPOST_INPUT);
  expect(plan.browserTask).toBeNull();
  expect(plan.credsEntry).toBe("x-account");
});

test("deps-update action → its OWN lane, with nothing a browser dispatcher could act on", () => {
  const plan = buildDispatchPlan(routine({ kind: "deps-update", base: "main" }));
  expect(plan.lane).toBe("deps-update");
  // The three fields a dispatcher reads to reach the browser lane are all empty, so there is no
  // shape here that could be mistaken for browser work (issue #85).
  expect(plan.browserTask).toBeNull();
  expect(plan.agentId).toBeNull();
  expect(plan.agentInput).toBeNull();
  expect(plan.credsEntry).toBeNull();
  // Repo/source stay unresolved in the plan — the executor fills them from identity at fire time.
  expect(plan.depsUpdate).toEqual({ repo: null, base: "main", sourceRepo: null });
  expect(plan.preview).toContain("open a PR against main");
});

test("deps-update carries an explicit repo/base/source when the routine names them", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "deps-update", base: "trunk", repo: "0xbeckett/beckett", sourceRepo: "/home/beckett/beckett" }),
  );
  expect(plan.depsUpdate).toEqual({
    repo: "0xbeckett/beckett",
    base: "trunk",
    sourceRepo: "/home/beckett/beckett",
  });
  expect(plan.preview).toContain("0xbeckett/beckett");
});

test("proactive-sweep action → its OWN lane carrying the opt-in repo list, nothing browser-shaped", () => {
  const plan = buildDispatchPlan(routine({ kind: "proactive-sweep", repos: ["me/a", "me/b"] }));
  expect(plan.lane).toBe("proactive-sweep");
  expect(plan.proactiveSweep).toEqual({ repos: ["me/a", "me/b"] });
  // Like deps-update, nothing here can be mistaken for browser work (issue #79).
  expect(plan.browserTask).toBeNull();
  expect(plan.agentId).toBeNull();
  expect(plan.agentInput).toBeNull();
  expect(plan.depsUpdate).toBeNull();
  expect(plan.credsEntry).toBeNull();
  expect(plan.preview).toContain("me/a, me/b");
});

test("proactive-sweep with an EMPTY opt-in list carries it faithfully and previews 'nothing swept'", () => {
  const plan = buildDispatchPlan(routine({ kind: "proactive-sweep", repos: [] }));
  expect(plan.lane).toBe("proactive-sweep");
  expect(plan.proactiveSweep).toEqual({ repos: [] });
  expect(plan.preview).toContain("no repos are opted in");
});

test("spend-report action → its OWN lane, with nothing a browser dispatcher could act on (#77)", () => {
  const plan = buildDispatchPlan(routine({ kind: "spend-report", since: "7d" }));
  expect(plan.lane).toBe("spend-report");
  // Same guarantee as deps-update: no browser task, no agent, no creds — the bill never touches the web.
  expect(plan.browserTask).toBeNull();
  expect(plan.agentId).toBeNull();
  expect(plan.agentInput).toBeNull();
  expect(plan.credsEntry).toBeNull();
  expect(plan.preview).toContain("spend bill for the last 7d");
});

test("self action → its OWN lane carrying only the prompt, nothing a browser dispatcher could act on", () => {
  const plan = buildDispatchPlan(routine({ kind: "self", prompt: "look over the board and nudge anything stalled" }));
  expect(plan.lane).toBe("self");
  expect(plan.selfPrompt).toBe("look over the board and nudge anything stalled");
  // The self lane wakes Beckett, never the browser: no browser task, no agent, no deps job, and —
  // critically — no creds entry anywhere on it (issue #26).
  expect(plan.browserTask).toBeNull();
  expect(plan.agentId).toBeNull();
  expect(plan.agentInput).toBeNull();
  expect(plan.depsUpdate).toBeNull();
  expect(plan.credsEntry).toBeNull();
  expect(plan.preview).toContain("look over the board and nudge anything stalled");
});

test("self action carries the routine's channelId/requesterId when named, still no creds", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "self", prompt: "morning sweep", channelId: "chan-1", requesterId: "owner-1" }),
  );
  expect(plan.channelId).toBe("chan-1");
  expect(plan.requesterId).toBe("owner-1");
  expect(plan.credsEntry).toBeNull();
});

test("a plan never carries a secret value — only the jingle entry NAME", () => {
  const plan = buildDispatchPlan(
    routine({ kind: "agent", agentId: "social-media", input: "x", credsEntry: "x-account" }),
  );
  expect(plan.credsEntry).toBe("x-account");
  expect(JSON.stringify(plan).toLowerCase()).not.toContain("password");
});

test("self-repair action → the SELF lane with selfRepair set: no agent, no browser, no creds", () => {
  const plan = buildDispatchPlan(routine({ kind: "self-repair" }));
  expect(plan.lane).toBe("self");
  expect(plan.selfRepair).toBe(true);
  expect(plan.freeTime).toBe(false);
  expect(plan.agentId).toBeNull();
  expect(plan.browserTask).toBeNull();
  expect(plan.credsEntry).toBeNull();
});

test("free-time action → the SELF lane with freeTime set: no agent, no browser, no creds", () => {
  const plan = buildDispatchPlan(routine({ kind: "free-time" }));
  expect(plan.lane).toBe("self");
  expect(plan.freeTime).toBe(true);
  expect(plan.selfPrompt).toBeNull();
  expect(plan.agentId).toBeNull();
  expect(plan.browserTask).toBeNull();
  expect(plan.credsEntry).toBeNull();
  expect(plan.preview).toContain("free time");
});

test("every non-free-time action plans with freeTime=false — only the free-time kind takes the fork", () => {
  const kinds: RoutineAction[] = [
    { kind: "agent", agentId: "social-media", input: "x" },
    { kind: "browser", task: "t" },
    { kind: "deps-update", base: "main" },
    { kind: "self", prompt: "sweep" },
    { kind: "spend-report", since: "7d" },
    { kind: "x-shitpost", account: "@a", credsEntry: "x-account" },
    { kind: "self-repair" },
  ];
  for (const action of kinds) expect(buildDispatchPlan(routine(action)).freeTime).toBe(false);
});

test("the builtin weekly-free-time ships the [free_time] defaults, and takes a seed-time override", async () => {
  const { builtinRoutineDefs } = await import("./builtins.ts");
  const shipped = builtinRoutineDefs().find((r) => r.id === "weekly-free-time")!;
  expect(shipped.action.kind).toBe("free-time");
  expect(shipped.schedule).toEqual({
    cadence: { kind: "weekly", weekday: "sunday" },
    window: { start: "02:00", end: "05:00", tz: "America/Los_Angeles" },
  });

  // Config retimes the SEED (the store passes it through); every other builtin is untouched.
  const overridden = builtinRoutineDefs({
    freeTime: { weekday: "wednesday", window: { start: "01:00", end: "03:00", tz: "Europe/Berlin" } },
  });
  expect(overridden.find((r) => r.id === "weekly-free-time")!.schedule).toEqual({
    cadence: { kind: "weekly", weekday: "wednesday" },
    window: { start: "01:00", end: "03:00", tz: "Europe/Berlin" },
  });
  expect(overridden.find((r) => r.id === "daily-x-shitpost")!.schedule).toEqual(
    builtinRoutineDefs().find((r) => r.id === "daily-x-shitpost")!.schedule,
  );
});
