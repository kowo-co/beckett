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
 *
 * A second boot-time heal, `healRemovedBuiltins`, does the same for `removedBuiltins` residue:
 * an install that lived through the v7 debt sweep (overhaul P16, `dream` retired whole) still
 * carries `removedBuiltins: ["nightly-dream"]` on disk from BEFORE the pass was rebuilt
 * (`src/dream/`) — with no heal, that stale entry would permanently block {@link RoutineStore.seed}
 * from ever recreating the rebuilt builtin, and the pass would silently never fire on that box.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { builtinRoutineDefs, fixedFireWindow, X_CREDS_ENTRY, type BuiltinRoutineOverrides } from "./builtins.ts";
import { RoutineRegistrySchema, type Routine, type RoutineRegistry } from "./types.ts";
import { log } from "../log.ts";
import type { Logger } from "../types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;

/** The jingle entry a routine's `credsEntry` was WRONGLY seeded with before the fix — the vault
 *  has never had an entry by this name. Anything still carrying it is healed on the next load. */
const DEAD_X_CREDS_ENTRY = "x.com";

/**
 * Builtin ids whose `removedBuiltins` entry is stale retirement residue, not a deliberate current
 * removal — see the class doc. Healed out on every load so {@link RoutineStore.seed} can recreate
 * them. Trade-off, same one `migrateCredsEntry` accepts for the dead creds string: an operator who
 * runs `beckett routine remove nightly-dream` AFTER this heal ships will see it reappear on the
 * next boot, because the on-disk state left by that command is indistinguishable from the pre-
 * rebuild residue this heal exists to fix. Nothing else on disk records the difference.
 */
const HEALED_REMOVED_BUILTINS: readonly string[] = ["nightly-dream"];

/**
 * Action kinds retired from the schema. A row still carrying one is dropped before the strict
 * parse, so a live routines.json written by an older build cannot make the daemon refuse to boot.
 *
 * `dream` was retired here too (v7 debt sweep, overhaul P16) but the nightly dream pass was
 * later rebuilt on top of the day's Discord sessions (`src/dream/`) and `{kind: "dream"}` is a
 * live action again — it must NOT be listed below, or the builtin `nightly-dream` routine would
 * be silently dropped on every load and the pass would never fire.
 */
const RETIRED_ACTION_KINDS: readonly string[] = [];

/**
 * Strip retired-kind routines from RAW json before `RoutineRegistrySchema.parse` sees it —
 * running it after the parse is too late, the parse is what throws. Returns the sanitized raw
 * plus the ids it dropped (recorded in `removedBuiltins` on write-back so a dropped built-in
 * never reseeds).
 */
function dropRetiredRoutines(raw: unknown): { raw: unknown; dropped: string[] } {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).routines)) {
    return { raw, dropped: [] };
  }
  const root = raw as Record<string, unknown>;
  const routines = root.routines as unknown[];
  const dropped: string[] = [];
  const kept = routines.filter((r) => {
    if (r === null || typeof r !== "object") return true;
    const action = (r as Record<string, unknown>).action;
    const kind = action && typeof action === "object" ? (action as Record<string, unknown>).kind : undefined;
    if (typeof kind === "string" && (RETIRED_ACTION_KINDS as readonly string[]).includes(kind)) {
      const id = (r as Record<string, unknown>).id;
      dropped.push(typeof id === "string" ? id : "<unknown>");
      return false;
    }
    return true;
  });
  if (dropped.length === 0) return { raw, dropped };
  return { raw: { ...root, routines: kept }, dropped };
}

