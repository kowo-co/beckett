/**
 * Coverage for the PiDriver's event normalizer (`src/drivers/pi.ts`). The parser is the risky
 * part — it maps pi's `--mode json` NDJSON into Beckett's {@link WorkerEvent} stream — so it's
 * Also guards the OPS-56 / issue #12 regression: the modern session argv (`--session-id` for a
 * caller-minted first launch) and the preflight that catches stale CLI/version drift.
 *
 * pinned here against event lines copied from a real pi JSON run (session →
 * tool_execution → assistant message → agent_end), rather than trusting a live spawn. `handleLine`
 * is driven directly; spawn/process lifecycle is out of scope for a unit test.
 */

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiDriver, piPreflight } from "./pi.ts";
import { probeCommand } from "./preflight-probe.ts";
import type { Config, WorkerEvent } from "../types.ts";

/** Minimal config exposing just what the parser reads. */
const config = {
  harness: {
    pi: { enabled: true, bin: "pi", default_provider: "openai-codex", default_model: "gpt-5.6-terra", thinking: "high" },
  },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

/** A driver with a collector attached; feed it raw JSON lines via handleLine. */
function harness() {
  const events: WorkerEvent[] = [];
  const driver = new PiDriver(config, quietLog);
  driver.onEvent((e) => events.push(e));
  const feed = (obj: unknown) => driver.handleLine(JSON.stringify(obj));
  return { driver, events, feed };
}

const CALL = "call_abc|fc_def";

test("normalizes a full pi run: session → tool → assistant → agent_end", () => {
  const { events, feed } = harness();

  feed({ type: "session", version: 3, id: "019f1c8b-0f77-7a29-b896-6a00ec141c14", cwd: "/x" });
  feed({ type: "agent_start" });
  feed({ type: "turn_start" });
  feed({ type: "tool_execution_start", toolCallId: CALL, toolName: "bash", args: { command: "echo hi" } });
  feed({ type: "tool_execution_end", toolCallId: CALL, toolName: "bash", result: { content: [] }, isError: false });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"status":"complete","summary":"did the thing","filesChanged":["a.ts"],"checksRun":null,"blockedReason":null}' }],
      usage: { input: 2539, output: 22, cacheRead: 0, cacheWrite: 0 },
    },
  });
  feed({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 2539, output: 22, cacheRead: 5, cacheWrite: 0 } }, toolResults: [] });
  feed({ type: "agent_end", messages: [] });

  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain("session_started");
  expect(kinds).toContain("turn_started");
  expect(kinds).toContain("tool_call");
  expect(kinds).toContain("tool_result");
  expect(kinds).toContain("assistant_text");
  expect(kinds).toContain("turn_completed");
  expect(kinds).toContain("finished");

  const session = events.find((e) => e.kind === "session_started");
  // Un-cast run resolves the config default — now gpt-5.6-terra (was gpt-5.5).
  expect(session).toMatchObject({ sessionId: "019f1c8b-0f77-7a29-b896-6a00ec141c14", model: "gpt-5.6-terra" });

  const call = events.find((e) => e.kind === "tool_call");
  expect(call).toMatchObject({ tool: "bash", toolId: CALL });
  expect((call as { input: { command: string } }).input.command).toBe("echo hi");

  const result = events.find((e) => e.kind === "tool_result");
  expect(result).toMatchObject({ toolId: CALL, isError: false });

  const usage = events.find((e) => e.kind === "turn_completed") as { usage: { input: number; cacheRead: number } };
  expect(usage.usage.input).toBe(2539);
  expect(usage.usage.cacheRead).toBe(5); // pi cacheRead → TokenUsage.cacheRead

  // agent_end → success finish, with the done-signal parsed out of the final assistant message.
  const fin = events.find((e) => e.kind === "finished") as {
    status: string;
    structuredOutput: { status: string; summary: string } | null;
  };
  expect(fin.status).toBe("success");
  expect(fin.structuredOutput).toMatchObject({ status: "complete", summary: "did the thing" });
});

