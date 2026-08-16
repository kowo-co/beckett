/**
 * Beckett — Run store (`src/run/store.ts`)
 * =======================================================================================
 * Durable ledger for {@link Run} rows: `<beckettDir>/runs.json`, `{version:1, runs: Run[]}`,
 * same atomic tmp+rename + directory-lock discipline as `../task/store.ts` (and the agent/routine
 * registries) so the CLI and the daemon can both mutate it safely.
 *
 * Unlike the CLI-facing agent/task stores, a corrupt or unparsable ledger must never take the
 * daemon down on boot: `read()` degrades to a fresh empty ledger with a warn log rather than
 * throwing, so a hand-corrupted `runs.json` costs the daemon its run history, not its liveness.
 * A subsequent successful `mutate()` is what actually overwrites the bad file on disk — reading
 * alone never destroys evidence of the corruption.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { log } from "../log.ts";
import type { Logger } from "../types.ts";
import type { BlockerClass, CiVerdict, LandingMode, Run, RunState } from "./types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;

const RUN_STATES = [
  "queued",
  "implementing",
  "reviewing",
  "publishing",
  "awaiting_input",
  "unverified",
  "done",
  "failed",
  "cancelled",
  "parked",
] as const;

/**
 * Non-terminal states — a run in one of these still has (or will have) a live worker.
 * `awaiting_input` (B8) belongs here: the run is live, just waiting on a person's answer instead
 * of a worker's turn — `beckett status` and the dashboard must keep showing it as in-flight.
 * `unverified` (B12) belongs here for the identical reason: the run published, but its proof has
 * not yet earned `verified` — the staffing watchdog keeps re-checking it, not a human.
 */
const LIVE_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "implementing",
  "reviewing",
  "publishing",
  "awaiting_input",
  "unverified",
  "parked",
]);

// Deliberately NOT `.strict()` (matches `../task/store.ts`'s idiom): these schemas run in
// strip mode, tolerating and dropping unknown fields rather than failing to parse. A ledger
// read is a degrade-to-empty-on-failure path (see `read()` below), so `.strict()` here would
// mean one unknown field on one row — a version-skew field, a sibling-lane writer with a wider
// shape, a hand edit — makes the ENTIRE ledger read as empty, and the next mutate() persists
// that empty ledger over the real one. Stripping unknown keys is the safe default; only a
// genuinely malformed row (wrong type, missing required field) should fail the parse.
const HarnessSpecSchema = z.object({
  harness: z.string().min(1),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "ultracode"]).optional(),
  reviewTier: z.enum(["self", "fresh"]).optional(),
  // Sonnet-first (issue #249): the framer's stated reason an IMPLEMENT-stage opus cast clears
  // sonnet's bar. Without this field the persisted round-trip (`patchRun`/`put`, both through
  // this schema) silently strips it — the reason would vanish from the run record on the very
  // next mutate() even though `cast.ts#applySonnetFirst` kept the cast because of it.
  reason: z.string().optional(),
});

// `Casting` is an open index signature (`[stage: string]: HarnessSpec | undefined`) keyed by
// stage name; a record schema mirrors that shape without hardcoding the stage set here.
const CastingSchema = z.record(z.string(), HarnessSpecSchema.optional());

// Mirrors `./types.ts#BlockerClass` verbatim — kept as a literal list here (not derived) because
// zod enums need the literal tuple, same idiom as `HarnessSpecSchema.effort` above.
const BLOCKER_CLASSES = [
  "credential",
  "admin-permission",
  "product-decision",
  "money",
  "question",
  "transient",
  "continuation",
] as const satisfies readonly BlockerClass[];

const BlockerSchema = z.object({
  class: z.enum(BLOCKER_CLASSES),
  actor: z.enum(["human", "supervisor"]),
  reversible: z.boolean(),
  remedy: z.string(),
  detail: z.string(),
  defaultAnswer: z.string().nullable(),
  // Nullable + defaulted for the same reason as `Run.blocker` below: an old persisted row (minted
  // before this field existed) still parses, and `resume()` falls back to `lastStageOf`.
  stage: z.enum(["implement", "review"]).nullable().default(null),
  at: z.string(),
});

// Mirrors `./types.ts#LandingMode`/`CiVerdict` verbatim — literal lists, same idiom as
// `BLOCKER_CLASSES` above (zod enums need the literal tuple).
const LANDING_MODES = ["pr", "direct-push", "courier", "local"] as const satisfies readonly LandingMode[];
const CI_VERDICTS = ["success", "failed", "pending", "none", "unknown"] as const satisfies readonly CiVerdict[];

// Nullable + defaulted (both the object and every OLD persisted row without one) so a run minted
// before proofs existed, or one that never reached `publishing`, still parses (B12 migration
// safety — same posture as `BlockerSchema`/`published` above).
const ProofSchema = z.object({
  landingMode: z.enum(LANDING_MODES),
  prUrl: z.string().nullable(),
  pushUrl: z.string().nullable(),
  prResolves: z.boolean().nullable(),
  ci: z.enum(CI_VERDICTS),
  uiWork: z.boolean(),
  screenshotPath: z.string().nullable(),
  verified: z.boolean(),
  gaps: z.array(z.string()),
  checkedAt: z.string(),
  attempts: z.number().int().nonnegative(),
});

const RunSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string(),
  channelId: z.string().nullable(),
  requesterId: z.string().nullable(),
  taskRef: z.string().nullable(),
  ultracode: z.boolean(),
  cast: CastingSchema.nullable(),
  repo: z.string().nullable(),
  state: z.enum(RUN_STATES),
  createdAt: z.string(),
  updatedAt: z.string(),
  workspace: z.string().nullable(),
  branch: z.string().min(1),
  baseSha: z.string().nullable(),
  // Plain string-keyed record rather than enum-keyed: a future third RunStage (or a sibling
  // lane's wider stage set) must stay parseable, not collapse the whole ledger to empty.
  sessionIds: z.record(z.string(), z.string()).default({}),
  sessionName: z.string().min(1),
  reviewCycles: z.number().int().nonnegative(),
  // Nullable-safe default so an OLD persisted row (minted before continuations existed) parses.
  continuations: z.number().int().nonnegative().default(0),
  // Nullable-safe default so an OLD persisted row (minted before auto-resume existed) parses (B7).
  autoResumes: z.number().int().nonnegative().default(0),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  // Nullable + defaulted so an OLD persisted row (minted before `published` existed) still parses
  // — the whole point of this schema running in strip/tolerant mode (#228 migration safety).
  published: z
    .object({ via: z.enum(["outbox", "courier"]), prUrl: z.string().nullable() })
    .nullable()
    .default(null),
  // Nullable + defaulted so an OLD persisted row (minted before blockers existed) still parses —
  // and so a run with no blocker (every non-parked state) round-trips without one.
  blocker: BlockerSchema.nullable().default(null),
  // Nullable + defaulted so an OLD persisted row (minted before questions existed) still parses —
  // and so a run with no open question (every non-`awaiting_input` state) round-trips without one.
  question: z
    .object({
      stage: z.enum(["implement", "review"]),
      text: z.string(),
      defaultAnswer: z.string().nullable(),
      askedAt: z.string(),
      expiresAt: z.string(),
    })
    .nullable()
    .default(null),
  // Nullable + defaulted so an OLD persisted row (minted before proofs existed) still parses —
  // and so a run that never reached `publishing` (every non-`unverified`/`done` state) round-trips
  // without one (B12).
  proof: ProofSchema.nullable().default(null),
  landingMode: z.enum(LANDING_MODES).nullable().default(null),
  // Defaulted so an OLD persisted row (minted before dependency edges existed) still parses, and
  // a run declaring neither `--needs` nor `--files` round-trips with the empty arrays that keep
  // this feature opt-in (B9).
  deps: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
});

const LedgerSchema = z.object({
  version: z.literal(1),
  runs: z.array(RunSchema),
});

type RunLedger = z.infer<typeof LedgerSchema>;

const EMPTY_LEDGER: RunLedger = { version: 1, runs: [] };

export interface RunStoreOptions {
  now?: () => Date;
  /** Id generator for internal disambiguation (not the run id itself, which is minted). */
  id?: () => string;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/**
 * Fields a caller supplies to mint a new run. Everything else (`id`, `branch`, `sessionName`,
 * `state`, timestamps, `sessionIds`, `reviewCycles`) is derived/defaulted by `create()`.
 */
export interface CreateRunInput {
  /** Short human title. Also the default source for the minted slug. */
  title: string;
  /** The original request, verbatim. */
  prompt: string;
  /**
   * Slug hint — normalized to kebab-case and deduped against every existing run's slug
   * (`-2`, `-3`, …). Defaults to a slugified `title` when omitted.
   */
  slug?: string;
  channelId?: string | null;
  requesterId?: string | null;
  taskRef?: string | null;
  ultracode?: boolean;
  cast?: Run["cast"];
  repo?: string | null;
  /** Run ids this run must not start before (`--needs`, resolved from slugs by the CLI). B9. */
  deps?: string[];
  /** Repo-relative paths/directory-prefixes this run expects to touch (`--files`). B9. */
  files?: string[];
}

export interface ListRunsOptions {
  /** Restrict to runs whose state is one of these. */
  states?: RunState[];
}

export class RunStore {
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(readonly path: string, opts: RunStoreOptions = {}) {
    this.lockPath = `${path}.lock`;
    this.now = opts.now ?? (() => new Date());
    this.id = opts.id ?? randomUUID;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.logger = opts.logger ?? log.child("run.store");
  }

