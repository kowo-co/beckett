import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, displayTaskName, effectivePings, newWaveId } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { path: string; store: TaskStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-tasks-"));
  dirs.push(dir);
  const path = join(dir, "tasks.json");
  return { path, store: new TaskStore(path) };
}

/**
 * A store on a hand-cranked clock. Wave grouping is a function of the gap between filings, so the
 * tests have to own that gap: a real clock would make "back to back" and "much later" the same
 * sub-millisecond instant and prove nothing either way.
 */
function makeClockStore(): { path: string; store: TaskStore; advance: (ms: number) => void } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-tasks-"));
  dirs.push(dir);
  const path = join(dir, "tasks.json");
  let clock = Date.parse("2026-07-25T09:00:00.000Z");
  const store = new TaskStore(path, { now: () => new Date(clock) });
  return { path, store, advance: (ms: number) => { clock += ms; } };
}

test("creates durable sequential tasks with a numbered initial branch", async () => {
  const { path, store: first } = makeStore();
  const one = await first.createTask({ title: "  Voting   launch ", originChannelId: "c1" });
  const two = await first.createTask({ title: "Uploads" });

  expect(displayTaskName(one.task)).toBe("#1 - Voting launch");
  expect(one.branch.ref).toBe("1.1");
  expect(two.task.number).toBe(2);
  expect(new TaskStore(path).getTask("#1")?.originChannelId).toBe("c1");
  expect(JSON.parse(readFileSync(path, "utf8")).nextTaskNumber).toBe(3);
});

test("creates sibling and nested branches with validated dependencies", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting" });
  const api = await store.createBranch({ task: 1, title: "API", needs: ["1.1"] });
  const route = await store.createBranch({ task: 1, parentRef: api.ref, title: "Route" });

  expect(api).toMatchObject({ ref: "1.2", status: "waiting", needs: ["1.1"] });
  expect(route).toMatchObject({ ref: "1.2.1", parentRef: "1.2" });
  await expect(store.createBranch({ task: 1, title: "Bad", needs: ["9.1"] })).rejects.toThrow("no such dependency");
});

test("concurrent creators receive unique task numbers", async () => {
  const { path } = makeStore();
  const stores = Array.from({ length: 8 }, () => new TaskStore(path));
  const created = await Promise.all(stores.map((taskStore, index) => taskStore.createTask({ title: `Task ${index}` })));
  expect(created.map((row) => row.task.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("links the executing run while keeping the public branch reference stable", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting", project: "polls" });
  const linked = await store.linkRun("#1.1", { runId: "run-20260810-voting" }, "implementing", "polls");
  expect(linked).toMatchObject({ ref: "1.1", status: "running", run: { runId: "run-20260810-voting" } });
  expect(store.findByRun("run-20260810-voting")?.branch.ref).toBe("1.1");
});

test("a second, DIFFERENT run on one branch is refused; re-linking the same run is idempotent", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting" });
  await store.linkRun("1.1", { runId: "run-a" }, "implementing");
  expect((await store.linkRun("1.1", { runId: "run-a" }, "reviewing")).status).toBe("review");
  await expect(store.linkRun("1.1", { runId: "run-b" }, "implementing")).rejects.toThrow(/already linked to run run-a/);
});

test("a pre-v7 registry with tracker links still loads; the dead links are dropped", () => {
  const { path, store } = makeStore();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      nextTaskNumber: 2,
      startClaims: {},
      tasks: [{
        id: "t", number: 1, title: "Legacy", status: "active", createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        branches: [{
          id: "b", ref: "1.1", path: [1], title: "Legacy", status: "review", needs: [],
          ticket: { id: "uuid", identifier: "OPS-143", board: "ops", projectId: "p1", url: "https://tracker.test/OPS-143" },
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      }],
    }),
    "utf8",
  );
  const branch = store.getBranch("1.1")!.branch;
  // The branch survives with its last known status; the tracker link is gone, and no run took
  // its place (a run id cannot be derived from a ticket id).
  expect(branch.status).toBe("review");
  expect(branch.run).toBeUndefined();
  expect(branch).not.toHaveProperty("ticket");
});

test("a corrupt registry fails loudly instead of resetting task numbers", () => {
  const { path, store } = makeStore();
  writeFileSync(path, "{not-json", "utf8");
  expect(() => store.list()).toThrow("task registry");
});

test("start claims serialize the tracker create gap and clear after linking", async () => {
  const { path, store } = makeStore();
  await store.createTask({ title: "Voting" });
  const token = await store.reserveStart("1.1");
  await expect(new TaskStore(path).reserveStart("1.1")).rejects.toThrow("already being started");
  await store.releaseStart("1.1", "wrong-token");
  await expect(new TaskStore(path).reserveStart("1.1")).rejects.toThrow("already being started");
  await store.releaseStart("1.1", token);
  expect(typeof await store.reserveStart("1.1")).toBe("string");
});

test("records direct publication independently from pull-request metadata", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting" });
  await store.setPublication("1.1", {
    repo: "0xbeckett/voting",
    url: "https://github.com/0xbeckett/voting",
    kind: "pushed",
  });
  expect(store.getBranch("1.1")?.branch.publication).toEqual({
    repo: "0xbeckett/voting",
    url: "https://github.com/0xbeckett/voting",
    kind: "pushed",
  });
});

