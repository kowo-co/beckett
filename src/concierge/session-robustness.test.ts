/**
 * Issue #24 — session lifecycle robustness. Pins the four fixes:
 *   1. restart persistence (session id + handoff survive a deploy; unresumable → seeded fresh)
 *   2. cross-turn contamination (a superseded child's output/exit can't touch the current turn)
 *   3. reply-claim correlation (CLI replies claim the turn EXECUTING now, not a shared slot)
 *   4. a mention behind a busy session is INTERRUPT-driven, never queue-narrated (no ack bubble)
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Concierge,
  ConciergeSession,
  describeToolUse,
  isLivenessEvent,
  timedOutTurnLine,
  HARD_TURN_TIMEOUT_MS,
  TURN_ABSOLUTE_CEILING_MS,
  TURN_SILENCE_MS,
} from "./index.ts";
import type { Config, IncomingMessage } from "../types.ts";
import type { DiscordGateway } from "../discord/gateway.ts";

const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {}, harness: { claude: { bin: "claude", extra_flags: [] } } } as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempBeckettDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-session-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  return dir;
}

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

/** The private surface these tests reach into. */
interface SessionGuts {
  sessionId: string;
  lastHandoff: string;
  lastLaunchWasResume: boolean;
  initSeen: boolean;
  freshNextLaunch: boolean;
  seedPending: string | null;
  child: unknown;
  pending: { parts: string[] } | null;
  stopped: boolean;
  consecutiveCrashes: number;
  persistSessionState(): void;
  loadSessionState(): { sessionId: string; handoff: string } | null;
  consumeSeed(message: unknown): unknown;
  handleLine(line: string, from: unknown): void;
  onTurnTimeout(timer: ReturnType<typeof setTimeout>): void;
  onExit(code: number, exited: unknown): Promise<void>;
}

function makeSession(onCrashLoop?: (info: { count: number; code: number }) => void): SessionGuts {
  return new ConciergeSession({ config, logger: quietLog, onCrashLoop }) as unknown as SessionGuts;
}

// ── 1. restart persistence ──────────────────────────────────────────────────────────────

test("session id + handoff persist and load across instances (deploys keep the conversation)", () => {
  tempBeckettDir();
  const a = makeSession();
  a.sessionId = "session-abc";
  a.lastHandoff = "mid-thread with jason about the healthz ticket";
  a.persistSessionState();

  const b = makeSession();
  const loaded = b.loadSessionState();
  expect(loaded).toEqual({ sessionId: "session-abc", handoff: "mid-thread with jason about the healthz ticket" });
});

test("a resume that dies before init falls back to a FRESH session seeded with the handoff", async () => {
  tempBeckettDir();
  const s = makeSession();
  const fakeChild = { kill() {} };
  s.child = fakeChild as never;
  s.sessionId = "dead-session";
  s.lastHandoff = "we were renaming the deploy command";
  s.lastLaunchWasResume = true;
  s.initSeen = false;

  await s.onExit(1, fakeChild);

  expect(s.sessionId).not.toBe("dead-session");
  expect(s.freshNextLaunch).toBe(true);
  expect(s.seedPending).toBe("we were renaming the deploy command");
  // The seed folds into the head of the next turn.
  const out = s.consumeSeed("hey, where were we?") as string;
  expect(out).toContain("we were renaming the deploy command");
  expect(out).toContain("hey, where were we?");
  expect(s.seedPending).toBeNull(); // consumed once
});

// ── issue #98: re-drive the in-flight turn on the seeded fresh session ─────────────────────

/** The private surface the issue-#98 re-drive tests script. */
interface RedriveGuts {
  sessionId: string;
  lastHandoff: string;
  child: unknown;
  freshNextLaunch: boolean;
  initSeen: boolean;
  lastLaunchWasResume: boolean;
  consecutiveCrashes: number;
  launch(isResume: boolean): Promise<void>;
  writeUserLine(content: unknown): void;
  handleLine(line: string, from: unknown): void;
  runTurn(message: unknown, meta?: unknown): Promise<unknown>;
}

/**
 * Wire a scripted claude harness onto a real ConciergeSession: each `launch` records the attempt
 * and installs a fresh fake child; each `writeUserLine` fires that attempt's `script(child)` on a
 * microtask (so the pending turn is already registered). This drives the ACTUAL runTurn/driveTurn/
 * onResult/onExit machinery — only the subprocess is faked.
 */
