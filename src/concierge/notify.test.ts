/**
 * Coverage for the closed agent loop's routing + dedup (Concierge.notify / frameRunUpdate). This is
 * the brittle judgment — which run transitions become a Discord ping, on which channel, exactly
 * once — so it's pinned here against an injected fake session rather than left to a live run.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import { createMemory } from "../memory/index.ts";
import { openLoop, settleLoop } from "../memory/loops.ts";
import { TaskStore } from "../task/store.ts";
import type { AmbientClock } from "./ambient.ts";
import type { Config } from "../types.ts";
import type { Run, RunStateChange } from "../run/types.ts";

const CHAN = "1097283746520174592";

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

/** A hand-cranked clock so a test can walk past the milestone dedupe window deliberately. */
class FakeClock implements AmbientClock {
  t = Date.parse("2026-07-23T12:00:00Z");
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  setTimeout(): unknown {
    return 0;
  }
  clearTimeout(): void {}
}

/** A Concierge wired to a fake session that just records the turns notify() feeds it. */
function harness(clock?: AmbientClock, tasks?: TaskStore) {
  const asks: string[] = [];
  const session = {
    ask: (m: string) => {
      asks.push(m);
      return Promise.resolve(""); // concierge "replies" via the CLI, so the return is unused
    },
  } as unknown as ConciergeSession;
  const gateway = {} as never; // notify never touches the gateway
  const concierge = new Concierge({ config, session, gateway, ...(clock ? { ambientClock: clock } : {}), ...(tasks ? { tasks } : {}) });
  return { concierge, asks };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-20260810-healthz",
    slug: "healthz",
    title: "Add healthz",
    prompt: "Add a /healthz endpoint.",
    channelId: CHAN,
    requesterId: null,
    taskRef: null,
    ultracode: false,
    cast: null,
    repo: null,
    state: "implementing",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    workspace: null,
    branch: "beckett/run-healthz",
    baseSha: null,
    sessionIds: {},
    sessionName: "beckett-run-healthz",
    reviewCycles: 0,
    continuations: 0,
    autoResumes: 0,
    prUrl: null,
    error: null,
    blocker: null,
    question: null,
    published: null,
    proof: null,
    landingMode: null,
    deps: [],
    files: [],
    ...overrides,
  };
}

function change(to: Run["state"], overrides: Partial<Run> = {}, from: Run["state"] | null = "implementing"): RunStateChange {
  return { kind: "state_changed", run: run({ state: to, ...overrides }), from, to };
}

test("relays a terminal milestone as one turn carrying the right --channel", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("failed", { error: "the implement worker exited with an error." }));
  await new Promise((r) => setTimeout(r, 0)); // notify frames + batches on a microtask (issue #25)
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN}`);
  expect(asks[0]).toContain("The run failed.");
  expect(asks[0]).toContain("the implement worker exited with an error.");
});

test("incoming email is delivered through the automated-update turn queue with readable fields", async () => {
  const { concierge, asks } = harness();
  await concierge.notifyIncomingEmail({
    from: "sender@example.com",
    subject: "Please review",
    snippet: "The short body preview.",
    messageId: "agentmail-message-1",
  });
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("SYSTEM (incoming email");
  expect(asks[0]).toContain("sender@example.com");
  expect(asks[0]).toContain("Please review");
  expect(asks[0]).toContain("The short body preview.");
  expect(asks[0]).toContain("agentmail-message-1");
  expect(asks[0]).toContain("beckett mail read");
});

test("incoming email sees a same-subject loop closed minutes earlier", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-mail-loop-"));
  try {
    const memory = createMemory({
      memoryDir: dir,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      git: false,
    });
    await openLoop(memory, {
      name: "github-2fa-enrollment",
      kind: "commitment",
      due: "2026-07-27",
      source: "browser-agent",
      description: "Authorize GitHub 2FA enrollment",
    });
    // Settlement uses today's date; an email moments later must still receive this context.
    await settleLoop(memory, "github-2fa-enrollment", "done", "Enrollment completed");

    const asks: string[] = [];
    const session = { ask: (message: string) => (asks.push(message), Promise.resolve("")) } as unknown as ConciergeSession;
    const concierge = new Concierge({ config, session, gateway: {} as never, memory });
    await concierge.notifyIncomingEmail({
      from: "github@example.com",
      subject: "Authorize GitHub 2FA enrollment",
      snippet: "Approve your enrollment.",
      messageId: "github-2fa-mail",
    });

    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain("<open-loops>");
    expect(asks[0]).toContain("CLOSED");
    expect(asks[0]).toContain("Authorize GitHub 2FA enrollment");
    expect(asks[0]).toContain("external, untrusted content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routine.self frames a SYSTEM self-directed-sweep turn on the same askUpdate lane (issue #26)", async () => {
  const { concierge, asks } = harness();
  const res = await concierge.onBusRequest({
    cmd: "routine.self",
    args: { routineId: "morning-sweep", prompt: "look over the board and nudge anything stalled", channelId: CHAN },
  });
  expect(res.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 0)); // askUpdate is fire-and-forget onto the system session
  expect(asks.length).toBe(1);
  // Framed as SYSTEM, a scheduled self-directed sweep, and explicitly NOT a user message.
  expect(asks[0]).toContain("SYSTEM (scheduled self-directed sweep");
  expect(asks[0]).toContain("NOT a message from a user");
  // Carries the routine id, the origin channel, and its own prompt.
  expect(asks[0]).toContain("morning-sweep");
  expect(asks[0]).toContain("look over the board and nudge anything stalled");
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN}`);
  // Permission to stay silent if there's nothing worth saying.
  expect(asks[0]).toContain("do nothing");
});

