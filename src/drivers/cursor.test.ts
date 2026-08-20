/**
 * Beckett — cursor seat tests (`src/drivers/cursor.test.ts`)
 * =======================================================================================
 * Four things this seat has to get right, and one it must never do:
 *
 *   1. Auto Balance is REQUESTED and then VERIFIED — never assumed, and never quietly swapped for
 *      Auto Cost (which the owner ruled out by name).
 *   2. A spent monthly allowance is told apart from a busy API, because they need opposite
 *      responses: change seats vs back off.
 *   3. The shim's frames land as the same normalized `WorkerEvent`s every other driver emits.
 *   4. A quota exit reports `errorClass: "quota"`, distinct from `rate_limit`, because
 *      `../run/supervisor.ts` routes the two completely differently.
 *
 * The parser is driven directly through `handleLine` (the pi/claude test pattern) so nothing here
 * spawns a process, touches the network, or loads `@cursor/sdk`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CursorDriver, cursorPreflight, CURSOR_API_KEY_ENV } from "./cursor.ts";
import { classifyCursorError, isRetryableKind, pathFromToolArgs } from "./cursor-protocol.ts";
import {
  assertNotCostOptimized,
  offersVariant,
  resolveCursorSelection,
  type CursorCatalogueItem,
} from "./cursor-model.ts";
import { defaultConfig } from "../config.ts";
import type { SpawnSpec, WorkerEvent } from "../types.ts";

// =======================================================================================
// Fixtures
// =======================================================================================

/**
 * The Auto row this account ACTUALLY returns, captured verbatim from `GET /v1/models` on
 * 2026-08-19. One variant, no params: there is no Router on an individual Pro plan.
 */
const LIVE_AUTO_ROW: CursorCatalogueItem = {
  id: "default",
  displayName: "Auto",
  aliases: ["auto"],
  variants: [{ params: [], displayName: "Auto", isDefault: true }],
};

/** What the row would look like if Cursor enabled Router here — the case we want to start using. */
const ROUTER_AUTO_ROW: CursorCatalogueItem = {
  id: "default",
  displayName: "Auto",
  aliases: ["auto"],
  parameters: [
    { id: "optimize_for", values: [{ value: "cost" }, { value: "balanced" }, { value: "intelligence" }] },
  ],
  variants: [
    { params: [{ id: "optimize_for", value: "cost" }], displayName: "Auto Cost" },
    { params: [{ id: "optimize_for", value: "balanced" }], displayName: "Auto Balance", isDefault: true },
  ],
};

function newDriver(): { driver: CursorDriver; events: WorkerEvent[] } {
  const driver = new CursorDriver(defaultConfig());
  const events: WorkerEvent[] = [];
  driver.onEvent((e) => events.push(e));
  return { driver, events };
}

/** Feed frames straight into the parser. `spec` is set so telemetry's diff stat has a workspace. */
function feed(driver: CursorDriver, frames: unknown[]): void {
  for (const frame of frames) driver.handleLine(JSON.stringify(frame));
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-cursor-"));
  return dir;
}

// =======================================================================================
// 1 — Auto Balance: asked for, verified, never silently downgraded to Auto Cost
// =======================================================================================