// ── OPS-108: explicit gpt-5.6-terra / gpt-5.6-luna casts run end-to-end. ──
// A cast may pin an explicit model; pi carries it via `--model` on the openai-codex (codex 0.144)
// path. These prove a terra cast AND a luna cast each: emit the right argv, echo the model on the
// session line, and drive a full session→tool→assistant→agent_end run to a clean success finish.
function castRun(model: string) {
  const events: WorkerEvent[] = [];
  const driver = new PiDriver(config, quietLog);
  driver.onEvent((e) => events.push(e));
  const priv = driver as unknown as {
    spec: unknown;
    sessionId: string | null;
    buildArgs(prompt: string, isResume: boolean): string[];
  };
  // The cast supplies an explicit model; the envelope effort maps onto pi's --thinking.
  priv.spec = { model, envelope: { effort: "medium" } };
  priv.sessionId = "cafe1234-0000-0000-0000-000000000000";
  const args = priv.buildArgs("do the thing", /*isResume*/ false);
  const feed = (obj: unknown) => driver.handleLine(JSON.stringify(obj));
  feed({ type: "session", id: "sess-1", cwd: "/x" });
  feed({ type: "turn_start" });
  feed({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "true" } });
  feed({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"status":"complete","summary":"done","filesChanged":[],"checksRun":null,"blockedReason":null}' }],
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    },
  });
  feed({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 100, output: 10, cost: { total: 0.01 } } }, toolResults: [] });
  feed({ type: "agent_end", messages: [] });
  return { args, events };
}

for (const model of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
  test(`an explicit ${model} pi cast runs end to end via codex (openai-codex)`, () => {
    const { args, events } = castRun(model);

    // argv: the explicit cast model is passed via --model on the openai-codex (codex 0.144) path.
    const mi = args.indexOf("--model");
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(args[mi + 1]).toBe(model);
    const pi = args.indexOf("--provider");
    expect(args[pi + 1]).toBe("openai-codex");
    const th = args.indexOf("--thinking");
    expect(args[th + 1]).toBe("medium"); // cast effort maps onto --thinking, unchanged

    // the session line echoes the cast model, and the run finishes as a clean success.
    const session = events.find((e) => e.kind === "session_started");
    expect(session).toMatchObject({ model });
    const fin = events.find((e) => e.kind === "finished") as {
      status: string;
      structuredOutput: { done: boolean } | null;
    };
    expect(fin.status).toBe("success");
    expect(fin.structuredOutput).toMatchObject({ status: "complete" });
  });
}

test("a failed tool is surfaced as an errored tool_result", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "false" } });
  feed({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: true });
  const result = events.find((e) => e.kind === "tool_result");
  expect(result).toMatchObject({ toolId: "t1", isError: true });
});

test("an edit/write tool synthesizes a file_change (pi has no native file event)", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "tool_execution_start", toolCallId: "w1", toolName: "write", args: { path: "src/new.ts" } });
  feed({ type: "tool_execution_end", toolCallId: "w1", toolName: "write", result: {}, isError: false });
  const fc = events.find((e) => e.kind === "file_change") as { paths: { path: string; kind: string }[] } | undefined;
  expect(fc).toBeDefined();
  expect(fc!.paths[0]).toMatchObject({ path: "src/new.ts", kind: "update" });
});

test("done-signal parses from a ```json fenced block (lenient)", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: 'Here is my result:\n```json\n{"status":"blocked","summary":"needs a key","blockedReason":"no PAT"}\n```\nlet me know.' }],
    },
  });
  feed({ type: "agent_end", messages: [] });
  const fin = events.find((e) => e.kind === "finished") as { structuredOutput: { status: string } | null };
  expect(fin.structuredOutput).toMatchObject({ status: "blocked" });
});

