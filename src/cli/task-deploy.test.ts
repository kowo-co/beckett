import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "../run/types.ts";
import {
  deployRun,
  parseTaskDeployArgs,
  slugify,
  TaskDeployUsageError,
  type RunStoreLike,
  type TaskDeployDeps,
} from "./task-deploy.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FAKE_NOW = "2026-08-10T12:00:00.000Z";

/**
 * A fake `RunStore` + fake bus, mirroring how `task-start.test.ts` fakes the tracker client.
 * `create()` mints identity from the partial input exactly like the real `RunStore` does
 * (`../run/store.ts`), minus the ledger-dependent slug dedupe — so these tests pin the CLI's
 * side of the contract (what argv resolves to) rather than re-testing the store.
 */
function fakeDeps(): TaskDeployDeps & { created: Run[]; busPings: Array<{ cmd: string; args: Record<string, unknown> }> } {
  const created: Run[] = [];
  const busPings: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const store: RunStoreLike = {
    async create(input) {
      const slug = input.slug ?? input.title;
      const run: Run = {
        id: `run-20260810-${slug}`,
        slug,
        title: input.title,
        prompt: input.prompt,
        channelId: input.channelId ?? null,
        requesterId: input.requesterId ?? null,
        taskRef: input.taskRef ?? null,
        ultracode: input.ultracode ?? false,
        cast: input.cast ?? null,
        repo: input.repo ?? null,
        state: "queued",
        createdAt: FAKE_NOW,
        updatedAt: FAKE_NOW,
        workspace: null,
        branch: `beckett/run-${slug}`,
        baseSha: null,
        sessionIds: {},
        sessionName: `beckett-run-${slug}`,
        reviewCycles: 0,
        prUrl: null,
        error: null,
        published: null,
      };
      created.push(run);
      return run;
    },
  };
  return {
    store,
    created,
    busPings,
    async notifyBus(cmd, args) {
      busPings.push({ cmd, args });
    },
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  };
}

// ── flag parsing ───────────────────────────────────────────────────────────────────────────

test("parseTaskDeployArgs: --prompt is required (or --prompt-file)", () => {
  expect(() => parseTaskDeployArgs([])).toThrow(TaskDeployUsageError);
});

test("parseTaskDeployArgs: title defaults to the first ~8 words of the prompt", () => {
  const input = parseTaskDeployArgs(["--prompt", "add oauth middleware to the gateway so requests carry a signed token please"]);
  expect(input.title).toBe("add oauth middleware to the gateway so requests");
  // The full kebab of the title is 49 chars; slugify caps at 40 and never leaves a dangling dash.
  expect(input.slug).toBe("add-oauth-middleware-to-the-gateway-so-r");
  expect(input.slug.length).toBeLessThanOrEqual(40);
});

test("parseTaskDeployArgs: --title overrides the derived one", () => {
  const input = parseTaskDeployArgs(["--prompt", "fix the thing", "--title", "Fix The Thing!!"]);
  expect(input.title).toBe("Fix The Thing!!");
  expect(input.slug).toBe("fix-the-thing");
});

test("parseTaskDeployArgs: --prompt-file reads the prompt from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-deploy-"));
  dirs.push(dir);
  const file = join(dir, "prompt.txt");
  writeFileSync(file, "  build the thing from a file  \n");
  const input = parseTaskDeployArgs(["--prompt-file", file]);
  expect(input.prompt).toBe("build the thing from a file");
});

test("parseTaskDeployArgs: --channel/--requester/--repo/--task/--ultracode round-trip", () => {
  const input = parseTaskDeployArgs([
    "--prompt", "ship it",
    "--channel", "chan-1",
    "--requester", "user-1",
    "--repo", "widgets",
    "--task", "12.1",
    "--ultracode",
  ]);
  expect(input.channelId).toBe("chan-1");
  expect(input.requesterId).toBe("user-1");
  expect(input.repo).toBe("widgets");
  expect(input.taskRef).toBe("#12.1");
  expect(input.ultracode).toBe(true);
});

test("parseTaskDeployArgs: --task already carrying a # is left alone", () => {
  const input = parseTaskDeployArgs(["--prompt", "x", "--task", "#12.1"]);
  expect(input.taskRef).toBe("#12.1");
});

test("parseTaskDeployArgs: without --ultracode/--channel/--requester/--repo/--task they default null/false", () => {
  const input = parseTaskDeployArgs(["--prompt", "x"]);
  expect(input.channelId).toBeNull();
  expect(input.requesterId).toBeNull();
  expect(input.repo).toBeNull();
  expect(input.taskRef).toBeNull();
  expect(input.ultracode).toBe(false);
  expect(input.cast).toBeNull();
});

// ── slug derivation ───────────────────────────────────────────────────────────────────────

test("slugify: kebab-cases, strips non [a-z0-9-], caps at 40 chars, no dangling dash", () => {
  expect(slugify("Add OAuth Middleware!")).toBe("add-oauth-middleware");
  const long = slugify("a".repeat(50));
  expect(long.length).toBeLessThanOrEqual(40);
  expect(long.endsWith("-")).toBe(false);
  expect(slugify("!!!")).toBe("run");
});

// ── cast validation ───────────────────────────────────────────────────────────────────────

test("parseTaskDeployArgs: a valid implement/review cast is accepted", () => {
  const input = parseTaskDeployArgs([
    "--prompt", "x",
    "--cast", JSON.stringify({ implement: { harness: "claude", effort: "high" }, review: { harness: "claude" } }),
  ]);
  expect(input.cast).toEqual({ implement: { harness: "claude", effort: "high" }, review: { harness: "claude" } });
});