describe("cursor model selection (the Auto Balance question)", () => {
  test("this account's real catalogue does not offer Balance, so we run plain Auto and SAY so", () => {
    const resolved = resolveCursorSelection("cursor-auto", [LIVE_AUTO_ROW]);
    expect(resolved.selection).toEqual({ id: "default" });
    expect(resolved.balanced).toBe(false);
    expect(resolved.label).toBe("Auto");
    // The note is the whole point: a degraded selection that reports nothing is the silent
    // substitution this module exists to prevent.
    expect(resolved.note).toContain("does not offer the Auto Balance router variant");
    expect(resolved.note).toContain("Auto Cost was NOT substituted");
  });

  test("Balance is requested the moment the account actually offers it — no code change needed", () => {
    const resolved = resolveCursorSelection("cursor-auto", [ROUTER_AUTO_ROW]);
    expect(resolved.selection).toEqual({
      id: "default",
      params: [{ id: "optimize_for", value: "balanced" }],
    });
    expect(resolved.balanced).toBe(true);
    expect(resolved.note).toBeUndefined();
  });

  test("an unreadable catalogue degrades to plain Auto rather than ASSUMING Balance", () => {
    const resolved = resolveCursorSelection("cursor-auto", []);
    expect(resolved.selection).toEqual({ id: "default" });
    expect(resolved.balanced).toBe(false);
    expect(resolved.note).toContain("could not read the model catalogue");
  });

  test("Auto Cost can never be requested, whatever the catalogue offers", () => {
    // The catalogue below advertises Cost as its DEFAULT variant. We still take Balance.
    const costFirst: CursorCatalogueItem = {
      ...ROUTER_AUTO_ROW,
      variants: [
        { params: [{ id: "optimize_for", value: "cost" }], displayName: "Auto Cost", isDefault: true },
        { params: [{ id: "optimize_for", value: "balanced" }], displayName: "Auto Balance" },
      ],
    };
    expect(resolveCursorSelection("cursor-auto", [costFirst]).selection.params).toEqual([
      { id: "optimize_for", value: "balanced" },
    ]);
    // And the belt: a hand-edited config cannot smuggle it past the shim either.
    expect(() => assertNotCostOptimized({ id: "default", params: [{ id: "optimize_for", value: "cost" }] })).toThrow(
      /Auto Cost is ruled out/,
    );
    expect(() => assertNotCostOptimized({ id: "default" })).not.toThrow();
  });

  test("`offersVariant` needs BOTH the declared parameter and a shipped variant", () => {
    // The dangerous middle case, observed live: `Agent.create` ACCEPTS an undeclared param and
    // silently drops it. A row that declares the knob but ships no variant carrying the value
    // (or vice versa) must not count as support.
    const declaredOnly: CursorCatalogueItem = {
      id: "default",
      parameters: [{ id: "optimize_for", values: [{ value: "balanced" }] }],
      variants: [{ params: [], displayName: "Auto" }],
    };
    const variantOnly: CursorCatalogueItem = {
      id: "default",
      variants: [{ params: [{ id: "optimize_for", value: "balanced" }], displayName: "Auto Balance" }],
    };
    expect(offersVariant(declaredOnly, "optimize_for", "balanced")).toBe(false);
    expect(offersVariant(variantOnly, "optimize_for", "balanced")).toBe(false);
    expect(offersVariant(ROUTER_AUTO_ROW, "optimize_for", "balanced")).toBe(true);
  });

  test("an explicitly cast cursor model is honoured, and a typo fails with the roster in hand", () => {
    const catalogue = [LIVE_AUTO_ROW, { id: "grok-4.6", displayName: "Cursor Grok 4.6" }];
    expect(resolveCursorSelection("grok-4.6", catalogue).selection).toEqual({ id: "grok-4.6" });
    expect(() => resolveCursorSelection("grok-9.9", catalogue)).toThrow(/not available on this account/);
    expect(() => resolveCursorSelection("grok-9.9", catalogue)).toThrow(/default, grok-4.6/);
  });
});

// =======================================================================================
// 2 — "the month is spent" vs "the API is busy"
// =======================================================================================