test("a caller-supplied wave id groups a whole batch behind &recent", async () => {
  const { store } = makeStore();
  const wave = newWaveId();
  await store.createTask({ title: "Schema" });
  await store.createTask({ title: "API", waveId: wave });
  await store.createTask({ title: "Route", waveId: wave });
  await store.createTask({ title: "Docs", waveId: wave });

  expect(store.recentWave().map((task) => task.number)).toEqual([2, 3, 4]);
  expect(new Set(store.recentWave().map((task) => task.waveId))).toEqual(new Set([wave]));
});

test("tasks filed back to back are one wave, which is the whole point of &recent", async () => {
  const { store, advance } = makeClockStore();
  // The concierge shells out once per task, so a wave arrives as separate processes a few hundred
  // milliseconds apart. Nobody passes a waveId; the store has to infer the batch from that.
  await store.createTask({ title: "Schema" });
  advance(400);
  await store.createTask({ title: "API" });
  advance(900);
  await store.createTask({ title: "Docs" });

  expect(store.recentWave().map((task) => task.number)).toEqual([1, 2, 3]);
  expect(new Set(store.recentWave().map((task) => task.waveId)).size).toBe(1);
});

test("a wave never spans channels, however close together the filings land", async () => {
  const { store, advance } = makeClockStore();
  // Two people asking for unrelated things in two rooms in the same breath. Co-filing time alone
  // used to fuse them into one wave, so `&recent` in the #dev thread attached the #media task too —
  // work reporting into a room whose members never asked for it.
  await store.createTask({ title: "Transcode uploads", originChannelId: "media" });
  advance(400);
  await store.createTask({ title: "Fix the build", originChannelId: "dev" });

  const [media, dev] = store.list();
  expect(media?.waveId).toBeTruthy();
  expect(dev?.waveId).not.toBe(media?.waveId as string);
  // `&recent` in either room gets the newest wave, and that wave is one task — not both.
  expect(store.recentWave().map((task) => task.number)).toEqual([2]);

  // A third filing in the ORIGINAL channel chains off that channel's task, not the newest overall.
  advance(400);
  await store.createTask({ title: "Thumbnails", originChannelId: "media" });
  expect(store.getTask(3)?.waveId).toBe(media?.waveId as string);
  expect(store.recentWave().map((task) => task.number)).toEqual([1, 3]);
});

test("a task filed well after the previous one starts a fresh wave", async () => {
  const { store, advance } = makeClockStore();
  await store.createTask({ title: "Schema" });
  advance(500);
  await store.createTask({ title: "API" });
  // A person filing, thinking, then filing something unrelated. Nothing to do with the batch.
  advance(5 * 60_000);
  await store.createTask({ title: "Unrelated bug" });

  const recent = store.recentWave();
  expect(recent.map((task) => task.number)).toEqual([3]);
  const [one, two, three] = store.list();
  expect(one?.waveId).toBe(two?.waveId as string);
  expect(three?.waveId).not.toBe(one?.waveId as string);
});