function scriptHarness(
  s: RedriveGuts,
  script: (attempt: number, child: { kill(): void }, s: RedriveGuts) => void,
): { launches: boolean[]; writes: unknown[] } {
  const launches: boolean[] = [];
  const writes: unknown[] = [];
  s.child = null;
  s.launch = async (isResume: boolean) => {
    s.initSeen = false;
    s.lastLaunchWasResume = isResume;
    s.child = { kill() {} } as unknown;
    launches.push(isResume);
  };
  s.writeUserLine = (content: unknown) => {
    writes.push(content);
    const attempt = launches.length;
    const child = s.child as { kill(): void };
    queueMicrotask(() => script(attempt, child, s));
  };
  return { launches, writes };
}

test("issue #98: an unresumable resume re-drives the SAME turn on the seeded fresh session", async () => {
  tempBeckettDir();
  const s = makeSession() as unknown as RedriveGuts;
  s.sessionId = "dead-session";
  s.lastHandoff = "we were mid-thread about the deploy rename";

  const { launches, writes } = scriptHarness(s, (attempt, child, sess) => {
    if (attempt === 1) {
      // The resumed transcript is gone: a bare error result, then the process exits before init.
      sess.handleLine(JSON.stringify({ type: "result", subtype: "error_during_execution" }), child);
      void (sess as unknown as { onExit(c: number, x: unknown): Promise<void> }).onExit(1, child);
    } else {
      // The seeded fresh session inits and answers normally.
      sess.handleLine(JSON.stringify({ type: "system", subtype: "init" }), child);
      sess.handleLine(
        JSON.stringify({ type: "result", structured_output: { decision: "send", voice_check: "", message: "ok, here's where we were" } }),
        child,
      );
    }
  });

  const output = await s.runTurn("hey, where were we?");

  // The turn produced a real delivery output instead of being dropped / suppressed.
  expect(output).toEqual({ decision: "send", message: "ok, here's where we were" });
  // Exactly one re-drive: resume attempt, then one fresh attempt — never a loop.
  expect(launches).toEqual([true, false]);
  // The fresh session id was minted and the retry rode the seeded handoff note.
  expect(s.sessionId).not.toBe("dead-session");
  expect(writes[1]).toContain("we were mid-thread about the deploy rename");
  // The transient crash was counted then cleared by the successful turn — no lingering alarm.
  expect(s.consecutiveCrashes).toBe(0);
});

test("issue #98: a genuinely broken harness fails loudly after one re-drive (never loops)", async () => {
  tempBeckettDir();
  const s = makeSession() as unknown as RedriveGuts;
  s.sessionId = "dead-session";
  s.lastHandoff = "handoff";

  const { launches } = scriptHarness(s, (_attempt, child, sess) => {
    // Every launch dies before init — the resume AND the fresh fallback.
    sess.handleLine(JSON.stringify({ type: "result", subtype: "error" }), child);
    void (sess as unknown as { onExit(c: number, x: unknown): Promise<void> }).onExit(1, child);
  });

  // The retry is bounded: the second (fresh) death is not retried — it surfaces as an error.
  await expect(s.runTurn("q")).rejects.toThrow();
  expect(launches).toEqual([true, false]);
  // Both deaths counted toward crash-loop detection — the existing alarm path is unaffected.
  expect(s.consecutiveCrashes).toBe(2);
});

// ── 2. superseded-child isolation ───────────────────────────────────────────────────────

test("output from a superseded child never touches the current turn", () => {
  tempBeckettDir();
  const s = makeSession();
  const oldChild = {};
  const newChild = {};
  s.child = newChild as never;
  s.pending = { parts: [] };

  const staleLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "tail of the PREVIOUS answer" }] },
  });
  s.handleLine(staleLine, oldChild); // late output from an explicitly recycled child
  expect(s.pending!.parts).toHaveLength(0);

  s.handleLine(staleLine.replace("PREVIOUS", "CURRENT"), newChild);
  expect(s.pending!.parts).toEqual(["tail of the CURRENT answer"]);
});

test("a soft timeout keeps the child alive and delivers its late real result", () => {
  const s = makeSession() as unknown as {
    child: unknown;
    pending: {
      parts: string[];
      timer: ReturnType<typeof setTimeout>;
      timedOut: boolean;
      resolve: (output: unknown) => void;
      reject: (error: Error) => void;
    } | null;
    onTurnTimeout(timer: ReturnType<typeof setTimeout>): void;
    handleLine(line: string, from: unknown): void;
  };
  let killed = false;
  const child = { kill() { killed = true; } };
  let delivered: unknown;
  const timer = setTimeout(() => undefined, 60_000);
  s.child = child;
  s.pending = {
    parts: [],
    timer,
    timedOut: false,
    resolve: (output) => { delivered = output; },
    reject: () => {},
  };

  s.onTurnTimeout(timer);
  expect(killed).toBeFalse();
  expect(s.child).toBe(child);
  expect(s.pending?.timedOut).toBe(true);

  s.handleLine(JSON.stringify({
    type: "result",
    structured_output: { decision: "send", voice_check: "", message: "the real answer" },
  }), child);

  expect(delivered).toEqual({
    decision: "send",
    message: "Sorry, that took a while —\n\nthe real answer",
  });
  expect(s.pending).toBeNull();
});

