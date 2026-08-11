/** Idle rotation is deliberately cheap and outside the live cross-channel turn gate (#127, #154). */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import { ConciergeSession } from "./index.ts";
import { TurnGate } from "./turn-gate.ts";

const dirs: string[] = [];
const priorDir = process.env.BECKETT_DIR;
afterEach(() => {
  if (priorDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = priorDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

function config() {
  const dir = mkdtempSync(join(tmpdir(), "beckett-rotation-"));
  dirs.push(dir);
  process.env.BECKETT_DIR = dir;
  return validateConfig({});
}

test("idle rotation uses a cheap handoff, preserves the channel window, and defers re-grounding", async () => {
  const s = new ConciergeSession({
    config: config(),
    logger: quietLog,
    handoffWindow: () => "[user:jason] keep the session rotation ticket open",
  }) as unknown as {
    lastContextTokens: number;
    child: { kill(signal: string): void } | null;
    runCheapHandoff(window: string): Promise<string>;
    runTurn(message: string): Promise<unknown>;
    launch(resume: boolean): Promise<void>;
    rotateWhileIdle(): Promise<boolean>;
    lastHandoff: string;
    seedPending: string | null;
  };
  s.lastContextTokens = 160_000;
  s.child = { kill() {} };
  let cheapWindow = "";
  let liveTurns = 0;
  s.runCheapHandoff = async (window) => {
    cheapWindow = window;
    return "Jason is reviewing the session rotation work.";
  };
  s.runTurn = async () => {
    liveTurns += 1;
    return { decision: "send", message: "should not run" };
  };
  s.launch = async () => {};

  expect(await s.rotateWhileIdle()).toBe(true);
  expect(cheapWindow).toContain("jason");
  expect(s.lastHandoff).toContain("Jason is reviewing");
  expect(s.lastHandoff).toContain("channel-store window");
  expect(s.lastHandoff).toContain("keep the session rotation ticket open");
  expect(s.seedPending).toBe(s.lastHandoff); // consumed by the next actual user turn
  expect(liveTurns).toBe(0); // no dying-session handoff or fresh-session re-ground turn
});

// ── issue #229: the idle gate ───────────────────────────────────────────────────────────────
//
// The re-grounder SIGTERMs the child, so "idle" has to mean every kind of in-flight work is done —
// not just "the pump isn't running". Prod re-grounded a scope whose turn chain still held an
// inline browser lease, killing the child out from under real work.

/** The private surface the idle-gate tests script. */
interface GateGuts {
  lastContextTokens: number;
  child: { kill(signal: string): void } | null;
  pending: unknown;
  peerTurnLive: boolean;
  deferredTurn: unknown;
  rotations: number;
  runCheapHandoff(window: string): Promise<string>;
  launch(resume: boolean): Promise<void>;
  rotateWhileIdle(): Promise<boolean>;
  noteInlineErrand(): () => void;
}

function overWatermarkSession(): GateGuts {
  const s = new ConciergeSession({ config: config(), logger: quietLog }) as unknown as GateGuts;
  s.lastContextTokens = 190_000; // well past the watermark: only the idle gate can hold it back
  s.child = { kill() {} };
  s.runCheapHandoff = async () => "handoff";
  s.launch = async () => {};
  return s;
}

test("issue #229: an outstanding inline errand blocks the re-ground until it settles", async () => {
  const s = overWatermarkSession();
  // A `browser.exec` holding the browser lease — the turn that issued it may already be gone.
  const settle = s.noteInlineErrand();

  expect(await s.rotateWhileIdle()).toBe(false);
  expect(s.rotations).toBe(0);

  settle();
  expect(await s.rotateWhileIdle()).toBe(true);
  expect(s.rotations).toBe(1);
});

test("issue #229: errands nest, and settling one twice cannot free the gate early", async () => {
  const s = overWatermarkSession();
  const first = s.noteInlineErrand();
  const second = s.noteInlineErrand();

  first();
  first(); // a `finally` that runs twice must not decrement the other errand's hold
  expect(await s.rotateWhileIdle()).toBe(false);

  second();
  expect(await s.rotateWhileIdle()).toBe(true);
});

test("issue #229: a turn awaiting its result boundary blocks the re-ground", async () => {
  const s = overWatermarkSession();
  s.pending = { parts: [] };
  expect(await s.rotateWhileIdle()).toBe(false);

  s.pending = null;
  expect(await s.rotateWhileIdle()).toBe(true);
});

test("issue #229: an unsolicited peer turn (or a line held for one) blocks the re-ground", async () => {
  const s = overWatermarkSession();
  s.peerTurnLive = true;
  expect(await s.rotateWhileIdle()).toBe(false);

  s.peerTurnLive = false;
  s.deferredTurn = { outbound: "a human's line, waiting for the peer turn to settle" };
  expect(await s.rotateWhileIdle()).toBe(false);

  s.deferredTurn = null;
  expect(await s.rotateWhileIdle()).toBe(true);
});

test("the hard-edge fallback releases its live TurnGate slot before rotating", async () => {
  const gate = new TurnGate(1);
  const a = new ConciergeSession({ config: config(), logger: quietLog, gate }) as unknown as {
    ask(message: string): Promise<unknown>;
    lastContextTokens: number;
    runTurn(message: string): Promise<{ decision: "send"; message: string }>;
    maybeRotate(): Promise<void>;
  };
  const b = new ConciergeSession({ config: config(), logger: quietLog, gate }) as unknown as {
    ask(message: string): Promise<unknown>;
    runTurn(message: string): Promise<{ decision: "send"; message: string }>;
  };
  let beginRotation!: () => void;
  const rotationStarted = new Promise<void>((resolve) => { beginRotation = resolve; });
  let finishRotation!: () => void;
  const rotationMayFinish = new Promise<void>((resolve) => { finishRotation = resolve; });
  a.runTurn = async () => {
    a.lastContextTokens = 190_000;
    return { decision: "send", message: "a" };
  };
  a.maybeRotate = async () => {
    beginRotation();
    await rotationMayFinish;
  };
  b.runTurn = async () => ({ decision: "send", message: "b" });

  await a.ask("first");
  await rotationStarted;
  // If rotation still held the gate, this would wait until finishRotation().
  await expect(b.ask("other channel")).resolves.toEqual({ decision: "send", message: "b" });
  finishRotation();
});
