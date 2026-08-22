/**
 * Beckett — Reminder store (`src/reminder/store.ts`)
 * =======================================================================================
 * Durable registry of reminders, persisted as one Zod-validated JSON file at
 * `<beckettDir>/reminders.json` — the SAME atomic tmp+rename + directory-lock discipline as
 * {@link ../routine/store.ts} (which itself mirrors the task registry), so the CLI and the daemon
 * can both mutate it safely and a restart never tears a write in half.
 *
 * The store is the single source of truth for the crash-safety state machine
 * ({@link ../reminder/scheduler.ts}): `setFiring` persists the CLAIM before a delivery attempt;
 * `removeOneShot`/`rollRecurring` persist the FINALIZE only after dispatch succeeds. Every write
 * goes through the same lock so a CLI `remind remove` racing the daemon's tick can't corrupt the
 * file, only serialize.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ReminderRegistrySchema, type Reminder, type ReminderRegistry } from "./types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;

export interface ReminderStoreOptions {
  now?: () => Date;
  id?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const EMPTY: ReminderRegistry = { version: 1, reminders: [] };

export type NewReminder = Omit<Reminder, "createdAt" | "updatedAt" | "status">;

export class ReminderStore {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(path: string, opts: ReminderStoreOptions = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.id ?? (() => randomUUID().slice(0, 8));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Every reminder, sorted by next fire time ascending (`remind list`'s contract). */
  async list(): Promise<Reminder[]> {
    return this.mutate((reg) =>
      reg.reminders.slice().sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt)),
    );
  }

  /** One reminder by id, or null. */
  async get(id: string): Promise<Reminder | null> {
    return this.mutate((reg) => reg.reminders.find((r) => r.id === id) ?? null);
  }

  /** Add a new reminder. Assigns an id if the caller left one unset (empty string). */
  async add(def: NewReminder): Promise<Reminder> {
    return this.mutate((reg) => {
      const id = def.id.trim() || this.id();
      if (reg.reminders.some((r) => r.id === id)) throw new Error(`reminder already exists: ${id}`);
      const now = this.now().toISOString();
      const reminder: Reminder = { ...def, id, status: "pending", createdAt: now, updatedAt: now };
      reg.reminders.push(reminder);
      return structuredClone(reminder);
    });
  }

  /** Remove a reminder by id. Returns false if it did not exist. */
  async remove(id: string): Promise<boolean> {
    return this.mutate((reg) => {
      const idx = reg.reminders.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      reg.reminders.splice(idx, 1);
      return true;
    });
  }

  /**
   * The scheduler's CLAIM, persisted BEFORE a delivery attempt starts — see the module header.
   * No-op (returns false) if the reminder is gone or already claimed, so a racing double-claim
   * from two ticks can never happen.
   */
  async setFiring(id: string): Promise<boolean> {
    return this.mutate((reg) => {
      const reminder = reg.reminders.find((r) => r.id === id);
      if (!reminder || reminder.status === "firing") return false;
      reminder.status = "firing";
      reminder.updatedAt = this.now().toISOString();
      return true;
    });
  }

  /**
   * A claim that never became a confirmed delivery this tick (dispatch threw) — release the
   * claim back to `pending` so the NEXT tick retries it, rather than leaving it stuck `firing`
   * forever with no fresh attempt.
   */
  async setPending(id: string): Promise<void> {
    await this.mutate((reg) => {
      const reminder = reg.reminders.find((r) => r.id === id);
      if (!reminder) return;
      reminder.status = "pending";
      reminder.updatedAt = this.now().toISOString();
    });
  }

  /**
   * FINALIZE a one-shot reminder that just delivered: remove it from the store — the
   * "self-clearing" behavior ro asked for. Only ever called AFTER dispatch resolves.
   */
  async removeOneShot(id: string): Promise<void> {
    await this.mutate((reg) => {
      const idx = reg.reminders.findIndex((r) => r.id === id);
      if (idx !== -1) reg.reminders.splice(idx, 1);
    });
  }

  /**
   * FINALIZE a recurring reminder that just delivered: roll it to `nextFireAt` and clear the
   * claim, so it stays on the list per the "unless it's a weekly or whatever" ask. Only ever
   * called AFTER dispatch resolves.
   */
  async rollRecurring(id: string, nextFireAt: Date): Promise<void> {
    await this.mutate((reg) => {
      const reminder = reg.reminders.find((r) => r.id === id);
      if (!reminder) return;
      reminder.fireAt = nextFireAt.toISOString();
      reminder.status = "pending";
      reminder.updatedAt = this.now().toISOString();
    });
  }

  // --- persistence internals (mirrors RoutineStore) ------------------------------------------

  private read(): ReminderRegistry {
    try {
      const raw = readFileSync(this.path, "utf8");
      return ReminderRegistrySchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return structuredClone(EMPTY);
      throw new Error(`reminder registry ${this.path} is unreadable: ${(err as Error).message}`);
    }
  }

  private async mutate<T>(change: (reg: ReminderRegistry) => T): Promise<T> {
    await this.acquireLock();
    try {
      const reg = this.read();
      const before = JSON.stringify(reg);
      const result = change(reg);
      if (JSON.stringify(reg) !== before) this.write(reg);
      return result;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private write(reg: ReminderRegistry): void {
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
    throw new Error(`reminder registry lock is held: ${this.lockPath}`);
  }
}
