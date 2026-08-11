/**
 * Coverage for the workspace registry: user-opened threads become work workspaces. No Discord
 * side-effects live here — the registry is pure routing state fed by the gateway's thread-create
 * event, grounded ONLY by explicit `&<taskRef>` / `&recent` attachments and by tickets filed from
 * inside the thread, and persisted so unmentioned routing survives a daemon restart.
 *
 * The security invariant that outranks all the others: **a thread NAME binds nothing.** The name is
 * chosen by whoever opened the thread and is never validated against who may see the work, so
 * scraping "OPS-120"/"#12" out of it turned `channelForTask`/`channelForTicket` — which route real
 * milestones, PR events and filed receipts — into an attacker-controlled routing table. The name is
 * a human label; only a deliberate act by an authorized person attaches work.
 *
 * The routing invariants worth breaking a build over: attachment is ADDITIVE within a thread (a
 * second wave never drops the first) but EXCLUSIVE across threads (a ref routes to exactly one
 * workspace, and `&ref` moves it there even when the target already holds it), a legacy scalar
 * `taskRef` on disk MIGRATES rather than vanishing, and neither `&ref` nor registering a task
 * thread ever STEALS a whole workspace out from under the person who opened it — only the one ref
 * moves.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry } from "./workspaces.ts";
import type { Logger } from "../types.ts";

const quietLog = (() => {
  const l = { debug() {}, info() {}, warn() {}, error() {}, child: () => l } as unknown as Logger;
  return l;
})();

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-workspaces-"));
  tmpDirs.push(dir);
  return join(dir, "workspaces.json");
}

/**
 * Write a state file where two workspaces BOTH hold the same task ref, and load a registry off it.
 *
 * There is deliberately no API that produces this: `attachTasks` and `registerTaskThread` both
 * withdraw the ref from everyone else, which is the exclusivity the tests below are pinning. The
 * state is still reachable in the wild — a file written by an older build, a hand edit, a merge of
 * two daemons' state — and it is exactly the state where a merge-only `attachTasks` would strand
 * routing on the wrong room forever. So it is seeded on disk rather than through the API.
 */
function registryHoldingRefTwice(file: string): WorkspaceRegistry {
  writeFileSync(
    file,
    JSON.stringify({
      // Insertion order is the tiebreak `channelForTask` uses, so A wins the routing to begin with.
      A: { parentChannelId: "chan-1", name: "first attempt", runIds: [], taskRefs: ["12"], branchRefs: [] },
      B: { parentChannelId: "chan-1", name: "second attempt", runIds: [], taskRefs: ["12"], branchRefs: [] },
    }),
    "utf8",
  );
  return new WorkspaceRegistry({ stateFile: file, logger: quietLog });
}

test("a user thread registers a workspace that owns NO work, however it is named", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-1", parentChannelId: "chan-1", name: "OPS-120 auth rework", creatorId: "u-1" });

  // The name is carried through verbatim as a human label — and grounds nothing. Registration
  // creates a room Beckett listens in, not a claim on OPS-120.
  expect(reg.contextFor("t-1")).toEqual({
    parentChannelId: "chan-1",
    name: "OPS-120 auth rework",
    runIds: [],
    taskRefs: [],
    branchRefs: [],
  });
  expect(reg.channelForRun("OPS-120")).toBeNull();
  // A channel that isn't a workspace resolves to nothing.
  expect(reg.contextFor("chan-1")).toBeNull();
});

test("a thread named for a numbered task does NOT ground itself on that task", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-n", parentChannelId: "chan-1", name: "#12 auth rework", creatorId: "u-1" });
  reg.registerThread({ threadId: "t-sub", parentChannelId: "chan-1", name: "#12.1 retry logic", creatorId: "u-1" });

  expect(reg.contextFor("t-n")?.taskRefs).toEqual([]);
  expect(reg.contextFor("t-sub")?.taskRefs).toEqual([]);
  // Nothing routes anywhere: task 12's milestones and receipts still go to its origin channel.
  expect(reg.channelForTask("#12")).toBeNull();
  expect(reg.channelForTask("12.1")).toBeNull();

  // …and the ONLY thing that changes that is an authorized person saying so.
  reg.attachTasks("t-n", ["#12"]);
  expect(reg.channelForTask("12")).toBe("t-n");
});