describe("cursor failure classification", () => {
  test("a spent allowance is quota, whatever status carries it", () => {
    expect(classifyCursorError({ message: "You have hit your usage limit for this month" })).toBe("quota");
    expect(classifyCursorError({ message: "Not enough credits remaining" })).toBe("quota");
    expect(classifyCursorError({ message: "quota exceeded", status: 429 })).toBe("quota");
    expect(classifyCursorError({ message: "Payment required", status: 402 })).toBe("quota");
    // The backend's own retry flag, off, on a 429 IS the hard-cap signal.
    expect(classifyCursorError({ message: "Too many requests", status: 429, isRetryable: false })).toBe("quota");
  });

  test("an ordinary transient 429 or 5xx is NOT quota — it must back off, not change seats", () => {
    expect(classifyCursorError({ message: "Too many requests", status: 429 })).toBe("transient");
    expect(classifyCursorError({ message: "Too many requests", status: 429, isRetryable: true })).toBe("transient");
    expect(classifyCursorError({ message: "Service Unavailable", status: 503 })).toBe("transient");
    expect(classifyCursorError({ message: "socket hang up" })).toBe("transient");
  });

  test("auth and config beat quota, so a bad key or a typo never triggers a pointless seat change", () => {
    // Both messages are verbatim from the live API (probed 2026-08-19).
    expect(classifyCursorError({ message: "Invalid User API Key", status: 401 })).toBe("auth");
    expect(
      classifyCursorError({ message: "Cannot use this model: auto-smart. Available models: default, grok-4.6" }),
    ).toBe("config");
    // `feature_unavailable` (what `getUsage` answers on this plan) means "not included", not
    // "exhausted" — it must not read as quota.
    expect(classifyCursorError({ message: "[feature_unavailable] This feature is not available for your account" }))
      .toBe("unknown");
  });

  test("only transient/unknown are worth another attempt", () => {
    expect(isRetryableKind("transient")).toBe(true);
    expect(isRetryableKind("unknown")).toBe(true);
    expect(isRetryableKind("quota")).toBe(false);
    expect(isRetryableKind("auth")).toBe(false);
    expect(isRetryableKind("config")).toBe(false);
  });

  test("the tool-arg path extractor reads the key the live SDK actually populates", () => {
    expect(pathFromToolArgs({ path: "/tmp/x/hello.txt" })).toBe("/tmp/x/hello.txt");
    expect(pathFromToolArgs({ file_path: "a.ts" })).toBe("a.ts");
    expect(pathFromToolArgs({ command: "ls" })).toBeUndefined();
    expect(pathFromToolArgs(null)).toBeUndefined();
  });
});

// =======================================================================================
// 3 — the shim's frames become ordinary WorkerEvents
// =======================================================================================

describe("CursorDriver frame parsing", () => {
  test("a session frame is the handshake; tools, text and usage normalize like every other driver", () => {
    const { driver, events } = newDriver();
    feed(driver, [
      { type: "session", agentId: "agent-abc", model: "cursor-auto" },
      { type: "turn_start" },
      { type: "tool_start", id: "t1", name: "edit", args: { path: "src/a.ts" } },
      { type: "tool_end", id: "t1", name: "edit", isError: false, path: "src/a.ts" },
      { type: "assistant", text: "partial…", partial: true },
      { type: "usage", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 } },
    ]);

    expect(events.map((e) => e.kind)).toEqual([
      "session_started",
      "turn_started",
      "tool_call",
      "tool_result",
      "file_change",
      "assistant_text",
      "turn_completed",
    ]);
    expect(driver.currentSessionId).toBe("agent-abc");
    const change = events.find((e) => e.kind === "file_change");
    expect(change).toMatchObject({ paths: [{ path: "src/a.ts", kind: "update" }] });
    expect(driver.getTelemetry().tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheCreate: 1 });
  });

  test("a failed edit produces no file_change — nothing was written", () => {
    const { driver, events } = newDriver();
    feed(driver, [
      { type: "session", agentId: "agent-abc", model: "cursor-auto" },
      { type: "tool_start", id: "t1", name: "edit", args: { path: "src/a.ts" } },
      { type: "tool_end", id: "t1", name: "edit", isError: true, path: "src/a.ts" },
    ]);
    expect(events.some((e) => e.kind === "file_change")).toBe(false);
  });

  test("a malformed line or an unknown frame becomes `unknown`, never a throw", () => {
    const { driver, events } = newDriver();
    driver.handleLine("{not json");
    driver.handleLine(JSON.stringify({ type: "something-new", x: 1 }));
    expect(events.map((e) => e.kind)).toEqual(["unknown", "unknown"]);
  });

  test("a finished result carries the done-signal parsed off the final assistant message", () => {
    const { driver, events } = newDriver();
    const done = { done: true, summary: "did it", filesChanged: ["a.ts"], checksRun: null, blocker: null };
    feed(driver, [
      { type: "session", agentId: "agent-abc", model: "cursor-auto" },
      { type: "tool_start", id: "t1", name: "edit", args: { path: "a.ts" } },
      { type: "tool_end", id: "t1", name: "edit", isError: false, path: "a.ts" },
      { type: "usage", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { type: "result", status: "finished", text: JSON.stringify(done) },
    ]);
    const finished = events.find((e) => e.kind === "finished");
    expect(finished).toMatchObject({ status: "success", subtype: "success", structuredOutput: done });
  });

  test("a fenced done-signal parses too (there is no --json-schema equivalent on this harness)", () => {
    const { driver, events } = newDriver();
    feed(driver, [
      { type: "session", agentId: "a", model: "cursor-auto" },
      { type: "tool_start", id: "t1", name: "edit", args: { path: "a.ts" } },
      { type: "tool_end", id: "t1", name: "edit", isError: false, path: "a.ts" },
      { type: "usage", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      {
        type: "result",
        status: "finished",
        text: 'Here you go:\n```json\n{"done":false,"summary":"s","filesChanged":[],"checksRun":null,"blocker":null}\n```',
      },
    ]);
    expect(events.find((e) => e.kind === "finished")).toMatchObject({
      structuredOutput: { done: false, summary: "s" },
    });
  });

  test("a run that spent nothing and touched nothing fails as a launch failure, not a success", () => {
    const { driver, events } = newDriver();
    feed(driver, [
      { type: "session", agentId: "a", model: "cursor-auto" },
      { type: "result", status: "finished", text: "" },
    ]);
    expect(events.find((e) => e.kind === "finished")).toMatchObject({
      status: "error",
      subtype: "error_noop",
    });
  });
});

