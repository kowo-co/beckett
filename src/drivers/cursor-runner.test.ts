/**
 * Beckett — shim integration tests (`src/drivers/cursor-runner.test.ts`)
 * =======================================================================================
 * The WHOLE shim path, driven against a real git repo and a real spec.md with `@cursor/sdk`
 * mocked at the module boundary. Real files, real commits, real checklist parsing — only the
 * network is faked, and only because a quota wall cannot be produced on demand.
 *
 * The two failure points the design names are exercised as separate runs, because they leave
 * genuinely different state behind and it is the difference that matters:
 *
 *   - **before the first token** (`Agent.create` refuses): nothing on disk, no commit, no ticks
 *     reset — but a `quota` frame, a briefing, and a clean exit code, so the supervisor can change
 *     seats instead of parking a run that never started.
 *   - **mid-run, between checklist items** (the stream throws after edits and ticks): a real
 *     checkpoint commit, exactly this run's ticks reset, and a briefing naming both.
 *
 * Plus the two rules that decide WHICH of those happens: a transient blip is retried and survived,
 * and a transient that will not clear is escalated rather than retried forever.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CursorFrame } from "./cursor-protocol.ts";
import { CURSOR_HANDOFF_REL } from "./cursor-handoff.ts";
import { CHECKPOINT_COMMIT_MESSAGE, git } from "./cursor-checkpoint.ts";
import { SPEC_FILE_REL, parseSpecChecklist } from "../run/spec-file.ts";

// =======================================================================================
// The mocked SDK — a scripted agent, nothing more
// =======================================================================================

/** What the next `Agent.create` / `send` / stream should do. Set per test. */
interface Script {
  createThrows?: unknown[];
  /** Called with the turn text; returns the messages to stream, or throws. */
  onSend?: (turn: string, index: number) => AsyncGenerator<unknown> | never;
  /** Terminal result of each run, in order. */
  results?: Array<{ status: "finished" | "error" | "cancelled"; result?: string }>;
  catalogue?: unknown[];
  catalogueThrows?: unknown;
}
let script: Script = {};
let sends: string[] = [];
// Call counters live OUT here, not in the mock factory's closure: `mock.module` is evaluated once
// per process, so a counter inside it would leak across tests and every script after the first
// would be read at the wrong index.
let createCalls = 0;
let sendCalls = 0;