test("a run whose last turn died on a provider error finishes as ERROR, not empty success", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "turn_start" });
  // The exact shape pi emits when auth is missing/expired: an empty assistant message carrying
  // stopReason:"error", then a clean agent_end. Without the runError guard this finished as an
  // instant empty "success" and the dispatcher advanced the ticket on nothing.
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "No API key for provider: openai-codex",
    },
  });
  feed({ type: "turn_end", message: { role: "assistant", content: [], stopReason: "error" }, toolResults: [] });
  feed({ type: "agent_end", messages: [], willRetry: false });

  const err = events.find((e) => e.kind === "error");
  expect(err).toMatchObject({ message: "No API key for provider: openai-codex" });
  const fin = events.find((e) => e.kind === "finished") as {
    status: string;
    subtype: string;
    errorClass?: string;
    structuredOutput: { done: boolean } | null;
  };
  expect(fin.status).toBe("error");
  expect(fin.subtype).toBe("error_provider");
  expect(fin.errorClass).toBe("auth"); // "no api key" classifies as auth → dispatcher holds, no blind retry
  expect(fin.structuredOutput).toMatchObject({ done: false, blocker: { class: "transient" } });
});

test("a transient errored turn followed by a successful one still finishes as success", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" },
  });
  feed({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "recovered and done" }] },
  });
  feed({ type: "agent_end", messages: [] });
  const fin = events.find((e) => e.kind === "finished") as { status: string };
  expect(fin.status).toBe("success");
});

// ── #159: the zero-tool-call no-op run. ──
// Captured from a live `pi -p --mode json --provider openai-codex` run whose provider refused
// turn one (reproduce with `--model gpt-5-codex`, which a ChatGPT-account tier rejects): pi exits
// 0 and emits a clean agent_end, so nothing about the PROCESS says the run failed. 93 implement
// runs in ~/.beckett/spend.jsonl look exactly like this.
test("#159: a run that reaches agent_end having done NOTHING fails as a launch failure", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "turn_start" });
  // No message_end at all — the shape the runError guard cannot see. Only the OUTCOME (no tokens,
  // no tools, no text) betrays that the harness never worked.
  feed({ type: "agent_end", messages: [] });

  const fin = events.find((e) => e.kind === "finished") as {
    status: string;
    subtype: string;
    errorClass?: string;
    structuredOutput: { done: boolean } | null;
  };
  expect(fin.status).toBe("error"); // NOT a silent ~$0 success
  expect(fin.subtype).toBe("error_noop");
  expect(fin.errorClass).toBe("crash"); // unclassified → the dispatcher's bounded retry
  expect(fin.structuredOutput).toMatchObject({ done: false, blocker: { class: "transient" } });
  const err = events.find((e) => e.kind === "error") as { message: string };
  expect(err.message).toContain("LAUNCH FAILURE");
});

test("#159: the quota refusal — 1 turn, 0 tools, 0 tokens — is classed rate_limit, not success", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "turn_start" });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "error",
      errorMessage: "Codex error: The usage limit has been reached",
    },
  });
  feed({ type: "agent_end", messages: [] });

  const fin = events.find((e) => e.kind === "finished") as { status: string; errorClass?: string };
  expect(fin.status).toBe("error");
  // rate_limit is what arms the #133 harness cooldown and the substitute-to-claude path.
  expect(fin.errorClass).toBe("rate_limit");
});

test("#159: a short but REAL run (tokens spent, text produced) still succeeds", () => {
  const { events, feed } = harness();
  feed({ type: "session", id: "s1" });
  feed({ type: "turn_start" });
  feed({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"status":"complete","summary":"nothing to change"}' }],
      usage: { input: 900, output: 12, cacheRead: 0, cacheWrite: 0 },
    },
  });
  feed({ type: "turn_end", message: { role: "assistant", content: [], usage: { input: 900, output: 12 } } });
  feed({ type: "agent_end", messages: [] });

  const fin = events.find((e) => e.kind === "finished") as { status: string };
  expect(fin.status).toBe("success");
});

