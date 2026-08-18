/**
 * Beckett — path resolution (`src/paths.ts`)
 * =======================================================================================
 * Resolves every runtime path from the loaded {@link Config} `[paths]` block (Spec 01 §4),
 * but stays portable: the daemon runs as OS user `beckett` on loom-desk (where the spec's
 * absolute `/home/beckett/.beckett` defaults are correct), yet this code is authored/tested
 * on a Mac. So the resolver derives `home` from the environment and lets **`BECKETT_DIR`**
 * override the whole layout — set it to a scratch dir and everything (db, events, logs,
 * memory, socket) relocates under it, making the foundation testable without touching
 * `/home/beckett`.
 *
 * Precedence (highest first):
 *   1. env `BECKETT_DIR`  → becomes `beckettDir`; db/events/logs/memory/socket derive under it.
 *   2. env `BECKETT_HOME` → becomes `home` (projects derive under it).
 *   3. config `[paths]`   → used verbatim when no env override applies.
 *   4. OS home + `.beckett` → final fallback so a near-empty environment still resolves.
 *
 * Spec note (Spec 09 §12): Spec 01 §4 uses absolute `/home/beckett/...` while Spec 00 §5
 * uses `~/.beckett/...`; for OS user `beckett` they are the same location. We resolve once
 * here so the constants are never duplicated across modules.
 */

import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { Config, Paths } from "./types.ts";

/** A thin env shape so buildPaths is pure/testable (defaults to process.env). */
export interface PathEnv {
  BECKETT_DIR?: string;
  BECKETT_HOME?: string;
  /** Index signature so `process.env` (ProcessEnv) is assignable. */
  [key: string]: string | undefined;
}

/** Join `base` and `seg` unless `seg` is already absolute (then use it as-is). */
function under(base: string, seg: string): string {
  return isAbsolute(seg) ? seg : join(base, seg);
}

/**
 * Build the typed {@link Paths} object from config + environment overrides.
 *
 * When `BECKETT_DIR` is set, the standard children (db/events/logs/memory/socket) are
 * derived under it with their conventional names — ignoring the absolute config defaults so
 * a test/dev relocation is total and predictable. When it is not set, the config `[paths]`
 * values win verbatim (the loom-desk production path).
 */
export function buildPaths(config: Config, env: PathEnv = process.env): Paths {
  const p = config.paths;

  // home: env override → config → OS home.
  const home = env.BECKETT_HOME ?? p.home ?? homedir();

  // beckettDir: env override → config → <home>/.beckett.
  const overridden = Boolean(env.BECKETT_DIR);
  const beckettDir = env.BECKETT_DIR ?? p.beckett_dir ?? join(home, ".beckett");

  // When BECKETT_DIR overrides, derive children under it (conventional names).
  // Otherwise honor config's explicit child paths verbatim.
  const db = overridden ? join(beckettDir, "beckett.db") : under(beckettDir, p.db);
  const eventsDir = overridden ? join(beckettDir, "events") : under(beckettDir, p.events_dir);
  const logsDir = overridden ? join(beckettDir, "logs") : under(beckettDir, p.logs_dir);
  const memoryDir = overridden ? join(beckettDir, "memory") : under(beckettDir, p.memory_dir);
  const socket = overridden ? join(beckettDir, "beckett.sock") : under(beckettDir, p.socket);
  const spend = overridden ? join(beckettDir, "spend.jsonl") : under(beckettDir, p.spend);
  const projects = overridden ? join(home, "projects") : under(home, p.projects);

  return {
    home,
    beckettDir,
    projects,
    db,
    eventsDir,
    logsDir,
    memoryDir,
    socket,
    spend,
    configFile: join(beckettDir, "config.toml"),
    envFile: join(beckettDir, ".env"),
    personaFile: join(beckettDir, "persona.md"),
    attachmentsDir: join(beckettDir, "attachments"),
    channelsDir: join(beckettDir, "channels"),
    accessFile: join(beckettDir, "access.txt"),
    imagesDir: join(beckettDir, "images"),
    identitiesFile: join(beckettDir, "identities.json"),
    accessPendingFile: join(beckettDir, "access-pending.json"),
    maintainersFile: join(beckettDir, "maintainers.txt"),
    maintainersPendingFile: join(beckettDir, "maintainers-pending.json"),
    peersFile: join(beckettDir, "peers.txt"),
    observedBotsFile: join(beckettDir, "observed-bots.txt"),
    announcedFile: join(beckettDir, "announced.txt"),
    presetsFile: join(beckettDir, "presets.json"),
    pauseFile: join(beckettDir, "pause.json"),
    journalDir: join(beckettDir, "journal"),
    proposalsDir: join(beckettDir, "proposals"),
    companyFile: join(beckettDir, "company.md"),
    workspacesFile: join(beckettDir, "workspaces.json"),
    chilltextLog: join(beckettDir, "chilltext-transforms.jsonl"),
  };
}

/**
 * Resolve just the `beckettDir` without a parsed config — needed at the very start of
 * boot (to locate `.env` and `config.toml` before the config schema is loaded) and by the
 * CLI (which reads the DB/socket directly). Mirrors the precedence of {@link buildPaths}.
 */
export function resolveBeckettDir(env: PathEnv = process.env): string {
  if (env.BECKETT_DIR) return env.BECKETT_DIR;
  const home = env.BECKETT_HOME ?? homedir();
  return join(home, ".beckett");
}

/** The conventional config/env file locations under a beckettDir (pre-config boot). */
export function bootFiles(beckettDir: string): { configFile: string; envFile: string } {
  return {
    configFile: join(beckettDir, "config.toml"),
    envFile: join(beckettDir, ".env"),
  };
}