// ── issue #139: the hard-deadline reaper + visible failure for dead turns ───────────────────

/** The private surface the issue-#139 / #150 tests reach into. */
interface ReaperGuts {
  child: unknown;
  initSeen: boolean;
  currentMeta: unknown;
  pending: {
    parts: string[];
    timer: ReturnType<typeof setTimeout>;
    hardTimer?: ReturnType<typeof setTimeout>;
    ceilingTimer?: ReturnType<typeof setTimeout>;
    timedOut: boolean;
    resolve: (output: unknown) => void;
    reject: (error: Error) => void;
  } | null;
  onTurnTimeout(timer: ReturnType<typeof setTimeout>): void;
  onHardTimeout(hardTimer: ReturnType<typeof setTimeout>): void;
  onCeilingTimeout(ceilingTimer: ReturnType<typeof setTimeout>): void;
  handleLine(line: string, from: unknown): void;
}

function makeReaperSession(): ReaperGuts {
  return new ConciergeSession({ config, logger: quietLog }) as unknown as ReaperGuts;
}

const directMention = () => ({
  channelId: "c",
  messageId: "m",
  userId: "u",
  isOwner: false,
  repliedViaCli: false,
  ackMessageId: null as string | null,
  turnSucceeded: false,
});

test("issue #139: the hard deadline reaps a resultless turn — child killed, pending settled, mention surfaced", () => {
  const s = makeReaperSession();
  let killed = false;
  const child = { kill() { killed = true; } };
  let delivered: unknown;
  const timer = setTimeout(() => undefined, 60_000);
  s.child = child;
  s.currentMeta = directMention();
  s.pending = { parts: [], timer, timedOut: false, resolve: (o) => { delivered = o; }, reject: () => {} };

  s.onTurnTimeout(timer); // soft fires: arms the hard deadline, but does NOT kill on its own
  expect(killed).toBeFalse();
  const hardTimer = s.pending!.hardTimer!;
  expect(hardTimer).toBeDefined();

  s.onHardTimeout(hardTimer); // the hard deadline fires — the turn is declared dead

  expect(killed).toBeTrue(); // child reaped, no leaked process
  expect(s.child).toBeNull(); // slot freed → the next ask() relaunches (fresh session)
  expect(s.pending).toBeNull(); // pending settled
  // The line names the TIMEOUT (issue #150) — "ask again" alone would send the person straight
  // back into the same deadline. It is still audible, which is what #139 bought.
  expect(delivered).toEqual({ decision: "send", message: "that turn timed out before it finished." });
});

test("issue #139: the hard deadline does NOT reap when a late real result arrives in time", () => {
  const s = makeReaperSession();
  let killed = false;
  const child = { kill() { killed = true; } };
  let deliveries = 0;
  let delivered: unknown;
  const timer = setTimeout(() => undefined, 60_000);
  s.child = child;
  s.pending = { parts: [], timer, timedOut: false, resolve: (o) => { delivered = o; deliveries += 1; }, reject: () => {} };

  s.onTurnTimeout(timer);
  const hardTimer = s.pending!.hardTimer!;

  // The completed-but-late REAL answer lands inside the late window — the whole point of the soft
  // deadline. onResult clears the hard timer, so the reaper must never fire.
  s.handleLine(JSON.stringify({ type: "result", structured_output: { decision: "send", voice_check: "", message: "the real answer" } }), child);
  expect(delivered).toEqual({ decision: "send", message: "Sorry, that took a while —\n\nthe real answer" });
  expect(s.pending).toBeNull();

  // A stale hard-timeout callback firing after the fact is an inert no-op: no second settle, no kill.
  s.onHardTimeout(hardTimer);
  expect(killed).toBeFalse();
  expect(deliveries).toBe(1);
  expect(s.child).toBe(child);
});

test("issue #139: a reaped direct-mention turn leaves turnSucceeded false so the origin question is re-askable", () => {
  const s = makeReaperSession();
  const child = { kill() {} };
  const meta = directMention();
  s.child = child;
  s.currentMeta = meta;
  const timer = setTimeout(() => undefined, 60_000);
  s.pending = { parts: [], timer, timedOut: false, resolve: () => {}, reject: () => {} };

  s.onTurnTimeout(timer);
  s.onHardTimeout(s.pending!.hardTimer!);

  expect(meta.turnSucceeded).toBe(false);
});

