#!/usr/bin/env bun
/**
 * Isolated browser host process.
 *
 * The daemon supervises this process and owns all wall-clock timeouts. Requests are deliberately
 * sequential: one model program may mutate the browser at a time, while that program can still use
 * Promise.all across as many Playwright pages as needed.
 */

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../types.ts";
import { createBetterWrightRuntime } from "./betterwright.ts";
import { createLocalBrowserRuntime, MAX_BROWSER_EVAL_CALL_TIMEOUT_MS, MAX_BROWSER_EVAL_NOTE_CHARS } from "./runtime.ts";
import type {
  BrowserBudgetOverrides,
  BrowserEvalCallOptions,
  BrowserHostSettings,
  BrowserLease,
  BrowserRuntime,
  BrowserControllerRuntime,
  BrowserEvaluatorOutput,
} from "./runtime.ts";

const MAX_REQUEST_CHARS = 1_100_000;

export type BrowserHostMethod =
  | "stats"
  | "acquire"
  | "evaluate"
  | "prepareEvaluation"
  | "applyEvaluation"
  | "capture"
  | "liveView"
  | "checkpoint"
  | "restore"
  | "release"
  | "stop";

export interface BrowserHostRequest {
  version: 1;
  id: number;
  method: BrowserHostMethod;
  params?: Record<string, unknown>;
}

