import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import type { DiscordGateway, ReplyOptions } from "../types.ts";
import { TaskStore } from "../task/store.ts";
import type { BranchStatusService } from "../task/status.ts";
import type { WorkspaceRegistry } from "../discord/workspaces.ts";
import { branchCardReference, CARDS_CHANNEL_ID, Concierge, type ConciergeSession } from "./index.ts";

// The Discord slash surface (`onCommand` — /task create|show|workspace, /stats, /branch) was
// deleted in the v6 Phase-4 product cut: @mention + CLI are the flow.
//
// Beckett no longer creates a thread per task at all — that is the whole point of the threads
// rework, and the FIRST thing these tests pin: `task.created` (what `beckett task create|branch|
// start` calls) and startup recovery must both be thread-silent. `ensureTaskThread` survives for
// the one case still legitimate (the person asking for a thread in words), so its stored-thread
// validation, deleted-thread recreation and sibling-thread logic are exercised by calling it
// directly instead of through a bus command that no longer reaches it.

const OWNER = "111111111111111111";
const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const dirs: string[] = [];

afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(
  opts: {
    failThreadOnce?: boolean;
    branchStatus?: BranchStatusService;
    unavailableThreadIds?: string[];
    existingThreads?: Record<string, string>;
    createThreadFromMessage?: (
      channelId: string,
      messageId: string,
      name: string,
    ) => Promise<{ threadId: string; parentChannelId: string; name: string }>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-command-"));
  dirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = OWNER;
  const createdNames: string[] = [];
  const createdChannels: string[] = [];
  const threadCalls: string[] = [];
  const asks: string[] = [];
  const posts: Array<{ channelId: string; content: string; options?: ReplyOptions }> = [];
  let failThread = opts.failThreadOnce ?? false;
  const gateway = {
    createTaskThread: async (channelId: string, name: string) => {
      threadCalls.push(channelId);
      if (failThread) {
        failThread = false;
        throw new Error("missing CreatePublicThreads");
      }
      if (opts.unavailableThreadIds?.includes(channelId)) throw new Error("Unknown Channel");
      const existingParent = opts.existingThreads?.[channelId];
      if (existingParent) return { threadId: channelId, parentChannelId: existingParent, name };
      createdNames.push(name);
      createdChannels.push(channelId);
      return { threadId: `thread-${createdNames.length}`, parentChannelId: channelId, name };
    },
    ...(opts.createThreadFromMessage ? { createThreadFromMessage: opts.createThreadFromMessage } : {}),
    sendTyping: async () => {},
    post: async (channelId: string, content: string, options?: ReplyOptions) => {
      posts.push({ channelId, content, options });
      return `message-${posts.length}`;
    },
  } as unknown as DiscordGateway;
  const session = {
    ask: async (turn: string) => {
      asks.push(turn);
      return "got it";
    },
  } as unknown as ConciergeSession;
  const tasks = new TaskStore(join(dir, "tasks.json"));
  const concierge = new Concierge({
    config: validateConfig({}),
    session,
    gateway,
    tasks,
    channelProfiler: null,
    ...(opts.branchStatus ? { branchStatus: opts.branchStatus } : {}),
  });
  return { concierge, tasks, createdNames, createdChannels, threadCalls, asks, posts, dir };
}

/** The private explicit-request path, reachable only by a deliberate call. */
function threadMaker(concierge: Concierge) {
  return (concierge as unknown as {
    ensureTaskThread(taskNumber: number, fallbackChannelId?: string): Promise<{ threadId: string; name: string }>;
  }).ensureTaskThread.bind(concierge);
}

test("task.created records the task and creates NO Discord thread", async () => {
  const { concierge, tasks, createdNames, threadCalls } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: "channel-1" });

  const first = await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 1, channelId: "channel-1" } });
  // No threadId in the reply and none on the task: the work reports into channel-1 itself.
  expect(first).toEqual({ ok: true, data: { taskRef: "#1" } });
  expect(createdNames).toEqual([]);
  expect(threadCalls).toEqual([]);
  expect(tasks.getTask(1)?.threadId).toBeUndefined();
});

test("task.created on a nonexistent task fails without touching Discord", async () => {
  const { concierge, threadCalls } = harness();
  const reply = await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 9, channelId: "channel-1" } });
  expect(reply).toEqual({ ok: false, error: "no such task: #9" });
  expect(threadCalls).toEqual([]);
});

