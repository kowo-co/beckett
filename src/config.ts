/**
 * Beckett — config loading & validation (`src/config.ts`)
 * =======================================================================================
 * Loads `~/.beckett/.env` (KEY=VALUE, no external dep) into `process.env`, parses
 * `~/.beckett/config.toml` (smol-toml), and validates the result against the COMPOSED
 * schema: every top-level key is a config-schema fragment registered by a capability
 * (`src/capability/builtins.ts`), assembled here via the capability registry — the V5
 * Phase 1c (#N.4) replacement for the old monolithic zod block. Every key has a default,
 * so a near-empty (or missing) config boots. Invalid or out-of-range values are a LOUD
 * refuse-to-start (Spec 01 §4) — config errors surface at boot, never mid-task.
 *
 * Subscription auth ONLY (Spec 00 §4): the `.env` loader deliberately REFUSES to import
 * API-auth/endpoint overrides (`ANTHROPIC_*` / `OPENAI_*` / `CLAUDE_CODE_*` — src/env.ts)
 * into the environment — Beckett drives `claude` / `codex` through their `~/.claude` /
 * `~/.codex` subscription logins, never an API key.
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Config } from "./types.ts";
import { resolveBeckettDir, bootFiles, type PathEnv } from "./paths.ts";
import { isForbiddenEnvKey } from "./env.ts";
import { builtinCapabilityRegistry, cloneRecord, isRecord } from "./capability/builtins.ts";
import type { CapabilityRegistry } from "./capability/index.ts";

export type { Config } from "./types.ts";

// =======================================================================================
// .env parsing (dependency-free)
// =======================================================================================

/**
 * Parse a `.env` body into key/value pairs. Supports `KEY=VALUE`, optional `export `
 * prefix, `#` comments (full-line and trailing on unquoted values), and single/double
 * quoted values (quotes stripped, no interpolation). Forbidden keys are dropped.
 */
