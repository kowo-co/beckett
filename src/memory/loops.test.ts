/** Open-loop ledger reads and state transitions stay in the canonical MemoryStore. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, type MemoryStore } from "./index.ts";
import { linkLoopTask, listLoops, noteLoop, openLoop, renderOpenLoopsBlock, resolveLinkedTasks, settleLoop } from "./loops.ts";
import { SELF_AUDIENCE } from "./search.ts";
import type { Logger } from "../types.ts";
import { TaskStore } from "../task/store.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): { memory: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-loops-"));
  dirs.push(dir);
  return { memory: createMemory({ memoryDir: dir, logger: quiet, git: false }), dir };
}

async function seed(memory: MemoryStore, name: string, due: string, kind = "commitment", extra: Record<string, unknown> = {}) {
  await memory.remember({
    op: "create",
    name,
    type: "loop",
    description: `I owe ${name}`,
    body: `Body for ${name}.`,
    metadata: {
      kind,
      status: "open",
      due,
      opened: "2026-07-01",
      source: `source for ${name}`,
      closes: `check ${name}`,
      ...extra,
    },
    source: "manual",
    reason: "test",
  });
}

test("lists valid visible open loops due-first and flags overdue without recall ranking", async () => {
  const { memory, dir } = store();
  await seed(memory, "later", "2026-08-03", "wishlist");
  await seed(memory, "late", "2026-07-01", "recurring-error");
  await seed(memory, "middle", "2026-07-20");
  // It is valid memory markdown but an invalid loop contract, so one bad file cannot poison reads.
  writeFileSync(join(dir, "loop", "bad-loop.md"), "---\nname: bad-loop\ndescription: >\n  broken loop\nmetadata:\n  type: loop\n  status: open\n---\n");

  const loops = listLoops(memory, { audience: SELF_AUDIENCE, today: "2026-07-20" });
  expect(loops.map((loop) => loop.node.name)).toEqual(["late", "middle", "later"]);
  expect(loops.map((loop) => loop.overdue)).toEqual([true, true, false]);
  expect(renderOpenLoopsBlock(memory)).toContain("[recurring-error]");
});

test("loop reads use recall's fail-closed visibility gate", async () => {
  const { memory } = store();
  await seed(memory, "public-loop", "2026-07-01");
  await seed(memory, "owner-loop", "2026-07-02", "commitment", { visibility: "owner" });
  await seed(memory, "dm-loop", "2026-07-03", "commitment", { visibility: "dm", dm_with: "881122334455667788" });

  expect(listLoops(memory).map((loop) => loop.node.name)).toEqual(["public-loop"]);
  expect(listLoops(memory, { audience: SELF_AUDIENCE }).map((loop) => loop.node.name)).toEqual([
    "public-loop", "owner-loop",
  ]);
  expect(renderOpenLoopsBlock(memory)).not.toContain("dm-loop");
});

test("loop block can include only recent closed SELF loops for event turns", async () => {
  const { memory } = store();
  await seed(memory, "open", "2026-08-01");
  await seed(memory, "just-closed", "2026-07-01", "commitment", { status: "done", closed: "2026-07-27" });
  await seed(memory, "week-old", "2026-07-02", "commitment", { status: "dropped", closed: "2026-07-20" });
  await seed(memory, "stale", "2026-07-03", "commitment", { status: "done", closed: "2026-07-19" });
  await seed(memory, "private-close", "2026-07-04", "commitment", {
    status: "done",
    closed: "2026-07-27",
    visibility: "dm",
    dm_with: "881122334455667788",
  });

  const block = renderOpenLoopsBlock(memory, undefined, { recentlyClosedDays: 7, today: "2026-07-27" });
  expect(block).toContain("I owe open");
  expect(block).toContain("CLOSED 2026-07-27 [commitment] I owe just-closed");
  expect(block).toContain("CLOSED 2026-07-20 [commitment] I owe week-old");
  expect(block).not.toContain("I owe stale");
  expect(block).not.toContain("I owe private-close");
});

test("close and drop round-trip through MemoryStore without losing body or unknown metadata", async () => {
  const { memory, dir } = store();
  await seed(memory, "close-me", "2026-07-01", "commitment", { watchdog: "still-here" });
  await seed(memory, "drop-me", "2026-07-02");

  const closed = await settleLoop(memory, "close-me", "done", "verified by ro", SELF_AUDIENCE);
  const dropped = await settleLoop(memory, "drop-me", "dropped", "ro released this", SELF_AUDIENCE);
  expect(closed.status).toBe("done");
  expect(dropped.status).toBe("dropped");
  expect(listLoops(memory, { all: true, audience: SELF_AUDIENCE }).map((loop) => loop.status)).toEqual([
    "done", "dropped",
  ]);

  const fresh = createMemory({ memoryDir: dir, logger: quiet, git: false });
  const closeNode = fresh.buildGraph().nodes.get("close-me")!;
  const dropNode = fresh.buildGraph().nodes.get("drop-me")!;
  expect(closeNode.metadata.status).toBe("done");
  expect(closeNode.metadata.closed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(closeNode.metadata.watchdog).toBe("still-here");
  expect(closeNode.body).toContain("Body for close-me.");
  expect(closeNode.body).toContain("verified by ro");
  expect(dropNode.metadata.status).toBe("dropped");
  expect(dropNode.metadata.closed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(dropNode.body).toContain("ro released this");
  expect(readFileSync(closeNode.path, "utf8")).toContain("watchdog: still-here");
});

test("noting a loop appends a dated note and stamps lastTouched without changing status", async () => {
  const { memory, dir } = store();
  await seed(memory, "note-me", "2026-08-01", "commitment", { watchdog: "keep-me", visibility: "owner" });

  const before = listLoops(memory, { all: true, audience: SELF_AUDIENCE });
  expect(before[0]!.lastTouched).toBeNull();

  const noted = await noteLoop(memory, "note-me", "made real progress on the adoption", SELF_AUDIENCE);
  expect(noted.status).toBe("open");
  expect(noted.lastTouched).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  const fresh = createMemory({ memoryDir: dir, logger: quiet, git: false });
  const node = fresh.buildGraph().nodes.get("note-me")!;
  expect(node.metadata.status).toBe("open");
  expect(node.metadata.lastTouched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(node.metadata.watchdog).toBe("keep-me");
  // A note must never widen visibility.
  expect(node.metadata.visibility).toBe("owner");
  expect(node.body).toContain("Body for note-me.");
  expect(node.body).toMatch(/\*\*Note \(\d{4}-\d{2}-\d{2}\):\*\* made real progress on the adoption/);

  // A second note stacks under the first and re-stamps.
  await noteLoop(memory, "note-me", "still not done", SELF_AUDIENCE);
  const twice = createMemory({ memoryDir: dir, logger: quiet, git: false }).buildGraph().nodes.get("note-me")!;
  expect(twice.body).toContain("made real progress on the adoption");
  expect(twice.body).toContain("still not done");
});

test("noting rejects unknown/non-open loops and blank notes in settleLoop's error style", async () => {
  const { memory } = store();
  await seed(memory, "live", "2026-08-01");
  await settleLoop(memory, "live", "done", undefined, SELF_AUDIENCE);
  await seed(memory, "still-open", "2026-08-02");

  expect(noteLoop(memory, "ghost", "x", SELF_AUDIENCE)).rejects.toThrow("no visible open loop named 'ghost'");
  expect(noteLoop(memory, "live", "x", SELF_AUDIENCE)).rejects.toThrow("no visible open loop named 'live'");
  expect(noteLoop(memory, "still-open", "   ", SELF_AUDIENCE)).rejects.toThrow("--note is required to note a loop");
});

test("loops opened before lastTouched existed parse and read as never touched", async () => {
  const { memory, dir } = store();
  await seed(memory, "modern", "2026-08-15"); // creates the loop/ dir
  // A pre-note loop file with no lastTouched key at all.
  writeFileSync(
    join(dir, "loop", "legacy.md"),
    "---\nname: legacy\ndescription: an old loop\nmetadata:\n  type: loop\n  kind: commitment\n  status: open\n  due: 2026-09-01\n  opened: 2026-06-01\n  source: manual\n  closes: check it\n---\nlegacy body\n",
  );
  const loops = listLoops(memory, { audience: SELF_AUDIENCE });
  expect(loops.map((l) => l.node.name)).toContain("legacy");
  expect(loops.find((l) => l.node.name === "legacy")!.lastTouched).toBeNull();
});

test("linking stamps a deduped task ref and resolves its live status without caching it on the node", async () => {
  const { memory, dir } = store();
  await seed(memory, "external-pr-has-no-watcher", "2026-08-01");
  const tasks = new TaskStore(join(dir, "tasks.json"));
  const { task } = await tasks.createTask({ title: "Watch every PR I open" });

  const linked = await linkLoopTask(memory, "external-pr-has-no-watcher", `#${task.number}`, SELF_AUDIENCE);
  expect(linked.linkedTasks).toEqual([`#${task.number}`]);
  // Re-linking the same ref is a no-op, not a duplicate entry.
  const again = await linkLoopTask(memory, "external-pr-has-no-watcher", `${task.number}.1`, SELF_AUDIENCE);
  expect(again.linkedTasks.sort()).toEqual([`#${task.number}`, `#${task.number}.1`].sort());

  const resolved = resolveLinkedTasks(tasks, again);
  expect(resolved).toContainEqual({ ref: `#${task.number}`, status: "active" });
  expect(resolved).toContainEqual({ ref: `#${task.number}.1`, status: "ready" });

  // Status resolves live, never from a cached copy: move the branch and the SAME loop entry (not
  // re-read from the loop node, whose linkedTasks never change) reports the new status.
  await tasks.linkRun(`${task.number}.1`, { runId: "run-20260810-loop" }, "cancelled");
  expect(resolveLinkedTasks(tasks, again)).toContainEqual({ ref: `#${task.number}.1`, status: "cancelled" });
});

test("linked task refs surface in the session-start block with an explicit check-before-filing instruction", async () => {
  const { memory, dir } = store();
  await seed(memory, "external-pr-has-no-watcher", "2026-08-01");
  const tasks = new TaskStore(join(dir, "tasks.json"));
  const { task } = await tasks.createTask({ title: "Watch every PR I open" });
  await linkLoopTask(memory, "external-pr-has-no-watcher", `#${task.number}`);

  const block = renderOpenLoopsBlock(memory, tasks);
  expect(block).toContain("check its");
  expect(block).toContain(`already filed: #${task.number} (active)`);

  // Without a wired TaskStore the block still renders (no crash), just without the status suffix.
  const bare = renderOpenLoopsBlock(memory);
  expect(bare).not.toContain(`#${task.number}`);
});

test("linking rejects an unknown loop and a malformed ref", async () => {
  const { memory } = store();
  await seed(memory, "real-loop", "2026-08-01");

  expect(linkLoopTask(memory, "ghost-loop", "#1")).rejects.toThrow("no visible loop named 'ghost-loop'");
  expect(linkLoopTask(memory, "real-loop", "not-a-ref")).rejects.toThrow('invalid task reference "not-a-ref"');
});

test("loops predating linkedTasks parse with an empty list", async () => {
  const { memory, dir } = store();
  await seed(memory, "modern", "2026-08-15");
  writeFileSync(
    join(dir, "loop", "legacy-no-links.md"),
    "---\nname: legacy-no-links\ndescription: an old loop\nmetadata:\n  type: loop\n  kind: commitment\n  status: open\n  due: 2026-09-01\n  opened: 2026-06-01\n  source: manual\n  closes: check it\n---\nbody\n",
  );
  const loop = listLoops(memory, { audience: SELF_AUDIENCE }).find((l) => l.node.name === "legacy-no-links")!;
  expect(loop.linkedTasks).toEqual([]);
});

test("opening a loop creates the conventional loop file and an empty ledger renders nothing", async () => {
  const { memory, dir } = store();
  expect(renderOpenLoopsBlock(memory)).toBe("");
  const opened = await openLoop(memory, {
    name: "new-loop",
    kind: "commitment",
    due: "2026-08-01",
    source: "self",
    description: "I said I'd add the ledger",
  });
  expect(opened.node.path).toBe(join(dir, "loop", "new-loop.md"));
  const raw = readFileSync(opened.node.path, "utf8");
  expect(raw).toContain("type: loop");
  expect(raw).toContain("status: open");
  expect(raw).toContain("closes:");
});
