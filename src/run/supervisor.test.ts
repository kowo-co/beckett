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
import { join } from "node:path";
import type { Config } from "../types.ts";
import type { HarnessSpec } from "../tracker/types.ts";
import { appendSpendRecord, type SpendRecord } from "../spend.ts";
import type { RunGitOps } from "./supervisor.ts";
import { RunStore } from "./store.ts";
import type { Run } from "./types.ts";

// ── controllable fake worker handle + spawn mock ────────────────────────────────────────────
interface SpawnCall {
  ticketId: string;
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
    ticketId: args.ticket.id,
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
    ticketId: args.ticket.id,
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
    body: args.ticket.body,
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
  spawnTicketWorker: fakeSpawn,
}));

const { RunSupervisor } = await import("./supervisor.ts");

// ── injected git fakes ──────────────────────────────────────────────────────────────────────
let commitCalls: { workspace: string; message: string }[] = [];
let commitResult = { committed: true, sha: "commit000" };
const gitFakes: Partial<RunGitOps> = {
  commitWorktree: async (workspace: string, message: string) => {
    commitCalls.push({ workspace, message });
    return commitResult;
  },
  headSha: async () => "base000",
  hasDiffSince: async () => true,
  ensureProjectRepo: async () => {},
  readDiff: async () => "diff --git a/x.ts b/x.ts\n+added",
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
    repo: over.repo ?? "gateway",
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

function doneSignal(status: "complete" | "blocked" | "partial", summary: string = status) {
  return { status, summary, filesChanged: ["src/app.ts"], checksRun: ["bun test"], blockedReason: null };
}

interface Harness {
  supervisor: InstanceType<typeof RunSupervisor>;
  store: RunStore;
  repos: string;
  publishCalls: { slug: string; ticket?: string; commitMessage?: string }[];
}

function newSupervisor(
  opts: {
    config?: Config;
    publish?: boolean | (() => Promise<{ url: string; kind: "pushed" | "pr"; prUrl?: string }>);
    runtimeStatePath?: string;
    spendLedgerPath?: string;
    publishOutboxPath?: string;
    store?: RunStore;
  } = {},
): Harness {
  const dir = scratch();
  const repos = join(dir, "repos");
  const store = opts.store ?? new RunStore(join(dir, "runs.json"));
  const publishCalls: Harness["publishCalls"] = [];
  const supervisor = new RunSupervisor({
    store,
    config: opts.config ?? cfg(),
    gitOps: gitFakes,
    resolveRepoRoot: (run) => join(repos, run.repo ?? run.id),
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
    ...(opts.runtimeStatePath ? { runtimeStatePath: opts.runtimeStatePath } : {}),
    ...(opts.spendLedgerPath ? { spendLedgerPath: opts.spendLedgerPath } : {}),
    ...(opts.publishOutboxPath ? { publishOutboxPath: opts.publishOutboxPath } : {}),
  });
  return { supervisor, store, repos, publishCalls };
}

beforeEach(() => {
  spawnCalls = [];
  created = [];
  counter = 0;
  spawnThrows = null;
  commitCalls = [];
  commitResult = { committed: true, sha: "commit000" };
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// ── tests ───────────────────────────────────────────────────────────────────────────────────

describe("admission", () => {
  test("admit spawns one implement worker and moves the run to implementing", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.stage).toBe("implement");
    expect(spawnCalls[0]!.branch).toBe(run.branch);
    expect(store.get(run.id)!.state).toBe("implementing");
  });

  test("claim-before-dispatch: a double admit produces exactly one spawn", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun());
    // Both calls race through the guard before either awaits — the synchronous reservation is
    // the only thing that can stop the second one.
    await Promise.all([supervisor.admit(run.id), supervisor.admit(run.id)]);
    await settle();
    expect(spawnCalls).toHaveLength(1);
  });

  test("the spec.md scaffold is written BEFORE the worker spawns", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun());
    await supervisor.admit(run.id);
    await tick();
    const workspace = store.get(run.id)!.workspace!;
    expect(existsSync(join(workspace, "spec.md"))).toBe(true);
    const spec = readFileSync(join(workspace, "spec.md"), "utf8");
    expect(spec).toContain("## Goal\nAdd OAuth middleware to the API gateway.");
    expect(spec).toContain("## Checklist");
    // The gate the worker will be held to is registered on the implement stage only.
    expect(spawnCalls[0]!.extraHooks?.[0]!.event).toBe("Stop");
    expect(spawnCalls[0]!.extraHooks?.[0]!.command).toContain("spec.md");
  });

  test("every worker gets its run's session name and accepts cross-session messages", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.sessionName).toBe("beckett-run-oauth");
    expect(spawnCalls[0]!.settingsExtra).toMatchObject({ crossSessionInbound: "accept" });
  });

  test("max_live caps live runs and queues the rest FIFO", async () => {
    const { supervisor, store } = newSupervisor({ config: cfg({ runs: { max_live: 1, review_cycles_max: 2, budget_usd_per_run: 0 } }) });
    const a = store.create(makeRun({ slug: "a" }));
    const b = store.create(makeRun({ slug: "b" }));
    await supervisor.admit(a.id);
    await tick();
    await supervisor.admit(b.id);
    await tick();
    expect(spawnCalls.map((c) => c.ticketId)).toEqual([a.id]);

    // A's own next stage takes the freed slot first — b is still queued behind the cap.
    created[0]!.finish("success", "done", doneSignal("complete"));
    await settle();
    expect(spawnCalls.map((c) => c.ticketId)).toEqual([a.id, a.id]);
    expect(spawnCalls[1]!.stage).toBe("review");

    // Once a is genuinely finished, the queue pumps and b starts.
    created[1]!.finish("success", "pass", doneSignal("complete"));
    await settle();
    expect(store.get(a.id)!.state).toBe("done");
    expect(spawnCalls.map((c) => c.ticketId)).toContain(b.id);
  });
});

