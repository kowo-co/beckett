/**
 * Coverage for the user-owned thread model (the threads rework), Concierge half.
 *
 * The rule this file exists to pin: **Beckett never creates a thread.** Work is filed silently,
 * results report into the channel the request came from, and the PERSON opens a thread and claims
 * work for it by posting `&<ref>` / `&recent`. Four moving parts, each with a failure mode that is
 * invisible in production until results land somewhere nobody is looking:
 *
 *  1. Lazy registration — a thread becomes a workspace on its first authorized message, so
 *     "I open a thread and Beckett is in it" holds even when the daemon missed ThreadCreate. An
 *     OUTSIDER must never mint one; that is a bouncer bypass, not a routing detail.
 *  2. The `&` command — resolved at code level, thread-only, never reaching the model.
 *  3. Routing — an attached thread beats the origin channel; nothing attached means origin.
 *  4. The filed line — ONE grey subtext line per wave, per destination channel.
 *
 * Injected fakes throughout (no live Discord, no claude), matching `ticket-workspace.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Concierge, type ConciergeSession } from "./index.ts";
import type { WorkspaceRegistry } from "../discord/workspaces.ts";
import { TaskStore } from "../task/store.ts";
import type { Config, IncomingMessage, ThreadCreated } from "../types.ts";
import type { Run } from "../run/types.ts";
import type { PrRef } from "../github/types.ts";

const OWNER = "111111111111111111";
const OUTSIDER = "999999999999999999";
const CHAN = "chan-42";
const THREAD = "thread-77";
const config = { concierge: { model: "m", rotate_at_tokens: 190_000 }, paths: {} } as unknown as Config;

const savedDir = process.env.BECKETT_DIR;
const savedOwner = process.env.DISCORD_OWNER_ID;
const tmpDirs: string[] = [];
afterEach(() => {
  if (savedDir === undefined) delete process.env.BECKETT_DIR;
  else process.env.BECKETT_DIR = savedDir;
  if (savedOwner === undefined) delete process.env.DISCORD_OWNER_ID;
  else process.env.DISCORD_OWNER_ID = savedOwner;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  concierge: Concierge;
  tasks: TaskStore;
  workspaces: WorkspaceRegistry;
  posts: { channelId: string; content: string }[];
  postOpts: Array<{ pingUserIds?: string[] } | undefined>;
  asks: string[];
  joined: string[];
  dir: string;
}

/** Fake gateway with NO createTaskThread at all — nothing here may ever spawn a thread. */
function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "beckett-thread-model-"));
  tmpDirs.push(dir);
  process.env.BECKETT_DIR = dir;
  process.env.DISCORD_OWNER_ID = OWNER;
  const posts: { channelId: string; content: string }[] = [];
  const postOpts: Array<{ pingUserIds?: string[] } | undefined> = [];
  const asks: string[] = [];
  const joined: string[] = [];
  const gateway = {
    async start() {},
    async stop() {},
    async sendTyping() {},
    onMessage() {},
    onThreadCreate() {},
    isConnected() {
      return true;
    },
    lastEventAgeMs() {
      return 0;
    },
    async joinThread(threadId: string) {
      joined.push(threadId);
    },
    async post(channelId: string, content: string, opts?: { pingUserIds?: string[] }) {
      posts.push({ channelId, content });
      postOpts.push(opts);
      return `mid-${posts.length}`;
    },
  } as never;
  const session = {
    ask: async (turn: string) => {
      asks.push(turn);
      return "got it";
    },
    async stop() {},
  } as unknown as ConciergeSession;
  const tasks = new TaskStore(join(dir, "tasks.json"));
  const concierge = new Concierge({ config, session, gateway, tasks, channelProfiler: null });
  const workspaces = (concierge as unknown as { workspaces: WorkspaceRegistry }).workspaces;
  return { concierge, tasks, workspaces, posts, postOpts, asks, joined, dir };
}

function message(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    userId: OWNER,
    channelId: THREAD,
    channelName: "voting corner",
    guildId: "g1",
    content: "hey",
    repliedToId: null,
    mentionsBot: false,
    authorIsBot: false,
    createdAt: 1,
    attachments: [],
    isThread: true,
    parentChannelId: CHAN,
    ...over,
  };
}

function threadCreated(over: Partial<ThreadCreated> = {}): ThreadCreated {
  return {
    threadId: THREAD,
    parentChannelId: CHAN,
    name: "voting corner",
    creatorId: OWNER,
    newlyCreated: true,
    ...over,
  };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-20260810-voting",
    slug: "voting",
    title: "Voting API",
    prompt: "",
    channelId: CHAN,
    taskRef: "#1.1",
    state: "implementing",
    cast: null,
    repo: null,
    prUrl: null,
    error: null,
    ...over,
  } as unknown as Run;
}

