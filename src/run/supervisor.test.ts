/**
 * RunSupervisor tests (`src/run/supervisor.ts`).
 * The spawn helper and the git ops are faked (the same posture as `dispatch/dispatcher.test.ts`:
 * `mock.module` the spawn seam, INJECT the git ops so `worker/worktree.ts` stays un-mocked for
 * everyone else), so the whole engine — admission, the cap queue, the stage flow, rework bounds,
 * crash resume, the watchdog, and the budget ceiling — runs deterministically with no real worker.
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config, DoneBlocker } from "../types.ts";
import type { HarnessSpec } from "./cast.ts";
import type { Harness as HarnessName } from "../types.ts";
import { appendSpendRecord, type SpendRecord } from "../spend.ts";
import type { DispatchEvent } from "../dispatch/events.ts";
import { restartBlockingRunWorkers } from "../deploy/run-drain.ts";
import type { RunGitOps } from "./supervisor.ts";
import { RunStore } from "./store.ts";
import { SPEC_FILE_REL } from "./spec-file.ts";
import type { CapabilityInventory, CapabilityTarget } from "../capability/preflight.ts";
import type { Run } from "./types.ts";
import type { BranchVsMainRaw } from "../worker/worktree.ts";

// ── controllable fake worker handle + spawn mock ────────────────────────────────────────────
interface SpawnCall {
  itemId: string;
  stage: string;
  harness: HarnessSpec;
  branch: string;
  baseRef: string;
  sessionName?: string;
  settingsExtra?: Record<string, unknown>;
  extraHooks?: { event: string; command: string }[];
  resumeSessionId?: string;
  steering?: string[];
  reviewDiff?: string;
  body: string;
  /** The worker's granular event callback — the journal sink AND the activity blurb lane. */
  onProgress?: (ev: unknown, ctx: { stage: string; workerId: string }) => void;
}
let spawnCalls: SpawnCall[] = [];
let created: any[] = [];
let counter = 0;
let spawnThrows: Error | null = null;

function makeHandle(args: any) {
  const doneCbs = new Set<(s: "success" | "error", sum: string) => void>();
  let result: any = null;
  const h: any = {
    id: `wk_${++counter}`,
    workerId: `wk_${counter}`,
    itemId: args.item.id,
    stage: args.stage,
    harness: args.harness.harness,
    workspace: args.workspace,
    branch: args.branch,
    sessionId: `sess-${counter}`,
    pid: 1000 + counter,
    state: "running",
    get result() {
      return result;
    },
    nudges: [] as string[],
    nudgeReceipt: "delivered" as string,
    async nudge(t: string) {
      h.nudges.push(t);
      return h.nudgeReceipt;
    },
    async abort() {},
    onDone(cb: (s: "success" | "error", sum: string) => void) {
      if (result) cb(result.status, result.summary);
      else doneCbs.add(cb);
    },
    onFinished(cb: any) {
      h.onDone(cb);
    },
    onStalled() {},
    stallFingerprint: () => null,
    async reap() {},
    // test trigger: complete the worker with a status + optional structured done-signal.
    // `extra` carries the rest of the real `WorkerResult` — `errorMessage` (the driver's own
    // lifecycle diagnostic, #247) and `timedOut` are the two a death path reads.
    finish(
      status: "success" | "error",
      summary: string,
      structured: unknown = null,
      extra: Record<string, unknown> = {},
    ) {
      result = { status, summary, structured, timedOut: false, unappliedNudges: [], ...extra };
      for (const cb of doneCbs) cb(status, summary);
    },
  };
  return h;
}

const fakeSpawn = async (args: any) => {
  spawnCalls.push({
    itemId: args.item.id,
    stage: args.stage,
    harness: args.harness,
    branch: args.branch,
    baseRef: args.baseRef,
    sessionName: args.sessionName,
    settingsExtra: args.settingsExtra,
    extraHooks: args.extraHooks,
    resumeSessionId: args.resumeSessionId,
    steering: args.steering,
    reviewDiff: args.reviewDiff,
    body: args.item.body,
    onProgress: args.onProgress,
  });
  if (spawnThrows) throw spawnThrows;
  const h = makeHandle(args);
  created.push(h);
  return h;
};
// bun's module mock is process-global, so the replacement must keep the REAL module's other
// exports (`writeWorkerMeta`, `workerMcpServerConfig`, …) — otherwise `dispatch/spawn.test.ts`
// loses them whenever it runs in the same process as this file.
const realSpawnModule = await import("../dispatch/spawn.ts");
mock.module("../dispatch/spawn.ts", () => ({
  ...realSpawnModule,
  spawnWorker: fakeSpawn,
}));

const { RunSupervisor, runProjectSlug, runSpecReader, PUBLISH_STALL_MS } = await import("./supervisor.ts");
const { resolveSelfProjectOwner } = await import("../github/owner.ts");

// ── injected git fakes ──────────────────────────────────────────────────────────────────────
let commitCalls: { workspace: string; message: string }[] = [];
let ensureCalls: { repoRoot: string; slug: string; owner: string }[] = [];
let commitResult = { committed: true, sha: "commit000" };
/** The diff the review stage pre-reads — a `let` so a test can swap in a copy/href surface (#234). */
const DEFAULT_REVIEW_DIFF = "diff --git a/x.ts b/x.ts\n+added";
let reviewDiffText = DEFAULT_REVIEW_DIFF;
/** B9: recorded `mergeBranchesIntoWorktree` calls, and an optional throw for the conflict test. */
let mergeCalls: { workspace: string; branches: string[] }[] = [];
let mergeThrows: Error | null = null;
/** B9: recorded `createWorktree` calls — which `baseRef` a dependent run was actually cut from. */
let createWorktreeCalls: { workspace: string; branch: string; baseRef: string }[] = [];
const gitFakes: Partial<RunGitOps> = {
  commitWorktree: async (workspace: string, message: string) => {
    commitCalls.push({ workspace, message });
    return commitResult;
  },
  headSha: async () => "base000",
  hasDiffSince: async () => true,
  ensureProjectRepo: async (repoRoot: string, slug: string, owner: string) => {
    ensureCalls.push({ repoRoot, slug, owner });
  },
  readDiff: async () => reviewDiffText,
  createWorktree: async (opts) => {
    createWorktreeCalls.push({ workspace: opts.workspace, branch: opts.branch, baseRef: opts.baseRef });
    mkdirSync(opts.workspace, { recursive: true });
    return { repoRoot: opts.repoRoot, workspace: opts.workspace, branch: opts.branch };
  },
  removeWorktree: async () => {},
  deleteBranch: async () => {},
  remoteBranchExists: async () => false,
  fetchRemote: async () => true,
  mergeBranchesIntoWorktree: async (workspace: string, branches: string[]) => {
    mergeCalls.push({ workspace, branches });
    if (mergeThrows) throw mergeThrows;
  },
  // Default: comparison unavailable → the generic push hand-off. Tests that assert case (a)/(b)/(c)
  // advice override this per-test to return the specific branch-vs-main shape.
  readBranchVsMain: async () => ({ compared: false, ahead: 0, behind: 0, aheadUnlanded: 0 }),
};

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Let the whole async finish→spawn chain (commit, worktree, spawn) settle deterministically. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
let dirs: string[] = [];
function scratch(prefix = "beckett-run-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function cfg(over: Record<string, unknown> = {}): Config {
  return {
    identity: { github_user: "test-account", gmail_address: "" },
    concurrency: { max_workers: 2 },
    runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0 },
    budget: { per_task_usd_cap: 0 },
    supervise: { staffing_watchdog_s: 120, worker_checkpoint_s: 0 },
    models: { reviewer: "claude-opus-5" },
    harness: {
      claude: { enabled: true, default_model: "claude-sonnet-5", default_effort: "high" },
      codex: { enabled: true },
      pi: { enabled: true },
    },
    ...over,
  } as unknown as Config;
}

function makeRun(over: Partial<Run> = {}): Run {
  const slug = over.slug ?? "oauth";
  return {
    id: over.id ?? `run-20260810-${slug}`,
    slug,
    title: over.title ?? "Add OAuth middleware",
    prompt: over.prompt ?? "Add OAuth middleware to the API gateway.",
    channelId: over.channelId ?? "chan-1",
    requesterId: null,
    taskRef: null,
    ultracode: over.ultracode ?? false,
    cast: over.cast ?? null,
    // `repo: null` is a MEANINGFUL value (beckett itself), so it must survive the override merge.
    repo: over.repo === undefined ? "gateway" : over.repo,
    state: over.state ?? "queued",
    createdAt: over.createdAt ?? "2026-08-10T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-08-10T00:00:00.000Z",
    workspace: over.workspace ?? null,
    branch: over.branch ?? `beckett/run-${slug}`,
    baseSha: over.baseSha ?? null,
    sessionIds: over.sessionIds ?? {},
    sessionName: over.sessionName ?? `beckett-run-${slug}`,
    reviewCycles: over.reviewCycles ?? 0,
    continuations: over.continuations ?? 0,
    autoResumes: over.autoResumes ?? 0,
    prUrl: null,
    error: over.error ?? null,
    published: over.published === undefined ? null : over.published,
    blocker: over.blocker === undefined ? null : over.blocker,
    question: over.question === undefined ? null : over.question,
    proof: over.proof === undefined ? null : over.proof,
    landingMode: over.landingMode === undefined ? null : over.landingMode,
    deps: over.deps ?? [],
    files: over.files ?? [],
  };
}

/**
 * Seed a fully-formed {@link Run} straight into the ledger file.
 *
 * `RunStore.create()` deliberately mints its OWN id/slug/branch/timestamps and always starts a run
 * at `queued`, so it cannot express the mid-flight fixtures these tests need — a run already
 * `reviewing`, or one whose `createdAt` the budget ceiling keys spend rows off. Writing the row is
 * the honest statement of "the ledger already contains this run", and it exercises the store's real
 * on-disk schema (a shape mismatch still fails the very next `get()`).
 */
function seedRun(store: RunStore, run: Run): Run {
  const ledger: { version: 1; runs: Run[] } = existsSync(store.path)
    ? (JSON.parse(readFileSync(store.path, "utf8")) as { version: 1; runs: Run[] })
    : { version: 1, runs: [] };
  ledger.runs.push(run);
  mkdirSync(dirname(store.path), { recursive: true });
  writeFileSync(store.path, JSON.stringify(ledger, null, 2));
  return run;
}

function doneSignal(done: boolean, summary: string = done ? "complete" : "blocked", blocker: DoneBlocker | null = null) {
  return { done, summary, filesChanged: ["src/app.ts"], checksRun: ["bun test"], blocker };
}

interface Harness {
  supervisor: InstanceType<typeof RunSupervisor>;
  store: RunStore;
  repos: string;
  publishCalls: { slug: string; ticket?: string; commitMessage?: string }[];
  events: DispatchEvent[];
}

function newSupervisor(
  opts: {
    config?: Config;
    publish?: boolean | (() => Promise<{ url: string; kind: "pushed" | "pr"; prUrl?: string }>);
    runtimeStatePath?: string;
    spendLedgerPath?: string;
    publishOutboxPath?: string;
    store?: RunStore;
    /** The activity-blurb POLISH seam — a fake here is what keeps this suite off the network. */
    summarizeActivity?: (lines: string[], opts: { provider?: string }) => Promise<string | null>;
    now?: () => number;
    preflight?: (harness: HarnessName) => Promise<{ ok: boolean; problems: string[] }>;
    capabilityPreflight?: (target: CapabilityTarget) => Promise<CapabilityInventory>;
    pauseFilePath?: string;
    verifyPr?: (prUrl: string) => Promise<{ resolves: boolean; ci: import("./types.ts").CiVerdict }>;
    frontendProof?: (args: { run: Run; workspace: string; baseRef: string }) => Promise<string | null>;
  } = {},
): Harness {
  const dir = scratch();
  const repos = join(dir, "repos");
  const store = opts.store ?? new RunStore(join(dir, "runs.json"));
  const publishCalls: Harness["publishCalls"] = [];
  // The card service's `specReader`/deploy-receipt tests read the run's own dispatch trace, the
  // SAME bus `progress/cards.ts` observes in production — captured here rather than through a
  // real DispatchEventBus so a torn events.jsonl can never make these tests flaky.
  const events: DispatchEvent[] = [];
  const supervisor = new RunSupervisor({
    store,
    config: opts.config ?? cfg(),
    gitOps: gitFakes,
    // The same resolver shape production wires (`shell/main.ts`): one slug rule for the repo root
    // and the publish target, so `repo: null` lands in beckett's own checkout here too.
    resolveRepoRoot: (run) => join(repos, runProjectSlug(run)),
    dispatchLiveSink: (event) => {
      events.push(event);
    },
    ...(opts.publish
      ? {
          publishRepo: async (a: any) => {
            publishCalls.push({ slug: a.slug, ticket: a.ticket, commitMessage: a.commitMessage });
            return typeof opts.publish === "function"
              ? await opts.publish()
              : { url: "https://github.com/o/gateway", kind: "pr" as const, prUrl: "https://github.com/o/gateway/pull/7" };
          },
        }
      : {}),
    // Default the blurb POLISH to a hard failure: any test that DOESN'T opt in must never be able
    // to reach a real model, and the run must survive the polish throwing. (With the shipped
    // default `provider = "off"` it is never called at all.)
    summarizeActivity: opts.summarizeActivity ?? (async () => {
      throw new Error("activity polish must be injected in tests");
    }),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.runtimeStatePath ? { runtimeStatePath: opts.runtimeStatePath } : {}),
    ...(opts.spendLedgerPath ? { spendLedgerPath: opts.spendLedgerPath } : {}),
    ...(opts.publishOutboxPath ? { publishOutboxPath: opts.publishOutboxPath } : {}),
    ...(opts.preflight ? { preflight: opts.preflight } : {}),
    ...(opts.capabilityPreflight ? { capabilityPreflight: opts.capabilityPreflight } : {}),
    ...(opts.pauseFilePath ? { pauseFilePath: opts.pauseFilePath } : {}),
    ...(opts.verifyPr ? { verifyPr: opts.verifyPr } : {}),
    ...(opts.frontendProof ? { frontendProof: opts.frontendProof } : {}),
  });
  return { supervisor, store, repos, publishCalls, events };
}