describe("stage flow", () => {
  test("implement done-signal → review → publish → done", async () => {
    const { supervisor, store, publishCalls } = newSupervisor({ publish: true });
    const run = store.create(makeRun());
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

  test("no publisher wired still finishes the run (local-only completion)", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun());
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
    const run = store.create(makeRun());
    await supervisor.admit(run.id);
    await tick();
    created[0]!.finish("success", "implemented", doneSignal("complete"));
    await settle();
    created[1]!.finish("success", "pass", doneSignal("complete"));
    await settle();
    expect(store.get(run.id)!.state).toBe("publishing");
    const rows = readFileSync(outbox, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].ticket.id).toBe(run.id);
    expect(rows[0].purpose).toBe("done");
  });

  test("an implement worker that reports blocked parks the run with its WIP committed", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun());
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
    const run = store.create(makeRun());
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

  test("a reviewer with no schema-valid verdict parks rather than guessing", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun({ state: "reviewing" }));
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
    const run = store.create(makeRun({ state: "implementing" }));
    const workspace = join(dir, "wt");
    mkdirSync(workspace, { recursive: true });
    store.update(run.id, { workspace });
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
    const run = seed.create(makeRun({ state: "implementing" }));
    const workspace = join(dir, "wt");
    mkdirSync(workspace, { recursive: true });
    seed.update(run.id, { workspace });
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
    const run = store.create(makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.steering).toEqual(["use PKCE"]);
  });
});

describe("staffing watchdog", () => {
  test("re-staffs once, then parks when the re-staff does not take", async () => {
    spawnThrows = new Error("harness binary missing");
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun());
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
    const run = store.create(makeRun());
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
    const run = store.create(makeRun());
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
    const run = store.create(makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("ultracode", () => {
  test("casts the implement stage onto opus at ultracode effort and asks for a large workflow", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun({ ultracode: true }));
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
    const run = store.create(makeRun({ ultracode: true, cast: { implement: { harness: "codex", effort: "medium" } } }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.harness).toMatchObject({ harness: "codex", effort: "medium" });
  });

  test("the review stage is unaffected by ultracode", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun({ ultracode: true, state: "reviewing" }));
    await supervisor.admit(run.id);
    await tick();
    expect(spawnCalls[0]!.stage).toBe("review");
    expect(spawnCalls[0]!.harness.model).toBe("claude-opus-5"); // config.models.reviewer, not the override
    expect(spawnCalls[0]!.harness.effort).not.toBe("ultracode");
    expect(spawnCalls[0]!.settingsExtra).not.toMatchObject({ workflowSizeGuideline: "large" });
  });
});

describe("steering", () => {
  test("a live worker is nudged; an idle run buffers for its next brief", async () => {
    const { supervisor, store } = newSupervisor();
    const run = store.create(makeRun());
    await supervisor.admit(run.id);
    await tick();
    expect(await supervisor.steer(run.id, "prefer PKCE")).toBe("delivered");
    expect(created[0]!.nudges).toEqual(["prefer PKCE"]);

    const idle = store.create(makeRun({ slug: "idle" }));
    expect(await supervisor.steer(idle.id, "later note")).toBe("buffered");
    await supervisor.admit(idle.id);
    await tick();
    expect(spawnCalls.find((c) => c.ticketId === idle.id)!.steering).toEqual(["later note"]);
  });
});