// ── 1. lazy registration ──────────────────────────────────────────────────────────────────────

test("a message in an unknown thread registers it and is answered without an @mention", async () => {
  const { concierge, workspaces, asks, joined } = harness();
  // Deliberately no onThreadCreated: this is the thread opened while the daemon was down.
  await concierge.onMessage(message({ content: "how do i wire this up?" }));

  expect(workspaces.contextFor(THREAD)).toMatchObject({ parentChannelId: CHAN, name: "voting corner" });
  expect(joined).toEqual([THREAD]);
  // Registered BEFORE the ambient split, so this very message is directed.
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("work workspace");
});

test("an outsider opening a thread cannot mint a workspace", async () => {
  const { concierge, workspaces, asks, posts, joined } = harness();
  await concierge.onMessage(message({ userId: OUTSIDER, content: "let me in" }));

  expect(workspaces.contextFor(THREAD)).toBeNull();
  expect(joined).toEqual([]);
  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(0); // unmentioned + unregistered is ambient, exactly as in a channel

  // Mentioning Beckett does not change it: the workspace check runs before the mention branch, so
  // there is still nothing to register from, and the outsider is bounced by the usual gate.
  await concierge.onMessage(message({ userId: OUTSIDER, content: "let me in", mentionsBot: true }));
  expect(workspaces.contextFor(THREAD)).toBeNull();
  expect(asks).toHaveLength(0);
  expect(posts).toHaveLength(1);
});

test("an outsider's thread-create event mints NOTHING, and Beckett does not even join", () => {
  const { concierge, workspaces, dir, joined } = harness();
  const stateFile = join(dir, "workspaces.json");

  concierge.onThreadCreated(
    threadCreated({ threadId: "thread-evil", name: "#1 notes", creatorId: OUTSIDER }),
  );

  // NO state at all — not an empty workspace, not a persisted file. Asserting "nothing was posted"
  // would pass even if the binding existed.
  expect(workspaces.contextFor("thread-evil")).toBeNull();
  expect(workspaces.channelForTask("1")).toBeNull();
  expect(existsSync(stateFile)).toBe(false);
  // Joining moved out of the gateway and behind this gate: the gateway cannot see the access list,
  // so joining on the raw event made Beckett a member of any room anyone could open.
  expect(joined).toEqual([]);

  // Same event from an authorized member DOES register — which also proves the assertions above
  // are watching the right registry and the right file, not passing vacuously.
  concierge.onThreadCreated(threadCreated({ name: "#1 notes" }));
  expect(workspaces.contextFor(THREAD)).not.toBeNull();
  expect(existsSync(stateFile)).toBe(true);
  expect(joined).toEqual([THREAD]);
  // …and it STILL owns no work, because the name is a label. See the next test.
  expect(workspaces.channelForTask("1")).toBeNull();
});

test("the thread NAME never binds work — not even once an authorized person speaks in the room", async () => {
  const { concierge, tasks, workspaces, asks } = harness();
  const stolen = "thread-evil";
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN });

  // The hijack, end to end. The thread NAME is attacker-chosen text that is never checked against
  // who may see task 1, while `channelForTask` routes that task's milestones, PR events and filed
  // receipts. Step 1: an outsider opens "#1 notes" and is correctly bounced.
  concierge.onThreadCreated(threadCreated({ threadId: stolen, name: "#1 notes", creatorId: OUTSIDER }));
  expect(workspaces.contextFor(stolen)).toBeNull();

  // Step 2 is the part the creator gate could never cover, and the reason the name had to stop
  // binding: the OWNER wanders in and posts something ordinary. That lazily registers the
  // workspace — the speaker is trusted, so the gate passes — but the name it registers under is
  // still the outsider's. Scraping it here would hand task 1's routing to the attacker's room
  // through a completely authorized action.
  await concierge.onMessage(
    message({ channelId: stolen, channelName: "#1 notes", content: "what's the status here?" }),
  );

  expect(workspaces.contextFor(stolen)).toMatchObject({ name: "#1 notes", taskRefs: [] });
  expect(asks).toHaveLength(1); // the room IS a workspace: the turn ran
  expect(workspaces.channelForTask("1")).toBeNull(); // …and it owns nothing

  // Only a deliberate `&1` from an authorized person moves routing. Asserting that it still works
  // here is what stops the null above from passing vacuously: task #1 exists and IS attachable —
  // the name simply is not what attaches it.
  await concierge.onMessage(message({ channelId: stolen, channelName: "#1 notes", content: "&1" }));
  expect(workspaces.channelForTask("1")).toBe(stolen);
});