test("routine.self refuses without routineId/prompt/channelId (no half-formed self turn)", async () => {
  const { concierge, asks } = harness();
  const res = await concierge.onBusRequest({ cmd: "routine.self", args: { prompt: "x", channelId: CHAN } });
  expect(res.ok).toBe(false);
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(0);
});

test("mid-flight churn (implement → review) never costs a turn", () => {
  const { concierge, asks } = harness();
  // The person already has an ack; the terminal ping lands when the work finishes. This
  // intermediate advance is exactly the "okay, I did the thing" half of a back-to-back pair.
  concierge.notify(change("reviewing"));
  concierge.notify(change("publishing", {}, "reviewing"));
  concierge.notify(change("queued", {}, null));
  expect(asks.length).toBe(0);
});

test("a parked run always speaks — nothing will re-staff it, so silence would strand the work", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("parked", { error: "review found issues, and this is rework cycle 2/2." }));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("parked for a human");
  expect(asks[0]).toContain("rework cycle 2/2");
});

test("surfaces `done` and carries the shipped PR link so the person can click through", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("done", { prUrl: "https://github.com/0xbeckett/healthz/pull/3" }, "publishing"));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`--channel ${CHAN}`);
  expect(asks[0]?.toLowerCase()).toContain("done");
  expect(asks[0]).toContain("https://github.com/0xbeckett/healthz/pull/3");
});

test("a done run with no PR still pings, without inventing a link", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("done", {}, "publishing"));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]?.toLowerCase()).toContain("done");
  expect(asks[0]).not.toContain("Artifact:");
});

test("boot recovery (from: null) tells the user the run is being re-staffed (issue #21)", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("implementing", {}, null));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("restarted");
});

test("a carded task's cancellation is card-only churn, but its done milestone still fires (#104)", async () => {
  // A task that owns a self-editing card shows cancelled/re-staff as machine state on the card, so
  // those routine transitions no longer cost a separate message. A genuine milestone (done) still
  // goes out in Beckett's voice — the card replaces churn, not the speaking-when-it-matters.
  const dir = mkdtempSync(join(tmpdir(), "beckett-notify-card-"));
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.createTask({ title: "Carded", originChannelId: CHAN });
  await store.setCard(1, { channelId: CHAN, messageId: "card-1" });
  const { concierge, asks } = harness(undefined, store);

  concierge.notify(change("cancelled", { taskRef: "#1.1" }));
  concierge.notify(change("implementing", { taskRef: "#1.1" }, null));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(0); // both are card-only churn — no plain message

  concierge.notify(change("done", { taskRef: "#1.1" }, "publishing"));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1); // the milestone still speaks
  expect(asks[0]!.toLowerCase()).toContain("done");
  rmSync(dir, { recursive: true, force: true });
});

