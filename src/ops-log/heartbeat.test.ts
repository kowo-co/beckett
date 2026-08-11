import { describe, expect, test } from "bun:test";
import { createTurnHeartbeat } from "./heartbeat.ts";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;

function manualScheduler() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    pending: () => timers.filter((t) => !t.cancelled),
    fire: () => {
      for (const timer of timers.filter((t) => !t.cancelled)) {
        timer.cancelled = true;
        timer.fn();
      }
    },
  };
}

function harness() {
  const pushed: string[] = [];
  const timers = manualScheduler();
  let clock = 1_000_000;
  const heartbeat = createTurnHeartbeat({
    push: (line) => pushed.push(line),
    logger: quiet,
    now: () => clock,
    schedule: timers.schedule,
  });
  return { heartbeat, pushed, timers, advance: (ms: number) => (clock += ms) };
}

describe("turn heartbeat", () => {
  test("does nothing before the 60s threshold", () => {
    const { heartbeat, pushed, timers, advance } = harness();
    heartbeat.turnStarted();
    advance(59_000);
    timers.fire();
    expect(pushed).toEqual([]);
  });

  test("fires at the 60s mark with elapsed + last event", () => {
    const { heartbeat, pushed, timers, advance } = harness();
    heartbeat.noteEvent("▶ browser lease acquired run-1");
    heartbeat.turnStarted();
    advance(60_000);
    timers.fire();
    expect(pushed).toEqual(["⏳ still working — 1m, last: ▶ browser lease acquired run-1"]);
  });

  test("repeats every ~60s while still live", () => {
    const { heartbeat, pushed, timers, advance } = harness();
    heartbeat.turnStarted();
    advance(60_000);
    timers.fire();
    advance(60_000);
    timers.fire();
    advance(60_000);
    timers.fire();
    expect(pushed.length).toBe(3);
    expect(pushed[1]).toContain("2m");
    expect(pushed[2]).toContain("3m");
  });

  test("stops the instant the turn ends — no more timers armed, no more pushes", () => {
    const { heartbeat, pushed, timers, advance } = harness();
    heartbeat.turnStarted();
    advance(60_000);
    timers.fire();
    expect(pushed.length).toBe(1);
    heartbeat.turnEnded();
    expect(timers.pending().length).toBe(0);
    expect(heartbeat.isLive()).toBe(false);
    advance(120_000);
    // No pending timer to fire — nothing more can be pushed even if one were forced.
    expect(pushed.length).toBe(1);
  });

  test("a turn that finishes before 60s never triggers a heartbeat", () => {
    const { heartbeat, pushed, timers, advance } = harness();
    heartbeat.turnStarted();
    advance(5_000);
    heartbeat.turnEnded();
    expect(timers.pending().length).toBe(0);
    advance(120_000);
    expect(pushed).toEqual([]);
  });

  test("concurrent turns: the heartbeat is ONE global signal keyed to the oldest live turn", () => {
    const { heartbeat, pushed, timers, advance } = harness();
    heartbeat.turnStarted(); // turn A at t=0
    advance(30_000);
    heartbeat.turnStarted(); // turn B at t=30s — does not re-arm or reset the clock
    advance(30_000); // t=60s: only turn A has crossed the threshold
    timers.fire();
    expect(pushed.length).toBe(1);
    expect(pushed[0]).toContain("1m");
    heartbeat.turnEnded(); // turn A ends; turn B (started at 30s) is still live
    expect(heartbeat.isLive()).toBe(true);
    expect(timers.pending().length).toBe(1); // the shared timer keeps running for B
  });

  test("liveCount never goes negative on a stray turnEnded with no matching start", () => {
    const { heartbeat } = harness();
    expect(() => heartbeat.turnEnded()).not.toThrow();
    expect(heartbeat.isLive()).toBe(false);
  });

  test("a throwing push is swallowed — the heartbeat itself never breaks a live turn", () => {
    const timers = manualScheduler();
    let clock = 0;
    const heartbeat = createTurnHeartbeat({
      push: () => {
        throw new Error("discord down");
      },
      logger: quiet,
      now: () => clock,
      schedule: timers.schedule,
    });
    heartbeat.turnStarted();
    clock += 60_000;
    expect(() => timers.fire()).not.toThrow();
    // It keeps ticking for the next window rather than getting wedged by the throw.
    expect(timers.pending().length).toBe(1);
  });
});