test("an invited MEMBER opening a thread still gets a workspace (the bar is access, not rank)", () => {
  const { concierge, workspaces, dir } = harness();
  const member = "222222222222222222";
  writeFileSync(join(dir, "access.txt"), `${member}\n`, "utf8");

  concierge.onThreadCreated(threadCreated({ threadId: "thread-member", creatorId: member }));
  expect(workspaces.contextFor("thread-member")).toMatchObject({ parentChannelId: CHAN });
});

test("the newlyCreated=false 'bot was added' event is gated the same way", () => {
  const { concierge, workspaces } = harness();
  // The gateway now forwards this case too (it is the only signal for a pre-existing thread), so
  // it is a second door into the same registration and needs the same bouncer.
  concierge.onThreadCreated(
    threadCreated({ threadId: "thread-old", name: "#1 notes", creatorId: OUTSIDER, newlyCreated: false }),
  );
  expect(workspaces.contextFor("thread-old")).toBeNull();
  expect(workspaces.channelForTask("1")).toBeNull();
});

test("an unknowable channel type is never assumed to be a thread", async () => {
  const { concierge, workspaces, asks } = harness();
  // isThread undefined = the gateway could not tell. Registering here would turn an ordinary
  // channel into a room where every message is directed.
  await concierge.onMessage(message({ isThread: undefined, channelId: CHAN, content: "just chatting" }));
  expect(workspaces.contextFor(CHAN)).toBeNull();
  expect(asks).toHaveLength(0);
});

// ── 2. the `&` command ────────────────────────────────────────────────────────────────────────

test("&<ref> attaches the task, recaps it, and never reaches the model", async () => {
  const { concierge, tasks, workspaces, asks, posts } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN, initialBranchTitle: "API" });

  await concierge.onMessage(message({ content: "&1" }));

  expect(workspaces.channelForTask("1")).toBe(THREAD);
  expect(asks).toHaveLength(0); // code-level, like the access approval intercept
  expect(posts).toHaveLength(1);
  expect(posts[0]?.content).toContain("#1 reports in here now");
  expect(posts[0]?.content).toContain("Build voting");
  expect(posts[0]?.content).toContain("#1.1 API (ready)");
});

test("the recap cannot ping the room through a task title", async () => {
  const { concierge, tasks, posts } = harness();
  await tasks.createTask({ title: "@everyone ship it", originChannelId: CHAN });
  await concierge.onMessage(message({ content: "&1" }));
  expect(posts[0]?.content).not.toContain("@everyone");
  expect(posts[0]?.content).toContain("everyone ship it");
});

test("&<ref> for work that does not exist attaches nothing and says so", async () => {
  const { concierge, workspaces, posts, asks } = harness();
  await concierge.onMessage(message({ content: "&404" }));

  expect(workspaces.contextFor(THREAD)?.taskRefs).toEqual([]);
  expect(asks).toHaveLength(0);
  expect(posts[0]?.content).toContain("no task #404");
});

test("a branch ref attaches its whole task, since routing is per task", async () => {
  const { concierge, tasks, workspaces } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN, initialBranchTitle: "API" });
  await concierge.onMessage(message({ content: "&1.1" }));
  expect(workspaces.channelForTask("1")).toBe(THREAD);
});

test("&recent attaches the whole wave and summarizes branches as counts past three", async () => {
  const { concierge, tasks, workspaces, posts } = harness();
  const wave = "wave_test01";
  await tasks.createTask({ title: "One", originChannelId: CHAN, waveId: wave, initialBranchTitle: "a" });
  await tasks.createTask({ title: "Two", originChannelId: CHAN, waveId: wave, initialBranchTitle: "b" });
  for (const title of ["c", "d", "e"]) await tasks.createBranch({ task: "#2", title });

  await concierge.onMessage(message({ content: "&recent" }));

  expect(workspaces.contextFor(THREAD)?.taskRefs).toEqual(["1", "2"]);
  const recap = posts[0]?.content ?? "";
  expect(recap).toContain("2 tasks report in here now");
  expect(recap).toContain("**#1** One");
  // Task 2 has four branches, so it collapses to counts instead of listing them.
  expect(recap).toContain("4 branches: 4 ready");
  // One line per task keeps a wave from becoming a wall of text.
  expect(recap.split("\n")).toHaveLength(3);
});

test("&recent with nothing filed says so instead of attaching an empty set", async () => {
  const { concierge, workspaces, posts } = harness();
  await concierge.onMessage(message({ content: "&recent" }));
  expect(workspaces.contextFor(THREAD)?.taskRefs).toEqual([]);
  expect(posts[0]?.content).toContain("nothing to attach");
});