test("task.created grounds the thread it was filed from, and only when that thread is a workspace", async () => {
  const { concierge, tasks } = harness();
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  concierge.onThreadCreated({
    threadId: "user-thread",
    parentChannelId: "parent-1",
    name: "voting corner",
    creatorId: OWNER,
  });
  await tasks.createTask({ title: "Build voting", originChannelId: "user-thread", initialBranchTitle: "API" });
  await tasks.linkRun("1.1", { runId: "run-ops-9" }, "implementing");

  await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 1, channelId: "user-thread" } });
  expect(workspaces.channelForTask("1")).toBe("user-thread");
  expect(workspaces.channelForRun("run-ops-9")).toBe("user-thread");

  // A plain channel is not a workspace, so nothing is recorded and results stay in that channel.
  await tasks.createTask({ title: "Other work", originChannelId: "channel-1" });
  await concierge.onBusRequest({ cmd: "task.created", args: { taskNumber: 2, channelId: "channel-1" } });
  expect(workspaces.channelForTask("2")).toBeNull();
});

test("a thread holding attached work is directed context framed with that work", async () => {
  const { concierge, tasks, asks } = harness();
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  await tasks.createTask({ title: "First task", originChannelId: "parent-1", initialBranchTitle: "API" });
  concierge.onThreadCreated({
    threadId: "thread-1",
    parentChannelId: "parent-1",
    name: "first task corner",
    creatorId: OWNER,
  });
  workspaces.attachTasks("thread-1", ["1"]);
  workspaces.bindBranch("thread-1", "1.1");

  await concierge.onMessage({
    messageId: "m1",
    userId: OWNER,
    channelId: "thread-1",
    channelName: "first task corner",
    guildId: "guild-1",
    content: "start the main branch now",
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: false,
    createdAt: 1,
    attachments: [],
  });
  expect(asks[0]).toContain("numbered task workspace");
  expect(asks[0]).toContain("task #1");
  expect(asks[0]).toContain("#1.1");
  expect(asks[0]).toContain("do not create a duplicate task");
});

test("an explicitly requested task thread lands as a sibling of the thread it was asked for in", async () => {
  const { concierge, tasks, createdChannels } = harness();
  const ensureTaskThread = threadMaker(concierge);
  await tasks.createTask({ title: "First task", originChannelId: "parent-1" });
  await ensureTaskThread(1, "parent-1");

  // Asking for a thread from inside a thread that already owns work puts the new one under the
  // durable parent, never nested. This is the `currentWorkspace.taskRefs.length` branch.
  await tasks.createTask({ title: "Second task", originChannelId: "thread-1" });
  await ensureTaskThread(2, "thread-1");
  expect(createdChannels).toEqual(["parent-1", "parent-1"]);
  expect(tasks.getTask(2)?.originChannelId).toBe("parent-1");
});

test("an explicit thread request keeps the task durable when Discord refuses, and repairs on retry", async () => {
  const { concierge, tasks, createdNames } = harness({ failThreadOnce: true });
  const ensureTaskThread = threadMaker(concierge);
  await tasks.createTask({ title: "Durable task", originChannelId: "channel-1" });

  await expect(ensureTaskThread(1, "channel-1")).rejects.toThrow("missing CreatePublicThreads");
  expect(tasks.getTask(1)?.threadId).toBeUndefined();

  const repaired = await ensureTaskThread(1, "channel-1");
  expect(repaired.threadId).toBe("thread-1");
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  expect(createdNames).toEqual(["#1 - Durable task"]);
});

test("an explicit thread request gateway-validates a stored thread instead of blindly recreating it", async () => {
  const { concierge, tasks, createdNames, threadCalls } = harness({
    existingThreads: { "thread-live": "parent-1" },
  });
  await tasks.createTask({ title: "Live task", originChannelId: "parent-1" });
  await tasks.setThread(1, "thread-live", "parent-1");

  const thread = await threadMaker(concierge)(1, "different-channel");

  expect(threadCalls).toEqual(["thread-live"]);
  expect(createdNames).toEqual([]);
  expect(thread.threadId).toBe("thread-live");
});

