import { expect, test } from "bun:test";
import { RoutineSchema } from "./types.ts";
import {
  builtinRoutineDefs,
  builtinRoutineIds,
  TIMELINE_REPLY_ID,
  TIMELINE_REPLY_INPUT,
  X_CREDS_ENTRY,
} from "./builtins.ts";
import { SOCIAL_MEDIA_AGENT_ID } from "../agent/builtins.ts";
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
    state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
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