test("a branch's persisted --ping list rides every automated update as a --ping flag (issue #10)", async () => {
  const RO = "1151230208783945818";
  const dir = mkdtempSync(join(tmpdir(), "beckett-notify-ping-"));
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.createTask({ title: "Add healthz", originChannelId: CHAN, pings: [RO] });
  const { concierge, asks } = harness(undefined, store);

  concierge.notify(change("failed", { taskRef: "#1.1" }));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN} --ping ${RO} "<your message>"`);
  rmSync(dir, { recursive: true, force: true });
});

test("a branch's own pings (set at task start) override the task's default in the suggested reply", async () => {
  const RO = "1151230208783945818";
  const ALICE = "222222222222222222";
  const dir = mkdtempSync(join(tmpdir(), "beckett-notify-ping-override-"));
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.createTask({ title: "Add healthz", originChannelId: CHAN, pings: [RO] });
  await store.setPings("1.1", [ALICE]);
  const { concierge, asks } = harness(undefined, store);

  concierge.notify(change("failed", { taskRef: "#1.1" }));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`--ping ${ALICE}`);
  expect(asks[0]).not.toContain(`--ping ${RO}`);
  rmSync(dir, { recursive: true, force: true });
});

test("a task/branch with no pings suggests the plain reply command, unchanged", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("failed"));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain(`beckett discord reply --channel ${CHAN} "<your message>"`);
  expect(asks[0]).not.toContain("--ping");
});

test("a card-less run still gets the plain cancellation ping", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("cancelled"));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("cancelled");
});

test("a cancel notice never claims a crash, a park, or a resume remedy — a cancel is final", async () => {
  const { concierge, asks } = harness();
  // `error` here is the cancel path's default reason string (no `--reason` given) — it must not
  // be echoed back as though it were a meaningful reason, and none of the parked/crash vocabulary
  // belongs on a cancel notice regardless of what a raced worker death happened to report.
  concierge.notify(change("cancelled", { error: "cancelled" }));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("The run was cancelled.");
  expect(asks[0]).not.toContain("parked");
  expect(asks[0]).not.toContain("failure class");
  expect(asks[0]).not.toContain("beckett task resume");
  // The default reason ("cancelled") is not a real reason — don't repeat it as though it were one.
  expect(asks[0]!.match(/cancelled/gi)?.length).toBe(1);
});

test("a cancel notice includes the human's real reason when one was given", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("cancelled", { error: "duplicate of another run" }));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]).toContain("The run was cancelled.");
  expect(asks[0]).toContain("duplicate of another run");
  expect(asks[0]).not.toContain("beckett task resume");
});

test("drops (does not surface) an update for a run with no origin channel", () => {
  const { concierge, asks } = harness();
  concierge.notify(change("failed", { channelId: null }));
  expect(asks.length).toBe(0);
});

test("a full lifecycle batch yields exactly one ping per real milestone", async () => {
  const { concierge, asks } = harness();
  const events: RunStateChange[] = [
    change("implementing", {}, "queued"),
    change("reviewing"),
    change("publishing", {}, "reviewing"),
    change("done", { prUrl: "https://github.com/0xbeckett/healthz/pull/3" }, "publishing"),
  ];
  concierge.notify(events);
  await new Promise((r) => setTimeout(r, 0));
  // ONE combined turn for the whole batch (issue #25): only the terminal transition speaks.
  expect(asks.length).toBe(1);
  expect(asks[0]!.toLowerCase()).toContain("done");
  expect(asks[0]).toContain(`--channel ${CHAN}`);
});

// ── notify re-fire idempotency (the done-update loop) ──────────────────────────────────────
// A `done` event can be re-delivered to notify() — a boot re-admission, or an ambiguous
// `beckett discord reply` ack that upstream retries mistake for "not delivered". The dispatch
// dedupes per (run, state) so one milestone is one turn even when it arrives repeatedly; a real,
// distinct milestone still fires.

test("a re-delivered done event notifies at most once (ambiguous-ack re-fire loop)", async () => {
  const { concierge, asks } = harness();
  const done = change("done", {}, "publishing");
  // Four back-to-back deliveries of the SAME done milestone — exactly the observed 4x re-fire.
  concierge.notify(done);
  concierge.notify(done);
  concierge.notify(done);
  concierge.notify(done);
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  expect(asks[0]?.toLowerCase()).toContain("done");
});

test("dedupe is per-run — two different runs reaching done each fire once", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("done", { id: "run-A" }, "publishing"));
  concierge.notify(change("done", { id: "run-A" }, "publishing"));
  concierge.notify(change("done", { id: "run-B" }, "publishing"));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(2); // one per distinct run, re-delivery of A suppressed
});

test("a genuinely-new milestone on the same run still fires after a done ping", async () => {
  const { concierge, asks } = harness();
  concierge.notify(change("done", {}, "publishing"));
  await new Promise((r) => setTimeout(r, 0));
  // A different STATE on the same run — a distinct key, so it is not suppressed.
  concierge.notify(change("parked", { error: "a human took it back" }, "done"));
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(2);
});

test("outside the dedupe window a re-entry fires again (a second park after human feedback)", async () => {
  const clock = new FakeClock();
  const { concierge, asks } = harness(clock);
  const parked = change("parked", { error: "held for review" });
  concierge.notify(parked);
  await new Promise((r) => setTimeout(r, 0));
  concierge.notify(parked); // immediate re-delivery — suppressed
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(1);
  clock.advance(6 * 60_000); // past the 5-minute window: a real second park is legitimate
  concierge.notify(parked);
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.length).toBe(2);
});
