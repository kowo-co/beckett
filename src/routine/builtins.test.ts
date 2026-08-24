import { expect, test } from "bun:test";
import { RoutineSchema, emptyRoutineState } from "./types.ts";
import { toMinutes } from "./types.ts";
import {
  builtinRoutineDefs,
  builtinRoutineIds,
  DAILY_SHITPOST_ID,
  DAILY_SHITPOST_IDS,
  TIMELINE_REPLY_ID,
  TIMELINE_REPLY_IDS,
  TIMELINE_REPLY_INPUT,
  X_CREDS_ENTRY,
} from "./builtins.ts";
import { SOCIAL_MEDIA_AGENT_ID, TIMELINE_REPLY_CAP } from "../agent/builtins.ts";
import { needsGroundingSources } from "./social-grounding.ts";

test("the timeline-reply routine ships enabled, on the agent lane, with a conservative daily cadence", () => {
  const defs = builtinRoutineDefs();
  expect(builtinRoutineIds()).toContain(TIMELINE_REPLY_ID);
  const routine = defs.find((r) => r.id === TIMELINE_REPLY_ID);
  expect(routine).toBeDefined();
  expect(routine!.enabled).toBe(true);
  expect(routine!.builtin).toBe(true);
  expect(routine!.action).toEqual({
    kind: "agent",
    agentId: SOCIAL_MEDIA_AGENT_ID,
    input: TIMELINE_REPLY_INPUT,
    credsEntry: X_CREDS_ENTRY,
  });
  // Daily, once a fuzz-window per day — never an hourly/watch-style poll, per the ticket's ask
  // for a conservative cadence.
  expect(routine!.schedule).toBeDefined();
  expect(routine!.schedule!.cadence).toEqual({ kind: "daily" });
  // A DIFFERENT window than daily-x-shitpost's noon slot, so the two fires never collide.
  const shitpost = defs.find((r) => r.id === "daily-x-shitpost")!;
  expect(routine!.schedule!.window).not.toEqual(shitpost.schedule!.window);
});

test("the timeline-reply routine parses against the real Routine schema (with timestamps/state stamped)", () => {
  const def = builtinRoutineDefs().find((r) => r.id === TIMELINE_REPLY_ID)!;
  const stamped = {
    ...def,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    state: emptyRoutineState(),
  };
  expect(() => RoutineSchema.parse(stamped)).not.toThrow();
});

test("its input is the literal TIMELINE REPLY ROUND phrase — the phrase the grounding gate reads", () => {
  expect(TIMELINE_REPLY_INPUT).toContain("TIMELINE REPLY ROUND");
  // The whole point of the phrase: it tells `needsGroundingSources` to skip the compose-time
  // SOURCES block, since a reply's grounding is the live timeline page, not a fetched feed.
  expect(needsGroundingSources(TIMELINE_REPLY_INPUT)).toBe(false);
});

test("every other builtin routine's input still needs the compose-time grounding sources", () => {
  const def = builtinRoutineDefs().find((r) => r.id === "daily-x-shitpost")!;
  if (def.action.kind === "agent") {
    expect(needsGroundingSources(def.action.input)).toBe(true);
  }
});

// ── crank-the-frequency ticket (2026-08-21): several fuzzed fires a day ─────────────────────

test("the shitpost routine fires FOUR times a day, each a distinct sibling routine with its own window", () => {
  expect(DAILY_SHITPOST_IDS.length).toBe(4);
  expect(DAILY_SHITPOST_IDS[0]).toBe(DAILY_SHITPOST_ID);
  const defs = builtinRoutineDefs();
  for (const id of DAILY_SHITPOST_IDS) {
    expect(builtinRoutineIds()).toContain(id);
    const routine = defs.find((r) => r.id === id)!;
    expect(routine.builtin).toBe(true);
    expect(routine.enabled).toBe(true);
    expect(routine.action).toEqual({
      kind: "agent",
      agentId: SOCIAL_MEDIA_AGENT_ID,
      input: expect.any(String),
      credsEntry: X_CREDS_ENTRY,
    });
    expect(routine.schedule!.cadence).toEqual({ kind: "daily" });
  }
  // The original id keeps its original window verbatim — nothing that already depended on it
  // (store.test.ts, scheduler.test.ts) needed to change.
  expect(defs.find((r) => r.id === DAILY_SHITPOST_ID)!.schedule!.window).toEqual({
    start: "12:00",
    end: "13:00",
    tz: "America/Los_Angeles",
  });
});

test("the timeline-reply routine runs THREE rounds a day, each a distinct sibling routine with its own window", () => {
  expect(TIMELINE_REPLY_IDS.length).toBe(3);
  expect(TIMELINE_REPLY_IDS[0]).toBe(TIMELINE_REPLY_ID);
  const defs = builtinRoutineDefs();
  for (const id of TIMELINE_REPLY_IDS) {
    expect(builtinRoutineIds()).toContain(id);
    const routine = defs.find((r) => r.id === id)!;
    expect(routine.builtin).toBe(true);
    expect(routine.enabled).toBe(true);
    expect(routine.action).toEqual({
      kind: "agent",
      agentId: SOCIAL_MEDIA_AGENT_ID,
      input: TIMELINE_REPLY_INPUT,
      credsEntry: X_CREDS_ENTRY,
    });
    expect(routine.schedule!.cadence).toEqual({ kind: "daily" });
  }
});

test("every shitpost/timeline-reply window this ticket seeds is disjoint — no two fires can ever land at the same minute", () => {
  const defs = builtinRoutineDefs();
  const windows = [...DAILY_SHITPOST_IDS, ...TIMELINE_REPLY_IDS].map((id) => {
    const w = defs.find((r) => r.id === id)!.schedule!.window;
    return { id, start: toMinutes(w.start), end: toMinutes(w.end) };
  });
  windows.sort((a, b) => a.start - b.start);
  for (let i = 1; i < windows.length; i++) {
    expect(windows[i]!.start).toBeGreaterThanOrEqual(windows[i - 1]!.end);
  }
});

test("the routine's own instruction names the For You tab and forbids search/profile-hunting/hashtags (ro, 2026-08-21)", () => {
  expect(TIMELINE_REPLY_INPUT.toLowerCase()).toContain("for you tab");
  expect(TIMELINE_REPLY_INPUT.toLowerCase()).toContain("never following");
  expect(TIMELINE_REPLY_INPUT.toLowerCase()).toContain("never use x's search");
  expect(TIMELINE_REPLY_INPUT.toLowerCase()).toContain("never open a hashtag or trends page");
  expect(TIMELINE_REPLY_INPUT.toLowerCase()).toContain("never open a stranger's profile hunting");
  // The routine's own cap matches the agent prompt's cap — one number, not two.
  expect(TIMELINE_REPLY_INPUT).toContain(`up to ${TIMELINE_REPLY_CAP}`);
});