export function parseEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (isForbiddenEnvKey(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // strip a trailing inline comment on unquoted values
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` from `beckettDir` into `process.env` WITHOUT overwriting existing process
 * env vars (real environment wins over the file). Returns the parsed pairs. Missing file
 * is fine (returns {}).
 */
export function loadEnvFile(envFile: string): Record<string, string> {
  if (!existsSync(envFile)) return {};
  const pairs = parseEnv(readFileSync(envFile, "utf8"));
  for (const [k, v] of Object.entries(pairs)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return pairs;
}

// =======================================================================================
// The composed schema — capability fragments assembled by the registry (V5 #N.4)
// =======================================================================================

/**
 * Compose a top-level config schema from a registry's config fragments: each capability's
 * slice mounts at its `configKey`, and the whole stays `.strict()` so a key NO capability
 * claims is the same loud refuse-to-start the old monolith gave.
 */
export function composeConfigSchema(registry: CapabilityRegistry): z.ZodTypeAny {
  return z.object(Object.fromEntries(registry.configFragments())).strict();
}

/**
 * The daemon's schema: every builtin capability's fragment, in registration order (the
 * order is observable — `defaultConfigToml` walks it). The compile-time proof that this
 * composition matches the frozen {@link Config} contract lives on `configFragments` in
 * `capability/builtins.ts` (a `satisfies` over every Config key), which is why the parse
 * results below may be typed as Config: same table, checked at its source.
 */
const ConfigSchema = composeConfigSchema(builtinCapabilityRegistry());

// =======================================================================================
// loadConfig
// =======================================================================================

/**
 * Runtime proactivity controls live outside config.toml so the daemon can later honor
 * "chill out in here" style commands without an edit+restart. The file is a partial
 * `[proactivity]` object and is merged over TOML before the strict schema validates it.
 */
function mergeProactivityOverride(rawConfig: unknown, overridePath: string): unknown {
  if (!existsSync(overridePath)) return rawConfig;

  let override: unknown;
  try {
    override = JSON.parse(readFileSync(overridePath, "utf8"));
  } catch (err) {
    throw new Error(
      `beckett: failed to parse ${overridePath} — ${(err as Error).message}`,
    );
  }
  if (!isRecord(override)) {
    throw new Error(`beckett: invalid ${overridePath} — expected a JSON object`);
  }

  const root = cloneRecord(rawConfig);
  const current = cloneRecord(root.proactivity);
  const merged: Record<string, unknown> = { ...current, ...override };
  if (Object.prototype.hasOwnProperty.call(override, "channels")) {
    merged.channels = isRecord(override.channels)
      ? { ...cloneRecord(current.channels), ...override.channels }
      : override.channels;
  } else if (isRecord(current.channels)) {
    merged.channels = { ...current.channels };
  }
  root.proactivity = merged;
  return root;
}

/**
 * Top-level sections that USED to be schema keys and no longer are. The composed root schema is
 * `.strict()`, so a live `~/.beckett/config.toml` that still carries one would make the daemon
 * refuse to start on "unrecognized key" — a deploy-time outage on a box whose config file the
 * deploy never touches. Stripping them here (with one loud line per key) turns a hard boot failure
 * into a visible deprecation the operator can clean up on their own schedule.
 *
 * This is the same one-release shim shape `foldLegacyPlaneSection` occupied before the ticket
 * rip-out retired it, and it should retire the same way: once prod's config.toml no longer has
 * these sections, delete the entry.
 *
 *   - `plane`   — the first tracker section, long since folded into `[tracker]` (itself now gone).
 *   - `tracker` — the out-of-process ticket queue. v7 has no board; the run ledger is the queue.
 *   - `progress`— `cards_as_code`, the ticket dispatcher's card switch. Runs use `[runs] cards`.
 */
const RETIRED_CONFIG_SECTIONS = ["plane", "tracker", "progress"] as const;

/**
 * Drop retired top-level sections from a parsed config before the strict schema sees them.
 * Returns the raw object untouched when it carries none (the steady state), so the common path
 * pays nothing and logs nothing.
 */
export function dropRetiredSections(raw: unknown, warn: (message: string) => void): unknown {
  if (!isRecord(raw)) return raw;
  const present = RETIRED_CONFIG_SECTIONS.filter((key) => Object.prototype.hasOwnProperty.call(raw, key));
  if (present.length === 0) return raw;
  const root = cloneRecord(raw);
  for (const key of present) {
    delete root[key];
    warn(
      `beckett: config section [${key}] was retired with the v7 run engine and is being IGNORED. ` +
        `Delete it from your config.toml — this compatibility strip goes away in a future release.`,
    );
  }
  return root;
}

export interface LoadConfigOptions {
  /** Override env source (for tests). Defaults to process.env. */
  env?: PathEnv;
  /** Explicit config.toml path (else derived from beckettDir). */
  configFile?: string;
  /** Explicit proactivity runtime override path (else <beckettDir>/proactivity.json). */
  proactivityOverrideFile?: string;
}

/**
 * The boot entry point. Resolves `beckettDir`, loads `.env` (subscription-safe), parses
 * `config.toml` if present, validates against the schema, and returns a fully-defaulted
 * {@link Config}. Throws a single loud error (with all zod issues) on any invalid value.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const beckettDir = resolveBeckettDir(env);
  const files = bootFiles(beckettDir);

  // 1. .env → process.env (does not overwrite existing; forbidden keys dropped).
  loadEnvFile(files.envFile);

  // 2. config.toml → raw object (empty if absent — defaults will fill everything).
  const configPath = opts.configFile ?? files.configFile;
  let raw: unknown = {};
  if (existsSync(configPath)) {
    try {
      raw = parseToml(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(
        `beckett: failed to parse ${configPath} — ${(err as Error).message}`,
      );
    }
  }

  // 3. runtime proactivity overrides (partial [proactivity]) → raw object.
  raw = mergeProactivityOverride(raw, opts.proactivityOverrideFile ?? `${beckettDir}/proactivity.json`);

  // 3b. retired v6 sections ([tracker], [progress], [plane]) → stripped with a deprecation line,
  //     so a prod config.toml written before the run engine still boots this daemon.
  raw = dropRetiredSections(raw, (message) => console.warn(message));

  // 4. validate + apply defaults (loud refuse-to-start on invalid).
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `beckett: invalid config at ${configPath} — refusing to start:\n${issues}`,
    );
  }
  return result.data as Config;
}

/** Parse a config object directly (tests / in-memory). Same validation as loadConfig. */
export function validateConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`beckett: invalid config — refusing to start:\n${issues}`);
  }
  return result.data as Config;
}

/** The fully-defaulted config (an empty TOML). Handy for tests + the v0 seed boot. */
export function defaultConfig(): Config {
  return validateConfig({});
}

// =======================================================================================
// Default-config TOML rendering (issue #34)
// =======================================================================================

/** Serialize one TOML value. Strings quoted; arrays inline; numbers/booleans literal. */
function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v); // TOML basic strings ≡ JSON string escaping
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  throw new Error(`configToToml: unsupported value ${JSON.stringify(v)}`);
}

/** Depth-first table writer: scalars first, then child tables as [a.b.c] sections. */
function tomlSection(out: string[], path: string[], obj: Record<string, unknown>): void {
  const scalars = Object.entries(obj).filter(([, v]) => typeof v !== "object" || Array.isArray(v));
  const tables = Object.entries(obj).filter(([, v]) => typeof v === "object" && v !== null && !Array.isArray(v));
  if (path.length > 0 && scalars.length > 0) out.push(`[${path.join(".")}]`);
  for (const [k, v] of scalars) out.push(`${k} = ${tomlValue(v)}`);
  if (scalars.length > 0) out.push("");
  for (const [k, v] of tables) tomlSection(out, [...path, k], v as Record<string, unknown>);
}

/**
 * Render {@link defaultConfig} as TOML — the generator behind `beckett config print-default`
 * and the committed `deploy/config.toml.example` (issue #34). Generated from the live zod
 * schema, so the example CANNOT drift from the code: a schema change fails the drift test
 * until the example is regenerated.
 */
export function defaultConfigToml(): string {
  const out: string[] = [
    "# Beckett — every config key at its DEFAULT value (issue #34).",
    "# The live file is ~/.beckett/config.toml on the box; only put keys you're OVERRIDING there",
    "# (validation is strict: schema-pruned keys must be removed in the same deploy).",
    "# Regenerate after any schema change:  bun src/cli/beckett.ts config print-default",
    "",
  ];
  tomlSection(out, [], defaultConfig() as unknown as Record<string, unknown>);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
