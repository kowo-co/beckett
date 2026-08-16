import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBus } from "../shell/control-bus.ts";
import { RunStore } from "../run/store.ts";
import type { BusRequest } from "../shell/control-bus.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function cli(dir: string, args: string[], env: Record<string, string> = {}): Promise<unknown> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "beckett.ts"), ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, BECKETT_DIR: dir, BECKETT_HOME: dir, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`CLI failed (${code}): ${stderr || stdout}`);
  return JSON.parse(stdout);
}

test("task create, branch, show, and list share one durable public namespace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-cli-"));
  dirs.push(dir);

  const created = await cli(dir, [
    "task", "create",
    "--title", "Voting launch",
    "--branch-title", "Votes schema",
    "--project", "polls",
  ]) as any;
  expect(created).toMatchObject({
    task: { ref: "#1", displayName: "#1 - Voting launch", project: "polls" },
    branch: { ref: "#1.1", title: "Votes schema", status: "ready" },
  });

  const branch = await cli(dir, [
    "task", "branch", "#1",
    "--title", "Voting API",
    "--needs", "#1.1",
  ]) as any;
  expect(branch).toMatchObject({
    taskRef: "#1",
    branch: { ref: "#1.2", needs: ["1.1"], status: "waiting" },
  });

  const shown = await cli(dir, ["task", "show", "#1.2"]) as any;
  expect(shown).toMatchObject({
    task: { ref: "#1", title: "Voting launch" },
    branch: { ref: "#1.2", title: "Voting API" },
  });

  const listed = await cli(dir, ["task", "list"]) as any[];
  expect(listed).toEqual([
    expect.objectContaining({
      ref: "#1",
      displayName: "#1 - Voting launch",
      branches: [
        expect.objectContaining({ ref: "#1.1", title: "Votes schema" }),
        expect.objectContaining({ ref: "#1.2", title: "Voting API" }),
      ],
    }),
  ]);
});

test("task start deploys a run for the branch and links the branch to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-cli-start-"));
  dirs.push(dir);

  await cli(dir, ["task", "create", "--title", "Voting launch", "--project", "polls"]);
  const started = await cli(dir, [
    "task", "start", "#1.1",
    "--body", "Build it",
    "--criteria", "works;tested",
    "--cast", '{"implement":{"harness":"pi","effort":"medium"}}',
  ]) as any;

  expect(started).toMatchObject({
    taskRef: "#1",
    branchRef: "#1.1",
    state: "queued",
    branch: "beckett/run-voting-launch",
  });
  expect(String(started.runId)).toMatch(/^run-\d{8}-voting-launch$/);

  // The run carries the whole brief — body + criteria — and the branch it was started for.
  const run = JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")).runs[0];
  expect(run.prompt).toBe("Build it\n\nAcceptance criteria:\n- works\n- tested");
  expect(run.taskRef).toBe("#1.1");
  expect(run.repo).toBe("polls");
  expect(run.cast).toEqual({ implement: { harness: "pi", effort: "medium" } });

  const shown = await cli(dir, ["task", "show", "#1.1"]) as any;
  expect(shown.branch).toMatchObject({ ref: "#1.1", status: "ready", run: { runId: started.runId } });
});

test("task start does not launder a bare --cast-quote flag into a stamped human quote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-cli-bare-quote-"));
  dirs.push(dir);
  await cli(dir, ["task", "create", "--title", "Voting launch", "--project", "polls"]);
  // A bare trailing --cast-quote (no value) is parsed as boolean `true` by io.ts; core.ts must
  // not forward that through as the literal string "true" and have it stamped as a quote.
  await cli(dir, [
    "task", "start", "#1.1",
    "--body", "Build it",
    "--cast", '{"implement":{"harness":"claude","model":"claude-opus-5"}}',
    "--cast-quote",
  ]);

  const run = JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")).runs[0];
  expect(run.cast?.implement?.reason).toBeUndefined();
});

test("task start refuses a cast naming a stage a run does not have", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-cli-badcast-"));
  dirs.push(dir);
  await cli(dir, ["task", "create", "--title", "Voting launch"]);
  await expect(
    cli(dir, ["task", "start", "#1.1", "--cast", '{"design":{"harness":"claude"}}']),
  ).rejects.toThrow(/a run only casts implement\|review/);
});

/**
 * Read the raw registry. `task list` is a deliberately curated public projection and does not carry
 * `waveId` — the wave is routing plumbing behind `&recent`, never something a person is shown.
 */
function wavesOf(dir: string): string[] {
  const raw = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as { tasks: Array<{ waveId?: string }> };
  return raw.tasks.map((t) => t.waveId ?? "");
}

test("an explicit --wave label groups tasks the clock and channel would have split", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-wave-"));
  dirs.push(dir);

  // Same label across DIFFERENT channels — the grouping the fallback inference cannot express.
  // Pinning has to win over it, or `&recent` can never pull a cross-channel wave into one thread.
  await cli(dir, ["task", "create", "--title", "Launch copy", "--channel", "111", "--wave", "launch"]);
  await cli(dir, ["task", "create", "--title", "Launch art", "--channel", "222", "--wave", "launch"]);

  expect(wavesOf(dir)).toEqual(["launch", "launch"]);
});