test("issue #139: a suppressed-schema result on a direct mention posts one honest line, never a silent pass or assistant text", () => {
  const s = makeReaperSession();
  const child = {};
  let delivered: unknown;
  const meta = directMention();
  s.child = child;
  s.initSeen = true; // a LIVE session (init WAS seen) — not the uninitialized lost-turn path
  s.currentMeta = meta;
  s.pending = {
    parts: ["scratch reasoning that must never reach Discord"],
    timer: setTimeout(() => undefined, 60_000),
    timedOut: false,
    resolve: (o) => { delivered = o; },
    reject: () => {},
  };

  // A result with no valid delivery output — e.g. upstream retries (529 storm) exhausted into an
  // error subtype. Previously a silent pass; now an audible failure line for the person who asked.
  s.handleLine(JSON.stringify({ type: "result", subtype: "error", structured_output: null }), child);

  expect(delivered).toEqual({ decision: "send", message: "that turn died on me, ask again." });
  expect(meta.turnSucceeded).toBe(false); // never marked succeeded → re-ask runs clean
  expect(s.pending).toBeNull();
});

test("issue #139: a suppressed-schema result on an ambient turn still passes silently (no new noise)", () => {
  const s = makeReaperSession();
  const child = {};
  let delivered: unknown;
  s.child = child;
  s.initSeen = true;
  s.currentMeta = { ...directMention(), ambient: true };
  s.pending = {
    parts: [],
    timer: setTimeout(() => undefined, 60_000),
    timedOut: false,
    resolve: (o) => { delivered = o; },
    reject: () => {},
  };

  s.handleLine(JSON.stringify({ type: "result", structured_output: null }), child);

  expect(delivered).toEqual({ decision: "pass", message: null });
  expect(s.pending).toBeNull();
});

test("issue #139: the hard deadline reaps an ambient turn silently (pass, not a failure line)", () => {
  const s = makeReaperSession();
  const child = { kill() {} };
  let delivered: unknown;
  const timer = setTimeout(() => undefined, 60_000);
  s.child = child;
  s.currentMeta = { ...directMention(), ambient: true };
  s.pending = { parts: [], timer, timedOut: false, resolve: (o) => { delivered = o; }, reject: () => {} };

  s.onTurnTimeout(timer);
  s.onHardTimeout(s.pending!.hardTimer!);

  expect(delivered).toEqual({ decision: "pass", message: null });
  expect(s.child).toBeNull();
});

// ── issue #150: the deadline measures SILENCE, not elapsed duration ─────────────────────────

const assistantText = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolUse = (name: string, command?: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: command ? { command } : {} }] },
  });
const toolResult = () =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });

/** A live turn wired the way driveTurn wires one (silence timer + absolute ceiling). */
function armReaperTurn(s: ReaperGuts, onDeliver: (output: unknown) => void): { child: { kill(): void }; killed: () => boolean } {
  let killed = false;
  const child = { kill() { killed = true; } };
  s.child = child;
  s.currentMeta = directMention();
  s.pending = {
    parts: [],
    timer: setTimeout(() => undefined, 600_000),
    ceilingTimer: setTimeout(() => undefined, 600_000),
    timedOut: false,
    resolve: onDeliver,
    reject: () => {},
  };
  return { child, killed: () => killed };
}

test("issue #150: a turn still emitting events past the old 6-minute wall clock survives — each event restarts the clock", () => {
  const s = makeReaperSession();
  let delivered: unknown;
  const { child, killed } = armReaperTurn(s, (o) => { delivered = o; });

  // Ten minutes of honest slow work (a typecheck, a test suite, a git fetch) is nothing but a
  // stream of tool calls and their results. Under the old pure-wall-clock rule this turn was
  // declared dead at six minutes while it was demonstrably working — the #150 incident.
  let previous = s.pending!.timer;
  for (const line of [
    toolUse("Bash", "bunx tsc --noEmit"),
    toolResult(),
    toolUse("Bash", "bun test"),
    toolResult(),
    assistantText("still digging"),
  ]) {
    s.handleLine(line, child);
    expect(s.pending!.timer).not.toBe(previous); // the silence clock was restarted, not accumulated
    previous = s.pending!.timer;
    expect(s.pending!.hardTimer).toBeUndefined(); // no reaper armed while the child is talking
  }
  expect(killed()).toBeFalse();
  expect(s.pending).not.toBeNull();

  // ...and the turn's real answer lands, unframed: it was never late, only long.
  s.handleLine(JSON.stringify({ type: "result", structured_output: { decision: "send", voice_check: "", message: "the real answer" } }), child);
  expect(delivered).toEqual({ decision: "send", message: "the real answer" });
  expect(s.pending).toBeNull();
});

