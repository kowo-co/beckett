import { describe, expect, test } from "bun:test";
import { DispatchDigest, describeDispatchEvent } from "./digest.ts";
import type { DispatchEvent, DispatchOutcome } from "./events.ts";

let clock = Date.parse("2026-08-04T21:34:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();

function ev(
  stage: string,
  outcome: DispatchOutcome,
  extra: { message?: string; error?: string; ts?: string; ref?: string; id?: string } = {},
): DispatchEvent {
  return {
    ts: extra.ts ?? at(clock),
    runId: extra.id ?? "ticket-1",
    runRef: extra.ref ?? "#2.1",
    branchRef: "beckett/task-2-1",
    stage,
    outcome,
    elapsedMs: 1_324_000,
    ...(extra.message ? { message: extra.message } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

function digest(overrides = {}) {
  let now = clock;
  const d = new DispatchDigest({ now: () => now, timeZone: "America/Los_Angeles", ...overrides });
  return { d, advance: (ms: number) => (now += ms) };
}

describe("describeDispatchEvent", () => {
  test("never emits anything shaped like a raw trace row", () => {
    const events: DispatchEvent[] = [
      ev("implement", "started", { message: "worker wk_8220548c on claude" }),
      ev("implement", "failed", { message: "worker exited with error", error: "TypeError: x is not a function" }),
      ev("implement", "interrupted", { message: "worker exited with error (stopped by a daemon restart)" }),
      ev("state:in_review", "info", { message: "in_progress → in_review" }),
      ev("worktree", "failed", { error: "fatal: could not create work tree" }),
      ev("publish", "failed", { message: "push/publish failed", error: "remote rejected" }),
      ev("pr", "passed", { message: "https://github.com/kowo-co/beckett/pull/12" }),
      ev("some-future-stage", "info", { message: "who knows" }),
    ];
    for (const event of events) {
      const note = describeDispatchEvent(event);
      if (!note) continue;
      expect(note.text).not.toContain("·");
      expect(note.text).not.toMatch(/\b(FAILED|STARTED|PASSED|HELD|INFO)\b/);
      expect(note.text).not.toMatch(/\bwk_[0-9a-f]+/); // no worker ids
      expect(note.text).not.toMatch(/\d{2}:\d{2}:\d{2}/); // no raw UTC clock
    }
  });

  test("the run card's activity blurb is card decoration, not digest news", () => {
    // It repaints every few seconds while a worker runs; relaying it would post a Discord
    // sentence per tool burst.
    expect(describeDispatchEvent(ev("activity", "info", { message: "editing index.html" }))).toBeNull();
  });

  test("a worker killed by a restart reads as a restart, with no error text or alarm", () => {
    // The real 04:56Z sample: a killed worker whose "error" was its own opening narration.
    const note = describeDispatchEvent(
      ev("implement", "interrupted", {
        message: "worker exited with error (stopped by a daemon restart)",
        error: "I'll start by getting oriented in the repo and understanding the existing CLI structure.",
      }),
    );
    expect(note?.alert).toBeFalsy();
    expect(note?.text).toBe("a restart stopped the implementation worker mid-run — it gets picked back up");
    expect(note?.text).not.toContain("getting oriented");
  });

  test("a no-op state transition says nothing at all", () => {
    expect(describeDispatchEvent(ev("state:in_review", "info", { message: "in_review → in_review" }))).toBeNull();
    expect(describeDispatchEvent(ev("state:in_review", "info", { message: "in_review -> in_review" }))).toBeNull();
    expect(describeDispatchEvent(ev("state:in_review", "info", { message: "in_progress → in_review" }))?.text)
      .toBe("moved to review");
  });

  test("plumbing is invisible until it breaks", () => {
    expect(describeDispatchEvent(ev("worktree", "started", { message: "creating isolated worktree" }))).toBeNull();
    expect(describeDispatchEvent(ev("worktree", "passed", { message: "/home/beckett/.beckett/worktrees/4" }))).toBeNull();
    expect(describeDispatchEvent(ev("repo", "passed", { message: "repository ready" }))).toBeNull();
    expect(describeDispatchEvent(ev("implement:staff", "started", { message: "staffing admitted" }))).toBeNull();
    const broken = describeDispatchEvent(ev("repo", "failed", { error: "fatal: repository not found" }));
    expect(broken).toEqual({ text: "couldn't set up the repository — fatal: repository not found", alert: true });
  });

  test("a genuine failure keeps the real error text and is marked as one", () => {
    const note = describeDispatchEvent(
      ev("implement", "failed", { message: "worker exited with error", error: "TypeError: cfg.harness is not a function" }),
    );
    expect(note?.alert).toBe(true);
    expect(note?.text).toBe("the implementation worker failed — TypeError: cfg.harness is not a function");
  });

  test("speaks in ticket words, not stage/worker ids", () => {
    expect(describeDispatchEvent(ev("implement", "started", { message: "worker wk_8220548c on claude" }))?.text)
      .toBe("a worker started the implementation (claude)");
    expect(describeDispatchEvent(ev("implement:staff", "held", { message: "queued at concurrency cap" }))?.text)
      .toBe("waiting for a free worker slot");
    expect(describeDispatchEvent(ev("implement:wedge", "failed", { message: "worker silent for 22m; status check sent", error: "silent worker alert" }))).toEqual({
      text: "the implementation worker has been quiet for 22m — sent it a status check",
    });
    expect(describeDispatchEvent(ev("implement", "held", { message: "ticket is cancelled; not retrying" }))?.text)
      .toBe("not staffing a worker — the ticket is cancelled");
    expect(describeDispatchEvent(ev("state:done", "passed", { message: "in_review → done" })))
      .toEqual({ text: "finished — moved to done", closes: true });
  });

  test("a restart-interrupted worker that cannot resume is a restart, not a failure", () => {
    const note = describeDispatchEvent(
      ev("implement", "held", { message: "interrupted mid-implement by a restart; resuming its harness session failed — parked in todo" }),
    );
    expect(note?.alert).toBeFalsy();
    expect(note?.text).toContain("a restart interrupted this");
  });
});

describe("DispatchDigest", () => {
  test("coalesces a ticket's progress into one edited message", () => {
    const { d, advance } = digest();
    const first = d.observe(ev("implement", "started", { message: "worker wk_1 on claude" }));
    expect(first?.fresh).toBe(true);
    advance(60_000);
    const second = d.observe(ev("state:in_review", "info", { message: "in_progress → in_review" }));
    expect(second?.fresh).toBe(false); // edits the same message
    expect(second?.key).toBe(first?.key);
    expect(second?.text).toContain("a worker started the implementation (claude)");
    expect(second?.text).toContain("moved to review");
    expect(second?.text).toContain("**#2.1**");
    // Local times, not raw UTC seconds.
    expect(second?.text).toMatch(/• \d{1,2}:\d{2} (AM|PM) — /);
    expect(second?.text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test("every digest points at the full trace", () => {
    const { d } = digest();
    expect(d.observe(ev("implement", "started", { message: "worker wk_1 on claude" }))?.text)
      .toContain('beckett task trace "#2.1"');
  });

  test("suppresses the duplicate replay batch a restart produces", () => {
    const { d, advance } = digest();
    const batch = () => [
      d.observe(ev("restart-restaff", "started", { message: "recovering interrupted worker" })),
      d.observe(ev("restart-restaff", "passed", { message: "restart recovery complete" })),
      d.observe(ev("implement:staff", "started", { message: "staffing admitted" })),
      d.observe(ev("worktree", "started", { message: "reusing isolated worktree" })),
      d.observe(ev("repo", "passed", { message: "repository ready (cloned or initialized)" })),
      d.observe(ev("implement", "started", { message: "worker wk_2 on claude" })),
    ];
    const said = batch().filter(Boolean);
    expect(said).toHaveLength(2); // the restart line + the worker line; the rest is plumbing
    advance(20_000); // the observed replay: the same batch again, 20s later
    expect(batch().filter(Boolean)).toHaveLength(0);
  });

  test("a genuine failure posts fresh so it can't be missed, carrying recent context", () => {
    const { d, advance } = digest();
    d.observe(ev("implement", "started", { message: "worker wk_1 on claude" }));
    advance(30_000);
    const alert = d.observe(ev("implement", "failed", { message: "worker exited with error", error: "bun test exited 1" }));
    expect(alert?.alert).toBe(true);
    expect(alert?.fresh).toBe(true);
    expect(alert?.text).toContain("⚠️");
    expect(alert?.text).toContain("bun test exited 1");
    expect(alert?.text).toContain("a worker started the implementation"); // context carried over
  });

  test("a restart is never posted as a failure", () => {
    const { d } = digest();
    const update = d.observe(ev("implement", "interrupted", { message: "worker exited with error (stopped by a daemon restart)", error: "I'll start by getting oriented in the repo." }));
    expect(update?.alert).toBe(false);
    expect(update?.fresh).toBe(true); // first line of the episode
    expect(update?.text).not.toContain("⚠️");
    expect(update?.text).not.toContain("getting oriented");
  });

  test("separate tickets get separate digests", () => {
    const { d } = digest();
    const a = d.observe(ev("implement", "started", { message: "worker wk_1 on claude" }));
    const b = d.observe(ev("implement", "started", { message: "worker wk_2 on codex", id: "ticket-2", ref: "#3" }));
    expect(a?.key).not.toBe(b?.key);
    expect(b?.text).toContain("**#3**");
    expect(b?.text).not.toContain("#2.1");
  });

  test("a closed ticket's next activity starts a new message", () => {
    const { d, advance } = digest();
    d.observe(ev("implement", "started", { message: "worker wk_1 on claude" }));
    advance(60_000);
    expect(d.observe(ev("state:done", "passed", { message: "in_review → done" }))?.fresh).toBe(false);
    advance(60_000);
    expect(d.observe(ev("state:in_progress", "info", { message: "todo → in_progress" }))?.fresh).toBe(true);
  });

  test("a long run stays inside Discord's single-message limit and says what it elided", () => {
    const { d, advance } = digest({ maxLines: 3 });
    let last = d.observe(ev("implement", "started", { message: "worker wk_1 on claude" }));
    for (const state of ["in_review", "in_progress", "in_review", "done"]) {
      advance(200_000);
      last = d.observe(ev(`state:${state}`, "info", { message: `x → ${state}` })) ?? last;
    }
    expect(last!.text.length).toBeLessThan(2000);
    expect(last!.text).toContain("earlier step");
    expect(last!.text.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(3);
  });

  test("an idle ticket's next update opens a fresh message rather than editing a scrolled-away one", () => {
    const { d, advance } = digest({ sessionIdleMs: 60_000 });
    d.observe(ev("implement", "started", { message: "worker wk_1 on claude" }));
    advance(120_000);
    const later = d.observe(ev("state:in_review", "info", { message: "in_progress → in_review" }));
    expect(later?.fresh).toBe(true);
    expect(later?.text).not.toContain("a worker started"); // a genuinely new episode
  });
});