beforeEach(() => {
  spawnCalls = [];
  created = [];
  counter = 0;
  spawnThrows = null;
  commitCalls = [];
  ensureCalls = [];
  commitResult = { committed: true, sha: "commit000" };
  reviewDiffText = DEFAULT_REVIEW_DIFF;
  mergeCalls = [];
  mergeThrows = null;
  createWorktreeCalls = [];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// ── tests ───────────────────────────────────────────────────────────────────────────────────

describe("admission", () => {
  test("admit spawns one implement worker and moves the run to implementing", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.stage).toBe("implement");
    expect(spawnCalls[0]!.branch).toBe(run.branch);
    expect(store.get(run.id)!.state).toBe("implementing");
  });

  test("admit fires the deploy receipt's first event BEFORE any staffing/worktree event", async () => {
    const { supervisor, store, events } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(events[0]).toMatchObject({ runId: run.id, stage: "run:deploy", outcome: "started", message: "queued" });
    // Every event on this run's timeline is keyed by the run id — cards, digests, and telemetry
    // all find it with one key.
    expect(events.every((e) => e.runId === run.id && e.runRef === run.id)).toBe(true);
  });

  test("claim-before-dispatch: a double admit produces exactly one spawn", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    // Both calls race through the guard before either awaits — the synchronous reservation is
    // the only thing that can stop the second one.
    await Promise.all([supervisor.admit(run.id), supervisor.admit(run.id)]);
    await settle();
    expect(spawnCalls).toHaveLength(1);
  });

  test("a queued run is not staffed while paused, and is staffed after the hold lifts", async () => {
    const dir = scratch("beckett-pause-");
    const pauseFile = join(dir, "pause.json");
    writeFileSync(pauseFile, JSON.stringify({ pausedAt: "2026-08-15T00:00:00.000Z", reason: "hands off tonight", by: "jason" }));
    const { supervisor, store, events } = newSupervisor({ pauseFilePath: pauseFile });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls).toHaveLength(0);
    expect(events.some((e) => e.outcome === "held" && e.stage === "implement:staff")).toBe(true);
    rmSync(pauseFile);
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls).toHaveLength(1);
    expect(store.get(run.id)!.state).toBe("implementing");
  });

  test("a hold never stops a run that already has a worker from advancing to review", async () => {
    const dir = scratch("beckett-pause-");
    const pauseFile = join(dir, "pause.json");
    writeFileSync(pauseFile, JSON.stringify({ pausedAt: "2026-08-15T00:00:00.000Z", reason: null, by: null }));
    const { supervisor, store } = newSupervisor({ pauseFilePath: pauseFile });
    const run = seedRun(store, makeRun({ state: "reviewing", workspace: scratch("beckett-ws-") }));
    // `spawnGuarded` for a non-"queued" run must proceed even while a hold is on file (only a
    // never-staffed "queued" run is gated).
    (supervisor as any).spawnGuarded(run, "review");
    await tick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.stage).toBe("review");
  });

  test("the spec scaffold is written to .beckett/spec.md, never the worktree root", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    const workspace = store.get(run.id)!.workspace!;
    expect(existsSync(join(workspace, SPEC_FILE_REL))).toBe(true);
    expect(existsSync(join(workspace, "spec.md"))).toBe(false);
    const spec = readFileSync(join(workspace, SPEC_FILE_REL), "utf8");
    expect(spec).toContain("## Goal\nAdd OAuth middleware to the API gateway.");
    expect(spec).toContain("## Checklist");
    // The gate the worker will be held to is registered on the implement stage only. The hook
    // takes the workspace ROOT (`--root`) and resolves `<root>/${SPEC_FILE_REL}` itself — see
    // `specGateSpec` in ../hooks/registry.ts and `resolveConfig` in ../hooks/spec-gate.ts.
    expect(spawnCalls[0]!.extraHooks?.[0]!.event).toBe("Stop");
    expect(spawnCalls[0]!.extraHooks?.[0]!.command).toContain("spec-gate.ts");
    expect(spawnCalls[0]!.extraHooks?.[0]!.command).toContain(`--root ${JSON.stringify(workspace)}`);
  });

  test("a root spec.md stamped with THIS run is migrated into .beckett/ and the root copy is gone", async () => {
    // Older beckett versions wrote spec.md at the worktree root; a worker restarted mid-run after
    // an upgrade can still find one there, stamped for THIS run. It must move, not be replaced.
    const runId = "run-20260810-oauth";
    const orig = gitFakes.createWorktree!;
    gitFakes.createWorktree = async (opts) => {
      const made = await orig(opts);
      writeFileSync(
        join(opts.workspace, "spec.md"),
        `# Fixture\n> run: ${runId} · branch: beckett/x · created: yesterday\n\n` +
          "## Goal\nAdd OAuth middleware to the API gateway.\n\n## Checklist\n- [x] already done\n",
        "utf8",
      );
      return made;
    };
    try {
      const { supervisor, store } = newSupervisor();
      const run = seedRun(store, makeRun({ id: runId }));
      await supervisor.admit(run.id);
      await tick();
      const workspace = store.get(run.id)!.workspace!;
      expect(existsSync(join(workspace, "spec.md"))).toBe(false);
      const spec = readFileSync(join(workspace, SPEC_FILE_REL), "utf8");
      expect(spec).toContain(`> run: ${run.id}`);
      expect(spec).toContain("already done"); // migrated verbatim, not rescaffolded
    } finally {
      gitFakes.createWorktree = orig;
    }
  });

  test("a root spec.md stamped with ANOTHER run is left alone and does not become this run's spec", async () => {
    // A worktree cut from a base that carries a committed spec.md is born holding the PREVIOUS
    // run's spec; the scaffold must replace anything stamped with a different run id, or review
    // briefs inherit a stranger's acceptance criteria (which happened twice on 2026-08-12).
    const orig = gitFakes.createWorktree!;
    gitFakes.createWorktree = async (opts) => {
      const made = await orig(opts);
      writeFileSync(
        join(opts.workspace, "spec.md"),
        "# Some earlier run\n> run: run-previous · branch: beckett/old · created: yesterday\n\n" +
          "## Goal\nSomething else entirely.\n\n## Checklist\n- [x] stale criterion\n",
        "utf8",
      );
      return made;
    };
    try {
      const { supervisor, store } = newSupervisor();
      const run = seedRun(store, makeRun());
      await supervisor.admit(run.id);
      await tick();
      const workspace = store.get(run.id)!.workspace!;
      // Not provably ours to move — a foreign-stamped root spec.md is left exactly where it was.
      expect(readFileSync(join(workspace, "spec.md"), "utf8")).toContain("stale criterion");
      const spec = readFileSync(join(workspace, SPEC_FILE_REL), "utf8");
      expect(spec).toContain(`> run: ${run.id}`);
      expect(spec).not.toContain("stale criterion");
      expect(spec).toContain("Add OAuth middleware to the API gateway.");
    } finally {
      gitFakes.createWorktree = orig;
    }
  });

  test("every worker gets its run's session name and accepts cross-session messages", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.sessionName).toBe("beckett-run-oauth");
    expect(spawnCalls[0]!.settingsExtra).toMatchObject({ crossSessionInbound: "accept" });
  });

  test("the harness session id is persisted onto the run, per stage", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    // `sessionIds` is a Run-contract field: the in-process ledger is cleared on recovery, so this
    // is the only place a sibling reader can learn which session did which stage.
    expect(store.get(run.id)!.sessionIds).toEqual({ implement: "sess-1" });

    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.sessionIds).toEqual({ implement: "sess-1", review: "sess-2" });
  });

  test("max_live caps live runs and queues the rest FIFO", async () => {
    const { supervisor, store } = newSupervisor({ config: cfg({ runs: { max_live: 1, review_cycles_max: 2, budget_usd_per_run: 0 } }) });
    const a = seedRun(store, makeRun({ slug: "a" }));
    const b = seedRun(store, makeRun({ slug: "b" }));
    await supervisor.admit(a.id);
    await tick();
    await supervisor.admit(b.id);
    await tick();
    expect(spawnCalls.map((c) => c.itemId)).toEqual([a.id]);

    // A's own next stage takes the freed slot first — b is still queued behind the cap.
    created[0]!.finish("success", "done", doneSignal(true));
    await settle();
    expect(spawnCalls.map((c) => c.itemId)).toEqual([a.id, a.id]);
    expect(spawnCalls[1]!.stage).toBe("review");

    // Once a is genuinely finished, the queue pumps and b starts.
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();
    expect(store.get(a.id)!.state).toBe("done");
    expect(spawnCalls.map((c) => c.itemId)).toContain(b.id);
  });
});

