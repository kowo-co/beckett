import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_RESULT_SCHEMA } from "./agent.ts";
import { BROWSER_TOOL_DEFINITION, handleMcpRequest, validateMcpBatch } from "./mcp.ts";
import type { BrowserEvalResult } from "./runtime.ts";

const emptyEval: BrowserEvalResult = {
  value: { ok: true },
  pages: [{ index: 0, active: true, url: "https://example.test", title: "Example" }],
  elapsedMs: 7,
};

describe("browser MCP", () => {
  test("negotiates MCP and exposes exactly one small code-as-action tool", async () => {
    const deps = { evaluate: async () => emptyEval };
    const initialized = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      deps,
    );
    expect(initialized).toMatchObject({ result: { capabilities: { tools: {} } } });
    expect(initialized).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    const future = await handleMcpRequest(
      { jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2099-01-01" } },
      deps,
    );
    expect(future).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    const listed = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, deps);
    expect((listed!.result as { tools: unknown[] }).tools).toEqual([BROWSER_TOOL_DEFINITION]);
  });

  test("forwards JavaScript and returns an optional screenshot as model vision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-mcp-test-"));
    const shot = join(dir, "shot.png");
    writeFileSync(shot, Buffer.from("89504e470d0a1a0a", "hex"));
    let code = "";
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "betterwright_browser", arguments: { code: "return await observe()" } },
      },
      {
        evaluate: async (value) => {
          code = value;
          return { ...emptyEval, screenshots: [shot] };
        },
      },
    );
    expect(code).toBe("return await observe()");
    const content = (response!.result as { content: { type: string; text?: string }[] }).content;
    expect(content.map((item) => item.type)).toEqual(["text", "image"]);
    expect(content[0]?.text).toBe(JSON.stringify({ ...emptyEval, screenshots: [shot] }));
    expect(content[0]?.text).not.toContain("\n  ");
    expect(() => readFileSync(shot)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  test("surfaces steering notes as their own instruction block, outside the data payload", async () => {
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "betterwright_browser", arguments: { code: "return 1" } },
      },
      {
        evaluate: async () => ({ ...emptyEval, steering: ["use the annual plan", 42] }) as unknown as BrowserEvalResult,
      },
    );
    const content = (response!.result as { content: { type: string; text?: string }[] }).content;
    expect(content).toHaveLength(2);
    // The data block stays a clean eval result; the note rides its own block as instruction.
    expect(content[0]?.text).toBe(JSON.stringify(emptyEval));
    expect(content[1]?.text).toContain("STEERING FROM THE DISPATCHER");
    expect(content[1]?.text).toContain("- use the annual plan");
    expect(content[1]?.text).not.toContain("42");
  });

  test("the tool schema declares optional note and timeoutMs and still requires only code", () => {
    expect(BROWSER_TOOL_DEFINITION.inputSchema.required).toEqual(["code"]);
    expect(BROWSER_TOOL_DEFINITION.inputSchema.properties.note.maxLength).toBe(300);
    expect(BROWSER_TOOL_DEFINITION.inputSchema.properties.timeoutMs.maximum).toBe(300000);
  });

  test("forwards note and a clamped timeout to the evaluator", async () => {
    const recorded: { code: string; options?: { note?: string; timeoutMs?: number } }[] = [];
    const deps = {
      evaluate: async (code: string, options?: { note?: string; timeoutMs?: number }) => {
        recorded.push({ code, options });
        return emptyEval;
      },
    };
    await handleMcpRequest({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "betterwright_browser",
        arguments: { code: "return 1", note: "  Signing in  ", timeoutMs: 120_000 },
      },
    }, deps);
    expect(recorded.at(-1)?.options).toEqual({ note: "Signing in", timeoutMs: 120_000 });

    await handleMcpRequest({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "betterwright_browser", arguments: { code: "return 1", timeoutMs: 999 } },
    }, deps);
    expect(recorded.at(-1)?.options).toEqual({ timeoutMs: 1_000 });

    await handleMcpRequest({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "betterwright_browser", arguments: { code: "return 1", timeoutMs: 10_000_000 } },
    }, deps);
    expect(recorded.at(-1)?.options).toEqual({ timeoutMs: 300_000 });

    await handleMcpRequest({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "betterwright_browser", arguments: { code: "return 1", note: 42 as never } },
    }, deps);
    expect(recorded.at(-1)?.options).toEqual({});
  });

  test("rejects oversized evaluator programs before the daemon boundary", async () => {
    const response = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "betterwright_browser", arguments: { code: "x".repeat(100_001) } },
    }, { evaluate: async () => emptyEval });
    expect(response).toMatchObject({ error: { code: -32602 } });
  });

  test("rejects empty and oversized JSON-RPC batches instead of leaving clients waiting", () => {
    expect(validateMcpBatch([])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(validateMcpBatch(Array.from({ length: 9 }, (_, id) => ({
      jsonrpc: "2.0" as const,
      id,
      method: "ping",
    })))).toMatchObject({ id: null, error: { message: "Batch too large" } });
    expect(validateMcpBatch([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toBeNull();
  });

  test("bounds success and error text at the configured MCP output limit", async () => {
    const success = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "betterwright_browser", arguments: { code: "return 1" } },
    }, {
      maxOutputChars: 4_096,
      evaluate: async () => ({ ...emptyEval, value: "x".repeat(10_000) }),
    });
    const successText = ((success!.result as { content: { text: string }[] }).content[0]!.text);
    expect(successText.length).toBeLessThanOrEqual(4_096);
    expect(successText).toEndWith("...[truncated to MCP output budget]");

    const failure = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "betterwright_browser", arguments: { code: "throw new Error()" } },
    }, {
      maxOutputChars: 4_096,
      evaluate: async () => { throw new Error("e".repeat(10_000)); },
    });
    const failureText = ((failure!.result as { content: { text: string }[] }).content[0]!.text);
    expect(failureText.length).toBeLessThanOrEqual(4_096);
    expect(failureText).toEndWith("...[truncated to MCP output budget]");
  });

  test("an empty envelope serializes to the minimal payload", async () => {
    const padded = { ...emptyEval, console: [], events: [], screenshots: [], truncated: false } as BrowserEvalResult;
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "betterwright_browser", arguments: { code: "return 1" } } },
      { evaluate: async () => padded },
    );
    const text = (response!.result as { content: { text: string }[] }).content[0]!.text;
    expect(text).toBe(JSON.stringify(emptyEval));
    expect(text).not.toContain("truncated");
  });

  test("challenges, warnings, skills, and pendingCredential pass through the payload", async () => {
    const rich = {
      ...emptyEval,
      warnings: ["dropped duplicate --disable-gpu"],
      challenges: [{ type: "bot_challenge", provider: "turnstile" }],
      skills: [{ name: "github", description: "GitHub flows", path: "/skills/github.md" }],
      pendingCredential: { pendingId: "p1", origin: "https://x.test", matchMode: "base-domain", username: null, label: null, expiresAt: null },
    } as BrowserEvalResult;
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "betterwright_browser", arguments: { code: "return 1" } } },
      { evaluate: async () => rich },
    );
    const parsed = JSON.parse((response!.result as { content: { text: string }[] }).content[0]!.text);
    expect(parsed.warnings).toEqual(["dropped duplicate --disable-gpu"]);
    expect(parsed.challenges[0].provider).toBe("turnstile");
    expect(parsed.skills[0].name).toBe("github");
    expect(parsed.pendingCredential.pendingId).toBe("p1");
  });
});

test("browser system prompt, result schema, and tool definition stay below the conservative 3000-token estimate", () => {
  const prompt = readFileSync(join(import.meta.dir, "agent.md"), "utf8");
  const completeSurface = prompt + JSON.stringify(BROWSER_RESULT_SCHEMA) + JSON.stringify(BROWSER_TOOL_DEFINITION);
  // Three characters per token deliberately overestimates normal English/JSON tokenization.
  const conservativeTokens = Math.ceil(completeSurface.length / 3);
  expect(conservativeTokens).toBeLessThan(3_000);
  expect([...BROWSER_RESULT_SCHEMA.required].sort().join(",")).toBe(
    Object.keys(BROWSER_RESULT_SCHEMA.properties).sort().join(","),
  );
  expect(BROWSER_RESULT_SCHEMA.properties.question.type).toContain("null");
});