export interface RoutineStoreOptions {
  now?: () => Date;
  id?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Seed the built-in routines on load (default true; tests disable for a clean slate). */
  seedBuiltins?: boolean;
  /**
   * Config overrides for the built-ins ({@link BuiltinRoutineOverrides}). Schedules (free time)
   * are seed-only — applied ONLY when a definition is first written, because the store, not
   * config, is the source of truth for timing once a routine exists. The sweep's repo list is the
   * exception: it is config-authoritative on EVERY load, because it is an allow-list and two
   * sources of truth for an allow-list is how you sweep a repo nobody opted in.
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
  /** Ids of routines dropped by {@link dropRetiredRoutines} on the most recent `read()`. */
  private droppedRetiredIds: string[] = [];

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
    this.droppedRetiredIds = [];
    try {
      const raw = readFileSync(this.path, "utf8");
      const { raw: cleaned, dropped } = dropRetiredRoutines(JSON.parse(raw));
      this.droppedRetiredIds = dropped;
      for (const id of dropped) {
        this.logger.info("dropped routine carrying a retired action kind", { routineId: id });
      }
      return RoutineRegistrySchema.parse(cleaned);
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

  /**
   * Drop any id in {@link HEALED_REMOVED_BUILTINS} from `removedBuiltins`, before {@link seed} so
   * a healed id is reseeded the SAME load. Runs on every load, logged, idempotent: once the entry
   * is gone there is nothing left to heal, so a repeat boot is a no-op — the exact shape of
   * {@link migrateCredsEntry} above. Returns true if it changed anything.
   */
  private healRemovedBuiltins(reg: RoutineRegistry): boolean {
    let changed = false;
    for (const id of HEALED_REMOVED_BUILTINS) {
      const idx = reg.removedBuiltins.indexOf(id);
      if (idx === -1) continue;
      reg.removedBuiltins.splice(idx, 1);
      changed = true;
      this.logger.info("healed a stale removed-builtin entry", { routineId: id });
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

  /**
   * Force the `proactive-sweep` routine's `action.repos` to the config override, on EVERY load —
   * unlike {@link seed}, which only runs once. Config is the sole source of truth for this
   * allow-list: a value written to `routines.json` by any other means (a stale CLI write, a
   * hand-edited file) is overwritten here, never merged. No-op when no override was supplied
   * (tests that construct a store without `builtins.proactiveSweep` keep whatever is on disk).
   * Returns true if it changed anything.
   */
  private reconcileProactiveSweep(reg: RoutineRegistry): boolean {
    const override = this.builtinOverrides.proactiveSweep;
    if (!override) return false;
    let changed = false;
    for (const routine of reg.routines) {
      if (routine.action.kind !== "proactive-sweep") continue;
      const current = routine.action.repos;
      const next = [...new Set(override.repos.map((r) => r.trim()).filter(Boolean))];
      if (current.length === next.length && current.every((r, i) => r === next[i])) continue;
      routine.action = { ...routine.action, repos: next };
      routine.updatedAt = this.now().toISOString();
      changed = true;
    }
    return changed;
  }

  /**
   * Force the `nightly-dream` routine's window to the FIXED time in `[dream] fire_at` /
   * `[dream] timezone`, on EVERY load — the same config-authoritative treatment the proactive
   * sweep's repo list gets, and for the same reason: it is a config value a human edits, so a
   * seed-only binding would go stale the moment they edited it. Rerolls nothing by itself; the
   * scheduler re-rolls the period whenever the persisted `chosenFireAt` falls outside the new
   * window's period, and a one-minute window can only ever roll to its own start.
   * No-op when no override was supplied (a store built without `builtins.dream`).
   */
  private reconcileDreamSchedule(reg: RoutineRegistry): boolean {
    const override = this.builtinOverrides.dream;
    if (!override) return false;
    const next = fixedFireWindow(override.fireAt, override.tz);
    let changed = false;
    for (const routine of reg.routines) {
      if (routine.action.kind !== "dream" || !routine.schedule) continue;
      const w = routine.schedule.window;
      if (w.start === next.start && w.end === next.end && w.tz === next.tz) continue;
      routine.schedule = { ...routine.schedule, window: next };
      // A window move invalidates the minute already chosen inside the OLD one.
      routine.state = { ...routine.state, periodKey: null, chosenFireAt: null };
      routine.updatedAt = this.now().toISOString();
      changed = true;
    }
    return changed;
  }

  private async mutate<T>(change: (reg: RoutineRegistry) => T): Promise<T> {
    await this.acquireLock();
    try {
      const reg = this.read();
      let droppedRetired = false;
      for (const id of this.droppedRetiredIds) {
        if (!reg.removedBuiltins.includes(id)) reg.removedBuiltins.push(id);
        droppedRetired = true;
      }
      const migrated = this.migrateCredsEntry(reg);
      const healedRemoved = this.healRemovedBuiltins(reg);
      const seeded = this.seed(reg);
      const reconciled = this.reconcileProactiveSweep(reg);
      const dreamRetimed = this.reconcileDreamSchedule(reg);
      const before = JSON.stringify(reg);
      const result = change(reg);
      if (droppedRetired || migrated || healedRemoved || seeded || reconciled || dreamRetimed || JSON.stringify(reg) !== before)
        this.write(reg);
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