  async create(input: CreateRunInput): Promise<Run> {
    return this.mutate((ledger) => {
      const now = this.now().toISOString();
      const date = now.slice(0, 10).replace(/-/g, "");
      const slug = uniqueSlug(ledger.runs, input.slug ?? input.title);
      const run: Run = {
        id: `run-${date}-${slug}`,
        slug,
        title: normalizeTitle(input.title),
        prompt: input.prompt,
        channelId: input.channelId ?? null,
        requesterId: input.requesterId ?? null,
        taskRef: input.taskRef ?? null,
        ultracode: input.ultracode ?? false,
        cast: input.cast ?? null,
        repo: input.repo ?? null,
        state: "queued",
        createdAt: now,
        updatedAt: now,
        workspace: null,
        branch: `beckett/run-${slug}`,
        baseSha: null,
        sessionIds: {},
        sessionName: `beckett-run-${slug}`,
        reviewCycles: 0,
        continuations: 0,
        autoResumes: 0,
        prUrl: null,
        error: null,
        published: null,
        blocker: null,
        question: null,
        proof: null,
        landingMode: null,
        deps: input.deps ?? [],
        files: input.files ?? [],
      };
      ledger.runs.push(run);
      return structuredClone(run);
    });
  }

  get(id: string): Run | null {
    return structuredClone(this.read().runs.find((run) => run.id === id) ?? null);
  }

  bySlug(slug: string): Run | null {
    return structuredClone(this.read().runs.find((run) => run.slug === slug) ?? null);
  }

  list(opts: ListRunsOptions = {}): Run[] {
    const runs = this.read().runs;
    const filtered = opts.states ? runs.filter((run) => opts.states!.includes(run.state)) : runs;
    return structuredClone(filtered).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /**
   * Every run in a non-terminal state (queued/implementing/reviewing/publishing/awaiting_input/
   * unverified/parked).
   */
  live(): Run[] {
    return this.list().filter((run) => LIVE_STATES.has(run.state));
  }

  /**
   * `slug`/`branch`/`sessionName`/`createdAt` are minted once by `create()` and never patched:
   * `bySlug()` and the collision-dedupe in `uniqueSlug()` both assume a run's slug (and the
   * branch/sessionName derived from it) is stable identity, not a mutable field.
   */
  async update(id: string, patch: Partial<Omit<Run, "id" | "slug" | "branch" | "sessionName" | "createdAt">>): Promise<Run> {
    return this.mutate((ledger) => {
      const run = ledger.runs.find((candidate) => candidate.id === id);
      if (!run) throw new Error(`no such run: ${id}`);
      Object.assign(run, patch);
      run.updatedAt = this.now().toISOString();
      return structuredClone(run);
    });
  }

  /**
   * Backfill the PR URL on a courier-published run once a human knows it (#228). There is no
   * automatic signal for a courier-landed PR — the daemon never drove that publish — so this is a
   * plain setter for a human/future caller to invoke explicitly. Deliberately narrow: a no-op
   * (returns the run unchanged) unless the run is actually `published.via === "courier"` with
   * `prUrl` still `null`, so it can never clobber a normal outbox publish or overwrite evidence
   * that is already there. Leaves `state`/`error` untouched — a courier run is already `done`.
   */
  async backfillCourierPrUrl(id: string, prUrl: string): Promise<Run> {
    return this.mutate((ledger) => {
      const run = ledger.runs.find((candidate) => candidate.id === id);
      if (!run) throw new Error(`no such run: ${id}`);
      if (run.published?.via === "courier" && run.published.prUrl === null) {
        run.published = { via: "courier", prUrl };
        run.prUrl = prUrl;
        run.updatedAt = this.now().toISOString();
      }
      return structuredClone(run);
    });
  }

  private read(): RunLedger {
    try {
      const raw = readFileSync(this.path, "utf8");
      return LedgerSchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return structuredClone(EMPTY_LEDGER);
      this.logger.warn("runs.json unreadable/corrupt — starting from a fresh empty ledger", {
        path: this.path,
        error: (err as Error).message,
      });
      return structuredClone(EMPTY_LEDGER);
    }
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

  private write(ledger: RunLedger): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${this.id()}.tmp`;
    writeFileSync(temp, JSON.stringify(ledger, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
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
        await this.sleep(10 + attempt);
      }
    }
    throw new Error(`timed out waiting for run store lock ${this.lockPath}`);
  }
}

/** Kebab-case a free-text hint. Falls back to "run" if nothing alphanumeric survives. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "run";
}

/**
 * Slug + branch + sessionName all derive from the SAME slug, and branch/sessionName carry no
 * date component — so uniqueness has to be checked against every run ever filed (any date), not
 * just the runs minted today, or two differently-dated runs sharing a title would collide on
 * branch name / cross-session address even though their `run-YYYYMMDD-<slug>` ids differ.
 */
function uniqueSlug(existing: Run[], hint: string): string {
  const base = slugify(hint);
  const taken = new Set(existing.map((run) => run.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function normalizeTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  return title || "untitled run";
}

export function createRunStore(path: string, opts?: RunStoreOptions): RunStore {
  return new RunStore(path, opts);
}