test("an explicit thread request replaces a deleted stored thread under its durable parent", async () => {
  const { concierge, tasks, createdChannels, threadCalls } = harness({
    unavailableThreadIds: ["thread-deleted"],
  });
  await tasks.createTask({ title: "Repair task", originChannelId: "parent-1" });
  await tasks.setThread(1, "thread-deleted", "parent-1");
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  workspaces.registerTaskThread(
    { threadId: "thread-deleted", parentChannelId: "parent-1", name: "#1 - Repair task" },
    "1",
    ["1.1"],
  );

  const thread = await threadMaker(concierge)(1, "different-channel");

  expect(threadCalls).toEqual(["thread-deleted", "parent-1"]);
  expect(createdChannels).toEqual(["parent-1"]);
  expect(tasks.getTask(1)?.threadId).toBe("thread-1");
  // The stale workspace yields the ref but stays a registered room the person opened.
  expect(workspaces.contextFor("thread-deleted")?.taskRefs).toEqual([]);
  expect(workspaces.channelForTask("1")).toBe("thread-1");
  expect(thread.threadId).toBe("thread-1");
});

test("startup recovery creates NO thread for a task that never had one", async () => {
  const { concierge, tasks, createdNames, threadCalls } = harness();
  await tasks.createTask({ title: "Offline task", originChannelId: "parent-1" });
  await (
    concierge as unknown as { restoreTaskWorkspaces(): Promise<void> }
  ).restoreTaskWorkspaces();
  // A boot that spawned a thread per task would recreate the exact noise we removed.
  expect(createdNames).toEqual([]);
  expect(threadCalls).toEqual([]);
  expect(tasks.getTask(1)?.threadId).toBeUndefined();
});

test("startup recovery re-binds branches linked while the daemon was down, and skips unattached work", async () => {
  const { concierge, tasks, threadCalls } = harness();
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  await tasks.createTask({ title: "Offline repair", originChannelId: "parent-1", initialBranchTitle: "API" });
  await tasks.linkRun("1.1", { runId: "run-ops-321" }, "implementing");
  // The room the person opened and attached #1 to. That attachment — not `task.threadId` — is what
  // recovery resolves against, and it is already durable in workspaces.json on its own.
  concierge.onThreadCreated({
    threadId: "user-thread",
    parentChannelId: "parent-1",
    name: "offline repair corner",
    creatorId: OWNER,
  });
  workspaces.attachTasks("user-thread", ["1"]);

  // A second task nobody ever attached to a thread must be left alone: no workspace owns it, so
  // there is nowhere to re-bind and its results keep reporting into its origin channel.
  await tasks.createTask({ title: "Closed room", originChannelId: "parent-1" });
  await tasks.setThread(2, "thread-gone", "parent-1");

  await (
    concierge as unknown as { restoreTaskWorkspaces(): Promise<void> }
  ).restoreTaskWorkspaces();

  expect(threadCalls).toEqual([]);
  // The branch/ticket link made while we were down is what recovery actually adds back.
  expect(workspaces.contextFor("user-thread")).toMatchObject({
    taskRefs: ["1"],
    branchRefs: ["1.1"],
    runIds: ["run-ops-321"],
  });
  expect(workspaces.channelForRun("run-ops-321")).toBe("user-thread");
  // A stale `task.threadId` is never resurrected into a workspace.
  expect(workspaces.contextFor("thread-gone")).toBeNull();
  expect(workspaces.channelForTask("2")).toBeNull();
});