test("issue #150: an event during the reap window disarms the reaper — the stale hard timer is inert", () => {
  const s = makeReaperSession();
  let delivered: unknown;
  const { child, killed } = armReaperTurn(s, (o) => { delivered = o; });

  s.onTurnTimeout(s.pending!.timer); // the child went quiet: soft fires, reaper armed
  const staleHardTimer = s.pending!.hardTimer!;
  expect(staleHardTimer).toBeDefined();

  s.handleLine(toolResult(), child); // ...then the long `bun test` finishes and speaks up
  expect(s.pending!.hardTimer).toBeUndefined();

  s.onHardTimeout(staleHardTimer); // the disarmed reaper firing late must do nothing
  expect(killed()).toBeFalse();
  expect(s.child).toBe(child);
  expect(s.pending).not.toBeNull();
  expect(delivered).toBeUndefined();

  // `timedOut` stays sticky: the person really did wait through that quiet stretch.
  s.handleLine(JSON.stringify({ type: "result", structured_output: { decision: "send", voice_check: "", message: "the real answer" } }), child);
  expect(delivered).toEqual({ decision: "send", message: "Sorry, that took a while —\n\nthe real answer" });
});

test("issue #150 guards #139: a turn emitting NO events is still reaped and still posts an honest line", () => {
  const s = makeReaperSession();
  let delivered: unknown;
  const { child, killed } = armReaperTurn(s, (o) => { delivered = o; });
  const meta = s.currentMeta as { turnSucceeded: boolean };

  // Nothing here is evidence of LIFE: init fires once at launch, and stream noise is not work.
  // A wedged child would emit exactly this much and must still die on the old schedule.
  const before = s.pending!.timer;
  s.handleLine(JSON.stringify({ type: "system", subtype: "init" }), child);
  s.handleLine(JSON.stringify({ type: "stream_event", event: { type: "ping" } }), child);
  expect(s.pending!.timer).toBe(before); // clock never restarted

  s.onTurnTimeout(before);
  s.onHardTimeout(s.pending!.hardTimer!);

  expect(killed()).toBeTrue(); // still reaped — no leaked process, no held gate slot
  expect(s.child).toBeNull();
  expect(s.pending).toBeNull();
  expect(delivered).toEqual({ decision: "send", message: "that turn timed out before it finished." });
  expect(meta.turnSucceeded).toBe(false); // re-ask still runs clean
});

test("issue #150: the absolute ceiling still reaps a runaway that never stops emitting events", () => {
  const s = makeReaperSession();
  let delivered: unknown;
  const { child, killed } = armReaperTurn(s, (o) => { delivered = o; });

  // A tool loop: liveness forever, so the silence clock alone would never fire.
  for (let i = 0; i < 20; i++) {
    s.handleLine(toolUse("Read", "cat same-file.ts"), child);
    s.handleLine(toolResult(), child);
  }
  expect(s.pending!.hardTimer).toBeUndefined();

  s.onCeilingTimeout(s.pending!.ceilingTimer!); // the backstop fires

  expect(killed()).toBeTrue();
  expect(s.child).toBeNull();
  expect(s.pending).toBeNull();
  expect(delivered).toEqual({
    decision: "send",
    message: "that turn timed out before it finished. last thing it was doing: Read (cat same-file.ts).",
  });
});

test("issue #150: the ceiling sits well above the old 6-minute deadline, and silence still reaps on the old schedule", () => {
  expect(TURN_SILENCE_MS + HARD_TURN_TIMEOUT_MS).toBe(360_000); // #139's wedged child: unchanged
  expect(TURN_ABSOLUTE_CEILING_MS).toBeGreaterThan(4 * 360_000); // the runaway backstop: far above it
});

test("issue #150: only real work counts as evidence of life", () => {
  expect(isLivenessEvent(JSON.parse(assistantText("thinking out loud")))).toBeTrue();
  expect(isLivenessEvent(JSON.parse(toolUse("Bash", "bun test")))).toBeTrue();
  expect(isLivenessEvent(JSON.parse(toolResult()))).toBeTrue();
  expect(isLivenessEvent({ type: "system", subtype: "init" })).toBeFalse();
  expect(isLivenessEvent({ type: "result" })).toBeFalse(); // settles the turn, never extends it
  expect(isLivenessEvent({ type: "user", message: { content: "plain echo" } })).toBeFalse();
  expect(isLivenessEvent({ type: "user", message: { content: [null, { type: "text", text: "hi" }] } })).toBeFalse();
});