describe("capability preflight (overhaul B10)", () => {
  test("a blocking capability gap parks the run before any worktree or worker", async () => {
    const { supervisor, store } = newSupervisor({
      capabilityPreflight: async () => ({
        checked: ["github"],
        gaps: [
          {
            kind: "github-not-installed",
            subject: "acme",
            detail: "the GitHub App is not installed on `acme`",
            fix: "https://github.com/apps/beckett/installations/new",
            severity: "blocking",
          },
        ],
      }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await settle();
    const after = store.get(run.id)!;
    expect(after.state).toBe("parked");
    expect(after.error ?? "").toContain("https://github.com/apps/beckett/installations/new");
    expect(spawnCalls).toHaveLength(0);
    expect(ensureCalls).toHaveLength(0);
  });

  test("a run parked on a blocking capability gap is resumable", async () => {
    let calls = 0;
    const { supervisor, store } = newSupervisor({
      capabilityPreflight: async () => {
        calls++;
        return {
          checked: ["github"],
          gaps: [
            {
              kind: "github-not-installed",
              subject: "acme",
              detail: "the GitHub App is not installed on `acme`",
              fix: "https://github.com/apps/beckett/installations/new",
              severity: "blocking",
            },
          ],
        };
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await settle();
    expect(store.get(run.id)!.state).toBe("parked");

    const result = await supervisor.resume(run.id);
    expect(result).toBe("resumed");
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(spawnCalls).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("advisory-only gaps staff the run normally", async () => {
    const { supervisor, store } = newSupervisor({
      capabilityPreflight: async () => ({
        checked: ["keychain"],
        gaps: [
          {
            kind: "keychain-entry-missing",
            subject: "huggingface",
            detail: "the jingle entry `huggingface` is not in the vault yet",
            fix: "add it to jingle",
            severity: "advisory",
          },
        ],
      }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(spawnCalls).toHaveLength(1);
  });

  test("a throwing preflight staffs the run", async () => {
    const { supervisor, store } = newSupervisor({
      capabilityPreflight: async () => {
        throw new Error("network down");
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(spawnCalls).toHaveLength(1);
  });

  test("preflight runs once per run, not per stage", async () => {
    let calls = 0;
    const { supervisor, store } = newSupervisor({
      capabilityPreflight: async () => {
        calls++;
        return { checked: [], gaps: [] };
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await settle();
    expect(calls).toBe(1);
    // Finish implement successfully → the run advances to review, staffing a second stage.
    created[0]!.finish("success", "done", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("reviewing");
    expect(calls).toBe(1);
  });

  test("no capabilityPreflight dep leaves admission byte-identical", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(spawnCalls).toHaveLength(1);
  });
});

describe("the repo a run works in", () => {
  test("`repo: null` is BECKETT ITSELF, never a fresh empty repo named after the run", async () => {
    const { supervisor, store, repos, publishCalls } = newSupervisor({ publish: true });
    const run = seedRun(store, makeRun({ slug: "voice", repo: null }));
    await supervisor.admit(run.id);
    await tick();
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]!.slug).toBe("beckett");
    expect(ensureCalls[0]!.repoRoot).toBe(join(repos, "beckett"));
    // …and under the self-project's own owner, or the clone would miss and `git init` a void.
    expect(ensureCalls[0]!.owner).toBe(resolveSelfProjectOwner());

    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();
    expect(publishCalls[0]!.slug).toBe("beckett");
  });

  test("a named project still resolves to its own repo", async () => {
    const { supervisor, store, repos } = newSupervisor();
    const run = seedRun(store, makeRun({ repo: "gateway" }));
    await supervisor.admit(run.id);
    await tick();
    expect(ensureCalls[0]!.slug).toBe("gateway");
    expect(ensureCalls[0]!.repoRoot).toBe(join(repos, "gateway"));
  });
});

describe("stage flow", () => {
  test("implement done-signal → review → publish → done", async () => {
    const { supervisor, store, publishCalls } = newSupervisor({ publish: true });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();

    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("reviewing");
    expect(spawnCalls[1]!.stage).toBe("review");
    // The reviewer is handed the diff rather than made to rediscover it.
    expect(spawnCalls[1]!.reviewDiff).toContain("diff --git");

    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    const done = store.get(run.id)!;
    expect(done.state).toBe("done");
    expect(done.prUrl).toBe("https://github.com/o/gateway/pull/7");
    expect(publishCalls).toHaveLength(1);
    // The publish is keyed by the RUN id — the whole point of the re-keying.
    expect(publishCalls[0]!.ticket).toBe(run.id);
  });

  // #234: the depth the reviewer's rubric was scaled to is journalled at cast time, so a run card
  // shows WHY a copy fix didn't buy ten minutes of browser rubric.
  test("review depth is journalled at cast time — scaled to the pre-read diff", async () => {
    reviewDiffText = `diff --git a/web/public/index.html b/web/public/index.html
--- a/web/public/index.html
+++ b/web/public/index.html
@@ -12,7 +12,7 @@
-  <a href="https://exmaple.com/docs">Read the docs</a>
+  <a href="https://example.com/docs">Read the docs</a>
`;
    const { supervisor, store, events } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();

    const depth = events.find((e) => e.stage === "review:depth");
    expect(depth?.outcome).toBe("info");
    expect(depth?.message).toBe("review depth: content (1 file, copy/href only)");
    // The depth line lands BEFORE the review worker starts — it explains the brief it was handed.
    const order = events.map((e) => `${e.stage}:${e.outcome}`);
    expect(order.indexOf("review:depth:info")).toBeLessThan(order.indexOf("review:started"));
  });

  test("a source diff journals the code tier instead", async () => {
    const { supervisor, store, events } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    expect(events.find((e) => e.stage === "review:depth")?.message).toBe(
      "review depth: code (1 file, source/config: x.ts)",
    );
    // Implement never classifies — the depth belongs to the review cast.
    expect(events.filter((e) => e.stage === "review:depth")).toHaveLength(1);
  });

  test("an unreadable diff journals no depth line and leaves the review un-scaled", async () => {
    reviewDiffText = "";
    const { supervisor, store, events } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    expect(events.some((e) => e.stage === "review:depth")).toBe(false);
    expect(spawnCalls[1]!.stage).toBe("review");
  });

  test("the done event's message is the shipped PR URL — the deploy receipt's closing line", async () => {
    const { supervisor, store, events } = newSupervisor({ publish: true });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    const doneEvent = events.find((e) => e.stage === "done" && e.outcome === "passed");
    expect(doneEvent?.message).toBe("https://github.com/o/gateway/pull/7");
  });

  test("no publisher wired still finishes the run (local-only completion)", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();
    const done = store.get(run.id)!;
    expect(done.state).toBe("done");
    // B12: local-only is verified-with-a-gap, not permanently unverified.
    expect(done.landingMode).toBe("local");
    expect(done.proof?.verified).toBe(true);
    expect(done.proof?.gaps).toContain("local-only, nothing published");
  });

  test("a failed publish holds the run in publishing behind a durable retry row", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const { supervisor, store } = newSupervisor({
      publishOutboxPath: outbox,
      publish: async () => {
        throw new Error("fetch failed");
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("publishing");
    const rows = readFileSync(outbox, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].item.id).toBe(run.id);
    expect(rows[0].purpose).toBe("done");
  });

  test("the watchdog pass drains the durable publish outbox (retries run without a restart)", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    let failNext = true;
    const { supervisor, store, publishCalls } = newSupervisor({
      publishOutboxPath: outbox,
      publish: async () => {
        if (failNext) throw new Error("fetch failed");
        return { url: "https://github.com/o/gateway", kind: "pr" as const, prUrl: "https://github.com/o/gateway/pull/7" };
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("publishing");
    expect(publishCalls).toHaveLength(1);

    // GitHub recovers, and the row comes due. No daemon restart happens — the running supervisor's
    // own watchdog tick is the only thing that can move this run, which is the whole point.
    failNext = false;
    const rows = readFileSync(outbox, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    writeFileSync(outbox, `${JSON.stringify({ ...rows[0], nextAttemptAt: 1 })}\n`);
    await supervisor.reconcileStaffing(10_000_000);
    await settle();
    expect(store.get(run.id)!.state).toBe("done");
    expect(store.get(run.id)!.prUrl).toBe("https://github.com/o/gateway/pull/7");
    expect(publishCalls).toHaveLength(2);
    expect(readFileSync(outbox, "utf8").trim()).toBe("");
  });

  test("a daemon that died mid-publish re-attempts on boot instead of wedging forever", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const storePath = join(dir, "runs.json");
    const seed = new RunStore(storePath);
    // Exactly the crash window: state moved to `publishing`, the attempt was in flight, and no
    // outbox row was ever written because the attempt never returned a failure.
    const run = seedRun(seed, makeRun({ state: "publishing" }));
    await seed.update(run.id, { workspace: join(dir, "wt") });
    const { supervisor, store, publishCalls } = newSupervisor({
      publish: true,
      publishOutboxPath: outbox,
      store: new RunStore(storePath),
    });
    await supervisor.start();
    await settle();
    supervisor.stop();
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.ticket).toBe(run.id);
    expect(store.get(run.id)!.state).toBe("done");
    // The re-attempt invents no commit message: the reviewer's summary did not survive the crash.
    expect(publishCalls[0]!.commitMessage).toBeUndefined();
    // And no worker is staffed for a publishing run — recovery is the publish path, not a respawn.
    expect(spawnCalls).toHaveLength(0);
  });

  test("boot leaves a publishing run that already owns an outbox row to the normal drain", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const storePath = join(dir, "runs.json");
    const seed = new RunStore(storePath);
    const run = seedRun(seed, makeRun({ state: "publishing" }));
    // A row scheduled well into the future: boot must not spend its retry early.
    writeFileSync(
      outbox,
      `${JSON.stringify({
        id: "op-1",
        item: { id: run.id, identifier: run.id },
        slug: "gateway",
        repoRoot: join(dir, "wt"),
        messagePrefix: "Review passed → **done**.",
        summary: "pass",
        purpose: "done",
        attempt: 1,
        nextAttemptAt: Date.now() + 60_000,
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const { supervisor, store, publishCalls } = newSupervisor({
      publish: true,
      publishOutboxPath: outbox,
      store: new RunStore(storePath),
    });
    await supervisor.start();
    await settle();
    supervisor.stop();
    expect(publishCalls).toHaveLength(0);
    expect(store.get(run.id)!.state).toBe("publishing");
  });

  test("an implement worker that reports a blocker parks the run with its WIP committed", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish(
      "success",
      "stuck on auth",
      doneSignal(false, "stuck on auth", {
        class: "credential",
        detail: "needs a GitHub token with repo scope",
        remedy: "provide a credential",
        defaultAnswer: null,
      }),
    );
    await settle();
    expect(store.get(run.id)!.state).toBe("parked");
    expect(store.get(run.id)!.error).toContain("needs a GitHub token with repo scope");
    // The worker's summary of what it did before blocking rides along too — behaviour-preserving
    // vs. the old free-text `park(run, "${detail}\n\n${summary}")`.
    expect(store.get(run.id)!.error).toContain("stuck on auth");
    expect(commitCalls.some((c) => c.message.includes("WIP"))).toBe(true);
  });
});

// B9: two runs that would fight over the same files queue instead of racing. Opt-in by
// declaration — every test in `describe("admission")`/`describe("stage flow")` above deploys no
// `deps`/`files` and needed no change for this feature to land, which is the acceptance gate.
describe("dependency edges (overhaul B9)", () => {
  test("a run whose files overlap an in-flight sibling stays queued without persisting an auto dep", async () => {
    const { supervisor, store } = newSupervisor();
    const sib = seedRun(store, makeRun({ id: "run-sib", slug: "sib", files: ["src/run/"] }));
    const dep = seedRun(store, makeRun({ id: "run-dep", slug: "dep", files: ["src/run/supervisor.ts"] }));
    await supervisor.admit(sib.id);
    await tick();
    expect(spawnCalls.map((c) => c.itemId)).toEqual([sib.id]);

    await supervisor.admit(dep.id);
    await tick();
    expect(spawnCalls.map((c) => c.itemId)).toEqual([sib.id]);
    expect(store.get(dep.id)!.state).toBe("queued");
    // Finding 22: the auto edge is recomputed from `run.files` on every admit and is never
    // persisted into `run.deps` — the trace ("held: waits on …") is the durable explanation.
    expect(store.get(dep.id)!.deps).toEqual([]);
  });

  test("it starts by itself the moment the sibling reaches done", async () => {
    const { supervisor, store } = newSupervisor({ publish: true });
    const sib = seedRun(store, makeRun({ id: "run-sib", slug: "sib", files: ["src/run/"] }));
    const dep = seedRun(store, makeRun({ id: "run-dep", slug: "dep", files: ["src/run/supervisor.ts"] }));
    await supervisor.admit(sib.id);
    await tick();
    await supervisor.admit(dep.id);
    await tick();
    expect(spawnCalls).toHaveLength(1);

    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    expect(store.get(sib.id)!.state).toBe("done");
    expect(spawnCalls.map((c) => c.itemId)).toContain(dep.id);
    expect(store.get(dep.id)!.state).not.toBe("queued");
  });

  test("a run auto-blocked by an overlapping sibling still composes that sibling's branch once it's done", async () => {
    // The auto edge is never persisted into `run.deps` (finding 22), but `prepareWorktree` must
    // still see it — otherwise a dependent admitted right after its overlap sibling finishes
    // would cut its worktree from stale `origin/main` instead of the sibling's committed edits
    // to the exact files they share.
    const { supervisor, store } = newSupervisor({ publish: true });
    const sib = seedRun(store, makeRun({ id: "run-sib", slug: "sib", files: ["src/run/"] }));
    const dep = seedRun(store, makeRun({ id: "run-dep", slug: "dep", files: ["src/run/supervisor.ts"] }));
    await supervisor.admit(sib.id);
    await tick();
    await supervisor.admit(dep.id);
    await tick();
    expect(store.get(dep.id)!.deps).toEqual([]); // no persisted edge

    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    expect(store.get(sib.id)!.state).toBe("done");
    const depWorktreeCall = createWorktreeCalls.find((c) => c.branch === store.get(dep.id)!.branch);
    expect(depWorktreeCall?.baseRef).toBe(store.get(sib.id)!.branch);
    expect(mergeCalls).toHaveLength(0);
  });

  test("a dependent run's worktree is cut from its dep's branch, not origin/main", async () => {
    const { supervisor, store } = newSupervisor();
    const dep = seedRun(store, makeRun({ id: "run-dep", slug: "dep", state: "done" }));
    const run = seedRun(store, makeRun({ id: "run-x", slug: "x", deps: [dep.id] }));
    await supervisor.admit(run.id);
    await tick();
    expect(createWorktreeCalls[0]?.baseRef).toBe("beckett/run-dep");
    expect(mergeCalls).toHaveLength(0);
  });

  test("two deps: the second is merged in with mergeBranchesIntoWorktree", async () => {
    const { supervisor, store } = newSupervisor();
    const depA = seedRun(store, makeRun({ id: "run-a", slug: "a", state: "done" }));
    const depB = seedRun(store, makeRun({ id: "run-b", slug: "b", state: "done" }));
    const run = seedRun(store, makeRun({ id: "run-x", slug: "x", deps: [depA.id, depB.id] }));
    await supervisor.admit(run.id);
    await tick();
    expect(createWorktreeCalls[0]?.baseRef).toBe(depB.branch);
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]?.branches).toEqual([depA.branch]);
  });

  test("a conflicting compose parks with a product-decision blocker naming the files", async () => {
    mergeThrows = new Error("cannot compose dependency branch beckett/run-b; conflicts: src/run/supervisor.ts");
    const { supervisor, store } = newSupervisor();
    const depA = seedRun(store, makeRun({ id: "run-a", slug: "a", state: "done" }));
    const depB = seedRun(store, makeRun({ id: "run-b", slug: "b", state: "done" }));
    const run = seedRun(store, makeRun({ id: "run-x", slug: "x", deps: [depA.id, depB.id] }));
    await supervisor.admit(run.id);
    await settle();
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.blocker?.class).toBe("product-decision");
    expect(parked.blocker?.remedy).toContain("src/run/supervisor.ts");
  });

  test("runs with no declared files are unaffected", async () => {
    const { supervisor, store } = newSupervisor();
    const a = seedRun(store, makeRun({ id: "run-a", slug: "a" }));
    const b = seedRun(store, makeRun({ id: "run-b", slug: "b" }));
    await supervisor.admit(a.id);
    await supervisor.admit(b.id);
    await tick();
    expect(spawnCalls.map((c) => c.itemId).sort()).toEqual([a.id, b.id].sort());
    expect(store.get(a.id)!.deps).toEqual([]);
    expect(store.get(b.id)!.deps).toEqual([]);
  });
});

// B12: `done` is a VERDICT `assembleProof` (`./proof.ts`) hands out, not a label `publishRun`
// grants itself the instant `git push`/`gh pr create` returns.
describe("proof gates done (overhaul B12)", () => {
  test("a published run with a green PR reaches done and records landingMode pr", async () => {
    const { supervisor, store } = newSupervisor({
      publish: true,
      verifyPr: async () => ({ resolves: true, ci: "success" }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    const done = store.get(run.id)!;
    expect(done.state).toBe("done");
    expect(done.landingMode).toBe("pr");
    expect(done.prUrl).toBe("https://github.com/o/gateway/pull/7");
    expect(done.proof?.verified).toBe(true);
    expect(done.proof?.prResolves).toBe(true);
    expect(done.proof?.ci).toBe("success");
    expect(done.proof?.gaps).toEqual([]);
  });

  test("a direct push records landingMode direct-push and leaves prUrl null (the bare-repo-URL bug)", async () => {
    const { supervisor, store } = newSupervisor({
      publish: async () => ({ url: "https://github.com/o/gateway", kind: "pushed" as const }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    const done = store.get(run.id)!;
    expect(done.state).toBe("done");
    expect(done.landingMode).toBe("direct-push");
    // The whole point of #228's fix: a push URL never lands in `prUrl` again.
    expect(done.prUrl).toBeNull();
    expect(done.proof?.pushUrl).toBe("https://github.com/o/gateway");
    expect(done.proof?.verified).toBe(true);
  });

  test("a red CI leaves the run unverified with the gap on the run", async () => {
    const { supervisor, store } = newSupervisor({
      publish: true,
      verifyPr: async () => ({ resolves: true, ci: "failed" }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    const unverified = store.get(run.id)!;
    expect(unverified.state).toBe("unverified");
    expect(unverified.landingMode).toBe("pr");
    expect(unverified.error).toContain("CI is failed");
    expect(unverified.proof?.verified).toBe(false);
    expect(unverified.proof?.gaps).toContain("CI is failed, not green");
  });

  test("the watchdog re-checks an unverified run and promotes it to done when CI goes green", async () => {
    let ci: "pending" | "success" = "pending";
    const { supervisor, store } = newSupervisor({
      publish: true,
      verifyPr: async () => ({ resolves: true, ci }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("unverified");
    expect(store.get(run.id)!.proof?.ci).toBe("pending");

    ci = "success";
    await supervisor.reconcileProofs();
    const done = store.get(run.id)!;
    expect(done.state).toBe("done");
    expect(done.proof?.ci).toBe("success");
    expect(done.proof?.attempts).toBe(1);
  });

  test("an unverified run that exhausts proof_recheck_max parks with a transient blocker", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, proof_recheck_max: 2 } }),
      publish: true,
      verifyPr: async () => ({ resolves: true, ci: "failed" }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("unverified");

    await supervisor.reconcileProofs(); // attempt 1 of 2 — still unverified
    expect(store.get(run.id)!.state).toBe("unverified");

    await supervisor.reconcileProofs(); // attempt 2 of 2 — cap reached
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.blocker?.class).toBe("transient");
    expect(parked.blocker?.actor).toBe("human");
    expect(parked.error).toContain("2 re-check");
    // A run the daemon itself published via the outbox is not eligible for `courier` (it would
    // erase the real PR URL/landing mode) — its remedy is `resume` after the PR is fixed.
    expect(parked.error).toContain(`beckett task resume ${run.id}`);
    expect(parked.error).not.toContain("beckett task courier");
  });

  test("a `pending` CI verdict never burns the recheck-cap budget — waiting resolves it, not a park", async () => {
    let ci: "pending" | "success" = "pending";
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, proof_recheck_max: 20 } }),
      publish: true,
      verifyPr: async () => ({ resolves: true, ci }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("unverified");

    // 25 re-check passes with CI still pending — well past `proof_recheck_max` (20) — must never
    // park: the cap is reserved for verdicts that will not change by waiting.
    for (let i = 0; i < 25; i++) {
      await supervisor.reconcileProofs();
    }
    const stillPending = store.get(run.id)!;
    expect(stillPending.state).toBe("unverified");
    expect(stillPending.proof?.attempts).toBe(0);
    expect(stillPending.error).toContain("CI is still running");

    ci = "success";
    await supervisor.reconcileProofs();
    const done = store.get(run.id)!;
    expect(done.state).toBe("done");
    expect(done.proof?.ci).toBe("success");
  });

  test("a production-shaped kind:pushed outcome with a /pull/ prUrl still lands as landingMode pr (not direct-push)", async () => {
    // `GitHubCli.ensurePublished` returns `kind: \"pushed\"` for EVERY owned-repo publish — the
    // real PR shape only ever differs by whether `prUrl` matches `/pull/<n>/`. Landing must be
    // classified off the URL, not `outcome.kind`.
    const { supervisor, store } = newSupervisor({
      publish: async () => ({
        url: "https://github.com/o/gateway",
        kind: "pushed" as const,
        prUrl: "https://github.com/o/gateway/pull/7",
      }),
      verifyPr: async () => ({ resolves: true, ci: "success" }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal(true));
    await settle();
    const done = store.get(run.id)!;
    expect(done.landingMode).toBe("pr");
    expect(done.prUrl).toBe("https://github.com/o/gateway/pull/7");
    expect(done.proof?.prResolves).toBe(true);
    expect(done.state).toBe("done");
  });

  test("uiWork is never asserted with frontendProof unwired — a .tsx diff still reaches done", async () => {
    const before = reviewDiffText;
    reviewDiffText = "diff --git a/web/App.tsx b/web/App.tsx\n+added";
    try {
      const { supervisor, store } = newSupervisor({ publish: true }); // no frontendProof wired
      const run = seedRun(store, makeRun());
      await supervisor.admit(run.id);
      await tick();
      created[0]!.finish("success", "implemented", doneSignal(true));
      await settle();
      created[1]!.finish("success", "looks good", doneSignal(true));
      await settle();
      const done = store.get(run.id)!;
      expect(done.state).toBe("done");
      expect(done.proof?.uiWork).toBe(false);
      expect(done.proof?.screenshotPath).toBeNull();
    } finally {
      reviewDiffText = before;
    }
  });

  test("a durable outbox retry that finally succeeds still goes through the proof gate", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    let attempt = 0;
    const { supervisor, store } = newSupervisor({
      publishOutboxPath: outbox,
      publish: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("gh pr create failed (1): transient network blip");
        return { url: "https://github.com/o/gateway", kind: "pushed" as const, prUrl: "https://github.com/o/gateway" };
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("publishing");

    const row = JSON.parse(readFileSync(outbox, "utf8").trim());
    writeFileSync(outbox, `${JSON.stringify({ ...row, nextAttemptAt: 1 })}\n`);
    await supervisor.replayPublishes();
    const landed = store.get(run.id)!;
    // A retry success is a direct push here (no /pull/ in the URL) — it must go through the SAME
    // proof gate a first-attempt success does: `landingMode: direct-push`, and the bare repo URL
    // lands in `proof.pushUrl`, NEVER in `prUrl` — exactly the bug a bypassed proof gate on the
    // retry path would reintroduce (`pub.prUrl ?? pub.url` stamped straight into `prUrl`).
    expect(landed.state).toBe("done");
    expect(landed.landingMode).toBe("direct-push");
    expect(landed.prUrl).toBeNull();
    expect(landed.proof?.pushUrl).toBe("https://github.com/o/gateway");
  });

  test("courier backfill re-checks the proof immediately and promotes an unverified courier run to done", async () => {
    const { supervisor, store } = newSupervisor({
      verifyPr: async () => ({ resolves: true, ci: "success" }),
    });
    const run = seedRun(store, makeRun({ state: "publishing" }));
    const couriered = await supervisor.courier(run.id);
    expect(couriered).toBe("done"); // courier()'s return value is a legacy label, not the run state
    expect(store.get(run.id)!.state).toBe("unverified");

    const backfilled = await supervisor.backfillCourierPrUrl(run.id, "https://github.com/o/gateway/pull/9");
    expect(backfilled?.state).toBe("done");
    expect(store.get(run.id)!.state).toBe("done");
    expect(store.get(run.id)!.proof?.verified).toBe(true);
  });
});

// #227: the outbox used to park after exactly ONE attempt (an unrecognized error defaulted to
// "permanent"), logged no reason, and said "retry" on a row that was never going to be retried.
describe("publish outbox backoff ladder (#227)", () => {
  test("attempts 1..4 walk the 30s/2m/10m ladder honestly, then park — never immediately", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const { supervisor, store, events } = newSupervisor({
      publishOutboxPath: outbox,
      // A message the OLD classifier's transient regex would not have matched — the #227
      // regression case: this must retry, not park on attempt 1.
      publish: async () => {
        throw new Error("gh pr create failed (1): some future gh error text nobody wrote a regex for");
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();

    const readRow = () => JSON.parse(readFileSync(outbox, "utf8").trim());
    let row = readRow();
    expect(row.attempt).toBe(1);
    expect(row.nextAttemptAt).toBeLessThan(Number.MAX_SAFE_INTEGER); // retried, not parked
    expect(store.get(run.id)!.state).toBe("publishing");

    // Attempt 2: force the row due, drain, and check the ladder's 2nd rung (~2m).
    const beforeAttempt2 = Date.now();
    writeFileSync(outbox, `${JSON.stringify({ ...row, nextAttemptAt: 1 })}\n`);
    await supervisor.reconcileStaffing();
    await settle();
    row = readRow();
    expect(row.attempt).toBe(2);
    expect(row.nextAttemptAt - beforeAttempt2).toBeGreaterThan(110_000);
    expect(row.nextAttemptAt - beforeAttempt2).toBeLessThan(130_000);

    // Attempt 3: the ladder's 3rd rung (~10m).
    const beforeAttempt3 = Date.now();
    writeFileSync(outbox, `${JSON.stringify({ ...row, nextAttemptAt: 1 })}\n`);
    await supervisor.reconcileStaffing();
    await settle();
    row = readRow();
    expect(row.attempt).toBe(3);
    expect(row.nextAttemptAt - beforeAttempt3).toBeGreaterThan(590_000);
    expect(row.nextAttemptAt - beforeAttempt3).toBeLessThan(610_000);

    // Attempt 4: the ladder is EXHAUSTED — park, do not invent a 4th delay.
    writeFileSync(outbox, `${JSON.stringify({ ...row, nextAttemptAt: 1 })}\n`);
    await supervisor.reconcileStaffing();
    await settle();
    row = readRow();
    expect(row.attempt).toBe(4);
    expect(row.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
    // …and the RUN parks with it. A row scheduled at MAX_SAFE_INTEGER is never going to run again,
    // so leaving the run `publishing` claimed work was in progress when nothing was — the
    // 2026-08-14 wedge. `parked` is the held-for-a-human state (still on the board, still
    // courier-able), and it carries the reason instead of `error: null`.
    const done = store.get(run.id)!;
    expect(done.state).toBe("parked");
    expect(done.error).toContain("parked for a human");
    expect(done.error).toContain("some future gh error text nobody wrote a regex for");
    expect(done.error).toContain(`beckett task courier ${run.id}`);

    // Every attempt after the first logged VERBATIM with honest wording — retry while there was a
    // rung left, "parked for human courier" (never "retry") on the last one.
    const retryEvents = events.filter((e) => e.stage === "publish-retry");
    expect(retryEvents).toHaveLength(3);
    expect(retryEvents[0]!.message).toBe("publish attempt 2 failed — retrying in 2m");
    expect(retryEvents[1]!.message).toBe("publish attempt 3 failed — retrying in 10m");
    expect(retryEvents[2]!.message).toBe("parked for human courier");
    for (const e of retryEvents) {
      expect(e.error).toBe("gh pr create failed (1): some future gh error text nobody wrote a regex for");
    }
  });

  test("a permanent-class error (403) parks for a human courier on attempt 1, honestly logged", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const { supervisor, store, events } = newSupervisor({
      publishOutboxPath: outbox,
      publish: async () => {
        throw new Error("HTTP 403 forbidden");
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();

    const row = JSON.parse(readFileSync(outbox, "utf8").trim());
    expect(row.attempt).toBe(1);
    expect(row.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
    // A permanent failure parks on attempt 1 — and the run says so, with the fix for THIS class of
    // error (a credential that cannot write), not a bare `error: null`.
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("HTTP 403 forbidden");
    expect(parked.error).toContain("beckett gh preflight");

    const held = events.find((e) => e.stage === "publish" && e.outcome === "held");
    expect(held?.message).toBe("parked for human courier");
    expect(held?.error).toBe("HTTP 403 forbidden");
  });
});

/**
 * 2026-08-14 (`babble`): a finished run — 43/43 checklist items, reviewer PASS, 115/115 tests —
 * sat in `publishing` with `live:false`, `prUrl:null` and `error:null` for over half an hour and
 * published nothing. Nothing was going to move it and nothing said so. `publishing` is invisible to
 * the staffing watchdog by design (`stageFor()` returns null for it), so it needs its own guard.
 */
describe("publishing never stalls silently", () => {
  test("a failed attempt writes the reason onto the RUN, not only into the durable row", async () => {
    const dir = scratch();
    const { supervisor, store } = newSupervisor({
      publishOutboxPath: join(dir, "run-publish-outbox.jsonl"),
      publish: async () => {
        throw new Error("git push failed (128): fatal: 'origin' does not appear to be a git repository");
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();

    const held = store.get(run.id)!;
    expect(held.state).toBe("publishing"); // a scheduled retry IS progress — still honest
    expect(held.error).toContain("publishing failed on attempt 1 of 4");
    expect(held.error).toContain("does not appear to be a git repository");
    // The actionable half: the missing thing, and the command that supplies it.
    expect(held.error).toContain("git remote add origin");
  });

  test("a run wedged in `publishing` with nothing scheduled is parked with a specific error", async () => {
    const dir = scratch();
    const { supervisor, store } = newSupervisor({
      publishOutboxPath: join(dir, "run-publish-outbox.jsonl"),
    });
    // The exact shape: `publishing`, no outbox row, no error, nothing in flight.
    const run = seedRun(store, makeRun({ state: "publishing", updatedAt: "2026-08-10T00:00:00.000Z" }));
    await supervisor.admit(run.id);

    const at = Date.parse("2026-08-10T00:00:00.000Z");
    // Inside the budget: still publishing, still untouched — the guard must not be trigger-happy.
    expect(await supervisor.reconcilePublishing(at + PUBLISH_STALL_MS - 1)).toEqual([]);
    expect(store.get(run.id)!.state).toBe("publishing");

    expect(await supervisor.reconcilePublishing(at + PUBLISH_STALL_MS + 60_000)).toEqual([run.id]);
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("the publish step never completed");
    expect(parked.error).toContain("the attempt never returned at all");
    expect(parked.error).toContain(`beckett task courier ${run.id}`);
    expect(parked.error).toContain(run.branch);
  });

  test("a row parked at MAX_SAFE_INTEGER by older code is repaired, not left holding the run", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const storePath = join(dir, "runs.json");
    const seed = new RunStore(storePath);
    const run = seedRun(seed, makeRun({ state: "publishing", updatedAt: "2026-08-10T00:00:00.000Z" }));
    writeFileSync(
      outbox,
      `${JSON.stringify({
        id: "op-legacy",
        item: { id: run.id, identifier: run.id },
        slug: "gateway",
        repoRoot: join(dir, "wt"),
        messagePrefix: "Review passed → **done**.",
        summary: "pass",
        purpose: "done",
        attempt: 4,
        nextAttemptAt: Number.MAX_SAFE_INTEGER, // gave up; will never come due again
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const { supervisor, store } = newSupervisor({
      publishOutboxPath: outbox,
      store: new RunStore(storePath),
    });

    const parkedIds = await supervisor.reconcilePublishing(Date.parse("2026-08-10T01:00:00.000Z"));

    expect(parkedIds).toEqual([run.id]);
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("gave up after attempt 4");
  });

  test("a row with a real next attempt is left alone — a scheduled retry is progress", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const storePath = join(dir, "runs.json");
    const seed = new RunStore(storePath);
    const run = seedRun(seed, makeRun({ state: "publishing", updatedAt: "2026-08-10T00:00:00.000Z" }));
    writeFileSync(
      outbox,
      `${JSON.stringify({
        id: "op-live",
        item: { id: run.id, identifier: run.id },
        slug: "gateway",
        repoRoot: join(dir, "wt"),
        messagePrefix: "Review passed → **done**.",
        summary: "pass",
        purpose: "done",
        attempt: 2,
        nextAttemptAt: Date.parse("2026-08-10T02:00:00.000Z"),
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const { supervisor, store } = newSupervisor({ publishOutboxPath: outbox, store: new RunStore(storePath) });

    expect(await supervisor.reconcilePublishing(Date.parse("2026-08-11T00:00:00.000Z"))).toEqual([]);
    expect(store.get(run.id)!.state).toBe("publishing");
  });

  test("the guard rides the watchdog pass, so a live daemon needs no restart to notice", async () => {
    const dir = scratch();
    const storePath = join(dir, "runs.json");
    const seed = new RunStore(storePath);
    const run = seedRun(seed, makeRun({ state: "publishing", updatedAt: "2026-08-10T00:00:00.000Z" }));
    const { supervisor, store } = newSupervisor({
      publishOutboxPath: join(dir, "run-publish-outbox.jsonl"),
      store: new RunStore(storePath),
    });

    const pass = await supervisor.reconcileStaffing(Date.parse("2026-08-10T00:00:00.000Z") + PUBLISH_STALL_MS + 1);

    expect(pass.parked).toContain(run.id);
    expect(store.get(run.id)!.state).toBe("parked");
  });

  // BUG 1, sharpened by the 2026-08-14 `babble` stall: a durable row can give up after just ONE
  // attempt (a non-retryable/permanent failure), not only after exhausting the four-rung ladder.
  // Whichever marks the row terminal MUST drive the run out of `publishing` immediately — a give-up
  // is never a state to sit in for hours waiting on a sweeper.
  test("a non-retryable failure gives up on attempt 1 and leaves `publishing` at once (BUG 1)", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const { supervisor, store, publishCalls } = newSupervisor({
      publishOutboxPath: outbox,
      // The exact 2026-08-14 mechanism: a dirty-tree rebase failure — deterministic, no retry can
      // clear it.
      publish: async () => {
        throw new Error(
          "publish: local work conflicts with kowo-co/babble@main and can't auto-rebase — needs a human " +
            "(error: cannot rebase: You have unstaged changes.)",
        );
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();

    // Exactly ONE publish attempt was made, and the run is already OUT of publishing — no sweeper,
    // no ladder, no hours of silence.
    expect(publishCalls).toHaveLength(1);
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("unrecoverable without a human");
    expect(parked.error).toContain("You have unstaged changes");
    const row = JSON.parse(readFileSync(outbox, "utf8").trim());
    expect(row.attempt).toBe(1);
    expect(row.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER); // gave up — never scheduled again
  });

  // The other half of BUG 1: exhausting all four attempts must ALSO leave `publishing` the moment
  // the last attempt fails — proven without advancing any clock past the final failure.
  test("exhausting the retry ladder leaves `publishing` on the final attempt, not hours later", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const { supervisor, store } = newSupervisor({
      publishOutboxPath: outbox,
      publish: async () => {
        throw new Error("fetch failed"); // transient — walks the ladder
      },
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "pass", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("publishing"); // attempt 1 retried — still honest

    // Force each successive attempt due and drain. The run must be parked the instant attempt 4
    // fails, in the SAME pass — never left publishing for a later sweeper.
    for (let attempt = 2; attempt <= 4; attempt++) {
      const row = JSON.parse(readFileSync(outbox, "utf8").trim());
      writeFileSync(outbox, `${JSON.stringify({ ...row, nextAttemptAt: 1 })}\n`);
      await supervisor.replayPublishes();
      await settle();
    }
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("no attempts left after 4 of 4");
  });

  // BUG 2: the parked hand-off advice is computed from the branch's REAL state vs origin/main, and
  // gives the SAFE command for each of the three shapes — never the blanket "just push it" that
  // would have duplicated or reverted shipped work five-for-five on 2026-08-14.
  async function parkWithBranchState(state: BranchVsMainRaw): Promise<Run> {
    const dir = scratch();
    const original = gitFakes.readBranchVsMain;
    gitFakes.readBranchVsMain = async () => state;
    try {
      const { supervisor, store } = newSupervisor({
        publishOutboxPath: join(dir, "run-publish-outbox.jsonl"),
        // A permanent failure so it parks on attempt 1 — the branch check drives the advice.
        publish: async () => {
          throw new Error("HTTP 403 forbidden");
        },
      });
      const run = seedRun(store, makeRun());
      await supervisor.admit(run.id);
      await tick();
      created[0]!.finish("success", "implemented", doneSignal(true));
      await settle();
      created[1]!.finish("success", "pass", doneSignal(true));
      await settle();
      return store.get(run.id)!;
    } finally {
      gitFakes.readBranchVsMain = original;
    }
  }

  test("(a) a genuinely-ahead branch parks with the push advice — the current advice IS correct", async () => {
    const parked = await parkWithBranchState({ compared: true, ahead: 2, behind: 0, aheadUnlanded: 2 });
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("beckett gh push --repo <owner/name>");
    expect(parked.error).toContain(`beckett task courier ${parked.id}`);
  });

  test("(b) an already-landed branch parks advising a courier-with-PR, NEVER a push", async () => {
    const parked = await parkWithBranchState({
      compared: true,
      ahead: 1,
      behind: 4,
      aheadUnlanded: 0,
      landedCommit: "2035e51deadbeef",
      landedSubject: "babble: post training cycles",
    });
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("ALREADY on origin/main");
    expect(parked.error).toContain("babble: post training cycles");
    expect(parked.error).toContain(`beckett task courier ${parked.id} --pr-url`);
    expect(parked.error).not.toContain("gh push"); // pushing would duplicate the landed PR
  });

  test("(c) a superseded (behind) branch parks warning a push would REVERT, advising courier-closed", async () => {
    const parked = await parkWithBranchState({ compared: true, ahead: 0, behind: 3, aheadUnlanded: 0 });
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("3 commit(s) BEHIND origin/main");
    expect(parked.error).toContain("REVERT");
    expect(parked.error).toContain(`beckett task courier ${parked.id}`);
    expect(parked.error).not.toContain("gh push"); // pushing would revert shipped work
  });
});

describe("rework bounds", () => {
  test("review fail reworks with the reviewer's notes, then parks at the cap", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0 } }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();

    // Cycle 1: back to implement, carrying the review notes as steering.
    created[1]!.finish("success", "missing error handling", doneSignal(false, "missing error handling"));
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(store.get(run.id)!.reviewCycles).toBe(1);
    const rework = spawnCalls.find((c, i) => i > 1 && c.stage === "implement")!;
    expect(rework.steering?.join("\n")).toContain("missing error handling");

    // Second implement → second review → cycle 2 hits the cap and parks.
    created[2]!.finish("success", "fixed", doneSignal(true));
    await settle();
    created[3]!.finish("success", "still wrong", doneSignal(false, "still wrong"));
    await settle();
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.reviewCycles).toBe(2);
    expect(parked.error).toContain("rework cycle 2/2");
  });

  test("review notes survive a failed rework spawn instead of vanishing with it", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();

    // The rework spawn dies (harness hiccup). Its steering was already consumed and persisted-as-
    // removed, so without a give-back the re-staffed worker would run with no idea what to fix.
    spawnThrows = new Error("harness binary missing");
    created[1]!.finish("success", "missing error handling", doneSignal(false, "missing error handling"));
    await settle();
    expect(spawnCalls[2]!.stage).toBe("implement");
    expect(spawnCalls[2]!.steering?.join("\n")).toContain("missing error handling");
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(store.get(run.id)!.error).toContain("harness binary missing");

    spawnThrows = null;
    await supervisor.admit(run.id);
    await settle();
    const restaffed = spawnCalls[spawnCalls.length - 1]!;
    expect(restaffed.stage).toBe("implement");
    expect(restaffed.steering?.join("\n")).toContain("missing error handling");
  });

  test("a reviewer with no schema-valid verdict parks rather than guessing", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "reviewing" }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.stage).toBe("review");
    created[0]!.finish("success", "I think it's fine?", { nonsense: true });
    await settle();
    expect(store.get(run.id)!.state).toBe("parked");
    expect(store.get(run.id)!.error).toContain("schema-valid");
  });
});

describe("continuation loop (overhaul B6)", () => {
  test("done:false with no blocker re-spawns implement with the worker's summary as steering", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "ran out of turn, half done", doneSignal(false, "ran out of turn, half done"));
    await settle();
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
    expect(spawnCalls[1]!.steering?.join("\n")).toContain("ran out of turn, half done");
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(commitCalls.some((c) => c.message.includes("WIP"))).toBe(true);
  });

  test("continuation stops at runs.continuation_max and parks with the cap named", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, continuation_max: 2, budget_usd_per_run: 0 } }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "pass 1, not done", doneSignal(false, "pass 1, not done"));
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    created[1]!.finish("success", "pass 2, still not done", doneSignal(false, "pass 2, still not done"));
    await settle();
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("2/2");
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
  });

  test("a continuation pass does not consume a review cycle", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "ran out of turn", doneSignal(false, "ran out of turn"));
    await settle();
    expect(store.get(run.id)!.reviewCycles).toBe(0);
    expect(store.get(run.id)!.continuations).toBe(1);
  });

  test("a done:true signal still goes straight to review", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    expect(store.get(run.id)!.state).toBe("reviewing");
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  test("a done:false signal with a `continuation` blocker re-spawns implement instead of parking", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish(
      "success",
      "need another pass",
      doneSignal(false, "need another pass", {
        class: "continuation",
        detail: "ran out of turn",
        remedy: "",
        defaultAnswer: null,
      }),
    );
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(store.get(run.id)!.continuations).toBe(1);
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
    // Never reaches the generic hold() for a supervisor-actor class.
    expect(store.get(run.id)!.blocker).toBeNull();
  });
});

describe("typed blockers (overhaul B5)", () => {
  test("every park records a typed blocker with actor human", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", "harness crashed");
    await settle();
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.blocker?.actor).toBe("human");
    expect(parked.blocker?.class).toBe("transient");
    expect(parked.error).toContain(parked.blocker!.remedy);
  });

  test("resume clears the blocker and re-staffs the stage that was parked", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", "harness crashed");
    await settle();
    expect(store.get(run.id)!.state).toBe("parked");

    const outcome = await supervisor.resume(run.id);
    await settle();
    expect(outcome).toBe("resumed");
    const resumed = store.get(run.id)!;
    expect(resumed.blocker).toBeNull();
    expect(resumed.state).toBe("implementing");
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
  });

  test("resume on a done run is not-parked and spawns nothing", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "done" }));
    const before = spawnCalls.length;
    const outcome = await supervisor.resume(run.id);
    expect(outcome).toBe("not-parked");
    expect(spawnCalls.length).toBe(before);
  });

  test("resume with a note delivers it as steering to the new worker", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", "harness crashed");
    await settle();

    const outcome = await supervisor.resume(run.id, { note: "use the backup credential" });
    await settle();
    expect(outcome).toBe("resumed");
    const rework = spawnCalls[spawnCalls.length - 1]!;
    expect(rework.stage).toBe("implement");
    expect(rework.steering?.join("\n")).toContain("use the backup credential");
  });

  test("a run parked from review resumes into review, not implement", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(
      store,
      makeRun({
        state: "parked",
        sessionIds: { implement: "sess-impl", review: "sess-review" },
        error: "the reviewer died",
        blocker: {
          class: "transient",
          actor: "human",
          reversible: true,
          remedy: "`beckett task resume …`",
          detail: "the reviewer died",
          defaultAnswer: null,
          stage: "review",
          at: "2026-08-10T00:00:00.000Z",
        },
      }),
    );
    const outcome = await supervisor.resume(run.id);
    await settle();
    expect(outcome).toBe("resumed");
    const resumed = store.get(run.id)!;
    expect(resumed.state).toBe("reviewing");
    expect(spawnCalls[spawnCalls.length - 1]!.stage).toBe("review");
  });

  test("a run parked mid-rework-implement resumes into implement, not review", async () => {
    // Regression for the bug the old `lastStageOf`-only derivation had: `sessionIds`'s key ORDER
    // is insertion order, and re-assigning an existing key (the second `implement` spawn below)
    // keeps its original position — so after implement → review → rework-implement, the keys are
    // still `["implement", "review"]` and a naive "last key" read would say "review" even though
    // the run was held mid-implement. `hold()` now stamps the stage itself, so this must resume
    // into "implement".
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0 } }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[1]!.finish("success", "missing error handling", doneSignal(false, "missing error handling"));
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");

    // The rework implement worker dies before it can finish.
    created[2]!.finish("error", "harness crashed");
    await settle();
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.blocker?.stage).toBe("implement");
    expect(Object.keys(parked.sessionIds)).toEqual(["implement", "review"]); // the key-order trap

    const outcome = await supervisor.resume(run.id);
    await settle();
    expect(outcome).toBe("resumed");
    const resumed = store.get(run.id)!;
    expect(resumed.state).toBe("implementing");
    expect(spawnCalls[spawnCalls.length - 1]!.stage).toBe("implement");
  });

  test("resuming a run parked from a pre-existing outbox row is publish-blocked even with no blocker recorded", async () => {
    // Migration case: a run parked BEFORE this PR shipped has `blocker: null` (the store's
    // default). If it still has a live outbox row, resuming it must not re-spawn implement/review
    // on a branch whose publish is already in flight.
    const dir = scratch();
    const outboxPath = join(dir, "run-publish-outbox.jsonl");
    const run = makeRun({ state: "parked", error: "publish stalled" });
    mkdirSync(dirname(outboxPath), { recursive: true });
    writeFileSync(
      outboxPath,
      JSON.stringify({
        id: "op1",
        item: { id: run.id, identifier: run.slug },
        slug: run.slug,
        repoRoot: "/tmp/nonexistent",
        messagePrefix: "beckett",
        summary: "",
        purpose: "done",
        attempt: 1,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        createdAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
    const { supervisor, store } = newSupervisor({ publishOutboxPath: outboxPath });
    seedRun(store, run);
    const before = spawnCalls.length;
    const outcome = await supervisor.resume(run.id);
    expect(outcome).toBe("publish-blocked");
    expect(spawnCalls.length).toBe(before);
  });

  test("resuming a publish-parked run refuses and names courier", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(
      store,
      makeRun({
        state: "parked",
        error: "could not be published",
        blocker: {
          class: "admin-permission",
          actor: "human",
          reversible: true,
          remedy: "beckett task courier",
          detail: "could not be published",
          defaultAnswer: null,
          stage: null,
          at: "2026-08-10T00:00:00.000Z",
        },
      }),
    );
    const before = spawnCalls.length;
    const outcome = await supervisor.resume(run.id);
    expect(outcome).toBe("publish-blocked");
    expect(spawnCalls.length).toBe(before);
    expect(store.get(run.id)!.state).toBe("parked");
  });
});

describe("death classification (overhaul B7)", () => {
  test("a cap-killed implement worker resumes from its WIP instead of parking", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", "", null, { timedOut: true, errorClass: "timeout" });
    await settle();

    const resumed = store.get(run.id)!;
    expect(resumed.state).toBe("implementing");
    expect(resumed.autoResumes).toBe(1);
    expect(resumed.blocker).toBeNull();
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
    const steer = spawnCalls[1]!.steering?.join("\n") ?? "";
    expect(steer).toContain("wall-clock backstop");
    expect(steer).toContain("WIP");
    expect(commitCalls.some((c) => c.message.includes("WIP"))).toBe(true);
  });

  test("auto-resume stops at runs.auto_resume_max and parks with a transient blocker", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, auto_resume_max: 2 } }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", "", null, { timedOut: true, errorClass: "timeout" });
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    created[1]!.finish("error", "", null, { timedOut: true, errorClass: "timeout" });
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    created[2]!.finish("error", "", null, { timedOut: true, errorClass: "timeout" });
    await settle();

    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.autoResumes).toBe(2);
    expect(parked.blocker?.class).toBe("transient");
    expect(parked.blocker?.actor).toBe("human");
    expect(parked.error).toContain("auto-resume cap 2/2 reached");
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(3);
  });

  test("a worker killed by the daemon's own shutdown still parks for the boot requeue", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    supervisor.stop();
    created[0]!.finish("error", "", null, { timedOut: true, errorClass: "timeout" });
    await settle();

    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  test("an external death (auth) parks with a credential blocker and does not resume", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", "", null, { errorClass: "auth", errorMessage: "no auth" });
    await settle();

    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.autoResumes).toBe(0);
    expect(parked.blocker?.class).toBe("credential");
    expect(parked.blocker?.actor).toBe("human");
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  test("an external death does not owe the run a resume — a boot must not re-staff into the same wall", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    const { supervisor, store } = newSupervisor({ runtimeStatePath: statePath });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", "", null, { errorClass: "auth", errorMessage: "no auth" });
    await settle();
    expect(store.get(run.id)!.state).toBe("parked");

    const state = JSON.parse(readFileSync(statePath, "utf8")) as { owedResumes?: Record<string, unknown> };
    expect(state.owedResumes ?? {}).toEqual({});
  });

  test("a run that auto-resumes and later parks for an unrelated reason is not boot-requeued by a stale owed row", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    const storePath = join(dir, "runs.json");
    const { supervisor, store } = newSupervisor({
      runtimeStatePath: statePath,
      store: new RunStore(storePath),
      config: cfg({ runs: { max_live: 3, review_cycles_max: 1, budget_usd_per_run: 0, auto_resume_max: 2 } }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    // A self-inflicted death: the debt is recorded, then paid off by the in-process auto-resume.
    created[0]!.finish("error", "", null, { timedOut: true, errorClass: "timeout" });
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(store.get(run.id)!.autoResumes).toBe(1);
    // Implement finishes clean → review, which fails once and hits `review_cycles_max` — a park
    // that has nothing to do with the earlier death.
    created[1]!.finish("success", "implemented", doneSignal(true));
    await settle();
    created[2]!.finish("success", "still wrong", doneSignal(false, "still wrong"));
    await settle();
    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("rework cycle 1/1");

    const state = JSON.parse(readFileSync(statePath, "utf8")) as { owedResumes?: Record<string, unknown> };
    expect(state.owedResumes ?? {}).toEqual({});

    // Boot: nothing owed, so nothing gets re-staffed — the review-cap park stands.
    const next = newSupervisor({ runtimeStatePath: statePath, store: new RunStore(storePath) });
    await next.supervisor.start();
    await settle();
    next.supervisor.stop();
    expect(next.store.get(run.id)!.state).toBe("parked");
    expect(spawnCalls.filter((c) => c.stage === "review" || c.stage === "implement")).toHaveLength(3);
  });

  test("a live worker within the wrap-up lead gets exactly one wrap-up steer", async () => {
    let now = 0;
    const { supervisor, store } = newSupervisor({
      now: () => now,
      config: cfg({
        supervise: { staffing_watchdog_s: 120, worker_checkpoint_s: 0, worker_hard_cap_s: 3600, wrap_up_lead_s: 300 },
      }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    now = 3600_000 - 300_000; // exactly at the lead edge
    await supervisor.checkpointLiveRuns();
    await supervisor.checkpointLiveRuns();

    expect(created[0]!.nudges).toHaveLength(1);
    expect(created[0]!.nudges[0]).toContain("wall-clock backstop");
  });

  test("a worker outside the wrap-up lead gets no steer", async () => {
    let now = 0;
    const { supervisor, store } = newSupervisor({
      now: () => now,
      config: cfg({
        supervise: { staffing_watchdog_s: 120, worker_checkpoint_s: 0, worker_hard_cap_s: 3600, wrap_up_lead_s: 300 },
      }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    now = 1000; // nowhere near the cap
    await supervisor.checkpointLiveRuns();

    expect(created[0]!.nudges).toHaveLength(0);
  });
});

describe("elicitation (overhaul B8)", () => {
  test("a question blocker puts the run in awaiting_input with the question stored, not parked", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, question_wait_s: 3600 } }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish(
      "success",
      "need to know which auth provider",
      doneSignal(false, "need to know which auth provider", {
        class: "question",
        detail: "Which OAuth provider should this integrate with?",
        remedy: "answer the question",
        defaultAnswer: "google",
      }),
    );
    await settle();

    const asked = store.get(run.id)!;
    expect(asked.state).toBe("awaiting_input");
    expect(asked.blocker).toBeNull();
    expect(asked.question?.text).toBe("Which OAuth provider should this integrate with?");
    expect(asked.question?.defaultAnswer).toBe("google");
    expect(asked.question?.stage).toBe("implement");
    expect(commitCalls.some((c) => c.message.includes("WIP"))).toBe(true);
  });

  test("an answer resumes the same stage with the answer as steering", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, question_wait_s: 3600 } }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish(
      "success",
      "asking",
      doneSignal(false, "asking", {
        class: "question",
        detail: "Which OAuth provider should this integrate with?",
        remedy: "answer the question",
        defaultAnswer: null,
      }),
    );
    await settle();
    expect(store.get(run.id)!.state).toBe("awaiting_input");

    const outcome = await supervisor.resume(run.id, { answer: "use google" });
    await settle();
    expect(outcome).toBe("resumed");
    const resumed = store.get(run.id)!;
    expect(resumed.state).toBe("implementing");
    expect(resumed.question).toBeNull();
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
    const steer = spawnCalls[1]!.steering?.join("\n") ?? "";
    expect(steer).toContain("Which OAuth provider should this integrate with?");
    expect(steer).toContain("use google");
  });

  test("the question timeout fires the default answer and resumes", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, question_wait_s: 0.15 } }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish(
      "success",
      "asking",
      doneSignal(false, "asking", {
        class: "question",
        detail: "Which OAuth provider should this integrate with?",
        remedy: "answer the question",
        defaultAnswer: "google",
      }),
    );
    await settle();
    expect(store.get(run.id)!.state).toBe("awaiting_input");

    await new Promise((r) => setTimeout(r, 250));
    await settle();

    const resumed = store.get(run.id)!;
    expect(resumed.state).toBe("implementing");
    expect(resumed.question).toBeNull();
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
    const steer = spawnCalls[1]!.steering?.join("\n") ?? "";
    expect(steer).toContain("google");
  });

  test("a question with no default parks with a question blocker when the clock runs out", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, question_wait_s: 0.15 } }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish(
      "success",
      "asking",
      doneSignal(false, "asking", {
        class: "question",
        detail: "Which OAuth provider should this integrate with?",
        remedy: "answer the question",
        defaultAnswer: null,
      }),
    );
    await settle();
    expect(store.get(run.id)!.state).toBe("awaiting_input");

    await new Promise((r) => setTimeout(r, 250));
    await settle();

    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.question).toBeNull();
    expect(parked.blocker?.class).toBe("question");
    expect(parked.blocker?.actor).toBe("human");
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(1); // no resume spawn

    // The blocker's remedy says `--answer`; a late answer must still resume the run (as a
    // resume whose steering is the answer), not bounce with "not-awaiting".
    const late = await supervisor.resume(run.id, { answer: "GitHub" });
    expect(late).toBe("resumed");
    await settle();
    const resumed = store.get(run.id)!;
    expect(resumed.state).toBe("implementing");
    expect(resumed.blocker).toBeNull();
    const implSpawns = spawnCalls.filter((c) => c.stage === "implement");
    expect(implSpawns).toHaveLength(2);
    const steer = implSpawns[1]!.steering?.join("\n") ?? "";
    expect(steer).toContain("Answer to your question");
    expect(steer).toContain("GitHub");
  });

  test("a run left awaiting_input by a dead daemon re-arms its timer at boot", async () => {
    const dir = scratch();
    const storePath = join(dir, "runs.json");
    const store = new RunStore(storePath);
    const run = seedRun(
      store,
      makeRun({
        state: "awaiting_input",
        sessionIds: { implement: "sess-1" },
        question: {
          stage: "implement",
          text: "Which OAuth provider should this integrate with?",
          defaultAnswer: "google",
          askedAt: "2026-08-10T00:00:00.000Z",
          expiresAt: "2026-08-10T00:00:01.000Z", // long past by the time this test runs
        },
      }),
    );
    const { supervisor } = newSupervisor({ store });
    await supervisor.start();
    await tick();
    await settle();
    supervisor.stop();

    const resumed = store.get(run.id)!;
    expect(resumed.state).toBe("implementing");
    expect(resumed.question).toBeNull();
    expect(spawnCalls.some((c) => c.stage === "implement")).toBe(true);
  });

  test("cancelling an awaiting_input run clears its timer", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, question_wait_s: 0.15 } }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish(
      "success",
      "asking",
      doneSignal(false, "asking", {
        class: "question",
        detail: "Which OAuth provider should this integrate with?",
        remedy: "answer the question",
        defaultAnswer: "google",
      }),
    );
    await settle();
    expect(store.get(run.id)!.state).toBe("awaiting_input");

    const outcome = await supervisor.cancel(run.id, "no longer needed");
    await settle();
    expect(outcome).toBe("cancelled");

    // Wait past when the timer WOULD have fired, and confirm the cancel held.
    await new Promise((r) => setTimeout(r, 250));
    await settle();
    const after = store.get(run.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.question).toBeNull(); // cancel clears the question, not just the timer
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(1); // no resume spawn
  });
});