function err(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

async function* stream(messages: unknown[]): AsyncGenerator<unknown> {
  for (const m of messages) yield m;
}

mock.module("@cursor/sdk", () => {
  return {
    Cursor: {
      models: {
        list: async () => {
          if (script.catalogueThrows) throw script.catalogueThrows;
          return script.catalogue ?? [{ id: "default", displayName: "Auto", aliases: ["auto"], variants: [{ params: [], displayName: "Auto", isDefault: true }] }];
        },
      },
    },
    Agent: {
      create: async () => {
        const thrown = script.createThrows?.[createCalls];
        createCalls += 1;
        if (thrown) throw thrown;
        return agentStub();
      },
      resume: async () => agentStub(),
    },
  };

  function agentStub() {
    return {
      agentId: "agent-stub",
      close() {},
      async send(turn: string) {
        const index = sendCalls;
        sendCalls += 1;
        sends.push(turn);
        const messages = script.onSend ? script.onSend(turn, index) : stream([]);
        const result = script.results?.[index] ?? { status: "finished" as const, result: "" };
        return {
          id: `run-${index}`,
          stream: () => messages,
          wait: async () => ({ id: `run-${index}`, status: result.status, result: result.result }),
        };
      },
    };
  }
});

const { main, parseRunnerArgs } = await import("./cursor-runner.ts");

// =======================================================================================
// Harness
// =======================================================================================

let repo = "";
let frames: CursorFrame[] = [];
let restoreStdout: (() => void) | null = null;

function captureStdout(): void {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = "";
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string): boolean => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) {
        try {
          frames.push(JSON.parse(line) as CursorFrame);
        } catch {
          /* not one of ours */
        }
      }
    }
    return true;
  };
  restoreStdout = () => {
    (process.stdout as unknown as { write: typeof original }).write = original;
  };
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cursor-runner-"));
  git(["init", "-q", "-b", "beckett/run-thing"], dir);
  git(["config", "user.name", "Beckett Test"], dir);
  git(["config", "user.email", "beckett@example.test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# base\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "base"], dir);
  mkdirSync(join(dir, ".beckett"), { recursive: true });
  return dir;
}

function writeSpec(checklist: string): void {
  writeFileSync(
    join(repo, SPEC_FILE_REL),
    `# Thing\n> run: run-20260820-thing · branch: beckett/run-thing\n\n## Goal\ndo it\n\n## Checklist\n${checklist}\n\n## Notes\nscratch\n`,
  );
}

function readSpec(): string {
  return readFileSync(join(repo, SPEC_FILE_REL), "utf8");
}

function run(): Promise<number> {
  return main(["--workspace", repo, "--agent-id", "agent-stub", "--model", "cursor-auto"], {
    readPrompt: async () => ({ prompt: "implement the thing", systemAppend: "<persona>a worker</persona>" }),
    sleep: async () => {}, // no real backoff wait in tests; the RULE is what's under test, not the clock
  });
}

function framesOf<T extends CursorFrame["type"]>(type: T): Extract<CursorFrame, { type: T }>[] {
  return frames.filter((f) => f.type === type) as Extract<CursorFrame, { type: T }>[];
}

beforeEach(() => {
  repo = initRepo();
  frames = [];
  sends = [];
  createCalls = 0;
  sendCalls = 0;
  script = {};
  process.env.CURSOR_API_KEY = "probe-value-not-a-real-key";
  captureStdout();
});

afterEach(() => {
  restoreStdout?.();
  restoreStdout = null;
  rmSync(repo, { recursive: true, force: true });
});

// =======================================================================================
// The driver <-> shim argv contract
// =======================================================================================

describe("parseRunnerArgs", () => {
  test("the two required flags really are required — a silent default would be worse", () => {
    expect(() => parseRunnerArgs(["--agent-id", "a"])).toThrow(/--workspace is required/);
    expect(() => parseRunnerArgs(["--workspace", "/tmp/x"])).toThrow(/--agent-id is required/);
  });

  test("defaults match what `CursorDriver.buildArgs` omits", () => {
    expect(parseRunnerArgs(["--workspace", "/tmp/x", "--agent-id", "agent-1"])).toEqual({
      workspace: "/tmp/x",
      agentId: "agent-1",
      model: "",
      resume: false,
      // `plan` mode explores and drafts; it writes nothing, so an implementer seat is always `agent`.
      mode: "agent",
    });
  });

  test("resume and model ride through, and an unknown mode falls back to agent", () => {
    const args = parseRunnerArgs([
      "--workspace", "/tmp/x", "--agent-id", "agent-1", "--model", "cursor-auto", "--resume", "--mode", "nonsense",
    ]);
    expect(args).toMatchObject({ model: "cursor-auto", resume: true, mode: "agent" });
    expect(parseRunnerArgs(["--workspace", "/w", "--agent-id", "a", "--mode", "plan"]).mode).toBe("plan");
  });
});

// =======================================================================================
// The happy path — the seat actually implements
// =======================================================================================

describe("the shim's normal run", () => {
  test("handshake first, then tools and text, then a terminal result", async () => {
    writeSpec("- [x] do the thing");
    script.onSend = () =>
      stream([
        { type: "tool_call", call_id: "t1", name: "edit", status: "running", args: { path: join(repo, "src.ts") } },
        { type: "tool_call", call_id: "t1", name: "edit", status: "completed", args: { path: join(repo, "src.ts") } },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } },
      ]);
    script.results = [{ status: "finished", result: '{"done":true,"summary":"ok","filesChanged":[],"checksRun":null,"blocker":null}' }];

    expect(await run()).toBe(0);

    // The handshake is FIRST — before the credential is read, before the catalogue, before create.
    expect(frames[0]).toMatchObject({ type: "session", agentId: "agent-stub" });
    expect(framesOf("tool_start")).toHaveLength(1);
    // Paths are workspace-relative: local mode reports absolutes, and a briefing full of 90-char
    // worktree prefixes is unreadable.
    expect(framesOf("tool_end")[0]).toMatchObject({ name: "edit", isError: false, path: "src.ts" });
    expect(framesOf("usage")[0]).toMatchObject({ usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 } });
    expect(framesOf("result")[0]).toMatchObject({ status: "finished" });
    expect(framesOf("quota")).toHaveLength(0);
  });

  test("the persona rides in the first turn — the SDK has nowhere else to put it", async () => {
    writeSpec("- [x] done");
    script.onSend = () => stream([]);
    script.results = [{ status: "finished", result: "ok" }];
    await run();
    expect(sends[0]).toContain("<persona>a worker</persona>");
    expect(sends[0]).toContain("implement the thing");
  });

  test("Auto Balance being unavailable is REPORTED, not silently absorbed", async () => {
    writeSpec("- [x] done");
    script.onSend = () => stream([]);
    script.results = [{ status: "finished", result: "ok" }];
    await run();
    const logs = framesOf("log").map((f) => f.message).join(" ");
    expect(logs).toContain("does not offer the Auto Balance router variant");
    expect(logs).toContain("Auto Cost was NOT substituted");
  });

  test("the spec gate blocks a stop with unchecked boxes and sends the reason back", async () => {
    // `../hooks/spec-gate.ts` is a Claude Stop hook with no Cursor equivalent, so the shim
    // evaluates the same decision function and replies with the block — same rule, same effect.
    writeSpec("- [ ] not done yet");
    let call = 0;
    script.onSend = () => {
      call += 1;
      if (call === 2) writeSpec("- [x] not done yet"); // the worker complies on the second turn
      return stream([]);
    };
    script.results = [
      { status: "finished", result: "I'm done" },
      { status: "finished", result: "actually done now" },
    ];

    expect(await run()).toBe(0);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain("not done yet"); // the block reason names the unresolved item
    expect(framesOf("result")).toHaveLength(1);
    expect(framesOf("result")[0]).toMatchObject({ status: "finished", text: "actually done now" });
  });
});

