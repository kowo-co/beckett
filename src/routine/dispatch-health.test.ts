import { expect, test } from "bun:test";
import {
  applyDispatchFailure,
  applyDispatchSuccess,
  applyWatchCycleHealth,
  enabledRoutinesMissingOrigin,
  formatOriginStartupLine,
} from "./dispatch-health.ts";
import { emptyRoutineState, type Routine } from "./types.ts";

test("a failing dispatch alerts once and not twice for the same signature", () => {
  const first = applyDispatchFailure(emptyRoutineState(), new Error("need origin"), { routineId: "daily-x-shitpost" });
  expect(first.alert).toContain("`daily-x-shitpost`");
  expect(first.alert).toContain("need origin");
  expect(first.alert).not.toMatch(/at \//);
  expect(first.state.consecutiveFailures).toBe(1);
  expect(first.state.lastOutcome).toBe("failed");
  expect(first.state.lastError).toBe("need origin");

  const second = applyDispatchFailure(first.state, "Error: need origin", { routineId: "daily-x-shitpost" });
  expect(second.alert).toBeNull();
  expect(second.state.consecutiveFailures).toBe(2);
  expect(second.state.lastAlertedSignature).toBe(first.state.lastAlertedSignature);
});

test("the counter persists across a restart-shaped rehydrate and re-alerts at the threshold", () => {
  let state = emptyRoutineState();
  const err = "routine dispatch needs an origin channel + requester";
  const lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    // Rehydrate the way a new daemon would: only the persisted fields, no in-memory cache.
    const disk = structuredClone(state);
    const next = applyDispatchFailure(disk, err, { routineId: "daily-x-shitpost" });
    if (next.alert) lines.push(next.alert);
    state = next.state;
  }
  expect(lines).toHaveLength(2); // first failure + count 5
  expect(state.consecutiveFailures).toBe(5);
  expect(lines[1]).toContain("(5 consecutive)");

  const sixth = applyDispatchFailure(structuredClone(state), err, { routineId: "daily-x-shitpost" });
  expect(sixth.alert).toBeNull();

  const different = applyDispatchFailure(sixth.state, "agent social-media is not registered", { routineId: "daily-x-shitpost" });
  expect(different.alert).toContain("not registered");
  expect(different.state.consecutiveFailures).toBe(7);
});

test("a recovery emits exactly one line and clears the counter", () => {
  const failed = applyDispatchFailure(emptyRoutineState(), "boom", { routineId: "r" });
  const recovered = applyDispatchSuccess(failed.state, "r", new Date("2026-08-24T12:00:00.000Z"));
  expect(recovered.alert).toBe("routine `r` dispatched again after 1 miss. whatever that was, it's over.");
  expect(recovered.state.consecutiveFailures).toBe(0);
  expect(recovered.state.lastOutcome).toBe("ok");
  expect(recovered.state.lastError).toBeNull();
  expect(recovered.state.lastSucceededAt).toBe("2026-08-24T12:00:00.000Z");
  expect(recovered.state.lastAlertedSignature).toBeNull();

  const stillOk = applyDispatchSuccess(recovered.state, "r", new Date("2026-08-25T12:00:00.000Z"));
  expect(stillOk.alert).toBeNull();
});

test("shortError drops stacks and Error: prefixes", () => {
  const err = new Error("no origin\n    at dispatchPlan (routines.ts:1:1)");
  const update = applyDispatchFailure(emptyRoutineState(), err, { routineId: "r" });
  expect(update.state.lastError).toBe("no origin");
  expect(update.alert).toContain("no origin");
  expect(update.alert).not.toContain("at dispatchPlan");
});

test("a quiet watch poll stamps lastFiredAt without pretending dispatch succeeded", () => {
  const at = new Date("2026-08-24T12:00:00.000Z");
  const quiet = applyWatchCycleHealth(emptyRoutineState(), "model-news-watch", at);
  expect(quiet.alert).toBeNull();
  expect(quiet.state.lastFiredAt).toBe(at.toISOString());
  expect(quiet.state.lastOutcome).toBeNull();
  expect(quiet.state.lastSucceededAt).toBeNull();

  const failed = applyWatchCycleHealth(quiet.state, "model-news-watch", at, { ok: false, err: new Error("lane down") });
  expect(failed.alert).toContain("`model-news-watch`");
  expect(failed.state.lastOutcome).toBe("failed");
});

test("the startup check names a routine whose origin cannot resolve", () => {
  const broken: Routine = {
    id: "daily-x-shitpost",
    name: "daily X shitpost",
    builtin: true,
    enabled: true,
    action: { kind: "agent", agentId: "social-media", input: "compose" },
    schedule: { cadence: { kind: "daily" }, window: { start: "12:00", end: "13:00", tz: "America/Los_Angeles" } },
    state: emptyRoutineState(),
    createdAt: "t",
    updatedAt: "t",
  };
  const paused = { ...broken, id: "paused", enabled: false };
  const ok = {
    ...broken,
    id: "local-self",
    action: { kind: "self" as const, prompt: "hi", channelId: "chan", requesterId: "owner" },
  };
  const missing = enabledRoutinesMissingOrigin([broken, paused, ok], { channelId: null, requesterId: null });
  expect(missing).toEqual(["daily-x-shitpost"]);
  const line = formatOriginStartupLine(missing);
  expect(line).toContain("`daily-x-shitpost`");
  expect(line).not.toContain("`paused`");
  expect(line).not.toContain("`local-self`");
});