test("startup recovery honours the CURRENT attachment, not the task's stale threadId", async () => {
  const { concierge, tasks } = harness();
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  await tasks.createTask({ title: "Moved work", originChannelId: "parent-1", initialBranchTitle: "API" });
  // The task row still points at thread A — an artifact of the era when Beckett opened a thread per
  // task, and a field `&12` deliberately never writes.
  await tasks.setThread(1, "A", "parent-1");
  await tasks.linkRun("1.1", { runId: "run-ops-77" }, "implementing");
  for (const threadId of ["A", "B"]) {
    concierge.onThreadCreated({ threadId, parentChannelId: "parent-1", name: `room ${threadId}`, creatorId: OWNER });
  }
  workspaces.attachTasks("A", ["1"]);

  // The person moves the work: `&1` in B. Attachment is exclusive, so A yields the ref.
  workspaces.attachTasks("B", ["1"]);
  expect(workspaces.channelForTask("1")).toBe("B");

  await (
    concierge as unknown as { restoreTaskWorkspaces(): Promise<void> }
  ).restoreTaskWorkspaces();

  // The regression: recovery used to re-attach from `task.threadId`, so every restart silently
  // dragged the work back to A while Beckett kept telling the user it reported in B.
  expect(workspaces.channelForTask("1")).toBe("B");
  expect(workspaces.contextFor("A")?.taskRefs).toEqual([]);
  // Branch/ticket links land on the thread that genuinely owns the task right now.
  expect(workspaces.contextFor("B")).toMatchObject({ branchRefs: ["1.1"], runIds: ["run-ops-77"] });
  expect(workspaces.contextFor("A")?.branchRefs).toEqual([]);
  expect(workspaces.channelForRun("run-ops-77")).toBe("B");
});

test("a conversational branch-status reference returns the rich card without an LLM turn", async () => {
  const branchStatus = {
    read: async () => ({
      ref: "42.1",
      title: "Voting API",
      taskNumber: 42,
      taskTitle: "Voting",
      status: "review",
      source: "pull_request",
      changes: { additions: 18, deletions: 4, files: 3, commits: 2 },
      pullRequest: { number: 9, url: "https://github.com/acme/voting/pull/9", state: "OPEN", draft: false },
      checks: { total: 2, passed: 2, pending: 0, failed: 0, skipped: 0, conclusion: "SUCCESS" },
      updatedAt: "2026-07-12T00:00:00.000Z",
    }),
  } as unknown as BranchStatusService;
  const { concierge, asks, posts } = harness({ branchStatus });
  await concierge.onMessage({
    messageId: "branch-question",
    userId: OWNER,
    channelId: "channel-1",
    guildId: "guild-1",
    content: "what's #42.1 looking like?",
    repliedToId: null,
    mentionsBot: true,
    authorIsBot: false,
    createdAt: 1,
    attachments: [],
  });

  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.channelId).toBe(CARDS_CHANNEL_ID);
  expect(posts[0]?.options?.replyToMessageId).toBeUndefined();
  expect(posts[0]?.options?.embeds?.[0]?.title).toBe("#42.1 - Voting API");
  expect(posts[0]?.options?.buttons?.[0]?.label).toBe("Open PR");
  expect(branchCardReference("please change #42.1 instead")).toBeNull();
});

test("a branch card requested inside a thread keeps attach controls in that current thread", async () => {
  const branchStatus = {
    read: async () => ({
      ref: "42.1", title: "Voting API", taskNumber: 42, taskTitle: "Voting", status: "done",
      source: "pull_request", pullRequest: { number: 9, url: "https://github.com/acme/voting/pull/9", state: "OPEN", draft: false },
      updatedAt: "2026-07-12T00:00:00.000Z",
    }),
  } as unknown as BranchStatusService;
  const { concierge, posts } = harness({ branchStatus });
  await concierge.onMessage({
    messageId: "thread-branch-question", userId: OWNER, channelId: "thread-1", guildId: "guild-1",
    content: "#42.1", repliedToId: null, mentionsBot: true, authorIsBot: false, createdAt: 1,
    attachments: [], isThread: true, parentChannelId: "channel-1",
  });

  expect(posts[0]?.channelId).toBe("thread-1");
  expect(posts[0]?.options?.buttons).toContainEqual({ label: "Attach to thread", customId: "beckett:v1:attach:42" });
});

/** The component action registry, reached the same way a button click or a reaction reaches it. */
function componentRouterOf(concierge: Concierge) {
  return (concierge as unknown as {
    componentRouter: {
      execute(
        action: string,
        target: string,
        interaction: unknown,
      ): Promise<{ authorized: boolean; message: string }>;
    };
  }).componentRouter;
}

function attachClick(overrides: Partial<{ channelId: string; isThread: boolean; messageId: string; userId: string }> = {}) {
  return {
    customId: "beckett:v1:attach:1",
    userId: OWNER,
    channelId: "channel-1",
    isThread: false,
    messageId: "card-msg-1",
    editReply: async () => {},
    ...overrides,
  };
}