test("issue #150: the timed-out line names the timeout, and the crumb never floods Discord", () => {
  expect(timedOutTurnLine()).toBe("that turn timed out before it finished.");
  expect(timedOutTurnLine("Bash (bun test)")).toContain("timed out");
  expect(timedOutTurnLine("  ")).toBe("that turn timed out before it finished.");
  expect(describeToolUse("Bash", { command: "bun test\nrm -rf /tmp/x" })).toBe("Bash (bun test)");
  expect(describeToolUse("Read", { file_path: "/x" })).toBe("Read");
  expect(describeToolUse(undefined, { command: "x" })).toBeUndefined();
  // Argument VALUES never ride along — the crumb goes to Discord, so it keeps the gist and drops
  // whatever was being passed (a pasted heredoc, a path, a token that wandered into an argv).
  expect(describeToolUse("Bash", { command: "beckett deploy beckett --port 8080 --token hunter2" }))
    .toBe("Bash (beckett deploy)");
  const long = describeToolUse("Bash", { command: "x".repeat(500) })!;
  expect(long.length).toBeLessThan(80);
});

test("reasoning before a pass decision is never promoted to Discord output", () => {
  const s = makeSession() as unknown as {
    child: unknown;
    pending: {
      parts: string[];
      timer: ReturnType<typeof setTimeout>;
      resolve: (output: unknown) => void;
      reject: (error: Error) => void;
    } | null;
    handleLine(line: string, from: unknown): void;
  };
  const child = {};
  let delivered: unknown;
  s.child = child;
  s.pending = {
    parts: ["I should keep this private.\nPASS"],
    timer: setTimeout(() => undefined, 60_000),
    resolve: (output) => { delivered = output; },
    reject: () => {},
  };

  s.handleLine(JSON.stringify({ type: "result", structured_output: { decision: "pass", voice_check: "", message: null } }), child);

  expect(delivered).toEqual({ decision: "pass", message: null });
  expect(s.pending).toBeNull();
});

test("a malformed delivery object on a live turn surfaces (warn + notice) instead of silent suppression (issue #138)", () => {
  // init WAS seen (a live turn), and the terminal result carries a structured_output that fails
  // the schema — a bug, not a deliberate model pass. A DIRECTED turn's author must get a word, not
  // dead air; an ambient/system turn stays silent.
  const s = makeSession() as unknown as {
    child: unknown;
    initSeen: boolean;
    currentMeta: unknown;
    pending: {
      parts: string[];
      timer: ReturnType<typeof setTimeout>;
      resolve: (output: unknown) => void;
      reject: (error: Error) => void;
    } | null;
    handleLine(line: string, from: unknown): void;
  };
  const child = {};
  const malformed = JSON.stringify({
    type: "result",
    structured_output: { decision: "wat", voice_check: "", message: "half a thought" }, // bad enum → parses to null
  });

  // Directed turn: the person is owed a word.
  let delivered: unknown;
  s.child = child;
  s.initSeen = true;
  s.currentMeta = { channelId: "chan-1", messageId: "m-1", userId: "u-1" };
  s.pending = {
    parts: ["scratch reasoning that must never be promoted"],
    timer: setTimeout(() => undefined, 60_000),
    resolve: (output) => { delivered = output; },
    reject: () => {},
  };
  s.handleLine(malformed, child);
  expect((delivered as { decision: string }).decision).toBe("send");
  expect(typeof (delivered as { message: string }).message).toBe("string");
  expect((delivered as { message: string }).message.length).toBeGreaterThan(0);
  expect((delivered as { message: string }).message).not.toContain("half a thought"); // never the raw/assistant text
  expect(s.pending).toBeNull();

  // Ambient/system turn (no directed author): stays a silent pass — nobody asked.
  let ambientDelivered: unknown;
  s.child = child;
  s.initSeen = true;
  s.currentMeta = { channelId: "chan-1", messageId: "m-2", userId: "u-1", ambient: true };
  s.pending = {
    parts: [],
    timer: setTimeout(() => undefined, 60_000),
    resolve: (output) => { ambientDelivered = output; },
    reject: () => {},
  };
  s.handleLine(malformed, child);
  expect(ambientDelivered).toEqual({ decision: "pass", message: null });
});

test("a superseded child's exit does not tear down the current child or fail the turn", async () => {
  tempBeckettDir();
  const s = makeSession();
  const oldChild = {};
  const newChild = {};
  s.child = newChild as never;
  s.pending = { parts: ["hi"] };

  await s.onExit(143, oldChild); // the recycled child finally exits

  expect(s.child).toBe(newChild);
  expect(s.pending).not.toBeNull(); // in-flight turn untouched
  expect(s.consecutiveCrashes).toBe(0); // not counted as a crash
});

// ── 3+4. concierge-level: no queue narration + reply-claim correlation ─────────────────────

interface Post {
  channelId: string;
  text: string;
  replyTo?: string;
}