describe("crash resume", () => {
  test("a ledgered session is resumed instead of restarting the run from scratch", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    const storePath = join(dir, "runs.json");
    const store = new RunStore(storePath);
    const run = seedRun(store, makeRun({ state: "implementing" }));
    const workspace = join(dir, "wt");
    mkdirSync(workspace, { recursive: true });
    await store.update(run.id, { workspace });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        liveLedger: {
          [run.id]: {
            stage: "implement",
            workerId: "wk_old",
            sessionId: "sess-old",
            pid: 0,
            workspace,
            harness: "claude",
            spawnedAt: 1,
          },
        },
        pendingSteers: {},
      }),
    );
    const { supervisor } = newSupervisor({ runtimeStatePath: statePath, store: new RunStore(storePath) });
    await supervisor.start();
    await tick();
    supervisor.stop();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.resumeSessionId).toBe("sess-old");
    // Ghost WIP from the interrupted worker is committed before anything re-staffs.
    expect(commitCalls.some((c) => c.message.includes("restart WIP"))).toBe(true);
  });

  test("an interrupted worker with no session parks rather than silently restarting", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    const storePath = join(dir, "runs.json");
    const seed = new RunStore(storePath);
    const run = seedRun(seed, makeRun({ state: "implementing" }));
    const workspace = join(dir, "wt");
    mkdirSync(workspace, { recursive: true });
    await seed.update(run.id, { workspace });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        liveLedger: {
          [run.id]: {
            stage: "implement",
            workerId: "wk_old",
            sessionId: "",
            pid: 0,
            workspace,
            harness: "claude",
            spawnedAt: 1,
          },
        },
        pendingSteers: {},
      }),
    );
    const store = new RunStore(storePath);
    const { supervisor } = newSupervisor({ runtimeStatePath: statePath, store });
    await supervisor.start();
    await tick();
    supervisor.stop();
    expect(spawnCalls).toHaveLength(0);
    expect(store.get(run.id)!.state).toBe("parked");
    expect(store.get(run.id)!.error).toContain("no harness session survived");
  });

  test("buffered steering survives a restart and rides the next brief", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ version: 1, liveLedger: {}, pendingSteers: { "run-20260810-oauth": ["use PKCE"] } }),
    );
    const { supervisor, store } = newSupervisor({ runtimeStatePath: statePath });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.steering).toEqual(["use PKCE"]);
  });
});