test("a malformed line becomes kind:unknown, never throws", () => {
  const { events, feed, driver } = harness();
  expect(() => driver.handleLine("not json at all {{{")).not.toThrow();
  expect(events.some((e) => e.kind === "unknown")).toBe(true);
});

test("kind is the pi-cli-stream driver tag", () => {
  const { driver } = harness();
  expect(driver.kind).toBe("pi-cli-stream");
});

// ── issue #12: modern pi session argv. ──
// buildArgs is private; drive it via bracket access with a stubbed session id + spec.
function argsFor(isResume: boolean, sessionId: string | null): string[] {
  const driver = new PiDriver(config, quietLog) as unknown as {
    sessionId: string | null;
    spec: unknown;
    buildArgs(prompt: string, isResume: boolean): string[];
  };
  driver.sessionId = sessionId;
  driver.spec = { envelope: { effort: "high" } };
  return driver.buildArgs("do the thing", isResume);
}

test("first launch pins Beckett's caller-minted id with --session-id", () => {
  const id = "cafe1234-0000-0000-0000-000000000000";
  const args = argsFor(/*isResume*/ false, id);
  const i = args.indexOf("--session-id");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe(id);
  expect(args).not.toContain("--session");
  expect(args).toContain("--mode");
  expect(args).toContain("json");
  expect(args[args.length - 1]).toBe("do the thing"); // prompt is the trailing positional
});

test("resume pins the existing id with --session <id>", () => {
  const id = "cafe1234-0000-0000-0000-000000000000";
  const args = argsFor(/*isResume*/ true, id);
  expect(args).not.toContain("--session-id");
  const i = args.indexOf("--session");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe(id);
});

// ── OPS-56: preflight catches a broken/absent pi harness loudly. ──
test("preflight FAILS loudly for a missing binary (no silent code-1)", async () => {
  const badConfig = {
    harness: { pi: { ...(config.harness as { pi: object }).pi, bin: "definitely-not-a-real-pi-binary-xyz" } },
  } as unknown as Config;
  const pf = await piPreflight(badConfig);
  expect(pf.ok).toBe(false);
  expect(pf.problems.length).toBeGreaterThan(0);
  expect(pf.problems.join(" ")).toContain("definitely-not-a-real-pi-binary-xyz");
});

test("preflight rejects stale pi without --session-id support", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-old-pi-"));
  const oldHome = process.env.HOME;
  try {
    const bin = join(dir, "pi-old");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  --version) echo 0.72.1 ;;",
        "  --help) echo '--mode --session --print' ;;",
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(bin, 0o755);
    const authDir = join(dir, ".pi/agent");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), '{"openai-codex":{}}\n', "utf8");
    process.env.HOME = dir;

    const oldConfig = {
      harness: { pi: { ...(config.harness as { pi: object }).pi, bin } },
    } as unknown as Config;
    const pf = await piPreflight(oldConfig);
    expect(pf.ok).toBe(false);
    expect(pf.problems.join(" ")).toContain("need >=0.78.0");
    expect(pf.problems.join(" ")).toContain("--session-id");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight rejects Node below the current Pi package's 22.19 floor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-old-node-"));
  const oldHome = process.env.HOME;
  try {
    const localBin = join(dir, ".local/bin");
    mkdirSync(localBin, { recursive: true });
    const node = join(localBin, "node");
    writeFileSync(node, "#!/bin/sh\necho v22.18.0\n", "utf8");
    chmodSync(node, 0o755);

    const pi = join(localBin, "pi");
    writeFileSync(
      pi,
      [
        "#!/bin/sh",
        'case "$1" in',
        "  --version) echo 0.80.6 ;;",
        "  --help) echo '--mode --session --session-id --print --no-extensions --no-skills --no-themes' ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(pi, 0o755);
    const authDir = join(dir, ".pi/agent");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), '{"openai-codex":{}}\n', "utf8");
    process.env.HOME = dir;

    const testConfig = {
      harness: { pi: { ...(config.harness as { pi: object }).pi, bin: "pi" } },
    } as unknown as Config;
    const pf = await piPreflight(testConfig);
    expect(pf.ok).toBe(false);
    expect(pf.nodeVersion).toBe("v22.18.0");
    expect(pf.problems.join(" ")).toContain("node >=22.19.0");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── issue #54: a timed-out probe must NOT be misread as a broken pi. ──

test("probeCommand classifies a KILLED (timed-out) probe as timedOut, not a failure — and retries", () => {
  // A child that outlives every budget is killed each time; probeCommand must report the KILL
  // (exitCode null) as timedOut, escalate through both budgets, and land on the larger budget.
  const r = probeCommand(["sh", "-c", "sleep 5"], process.env, { budgets: [150, 250] });
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).toBeNull();
  expect(r.attempts).toBe(2); // starved once, retried at the longer budget
  expect(r.budgetMs).toBe(250); // reports the FINAL (largest) budget it gave up on
  expect(r.signalCode).toBeTruthy();
});