test("a thread name never binds work, however it is spelled", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  // Every vocabulary the old scraper understood, every lookalike it deliberately rejected, and the
  // shapes in between. They are all the same case now, which is the point: there is no parse to
  // get subtly wrong, so no name can ever become a routing decision.
  const names = [
    "OPS-120 auth rework", // legacy ticket identifier
    "#12 auth rework", // task ref
    "#12.1 retry logic", // dotted sub-ref
    "OPS-120 + #2 and #10 (see #10 again)", // both vocabularies, repeated
    "12 ideas for #general, ping auth#7 or #12abc", // the lookalikes
    "#1 notes", // the hijack the fix exists to stop
  ];
  for (const [i, name] of names.entries()) {
    reg.registerThread({ threadId: `t-${i}`, parentChannelId: "chan-1", name, creatorId: "u-1" });
    expect(reg.contextFor(`t-${i}`)).toEqual({
      parentChannelId: "chan-1",
      name,
      runIds: [],
      taskRefs: [],
      branchRefs: [],
    });
  }
  // Nothing a name mentioned is reachable by routing, in either vocabulary.
  for (const ref of ["1", "2", "7", "10", "12", "12.1", "12abc"]) {
    expect(reg.channelForTask(ref)).toBeNull();
  }
  expect(reg.channelForRun("OPS-120")).toBeNull();
});

test("an ungrounded thread is still a workspace, and a ticket filed from it grounds it", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-2", parentChannelId: "chan-1", name: "brainstorm corner", creatorId: "u-1" });
  expect(reg.contextFor("t-2")).toEqual({
    parentChannelId: "chan-1",
    name: "brainstorm corner",
    runIds: [],
    taskRefs: [],
    branchRefs: [],
  });

  // A ticket filed FROM the workspace grounds it.
  reg.bindRun("t-2", "run-7");
  expect(reg.contextFor("t-2")?.runIds).toEqual(["run-7"]);
  // Binding against a non-workspace channel is a no-op, not a registration.
  reg.bindRun("chan-1", "OPS-8");
  expect(reg.contextFor("chan-1")).toBeNull();
});

test("registration is idempotent and binds are deduped", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-3", parentChannelId: "chan-1", name: "auth rework", creatorId: "u-1" });
  // Grounding is seeded the only way it can be: tickets filed from inside the room.
  reg.bindRun("t-3", "run-1");
  reg.bindRun("t-3", "run-2");

  // A re-emitted create event (a rename, or the daemon seeing the thread twice) changes nothing —
  // not the parent channel, not the label, and above all not the work already bound here.
  reg.registerThread({ threadId: "t-3", parentChannelId: "chan-9", name: "renamed", creatorId: "u-2" });
  reg.bindRun("t-3", "run-1"); // …and a repeated bind does not duplicate

  expect(reg.contextFor("t-3")).toEqual({
    parentChannelId: "chan-1", // the first registration wins
    name: "auth rework",
    runIds: ["run-1", "run-2"],
    taskRefs: [],
    branchRefs: [],
  });
});

test("attachTasks binds a whole wave to a thread the person opened", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "t-wave", parentChannelId: "chan-1", name: "release cleanup", creatorId: "u-1" });

  // The `&recent` case: many refs at once, mixed sigils, duplicates and blanks tolerated.
  reg.attachTasks("t-wave", ["#3", "1", "#3", "  ", "10"]);
  expect(reg.contextFor("t-wave")?.taskRefs).toEqual(["1", "3", "10"]);
  expect(reg.channelForTask("#1")).toBe("t-wave");
  expect(reg.channelForTask("10")).toBe("t-wave");

  // …and it survives a restart.
  expect(new WorkspaceRegistry({ stateFile: file, logger: quietLog }).channelForTask("3")).toBe("t-wave");
});