/**
 * The 2026-08-12 casualty, end to end (#243 / #244 / #247): the deploy's `clean_shutdown` at
 * 20:51:44.345Z killed a live reviewer (.371Z) and the run parked (.404Z) carrying the WORKER'S
 * GREETING as its error, with nothing to pick the stage back up.
 */
describe("start() lowers shuttingDown — a restarted supervisor is not permanently in shutdown mode", () => {
  test("a worker death after a stop()/start() cycle is classified fresh, not as a shutdown kill", async () => {
    const { supervisor, store } = newSupervisor();
    supervisor.stop(); // raises shuttingDown with nothing live — the shape of an in-process restart
    await supervisor.start();

    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", "", null, { errorClass: "auth", errorMessage: "no auth" });
    await settle();

    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    // A shutdown-classified death would auto-resume (self-inflicted) instead of parking with a
    // typed credential blocker, and its cause would say "killed during daemon shutdown".
    expect(parked.blocker?.class).toBe("credential");
    expect(parked.error).not.toContain("daemon shutdown");
  });
});

describe("a worker killed by the daemon's own shutdown", () => {
  /** Verbatim from the parked run: the model's OPENING SENTENCE, which is not an error. */
  const GREETING = "the reviewer exited with an error.\n\nI'll start by inspecting the actual diff and repo state.";
  /** What the driver actually says now that it reads `signalCode` (`../drivers/base.ts`). */
  const SIGTERM = "claude process exited (signal SIGTERM)";

  /** Drive a run to a live review worker, then kill it the way a daemon restart does. */
  async function killedMidReview(opts: { statePath: string; store: RunStore }) {
    const h = newSupervisor({ runtimeStatePath: opts.statePath, store: opts.store });
    const run = seedRun(opts.store, makeRun({ state: "reviewing" }));
    await h.supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.stage).toBe("review");
    // `shell/main.ts` calls stop() FIRST in its drain, then the workers take the signal.
    h.supervisor.stop();
    created[0]!.finish("error", GREETING, null, { errorMessage: SIGTERM });
    await settle();
    return { ...h, run };
  }

  test("run.error names the signal and the shutdown, never the session's leading assistant text", async () => {
    const dir = scratch();
    const { store, events, run } = await killedMidReview({
      statePath: join(dir, "run-state.json"),
      store: new RunStore(join(dir, "runs.json")),
    });

    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("killed during daemon shutdown");
    expect(parked.error).toContain("SIGTERM");
    // The regression itself: not one word of what the model happened to be saying.
    expect(parked.error).not.toContain("I'll start by inspecting");
    expect(parked.error).not.toContain("the reviewer exited with an error.");

    // A restart is not a failure — the timeline says `interrupted`, and carries the cause only.
    const death = events.find((e) => e.stage === "review" && e.outcome !== "started");
    expect(death?.outcome).toBe("interrupted");
    expect(death?.error).toContain("SIGTERM");
    expect(death?.error).not.toContain("I'll start by inspecting");
  });

  // 2026-08-14: a worker Beckett itself killed on the wall-clock backstop was parked as "failure
  // class `crash`", which reads as a harness segfault and cost two investigations in one day. A
  // cap kill must name the cap and the knob, and must never say crash.
  //
  // B7: a cap kill no longer parks on the FIRST kill — it auto-resumes from its own WIP
  // (`runs.auto_resume_max`, default 2). This test pins `auto_resume_max: 1` so a SECOND cap kill
  // exhausts it and the wording assertions below apply to the exhaustion park, not the first kill.
  test("a wall-clock cap kill auto-resumes once, then parks as a timeout naming worker_hard_cap_s, never as a crash", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, auto_resume_max: 1 } }),
    });
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", GREETING, null, { timedOut: true, errorClass: "timeout" });
    await settle();

    // First cap kill: auto-resumed, not parked.
    const resumed = store.get(run.id)!;
    expect(resumed.state).toBe("implementing");
    expect(resumed.autoResumes).toBe(1);
    expect(spawnCalls.filter((c) => c.stage === "implement")).toHaveLength(2);
    expect(spawnCalls[1]!.steering?.join("\n")).toContain("wall-clock backstop");
    // And the work survives: WIP is committed BEFORE the resume, on every death path.
    expect(commitCalls.some((c) => c.message.includes("WIP"))).toBe(true);

    // Second cap kill: auto-resume budget (1) is exhausted — parks.
    created[1]!.finish("error", GREETING, null, { timedOut: true, errorClass: "timeout" });
    await settle();

    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("wall-clock backstop");
    expect(parked.error).toContain("worker_hard_cap_s");
    expect(parked.error).toContain("4h"); // the cap the default config actually allowed
    // The regression itself: nothing that sends a reader hunting for a segfault. The message DOES
    // say "did NOT crash" — an explicit denial is the point — but it must never report crash as
    // the class, and must not call a worker we deliberately stopped one that "died".
    expect(parked.error).not.toContain("failure class");
    expect(parked.error).not.toContain("died before it reported a verdict");
    expect(parked.error).not.toContain("I'll start by inspecting");
  });

  // `finishReview` does NOT commit WIP (a dead reviewer wrote nothing worth saving), so the park
  // message must not promise a WIP commit there — a park note that lies is how we got here.
  test("a capped REVIEWER names the cap but never claims a WIP commit it did not make", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, auto_resume_max: 1 } }),
    });
    const run = seedRun(store, makeRun({ state: "reviewing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", GREETING, null, { timedOut: true, errorClass: "timeout" });
    await settle();
    // First cap kill auto-resumes into review, never claiming a WIP commit it never made —
    // including in the steering note the resumed worker actually reads.
    expect(store.get(run.id)!.state).toBe("reviewing");
    expect(commitCalls.some((c) => c.message.includes("WIP"))).toBe(false);
    expect(spawnCalls[1]!.steering?.join("\n")).not.toContain("WIP");

    created[1]!.finish("error", GREETING, null, { timedOut: true, errorClass: "timeout" });
    await settle();

    const parked = store.get(run.id)!;
    expect(parked.state).toBe("parked");
    expect(parked.error).toContain("worker_hard_cap_s");
    expect(parked.error).not.toContain("WIP");
    expect(commitCalls.some((c) => c.message.includes("WIP"))).toBe(false);
  });

  test("a genuine crash still says crash — the timeout wording is not blanket-applied", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "implementing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", GREETING, null, { errorClass: "crash" });
    await settle();

    const parked = store.get(run.id)!;
    expect(parked.error).toContain("failure class `crash`");
    expect(parked.error).toContain("died before it reported a verdict");
    expect(parked.error).not.toContain("worker_hard_cap_s");
  });

  test("a worker that dies while the daemon is UP records the driver's cause, not a shutdown", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "reviewing" }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("error", GREETING, null, { errorMessage: "claude process exited (code 1)" });
    await settle();
    const parked = store.get(run.id)!;
    expect(parked.error).toContain("code 1");
    expect(parked.error).not.toContain("daemon shutdown");
    expect(parked.error).not.toContain("I'll start by inspecting");
  });

  test("on the next boot the owed review stage is re-dispatched instead of parking forever", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    const storePath = join(dir, "runs.json");
    const { run } = await killedMidReview({ statePath, store: new RunStore(storePath) });
    expect(spawnCalls).toHaveLength(1);

    // The daemon comes back on the new release. Nothing else changed: same state file, same ledger.
    const next = newSupervisor({ runtimeStatePath: statePath, store: new RunStore(storePath) });
    await next.supervisor.start();
    await settle();
    next.supervisor.stop();

    expect(next.store.get(run.id)!.state).toBe("reviewing");
    // The park reason belonged to a worker that no longer exists.
    expect(next.store.get(run.id)!.error).toBeNull();
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.stage).toBe("review");
    expect(next.events.find((e) => e.stage === "restart-restaff")?.message).toContain("SIGTERM");

    // Consumed ONCE: a third boot must not re-run a stage that is already staffed again.
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { owedResumes?: Record<string, unknown> };
    expect(state.owedResumes ?? {}).toEqual({});
  });

  test("a stage that completed before the kill is never re-run", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    const storePath = join(dir, "runs.json");
    const store = new RunStore(storePath);
    // The owed row survived, but the ledger says the run moved on — the stage landed before the
    // daemon went down, so re-dispatching it would double-run finished work.
    const run = seedRun(store, makeRun({ state: "done" }));
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        liveLedger: {},
        pendingSteers: {},
        owedResumes: { [run.id]: { stage: "review", cause: "killed during daemon shutdown", at: 1 } },
      }),
    );
    const { supervisor, store: reloaded } = newSupervisor({
      runtimeStatePath: statePath,
      store: new RunStore(storePath),
    });
    await supervisor.start();
    await settle();
    supervisor.stop();
    expect(spawnCalls).toHaveLength(0);
    expect(reloaded.get(run.id)!.state).toBe("done");
  });

  test("a boot requeue clears the stale typed blocker it just parked — `blocker` is non-null iff state parked", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    const storePath = join(dir, "runs.json");
    const store = new RunStore(storePath);
    const run = seedRun(
      store,
      makeRun({
        state: "parked",
        blocker: {
          class: "credential",
          actor: "human",
          reversible: true,
          detail: "no auth",
          remedy: "fix the credential",
          defaultAnswer: null,
          stage: "review",
          at: "2026-08-10T00:00:00.000Z",
        },
      }),
    );
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        liveLedger: {},
        pendingSteers: {},
        owedResumes: { [run.id]: { stage: "review", cause: "killed during daemon shutdown", at: 1 } },
      }),
    );
    const { supervisor, store: reloaded } = newSupervisor({
      runtimeStatePath: statePath,
      store: new RunStore(storePath),
    });
    await supervisor.start();
    await settle();
    supervisor.stop();
    const updated = reloaded.get(run.id)!;
    expect(updated.state).toBe("reviewing");
    expect(updated.blocker).toBeNull();
  });

  test("the deploy drain guard sees the live worker the restart would kill (#243)", async () => {
    const { supervisor, store } = newSupervisor({ now: () => 5_000 });
    const run = seedRun(store, makeRun({ state: "reviewing" }));
    await supervisor.admit(run.id);
    await tick();

    // This is the exact seam `deploy/run-drain-guard.ts` reads: `beckett status`'s `runs` array is
    // `RunSupervisor.live()` verbatim, and the guard refuses over any row with a worker.
    const blocking = restartBlockingRunWorkers({ runs: supervisor.live() });
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.runId).toBe(run.id);
    expect(blocking[0]!.stage).toBe("review");
    expect(typeof blocking[0]!.startedAt).toBe("number");

    // Once the stage finishes the run keeps living (publishing) but blocks no deploy.
    created[0]!.finish("success", "looks good", doneSignal(true));
    await settle();
    expect(restartBlockingRunWorkers({ runs: supervisor.live() })).toEqual([]);
    supervisor.stop();
  });
});

