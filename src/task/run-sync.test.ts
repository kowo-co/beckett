/**
 * The task registry ↔ run engine bridge (`src/task/run-sync.ts`) — driven against a REAL
 * `TaskStore` on a scratch registry, because the whole point of the module is what ends up on
 * disk for `beckett task list` and the #104 card to read.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./store.ts";
import { branchRefOfRun, createRunTaskSync, type RunSyncTaskStore } from "./run-sync.ts";
import type { Run, RunState, RunStateChange } from "../run/types.ts";
import type { Logger } from "../types.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beckett-run-sync-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const warnings: string[] = [];
const logger = {
  debug() {},
  info() {},
  warn: (msg: string) => void warnings.push(msg),
  error() {},
  child: () => logger,
} as unknown as Logger;

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: "run-20260810-oauth",
    slug: "oauth",
    title: "Add OAuth",
    prompt: "Add OAuth.",
    channelId: "chan-1",
    requesterId: null,
    taskRef: "#1.1",
    ultracode: false,
    cast: null,
    repo: "gateway",
    state: "queued",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    workspace: null,
    branch: "beckett/run-oauth",
    baseSha: null,
    sessionIds: {},
    sessionName: "beckett-run-oauth",
    reviewCycles: 0,
    continuations: 0,
    autoResumes: 0,
    prUrl: null,
    error: null,
    blocker: null,
    question: null,
    published: null,
    proof: null,
    landingMode: null,
    deps: [],
    files: [],
    ...over,
  };
}

const change = (run: Run, to: RunState): RunStateChange => ({ kind: "state_changed", run, from: null, to });

function syncFor(store: RunSyncTaskStore) {
  return createRunTaskSync({
    tasks: store,
    projectSlugOf: (run) => run.repo ?? "beckett",
    githubOwner: "kowo-co",
    logger,
  });
}

async function registry(): Promise<TaskStore> {
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.createTask({ title: "Ship the gateway" });
  await store.createBranch({ task: 1, title: "OAuth middleware" });
  return store;
}

describe("branchRefOfRun", () => {
  test("normalizes a branch ref and refuses anything that is not one", () => {
    expect(branchRefOfRun({ taskRef: "#12.1" })).toBe("12.1");
    expect(branchRefOfRun({ taskRef: " 12.1 " })).toBe("12.1");
    // A bare task ref names no branch, and a prompt-deployed run has none at all.
    expect(branchRefOfRun({ taskRef: "#12" })).toBeNull();
    expect(branchRefOfRun({ taskRef: null })).toBeNull();
  });
});

describe("the board follows the run", () => {
  test("each transition projects onto the branch status — the frozen-at-ready bug", async () => {
    const store = await registry();
    const sync = syncFor(store);
    const run = makeRun();

    await sync.onStateChange(change(run, "implementing"));
    expect(store.getBranch("1.1")!.branch.status).toBe("running");
    expect(store.getBranch("1.1")!.branch.run).toEqual({ runId: run.id });

    await sync.onStateChange(change({ ...run, state: "reviewing" }, "reviewing"));
    expect(store.getBranch("1.1")!.branch.status).toBe("review");

    await sync.onStateChange(change({ ...run, state: "done" }, "done"));
    expect(store.getBranch("1.1")!.branch.status).toBe("done");
  });

  test("the worktree is recorded with the run's REAL git ref, not a derived task-N-x guess", async () => {
    const store = await registry();
    const sync = syncFor(store);
    const run = makeRun({ workspace: "/tmp/wt/oauth", baseSha: "base000" });
    await sync.onStateChange(change(run, "implementing"));
    expect(store.getBranch("1.1")!.branch.git).toMatchObject({
      project: "gateway",
      workspace: "/tmp/wt/oauth",
      gitRef: "beckett/run-oauth",
      baseSha: "base000",
    });
  });

  test("a PR and a publication land on the branch (artifact link + Merge button)", async () => {
    const store = await registry();
    const sync = syncFor(store);
    const run = makeRun();
    await sync.onStateChange(change(run, "implementing"));
    await sync.onPrOpened(run, { repo: "kowo-co/gateway", number: 7, url: "https://github.com/kowo-co/gateway/pull/7" });
    await sync.onPublished(run, { url: "https://github.com/kowo-co/gateway/pull/7", kind: "pr" });
    const branch = store.getBranch("1.1")!.branch;
    expect(branch.pullRequest).toEqual({
      repo: "kowo-co/gateway",
      number: 7,
      url: "https://github.com/kowo-co/gateway/pull/7",
      state: "OPEN",
    });
    expect(branch.publication).toEqual({
      repo: "kowo-co/gateway",
      url: "https://github.com/kowo-co/gateway/pull/7",
      kind: "pr",
    });
  });

  test("a run with no task branch touches nothing", async () => {
    const store = await registry();
    const sync = syncFor(store);
    const run = makeRun({ taskRef: null });
    await sync.onStateChange(change(run, "implementing"));
    await sync.onPrOpened(run, { repo: "kowo-co/gateway", number: 7, url: "u" });
    await sync.onPublished(run, { url: "u", kind: "pushed" });
    const branch = store.getBranch("1.1")!.branch;
    expect(branch.run).toBeUndefined();
    expect(branch.status).toBe("ready");
  });
});

test("a registry write that throws is reported, never propagated into the engine", async () => {
  warnings.length = 0;
  const exploding: RunSyncTaskStore = {
    linkRun: async () => {
      throw new Error("registry is locked");
    },
    setGit: async () => {
      throw new Error("registry is locked");
    },
    setPullRequest: async () => {
      throw new Error("registry is locked");
    },
    setPublication: async () => {
      throw new Error("registry is locked");
    },
  };
  const sync = syncFor(exploding);
  const run = makeRun({ workspace: "/tmp/wt/oauth" });
  await sync.onStateChange(change(run, "implementing"));
  await sync.onPrOpened(run, { repo: "r", number: 1, url: "u" });
  await sync.onPublished(run, { url: "u", kind: "pushed" });
  // state + git + PR + publication = four reported failures, zero thrown.
  expect(warnings).toHaveLength(4);
  expect(warnings.every((w) => w.includes("sync failed"))).toBe(true);
});
