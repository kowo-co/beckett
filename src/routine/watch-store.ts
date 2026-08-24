/**
 * Beckett — watch routine runtime state (`src/routine/watch-store.ts`)
 * =======================================================================================
 * Durable, per-routine state for the `watch` action (issue #1): the seen-item set that makes a
 * cold start post nothing, and the post history that backs both the model-id dedup rule and the
 * rate limiter. Persisted as one Zod-validated JSON file at `<beckettDir>/watch-state.json`,
 * with the same atomic tmp+rename + directory-lock discipline as {@link ./store.ts} so the CLI
 * (a one-shot dry-run preview) and the daemon (the live poll loop) can both read/write it safely.
 *
 * The feed is a third-party service this routine does not control, so the seen-set and post
 * history are both bounded here — capped by count AND aged out by time — rather than trusting
 * the feed to stay small forever.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;

/** Bounds on the seen-set: whichever limit bites first. A handful-of-items-per-day feed will
 *  never come close to either in practice — these exist purely so a misbehaving feed (or a
 *  routine left running for years) can't grow this file without limit. */
export const WATCH_SEEN_CAP = 500;
export const WATCH_SEEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Post history only needs the trailing 24h for rate-limiting; kept a little longer for `inspect`. */
export const WATCH_POST_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const WatchSeenItemSchema = z.object({ id: z.string(), firstSeenAt: z.string() });

export const WatchPostRecordSchema = z.object({
  modelId: z.string(),
  postedAt: z.string(),
  /** Not known at dispatch time (the real post confirms asynchronously) — kept for future use. */
  url: z.string().nullable().default(null),
  /** True for a dry-run "would have posted" entry — kept in its own accounting bucket. */
  simulated: z.boolean().default(false),
});
export type WatchPostRecord = z.infer<typeof WatchPostRecordSchema>;

export const WatchRoutineStateSchema = z.object({
  /** False until the very first poll has run; blocks every fire until the cold start seeds. */
  seeded: z.boolean().default(false),
  seenIds: z.array(WatchSeenItemSchema).default([]),
  posts: z.array(WatchPostRecordSchema).default([]),
  lastPolledAt: z.string().nullable().default(null),
});
export type WatchRoutineState = z.infer<typeof WatchRoutineStateSchema>;

const WatchFileSchema = z.object({
  version: z.literal(1),
  routines: z.record(z.string(), WatchRoutineStateSchema).default({}),
});
type WatchFile = z.infer<typeof WatchFileSchema>;

const EMPTY_STATE: WatchRoutineState = { seeded: false, seenIds: [], posts: [], lastPolledAt: null };
const EMPTY_FILE: WatchFile = { version: 1, routines: {} };

/** Enforce the age + count bounds on one routine's state before it's ever written to disk. */
function pruneState(state: WatchRoutineState, now: Date): WatchRoutineState {
  const seenCutoff = now.getTime() - WATCH_SEEN_MAX_AGE_MS;
  let seenIds = state.seenIds.filter((s) => {
    const at = Date.parse(s.firstSeenAt);
    return !Number.isFinite(at) || at >= seenCutoff;
  });
  if (seenIds.length > WATCH_SEEN_CAP) seenIds = seenIds.slice(seenIds.length - WATCH_SEEN_CAP);

  const postCutoff = now.getTime() - WATCH_POST_HISTORY_MAX_AGE_MS;
  const posts = state.posts.filter((p) => {
    const at = Date.parse(p.postedAt);
    return !Number.isFinite(at) || at >= postCutoff;
  });

  return { ...state, seenIds, posts };
}

export interface WatchStateStoreOptions {
  now?: () => Date;
  id?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export class WatchStateStore {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(path: string, opts: WatchStateStoreOptions = {}) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.id ?? (() => randomUUID().slice(0, 8));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One routine's state, or the empty default if it has never polled. Read-only. */
  async get(routineId: string): Promise<WatchRoutineState> {
    return this.mutate((file) => structuredClone(file.routines[routineId] ?? EMPTY_STATE));
  }

  /** Atomic read-modify-write against one routine's state; the result is pruned before it persists. */
  async update(
    routineId: string,
    change: (state: WatchRoutineState) => WatchRoutineState,
  ): Promise<WatchRoutineState> {
    return this.mutate((file) => {
      const current = structuredClone(file.routines[routineId] ?? EMPTY_STATE);
      const updated = pruneState(change(current), this.now());
      file.routines[routineId] = updated;
      return structuredClone(updated);
    });
  }

  // --- persistence internals (mirrors RoutineStore) -----------------------------------------

  private read(): WatchFile {
    try {
      const raw = readFileSync(this.path, "utf8");
      return WatchFileSchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return structuredClone(EMPTY_FILE);
      throw new Error(`watch state ${this.path} is unreadable: ${(err as Error).message}`);
    }
  }

  private async mutate<T>(change: (file: WatchFile) => T): Promise<T> {
    await this.acquireLock();
    try {
      const file = this.read();
      const before = JSON.stringify(file);
      const result = change(file);
      if (JSON.stringify(file) !== before) this.write(file);
      return result;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
  }

  private write(file: WatchFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${this.id()}.tmp`;
    writeFileSync(temp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
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
    throw new Error(`watch state lock is held: ${this.lockPath}`);
  }
}