test("attach clicked in a plain channel creates a thread off the card's message, attaches the task, and posts a fresh card there (#112)", async () => {
  const threadCreateCalls: Array<{ channelId: string; messageId: string; name: string }> = [];
  const { concierge, tasks, posts } = harness({
    createThreadFromMessage: async (channelId, messageId, name) => {
      threadCreateCalls.push({ channelId, messageId, name });
      return { threadId: "new-thread-1", parentChannelId: channelId, name };
    },
  });
  await tasks.createTask({ title: "Ship export", originChannelId: "channel-1" });
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;

  const result = await componentRouterOf(concierge).execute("attach", "1", attachClick());

  expect(threadCreateCalls).toEqual([{ channelId: "channel-1", messageId: "card-msg-1", name: "#1 - Ship export" }]);
  expect(result).toEqual({ authorized: true, message: expect.stringContaining("new-thread-1") });
  expect(workspaces.channelForTask("1")).toBe("new-thread-1");
  // A live card was posted INSIDE the new thread, not just a text reply. Task cards render as a
  // Components V2 container now (`card`), not an embed — this assertion trailed that change.
  const cardPost = posts.find((p) => p.channelId === "new-thread-1");
  expect(cardPost?.options?.card).toBeDefined();
  expect(tasks.getTask(1)?.card?.channelId).toBe("new-thread-1");
});

test("attach clicked inside an existing thread behaves exactly as before — no thread is created", async () => {
  const threadCreateCalls: string[] = [];
  const { concierge, tasks } = harness({
    createThreadFromMessage: async (channelId) => {
      threadCreateCalls.push(channelId);
      return { threadId: "should-not-be-used", parentChannelId: channelId, name: "n/a" };
    },
  });
  await tasks.createTask({ title: "Ship export", originChannelId: "channel-1" });
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  workspaces.registerThread({ threadId: "thread-1", parentChannelId: "channel-1", name: "room", creatorId: OWNER });

  const result = await componentRouterOf(concierge).execute(
    "attach",
    "1",
    attachClick({ channelId: "thread-1", isThread: true }),
  );

  expect(threadCreateCalls).toEqual([]);
  expect(result).toEqual({ authorized: true, message: expect.stringContaining("got it, #1 reports in here now.") });
  expect(workspaces.channelForTask("1")).toBe("thread-1");
});

test("attach reuses a thread the card's message already has instead of erroring", async () => {
  const { concierge, tasks } = harness({
    createThreadFromMessage: async (channelId, _messageId, name) => ({
      threadId: "already-existing-thread", parentChannelId: channelId, name,
    }),
  });
  await tasks.createTask({ title: "Ship export", originChannelId: "channel-1" });
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;

  const result = await componentRouterOf(concierge).execute("attach", "1", attachClick());

  expect(result.authorized).toBe(true);
  expect(result.message).toContain("already-existing-thread");
  expect(workspaces.channelForTask("1")).toBe("already-existing-thread");
});

test("attach reports a thread-creation failure verbatim, never the old 'open a thread first' text", async () => {
  const { concierge, tasks } = harness({
    createThreadFromMessage: async () => { throw new Error("Missing Permissions"); },
  });
  await tasks.createTask({ title: "Ship export", originChannelId: "channel-1" });
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;

  const result = await componentRouterOf(concierge).execute("attach", "1", attachClick());

  expect(result.authorized).toBe(true);
  expect(result.message).toContain("Missing Permissions");
  expect(result.message).not.toContain("Open the target thread first");
  expect(workspaces.channelForTask("1")).toBeNull();
});

test("attach from a plain channel still refuses an outsider without creating a thread", async () => {
  const threadCreateCalls: string[] = [];
  const { concierge, tasks } = harness({
    createThreadFromMessage: async (channelId) => {
      threadCreateCalls.push(channelId);
      return { threadId: "new-thread-1", parentChannelId: channelId, name: "n/a" };
    },
  });
  await tasks.createTask({ title: "Ship export", originChannelId: "channel-1" });

  const result = await componentRouterOf(concierge).execute(
    "attach",
    "1",
    attachClick({ userId: "stranger-1" }),
  );

  expect(threadCreateCalls).toEqual([]);
  expect(result).toEqual({ authorized: false, message: "You are not authorized to use that control." });
});
