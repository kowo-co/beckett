/**
 * W2B — UNSOLICITED turns: the concierge session is addressable and accepts cross-session inbound
 * (W2A), so a live worker answering "how's it going?" wakes an idle child, which runs a turn NO
 * ask() is waiting on and ends it with a `result` frame carrying a delivery decision.
 *
 * What must hold for the chat lane to stay safe:
 *   - it never crashes the stdout loop (there is no pending promise to resolve);
 *   - its `decision:"send"` is NEVER delivered — no channel binding here is trustworthy;
 *   - pool bookkeeping (queueDepth / pump / turn queue) is untouched, and the very next real ask
 *     runs normally on the same warm transcript;
 *   - the pool's idle clock hears about it, so a peer conversation can't get its child reaped.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConciergeSession } from "./index.ts";
import { SessionPool, type PoolSession } from "./session-pool.ts";
import type { Config, Logger } from "../types.ts";

const config = {
  concierge: { model: "m", rotate_at_tokens: 190_000 },
  paths: {},
  harness: { claude: { bin: "claude", extra_flags: [] } },
} as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempBeckettDir(): void {
  const dir = mkdtempSync(join(tmpdir(), "beckett-peer-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
}

interface LogLine {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

/** A logger that records every line, so a test can assert what the peer path reported. */
function recordingLogger(): { lines: LogLine[]; logger: Logger } {
  const lines: LogLine[] = [];
  const make = (): Logger => {
    const l = {
      info: (msg: string, fields: Record<string, unknown> = {}) => lines.push({ level: "info", msg, fields }),
      warn: (msg: string, fields: Record<string, unknown> = {}) => lines.push({ level: "warn", msg, fields }),
      debug: () => {},
      error: (msg: string, fields: Record<string, unknown> = {}) => lines.push({ level: "error", msg, fields }),
      child: () => l,
    };
    return l as unknown as Logger;
  };
  return { lines, logger: make() };
}

/** The private surface these tests script (same idiom as session-robustness.test.ts). */
interface SessionGuts {
  child: unknown;
  pending: unknown;
  launch(isResume: boolean): Promise<void>;
  writeUserLine(content: unknown): void;
  handleLine(line: string, from: unknown): void;
  queueDepth(): number;
  ask(message: unknown, meta?: unknown, opts?: { priority?: boolean }): Promise<unknown>;
  stats(): Record<string, unknown>;
}

function resultLine(output: unknown): string {
  return JSON.stringify({ type: "result", structured_output: output });
}

/** One assistant text frame — the liveness event that proves SOME turn is executing. */
function assistantLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

