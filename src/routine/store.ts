/**
 * Beckett — Routine store (`src/routine/store.ts`)
 * =======================================================================================
 * Durable registry of routine definitions AND their per-period runtime state (the chosen fire
 * time + last-fired period key). Persisted as one Zod-validated JSON file at
 * `<beckettDir>/routines.json`, with the same atomic tmp+rename + directory-lock discipline as
 * the task registry ({@link ../task/store.ts}) so the CLI and the daemon can both mutate it
 * safely (issue #62, aligning with #51's on-disk snapshot spirit).
 *
 * The store is the single source of truth: the daemon scheduler re-reads it each tick, so a
 * `beckett routine add/remove` from the CLI is picked up without a restart, and a restart
 * restores the chosen fire time verbatim (no re-roll, no double-fire).
 *
 * Built-ins are seeded on load unless the user removed them (`removedBuiltins`).
 *
 * Boot-time healing: a routine written to disk before the jingle vault entry was renamed may
 * still carry the DEAD `credsEntry: "x.com"` (ctx-social.md — the vault has no such entry, only
 * `x-account`). `migrateCredsEntry` rewrites any occurrence in place on the next load, once,
 * logged, so prod's `routines.json` heals itself with no manual surgery. Idempotent: a routine
 * already on `x-account` (or any other entry) is untouched, so a repeat boot is a no-op.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { builtinRoutineDefs, X_CREDS_ENTRY, type BuiltinRoutineOverrides } from "./builtins.ts";
import { RoutineRegistrySchema, type Routine, type RoutineRegistry } from "./types.ts";
import { log } from "../log.ts";
import type { Logger } from "../types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;

/** The jingle entry a routine's `credsEntry` was WRONGLY seeded with before the fix — the vault
 *  has never had an entry by this name. Anything still carrying it is healed on the next load. */
const DEAD_X_CREDS_ENTRY = "x.com";

export interface RoutineStoreOptions {
  now?: () => Date;
  id?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Seed the built-in routines on load (default true; tests disable for a clean slate). */
  seedBuiltins?: boolean;
  /**
   * Seed-time schedule overrides for the built-ins that read config (free time only —
   * {@link BuiltinRoutineOverrides}). Applied ONLY when a definition is first written; a routine
   * already on disk keeps whatever timing it has, because the store, not config, is the source of
   * truth once a routine exists.
   */
  builtins?: BuiltinRoutineOverrides;
  /** Injectable for tests; defaults to `log.child("routine.store")`. */
  logger?: Logger;
}

const EMPTY: RoutineRegistry = { version: 1, routines: [], removedBuiltins: [] };

export class RoutineStore {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly seedBuiltins: boolean;
  private readonly builtinOverrides: BuiltinRoutineOverrides;
  private readonly logger: Logger;

  constructor(path: string, opts: RoutineStoreOptions = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.id ?? (() => randomUUID().slice(0, 8));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.seedBuiltins = opts.seedBuiltins ?? true;
    this.builtinOverrides = opts.builtins ?? {};
    this.logger = opts.logger ?? log.child("routine.store");
  }

  /** All routines (seeding built-ins if needed), sorted by id for stable output. */
  async list(): Promise<Routine[]> {
    return this.mutate((reg) => reg.routines.slice().sort((a, b) => a.id.localeCompare(b.id)));
  }

  /** One routine by id, or null. */
  async get(id: string): Promise<Routine | null> {
    return this.mutate((reg) => reg.routines.find((r) => r.id === id) ?? null);
  }

  /** Add a user routine. Throws on a duplicate id. */
  async add(def: Omit<Routine, "createdAt" | "updatedAt" | "state" | "builtin">): Promise<Routine> {
    return this.mutate((reg) => {
      if (reg.routines.some((r) => r.id === def.id)) throw new Error(`routine already exists: ${def.id}`);
      const now = this.now().toISOString();
      const routine: Routine = {
        ...def,
        builtin: false,
        state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
        createdAt: now,
        updatedAt: now,
      };
      reg.routines.push(routine);
      return structuredClone(routine);
    });
  }

  /** Remove a routine by id. A built-in is remembered as removed so seeding won't restore it. */
  async remove(id: string): Promise<boolean> {
    return this.mutate((reg) => {
      const idx = reg.routines.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      const [removed] = reg.routines.splice(idx, 1);
      if (removed?.builtin && !reg.removedBuiltins.includes(id)) reg.removedBuiltins.push(id);
      return true;
    });
  }

  /** Enable/disable a routine. */
  async setEnabled(id: string, enabled: boolean): Promise<Routine> {
    return this.mutate((reg) => {
      const routine = reg.routines.find((r) => r.id === id);
      if (!routine) throw new Error(`no such routine: ${id}`);
      routine.enabled = enabled;
      routine.updatedAt = this.now().toISOString();
      return structuredClone(routine);
    });
  }