test("attachTasks is additive and idempotent — attaching #2 never drops #1", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "t-add", parentChannelId: "chan-1", name: "the room", creatorId: "u-1" });

  reg.attachTasks("t-add", ["#1"]);
  reg.attachTasks("t-add", ["#2"]);
  expect(reg.contextFor("t-add")?.taskRefs).toEqual(["1", "2"]);

  // Re-attaching an existing ref changes nothing at all.
  reg.attachTasks("t-add", ["#2", "#1"]);
  expect(reg.contextFor("t-add")?.taskRefs).toEqual(["1", "2"]);
});

test("attachTasks MOVES a ref: '&12' in thread B takes routing away from thread A", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  // A holds #12 because someone attached it there — the only way a thread ever holds anything.
  reg.registerThread({ threadId: "A", parentChannelId: "chan-1", name: "auth rework", creatorId: "u-1" });
  reg.attachTasks("A", ["#12"]);
  reg.registerThread({ threadId: "B", parentChannelId: "chan-1", name: "second attempt", creatorId: "u-1" });
  expect(reg.channelForTask("12")).toBe("A");

  reg.attachTasks("B", ["#12"]);

  // Beckett confirms "#12 reports in here now" — routing has to actually agree.
  expect(reg.channelForTask("12")).toBe("B");
  expect(reg.contextFor("B")?.taskRefs).toEqual(["12"]);
  // A yields the one ref and nothing else: still a workspace, just no longer holding #12.
  expect(reg.contextFor("A")).toEqual({
    parentChannelId: "chan-1",
    name: "auth rework",
    runIds: [],
    taskRefs: [],
    branchRefs: [],
  });
});

test("attachTasks moves only the named refs and leaves the loser's other work alone", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "A", parentChannelId: "chan-1", name: "release cleanup", creatorId: "u-1" });
  reg.attachTasks("A", ["#12", "#13", "#14"]);
  reg.bindBranch("A", "12.1", "run-9");
  reg.registerThread({ threadId: "B", parentChannelId: "chan-1", name: "the retry room", creatorId: "u-1" });

  reg.attachTasks("B", ["#12", "#14"]);

  expect(reg.contextFor("A")).toMatchObject({
    taskRefs: ["13"],
    runIds: ["run-9"],
    branchRefs: ["12.1"],
  });
  expect(reg.contextFor("B")?.taskRefs).toEqual(["12", "14"]);
  expect(reg.channelForTask("13")).toBe("A");
  expect(reg.channelForRun("run-9")).toBe("A");
});

test("re-attaching a ref the target ALREADY holds still withdraws it from the other workspace", () => {
  // Both rooms hold #12 on disk; insertion order hands A the routing.
  const reg = registryHoldingRefTwice(stateFile());
  expect(reg.channelForTask("12")).toBe("A");

  // The user types `&12` in B *because it didn't work*. B's own set is already {12}, so a
  // merge-only implementation would early-return and leave routing stuck on A forever.
  reg.attachTasks("B", ["#12"]);

  expect(reg.channelForTask("12")).toBe("B");
  expect(reg.contextFor("A")?.taskRefs).toEqual([]);
});

test("an attach that only withdraws is still persisted across a save/load cycle", () => {
  const file = stateFile();
  const reg = registryHoldingRefTwice(file);

  reg.attachTasks("B", ["#12"]); // withdrawal-only: B's own set really does not change

  // The write must have happened, or the daemon restarts straight back into the wrong routing.
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  expect(onDisk.A.taskRefs).toEqual([]);

  const reloaded = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(reloaded.channelForTask("12")).toBe("B");
  expect(reloaded.contextFor("A")?.taskRefs).toEqual([]);
});

test("losing its last ref leaves a workspace REGISTERED, just ungrounded", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "A", parentChannelId: "chan-1", name: "the old room", creatorId: "u-1" });
  reg.attachTasks("A", ["#12"]);
  reg.registerThread({ threadId: "B", parentChannelId: "chan-1", name: "the new room", creatorId: "u-1" });

  reg.attachTasks("B", ["#12"]);

  // A is emptied, never deleted — Beckett still listens there without an @mention…
  expect(reg.contextFor("A")).not.toBeNull();
  expect(reg.contextFor("A")?.taskRefs).toEqual([]);
  // …and it can take work again, which would be impossible if it had been unregistered.
  reg.attachTasks("A", ["#20"]);
  expect(reg.channelForTask("20")).toBe("A");
  expect(new WorkspaceRegistry({ stateFile: file, logger: quietLog }).contextFor("A")).toMatchObject({
    name: "the old room",
    taskRefs: ["20"],
  });
});