function conciergeHarness(session: Partial<ConciergeSession> & Record<string, unknown>) {
  tempBeckettDir();
  process.env.DISCORD_OWNER_ID = "111111111111111111";
  const posts: Post[] = [];
  const gateway = {
    onMessage() {},
    async start() {},
    async stop() {},
    sendTyping() {},
    async post(channelId: string, text: string, o?: { replyToMessageId?: string }) {
      posts.push({ channelId, text, replyTo: o?.replyToMessageId });
      return `mid-${posts.length}`;
    },
  } as unknown as DiscordGateway;
  const concierge = new Concierge({ config, gateway, session: session as unknown as ConciergeSession });
  return { concierge, posts };
}

function msg(channelId: string, messageId: string): IncomingMessage {
  return {
    channelId,
    messageId,
    userId: "111111111111111111",
    displayName: "jason",
    content: "quick question",
    mentionsBot: true,
    guildId: null,
    attachments: [],
  } as unknown as IncomingMessage;
}

test("a mention landing behind a busy session gets no bubble — typing is the whole ack", async () => {
  // Queue-free UX: a directed message interrupts the live turn (or jumps the queue), so there is
  // no line to narrate. The ONLY post is the real answer; nothing resembling "you're next" exists.
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the real answer" } as const),
    queueDepth: () => 1, // a turn is already running
    getCurrentMeta: () => null,
  });
  await concierge.onMessage(msg("chan-1", "m-1"));

  expect(posts).toEqual([{ channelId: "chan-1", text: "the real answer", replyTo: "m-1" }]);
});

test("rapid mentions behind a busy session get no ack bubbles — each still gets its answer", async () => {
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the real answer" } as const),
    queueDepth: () => 1, // a turn is already running the whole time
    getCurrentMeta: () => null,
  });
  await concierge.onMessage(msg("chan-1", "m-1"));
  await concierge.onMessage(msg("chan-1", "m-2"));
  await concierge.onMessage(msg("chan-1", "m-3"));

  expect(posts.filter((p) => p.text === "the real answer")).toHaveLength(3); // replies unaffected
  expect(posts).toHaveLength(3); // and nothing else was posted at all
});

test("a slow turn posts NO canned progress bubble — the answer is the only message", async () => {
  // The daemon-authored "Still working on this" ack is gone (it was schedule-narration the
  // doctrine bans the model from writing — the daemon doesn't get to write it instead). A slow
  // turn shows typing and then the answer, nothing between. This pins its absence.
  let startAsk!: () => void;
  let resolveAsk!: (output: { decision: "send"; message: string }) => void;
  const started = new Promise<void>((resolve) => { startAsk = resolve; });
  const answer = new Promise<{ decision: "send"; message: string }>((resolve) => { resolveAsk = resolve; });
  const { concierge, posts } = conciergeHarness({
    ask: async () => {
      startAsk();
      return await answer;
    },
    queueDepth: () => 0,
    getCurrentMeta: () => null,
  });

  const handling = concierge.onMessage(msg("chan-idle", "m-slow"));
  await started;
  expect(posts).toHaveLength(0); // slow turn in flight, nothing posted

  resolveAsk({ decision: "send", message: "the eventual answer" });
  await handling;
  expect(posts.map((p) => p.text)).toEqual(["the eventual answer"]);
});

test("an idle session posts only the answer", async () => {
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the answer" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null,
  });
  await concierge.onMessage(msg("chan-1", "m-1"));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text).toBe("the answer");
});

// ── 5. queue-free supersession (a follow-up replaces your own still-queued turn) ─────────

test("supersedeQueuedTurns drops only matching queued turns, resolving them as silent passes", () => {
  tempBeckettDir();
  const s = new ConciergeSession({ config, logger: quietLog }) as unknown as {
    turnQueue: {
      message: unknown;
      meta: unknown;
      priority: boolean;
      resolve: (output: unknown) => void;
      reject: (err: unknown) => void;
    }[];
    supersedeQueuedTurns(match: (meta: unknown) => boolean): number;
  };
  const settled: { which: string; output: unknown }[] = [];
  const push = (which: string, meta: unknown) =>
    s.turnQueue.push({
      message: which,
      meta,
      priority: true,
      resolve: (output) => settled.push({ which, output }),
      reject: (err) => { throw err; },
    });
  push("older-same-speaker", { channelId: "c", messageId: "m1", userId: "u1" });
  push("other-speaker", { channelId: "c", messageId: "m2", userId: "u2" });
  push("update-turn", null);
  push("newest-same-speaker", { channelId: "c", messageId: "m3", userId: "u1" });

  const dropped = s.supersedeQueuedTurns((meta) => (meta as { userId?: string })?.userId === "u1");

  expect(dropped).toBe(2);
  // Other speakers and meta-less system/update turns are never superseded.
  expect(s.turnQueue.map((q) => q.message)).toEqual(["other-speaker", "update-turn"]);
  // Dropped turns RESOLVE as a silent pass (never reject) — their handlers post nothing.
  expect(settled.map((x) => x.which).sort()).toEqual(["newest-same-speaker", "older-same-speaker"]);
  for (const { output } of settled) {
    expect(output).toEqual({ decision: "pass", message: null });
  }
});

