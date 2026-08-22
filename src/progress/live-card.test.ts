import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordCard } from "../types.ts";
import { DiscordUnknownMessageError, type DiscordGateway } from "../discord/gateway.ts";
import type { DispatchEvent, DispatchOutcome } from "../dispatch/events.ts";
import { createLiveProgressCardService } from "./live-card.ts";

const TS = "2026-08-22T21:34:00.000Z";

function ev(stage: string, outcome: DispatchOutcome, message?: string, error?: string): DispatchEvent {
  return {
    ts: TS,
    runId: "run-1",
    runRef: "run-1",
    branchRef: "beckett/run-1",
    stage,
    outcome,
    elapsedMs: 0,
    ...(message ? { message } : {}),
    ...(error ? { error } : {}),
  };
}

function fakeGateway() {
  const posts: { channelId: string; card?: DiscordCard }[] = [];
  const edits: { channelId: string; messageId: string; card?: DiscordCard }[] = [];
  let postFails: Error | null = null;
  let editFails: Error | null = null;
  let n = 0;
  const gateway = {
    async post(channelId: string, _content: string, opts?: { card?: DiscordCard }) {
      if (postFails) throw postFails;
      posts.push({ channelId, card: opts?.card });
      return `msg-${++n}`;
    },
    async editMessage(channelId: string, messageId: string, payload: { card?: DiscordCard }) {
      if (editFails) throw editFails;
      edits.push({ channelId, messageId, card: payload.card });
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

/** A manual scheduler: nothing fires until the test says so — mirrors `./cards.test.ts`. */
function manualScheduler() {
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  return {
    timers,
    schedule: (fn: () => void, _ms: number) => {
      const timer = { fn, cancelled: false };
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

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;

function cardText(card: DiscordCard | undefined): string {
  if (!card) return "";
  return card.blocks
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");
}

function harness(
  overrides: {
    channel?: string | null;
    journal?: Record<string, string[]>;
    minEditIntervalMs?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-live-card-"));
  const statePath = join(dir, "live-progress-cards.json");
  const g = fakeGateway();
  const timers = manualScheduler();
  let clock = 1_000_000;
  const journal = overrides.journal ?? {};
  const service = createLiveProgressCardService({
    gateway: g.gateway,
    statePath,
    resolveChannel: () => (overrides.channel === undefined ? "live-chan" : overrides.channel),
    readJournalLines: (runId) => journal[runId] ?? [],
    logger: quiet,
    now: () => clock,
    schedule: timers.schedule,
    ...(overrides.minEditIntervalMs !== undefined ? { minEditIntervalMs: overrides.minEditIntervalMs } : {}),
  });
  return {
    dir,
    g,
    timers,
    service,
    journal,
    advance: (ms: number) => (clock += ms),
    readState: () => JSON.parse(readFileSync(statePath, "utf8")) as { version: number; cards: Record<string, unknown> },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("LiveProgressCardService coalescing", () => {
  test("posts once, then coalesces a fast follow-up into one trailing edit", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started", "worker wk_1 on claude"));
      expect(h.g.posts).toHaveLength(1);
      expect(h.g.posts[0]!.channelId).toBe("live-chan");

      h.advance(1_000); // still inside the 5s default floor
      await h.service.observe(ev("implement:wedge", "failed", "worker silent for 6m"));
      expect(h.g.edits).toHaveLength(0);
      expect(h.timers.pending()).toHaveLength(1);

      h.timers.fire();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.g.edits).toHaveLength(1);
      expect(cardText(h.g.edits[0]!.card)).toContain("stalled");
    } finally {
      h.cleanup();
    }
  });

  test("an event past the 5s floor edits immediately, no timer needed", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started"));
      h.advance(5_000);
      await h.service.observe(ev("review", "started"));
      expect(h.g.edits).toHaveLength(1);
      expect(h.timers.pending()).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("the coalescing floor is configurable", async () => {
    const h = harness({ minEditIntervalMs: 30_000 });
    try {
      await h.service.observe(ev("implement", "started"));
      h.advance(10_000); // inside the wider 30s floor
      await h.service.observe(ev("review", "started"));
      expect(h.g.edits).toHaveLength(0);
      expect(h.timers.pending()).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test("a Discord failure skips the tick instead of retrying in a loop", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started"));
      h.g.failEdits(new Error("503 service unavailable"));
      h.advance(5_000);
      await h.service.observe(ev("review", "started"));
      expect(h.g.edits).toHaveLength(0); // the failed edit never retried inline
      expect(h.timers.pending()).toHaveLength(0); // and nothing was queued to retry it either
    } finally {
      h.cleanup();
    }
  });
});

describe("LiveProgressCardService lifecycle", () => {
  test("the terminal window is included while the run is active", async () => {
    const h = harness({ journal: { "run-1": ["· Bash  bun test"] } });
    try {
      await h.service.observe(ev("implement", "started"));
      expect(cardText(h.g.posts[0]!.card)).toContain("bun test");
      expect(cardText(h.g.posts[0]!.card)).toContain("updates in place");
    } finally {
      h.cleanup();
    }
  });

  test("a terminal event delivers one last render carrying the journal's final lines, then stops", async () => {
    const h = harness({ journal: { "run-1": ["· Bash  bun test"] } });
    try {
      await h.service.observe(ev("implement", "started"));
      h.advance(1_000);
      h.journal["run-1"] = ["· Bash  bun test", "✓ implement passed"];
      await h.service.observe(ev("state:done", "passed", "in_review → done"));
      expect(h.g.edits).toHaveLength(1);
      const finalText = cardText(h.g.edits[0]!.card);
      expect(finalText).toContain("implement passed");
      expect(finalText).toContain("stopped");
      expect(h.readState().cards).toEqual({}); // anchor dropped — no further edits will ever land
    } finally {
      h.cleanup();
    }
  });

  test("a plumbing event after termination changes nothing — the window stays stopped", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("state:done", "passed", "in_review → done"));
      expect(h.g.posts).toHaveLength(1);
      // A late-arriving no-op event for the same runId after termination changes nothing.
      await h.service.observe(ev("preview", "info"));
      expect(h.g.posts).toHaveLength(1);
      expect(h.g.edits).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a re-staffed run reusing the same id posts a fresh card rather than editing the retired one", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("state:done", "passed", "in_review → done"));
      expect(h.g.posts).toHaveLength(1);
      expect(h.readState().cards).toEqual({}); // the finished card's anchor was dropped
      await h.service.observe(ev("implement", "started"));
      expect(h.g.posts).toHaveLength(2); // a NEW post, not an edit of the retired card
      expect(h.g.edits).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a run with no channel configured gets no card, and observe never rejects", async () => {
    const h = harness({ channel: null });
    try {
      await expect(h.service.observe(ev("implement", "started"))).resolves.toBeUndefined();
      expect(h.g.posts).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("a deleted card is reposted exactly once", async () => {
    const h = harness();
    try {
      await h.service.observe(ev("implement", "started"));
      h.g.failEdits(new DiscordUnknownMessageError("live-chan", "msg-1"));
      h.advance(5_000);
      await h.service.observe(ev("review", "started"));
      expect(h.g.posts).toHaveLength(2); // the replacement
    } finally {
      h.cleanup();
    }
  });
});