// =======================================================================================
// Failure point 1 — before the first token
// =======================================================================================

describe("quota BEFORE the first token", () => {
  test("a refused create hands over cleanly instead of dying as a spawn failure", async () => {
    writeSpec("- [ ] one\n- [ ] two");
    script.createThrows = [err("You have hit your usage limit for this month", { status: 429, code: "usage_limit" })];

    // Exit 0, not 1: this is a routine seat change, not a crash.
    expect(await run()).toBe(0);

    // The handshake still went out first, which is what lets the driver report a terminal frame
    // rather than "the harness exited before its session handshake".
    expect(frames[0]!.type).toBe("session");
    const quota = framesOf("quota")[0]!;
    expect(quota).toMatchObject({ reason: expect.stringContaining("usage limit"), status: 429, code: "usage_limit" });
    // Nothing was on disk, so nothing was committed and no tick was touched.
    expect(quota.checkpoint).toBeUndefined();
    expect(git(["log", "--format=%s"], repo).stdout).toBe("base");
    expect(parseSpecChecklist(readSpec()).total).toBe(2);
    // The briefing still exists, so whoever picks this up knows why the seat changed.
    expect(readFileSync(join(repo, CURSOR_HANDOFF_REL), "utf8")).toContain("usage limit");
  });

  test("a refused catalogue read on quota also hands over — the wall can be hit that early", async () => {
    writeSpec("- [ ] one");
    script.catalogueThrows = err("Payment required", { status: 402 });
    expect(await run()).toBe(0);
    expect(framesOf("quota")[0]).toMatchObject({ status: 402 });
  });

  test("a BAD CREDENTIAL is not a quota wall — it fails, it does not change seats", async () => {
    writeSpec("- [ ] one");
    script.createThrows = [err("Invalid User API Key", { status: 401 })];
    expect(await run()).toBe(1);
    expect(framesOf("quota")).toHaveLength(0);
    expect(framesOf("result")[0]).toMatchObject({ status: "error" });
  });

  test("a bad model id is a CONFIG bug, reported as an error rather than a seat change", async () => {
    writeSpec("- [ ] one");
    script.createThrows = [err("Cannot use this model: nonsense. Available models: default, grok-4.6")];
    expect(await run()).toBe(1);
    expect(framesOf("quota")).toHaveLength(0);
  });
});

// =======================================================================================
// Failure point 2 — mid-run, between checklist items
// =======================================================================================