export interface BrowserHostResponse {
  version: 1;
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const hostLogger: Logger = (() => {
  const emit = (level: string, message: string, fields?: Record<string, unknown>) => {
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    process.stderr.write(`[browser-host:${level}] ${message}${suffix}\n`);
  };
  const logger = {
    info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
    debug: () => undefined,
    child: () => logger,
  };
  return logger as unknown as Logger;
})();

function decodeSettings(): BrowserHostSettings {
  const encoded = process.env.BECKETT_BROWSER_HOST_SETTINGS;
  if (!encoded) throw new Error("BECKETT_BROWSER_HOST_SETTINGS is required");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<BrowserHostSettings>;
  const numeric = [
    parsed.viewportWidth,
    parsed.viewportHeight,
    parsed.launchTimeoutMs,
    parsed.actionTimeoutMs,
    parsed.navigationTimeoutMs,
    parsed.evalTimeoutMs,
    parsed.maxOutputChars,
  ];
  const attachmentRoots = parsed.attachmentRoots ?? [];
  if (
    typeof parsed.profileDir !== "string" ||
    !parsed.profileDir.startsWith("/") ||
    typeof parsed.artifactsRoot !== "string" ||
    !parsed.artifactsRoot.startsWith("/") ||
    !Array.isArray(attachmentRoots) ||
    attachmentRoots.some((root) => typeof root !== "string" || !root.startsWith("/")) ||
    (parsed.chromiumArgs !== undefined &&
      (!Array.isArray(parsed.chromiumArgs) || parsed.chromiumArgs.some((arg) => typeof arg !== "string"))) ||
    (parsed.parkBackgroundPages !== undefined && typeof parsed.parkBackgroundPages !== "boolean") ||
    typeof parsed.headless !== "boolean" ||
    numeric.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error("invalid browser host settings");
  }
  return { ...parsed, attachmentRoots } as BrowserHostSettings;
}

function decodeBudgetOverrides(): BrowserBudgetOverrides {
  const encoded = process.env.BECKETT_BROWSER_HOST_BUDGETS;
  if (!encoded) return {};
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  const allowed = ["maxDownloadBytes", "maxDownloadsPerLease", "maxProfileBytes", "maxProfileGrowthBytes"] as const;
  const result: BrowserBudgetOverrides = {};
  for (const key of allowed) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`invalid browser host budget ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function requireString(params: Record<string, unknown> | undefined, name: string): string {
  const value = params?.[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function parseLease(params: Record<string, unknown> | undefined): BrowserLease {
  const channelId = params?.channelId;
  if (channelId !== null && typeof channelId !== "string") throw new Error("channelId must be a string or null");
  return {
    runId: requireString(params, "runId"),
    channelId: channelId as string | null,
    artifactsDir: requireString(params, "artifactsDir"),
    controlToken: "host-internal",
  };
}

async function handle(runtime: BrowserRuntime, request: BrowserHostRequest): Promise<unknown> {
  switch (request.method) {
    case "stats":
      return runtime.stats();
    case "acquire":
      await runtime.acquire(parseLease(request.params));
      return runtime.stats();
    case "evaluate": {
      const options: BrowserEvalCallOptions = {};
      const note = request.params?.note;
      if (typeof note === "string" && note.trim()) options.note = note.trim().slice(0, MAX_BROWSER_EVAL_NOTE_CHARS);
      const timeoutMs = request.params?.timeoutMs;
      if (typeof timeoutMs === "number" && Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
        options.timeoutMs = Math.min(timeoutMs, MAX_BROWSER_EVAL_CALL_TIMEOUT_MS);
      }
      return runtime.evaluate(requireString(request.params, "runId"), requireString(request.params, "code"), undefined, options);
    }
    case "prepareEvaluation":
      if (!("prepareEvaluation" in runtime)) throw new Error("BetterWright host does not expose evaluator sessions");
      return (runtime as BrowserControllerRuntime).prepareEvaluation(requireString(request.params, "runId"));
    case "applyEvaluation": {
      if (!("applyEvaluation" in runtime)) throw new Error("BetterWright host does not accept evaluator output");
      const evaluated = request.params?.evaluated;
      if (!evaluated || typeof evaluated !== "object") throw new Error("evaluated must be an object");
      return (runtime as BrowserControllerRuntime).applyEvaluation(
        requireString(request.params, "runId"), evaluated as BrowserEvaluatorOutput,
      );
    }
    case "capture":
      return runtime.capture(requireString(request.params, "runId"), requireString(request.params, "name"));
    case "liveView": {
      const action = requireString(request.params, "action");
      if (action !== "start" && action !== "stop" && action !== "status") throw new Error("invalid live view action");
      if (!runtime.liveView) throw new Error("live view is not supported by this browser backend");
      return runtime.liveView(requireString(request.params, "runId"), action);
    }
    case "checkpoint":
      return runtime.checkpoint(requireString(request.params, "runId"));
    case "restore": {
      const checkpoint = request.params?.checkpoint;
      if (!checkpoint || typeof checkpoint !== "object") throw new Error("checkpoint must be an object");
      await runtime.restore(
        requireString(request.params, "runId"),
        checkpoint as Awaited<ReturnType<BrowserRuntime["checkpoint"]>>,
      );
      return null;
    }
    case "release":
      return runtime.release(requireString(request.params, "runId"), request.params?.captureProof === true);
    case "stop":
      await runtime.stop();
      return null;
    default:
      throw new Error(`unknown browser host method: ${String(request.method)}`);
  }
}

async function main(): Promise<void> {
  const settings = decodeSettings();
  const backend = process.env.BECKETT_BROWSER_BACKEND === "betterwright" ? "betterwright" : "playwright";
  const runtime: BrowserRuntime = backend === "betterwright"
    ? createBetterWrightRuntime(settings, hostLogger)
    : createLocalBrowserRuntime({ settings, logger: hostLogger, ...decodeBudgetOverrides() });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    const active = new Set<Promise<void>>();
    const respond = async (request: BrowserHostRequest): Promise<void> => {
      let response: BrowserHostResponse;
      try {
        response = { version: 1, id: request.id, ok: true, data: await handle(runtime, request) };
      } catch (error) {
        response = { version: 1, id: request.id, ok: false, error: boundedError(error) };
      }
      // Each response is one small JSONL write; request ids let the supervisor match out-of-order
      // session completions while BetterWright itself preserves order within a session.
      process.stdout.write(`${JSON.stringify(response)}\n`);
    };
    for await (const line of input) {
      if (!line.trim()) continue;
      if (line.length > MAX_REQUEST_CHARS) throw new Error("browser host request exceeded size limit");
      let request: BrowserHostRequest;
      try {
        request = JSON.parse(line) as BrowserHostRequest;
      } catch {
        throw new Error("browser host received invalid JSON");
      }
      if (request.version !== 1 || !Number.isSafeInteger(request.id) || typeof request.method !== "string") {
        throw new Error("browser host received an invalid request envelope");
      }
      // Stop is a barrier: never close the shared BetterWright client under earlier requests.
      if (request.method === "stop") {
        await Promise.all(active);
        await respond(request);
        break;
      }
      const work = respond(request);
      active.add(work);
      void work.finally(() => active.delete(work));
    }
  } finally {
    input.close();
    await runtime.stop();
  }
}

function boundedError(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (message.length <= 8_000) return message;
  return `${message.slice(0, 1_000)}\n...[browser error truncated]...\n${message.slice(-6_900)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[browser-host:fatal] ${String((error as Error).message ?? error)}\n`);
    process.exitCode = 1;
  });
}