describe("staffing watchdog", () => {
  test("re-staffs once, then parks when the re-staff does not take", async () => {
    spawnThrows = new Error("harness binary missing");
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    // The failed spawn is recorded but does NOT park — the watchdog owns recovery.
    expect(spawnCalls).toHaveLength(1);
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(store.get(run.id)!.error).toContain("harness binary missing");

    const t0 = 8_000_000;
    expect(await supervisor.reconcileStaffing(t0)).toEqual({ restaffed: [], parked: [] });
    const first = await supervisor.reconcileStaffing(t0 + 121_000);
    await tick();
    expect(first.restaffed).toEqual([run.id]);
    expect(spawnCalls).toHaveLength(2);

    const second = await supervisor.reconcileStaffing(t0 + 400_000);
    expect(second.parked).toEqual([run.id]);
    expect(store.get(run.id)!.state).toBe("parked");
    // It never re-staffs a third time.
    expect(spawnCalls).toHaveLength(2);
  });

  test("a healthily-staffed run is never treated as wedged", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    const t0 = 9_000_000;
    expect(await supervisor.reconcileStaffing(t0)).toEqual({ restaffed: [], parked: [] });
    expect(await supervisor.reconcileStaffing(t0 + 400_000)).toEqual({ restaffed: [], parked: [] });
    expect(spawnCalls).toHaveLength(1);
  });

  // Finding 1: a paused `queued` run must not be wedge-clocked into a park — the hold is
  // transient, and `beckett task resume` is exactly what the pause lane exists to avoid needing.
  test("a paused queued run's wedge clock is forgotten — it never gets parked for the hold", async () => {
    const dir = scratch("beckett-pause-");
    const pauseFile = join(dir, "pause.json");
    writeFileSync(pauseFile, JSON.stringify({ pausedAt: "2026-08-15T00:00:00.000Z", reason: "hands off tonight", by: "jason" }));
    const { supervisor, store } = newSupervisor({ pauseFilePath: pauseFile });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    // Held by the pause guard in `spawnGuarded` — no worker, run stays `queued`.
    expect(spawnCalls).toHaveLength(0);
    expect(store.get(run.id)!.state).toBe("queued");

    const t0 = 8_000_000;
    await supervisor.reconcileStaffing(t0);
    const first = await supervisor.reconcileStaffing(t0 + 121_000);
    expect(first).toEqual({ restaffed: [], parked: [] });
    const second = await supervisor.reconcileStaffing(t0 + 400_000);
    expect(second).toEqual({ restaffed: [], parked: [] });
    expect(store.get(run.id)!.state).toBe("queued");
    expect(spawnCalls).toHaveLength(0);
  });

  // Finding 2: the watchdog must not bypass the B9 dependency gate — a dependent run staying
  // `queued` behind an in-flight sibling is not "wedged", it is waiting exactly as designed.
  test("a queued run waiting on a file-overlap dependency is never force-restaffed by the watchdog", async () => {
    const { supervisor, store } = newSupervisor();
    const sib = seedRun(store, makeRun({ id: "run-sib", slug: "sib", files: ["src/run/"] }));
    const dep = seedRun(store, makeRun({ id: "run-dep", slug: "dep", files: ["src/run/supervisor.ts"] }));
    await supervisor.admit(sib.id);
    await tick();
    await supervisor.admit(dep.id);
    await tick();
    expect(spawnCalls.map((c) => c.itemId)).toEqual([sib.id]);
    expect(store.get(dep.id)!.state).toBe("queued");

    const t0 = 8_000_000;
    await supervisor.reconcileStaffing(t0);
    await supervisor.reconcileStaffing(t0 + 10 * 121_000);
    await supervisor.reconcileStaffing(t0 + 20 * 121_000);
    expect(store.get(dep.id)!.state).toBe("queued");
    expect(spawnCalls).toHaveLength(1);
  });
});

describe("budget ceiling", () => {
  function row(over: Partial<SpendRecord>): SpendRecord {
    return {
      ticketId: "run-20260810-oauth",
      project: "gateway",
      stage: "implement",
      harness: "claude",
      model: "claude-sonnet-5",
      effort: "high",
      turns: 1,
      toolCalls: 1,
      tokensIn: 10,
      tokensOut: 10,
      costUsd: 5,
      durationMs: 1000,
      outcome: "done",
      reviewTier: "fresh",
      ts: "2026-08-10T01:00:00.000Z",
      ...over,
    };
  }

  test("rows that predate the run's createdAt do not count against its cap", async () => {
    const dir = scratch();
    const ledger = join(dir, "spend.jsonl");
    // $50 spent by a PRIOR incarnation, then $1 by this one. Cap is $10.
    appendSpendRecord(ledger, row({ costUsd: 50, ts: "2026-08-01T00:00:00.000Z" }));
    appendSpendRecord(ledger, row({ costUsd: 1, ts: "2026-08-10T01:00:00.000Z" }));
    const { supervisor, store } = newSupervisor({
      spendLedgerPath: ledger,
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 10 } }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls).toHaveLength(1);
  });

  test("at/over the cap no further stage is staffed", async () => {
    const dir = scratch();
    const ledger = join(dir, "spend.jsonl");
    appendSpendRecord(ledger, row({ costUsd: 12, ts: "2026-08-10T01:00:00.000Z" }));
    const { supervisor, store } = newSupervisor({
      spendLedgerPath: ledger,
      config: cfg({ runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 10 } }),
    });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("ultracode", () => {
  test("casts the implement stage onto opus at ultracode effort and asks for a large workflow", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ ultracode: true }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toEqual({ harness: "claude", model: "claude-opus-5", effort: "ultracode" });
    expect(spawnCalls[0]!.settingsExtra).toMatchObject({
      crossSessionInbound: "accept",
      workflowSizeGuideline: "large",
    });
  });

  test("an explicit implement cast wins over the ultracode default", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ ultracode: true, cast: { implement: { harness: "codex", effort: "medium" } } }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({ harness: "codex", effort: "medium" });
  });

  test("the review stage is unaffected by ultracode", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ ultracode: true, state: "reviewing" }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.stage).toBe("review");
    expect(spawnCalls[0]!.harness.model).toBe("claude-opus-5"); // config.models.reviewer, not the override
    expect(spawnCalls[0]!.harness.effort).not.toBe("ultracode");
    expect(spawnCalls[0]!.settingsExtra).not.toMatchObject({ workflowSizeGuideline: "large" });
  });
});