test("an explicit wave id overrides the inferred grouping", async () => {
  const { store, advance } = makeClockStore();
  const wave = newWaveId();
  // #1 lands inside the window of nothing, so it opens its own wave; #2 is filed just as close but
  // names its wave, and that must win. #3 then chains off #2, the newest task.
  await store.createTask({ title: "Schema" });
  advance(200);
  await store.createTask({ title: "API", waveId: wave });
  advance(200);
  await store.createTask({ title: "Docs" });

  const [one, two, three] = store.list();
  expect(two?.waveId).toBe(wave);
  expect(one?.waveId).not.toBe(wave);
  expect(three?.waveId).toBe(wave);
  expect(store.recentWave().map((task) => task.number)).toEqual([2, 3]);
});

test("a new task never joins a pre-wave row from an older registry", async () => {
  const { path, store } = makeStore();
  await store.createTask({ title: "Legacy" });
  const registry = JSON.parse(readFileSync(path, "utf8"));
  for (const task of registry.tasks) delete task.waveId;
  writeFileSync(path, JSON.stringify(registry), "utf8");

  // Grouping onto an absent id would leave #2 outside every wave lookup, so it opens its own.
  const fresh = new TaskStore(path);
  await fresh.createTask({ title: "Modern" });
  expect(fresh.getTask(2)?.waveId).toBeTruthy();
  expect(fresh.recentWave().map((task) => task.number)).toEqual([2]);
});

test("a lone task is a wave of one, and a finished wave is still the recent one", async () => {
  const { store, advance } = makeClockStore();
  const wave = newWaveId();
  await store.createTask({ title: "API", waveId: wave });
  // Filed long after, so #2 is genuinely its own wave rather than a continuation of #1's.
  advance(10 * 60_000);
  await store.createTask({ title: "Hotfix" });
  // Status-blind: completing the newest wave must not hand &recent back to the older batch.
  await store.linkRun("2.1", { runId: "run-20260810-hotfix" }, "done");

  const recent = store.recentWave();
  expect(recent.map((task) => task.number)).toEqual([2]);
  expect(recent[0]?.status).toBe("done");
  expect(recent[0]?.waveId).not.toBe(wave);
});

test("a pre-wave task loaded from an older registry is its own wave", async () => {
  const { path, store } = makeStore();
  await store.createTask({ title: "Legacy" });
  await store.createTask({ title: "Also legacy" });
  const registry = JSON.parse(readFileSync(path, "utf8"));
  for (const task of registry.tasks) delete task.waveId;
  writeFileSync(path, JSON.stringify(registry), "utf8");

  const recent = new TaskStore(path).recentWave();
  expect(recent.map((task) => task.number)).toEqual([2]);
  expect(recent[0]?.waveId).toBeUndefined();
});

test("recentWave on an empty registry is empty, not an error", () => {
  const { store } = makeStore();
  expect(store.recentWave()).toEqual([]);
});

test("resolves every spelling of a task or branch reference", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting" });
  await store.createBranch({ task: 1, title: "API" });

  expect(store.resolveTaskRef("#1")?.task.number).toBe(1);
  expect(store.resolveTaskRef("1")?.task.number).toBe(1);
  expect(store.resolveTaskRef("#1")?.branch).toBeUndefined();
  expect(store.resolveTaskRef(" #1.2 ")?.branch?.ref).toBe("1.2");
  expect(store.resolveTaskRef("1.2")).toMatchObject({ task: { number: 1 }, branch: { title: "API" } });
});

test("unresolvable references return null instead of throwing", async () => {
  const { store } = makeStore();
  await store.createTask({ title: "Voting" });

  expect(store.resolveTaskRef("1.7")).toBeNull(); // well-formed, branch does not exist
  expect(store.resolveTaskRef("#9")).toBeNull();
  expect(store.resolveTaskRef("9.1")).toBeNull();
  expect(store.resolveTaskRef("recent")).toBeNull();
  expect(store.resolveTaskRef("")).toBeNull();
  expect(store.resolveTaskRef("1.")).toBeNull();
});

