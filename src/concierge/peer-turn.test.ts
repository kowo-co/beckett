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