  /**
   * Toggle a `watch` routine's ambient dry-run mode — the "watch what it would have posted for a
   * day before trusting it" lever (issue #1). Distinct from `enabled`: `enabled: false` stops the
   * poll loop entirely, while `dryRun: true` keeps it polling and evaluating for real but swaps
   * the final step (a live post) for a one-line Discord preview.
   */
  async setWatchDryRun(id: string, dryRun: boolean): Promise<Routine> {
    return this.mutate((reg) => {
      const routine = reg.routines.find((r) => r.id === id);
      if (!routine) throw new Error(`no such routine: ${id}`);
      if (routine.action.kind !== "watch") throw new Error(`routine ${id} is not a "watch" routine`);
      routine.action = { ...routine.action, dryRun };
      routine.updatedAt = this.now().toISOString();
      return structuredClone(routine);
    });
  }

  /**
   * Replace a `proactive-sweep` routine's opt-in repo list (issue #79) — the "opt a repo in / out"
   * lever. This IS the explicit config list the sweep gates on: nothing off it is ever touched. The
   * list is de-duplicated and order-stable so the persisted config reads cleanly. Throws if `id`
   * isn't a proactive-sweep routine, so a typo can never quietly write repos onto the wrong action.
   */
  async setProactiveRepos(id: string, repos: string[]): Promise<Routine> {
    return this.mutate((reg) => {
      const routine = reg.routines.find((r) => r.id === id);
      if (!routine) throw new Error(`no such routine: ${id}`);
      if (routine.action.kind !== "proactive-sweep") {
        throw new Error(`routine ${id} is not a "proactive-sweep" routine`);
      }
      const cleaned = [...new Set(repos.map((r) => r.trim()).filter(Boolean))];
      routine.action = { ...routine.action, repos: cleaned };
      routine.updatedAt = this.now().toISOString();
      return structuredClone(routine);
    });
  }

  /** Replace a routine's runtime state (the scheduler's persist path). */
  async setState(id: string, state: Routine["state"]): Promise<void> {
    await this.mutate((reg) => {
      const routine = reg.routines.find((r) => r.id === id);
      if (!routine) return;
      routine.state = state;
      routine.updatedAt = this.now().toISOString();
    });
  }

  // --- persistence internals (mirrors TaskStore) --------------------------------------------

  private read(): RoutineRegistry {
    try {
      const raw = readFileSync(this.path, "utf8");
      return RoutineRegistrySchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return structuredClone(EMPTY);
      throw new Error(`routine registry ${this.path} is unreadable: ${(err as Error).message}`);
    }
  }

  /**
   * Heal any routine still carrying the dead `credsEntry: "x.com"` (see the class doc). Runs on
   * every load, before seeding, so it fixes routines that predate the fix regardless of whether
   * they're built-in or user-added. Returns true if anything changed (the write-back trigger).
   */
  private migrateCredsEntry(reg: RoutineRegistry): boolean {
    let changed = false;
    for (const routine of reg.routines) {
      const action = routine.action;
      if ("credsEntry" in action && action.credsEntry === DEAD_X_CREDS_ENTRY) {
        action.credsEntry = X_CREDS_ENTRY;
        routine.updatedAt = this.now().toISOString();
        changed = true;
        this.logger.info("healed dead routine credsEntry", {
          routineId: routine.id,
          from: DEAD_X_CREDS_ENTRY,
          to: X_CREDS_ENTRY,
        });
      }
    }
    return changed;
  }

  /** Seed any built-in not present and not in the removed list. Returns true if it changed. */
  private seed(reg: RoutineRegistry): boolean {
    if (!this.seedBuiltins) return false;
    let changed = false;
    const now = this.now().toISOString();
    for (const def of builtinRoutineDefs(this.builtinOverrides)) {
      if (reg.removedBuiltins.includes(def.id)) continue;
      if (reg.routines.some((r) => r.id === def.id)) continue;
      reg.routines.push({
        ...def,
        state: { periodKey: null, chosenFireAt: null, lastFiredPeriodKey: null, lastFiredAt: null },
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
    }
    return changed;
  }

  private async mutate<T>(change: (reg: RoutineRegistry) => T): Promise<T> {
    await this.acquireLock();
    try {
      const reg = this.read();
      const migrated = this.migrateCredsEntry(reg);
      const seeded = this.seed(reg);
      const before = JSON.stringify(reg);
      const result = change(reg);
      if (migrated || seeded || JSON.stringify(reg) !== before) this.write(reg);
      return result;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private write(reg: RoutineRegistry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${this.id()}.tmp`;
    writeFileSync(temp, JSON.stringify(reg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
  }

  private async acquireLock(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        mkdirSync(this.lockPath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await this.sleep(25);
      }
    }
    throw new Error(`routine registry lock is held: ${this.lockPath}`);
  }
}