test("a fully inert attachTasks still skips the write", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "solo", parentChannelId: "chan-1", name: "the room", creatorId: "u-1" });
  reg.attachTasks("solo", ["#1"]);

  const before = readFileSync(file, "utf8");
  writeFileSync(file, "SENTINEL", "utf8");
  reg.attachTasks("solo", ["#1"]); // nobody else holds it, target already has it: no state change
  expect(readFileSync(file, "utf8")).toBe("SENTINEL");

  // Sanity: the sentinel would have been clobbered had a write occurred.
  reg.attachTasks("solo", ["#2"]);
  expect(readFileSync(file, "utf8")).not.toBe("SENTINEL");
  expect(readFileSync(file, "utf8")).not.toBe(before);
});

test("attachTasks on a thread that is not a workspace is a no-op, not an implicit registration", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.attachTasks("never-registered", ["#1"]);
  expect(reg.contextFor("never-registered")).toBeNull();
  expect(reg.channelForTask("#1")).toBeNull();
});

test("detachAll clears the work but keeps the thread a workspace", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  reg.registerThread({ threadId: "t-det", parentChannelId: "chan-1", name: "OPS-5 room", creatorId: "u-1" });
  reg.attachTasks("t-det", ["#1", "#2"]);
  reg.bindBranch("t-det", "#1.1");

  reg.detachAll("t-det");

  expect(reg.contextFor("t-det")).toEqual({
    parentChannelId: "chan-1",
    name: "OPS-5 room",
    runIds: [],
    taskRefs: [],
    branchRefs: [],
  });
  expect(reg.channelForTask("#1")).toBeNull();
  expect(reg.channelForRun("OPS-5")).toBeNull();
  // Still registered, so a later `&ref` lands — and the clear was persisted.
  reg.attachTasks("t-det", ["#9"]);
  expect(new WorkspaceRegistry({ stateFile: file, logger: quietLog }).contextFor("t-det")?.taskRefs).toEqual(["9"]);
});

test("workspace routing survives a restart via the state file", () => {
  const file = stateFile();
  const first = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  first.registerThread({ threadId: "t-4", parentChannelId: "chan-1", name: "auth rework", creatorId: "u-1" });
  first.bindRun("t-4", "run-9");
  first.bindRun("t-4", "run-10");
  first.attachTasks("t-4", ["#12"]);

  const second = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(second.contextFor("t-4")).toEqual({
    parentChannelId: "chan-1",
    name: "auth rework",
    runIds: ["run-10", "run-9"], // contextFor sorts idents lexicographically
    taskRefs: ["12"],
    branchRefs: [],
  });
  expect(second.channelForRun("run-9")).toBe("t-4");
  expect(second.channelForTask("12")).toBe("t-4");
});

test("a legacy scalar taskRef on disk migrates into taskRefs instead of being dropped", () => {
  const file = stateFile();
  writeFileSync(
    file,
    JSON.stringify({
      "old-thread": {
        parentChannelId: "chan-1",
        name: "#42 - Voting",
        runIds: ["run-a"],
        taskRef: "#42",
        branchRefs: ["42.1"],
      },
    }),
    "utf8",
  );

  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(reg.contextFor("old-thread")).toMatchObject({ taskRefs: ["42"], branchRefs: ["42.1"] });
  expect(reg.channelForTask("#42")).toBe("old-thread");

  // And the migrated shape is what gets written back out.
  reg.attachTasks("old-thread", ["#43"]);
  const rewritten = JSON.parse(readFileSync(file, "utf8"));
  expect(rewritten["old-thread"].taskRefs).toEqual(["42", "43"]);
  expect(rewritten["old-thread"].taskRef).toBeUndefined();
});

