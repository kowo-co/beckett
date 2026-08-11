// W1A owns this file — integrator keeps theirs.
//
// THIN PLACEHOLDER so `task-deploy.ts` (W1B) has a real `RunStore` to construct and test
// against while W1A builds the durable version in parallel. Matches the `RunStoreLike`
// contract in `../cli/task-deploy.ts` and the JSON-ledger idiom `../task/store.ts` already
// uses (atomic tmp+rename writes, mkdir-lockfile mutual exclusion). Discard on integration —
// take W1A's `src/run/store.ts` wholesale, then re-point `task-deploy.ts`'s one construction
// call site (see its top-of-file comment) at whatever shape W1A's `create()` actually wants.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type { Casting } from "../tracker/types.ts";
import type { Run, RunState } from "./types.ts";

const LOCK_ATTEMPTS = 200;
const LOCK_STALE_MS = 30_000;

const HarnessSpecSchema = z.object({
  harness: z.string(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  reviewTier: z.enum(["self", "fresh"]).optional(),
});

const CastingSchema: z.ZodType<Casting> = z.record(z.string(), HarnessSpecSchema.optional());

const RunSchema: z.ZodType<Run> = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  channelId: z.string().nullable(),
  requesterId: z.string().nullable(),
  taskRef: z.string().nullable(),
  ultracode: z.boolean(),
  cast: CastingSchema.nullable(),
  repo: z.string().nullable(),
  state: z.enum(["queued", "implementing", "reviewing", "publishing", "done", "failed", "cancelled", "parked"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  workspace: z.string().nullable(),
  branch: z.string(),
  baseSha: z.string().nullable(),
  sessionIds: z.record(z.string(), z.string()),
  sessionName: z.string(),
  reviewCycles: z.number().int().nonnegative(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
});

const RunLedgerSchema = z.object({
  version: z.literal(1),
  runs: z.array(RunSchema),
});

type RunLedger = z.infer<typeof RunLedgerSchema>;

const RUN_TERMINAL: ReadonlySet<RunState> = new Set(["done", "failed", "cancelled", "parked"]);

export class RunStore {
  private readonly lockPath: string;

  constructor(readonly path: string) {
    this.lockPath = `${path}.lock`;
  }

  /** Persist a fully-formed Run (the caller mints id/slug/branch/sessionName — see task-deploy.ts). */
  async create(run: Run): Promise<Run> {
    return this.mutate((ledger) => {
      if (ledger.runs.some((r) => r.id === run.id)) {
        throw new Error(`run ${run.id} already exists`);
      }
      const stored = structuredClone(run);
      ledger.runs.push(stored);
      return structuredClone(stored);
    });
  }

  get(id: string): Run | null {
    return structuredClone(this.read().runs.find((r) => r.id === id) ?? null);
  }

  bySlug(slug: string): Run | null {
    return structuredClone(this.read().runs.find((r) => r.slug === slug) ?? null);
  }

  list(opts: { states?: RunState[] } = {}): Run[] {
    const runs = this.read().runs;
    const filtered = opts.states ? runs.filter((r) => opts.states!.includes(r.state)) : runs;
    return structuredClone(filtered);
  }

  async update(id: string, patch: Partial<Run>): Promise<Run> {
    return this.mutate((ledger) => {
      const run = ledger.runs.find((r) => r.id === id);
      if (!run) throw new Error(`no such run: ${id}`);
      Object.assign(run, patch, { updatedAt: new Date().toISOString() });
      return structuredClone(run);
    });
  }

  live(): Run[] {
    return structuredClone(this.read().runs.filter((r) => !RUN_TERMINAL.has(r.state)));
  }

  private read(): RunLedger {
    try {
      const raw = readFileSync(this.path, "utf8");
      return RunLedgerSchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { version: 1, runs: [] };
      throw new Error(`run ledger ${this.path} is unreadable: ${(err as Error).message}`);
    }
  }

  private write(ledger: RunLedger): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(ledger, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
  }

  private async mutate<T>(change: (ledger: RunLedger) => T): Promise<T> {
    await this.acquireLock();
    try {
      const ledger = this.read();
      const result = change(ledger);
      this.write(ledger);
      return result;
    } finally {
      rmSync(this.lockPath, { recursive: true, force: true });
    }
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
          const age = Date.now() - statSync(this.lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) {
            rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // lock vanished between the EEXIST and the stat — fine, next attempt will succeed
        }
        await Bun.sleep(25);
      }
    }
    throw new Error(`run ledger ${this.path}: lock contention timed out`);
  }
}