test("probeCommand classifies a real non-zero exit as a failure, NOT a timeout (no retry)", () => {
  // A binary that ran and chose to exit non-zero is genuinely broken — a longer budget won't help,
  // so it must return immediately with the real exit code and timedOut=false.
  const r = probeCommand(["sh", "-c", "echo boom >&2; exit 3"], process.env, { budgets: [2000, 4000] });
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(false);
  expect(r.exitCode).toBe(3);
  expect(r.attempts).toBe(1); // a real fault is not retried
  expect(r.stderr).toContain("boom");
});

test("preflight reports a real non-zero `pi --version` exit as an EXIT, not a timeout", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-broken-pi-"));
  const oldHome = process.env.HOME;
  try {
    const bin = join(dir, "pi-broken");
    writeFileSync(bin, "#!/bin/sh\necho 'pi: fatal' >&2\nexit 1\n", "utf8");
    chmodSync(bin, 0o755);
    const authDir = join(dir, ".pi/agent");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), '{"openai-codex":{}}\n', "utf8");
    process.env.HOME = dir;

    const brokenConfig = {
      harness: { pi: { ...(config.harness as { pi: object }).pi, bin } },
    } as unknown as Config;
    return piPreflight(brokenConfig).then((pf) => {
      expect(pf.ok).toBe(false);
      const joined = pf.problems.join(" ");
      // The genuine-fault branch: names the exit code, and must NOT claim a timeout.
      expect(joined).toContain("exited 1");
      expect(joined).not.toContain("TIMED OUT");
    });
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #159: preflight must not bless a login that dies on turn one. ──
/** Run piPreflight against a stub pi + a caller-supplied auth.json body. */
async function preflightWithAuth(authBody: string): Promise<{ ok: boolean; problems: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "beckett-pi-auth-"));
  const oldHome = process.env.HOME;
  try {
    const localBin = join(dir, ".local/bin");
    mkdirSync(localBin, { recursive: true });
    const node = join(localBin, "node");
    writeFileSync(node, "#!/bin/sh\necho v22.19.0\n", "utf8");
    chmodSync(node, 0o755);
    const pi = join(localBin, "pi");
    writeFileSync(
      pi,
      [
        "#!/bin/sh",
        'case "$1" in',
        "  --version) echo 0.82.1 ;;",
        "  --help) echo '--mode --session --session-id --print --no-extensions --no-skills --no-themes' ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(pi, 0o755);
    const authDir = join(dir, ".pi/agent");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), authBody, "utf8");
    process.env.HOME = dir;
    const pf = await piPreflight({
      harness: { pi: { ...(config.harness as { pi: object }).pi, bin: "pi" } },
    } as unknown as Config);
    return { ok: pf.ok, problems: pf.problems };
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#159: preflight rejects an auth.json with no credential for the provider", async () => {
  // The old check was `auth.includes(provider)` over the raw file, so this PASSED — and the run
  // then died on turn one with "No API key for provider: openai-codex", 0 tools, 0 tokens.
  const pf = await preflightWithAuth('{"openrouter":{"key":"sk-x"},"note":"openai-codex removed"}\n');
  expect(pf.ok).toBe(false);
  expect(pf.problems.join(" ")).toContain("no credential for provider openai-codex");
});

