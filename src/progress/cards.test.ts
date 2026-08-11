import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import type { DispatchEvent, DispatchOutcome } from "../dispatch/events.ts";
import {
  createProgressCardService,
  reduceProgressCard,
  renderProgressCard,
  shouldObserveRunCard,
  type ProgressCardState,
} from "./cards.ts";

const TS = "2026-08-04T21:34:00.000Z";
const STARTED = Date.parse(TS);

function ev(stage: string, outcome: DispatchOutcome, message?: string, error?: string): DispatchEvent {
  return {
    ts: TS,
    runId: "ticket-1",
    runRef: "#2.1",
    branchRef: "beckett/task-2-1",
    stage,
    outcome,
    elapsedMs: 0,
    ...(message ? { message } : {}),
    ...(error ? { error } : {}),
  };
}

function fakeGateway() {
  const posts: { channelId: string; content: string }[] = [];
  const edits: { messageId: string; content: string }[] = [];
  let postFails: Error | null = null;
  let editFails: Error | null = null;
  let n = 0;
  const gateway = {
    async post(channelId: string, content: string) {
      if (postFails) throw postFails;
      posts.push({ channelId, content });
      return `msg-${++n}`;
    },
    async editMessage(_channelId: string, messageId: string, payload: { content?: string }) {
      if (editFails) throw editFails;
      edits.push({ messageId, content: payload.content ?? "" });
    },
  } as unknown as Pick<DiscordGateway, "post" | "editMessage">;
  return {
    gateway,
    posts,
    edits,
    failPosts: (e: Error | null) => (postFails = e),
    failEdits: (e: Error | null) => (editFails = e),
  };
}

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;

/** A manual scheduler: nothing fires until the test says so. */
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

