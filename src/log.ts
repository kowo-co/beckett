/**
 * Beckett — structured logger (`src/log.ts`)
 * =======================================================================================
 * A tiny dependency-free structured logger. Emits one JSON object per line to **stderr**
 * (journald captures stderr for the systemd user service, Spec 01 §5.3), with a stable
 * shape: {level, ts, component, msg, ...fields}. Also offers a helper to append
 * human-prettified per-worker lines to `logs_dir` (Spec 00 §5: "daemon + per-worker
 * prettified logs").
 *
 * No deps; safe to import anywhere (it is owned by Foundation alongside types/config/paths).
 */

import type { Logger, LogLevel } from "./types.ts";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const v = (process.env.BECKETT_LOG_LEVEL ?? "").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

let minLevel: LogLevel = envLevel();

/** Override the global minimum level (e.g. after config load). */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** A structured log record passed to extra sinks (e.g. the Discord log mirror). */
export type LogRecord = { level: LogLevel; ts: string; component: string; msg: string } & Record<string, unknown>;
type LogSink = (rec: LogRecord) => void;
const sinks: LogSink[] = [];
let inSink = false;

/** Register an extra log sink (e.g. a Discord mirror). Returns an unregister fn. */
export function addLogSink(fn: LogSink): () => void {
  sinks.push(fn);
  return () => {
    const i = sinks.indexOf(fn);
    if (i >= 0) sinks.splice(i, 1);
  };
}

function emit(level: LogLevel, component: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const rec: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    component,
    msg,
    ...(fields ?? {}),
  };
  let line: string;
  try {
    line = JSON.stringify(rec);
  } catch {
    // never let a non-serializable field crash logging
    line = JSON.stringify({ level, ts: rec.ts, component, msg, fields: "[unserializable]" });
  }
  process.stderr.write(line + "\n");

  // Fan out to extra sinks (Discord mirror, etc.). The `inSink` guard prevents a sink that itself
  // logs from recursing; sinks must never throw out (each is wrapped) so logging can't be broken.
  if (sinks.length > 0 && !inSink) {
    inSink = true;
    try {
      for (const s of sinks) {
        try {
          s(rec as LogRecord);
        } catch {
          /* a sink must never break logging */
        }
      }
    } finally {
      inSink = false;
    }
  }
}

/** Create a logger bound to a component name. */
export function makeLogger(component = "beckett"): Logger {
  return {
    debug: (msg, fields) => emit("debug", component, msg, fields),
    info: (msg, fields) => emit("info", component, msg, fields),
    warn: (msg, fields) => emit("warn", component, msg, fields),
    error: (msg, fields) => emit("error", component, msg, fields),
    child: (sub: string) => makeLogger(component === "beckett" ? sub : `${component}.${sub}`),
  };
}

/** The root logger. Most modules call `log.child("<component>")`. */
export const log: Logger = makeLogger();