/** Let the queue/pump microtasks settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

test("an unsolicited result (no pending ask) is absorbed, logged, and never delivered", () => {
  tempBeckettDir();
  const { lines, logger } = recordingLogger();
  const peerTurns: number[] = [];
  const s = new ConciergeSession({
    config,
    logger,
    scope: "system",
    onPeerTurn: () => peerTurns.push(1),
  }) as unknown as SessionGuts;
  const child = { kill() {} };
  s.child = child;

  // The peer turn wants to SEND — the one case that must be actively suppressed.
  expect(() =>
    s.handleLine(
      resultLine({ decision: "send", voice_check: "", message: "the middleware worker says it's on step 3 of 5" }),
      child,
    ),
  ).not.toThrow();

  // Nothing was resolved, nothing queued, nothing pumping: bookkeeping is exactly as before.
  expect(s.pending).toBeNull();
  expect(s.queueDepth()).toBe(0);
  // It IS reported, on its own component, with the send explicitly suppressed and no prose logged.
  const noted = lines.find((l) => l.msg.includes("unsolicited concierge turn"));
  expect(noted).toBeDefined();
  expect(noted!.fields.decision).toBe("send");
  expect(noted!.fields.suppressedSend).toBe(true);
  expect(noted!.fields.sessionName).toBe("beckett-concierge-system");
  expect(JSON.stringify(noted!.fields)).not.toContain("step 3 of 5");
  expect(lines.some((l) => l.level === "warn" && l.msg.includes("suppressed"))).toBe(true);
  // The owner heard about it once (the pool keeps its idle clock honest off this).
  expect(peerTurns).toHaveLength(1);
  expect(s.stats().peerTurns).toBe(1);
});

test("a pass-shaped unsolicited result is absorbed just as quietly (no warn)", () => {
  tempBeckettDir();
  const { lines, logger } = recordingLogger();
  const s = new ConciergeSession({ config, logger, scope: "system" }) as unknown as SessionGuts;
  const child = { kill() {} };
  s.child = child;

  s.handleLine(resultLine({ decision: "pass", voice_check: "", message: null }), child);

  const noted = lines.find((l) => l.msg.includes("unsolicited concierge turn"));
  expect(noted!.fields.decision).toBe("pass");
  expect(noted!.fields.suppressedSend).toBe(false);
  expect(lines.some((l) => l.level === "warn" && l.msg.includes("suppressed"))).toBe(false);
});

test("an unsolicited result with NO valid delivery object is absorbed too (peer prose, not a turn)", () => {
  tempBeckettDir();
  const { lines, logger } = recordingLogger();
  const s = new ConciergeSession({ config, logger, scope: "system" }) as unknown as SessionGuts;
  const child = { kill() {} };
  s.child = child;

  expect(() => s.handleLine(resultLine(null), child)).not.toThrow();
  const noted = lines.find((l) => l.msg.includes("unsolicited concierge turn"));
  expect(noted!.fields.decision).toBe("none");
  expect(s.queueDepth()).toBe(0);
});

test("a normal ask right after an unsolicited turn still works", async () => {
  tempBeckettDir();
  const { logger } = recordingLogger();
  const s = new ConciergeSession({ config, logger, scope: "system" }) as unknown as SessionGuts;
  const child = { kill() {} };
  s.child = child;
  s.launch = async () => {
    s.child = child;
  };
  s.writeUserLine = () => {
    queueMicrotask(() => {
      s.handleLine(JSON.stringify({ type: "system", subtype: "init" }), child);
      s.handleLine(resultLine({ decision: "send", voice_check: "", message: "it's about halfway" }), child);
    });
  };

  // A worker's status answer lands first, on an idle session.
  s.handleLine(resultLine({ decision: "send", voice_check: "", message: "worker says step 3 of 5" }), child);

  // …then a person asks something. The turn is answered normally — the orphan didn't eat it.
  await expect(s.ask("how's the middleware going?")).resolves.toEqual({
    decision: "send",
    message: "it's about halfway",
  });
  expect(s.queueDepth()).toBe(0);
});

// ── the ordering that arrival order alone gets WRONG ───────────────────────────────────────
//
// A peer turn runs for tens of seconds (the model reads the run, posts a `beckett discord reply`).
// A human message landing INSIDE that window arms `pending` first, so "no pending turn" can no
// longer be the test for "unsolicited" — the peer turn's result would be handed to the human's
// promise (peer prose delivered under their mention claim) and the human's own answer would then
// arrive with no pending turn and be swallowed as unsolicited. Both messages lost, one misdelivered.

test("a peer turn already EXECUTING when a real ask starts keeps its own result", async () => {
  tempBeckettDir();
  const { lines, logger } = recordingLogger();
  const s = new ConciergeSession({ config, logger, scope: "system" }) as unknown as SessionGuts;
  const child = { kill() {} };
  s.child = child;
  const written: unknown[] = [];
  s.launch = async () => {
    s.child = child;
  };
  s.writeUserLine = (content: unknown) => {
    written.push(content);
  };

  // 1. A worker's status reply wakes the idle child; that turn is now WORKING (assistant frames).
  s.handleLine(assistantLine("checking on the middleware run"), child);

  // 2. …and only now does a human @mention land on the same scope.
  const asked = s.ask("how's the middleware going?");
  await tick();
  // The human's line is HELD: writing it now would inject it into the peer turn as a mid-flow
  // message, and the peer turn's single reply would answer the worker, not them.
  expect(written).toEqual([]);

  // 3. The peer turn finishes, wanting to SEND. That is the peer's decision, not the human's turn:
  //    suppressed, and NOT resolved into the waiting ask.
  s.handleLine(
    resultLine({ decision: "send", voice_check: "", message: "worker says step 3 of 5" }),
    child,
  );
  await tick();
  const noted = lines.find((l) => l.msg.includes("unsolicited concierge turn"));
  expect(noted).toBeDefined();
  expect(noted!.fields.suppressedSend).toBe(true);
  // The held line goes out the moment the floor is free — the human's turn starts now.
  expect(written).toEqual(["how's the middleware going?"]);

  // 4. The human's OWN result then resolves their ask, with their own answer.
  s.handleLine(resultLine({ decision: "send", voice_check: "", message: "about halfway" }), child);
  await expect(asked).resolves.toEqual({ decision: "send", message: "about halfway" });
  expect(s.queueDepth()).toBe(0);
  expect(s.stats().peerTurns).toBe(1);
});

test("the peer turn's assistant text never leaks into the waiting ask's turn", async () => {
  tempBeckettDir();
  const { logger } = recordingLogger();
  const s = new ConciergeSession({ config, logger, scope: "system" }) as unknown as SessionGuts;
  const child = { kill() {} };
  s.child = child;
  s.launch = async () => {
    s.child = child;
  };
  s.writeUserLine = () => {};

  s.handleLine(assistantLine("peer deliberation nobody asked for"), child);
  const asked = s.ask("how's it going?");
  await tick();
  // A tool_use frame from the PEER turn must not make the waiting ask look like it is doing work
  // (the pool reads this to decide cancel-vs-queue on the next message).
  s.handleLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "beckett task show" } }] },
    }),
    child,
  );
  expect((s as unknown as { liveTurnToolUse(): boolean }).liveTurnToolUse()).toBe(false);
  // A mid-flow injection has no live turn to join either: the floor belongs to the peer turn.
  expect(
    (s as unknown as { injectIntoLiveTurn(t: string): string }).injectIntoLiveTurn("one more thing"),
  ).toBe("no-live-turn");

  s.handleLine(resultLine({ decision: "pass", voice_check: "", message: null }), child);
  s.handleLine(resultLine({ decision: "send", voice_check: "", message: "mine" }), child);
  await expect(asked).resolves.toEqual({ decision: "send", message: "mine" });
});

test("a peer turn that dies with its child never strands a held user line", async () => {
  tempBeckettDir();
  const { logger } = recordingLogger();
  const s = new ConciergeSession({ config, logger, scope: "system" }) as unknown as SessionGuts;
  const first = { kill() {} };
  s.child = first;
  const written: unknown[] = [];
  s.writeUserLine = (content: unknown) => {
    written.push(content);
  };

  // A peer turn is executing, so the first ask holds its line…
  s.handleLine(assistantLine("peer working"), first);
  const stalled = s.ask("first question");
  await tick();
  expect(written).toEqual([]);

  // …then the child dies. The stalled ask fails honestly rather than hanging on a dead process.
  await (s as unknown as { onExit(code: number, exited: unknown): Promise<void> }).onExit(1, first);
  await expect(stalled).rejects.toThrow(/exited/);

  // The next ask relaunches and must NOT inherit the stranded peer flag (that would hold every
  // future line forever) nor re-write the dead turn's message.
  const second = { kill() {} };
  s.launch = async () => {
    s.child = second;
  };
  const asked = s.ask("second question");
  await tick();
  expect(written).toEqual(["second question"]);
  s.handleLine(resultLine({ decision: "send", voice_check: "", message: "answered" }), second);
  await expect(asked).resolves.toEqual({ decision: "send", message: "answered" });
});

// ── pool bookkeeping ───────────────────────────────────────────────────────────────────────

test("notePeerActivity keeps a peer-busy scope off the idle sweep's chopping block", async () => {
  const recycles: string[] = [];
  const session: PoolSession = {
    start: async () => {},
    stop: async () => {},
    ask: async () => "reply",
    queueDepth: () => 0,
    hasLiveChild: () => true,
    recycle: (reason: string) => recycles.push(reason),
  };
  const p = new SessionPool({
    scope: "channel",
    maxLiveSessions: 6,
    idleRecycleMs: 60_000,
    makeSession: () => session,
  });
  await p.ask("chan-a", "hi");
  const entries = (p as unknown as { entries: Map<string, { lastUsedAt: number }> }).entries;
  const now = Date.now();
  for (const e of entries.values()) e.lastUsedAt = now - 120_000;

  // A cross-session peer turn just ran on this scope — it is NOT idle.
  p.notePeerActivity("chan-a");
  (p as unknown as { idleSweep(now: number): void }).idleSweep(now);
  expect(recycles).toEqual([]);

  // Without the peer signal the same sweep recycles it, exactly as before.
  for (const e of entries.values()) e.lastUsedAt = now - 120_000;
  (p as unknown as { idleSweep(now: number): void }).idleSweep(now);
  expect(recycles).toEqual(["idle session recycle"]);
});

test("notePeerActivity never creates an entry for an unknown/evicted scope", () => {
  let made = 0;
  const p = new SessionPool({
    scope: "channel",
    maxLiveSessions: 6,
    idleRecycleMs: 0,
    makeSession: () => {
      made += 1;
      return { stop: async () => {}, ask: async () => "reply" } as PoolSession;
    },
  });
  p.notePeerActivity("chan-never-seen");
  expect(made).toBe(0);
  expect((p.stats() as { sessions: number }).sessions).toBe(0);
});