function harness(
  overrides: {
    channel?: string | null;
    channelThrows?: Error;
    specReader?: (runId: string) => { done: number; total: number } | null;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cards-"));
  const statePath = join(dir, "progress-cards.json");
  const g = fakeGateway();
  const timers = manualScheduler();
  let clock = 1_000_000;
  const make = () =>
    createProgressCardService({
      gateway: g.gateway,
      statePath,
      resolveChannel: () => {
        if (overrides.channelThrows) throw overrides.channelThrows;
        return overrides.channel === undefined ? "chan-1" : overrides.channel;
      },
      ...(overrides.specReader ? { specReader: overrides.specReader } : {}),
      logger: quiet,
      now: () => clock,
      schedule: timers.schedule,
    });
  return {
    dir,
    statePath,
    g,
    timers,
    make,
    service: make(),
    advance: (ms: number) => (clock += ms),
    readState: () => JSON.parse(readFileSync(statePath, "utf8")) as { version: number; cards: Record<string, unknown> },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("reduceProgressCard", () => {
  test("a worker start reads as the stage's gerund", () => {
    const state = reduceProgressCard(null, ev("implement", "started", "worker wk_1 on claude"), 0)!;
    expect(state.phase).toBe("implementing");
    expect(state.terminal).toBe(false);
  });

  test("a staffing hold reads as queued", () => {
    const state = reduceProgressCard(null, ev("implement:staff", "held", "queued at concurrency cap"), 0)!;
    expect(state.phase).toBe("queued");
    expect(state.detail).toBe("waiting for a worker slot");
  });

  test("a wedge reads as stalled and alerts", () => {
    const state = reduceProgressCard(null, ev("implement:wedge", "failed", "worker silent for 6m; status check sent"), 0)!;
    expect(state.phase).toBe("stalled");
    expect(state.alert).toBe(true);
  });

  test("the staffing watchdog reads as retrying", () => {
    const state = reduceProgressCard(null, ev("watchdog", "started", "no live worker for 130s — re-staffing"), 0)!;
    expect(state.phase).toBe("retrying");
  });

  test("a failed worker names the stage and carries the error", () => {
    const state = reduceProgressCard(null, ev("implement", "failed", "worker exited", "bun test exited 1"), 0)!;
    expect(state.phase).toBe("implementation failed");
    expect(state.alert).toBe(true);
    expect(state.detail).toContain("bun test exited 1");
  });

  test("reaching done is terminal", () => {
    const state = reduceProgressCard(null, ev("state:done", "passed", "in_review → done"), 0)!;
    expect(state.phase).toBe("done");
    expect(state.terminal).toBe(true);
  });

  test("a durable park is terminal and alerts", () => {
    const state = reduceProgressCard(null, ev("park", "held", "durably parked for a human"), 0)!;
    expect(state.phase).toBe("parked for a human");
    expect(state.alert).toBe(true);
    expect(state.terminal).toBe(true);
  });

  test("a restart interruption is not a failure", () => {
    const state = reduceProgressCard(null, ev("implement", "interrupted", "stopped by a daemon restart"), 0)!;
    expect(state.phase).toBe("interrupted by a restart");
    expect(state.alert).toBe(false);
    expect(state.terminal).toBe(false);
  });

  test("plumbing events say nothing", () => {
    expect(reduceProgressCard(null, ev("worktree", "started"), 0)).toBeNull();
    expect(reduceProgressCard(null, ev("state:in_review", "started"), 0)).toBeNull();
    expect(reduceProgressCard(null, ev("restart-restaff", "started"), 0)).toBeNull();
    expect(reduceProgressCard(null, ev("preview", "passed", "https://x"), 0)).toBeNull();
  });

  test("the episode clock survives later events", () => {
    const first = reduceProgressCard(null, ev("implement", "started"), 0)!;
    const second = reduceProgressCard(first, { ...ev("review", "started"), ts: "2026-08-04T22:00:00.000Z" }, 0)!;
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.startedAt).toBe(STARTED);
  });

  test("a run.deploy admission reads as queued — the deploy receipt's first card", () => {
    const state = reduceProgressCard(null, ev("run:deploy", "started", "queued"), 0)!;
    expect(state.phase).toBe("queued");
    expect(state.terminal).toBe(false);
    expect(state.alert).toBe(false);
  });

  test("a run reaching bare `done` (run/supervisor.ts's own vocabulary) reads as shipped", () => {
    const state = reduceProgressCard(null, ev("done", "passed", "https://github.com/o/r/pull/7"), 0)!;
    expect(state.phase).toBe("shipped");
    expect(state.terminal).toBe(true);
    expect(state.alert).toBe(false);
    expect(state.detail).toBe("https://github.com/o/r/pull/7");
  });

  test("a bare `done` event with no message still ships, with no detail", () => {
    const state = reduceProgressCard(null, ev("done", "passed"), 0)!;
    expect(state.phase).toBe("shipped");
    expect(state.detail).toBe("");
  });
});

describe("renderProgressCard", () => {
  const base: ProgressCardState = {
    ref: "#2.1",
    phase: "implementing",
    detail: "",
    alert: false,
    terminal: false,
    startedAt: STARTED,
  };

  test("a working card is one line", () => {
    expect(renderProgressCard(base, STARTED + 300_000)).toBe("▸ **#2.1** · implementing · 5m");
  });

  test("markers distinguish alert, done and cancelled", () => {
    const alert = renderProgressCard({ ...base, phase: "stalled", detail: "worker silent", alert: true }, STARTED);
    expect(alert).toContain("⚠");
    expect(alert).toContain("\n— worker silent");
    expect(renderProgressCard({ ...base, phase: "done", terminal: true }, STARTED)).toContain("✓");
    expect(renderProgressCard({ ...base, phase: "cancelled", terminal: true }, STARTED)).toContain("⛔");
  });

  test("a huge error can never overflow one Discord message", () => {
    const state = reduceProgressCard(null, ev("implement", "failed", "worker exited", "x".repeat(5000)), 0)!;
    const text = renderProgressCard(state, STARTED);
    expect(text.length).toBeLessThanOrEqual(1900);
    expect(text).toContain("…");
  });

  test("a run card with a checklist folds progress and detail onto one line", () => {
    const withDetail = { ...base, phase: "implementing", detail: "worker wk_1 on claude" };
    expect(renderProgressCard(withDetail, STARTED + 720_000, { done: 3, total: 7 })).toBe(
      "▸ **#2.1** · implementing · 12m — 3/7 checked · worker wk_1 on claude",
    );
  });

  test("a run card with a checklist but no detail stops after the count", () => {
    expect(renderProgressCard(base, STARTED + 720_000, { done: 3, total: 7 })).toBe(
      "▸ **#2.1** · implementing · 12m — 3/7 checked",
    );
  });

  test("no specReader hit (null/undefined checklist) renders exactly as before run cards existed", () => {
    const withDetail = { ...base, phase: "stalled", detail: "worker silent", alert: true };
    expect(renderProgressCard(withDetail, STARTED, null)).toBe(renderProgressCard(withDetail, STARTED));
  });

  test("a shipped run card reads as a checkmark with the PR/push URL as its detail", () => {
    const state = reduceProgressCard(null, ev("done", "passed", "https://github.com/o/r/pull/7"), 0)!;
    const text = renderProgressCard(state, STARTED);
    expect(text).toContain("✓");
    expect(text).toContain("shipped");
    expect(text).toContain("\n— https://github.com/o/r/pull/7");
  });
});

describe("ProgressCardService", () => {
  test("posts once, then throttles later edits into one trailing update", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started", "worker wk_1 on claude"));
      expect(h.g.posts).toHaveLength(1);
      expect(h.g.posts[0]!.channelId).toBe("chan-1");

      h.advance(1_000);
      await h.service.observe(ev("implement:wedge", "failed", "worker silent for 6m"));
      expect(h.g.edits).toHaveLength(0);
      expect(h.timers.pending()).toHaveLength(1);

      h.timers.fire();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.g.edits).toHaveLength(1);
      expect(h.g.edits[0]!.content).toContain("stalled");
    } finally {
      h.cleanup();
    }
  });

  test("an event past the floor edits straight away", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started"));
      h.advance(20_000);
      await h.service.observe(ev("review", "started"));
      expect(h.g.edits).toHaveLength(1);
      expect(h.g.edits[0]!.content).toContain("in review");
      expect(h.timers.pending()).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a terminal event bypasses the floor and drops the durable anchor", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started"));
      expect(Object.keys(h.readState().cards)).toEqual(["ticket-1"]);
      h.advance(1_000);
      await h.service.observe(ev("state:done", "passed", "in_review → done"));
      expect(h.g.edits).toHaveLength(1);
      expect(h.g.edits[0]!.content).toContain("done");
      expect(h.readState().cards).toEqual({});
    } finally {
      h.cleanup();
    }
  });

  test("a deleted card is recreated exactly once", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started"));
      h.g.failEdits(new DiscordUnknownMessageError("chan-1", "msg-1"));

      h.advance(20_000);
      await h.service.observe(ev("review", "started"));
      expect(h.g.posts).toHaveLength(2);

      h.advance(20_000);
      await h.service.observe(ev("implement:wedge", "failed", "silent"));
      expect(h.g.posts).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  test("any other edit failure folds into the next update", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started"));
      h.g.failEdits(new Error("boom"));
      h.advance(20_000);
      await h.service.observe(ev("review", "started"));
      expect(h.g.posts).toHaveLength(1);
      expect(h.g.edits).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a ticket with no channel gets no card", async () => {
    const h = harness({ channel: null });
    try {
      await h.service.observe(ev("implement", "started"));
      expect(h.g.posts).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a channel lookup that throws never rejects observe", async () => {
    const h = harness({ channelThrows: new Error("registry unreadable") });
    try {
      await h.service.observe(ev("implement", "started"));
      expect(h.g.posts).toHaveLength(0);
      expect(h.g.edits).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a restart edits the same card instead of posting a second one", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started"));
      expect(h.g.posts).toHaveLength(1);

      const restarted = h.make();
      await restarted.observe(ev("review", "started"));
      expect(h.g.posts).toHaveLength(1);
      expect(h.g.edits).toEqual([{ messageId: "msg-1", content: expect.stringContaining("in review") }]);
    } finally {
      h.cleanup();
    }
  });

  test("a gateway outage never rejects and leaves no anchor behind", async () => {
    const h = harness();
    try {
      h.g.failPosts(new Error("offline"));
      await h.service.observe(ev("implement", "started"));
      expect(h.g.posts).toHaveLength(0);

      h.g.failPosts(null);
      h.advance(20_000);
      await h.service.observe(ev("review", "started"));
      expect(h.g.posts).toHaveLength(1); // still no anchor to edit — it posts fresh
      expect(h.g.edits).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  // ── v7 run cards: the deploy receipt ────────────────────────────────────────────────────
  function runEv(stage: string, outcome: DispatchOutcome, message?: string): DispatchEvent {
    return {
      ts: TS,
      runId: "run-20260810-oauth",
      runRef: "run-20260810-oauth",
      branchRef: "beckett/run-oauth",
      stage,
      outcome,
      elapsedMs: 0,
      ...(message ? { message } : {}),
    };
  }

  test("run.deploy admission posts the deploy receipt immediately — no floor, no anchor yet", async () => {
    const h = harness();
    try {
      await h.service.observe(runEv("run:deploy", "started", "queued"));
      expect(h.g.posts).toHaveLength(1);
      expect(h.g.posts[0]!.content).toContain("queued");
      expect(h.g.posts[0]!.content).toContain("run-20260810-oauth");
    } finally {
      h.cleanup();
    }
  });

  test("the deploy-instant card reads 0/0 even with no specReader wired and no spec.md yet", async () => {
    // Before a worktree (and so a spec.md) exists, specReader has nothing to read — the deploy
    // receipt still promises "queued · 0/0" per the architecture doc, so this one event
    // synthesizes the placeholder rather than dropping the checklist segment.
    const h = harness();
    try {
      await h.service.observe(runEv("run:deploy", "started", "queued"));
      expect(h.g.posts[0]!.content).toContain("0/0 checked");
    } finally {
      h.cleanup();
    }
  });

  test("once a real specReader is wired, its result wins over the deploy-instant placeholder", async () => {
    const h = harness({ specReader: (id) => (id === "run-20260810-oauth" ? { done: 1, total: 4 } : null) });
    try {
      await h.service.observe(runEv("run:deploy", "started", "queued"));
      expect(h.g.posts[0]!.content).toContain("1/4 checked");
      expect(h.g.posts[0]!.content).not.toContain("0/0");
    } finally {
      h.cleanup();
    }
  });

  test("a wired specReader folds the run's live checklist progress into the card", async () => {
    const h = harness({ specReader: (id) => (id === "run-20260810-oauth" ? { done: 3, total: 7 } : null) });
    try {
      await h.service.observe(runEv("implement", "started", "worker wk_1 on claude"));
      expect(h.g.posts[0]!.content).toContain("3/7 checked");
    } finally {
      h.cleanup();
    }
  });

  test("no specReader wired (the pre-run-cards default) renders with no checklist segment", async () => {
    const h = harness();
    try {
      await h.service.observe(runEv("implement", "started", "worker wk_1 on claude"));
      expect(h.g.posts[0]!.content).not.toContain("checked");
    } finally {
      h.cleanup();
    }
  });

  test("a run reaching done renders terminal — shipped, checkmark, and the shipped URL", async () => {
    const h = harness();
    try {
      await h.service.observe(runEv("implement", "started"));
      h.advance(1_000);
      await h.service.observe(runEv("done", "passed", "https://github.com/o/gateway/pull/7"));
      expect(h.g.edits).toHaveLength(1);
      expect(h.g.edits[0]!.content).toContain("✓");
      expect(h.g.edits[0]!.content).toContain("shipped");
      expect(h.g.edits[0]!.content).toContain("https://github.com/o/gateway/pull/7");
      expect(h.readState().cards).toEqual({}); // terminal — the anchor is dropped like any other
    } finally {
      h.cleanup();
    }
  });
});

describe("boot sink gating (src/shell/main.ts's dispatchLiveSink wiring)", () => {
  // The sink must check the flag before forwarding, independent of whether the service itself
  // exists. A regression that drops the flag check (reverting to a bare service-truthy
  // null-check) fails here.
  test("shouldObserveRunCard requires both the service and runs.cards — flag off skips observe()", () => {
    expect(shouldObserveRunCard({}, true)).toBe(true);
    expect(shouldObserveRunCard({}, false)).toBe(false); // runs.cards=false: the spec's "flag off" case
    expect(shouldObserveRunCard(null, true)).toBe(false);
    expect(shouldObserveRunCard(null, false)).toBe(false);
  });

});