test("without a label, two channels never share a wave", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-wave-split-"));
  dirs.push(dir);

  await cli(dir, ["task", "create", "--title", "Media ask", "--channel", "111"]);
  await cli(dir, ["task", "create", "--title", "Dev ask", "--channel", "222"]);

  const waves = wavesOf(dir);
  expect(waves).toHaveLength(2);
  expect(waves[0]).not.toBe(waves[1]);
});

test("without a label, back-to-back filings in ONE channel do share a wave", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-wave-join-"));
  dirs.push(dir);

  await cli(dir, ["task", "create", "--title", "Schema", "--channel", "111"]);
  await cli(dir, ["task", "create", "--title", "API", "--channel", "111"]);

  const waves = wavesOf(dir);
  expect(waves[0]).toBe(waves[1]!);
  expect(waves[0]).not.toBe("");
});

// ── --ping (issue #10) ─────────────────────────────────────────────────────────────────────
const RO = "1151230208783945818";
const ALICE = "222222222222222222";

function seedIdentities(dir: string): void {
  writeFileSync(
    join(dir, "identities.json"),
    JSON.stringify({
      [RO]: { known_name: "ro", created_at: 1, updated_at: 1 },
      [ALICE]: { known_name: "alice", created_at: 1, updated_at: 1 },
    }),
  );
}

test("task create --ping resolves and persists the task-level default ping list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-ping-create-"));
  dirs.push(dir);
  seedIdentities(dir);

  const created = await cli(dir, ["task", "create", "--title", "Voting launch", "--ping", "ro", "--ping", ALICE]) as any;
  expect(created.task.pings).toEqual([RO, ALICE]);
  // The branch inherits — it never got its own override at create time.
  expect(created.branch.pings).toBeUndefined();

  const shown = await cli(dir, ["task", "show", "#1"]) as any;
  expect(shown.pings).toEqual([RO, ALICE]);
});

test("task create --ping fails clearly on an unknown target, naming it and the known names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-ping-unknown-"));
  dirs.push(dir);
  seedIdentities(dir);

  await expect(cli(dir, ["task", "create", "--title", "Voting launch", "--ping", "nobody"])).rejects.toThrow(
    /unknown --ping target: nobody.*known names: alice, ro/s,
  );
});

test("task start --ping overrides the branch's pings independent of the task-level default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-ping-start-"));
  dirs.push(dir);
  seedIdentities(dir);

  await cli(dir, ["task", "create", "--title", "Voting launch", "--ping", "ro"]);
  await cli(dir, ["task", "start", "#1.1", "--body", "Build it", "--ping", "alice"]);

  const shown = await cli(dir, ["task", "show", "#1.1"]) as any;
  expect(shown.task.pings).toEqual([RO]);
  expect(shown.branch.pings).toEqual([ALICE]);
});

// ── resume (overhaul B5) ─────────────────────────────────────────────────────────────────────

test("task resume pings run.resume with the run id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-resume-"));
  dirs.push(dir);
  const store = new RunStore(join(dir, "runs.json"));
  const run = await store.create({ title: "Add oauth", prompt: "…" });
  await store.update(run.id, { state: "parked" });

  const requests: BusRequest[] = [];
  const stop = serveBus(join(dir, "control.sock"), (req) => {
    requests.push(req);
    return { ok: true, data: { runId: req.args.runId, resumed: true } };
  });
  try {
    const result = (await cli(dir, ["task", "resume", run.id, "--note", "try again"])) as any;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.cmd).toBe("run.resume");
    expect(requests[0]!.args.runId).toBe(run.id);
    expect(requests[0]!.args.note).toBe("try again");
    expect(result).toEqual({ runId: run.id, resumed: true });
  } finally {
    stop();
  }
});

test("task steer on a parked run resumes it instead of failing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-steer-parked-"));
  dirs.push(dir);
  const store = new RunStore(join(dir, "runs.json"));
  const run = await store.create({ title: "Add oauth", prompt: "…" });
  await store.update(run.id, { state: "parked" });

  const requests: BusRequest[] = [];
  const stop = serveBus(join(dir, "control.sock"), (req) => {
    requests.push(req);
    return { ok: true, data: { runId: req.args.runId, resumed: true } };
  });
  try {
    await cli(dir, ["task", "steer", run.id, "get past the credential"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.cmd).toBe("run.resume");
    expect(requests[0]!.args.note).toBe("get past the credential");
  } finally {
    stop();
  }
});

test("task steer on a done run still fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-task-steer-done-"));
  dirs.push(dir);
  const store = new RunStore(join(dir, "runs.json"));
  const run = await store.create({ title: "Add oauth", prompt: "…" });
  await store.update(run.id, { state: "done" });

  await expect(cli(dir, ["task", "steer", run.id, "one more thing"])).rejects.toThrow(
    /is done — steering only reaches a run that is still going/,
  );
});
