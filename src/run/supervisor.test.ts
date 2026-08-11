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
import type { Config } from "../types.ts";
import type { HarnessSpec } from "./cast.ts";
import { appendSpendRecord, type SpendRecord } from "../spend.ts";
import type { DispatchEvent } from "../dispatch/events.ts";
import type { RunGitOps } from "./supervisor.ts";
import { RunStore } from "./store.ts";
import type { Run } from "./types.ts";

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
    finish(status: "success" | "error", summary: string, structured: unknown = null) {
      result = { status, summary, structured, timedOut: false, unappliedNudges: [] };
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

const { RunSupervisor, runProjectSlug, runSpecReader } = await import("./supervisor.ts");
const { resolveSelfProjectOwner } = await import("../github/owner.ts");

// ── injected git fakes ──────────────────────────────────────────────────────────────────────
let commitCalls: { workspace: string; message: string }[] = [];
let ensureCalls: { repoRoot: string; slug: string; owner: string }[] = [];
let commitResult = { committed: true, sha: "commit000" };
/** The diff the review stage pre-reads — a `let` so a test can swap in a copy/href surface (#234). */
const DEFAULT_REVIEW_DIFF = "diff --git a/x.ts b/x.ts\n+added";
let reviewDiffText = DEFAULT_REVIEW_DIFF;
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
    mkdirSync(opts.workspace, { recursive: true });
    return { repoRoot: opts.repoRoot, workspace: opts.workspace, branch: opts.branch };
  },
  removeWorktree: async () => {},
  fetchRemote: async () => true,
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
    sessionIds: {},
    sessionName: over.sessionName ?? `beckett-run-${slug}`,
    reviewCycles: over.reviewCycles ?? 0,
    prUrl: null,
    error: null,
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

function doneSignal(status: "complete" | "blocked" | "partial", summary: string = status) {
  return { status, summary, filesChanged: ["src/app.ts"], checksRun: ["bun test"], blockedReason: null };
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

  test("the spec.md scaffold is written BEFORE the worker spawns", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    const workspace = store.get(run.id)!.workspace!;
    expect(existsSync(join(workspace, "spec.md"))).toBe(true);
    const spec = readFileSync(join(workspace, "spec.md"), "utf8");
    expect(spec).toContain("## Goal\nAdd OAuth middleware to the API gateway.");
    expect(spec).toContain("## Checklist");
    // The gate the worker will be held to is registered on the implement stage only. The hook
    // takes the workspace ROOT (`--root`) and resolves `<root>/spec.md` itself — see
    // `specGateSpec` in ../hooks/registry.ts and `resolveConfig` in ../hooks/spec-gate.ts.
    expect(spawnCalls[0]!.extraHooks?.[0]!.event).toBe("Stop");
    expect(spawnCalls[0]!.extraHooks?.[0]!.command).toContain("spec-gate.ts");
    expect(spawnCalls[0]!.extraHooks?.[0]!.command).toContain(`--root ${JSON.stringify(workspace)}`);
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

    created[0]!.finish("success", "implemented", doneSignal("complete"));
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
    created[0]!.finish("success", "done", doneSignal("complete"));
    await settle();
    expect(spawnCalls.map((c) => c.itemId)).toEqual([a.id, a.id]);
    expect(spawnCalls[1]!.stage).toBe("review");

    // Once a is genuinely finished, the queue pumps and b starts.
    created[1]!.finish("success", "pass", doneSignal("complete"));
    await settle();
    expect(store.get(a.id)!.state).toBe("done");
    expect(spawnCalls.map((c) => c.itemId)).toContain(b.id);
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

    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();
    created[1]!.finish("success", "pass", doneSignal("complete"));
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

    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();
    expect(store.get(run.id)!.state).toBe("reviewing");
    expect(spawnCalls[1]!.stage).toBe("review");
    // The reviewer is handed the diff rather than made to rediscover it.
    expect(spawnCalls[1]!.reviewDiff).toContain("diff --git");

    created[1]!.finish("success", "looks good", doneSignal("complete"));
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();
    expect(events.some((e) => e.stage === "review:depth")).toBe(false);
    expect(spawnCalls[1]!.stage).toBe("review");
  });

  test("the done event's message is the shipped PR URL — the deploy receipt's closing line", async () => {
    const { supervisor, store, events } = newSupervisor({ publish: true });
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();
    created[1]!.finish("success", "looks good", doneSignal("complete"));
    await settle();
    const doneEvent = events.find((e) => e.stage === "done" && e.outcome === "passed");
    expect(doneEvent?.message).toBe("https://github.com/o/gateway/pull/7");
  });

  test("no publisher wired still finishes the run (local-only completion)", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();
    created[1]!.finish("success", "pass", doneSignal("complete"));
    await settle();
    expect(store.get(run.id)!.state).toBe("done");
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();
    created[1]!.finish("success", "pass", doneSignal("complete"));
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();
    created[1]!.finish("success", "pass", doneSignal("complete"));
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

  test("an implement worker that reports blocked parks the run with its WIP committed", async () => {
    const { supervisor, store } = newSupervisor();
    const run = seedRun(store, makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "stuck on auth", doneSignal("blocked"));
    await settle();
    expect(store.get(run.id)!.state).toBe("parked");
    expect(store.get(run.id)!.error).toContain("blocked");
    expect(commitCalls.some((c) => c.message.includes("WIP"))).toBe(true);
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();

    // Cycle 1: back to implement, carrying the review notes as steering.
    created[1]!.finish("success", "missing error handling", doneSignal("blocked", "missing error handling"));
    await settle();
    expect(store.get(run.id)!.state).toBe("implementing");
    expect(store.get(run.id)!.reviewCycles).toBe(1);
    const rework = spawnCalls.find((c, i) => i > 1 && c.stage === "implement")!;
    expect(rework.steering?.join("\n")).toContain("missing error handling");

    // Second implement → second review → cycle 2 hits the cap and parks.
    created[2]!.finish("success", "fixed", doneSignal("complete"));
    await settle();
    created[3]!.finish("success", "still wrong", doneSignal("blocked", "still wrong"));
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();

    // The rework spawn dies (harness hiccup). Its steering was already consumed and persisted-as-
    // removed, so without a give-back the re-staffed worker would run with no idea what to fix.
    spawnThrows = new Error("harness binary missing");
    created[1]!.finish("success", "missing error handling", doneSignal("blocked", "missing error handling"));
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
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
      created[0]!.finish("success", "implemented", doneSignal("complete"));
      await settle();
      expect(spawnCalls.map((c) => c.stage)).toEqual([...expected]);
    }

    spawnCalls = [];
    created = [];
    const { supervisor, store } = newSupervisor({ publish: true });
    const plain = seedRun(store, makeRun({ slug: "tier-none" }));
    await supervisor.admit(plain.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal("complete"));
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
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
    worker.finish("success", "implemented", doneSignal("complete"));
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
    mkdirSync(run.workspace!, { recursive: true });
    writeFileSync(
      join(run.workspace!, "spec.md"),
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
    created[0]!.finish("success", "implemented", doneSignal("complete"));
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