test("#159: preflight rejects an empty credential for the provider", async () => {
  const pf = await preflightWithAuth('{"openai-codex":{"type":"oauth","access":"   "}}\n');
  expect(pf.ok).toBe(false);
  expect(pf.problems.join(" ")).toContain("EMPTY credential");
});

test("#159: an expired token WITH a refresh token is not a preflight failure (pi renews it)", async () => {
  const pf = await preflightWithAuth(
    `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n`,
  );
  expect(pf.problems.join(" ")).not.toContain("expired");
  expect(pf.ok).toBe(true);
});

test("#159: an expired token with NO refresh token fails loudly", async () => {
  const pf = await preflightWithAuth(`{"openai-codex":{"type":"oauth","access":"a","expires":1}}\n`);
  expect(pf.ok).toBe(false);
  expect(pf.problems.join(" ")).toContain("expired");
});

test("#159: an auth.json in an unrecognized shape falls back to the old substring check", async () => {
  const pf = await preflightWithAuth("openai-codex = { access = 'a' }\n"); // not JSON
  expect(pf.ok).toBe(true);
});

// ── issue #31: config & telemetry truthfulness. ──
test("turn_end usage.cost.total accumulates into getTelemetry().usdEstimate", () => {
  const { driver, feed } = harness();
  feed({
    type: "turn_end",
    message: { role: "assistant", content: [], usage: { input: 100, output: 10, cost: { total: 0.0125 } } },
    toolResults: [],
  });
  feed({
    type: "turn_end",
    message: { role: "assistant", content: [], usage: { input: 200, output: 20, cost: { total: 0.025 } } },
    toolResults: [],
  });
  expect(driver.getTelemetry().usdEstimate).toBeCloseTo(0.0375, 6);
});

test("usdEstimate stays null when pi reports no cost", () => {
  const { driver, feed } = harness();
  feed({
    type: "turn_end",
    message: { role: "assistant", content: [], usage: { input: 100, output: 10 } },
    toolResults: [],
  });
  expect(driver.getTelemetry().usdEstimate).toBeNull();
});

test("worker env is pinned: --no-extensions --no-skills --no-themes on every launch", () => {
  for (const isResume of [false, true]) {
    const args = argsFor(isResume, "cafe1234-0000-0000-0000-000000000000");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-themes");
  }
});

test("un-cast worker falls back to config.harness.pi.thinking for --thinking", () => {
  const driver = new PiDriver(config, quietLog) as unknown as {
    sessionId: string | null;
    spec: unknown;
    buildArgs(prompt: string, isResume: boolean): string[];
  };
  driver.sessionId = null;
  driver.spec = { envelope: {} }; // no cast effort
  const args = driver.buildArgs("go", false);
  const i = args.indexOf("--thinking");
  expect(args[i + 1]).toBe("high"); // the config default, not claude's
});

test("process-exit diagnostics include the stderr tail", () => {
  const driver = new PiDriver(config, quietLog) as unknown as {
    stderrRing: { record(text: string): void };
    processExitMessage(code: number): string;
    spawnFailureError(reason: string | number): Error;
  };
  driver.stderrRing.record("first line\nunknown option: --session-id");
  const exit = driver.processExitMessage(1);
  expect(exit).toContain("unknown option: --session-id");
  const startup = driver.spawnFailureError("code 1");
  expect(startup.message).toContain("unknown option: --session-id");
});