test("a Beckett-created task thread persists task/branch grounding and reverse ticket routing", () => {
  const file = stateFile();
  const first = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  first.registerTaskThread(
    { threadId: "task-thread", parentChannelId: "chan-1", name: "#42 - Voting" },
    "#42",
    ["#42.1"],
  );
  first.bindBranch("task-thread", "42.2", "run-a");

  const second = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(second.contextFor("task-thread")).toMatchObject({
    taskRefs: ["42"],
    branchRefs: ["42.1", "42.2"],
    runIds: ["run-a"],
  });
  expect(second.channelForTask("#42")).toBe("task-thread");
  expect(second.channelForRun("run-a")).toBe("task-thread");
});

test("registerTaskThread withdraws only the one ref from another workspace, never the workspace", () => {
  const file = stateFile();
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  // A room a person opened, holding a wave.
  reg.registerThread({ threadId: "user-room", parentChannelId: "chan-1", name: "release cleanup", creatorId: "u-1" });
  reg.attachTasks("user-room", ["#42", "#43"]);
  reg.bindBranch("user-room", "42.2", "run-a");

  reg.registerTaskThread({ threadId: "task-thread", parentChannelId: "chan-1", name: "#42 - Voting" }, "42", ["42.1"]);

  // #42 moved. Everything else about the person's room is untouched.
  expect(reg.channelForTask("42")).toBe("task-thread");
  expect(reg.contextFor("user-room")).toMatchObject({
    name: "release cleanup",
    taskRefs: ["43"],
    runIds: ["run-a"],
    branchRefs: ["42.2"],
  });
  expect(reg.channelForTask("43")).toBe("user-room");
  expect(reg.channelForRun("run-a")).toBe("user-room");

  const reloaded = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(reloaded.contextFor("user-room")?.taskRefs).toEqual(["43"]);
  expect(reloaded.contextFor("task-thread")).toMatchObject({ taskRefs: ["42"], branchRefs: ["42.1"] });
});

test("registerTaskThread is additive on a thread that already holds other work", () => {
  const reg = new WorkspaceRegistry({ logger: quietLog });
  reg.registerThread({ threadId: "room", parentChannelId: "chan-1", name: "the room", creatorId: "u-1" });
  reg.attachTasks("room", ["#7"]);

  reg.registerTaskThread({ threadId: "room", parentChannelId: "chan-2", name: "#8 - Voting" }, "#8");

  expect(reg.contextFor("room")).toMatchObject({
    parentChannelId: "chan-2",
    taskRefs: ["7", "8"],
  });
});

test("a corrupt state file starts fresh instead of throwing", () => {
  const file = stateFile();
  const first = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  first.registerThread({ threadId: "t-5", parentChannelId: "chan-1", name: "x", creatorId: "u-1" });
  writeFileSync(file, "{not json", "utf8");

  const second = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  expect(second.contextFor("t-5")).toBeNull();
  // …and it can still register + persist going forward.
  second.registerThread({ threadId: "t-6", parentChannelId: "chan-1", name: "y", creatorId: "u-1" });
  expect(second.contextFor("t-6")).not.toBeNull();
});

test("a pre-v7 workspaces.json with ticketIdents loads, keeps its routing, and drops the dead keys", () => {
  const file = stateFile();
  writeFileSync(
    file,
    JSON.stringify({
      "thread-1": {
        parentChannelId: "chan-1", name: "voting corner",
        // The dead half: tracker identifiers, which no run id can ever match.
        ticketIdents: ["OPS-143", "OPS-9"],
        taskRefs: ["12"], branchRefs: ["12.1"],
      },
    }),
    "utf8",
  );
  const reg = new WorkspaceRegistry({ stateFile: file, logger: quietLog });
  // The routing a human chose (`&12`) survives; the tracker identifiers do not.
  expect(reg.channelForTask("12")).toBe("thread-1");
  expect(reg.contextFor("thread-1")).toMatchObject({ taskRefs: ["12"], branchRefs: ["12.1"], runIds: [] });
  expect(reg.channelForRun("OPS-143")).toBeNull();
});