describe("quota MID-RUN, between checklist items", () => {
  test("the stream dies after real edits: commit, reset this run's ticks, brief the next seat", async () => {
    writeSpec("- [x] inherited\n- [ ] write the module\n- [ ] write the tests");
    script.onSend = () =>
      (async function* () {
        yield { type: "tool_call", call_id: "t1", name: "edit", status: "running", args: { path: join(repo, "module.ts") } };
        // The worker really writes the file and really ticks its box…
        writeFileSync(join(repo, "module.ts"), "export const m = 1;\n");
        writeSpec("- [x] inherited\n- [x] write the module\n- [ ] write the tests");
        yield { type: "tool_call", call_id: "t1", name: "edit", status: "completed", args: { path: join(repo, "module.ts") } };
        // …and then the wall lands, between checklist items.
        throw err("You have hit your usage limit", { status: 429, code: "usage_limit" });
      })();

    expect(await run()).toBe(0);

    const quota = framesOf("quota")[0]!;
    expect(quota.reason).toContain("usage limit");
    // 1 — the edit is committed. Nothing is left uncommitted for the next seat to lose.
    expect(quota.checkpoint).toMatch(/^[0-9a-f]{40}$/);
    expect(git(["log", "--format=%s"], repo).stdout.split("\n")[0]).toBe(CHECKPOINT_COMMIT_MESSAGE);
    expect(git(["show", "--name-only", "--format=", "HEAD"], repo).stdout).toContain("module.ts");
    expect(git(["status", "--porcelain"], repo).stdout).not.toContain("module.ts");

    // 2 — the tick THIS run added is reset; the inherited one is not ours to touch.
    const spec = parseSpecChecklist(readSpec());
    expect(spec.total).toBe(3); // every item survives
    expect(spec.items.find((i) => i.text === "inherited")?.done).toBe(true);
    expect(spec.items.find((i) => i.text === "write the module")?.done).toBe(false);

    // 3 — the briefing names what happened, with the raw shape and the checkpoint.
    const handoff = readFileSync(join(repo, CURSOR_HANDOFF_REL), "utf8");
    expect(handoff).toContain("- write the module");
    expect(handoff).toContain("HTTP 429");
    expect(handoff).toContain(quota.checkpoint!);
    expect(handoff).toContain("- edit: module.ts"); // relative, readable
  });

  test("a mid-run quota still ships the tokens it spent, so telemetry stays honest", async () => {
    writeSpec("- [ ] a");
    script.onSend = () =>
      (async function* () {
        yield { type: "usage", usage: { inputTokens: 5_000, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0 } };
        throw err("usage limit reached", { status: 429 });
      })();
    await run();
    expect(framesOf("usage")[0]).toMatchObject({ usage: { input: 5_000, output: 200, cacheRead: 100, cacheWrite: 0 } });
    expect(framesOf("quota")).toHaveLength(1);
  });
});

// =======================================================================================
// The rule that decides which of the two happens
// =======================================================================================

describe("transient vs quota", () => {
  test("a blip is retried and survived — one bad response is not a seat change", async () => {
    writeSpec("- [x] done");
    script.createThrows = [err("Service Unavailable", { status: 503 })];
    script.onSend = () => stream([]);
    script.results = [{ status: "finished", result: "ok" }];

    expect(await run()).toBe(0);
    expect(framesOf("quota")).toHaveLength(0);
    expect(framesOf("result")[0]).toMatchObject({ status: "finished" });
    expect(framesOf("log").some((f) => f.message.includes("retry 1/2"))).toBe(true);
  });

  test("a transient that will not clear is ESCALATED to quota, never retried forever", async () => {
    // The deliberate fail-safe: Cursor documents no way to tell a spent allowance from a
    // persistent 5xx. Wedging a run against a wall that will not move is far worse than one free
    // handoff to a seat that also works.
    writeSpec("- [ ] a");
    const blip = err("Service Unavailable", { status: 503 });
    script.createThrows = [blip, blip, blip];

    expect(await run()).toBe(0);
    const quota = framesOf("quota")[0]!;
    expect(quota.reason).toContain("failed 3 times with the same error");
    expect(quota.reason).toContain("treated as quota exhaustion");
    // The RAW shape rides along, so the first real production wall is what tightens the rule.
    expect(quota.status).toBe(503);
    expect(readFileSync(join(repo, CURSOR_HANDOFF_REL), "utf8")).toContain("HTTP 503");
  });
});