// Sonnet-first (issue #249): CLAUDE.md's "sonnet is the default builder" doctrine, enforced
// structurally instead of resting on the harness's own `default_model` config (which is exactly
// how the betterwright run cast opus with no directive behind it — see `cast.ts#applySonnetFirst`).
describe("sonnet-first implement casting", () => {
  test("an un-cast run defaults the implement stage to sonnet", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({ harness: "claude", model: "claude-sonnet-5" });
  });

  test("an explicit non-opus directive is honored verbatim ('cast sonnet'/'cast codex' pass-through)", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ cast: { implement: { harness: "codex", effort: "medium" } } }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({ harness: "codex", effort: "medium" });
  });

  test("an opus cast with no stated reason is downgraded to sonnet and logged on the run record", async () => {
    const { supervisor, store, events } = newSupervisor();
    const run = seedRun(store, makeRun({ cast: { implement: { harness: "claude", model: "claude-opus-5" } } }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({ harness: "claude", model: "claude-sonnet-5" });
    const note = events.find((e) => e.stage === "implement:cast");
    expect(note).toBeDefined();
    expect(note!.outcome).toBe("info");
    expect(note!.message).toContain("claude-opus-5");
    expect(note!.message).toContain("downgraded");
    // PR #252 review finding 4: the run record is the audit surface — a downgrade that leaves
    // `run.cast` still reading opus would make `runs.json` lie about what actually implemented.
    expect(store.get(run.id)!.cast?.implement?.model).toBe("claude-sonnet-5");
  });

  // PR #252 review finding 3: a model-less explicit claude cast must not fall through to the
  // driver's `config.harness.claude.default_model` — forced onto the enforced sonnet default
  // exactly like an un-cast run.
  test("an explicit claude cast naming no model is forced to sonnet, not the install's harness default", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ harness: { claude: { enabled: true, default_model: "claude-opus-5", default_effort: "high" }, codex: { enabled: true }, pi: { enabled: true } } }),
    });
    const run = seedRun(store, makeRun({ cast: { implement: { harness: "claude" } } }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({ harness: "claude", model: "claude-sonnet-5" });
  });

  // PR #252 review finding 3: `pickHealthyHarness`'s preflight-fallback substitution runs AFTER
  // sonnet-first and used to drop the model entirely, re-opening the same install-default
  // fallthrough for any non-claude cast whose harness fails preflight.
  test("a preflight-failed non-claude cast substitutes claude WITH the sonnet-first default model", async () => {
    const { supervisor, store } = newSupervisor({
      preflight: async (harness) => (harness === "codex" ? { ok: false, problems: ["not installed"] } : { ok: true, problems: [] }),
    });
    const run = seedRun(store, makeRun({ cast: { implement: { harness: "codex", effort: "medium" } } }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({ harness: "claude", model: "claude-sonnet-5", effort: "medium" });
  });

  // Re-review residual: the crash-recovery resume-hint substitution is the third path that used
  // to mint a model-less claude spec (after sonnet-first and the preflight fallback ran).
  test("a resume-hint harness substitution stamps the sonnet-first default model too", async () => {
    const dir = scratch();
    const statePath = join(dir, "run-state.json");
    const storePath = join(dir, "runs.json");
    const seed = new RunStore(storePath);
    const run = seedRun(seed, makeRun({ state: "implementing", cast: { implement: { harness: "codex", effort: "high" } } }));
    const workspace = join(dir, "wt");
    mkdirSync(workspace, { recursive: true });
    await seed.update(run.id, { workspace });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        liveLedger: {
          [run.id]: {
            stage: "implement",
            workerId: "wk_old",
            sessionId: "sess-old",
            pid: 0,
            workspace,
            harness: "claude",
            spawnedAt: 1,
          },
        },
        pendingSteers: {},
      }),
    );
    const { supervisor } = newSupervisor({ runtimeStatePath: statePath, store: new RunStore(storePath) });
    await supervisor.start();
    await tick();
    supervisor.stop();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.resumeSessionId).toBe("sess-old");
    expect(spawnCalls[0]!.harness).toMatchObject({ harness: "claude", model: "claude-sonnet-5", effort: "high" });
  });

  // Task 2 (overhaul B-P16): an opus implement cast reaches the supervisor carrying a `reason`
  // ONLY when a human quoted one via `--cast-quote` at `task-deploy.ts#resolveCast` (or the cast
  // already had one) — so a KEPT opus cast is now traced, not silently passed through, so jason
  // can grep for casts he never authored.
  test("an opus implement cast with a human quote runs opus and is traced, not downgraded", async () => {
    const { supervisor, store, events } = newSupervisor();
    const run = seedRun(
      store,
      makeRun({
        cast: {
          implement: {
            harness: "claude",
            model: "claude-opus-5",
            reason: 'human cast directive: "jason said opus for the gateway/auth cross-cut"',
          },
        },
      }),
    );
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({
      harness: "claude",
      model: "claude-opus-5",
      reason: 'human cast directive: "jason said opus for the gateway/auth cross-cut"',
    });
    // The reason on `run.cast.implement` (persisted to runs.json) is the record of why opus was
    // kept, so `run.cast` is NOT patched (unlike the downgrade path) — but it IS traced.
    const note = events.find((e) => e.stage === "implement:cast");
    expect(note).toBeDefined();
    expect(note!.outcome).toBe("info");
    expect(note!.message).toContain("opus implement kept");
    expect(note!.message).toContain('human cast directive: "jason said opus for the gateway/auth cross-cut"');
    expect(store.get(run.id)!.cast?.implement?.reason).toBe(
      'human cast directive: "jason said opus for the gateway/auth cross-cut"',
    );
  });

  test("the ultracode override still bypasses sonnet-first (its own documented deep-tier directive)", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ ultracode: true }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toEqual({ harness: "claude", model: "claude-opus-5", effort: "ultracode" });
  });

  test("review stays on the strongest tier and is unaffected by sonnet-first", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "reviewing" }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.stage).toBe("review");
    expect(spawnCalls[0]!.harness.model).toBe("claude-opus-5"); // config.models.reviewer (cfg() test default)
  });
});

// The review GATE (`cast.ts#HarnessSpec.reviewTier`), ported from the dispatcher. `self` is what
// `--preset taste-lane` and the cheap lanes are FOR: one pass, no second adversarial seat.
describe("review tier", () => {
  test("an explicit self tier publishes straight off implement — no reviewer is ever spawned", async () => {
    const { supervisor, store, publishCalls } = newSupervisor({ publish: true });
    const run = seedRun(
      store,
      makeRun({ cast: { implement: { harness: "claude", model: "claude-opus-5", effort: "high", reviewTier: "self" } } }),
    );
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    expect(spawnCalls.map((c) => c.stage)).toEqual(["implement"]);
    expect(store.get(run.id)!.state).toBe("done");
    expect(publishCalls).toHaveLength(1);
  });

  test("a low/medium implement effort derives self; high and an un-cast run stay fresh", async () => {
    for (const [effort, expected] of [["low", ["implement"]], ["medium", ["implement"]], ["high", ["implement", "review"]]] as const) {
      spawnCalls = [];
      created = [];
      const { supervisor, store } = newSupervisor({ publish: true });
      const run = seedRun(store, makeRun({ slug: `tier-${effort}`, cast: { implement: { harness: "pi", effort } } }));
      await supervisor.admit(run.id);
      await tick();
      created[0]!.finish("success", "implemented", doneSignal(true));
      await settle();
      expect(spawnCalls.map((c) => c.stage)).toEqual([...expected]);
    }

    spawnCalls = [];
    created = [];
    const { supervisor, store } = newSupervisor({ publish: true });
    const plain = seedRun(store, makeRun({ slug: "tier-none" }));
    await supervisor.admit(plain.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    expect(spawnCalls.map((c) => c.stage)).toEqual(["implement", "review"]);
  });

  test("the spend ledger records the tier the run ACTUALLY ran under, not a constant", async () => {
    const dir = scratch();
    const ledger = join(dir, "spend.jsonl");
    const { supervisor, store } = newSupervisor({ publish: true, spendLedgerPath: ledger });
    const run = seedRun(store, makeRun({ cast: { implement: { harness: "pi", effort: "low" } } }));
    await supervisor.admit(run.id);
    await tick();
    created[0]!.telemetry = () => ({
      turns: 1,
      toolCalls: 2,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 },
      usdEstimate: 0.01,
    });
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as SpendRecord);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reviewTier).toBe("self");
  });
});

// The ONE lever that stops work already running. Under the ticket system this was the poller's
// `cancelled` event reaching the dispatcher; without it a cancelled run burns to completion.
describe("cancel", () => {
  test("cancelling a live run aborts + reaps its worker and marks it cancelled", async () => {
    const { supervisor, store } = newSupervisor({ publish: true });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    const worker = created[0]!;
    let aborted: string | undefined;
    let reaped = 0;
    worker.abort = async (reason?: string) => void (aborted = reason);
    worker.reap = async () => void (reaped += 1);

    expect(await supervisor.cancel(run.id, "owner clicked cancel")).toBe("cancelled");
    expect(aborted).toBe("owner clicked cancel");
    expect(reaped).toBe(1);
    expect(store.get(run.id)!.state).toBe("cancelled");
    expect(store.get(run.id)!.error).toBe("owner clicked cancel");

    // And the run is genuinely off the engine: a late worker finish must not resurrect it into
    // review, publish it, or spawn anything else.
    worker.finish("success", "implemented", doneSignal(true));
    await settle();
    expect(spawnCalls).toHaveLength(1);
    expect(store.get(run.id)!.state).toBe("cancelled");
  });

  test("a queued (never-staffed) run cancels cleanly, and a finished one is refused", async () => {
    const { supervisor, store } = newSupervisor();
    const queued = seedRun(store, makeRun({ slug: "queued-one" }));
    expect(await supervisor.cancel(queued.id)).toBe("cancelled");
    expect(store.get(queued.id)!.state).toBe("cancelled");
    expect(spawnCalls).toHaveLength(0);

    expect(await supervisor.cancel("run-20260810-nope")).toBe("unknown");
    const finished = seedRun(store, makeRun({ slug: "shipped", state: "done" }));
    expect(await supervisor.cancel(finished.id)).toBe("already-terminal");
    expect(store.get(finished.id)!.state).toBe("done");
  });

  test("a parked run IS cancellable — parking is held-for-a-human, not finished", async () => {
    const { supervisor, store } = newSupervisor();
    const parked = seedRun(store, makeRun({ slug: "held", state: "parked" }));
    expect(await supervisor.cancel(parked.id)).toBe("cancelled");
    expect(store.get(parked.id)!.state).toBe("cancelled");
  });

  test("cancelling a parked run clears its typed blocker — `blocker` is non-null iff state parked", async () => {
    const { supervisor, store } = newSupervisor();
    const parked = seedRun(
      store,
      makeRun({
        slug: "held-with-blocker",
        state: "parked",
        blocker: {
          class: "credential",
          actor: "human",
          reversible: true,
          detail: "no auth",
          remedy: "fix the credential",
          defaultAnswer: null,
          stage: "implement",
          at: "2026-08-10T00:00:00.000Z",
        },
      }),
    );
    expect(await supervisor.cancel(parked.id)).toBe("cancelled");
    const cancelled = store.get(parked.id)!;
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.blocker).toBeNull();
  });

  test("cancelling frees the live-run slot so a queued run is pumped in", async () => {
    const { supervisor, store } = newSupervisor({
      config: cfg({ runs: { max_live: 1, review_cycles_max: 2, budget_usd_per_run: 0 } }),
    });
    const first = seedRun(store, makeRun({ slug: "first" }));
    const second = seedRun(store, makeRun({ slug: "second" }));
    await supervisor.admit(first.id);
    await tick();
    await supervisor.admit(second.id);
    await settle();
    expect(spawnCalls).toHaveLength(1); // second is queued behind the cap

    await supervisor.cancel(first.id);
    await settle();
    expect(spawnCalls.map((c) => c.itemId)).toEqual([first.id, second.id]);
  });
});