test("resuming implementation clears the previous final diff snapshot", async () => {
  const { store } = makeStore();
  const link = { runId: "run-20260810-voting" };
  await store.createTask({ title: "Voting" });
  await store.linkRun("1.1", link, "reviewing");
  await store.setDiff("1.1", { additions: 4, deletions: 1, files: 2, commits: 1 });

  await store.linkRun("1.1", link, "implementing");

  expect(store.getBranch("1.1")?.branch.diff).toBeUndefined();
});

test("persists the task card id + channel and survives a reload", async () => {
  const { path, store } = makeStore();
  await store.createTask({ title: "Carded", originChannelId: "c1" });
  await store.setCard(1, { channelId: "c1", messageId: "m-1" });

  const reloaded = new TaskStore(path).getTask(1);
  expect(reloaded?.card?.channelId).toBe("c1");
  expect(reloaded?.card?.messageId).toBe("m-1");
  expect(reloaded?.card?.updatedAt).toBeTruthy();

  // Reposting a deleted card overwrites the id in place.
  await store.setCard(1, { channelId: "c1", messageId: "m-2" });
  expect(new TaskStore(path).getTask(1)?.card?.messageId).toBe("m-2");
});

test("a pre-card registry still parses (the card field is optional)", () => {
  const { path, store } = makeStore();
  writeFileSync(path, JSON.stringify({
    version: 1,
    nextTaskNumber: 2,
    tasks: [{
      id: "t1", number: 1, title: "Legacy", status: "active",
      branches: [{ id: "b1", ref: "1.1", path: [1], title: "Main", status: "ready", needs: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    startClaims: {},
  }));
  expect(store.getTask(1)?.card).toBeUndefined();
  expect(store.getTask(1)?.title).toBe("Legacy");
});

test("branch card images dedupe by URL, cap at ten, and survive a reload", async () => {
  const { path, store } = makeStore();
  await store.createTask({ title: "Shots", originChannelId: "c1" });

  await store.addBranchImage("1.1", { url: "https://cdn.example.com/a.png", description: "OPS-1" });
  // A retried upload of the same URL never doubles the entry.
  await store.addBranchImage("1.1", { url: "https://cdn.example.com/a.png", description: "OPS-1" });
  for (let i = 0; i < 9; i++) {
    await store.addBranchImage("1.1", { url: `https://cdn.example.com/${i}.png` });
  }

  let branch = new TaskStore(path).getTask(1)?.branches[0];
  expect(branch?.images).toHaveLength(10);
  expect(branch?.images?.filter((img) => img.url === "https://cdn.example.com/a.png")).toHaveLength(1);

  // The cap keeps the most recent: one more upload pushes the oldest (a.png) off the reel.
  await store.addBranchImage("1.1", { url: "https://cdn.example.com/9.png" });
  branch = new TaskStore(path).getTask(1)?.branches[0];
  expect(branch?.images).toHaveLength(10);
  expect(branch?.images?.some((img) => img.url === "https://cdn.example.com/a.png")).toBe(false);
  expect(branch?.images?.at(-1)?.url).toBe("https://cdn.example.com/9.png");
});

test("createTask persists a `pings` default; setPings overrides it per branch (issue #10)", async () => {
  const { path, store } = makeStore();
  const RO = "1151230208783945818";
  const ALICE = "222222222222222222";
  const { task, branch } = await store.createTask({ title: "Voting launch", pings: [RO] });
  expect(task.pings).toEqual([RO]);
  // No override yet — the branch inherits the task's default.
  expect(effectivePings(task, branch)).toEqual([RO]);

  const overridden = await store.setPings(branch.ref, [ALICE]);
  expect(overridden.pings).toEqual([ALICE]);
  const reloadedTask = new TaskStore(path).getTask(1)!;
  expect(effectivePings(reloadedTask, reloadedTask.branches[0]!)).toEqual([ALICE]);
  // The task-level default is untouched by a branch override.
  expect(reloadedTask.pings).toEqual([RO]);
});

test("a task created with no `--ping` has no pings field, and effectivePings degrades to empty", async () => {
  const { store } = makeStore();
  const { task, branch } = await store.createTask({ title: "Voting launch" });
  expect(task.pings).toBeUndefined();
  expect(effectivePings(task, branch)).toEqual([]);
});
