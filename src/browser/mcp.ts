#!/usr/bin/env bun
/**
 * Tiny stdio MCP bridge for the computer-use seat.
 *
 * The model sees one BetterWright code-as-action tool rather than a large click/type/snapshot
 * catalog. BetterWright keeps the persistent, policy-guarded browser in the isolated host;
 * this process only forwards JavaScript over the local control socket and returns compact data
 * plus controller-owned images.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { callBus } from "../shell/control-bus.ts";
import type { BrowserEvalResult } from "./runtime.ts";
import betterwrightPkg from "betterwright/package.json";

const TOOL_NAME = "betterwright_browser";
const MAX_CODE_CHARS = 100_000;
const MAX_BATCH_REQUESTS = 8;
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export const BROWSER_TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Run JavaScript in Beckett's warm BetterWright session. Top-level await works. Globals include page, pages, openPage, usePage, snapshot, screenshot, attachFile, human, dialogs, overlays, and captcha. Return plain data from the script.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "BetterWright browser JavaScript body. Use return to send useful data back.",
        maxLength: MAX_CODE_CHARS,
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
} as const;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpDeps {
  evaluate(code: string): Promise<BrowserEvalResult>;
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 24_000;

function boundMcpText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "\n...[truncated to MCP output budget]";
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

export async function handleMcpRequest(message: JsonRpcRequest, deps: McpDeps): Promise<Record<string, unknown> | null> {
  if (message.id === undefined) return null;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id: message.id, result: value });
  const error = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: text },
  });

  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    const protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
    return result({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "beckett-browser", version: betterwrightPkg.version },
    });
  }
  if (message.method === "ping") return result({});
  if (message.method === "tools/list") {
    return result({
      tools: [BROWSER_TOOL_DEFINITION],
    });
  }
  if (message.method !== "tools/call") return error(-32601, `Method not found: ${message.method}`);

  const name = message.params?.name;
  const args = message.params?.arguments as Record<string, unknown> | undefined;
  if (name !== TOOL_NAME) return error(-32602, `Unknown tool: ${String(name)}`);
  if (typeof args?.code !== "string" || !args.code.trim()) {
    return error(-32602, `${TOOL_NAME} requires a non-empty code string`);
  }
  if (args.code.length > MAX_CODE_CHARS) return error(-32602, `${TOOL_NAME} code exceeds ${MAX_CODE_CHARS} characters`);
  try {
    const evaluated = await deps.evaluate(args.code);
    const maxOutputChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    // Mid-run guidance from the dispatcher rides the eval response (see the daemon's
    // browser.eval boundary); surface it as its own block so it reads as instruction, not data.
    const { steering, ...payload } = evaluated as BrowserEvalResult & { steering?: unknown };
    const notes = Array.isArray(steering) ? steering.filter((note): note is string => typeof note === "string") : [];
    const content: Record<string, unknown>[] = [
      { type: "text", text: boundMcpText(JSON.stringify(payload), maxOutputChars) },
    ];
    if (notes.length > 0) {
      content.push({
        type: "text",
        text:
          "STEERING FROM THE DISPATCHER — mid-run guidance from Beckett/the user. It is authoritative: " +
          "adjust the task accordingly before your next action.\n" +
          notes.map((note) => `- ${note}`).join("\n"),
      });
    }
    for (const path of evaluated.screenshots.slice(0, 3)) {
      try {
        content.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/png" });
      } catch {
        // The path remains in the text result; a missing optional vision block must not fail the action.
      } finally {
        try {
          unlinkSync(path);
        } catch {
          // Already absent.
        }
      }
    }
    return result({ content, isError: false });
  } catch (caught) {
    const maxOutputChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    return result({
      content: [{ type: "text", text: boundMcpText((caught as Error).message, maxOutputChars) }],
      isError: true,
    });
  }
}

export function validateMcpBatch(parsed: JsonRpcRequest | JsonRpcRequest[]): Record<string, unknown> | null {
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (parsed.length > MAX_BATCH_REQUESTS) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large" } };
  }
  return null;
}

async function main(): Promise<void> {
  const socket = process.env.BECKETT_CONTROL_SOCKET?.trim();
  const runId = process.env.BECKETT_BROWSER_RUN_ID?.trim();
  const controlToken = process.env.BECKETT_BROWSER_CONTROL_TOKEN?.trim();
  const timeoutMs = Number(process.env.BECKETT_BROWSER_EVAL_TIMEOUT_MS ?? "90000");
  const maxOutputChars = Number(process.env.BECKETT_BROWSER_MAX_OUTPUT_CHARS ?? String(DEFAULT_MAX_OUTPUT_CHARS));
  if (!socket || !runId || !controlToken) {
    throw new Error("browser MCP needs its control socket, run id, and capability token");
  }

  // The attach marker is the deterministic proof-of-registration the agent checks after each leg:
  // the file exists iff claude actually negotiated with this server and pulled its tool list, so a
  // leg that ran without `mcp__browser__betterwright_browser` is caught instead of flailing. Best
  // effort — the leg-level retry still guards if the write itself fails.
  const attachMarker = process.env.BECKETT_BROWSER_ATTACH_MARKER?.trim();
  let attachMarked = false;
  const markAttached = (): void => {
    if (attachMarked || !attachMarker) return;
    try {
      writeFileSync(attachMarker, `${runId}\n`, { mode: 0o600 });
      attachMarked = true;
    } catch {
      // The agent's per-leg retry covers a missed marker; never let this crash the handshake.
    }
  };

  const deps: McpDeps = {
    maxOutputChars: Number.isSafeInteger(maxOutputChars) && maxOutputChars >= 4_096
      ? maxOutputChars
      : DEFAULT_MAX_OUTPUT_CHARS,
    evaluate: async (code) => {
      const response = await callBus(socket, "browser.eval", { runId, controlToken, code }, timeoutMs);
      if (!response.ok) throw new Error(response.error ?? "browser evaluation failed");
      return response.data as BrowserEvalResult;
    },
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(line) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      continue;
    }
    const batchError = validateMcpBatch(parsed);
    if (batchError) {
      process.stdout.write(JSON.stringify(batchError) + "\n");
      continue;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses: Record<string, unknown>[] = [];
    for (const message of messages) {
      const response = await handleMcpRequest(message, deps);
      // `initialize` proves claude connected; `tools/list` proves the tool reached its toolset.
      if (message.method === "initialize" || message.method === "tools/list") markAttached();
      if (response) responses.push(response);
    }
    if (responses.length === 0) continue;
    process.stdout.write(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]) + "\n");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`beckett browser MCP failed: ${String((error as Error).message ?? error)}\n`);
    process.exit(1);
  });
}