test("parseTaskDeployArgs: an unknown cast stage (e.g. design) is rejected", () => {
  expect(() =>
    parseTaskDeployArgs(["--prompt", "x", "--cast", JSON.stringify({ design: { harness: "claude" } })]),
  ).toThrow(TaskDeployUsageError);
});

test("parseTaskDeployArgs: a hard-blocked model is rejected", () => {
  expect(() =>
    parseTaskDeployArgs(["--prompt", "x", "--cast", JSON.stringify({ implement: { harness: "pi", model: "sol" } })]),
  ).toThrow(TaskDeployUsageError);
});

test("parseTaskDeployArgs: garbage JSON in --cast is rejected, not silently degraded to {}", () => {
  expect(() => parseTaskDeployArgs(["--prompt", "x", "--cast", "{not json"])).toThrow(TaskDeployUsageError);
});

test("parseTaskDeployArgs: a typo'd harness in --cast is rejected, not silently dropped", () => {
  expect(() =>
    parseTaskDeployArgs(["--prompt", "x", "--cast", JSON.stringify({ implement: { harness: "clade" } })]),
  ).toThrow(TaskDeployUsageError);
});

test("parseTaskDeployArgs: an invalid effort in --cast is rejected, not silently dropped", () => {
  expect(() =>
    parseTaskDeployArgs(["--prompt", "x", "--cast", JSON.stringify({ implement: { harness: "codex", effort: "ultra" } })]),
  ).toThrow(TaskDeployUsageError);
});

// ── dry run ────────────────────────────────────────────────────────────────────────────────

test("deployRun: --dry prints the full Run JSON but writes nothing and pings no bus", async () => {
  const deps = fakeDeps();
  const result = await deployRun(
    ["--prompt", "add oauth middleware", "--channel", "chan-9", "--requester", "user-9", "--task", "12.1", "--dry"],
    deps,
  );
  // --dry's whole point is previewing the resolved title/slug/prompt/cast/taskRef before anything
  // is persisted — a wet deploy's narrow 5-field {runId, sessionName, branch, specPath, state}
  // summary would defeat that, so --dry returns the FULL Run object instead.
  expect(result).toEqual({
    id: "run-20260810-add-oauth-middleware",
    slug: "add-oauth-middleware",
    title: "add oauth middleware",
    prompt: "add oauth middleware",
    channelId: "chan-9",
    requesterId: "user-9",
    taskRef: "#12.1",
    ultracode: false,
    cast: null,
    repo: null,
    state: "queued",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    workspace: null,
    branch: "beckett/run-add-oauth-middleware",
    baseSha: null,
    sessionIds: {},
    sessionName: "beckett-run-add-oauth-middleware",
    reviewCycles: 0,
    prUrl: null,
    error: null,
    published: null,
  });
  expect(deps.created).toEqual([]);
  expect(deps.busPings).toEqual([]);
});

// ── real deploy: store write + bus ping ───────────────────────────────────────────────────

test("deployRun: creates the Run via the store and pings the bus exactly once", async () => {
  const deps = fakeDeps();
  const result = await deployRun(
    ["--prompt", "add oauth middleware", "--channel", "chan-9", "--requester", "user-9", "--task", "12.1"],
    deps,
  );
  expect(result).toEqual({
    runId: "run-20260810-add-oauth-middleware",
    sessionName: "beckett-run-add-oauth-middleware",
    branch: "beckett/run-add-oauth-middleware",
    specPath: null,
    state: "queued",
  });
  expect(deps.created).toHaveLength(1);
  const run = deps.created[0]!;
  expect(run).toMatchObject({
    id: "run-20260810-add-oauth-middleware",
    slug: "add-oauth-middleware",
    prompt: "add oauth middleware",
    channelId: "chan-9",
    requesterId: "user-9",
    taskRef: "#12.1",
    ultracode: false,
    cast: null,
    repo: null,
    state: "queued",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    workspace: null,
    baseSha: null,
    sessionIds: {},
    reviewCycles: 0,
    prUrl: null,
    error: null,
  });
  expect(deps.busPings).toEqual([
    { cmd: "run.deploy", args: { runId: "run-20260810-add-oauth-middleware", channelId: "chan-9" } },
  ]);
});

// The ordering `beckett task start` depends on: the bus ping ADMITS the run, and the supervisor's
// first event resolves its destination through the task→run link. A link written after the ping
// loses that race and routes the deploy receipt to the wrong channel.
test("deployRun: preNotify runs after the store write and BEFORE the bus ping", async () => {
  const deps = fakeDeps();
  const order: string[] = [];
  const notifyBus = deps.notifyBus;
  await deployRun(["--prompt", "add oauth middleware", "--task", "12.1"], {
    ...deps,
    async notifyBus(cmd, args) {
      order.push("ping");
      await notifyBus(cmd, args);
    },
    async preNotify(run) {
      order.push(`link:${run.id}`);
      expect(deps.created).toHaveLength(1); // the row is already durable
    },
  });
  expect(order).toEqual(["link:run-20260810-add-oauth-middleware", "ping"]);
});

test("deployRun: a preNotify failure stops the deploy before anything is admitted", async () => {
  const deps = fakeDeps();
  await expect(
    deployRun(["--prompt", "add oauth middleware", "--task", "12.1"], {
      ...deps,
      preNotify: async () => {
        throw new Error("branch #12.1 is already linked to another run");
      },
    }),
  ).rejects.toThrow(/already linked/);
  expect(deps.busPings).toEqual([]);
});

test("deployRun: a validation failure never reaches the store or the bus", async () => {
  const deps = fakeDeps();
  await expect(deployRun([], deps)).rejects.toThrow(TaskDeployUsageError);
  expect(deps.created).toEqual([]);
  expect(deps.busPings).toEqual([]);
});
