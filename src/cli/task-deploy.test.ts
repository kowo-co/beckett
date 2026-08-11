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

/** A fake `RunStore` + fake bus, mirroring how `task-start.test.ts` fakes the tracker client. */
function fakeDeps(): TaskDeployDeps & { created: Run[]; busPings: Array<{ cmd: string; args: Record<string, unknown> }> } {
  const created: Run[] = [];
  const busPings: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const store: RunStoreLike = {
    async create(run) {
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

// ── dry run ────────────────────────────────────────────────────────────────────────────────

test("deployRun: --dry builds the Run JSON but writes nothing and pings no bus", async () => {
  const deps = fakeDeps();
  const result = await deployRun(["--prompt", "add oauth middleware", "--dry"], deps);
  expect(result).toEqual({
    runId: "run-20260810-add-oauth-middleware",
    sessionName: "beckett-run-add-oauth-middleware",
    branch: "beckett/run-add-oauth-middleware",
    specPath: null,
    state: "queued",
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

test("deployRun: a validation failure never reaches the store or the bus", async () => {
  const deps = fakeDeps();
  await expect(deployRun([], deps)).rejects.toThrow(TaskDeployUsageError);
  expect(deps.created).toEqual([]);
  expect(deps.busPings).toEqual([]);
});