// =======================================================================================
// 4 — the quota exit
// =======================================================================================

describe("CursorDriver quota exit", () => {
  test("a quota frame finishes the worker with errorClass `quota`, NOT `rate_limit`", () => {
    const { driver, events } = newDriver();
    feed(driver, [
      { type: "session", agentId: "agent-abc", model: "cursor-auto" },
      { type: "turn_start" },
      { type: "usage", usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 } },
      {
        type: "quota",
        reason: "You have hit your usage limit for this month",
        status: 429,
        code: "usage_limit",
        checkpoint: "abc1234",
      },
    ]);

    const finished = events.find((e) => e.kind === "finished");
    // The distinction the whole fallback hangs on: `rate_limit` means back off, `quota` means
    // change seats. Collapsing them would send this run to the park path instead.
    expect(finished).toMatchObject({ status: "error", subtype: "error_quota", errorClass: "quota" });
    // The tokens spent BEFORE the wall still count — telemetry stays honest for the seat that ran.
    expect(finished).toMatchObject({ usage: { input: 900, output: 100, cacheRead: 0, cacheCreate: 0 } });

    // The error message a human reads names the checkpoint and where the handoff lives.
    const error = events.filter((e) => e.kind === "error").at(-1);
    expect(error?.kind === "error" && error.message).toContain("out of quota");
    expect(error?.kind === "error" && error.message).toContain("abc1234");
    expect(error?.kind === "error" && error.message).toContain(".beckett/cursor-handoff.md");
  });

  test("the raw error shape rides along, so the first real occurrence can tighten the rule", () => {
    const { driver, events } = newDriver();
    feed(driver, [
      { type: "session", agentId: "a", model: "cursor-auto" },
      { type: "quota", reason: "spent", status: 402, code: "payment_required" },
    ]);
    const error = events.filter((e) => e.kind === "error").at(-1);
    expect(error?.kind === "error" && error.message).toContain("HTTP 402");
    expect(error?.kind === "error" && error.message).toContain("code payment_required");
  });
});

// =======================================================================================
// preflight
// =======================================================================================

