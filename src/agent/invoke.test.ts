/** Generic agent invoke-lane: runs ANY registered agent by its definition (issue #55/#72). */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Logger } from "../types.ts";
import {
  createAgentRunner,
  extractPostText,
  truncateAtWordBoundary,
  buildXPostBrowserTask,
  applyChillPass,
  composeXPostBrowserTask,
  X_POST_MAX_CHARS,
  type ChillPassDeps,
} from "./invoke.ts";
import { builtinAgentDefs, SOCIAL_MEDIA_AGENT_ID, X_SOCIAL_ACCOUNT } from "./builtins.ts";
import { chillTransform, type ChilltextConfig } from "../chilltext.ts";
import type { AgentDefinition } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quietLog = (() => {
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return logger; } };
  return logger as unknown as Logger;
})();

/** A stub harness that echoes its argv to stdout (so tests can assert the seat), or fails on FAILNOW. */
function writeStubBin(dir: string): string {
  const bin = join(dir, "claude-stub.sh");
  writeFileSync(
    bin,
    `#!/bin/bash
if printf '%s' "$*" | grep -q FAILNOW; then echo "stub failure" >&2; exit 5; fi
printf '%s\\n' "$@"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function makeConfig(dir: string): Config {
  return {
    paths: {
      beckett_dir: dir,
      db: "beckett.db",
      events_dir: "events",
      logs_dir: "logs",
      memory_dir: "memory",
      socket: "beckett.sock",
      spend: "spend.jsonl",
      projects: "projects",
    },
    harness: {
      claude: { bin: writeStubBin(dir), default_model: "fallback-model", permission_mode: "bypassPermissions", extra_flags: [] },
    },
  } as unknown as Config;
}

function makeDef(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "sample-agent",
    description: "d",
    systemPrompt: "SYSTEM-PROMPT-MARKER",
    model: { harness: "claude", model: "test-model", effort: "high" },
    skills: ["browser"],
    tools: [],
    persistent: false,
    builtin: true,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...over,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-invoke-"));
  dirs.push(dir);
  return createAgentRunner({ config: makeConfig(dir), logger: quietLog });
}

test("runs the agent's seat: prompt, model, effort, and permission mode all reach the harness", async () => {
  const runner = setup();
  const out = await runner.run(makeDef(), "author today's post");
  expect(out.state).toBe("done");
  expect(out.output).toContain("author today's post"); // the -p input
  expect(out.output).toContain("--append-system-prompt");
  expect(out.output).toContain("SYSTEM-PROMPT-MARKER");
  expect(out.output).toContain("--model");
  expect(out.output).toContain("test-model");
  expect(out.output).toContain("bypassPermissions");
  expect(out.output).toContain("--effort");
  expect(out.output).toContain("high");
});

test("the runner is generic — it runs whatever definition it is handed, not a hardcoded agent", async () => {
  const runner = setup();
  const a = await runner.run(makeDef({ id: "one", systemPrompt: "PROMPT-A", model: { harness: "claude", model: "model-a", effort: "" } }), "x");
  const b = await runner.run(makeDef({ id: "two", systemPrompt: "PROMPT-B", model: { harness: "claude", model: "model-b", effort: "low" } }), "x");
  expect(a.output).toContain("PROMPT-A");
  expect(a.output).toContain("model-a");
  expect(a.output).not.toContain("--effort"); // "" effort → harness default, flag omitted
  expect(b.output).toContain("PROMPT-B");
  expect(b.output).toContain("model-b");
  expect(b.output).toContain("low");
});

test("a blank model falls back to the harness default_model", async () => {
  const runner = setup();
  const out = await runner.run(makeDef({ model: { harness: "claude", model: "", effort: "" } }), "x");
  expect(out.output).toContain("fallback-model");
});

test("granted tools narrow the harness surface; none granted leaves it at defaults", async () => {
  const runner = setup();
  const withTools = await runner.run(makeDef({ tools: ["Read", "Edit"] }), "x");
  expect(withTools.output).toContain("--allowedTools");
  expect(withTools.output).toContain("Read,Edit");

  const noTools = await runner.run(makeDef({ tools: [] }), "x");
  expect(noTools.output).not.toContain("--allowedTools");
});

test("a non-zero harness exit is a clean error outcome, never a throw", async () => {
  const runner = setup();
  const out = await runner.run(makeDef(), "please FAILNOW");
  expect(out.state).toBe("error");
  expect(out.error).toContain("code 5");
});

test("an unsupported harness fails cleanly with a clear seam message", async () => {
  const runner = setup();
  const out = await runner.run(makeDef({ model: { harness: "codex", model: "m", effort: "" } }), "x");
  expect(out.state).toBe("error");
  expect(out.error).toMatch(/not spawnable/);
});

test("empty input is rejected before any spawn", async () => {
  const runner = setup();
  const out = await runner.run(makeDef(), "   ");
  expect(out.state).toBe("error");
  expect(out.error).toMatch(/non-empty/);
});

// ── POST: extraction (the new OUTPUT CONTRACT — agent authors only the text) ─────────────────

test("extractPostText pulls the text after a POST: first line", () => {
  expect(extractPostText("POST: deploys are just controlled chaos with extra steps")).toBe(
    "deploys are just controlled chaos with extra steps",
  );
});

test("extractPostText is case-insensitive and tolerates leading whitespace", () => {
  expect(extractPostText("  post:   lowercase prefix too")).toBe("lowercase prefix too");
});

test("extractPostText only honors the FIRST line — a stray second line is ignored, not appended", () => {
  expect(extractPostText("POST: the real post\nsome extra commentary the contract forbids")).toBe("the real post");
});

test("extractPostText returns null for legacy freeform output (no POST: line) — the back-compat seam", () => {
  expect(extractPostText("Go to https://x.com and post a new tweet...")).toBeNull();
  expect(extractPostText("")).toBeNull();
  expect(extractPostText("POST:")).toBeNull(); // prefix with nothing after it is not a post
});

// ── truncation ─────────────────────────────────────────────────────────────────────────────

test("truncateAtWordBoundary leaves short text untouched", () => {
  expect(truncateAtWordBoundary("short", 280)).toBe("short");
});

test("truncateAtWordBoundary cuts at the last space, never mid-word", () => {
  const text = "a".repeat(275) + " overflowsright here";
  const cut = truncateAtWordBoundary(text, 280);
  expect(cut.length).toBeLessThanOrEqual(280);
  expect(cut.endsWith("a")).toBe(true); // cut before "overflowsright", not inside it
  expect(text.startsWith(cut)).toBe(true);
});

// ── the browser-task template (built by CODE, not the agent) ─────────────────────────────────

test("buildXPostBrowserTask carries the account, the verbatim text, and every safety line", () => {
  const task = buildXPostBrowserTask(X_SOCIAL_ACCOUNT, "a genuinely unhinged opinion about tabs");
  expect(task).toContain("https://x.com");
  expect(task).toContain(X_SOCIAL_ACCOUNT);
  expect(task).toContain("already authenticated");
  expect(task).toContain("do not log in or touch any credential field");
  expect(task).toContain("a genuinely unhinged opinion about tabs");
  expect(task).toContain("confirm it went live and report the URL");
  expect(task).toContain("stop and report what you");
});

// ── the chill pass: fail-open, cap enforcement (fake chillTransform — no network) ────────────

function fakeDeps(impl: ChillPassDeps["chillTransform"]): ChillPassDeps {
  return { chillTransform: impl };
}

test("chill disabled: the draft ships as-is, chillTransform is never called", async () => {
  let called = false;
  const out = await applyChillPass(
    "the draft",
    false,
    fakeDeps(async () => {
      called = true;
      return { messages: ["should not be used"] };
    }),
  );
  expect(out).toBe("the draft");
  expect(called).toBe(false);
});

test("chill enabled: a transformed result within the cap is used", async () => {
  const out = await applyChillPass(
    "the original draft",
    true,
    fakeDeps(async (req) => {
      expect(req.agentOutput).toBe("the original draft");
      expect(req.single).toBe(true);
      expect(req.system).toContain("280 chars");
      return { messages: ["the chilled version"] };
    }),
  );
  expect(out).toBe("the chilled version");
});

test("fail-open: chillTransform returning null falls back to the draft", async () => {
  const out = await applyChillPass("the draft", true, fakeDeps(async () => null));
  expect(out).toBe("the draft");
});

test("fail-open: a rejecting chillTransform falls back to the draft, never throws", async () => {
  const out = await applyChillPass(
    "the draft",
    true,
    fakeDeps(async () => {
      throw new Error("chilltext is down");
    }),
  );
  expect(out).toBe("the draft");
});

test("280 cap: a transformed result over the cap falls back to the (in-range) draft", async () => {
  const draft = "a".repeat(200);
  const tooLong = "b".repeat(300);
  const out = await applyChillPass(draft, true, fakeDeps(async () => ({ messages: [tooLong] })));
  expect(out).toBe(draft);
  expect(out.length).toBeLessThanOrEqual(X_POST_MAX_CHARS);
});

test("280 cap: when even the draft is over cap, it is truncated at a word boundary", async () => {
  const draft = "word ".repeat(80).trim(); // way over 280
  const out = await applyChillPass(draft, true, fakeDeps(async () => null));
  expect(out.length).toBeLessThanOrEqual(X_POST_MAX_CHARS);
  expect(draft.startsWith(out)).toBe(true);
  expect(out.endsWith("word")).toBe(true); // cut on a word boundary
});

test("composeXPostBrowserTask wires the chill pass into the final template", async () => {
  const task = await composeXPostBrowserTask(
    "raw draft text",
    X_SOCIAL_ACCOUNT,
    true,
    fakeDeps(async () => ({ messages: ["chilled draft text"] })),
  );
  expect(task).toContain("chilled draft text");
  expect(task).not.toContain("raw draft text");
  expect(task).toContain(X_SOCIAL_ACCOUNT);
});

// ── the real chilltext.ts client, exercised through applyChillPass with a FAKE fetch ─────────
// (no network — Bounds forbid it; this proves the wiring against the documented /chill contract)

/** The `[concierge.chilltext]` slice the shared client takes, with only the url varied. */
function chillCfg(url: string): ChilltextConfig {
  return {
    enabled: true,
    url,
    timeout_ms: 2000,
    max_bubbles: 1,
    bubble_delay_ms: 0,
    system: "",
    skip_code_blocks: true,
  };
}

test("chilltext pass with a fake fetch: applies the transform end-to-end", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ output: "chilled", messages: ["deploys are chaos, actually"], n_bubbles: 1, ms: 12 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const out = await applyChillPass("deploys are chaos", true, {
    chillTransform: (req) => chillTransform(chillCfg("https://chilltext.example"), req, fakeFetch),
  });

  expect(out).toBe("deploys are chaos, actually");
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe("https://chilltext.example/chill");
  expect(calls[0]!.body).toMatchObject({ agentOutput: "deploys are chaos", single: true, max_bubbles: 1 });
});

test("chilltext pass with a fake fetch: a non-2xx response fails open to the draft", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ error: "model overloaded" }), { status: 503 })) as unknown as typeof fetch;
  const out = await applyChillPass("deploys are chaos", true, {
    chillTransform: (req) => chillTransform(chillCfg("https://chilltext.example"), req, fakeFetch),
  });
  expect(out).toBe("deploys are chaos");
});

test("chilltext pass with a fake fetch: a network error fails open to the draft", async () => {
  const fakeFetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const out = await applyChillPass("deploys are chaos", true, {
    chillTransform: (req) => chillTransform(chillCfg("https://chilltext.example"), req, fakeFetch),
  });
  expect(out).toBe("deploys are chaos");
});

test("the built-in social-media agent is pure data and runs through the same generic lane", async () => {
  const runner = setup();
  const def = builtinAgentDefs().find((a) => a.id === SOCIAL_MEDIA_AGENT_ID)!;
  const full: AgentDefinition = { ...def, createdAt: "t", updatedAt: "t" };
  const out = await runner.run(full, "compose today's shitpost");
  expect(out.state).toBe("done");
  // Its behavior lives entirely in the systemPrompt (data) — the browser-posting instructions
  // reach the harness, no bespoke code path.
  expect(out.output).toContain("@beckposting");
  expect(out.output).toContain("--append-system-prompt");
});