// #228: a human takes publishing over by hand after the outbox stops driving it. This is its OWN
// terminal shape — never `cancel()`'s bookkeeping, which used to be reused here and threw the
// run's own shipped outcome away (`state: "cancelled", error: "cancelled", prUrl: null`).
describe("courier handoff (#228)", () => {
  // B12: courier no longer grants `done` on the spot — it stamps `landingMode: "courier"` and
  // assembles a proof same as any other landing. There is no synchronous PR URL to check, so the
  // proof's courier rule (`./proof.ts`) is unverified on THIS call — #228's backfill hole, made
  // visible instead of silently `done`. `published` is still recorded, `prUrl` is still null.
  test("a courier-published run without a PR URL is unverified", async () => {
    const { supervisor, store, events } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "publishing" }));
    expect(await supervisor.courier(run.id)).toBe("done");
    await tick(); // the live sink notifies off a microtask queued inside trace()
    const updated = store.get(run.id)!;
    expect(updated.state).toBe("unverified");
    expect(updated.error).toContain("no PR URL recorded");
    expect(updated.published).toEqual({ via: "courier", prUrl: null });
    expect(updated.landingMode).toBe("courier");
    expect(updated.proof?.verified).toBe(false);
    const heldEvent = events.find((e) => e.stage === "done:courier" && e.outcome === "held");
    expect(heldEvent).toBeTruthy();
  });

  test("courier() drops the run's outbox row — a stale retry must never race the human's push", async () => {
    const dir = scratch();
    const outbox = join(dir, "run-publish-outbox.jsonl");
    const { supervisor, store } = newSupervisor({ publishOutboxPath: outbox });
    const run = seedRun(store, makeRun({ state: "publishing" }));
    writeFileSync(
      outbox,
      `${JSON.stringify({
        id: "op-1",
        item: { id: run.id, identifier: run.id },
        slug: "gateway",
        repoRoot: "/x",
        messagePrefix: "x",
        summary: "x",
        purpose: "done",
        attempt: 2,
        nextAttemptAt: Date.now() + 60_000,
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    await supervisor.courier(run.id);
    expect(readFileSync(outbox, "utf8").trim()).toBe("");
  });

  test("courier() also works from parked — a run the ladder already gave up on", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "parked", error: "parked for human courier" }));
    expect(await supervisor.courier(run.id)).toBe("done");
    // Unverified, not `done`, until a PR URL is known — same B12 rule as the `publishing` case.
    expect(store.get(run.id)!.state).toBe("unverified");
    expect(store.get(run.id)!.error).toContain("no PR URL recorded");
  });

  test("courier() refuses a run that never reached publishing (a caller mistake, not a transition)", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "implementing" }));
    expect(await supervisor.courier(run.id)).toBe("not-eligible");
    expect(store.get(run.id)!.state).toBe("implementing");
  });

  test("courier() refuses an already-terminal run and reports an unknown run id honestly", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "done" }));
    expect(await supervisor.courier(run.id)).toBe("already-terminal");
    expect(await supervisor.courier("run-20260810-nope")).toBe("unknown");
  });

  test("courier() refuses a run the daemon itself already published via the outbox", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(
      store,
      makeRun({
        state: "parked",
        published: { via: "outbox", prUrl: "https://github.com/o/gateway/pull/7" },
        landingMode: "pr",
      }),
    );
    expect(await supervisor.courier(run.id)).toBe("already-terminal");
    // Never overwritten: the real PR URL and mode beckett itself drove survive.
    const untouched = store.get(run.id)!;
    expect(untouched.published).toEqual({ via: "outbox", prUrl: "https://github.com/o/gateway/pull/7" });
    expect(untouched.landingMode).toBe("pr");
    expect(untouched.state).toBe("parked");
  });

  test("backfillCourierPrUrl fills the URL and re-traces done:courier for a still-open card", async () => {
    const { supervisor, store, events } = newSupervisor();
    const run = seedRun(store, makeRun({ state: "publishing" }));
    await supervisor.courier(run.id);
    const updated = await supervisor.backfillCourierPrUrl(run.id, "https://github.com/o/gateway/pull/9");
    await tick(); // the live sink notifies off a microtask queued inside trace()
    expect(updated?.published).toEqual({ via: "courier", prUrl: "https://github.com/o/gateway/pull/9" });
    expect(store.get(run.id)!.prUrl).toBe("https://github.com/o/gateway/pull/9");
    const backfillEvent = events.filter((e) => e.stage === "done:courier").at(-1);
    expect(backfillEvent?.message).toBe("https://github.com/o/gateway/pull/9");
  });
});

describe("steering", () => {
  test("a live worker is nudged; an idle run buffers for its next brief", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(await supervisor.steer(run.id, "prefer PKCE")).toBe("delivered");
    expect(created[0]!.nudges).toEqual(["prefer PKCE"]);

    const idle = seedRun(store, makeRun({ slug: "idle" }));
    expect(await supervisor.steer(idle.id, "later note")).toBe("buffered");
    await supervisor.admit(idle.id);
    await tick();
    expect(spawnCalls.find((c) => c.itemId === idle.id)!.steering).toEqual(["later note"]);
  });
});

// `progress/cards.ts`'s `specReader` adapter — the checklist line on a run's deploy receipt.
describe("runSpecReader", () => {
  test("reads a run's live spec.md checklist progress off its workspace", () => {
    const dir = scratch();
    const store = new RunStore(join(dir, "runs.json"));
    const run = seedRun(store, makeRun({ workspace: join(dir, "ws") }));
    mkdirSync(join(run.workspace!, ".beckett"), { recursive: true });
    writeFileSync(
      join(run.workspace!, SPEC_FILE_REL),
      "# t\n\n## Checklist\n- [x] one\n- [x] two\n- [ ] three\n",
    );
    expect(runSpecReader(store)(run.id)).toEqual({ done: 2, total: 3 });
  });

  test("no workspace yet (the deploy-instant card's case) reads as null, not zero", () => {
    const dir = scratch();
    const store = new RunStore(join(dir, "runs.json"));
    const run = seedRun(store, makeRun({ workspace: null }));
    expect(runSpecReader(store)(run.id)).toBeNull();
  });

  test("a workspace with no spec.md yet reads as null", () => {
    const dir = scratch();
    const store = new RunStore(join(dir, "runs.json"));
    const run = seedRun(store, makeRun({ workspace: join(dir, "ws") }));
    mkdirSync(run.workspace!, { recursive: true });
    expect(runSpecReader(store)(run.id)).toBeNull();
  });

  test("an id that isn't a run at all (a ticket-dispatcher event) reads as null", () => {
    const dir = scratch();
    const store = new RunStore(join(dir, "runs.json"));
    expect(runSpecReader(store)("ticket-1")).toBeNull();
  });
});

// ── the live activity blurb (./activity.ts) ─────────────────────────────────────────────

describe("the live activity blurb", () => {
  /** One worker tool call, exactly as the driver hands it to `onProgress`. */
  const toolCall = (tool: string, input: Record<string, unknown>) =>
    ({ kind: "tool_call", tool, toolId: `t${Math.random()}`, input }) as never;

  /** Drive a run to a live implement worker and hand back its `onProgress` callback. */
  async function liveWorker(opts: Parameters<typeof newSupervisor>[0] = {}) {
    const h = newSupervisor(opts);
    const run = seedRun(h.store, makeRun());
    await h.supervisor.admit(run.id);
    await tick();
    const onProgress = spawnCalls.at(-1)!.onProgress!;
    const blurbs = () => h.events.filter((e) => e.stage === "activity");
    return { ...h, run, onProgress, blurbs };
  }

  test("a tool call puts a derived phrase on the card, with no model in the path", async () => {
    const { onProgress, blurbs } = await liveWorker();
    onProgress(toolCall("Edit", { file_path: "/ws/web/public/index.html" }), {
      stage: "implement",
      workerId: "wk_1",
    });
    await tick();
    expect(blurbs().map((e) => e.message)).toEqual(["editing index.html"]);
    expect(blurbs()[0]).toMatchObject({ outcome: "info", stage: "activity" });
  });

  test("refreshes are throttled to one per 15s per run (fake clock)", async () => {
    let now = 1_000_000;
    const { onProgress, blurbs } = await liveWorker({ now: () => now });
    const ctx = { stage: "implement", workerId: "wk_1" };
    onProgress(toolCall("Edit", { file_path: "/ws/a.ts" }), ctx);
    onProgress(toolCall("Edit", { file_path: "/ws/b.ts" }), ctx); // same instant — throttled
    now += 14_999;
    onProgress(toolCall("Edit", { file_path: "/ws/c.ts" }), ctx); // still inside the floor
    now += 1;
    onProgress(toolCall("Edit", { file_path: "/ws/d.ts" }), ctx); // clears it
    await tick();
    expect(blurbs().map((e) => e.message)).toEqual(["editing a.ts", "editing d.ts"]);
  });

  test("a line that derives NOTHING does not spend the first-refresh allowance", async () => {
    // Every real worker opens with `session_started`, whose `▸ … worker started` line the rules
    // have nothing to say about. If that consumed the run's one never-waits refresh, the FIRST
    // real tool call of every run would sit behind the 15s floor — the exact moment the feature
    // exists for.
    let now = 1_000_000;
    const { onProgress, blurbs } = await liveWorker({ now: () => now });
    const ctx = { stage: "implement", workerId: "wk_1" };
    onProgress({ kind: "session_started", model: "claude" } as never, ctx);
    now += 2_000;
    onProgress(toolCall("Edit", { file_path: "/ws/web/public/index.html" }), ctx);
    await tick();
    expect(blurbs().map((e) => e.message)).toEqual(["editing index.html"]);
  });

  test("an unchanged phrase is not republished every cycle", async () => {
    let now = 1_000_000;
    const { onProgress, blurbs } = await liveWorker({ now: () => now });
    const ctx = { stage: "implement", workerId: "wk_1" };
    for (let i = 0; i < 4; i++) {
      onProgress(toolCall("Bash", { command: "bun test" }), ctx);
      now += 16_000;
    }
    await tick();
    // 4 refreshes, one phrase: the card is repainted only often enough to stay fresh.
    expect(blurbs().map((e) => e.message)).toEqual(["running tests"]);
    now += 60_000;
    onProgress(toolCall("Bash", { command: "bun test" }), ctx);
    await tick();
    expect(blurbs()).toHaveLength(2);
  });

  test("blurbs are EPHEMERAL — they never reach the durable dispatch ledger", async () => {
    const dir = scratch();
    const path = join(dir, "dispatch.jsonl");
    const h = newSupervisor();
    // A supervisor whose bus actually writes: the blurb must not appear in the file.
    const supervisor = new RunSupervisor({
      store: h.store,
      config: cfg(),
      gitOps: gitFakes,
      resolveRepoRoot: (run) => join(h.repos, runProjectSlug(run)),
      dispatchEventsPath: path,
      summarizeActivity: async () => null,
    });
    const run = seedRun(h.store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    spawnCalls[0]!.onProgress!(toolCall("Edit", { file_path: "/ws/index.html" }), {
      stage: "implement",
      workerId: "wk_1",
    });
    await tick();
    const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.stage === "activity")).toBe(false);
  });

  test("`enabled = false` reverts the card to the phase word entirely", async () => {
    const config = cfg({
      runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, activity: { enabled: false } },
    });
    const { onProgress, blurbs } = await liveWorker({ config });
    onProgress(toolCall("Edit", { file_path: "/ws/index.html" }), { stage: "implement", workerId: "wk_1" });
    await tick();
    expect(blurbs()).toHaveLength(0);
  });

  test("the polish is OFF by default — a throwing polish seam is never even called", async () => {
    // `newSupervisor`'s default polish throws; with `provider = "off"` (the shipped default) the
    // run still gets its derived phrase and nothing rejects.
    const { onProgress, blurbs } = await liveWorker();
    onProgress(toolCall("Bash", { command: "bun x tsc --noEmit" }), { stage: "implement", workerId: "wk_1" });
    await settle();
    expect(blurbs().map((e) => e.message)).toEqual(["typechecking"]);
  });

  test("a flagged-on polish overwrites the derived phrase, and a failing one doesn't", async () => {
    const config = cfg({
      runs: {
        max_live: 3,
        review_cycles_max: 2,
        budget_usd_per_run: 0,
        activity: { provider: "cerebras" },
      },
    });
    const good = await liveWorker({ config, summarizeActivity: async () => "polishing the hero styles" });
    good.onProgress(toolCall("Bash", { command: "bun test" }), { stage: "implement", workerId: "wk_1" });
    await settle();
    expect(good.blurbs().map((e) => e.message)).toEqual(["running tests", "polishing the hero styles"]);

    const bad = await liveWorker({
      config,
      summarizeActivity: async () => {
        throw new Error("cerebras is down");
      },
    });
    bad.onProgress(toolCall("Bash", { command: "bun test" }), { stage: "implement", workerId: "wk_1" });
    await settle();
    expect(bad.blurbs().map((e) => e.message)).toEqual(["running tests"]);
  });

  test("a polish that lands after its worker is gone never decorates the next stage's card", async () => {
    const config = cfg({
      runs: { max_live: 3, review_cycles_max: 2, budget_usd_per_run: 0, activity: { provider: "cerebras" } },
    });
    let release!: (phrase: string | null) => void;
    const inFlight = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const { onProgress, blurbs } = await liveWorker({ config, summarizeActivity: () => inFlight });
    onProgress(toolCall("Edit", { file_path: "/ws/index.html" }), { stage: "implement", workerId: "wk_1" });
    await tick();
    expect(blurbs().map((e) => e.message)).toEqual(["editing index.html"]);

    // The implement worker finishes while the model is still thinking. Its phrase describes a
    // stage that is over by the time it arrives, so it must be dropped rather than stamped onto
    // the card the run has moved on to.
    created[0]!.finish("success", "implemented", doneSignal(true));
    await settle();
    release("polishing the hero styles");
    await settle();
    expect(blurbs().map((e) => e.message)).toEqual(["editing index.html"]);
  });

  test("a tool call the journal drops produces no blurb, and neither does a non-worker stage", async () => {
    const { onProgress, blurbs } = await liveWorker();
    onProgress({ kind: "turn_complete" } as never, { stage: "implement", workerId: "wk_1" });
    onProgress(toolCall("Edit", { file_path: "/ws/a.ts" }), { stage: "design", workerId: "wk_1" });
    await tick();
    expect(blurbs()).toHaveLength(0);
  });
});

// ── worktree sweep (Task 4) ────────────────────────────────────────────────────────────────
describe("RunSupervisor worktree sweep", () => {
  function seedTerminalRun(
    store: RunStore,
    repos: string,
    over: Partial<Run> & { state: Run["state"] },
  ): { run: Run; workspace: string } {
    mkdirSync(repos, { recursive: true });
    const workspace = mkdtempSync(join(repos, "wt-"));
    const run = seedRun(
      store,
      makeRun({
        workspace,
        updatedAt: "2026-08-10T00:00:00.000Z",
        ...over,
      }),
    );
    return { run, workspace };
  }

  test("the sweep removes the worktree and the branch and nulls run.workspace", async () => {
    const removed: { repoRoot: string; workspace: string }[] = [];
    const branchesDeleted: { repoRoot: string; branch: string }[] = [];
    const origRemove = gitFakes.removeWorktree!;
    const origDelete = gitFakes.deleteBranch!;
    const origPushed = gitFakes.remoteBranchExists!;
    // Must be set BEFORE `newSupervisor()` — the constructor spreads `gitFakes` into `this.git`
    // by value, so a swap after construction would silently miss (matches the createWorktree
    // fixtures above).
    gitFakes.removeWorktree = async (repoRoot, ws) => {
      removed.push({ repoRoot, workspace: ws });
      rmSync(ws, { recursive: true, force: true }); // a real remove — the sweep checks existsSync after
    };
    gitFakes.deleteBranch = async (repoRoot, branch) => {
      branchesDeleted.push({ repoRoot, branch });
    };
    // Branch deletion is gated on durability — for a `done` run to have its branch removed too,
    // the branch must be provably on origin.
    gitFakes.remoteBranchExists = async () => true;
    try {
      const { supervisor, store, repos } = newSupervisor();
      const { run, workspace } = seedTerminalRun(store, repos, { state: "done" });
      // Ninety-six hours old — well past the 48h `done` TTL.
      const nowMs = Date.parse("2026-08-10T00:00:00.000Z") + 96 * 60 * 60_000;
      const swept: string[] = await (supervisor as any).sweepWorktrees(nowMs);
      expect(swept).toEqual([run.id]);
      expect(removed).toHaveLength(1);
      expect(removed[0]!.workspace).toBe(workspace);
      expect(branchesDeleted).toHaveLength(1);
      expect(branchesDeleted[0]!.branch).toBe(run.branch);
      expect(store.get(run.id)!.workspace).toBeNull();
    } finally {
      gitFakes.removeWorktree = origRemove;
      gitFakes.deleteBranch = origDelete;
      gitFakes.remoteBranchExists = origPushed;
    }
  });

  test("a done run whose branch is not on origin loses its worktree but keeps its branch", async () => {
    const removed: string[] = [];
    const branchesDeleted: string[] = [];
    const origRemove = gitFakes.removeWorktree!;
    const origDelete = gitFakes.deleteBranch!;
    const origPushed = gitFakes.remoteBranchExists!;
    gitFakes.removeWorktree = async (_repoRoot, ws) => {
      removed.push(ws);
      rmSync(ws, { recursive: true, force: true }); // a real remove — the sweep checks existsSync after
    };
    gitFakes.deleteBranch = async (_repoRoot, branch) => {
      branchesDeleted.push(branch);
    };
    gitFakes.remoteBranchExists = async () => false;
    try {
      const { supervisor, store, repos } = newSupervisor();
      const { run, workspace } = seedTerminalRun(store, repos, { state: "done" });
      const nowMs = Date.parse("2026-08-10T00:00:00.000Z") + 96 * 60 * 60_000; // past the 48h TTL
      const swept: string[] = await (supervisor as any).sweepWorktrees(nowMs);
      expect(swept).toEqual([run.id]);
      expect(removed).toEqual([workspace]);
      // The worktree is gone (harmless — objects live in repoRoot) but the local branch is the
      // ONLY ref to this run's commits when it was never pushed, so it must survive.
      expect(branchesDeleted).toHaveLength(0);
      expect(store.get(run.id)!.workspace).toBeNull();
    } finally {
      gitFakes.removeWorktree = origRemove;
      gitFakes.deleteBranch = origDelete;
      gitFakes.remoteBranchExists = origPushed;
    }
  });

  test("a removeWorktree failure is logged and never fails the staffing pass", async () => {
    const origRemove = gitFakes.removeWorktree!;
    gitFakes.removeWorktree = async () => {
      throw new Error("worktree remove exploded");
    };
    try {
      const { supervisor, store, repos } = newSupervisor();
      const { run, workspace } = seedTerminalRun(store, repos, { state: "done" });
      const nowMs = Date.parse("2026-08-10T00:00:00.000Z") + 96 * 60 * 60_000;
      // Neither the private sweep nor the public staffing pass may throw.
      await expect((supervisor as any).sweepWorktrees(nowMs)).resolves.toBeDefined();
      // The removeWorktree fake above throws WITHOUT deleting the directory, so it is still on
      // disk — the ledger must keep pointing at it so the next pass can retry, instead of
      // orphaning it invisibly.
      expect(store.get(run.id)!.workspace).toBe(workspace);
      await expect(supervisor.reconcileStaffing(nowMs)).resolves.toBeDefined();
    } finally {
      gitFakes.removeWorktree = origRemove;
    }
  });

  test("a parked run's workspace is never touched by the sweep", async () => {
    const { supervisor, store, repos } = newSupervisor();
    const { run, workspace } = seedTerminalRun(store, repos, {
      state: "parked",
      blocker: {
        class: "transient",
        actor: "human",
        reversible: true,
        remedy: "`beckett task resume …`",
        detail: "test park",
        defaultAnswer: null,
        stage: "review",
        at: "2026-08-10T00:00:00.000Z",
      },
      updatedAt: "2020-01-01T00:00:00.000Z", // absurdly old — TTL alone would sweep it
    });
    const removed: string[] = [];
    const origRemove = gitFakes.removeWorktree!;
    gitFakes.removeWorktree = async (_repoRoot, ws) => {
      removed.push(ws);
    };
    try {
      const nowMs = Date.parse("2026-08-10T00:00:00.000Z") + 365 * 24 * 60 * 60_000;
      const swept: string[] = await (supervisor as any).sweepWorktrees(nowMs);
      expect(swept).not.toContain(run.id);
      expect(removed).not.toContain(workspace);
      expect(store.get(run.id)!.workspace).toBe(workspace);
      expect(existsSync(workspace)).toBe(true);
    } finally {
      gitFakes.removeWorktree = origRemove;
    }
  });

  test("a done run younger than 48h is kept by the sweep", async () => {
    const { supervisor, store, repos } = newSupervisor();
    const { run, workspace } = seedTerminalRun(store, repos, { state: "done" });
    const nowMs = Date.parse("2026-08-10T00:00:00.000Z") + 1 * 60 * 60_000; // 1h old
    const swept: string[] = await (supervisor as any).sweepWorktrees(nowMs);
    expect(swept).not.toContain(run.id);
    expect(store.get(run.id)!.workspace).toBe(workspace);
  });

  test("a failed run whose branch is not on origin is kept even past 7 days", async () => {
    const { supervisor, store, repos } = newSupervisor();
    const { run, workspace } = seedTerminalRun(store, repos, { state: "failed" });
    const origPushed = gitFakes.remoteBranchExists!;
    gitFakes.remoteBranchExists = async () => false;
    try {
      const nowMs = Date.parse("2026-08-10T00:00:00.000Z") + 30 * 24 * 60 * 60_000; // 30d old
      const swept: string[] = await (supervisor as any).sweepWorktrees(nowMs);
      expect(swept).not.toContain(run.id);
      expect(store.get(run.id)!.workspace).toBe(workspace);
    } finally {
      gitFakes.remoteBranchExists = origPushed;
    }
  });
});