describe("cursorPreflight", () => {
  test("a missing credential is the seat's one blocking problem, named actionably", async () => {
    const prev = process.env[CURSOR_API_KEY_ENV];
    delete process.env[CURSOR_API_KEY_ENV];
    try {
      const pf = await cursorPreflight(defaultConfig());
      expect(pf.ok).toBe(false);
      expect(pf.problems.join(" ")).toContain(`no ${CURSOR_API_KEY_ENV}`);
      expect(pf.problems.join(" ")).toContain("~/.beckett/.env");
    } finally {
      if (prev !== undefined) process.env[CURSOR_API_KEY_ENV] = prev;
    }
  });

  test("with a credential present the in-tree seat preflights clean", async () => {
    const prev = process.env[CURSOR_API_KEY_ENV];
    process.env[CURSOR_API_KEY_ENV] = "probe-value-not-a-real-key";
    try {
      const pf = await cursorPreflight(defaultConfig());
      expect(pf.problems).toEqual([]);
      expect(pf.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env[CURSOR_API_KEY_ENV];
      else process.env[CURSOR_API_KEY_ENV] = prev;
    }
  });

  test("a configured shim path that does not exist fails preflight instead of dying after spawn", async () => {
    const prev = process.env[CURSOR_API_KEY_ENV];
    process.env[CURSOR_API_KEY_ENV] = "probe-value-not-a-real-key";
    const config = defaultConfig();
    (config.harness as { cursor?: { runner: string } }).cursor = {
      ...(config.harness.cursor as object),
      runner: "/nowhere/cursor-runner.ts",
    } as never;
    try {
      const pf = await cursorPreflight(config);
      expect(pf.ok).toBe(false);
      expect(pf.problems.join(" ")).toContain("/nowhere/cursor-runner.ts");
    } finally {
      if (prev === undefined) delete process.env[CURSOR_API_KEY_ENV];
      else process.env[CURSOR_API_KEY_ENV] = prev;
    }
  });

  test("spawn refuses loudly when preflight fails, rather than launching a doomed child", async () => {
    const prev = process.env[CURSOR_API_KEY_ENV];
    delete process.env[CURSOR_API_KEY_ENV];
    const dir = scratch();
    try {
      const driver = new CursorDriver(defaultConfig());
      const spec = {
        workerId: "wk_test",
        prompt: "do the thing",
        systemAppend: "",
        workspace: dir,
        scope: { ownedGlobs: [], readGlobs: null, description: "test" },
        envelope: { effort: "high", turnCap: 60, wallClockS: 2400, network: true },
        model: "cursor-auto",
        doneSchemaPath: join(dir, "done.json"),
        settingsPath: join(dir, "settings.json"),
        mcpConfigPath: join(dir, "mcp.json"),
      } as unknown as SpawnSpec;
      await expect(driver.spawn(spec)).rejects.toThrow(/preflight failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prev !== undefined) process.env[CURSOR_API_KEY_ENV] = prev;
    }
  });
});

// =======================================================================================
// Credential containment
// =======================================================================================

describe("the cursor credential reaches exactly one process", () => {
  test("every OTHER harness child is stripped of it, and the cursor child gets it back", async () => {
    const { childEnv } = await import("../env.ts");
    const prev = process.env[CURSOR_API_KEY_ENV];
    process.env[CURSOR_API_KEY_ENV] = "probe-value-not-a-real-key";
    try {
      // The shared builder (what claude/codex/pi children get) must not carry it.
      expect(childEnv()[CURSOR_API_KEY_ENV]).toBeUndefined();
      // The cursor driver re-injects it for the one process that needs it.
      const driver = new CursorDriver(defaultConfig());
      const env = (driver as unknown as { buildChildEnv(): Record<string, string | undefined> }).buildChildEnv();
      expect(env[CURSOR_API_KEY_ENV]).toBe("probe-value-not-a-real-key");
    } finally {
      if (prev === undefined) delete process.env[CURSOR_API_KEY_ENV];
      else process.env[CURSOR_API_KEY_ENV] = prev;
    }
  });

  test("the credential never appears in the shim's argv", () => {
    const prev = process.env[CURSOR_API_KEY_ENV];
    process.env[CURSOR_API_KEY_ENV] = "probe-value-not-a-real-key";
    const dir = scratch();
    try {
      writeFileSync(join(dir, "marker"), "x");
      const driver = new CursorDriver(defaultConfig()) as unknown as {
        spec: unknown;
        sessionId: string | null;
        buildArgs(isResume: boolean): string[];
      };
      driver.spec = { workspace: dir, model: "cursor-auto" };
      driver.sessionId = "agent-1";
      const argv = driver.buildArgs(false).join(" ");
      expect(argv).not.toContain("probe-value-not-a-real-key");
      expect(argv).toContain("--workspace");
      expect(argv).toContain("--agent-id agent-1");
      expect(readFileSync(join(dir, "marker"), "utf8")).toBe("x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env[CURSOR_API_KEY_ENV];
      else process.env[CURSOR_API_KEY_ENV] = prev;
    }
  });
});
