/**
 * Beckett v7 — the run ledger (`src/run/store.ts`)
 * =======================================================================================
 * A JSON ledger at `<beckettDir>/runs.json` (`{version: 1, runs: Run[]}`) with the same
 * durability idioms as `src/task/store.ts`: zod-validated on load, atomic tmp+rename on
 * write, a malformed file never takes the daemon down (it is quarantined and the store
 * starts empty rather than crash-looping the boot).
 *
 * Deliberately synchronous. The whole ledger is a handful of KB and every writer is the
 * daemon's own single-threaded supervisor, so a lock file would buy nothing a rename does
 * not already give us.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Run, RunPatch, RunState } from "./types.ts";
import { RUN_TERMINAL } from "./types.ts";

const HarnessSpecSchema = z
  .object({
    harness: z.string().min(1),
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "ultracode"]).optional(),
    reviewTier: z.enum(["self", "fresh"]).optional(),
  })
  .passthrough();

const RunSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  channelId: z.string().nullable().default(null),
  requesterId: z.string().nullable().default(null),
  taskRef: z.string().nullable().default(null),
  ultracode: z.boolean().default(false),
  cast: z.record(HarnessSpecSchema.optional()).nullable().default(null),
  repo: z.string().nullable().default(null),
  state: z.enum([
    "queued",
    "implementing",
    "reviewing",
    "publishing",
    "done",
    "failed",
    "cancelled",
    "parked",
  ]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  workspace: z.string().nullable().default(null),
  branch: z.string().min(1),
  baseSha: z.string().nullable().default(null),
  sessionIds: z.record(z.string()).default({}),
  sessionName: z.string().min(1),
  reviewCycles: z.number().int().min(0).default(0),
  prUrl: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

const LedgerSchema = z.object({
  version: z.literal(1),
  runs: z.array(RunSchema).default([]),
});

/** Everything a caller must supply to mint a run; the rest is defaulted here. */
export interface CreateRunInput {
  id: string;
  slug: string;
  title: string;
  prompt: string;
  branch: string;
  sessionName: string;
  channelId?: string | null;
  requesterId?: string | null;
  taskRef?: string | null;
  ultracode?: boolean;
  cast?: Run["cast"];
  repo?: string | null;
  state?: RunState;
  createdAt?: string;
}

export class RunStore {
  private runs: Run[] = [];

  constructor(private readonly path: string) {
    this.load();
  }

  /** Mint a run in `queued` (unless the caller names a state) and persist it. */
  create(input: CreateRunInput): Run {
    if (this.runs.some((r) => r.id === input.id)) {
      throw new Error(`beckett: run "${input.id}" already exists`);
    }
    const now = new Date().toISOString();
    const run: Run = {
      id: input.id,
      slug: input.slug,
      title: input.title,
      prompt: input.prompt,
      channelId: input.channelId ?? null,
      requesterId: input.requesterId ?? null,
      taskRef: input.taskRef ?? null,
      ultracode: input.ultracode ?? false,
      cast: input.cast ?? null,
      repo: input.repo ?? null,
      state: input.state ?? "queued",
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      workspace: null,
      branch: input.branch,
      baseSha: null,
      sessionIds: {},
      sessionName: input.sessionName,
      reviewCycles: 0,
      prUrl: null,
      error: null,
    };
    this.runs.push(run);
    this.persist();
    return run;
  }

  get(id: string): Run | null {
    return this.runs.find((r) => r.id === id) ?? null;
  }

  bySlug(slug: string): Run | null {
    return this.runs.find((r) => r.slug === slug) ?? null;
  }

  list(filter: { states?: RunState[] } = {}): Run[] {
    const wanted = filter.states ? new Set(filter.states) : null;
    return this.runs.filter((r) => !wanted || wanted.has(r.state)).map((r) => ({ ...r }));
  }

  /** Every non-terminal run — what the boot scan and the staffing watchdog enumerate. */
  live(): Run[] {
    return this.runs.filter((r) => !RUN_TERMINAL.has(r.state)).map((r) => ({ ...r }));
  }

  /** Apply a patch and bump `updatedAt`. Returns the stored run, or null when unknown. */
  update(id: string, patch: RunPatch): Run | null {
    const index = this.runs.findIndex((r) => r.id === id);
    if (index === -1) return null;
    const merged: Run = { ...this.runs[index]!, ...patch, updatedAt: new Date().toISOString() };
    this.runs[index] = merged;
    this.persist();
    return { ...merged };
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = LedgerSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      this.runs = parsed.runs as Run[];
    } catch {
      // A torn/hand-edited ledger must not crash-loop the daemon. Quarantine and start clean;
      // the operator still has the original bytes next to the live file.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* best-effort */
      }
      this.runs = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, runs: this.runs }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, this.path);
  }
}