test("a mention asks the pool to supersede the same speaker's still-queued earlier turn", async () => {
  const predicates: ((meta: unknown) => boolean)[] = [];
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "answer" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null,
    supersedeQueuedTurns: (match: (meta: unknown) => boolean) => {
      predicates.push(match);
      return 1;
    },
  });
  await concierge.onMessage(msg("chan-1", "m-1"));

  expect(predicates).toHaveLength(1);
  const match = predicates[0]!;
  // Matches a queued mention from the SAME speaker in the SAME channel...
  expect(match({ channelId: "chan-1", messageId: "m-0", userId: "111111111111111111" })).toBe(true);
  // ...never the same speaker in a DIFFERENT channel (their DM isn't this conversation)...
  expect(match({ channelId: "dm-9", messageId: "m-7", userId: "111111111111111111" })).toBe(false);
  // ...never another speaker's queued mention...
  expect(match({ channelId: "chan-1", messageId: "m-9", userId: "222222222222222222" })).toBe(false);
  // ...and never a meta-less update turn (isMentionClaim requires channelId+messageId).
  expect(match(null)).toBe(false);
  expect(match({ ticket: "OPS-1" })).toBe(false);
  expect(posts.map((p) => p.text)).toEqual(["answer"]);
});

test("a direct reply can say pass, while a structured pass posts nothing", async () => {
  const spoken = conciergeHarness({
    ask: async () => ({ decision: "send", message: "the tests pass" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null,
  });
  await spoken.concierge.onMessage(msg("chan-1", "m-1"));
  expect(spoken.posts.map((post) => post.text)).toEqual(["the tests pass"]);

  const silent = conciergeHarness({
    ask: async () => ({ decision: "pass", message: null } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null,
  });
  await silent.concierge.onMessage(msg("chan-2", "m-2"));
  expect(silent.posts).toEqual([]);
});

test("a CLI reply claims the turn EXECUTING now — a queued second mention can't steal it", async () => {
  // Turn 1 (for message m-1) is executing; a second mention (m-2) has overwritten the shared
  // slot. The CLI reply issued by turn 1 must reply-bar to m-1, not m-2.
  const turn1Mention = {
    channelId: "chan-1",
    messageId: "m-1",
    repliedViaCli: false,
    ackMessageId: null,
    pendingTickets: [],
  };
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "unused" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => turn1Mention, // the session says: turn 1 is what's running
  });

  const res = await concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: "chan-1", text: "here's your answer" },
  });

  expect(res.ok).toBe(true);
  expect(posts[0]!.replyTo).toBe("m-1");
  expect(turn1Mention.repliedViaCli).toBe(true);
});

test("an update turn (no mention meta) can never claim a pending mention", async () => {
  const { concierge, posts } = conciergeHarness({
    ask: async () => ({ decision: "send", message: "unused" } as const),
    queueDepth: () => 0,
    getCurrentMeta: () => null, // a notify() update turn is running — it carries no mention
  });

  const res = await concierge.onBusRequest({
    cmd: "discord.reply",
    args: { channelId: "chan-1", text: "ticket update ping" },
  });

  expect(res.ok).toBe(true);
  expect(posts[0]!.replyTo).toBeUndefined(); // plain post, no claim, no suppression
});

// ── issue #25: mention priority in the turn queue ─────────────────────────────────────────

test("mention turns jump ahead of queued update turns but never pre-empt a running one", async () => {
  tempBeckettDir();
  const s = new ConciergeSession({ config, logger: quietLog }) as unknown as {
    ask(m: unknown, meta?: unknown, opts?: { priority?: boolean }): Promise<string>;
    runTurn(m: string): Promise<string>;
    maybeRotate(): Promise<void>;
  };
  const order: string[] = [];
  s.runTurn = async (m: string) => {
    order.push(m);
    await new Promise((r) => setTimeout(r, 5));
    return m;
  };
  s.maybeRotate = async () => {};

  const turns = [
    s.ask("update-1"), // starts running immediately
    s.ask("update-2"),
    s.ask("mention", null, { priority: true }),
  ];
  await Promise.all(turns);
  expect(order).toEqual(["update-1", "mention", "update-2"]);
});