test("&clear releases the work but leaves the thread a workspace", async () => {
  const { concierge, tasks, workspaces, posts } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN, initialBranchTitle: "API" });
  await concierge.onMessage(message({ content: "&1" }));

  await concierge.onMessage(message({ content: "&clear" }));

  expect(workspaces.channelForTask("1")).toBeNull();
  expect(workspaces.contextFor(THREAD)).not.toBeNull(); // still a directed room
  expect(posts[1]?.content).toContain("cleared");
});

test("outside a thread, &12 is ordinary text and reaches the model untouched", async () => {
  const { concierge, tasks, workspaces, asks, posts } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN });

  await concierge.onMessage(message({ isThread: false, channelId: CHAN, content: "&1", mentionsBot: true }));

  expect(workspaces.channelForTask("1")).toBeNull();
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("&1");
  expect(posts.some((p) => p.content.includes("reports in here now"))).toBe(false);
});

test("an attach seeds the NEXT turn with the work's grounding, exactly once", async () => {
  const { concierge, tasks, asks } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN, initialBranchTitle: "API" });
  await concierge.onMessage(message({ content: "&1" }));

  await concierge.onMessage(message({ content: "where's that at?" }));
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("work just attached to this thread");
  expect(asks[0]).toContain("#1 Build voting [active]");
  expect(asks[0]).toContain("#1.1 API [ready]");

  // One-shot: a second follow-up still gets the standing workspace frame, but not the seed again.
  await concierge.onMessage(message({ content: "and now?" }));
  expect(asks[1]).not.toContain("work just attached to this thread");
  expect(asks[1]).toContain("numbered task workspace");
});

// ── 3. routing ────────────────────────────────────────────────────────────────────────────────

test("an attached thread wins over the run's origin channel; unattached work stays put", async () => {
  const { concierge, tasks, asks } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN, initialBranchTitle: "API" });

  // Nothing attached yet: the update goes back to where the request came from.
  concierge.notify({ kind: "state_changed", run: run({ state: "done" }), from: "publishing", to: "done" });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks[0]).toContain(`--channel ${CHAN}`);

  await concierge.onMessage(message({ content: "&1" }));
  concierge.notify({
    kind: "state_changed",
    run: run({ id: "run-20260810-voting-2", state: "done" }),
    from: "publishing",
    to: "done",
  });
  await new Promise((r) => setTimeout(r, 0));
  // #1.1 belongs to task 1, which now reports into the thread.
  expect(asks[asks.length - 1]).toContain(`--channel ${THREAD}`);
});

test("PR events follow the thread the work was attached to, even when the PR opened first", async () => {
  const { concierge, tasks, asks } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN, initialBranchTitle: "API" });
  await tasks.linkRun("1.1", { runId: "run-20260810-voting" }, "implementing");
  const pr: PrRef = {
    repo: "0xbeckett/foo",
    number: 96,
    url: "https://github.com/0xbeckett/foo/pull/96",
    title: "Voting API",
    runId: "run-20260810-voting",
    // Stamped when the PR opened: the origin channel, the only destination known back then.
    channel: CHAN,
  };

  concierge.notifyPrEvents({ kind: "merged", pr });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.at(-1)).toContain(`--channel ${CHAN}`);

  // The person now opens a thread and claims #1. `&1` writes the WORKSPACE REGISTRY only — it
  // never stamps task.threadId — so a destination frozen at PR-open time keeps reporting into the
  // origin channel forever, which is exactly the bug. Resolution happens at relay time instead.
  await concierge.onMessage(message({ content: "&1" }));
  concierge.notifyPrEvents({ kind: "ci", pr, conclusion: "FAILURE" });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.at(-1)).toContain(`--channel ${THREAD}`);
  expect(asks.at(-1)).not.toContain(`--channel ${CHAN}`);
});

test("a PR with no stamped channel still reports into the thread that owns its work", async () => {
  const { concierge, tasks, asks } = harness();
  await tasks.createTask({ title: "Build voting", originChannelId: CHAN, initialBranchTitle: "API" });
  await tasks.linkRun("1.1", { runId: "run-20260810-voting" }, "implementing");
  await concierge.onMessage(message({ content: "&1" }));

  // An unstamped PR used to be dropped outright. The attachment is a real, human-chosen
  // destination, so it answers the "nowhere to route" question the drop exists for.
  concierge.notifyPrEvents({
    kind: "merged",
    pr: { repo: "0xbeckett/foo", number: 96, url: "u", title: "Voting API", runId: "run-20260810-voting" },
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks.at(-1)).toContain(`--channel ${THREAD}`);
});

test("a PR for work nobody attached still lands in the channel stamped when it opened", async () => {
  const { concierge, asks } = harness();
  concierge.notifyPrEvents({
    kind: "merged",
    pr: { repo: "0xbeckett/foo", number: 96, url: "u", title: "Voting API", runId: "run-20260810-voting", channel: CHAN },
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain(`--channel ${CHAN}`);
});
