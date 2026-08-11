/**
 * Beckett — ticket workspaces (`src/discord/workspaces.ts`)
 * =======================================================================================
 * The Coworker-as-a-Service thread model: a workspace is a Discord thread a PERSON opened,
 * registered here so that every authorized message inside it is a directed Concierge turn with no
 * @mention required. Beckett does not create threads — the human decides when a piece of work
 * deserves a dedicated space, opens the thread, and Beckett moves in.
 *
 * A workspace holds a **set** of task refs, not one. The user attaches work to a thread they opened
 * by posting `&<taskRef>` (one task) or `&recent` (a whole wave at once), so "this thread owns
 * exactly one task" was never true under the new model — a wave of twelve tickets lands in one
 * thread the person chose. Hence {@link StoredWorkspace.taskRefs} is an array, and everything that
 * used to compare a scalar now asks "is this ref IN the set".
 *
 * The registry is deliberately dumb state, no gateway handle at all:
 *  - **Registration** comes from the gateway's thread-create event ({@link WorkspaceRegistry.registerThread}),
 *    filtered upstream to user-created threads only.
 *  - **Work grounding** is additive within a thread, and never comes from the thread NAME — the
 *    name is attacker-chosen text and binding work by it is a routing hijack (see the note above
 *    {@link StoredWorkspace}). A run deployed FROM inside a workspace binds to it when the Concierge
 *    acks it ({@link WorkspaceRegistry.bindRun}); an explicit `&ref` attaches more later
 *    ({@link WorkspaceRegistry.attachTasks}). Additive is the invariant that matters: attaching #2
 *    must never silently drop #1, because a dropped binding shows up much later as results posting
 *    to the wrong place with no error anywhere.
 *  - **A task ref lives in exactly one workspace.** Additive-within is not additive-across: routing
 *    ({@link WorkspaceRegistry.channelForTask}) can only name one thread, so both `&ref` attachment
 *    and {@link WorkspaceRegistry.registerTaskThread} withdraw the ref from every other workspace.
 *    The loser keeps its other work and stays registered — only the one ref moves.
 *  - A workspace with no tasks yet is still a workspace — the conversation is directed, just not
 *    grounded. {@link WorkspaceRegistry.detachAll} returns a thread to exactly that state rather
 *    than unregistering it: Beckett still listens there, it just no longer owns any work.
 *  - **Persistence**: the thread → work map is saved to `<beckettDir>/workspaces.json` so
 *    unmentioned routing survives a daemon restart. Best-effort: a corrupt/missing file starts
 *    fresh and new thread-create events rebuild it.
 *
 * The verbose worker play-by-play that used to stream into bot-created progress threads now goes
 * to the private per-ticket journal (`src/progress/journal.ts`) — a workspace only ever carries
 * the human conversation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger, TaskThreadCreated, ThreadCreated } from "../types.ts";
import { log as rootLog } from "../log.ts";

/** Work context attached to an inbound message from a workspace thread. */
export interface WorkspaceContext {
  parentChannelId: string;
  /** The thread name the person chose — the workspace's human label. */
  name: string;
  /** Run ids grounded in this workspace (possibly empty for a fresh thread). */
  runIds: string[];
  /**
   * Numbered task refs this workspace owns, normalized without the leading `#` and in stable
   * order. Empty for a thread that has not been attached to any work yet.
   */
  taskRefs: string[];
  branchRefs: string[];
}

export interface WorkspaceRegistryOptions {
  /** JSON file remembering thread → work across daemon restarts. Omit to disable persistence. */
  stateFile?: string;
  logger?: Logger;
}

/**
 * A thread NAME never binds work. This is a security boundary, not a style choice.
 *
 * We used to scrape "OPS-120" and "#12" out of the name and ground the workspace on them. But the
 * name is chosen by whoever opened the thread, and `channelForTask`/`channelForRun` route real
 * milestones, PR events and filed receipts by it. That made the name an attacker-controlled routing
 * table: anyone who could see a channel could open a thread called "#12 notes" and, the moment any
 * authorized person said anything in it, become the destination for task 12's updates.
 *
 * Gating registration on the SPEAKER did not close it — the speaker is trusted, the name is not.
 * The only robust rule is that attachment must be an explicit act by an authorized person, which is
 * exactly what `&12` / `&recent` already are (see src/concierge/thread-attach.ts). The name is kept
 * as a human label and nothing more.
 */
interface StoredWorkspace {
  parentChannelId: string;
  name: string;
  runIds: string[];
  /** Normalized (no leading `#`), deduped, stably ordered. Never undefined — empty means "none". */
  taskRefs: string[];
  branchRefs: string[];
}

/** Strip the display sigil and surrounding whitespace: `" #12.1 "` → `"12.1"`. */
function normalizeRef(raw: string): string {
  return raw.trim().replace(/^#/, "");
}

/**
 * Order task refs the way a human reads a wave: numerically by dotted segment, so `#2` sorts before
 * `#10` instead of after it the way a plain lexicographic `.sort()` would. Non-numeric refs (we
 * accept whatever a caller hands us) fall back to lexicographic and sort after the numbered ones,
 * which keeps the order total and therefore stable across saves.
 */
function compareTaskRefs(a: string, b: string): number {
  const segsA = a.split(".");
  const segsB = b.split(".");
  const numericA = segsA.every((s) => /^\d+$/.test(s));
  const numericB = segsB.every((s) => /^\d+$/.test(s));
  if (numericA !== numericB) return numericA ? -1 : 1;
  if (!numericA) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < Math.max(segsA.length, segsB.length); i++) {
    const na = Number(segsA[i] ?? "0");
    const nb = Number(segsB[i] ?? "0");
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Normalize + dedupe + order a set of refs. The single funnel every mutation goes through. */
function normalizeTaskRefs(refs: readonly string[]): string[] {
  return [...new Set(refs.map(normalizeRef).filter(Boolean))].sort(compareTaskRefs);
}

/**
 * Owns the user-opened-thread → work routing map. Constructed by the Concierge, fed by the
 * gateway's thread-create events and by explicit `&ref` attachments, and consulted on every
 * inbound message and every outbound result.
 */
export class WorkspaceRegistry {
  private readonly log: Logger;
  private readonly stateFile?: string;
  private readonly byThread = new Map<string, StoredWorkspace>();

  constructor(opts: WorkspaceRegistryOptions = {}) {
    this.log = (opts.logger ?? rootLog).child("workspaces");
    this.stateFile = opts.stateFile;
    this.loadState();
  }

  /**
   * Register a user-created thread as a workspace. Idempotent per thread id.
   *
   * A fresh workspace owns NO work. It is a room Beckett listens in without needing an @mention;
   * which work reports there is decided later, and only ever by an authorized person typing
   * `&<ref>` or `&recent`. See the note on {@link StoredWorkspace} for why the thread name is
   * deliberately not consulted.
   */
  registerThread(t: ThreadCreated): void {
    const existing = this.byThread.get(t.threadId);
    if (existing) return; // already a workspace — a re-emitted create event changes nothing
    this.byThread.set(t.threadId, {
      parentChannelId: t.parentChannelId,
      name: t.name,
      runIds: [],
      taskRefs: [],
      branchRefs: [],
    });
    this.log.info("workspace registered from user thread", {
      threadId: t.threadId,
      name: t.name,
      creatorId: t.creatorId,
    });
    this.saveState();
  }

  /**
   * Register a task workspace Beckett deliberately created or adopted. Idempotent per thread, and
   * additive on the thread's task set.
   *
   * This used to STEAL the ref: any other workspace holding the same task was deleted outright, on
   * the assumption that a task thread is Beckett's and there is exactly one. Under the user-owned
   * thread model that assumption is false and the deletion is destructive — the other workspace is
   * a room a person opened and may legitimately hold a dozen other tasks. So we now only withdraw
   * *this* ref from the other workspace and leave it registered with everything else intact.
   */
  registerTaskThread(
    thread: TaskThreadCreated,
    taskRef: string,
    branchRefs: string[] = [],
  ): void {
    const normalizedTask = normalizeRef(taskRef);
    const normalizedBranches = [...new Set(branchRefs.map(normalizeRef).filter(Boolean))];
    const yieldedThreadIds: string[] = [];
    for (const [threadId, workspace] of this.byThread) {
      if (threadId === thread.threadId || !workspace.taskRefs.includes(normalizedTask)) continue;
      workspace.taskRefs = workspace.taskRefs.filter((ref) => ref !== normalizedTask);
      yieldedThreadIds.push(threadId);
    }
    const existing = this.byThread.get(thread.threadId);
    if (existing) {
      existing.taskRefs = normalizeTaskRefs([...existing.taskRefs, normalizedTask]);
      existing.parentChannelId = thread.parentChannelId;
      existing.branchRefs = [...new Set([...existing.branchRefs, ...normalizedBranches])];
      existing.name = thread.name;
    } else {
      this.byThread.set(thread.threadId, {
        parentChannelId: thread.parentChannelId,
        name: thread.name,
        runIds: [],
        taskRefs: normalizeTaskRefs([normalizedTask]),
        branchRefs: normalizedBranches,
      });
    }
    this.log.info("task workspace registered", {
      threadId: thread.threadId,
      task: normalizedTask,
      branches: normalizedBranches,
      yieldedThreadIds,
    });
    this.saveState();
  }

  /**
   * Bind a set of task refs to an already-registered workspace thread — the `&<taskRef>` / `&recent`
   * path, where the person points at a thread they opened and says "report this work here".
   *
   * Additive **within** the target thread (attaching #2 never drops #1) but **exclusive across**
   * threads: every other workspace yields the incoming refs. Why always-exclusive rather than an
   * opt-in flag — `&12` is not "also mention it here", it is a person standing in a room saying
   * *this work lives HERE*, and {@link channelForTask} can only answer with one thread anyway. It
   * resolves ties by Map insertion order, so leaving the ref in an older workspace does not produce
   * shared routing, it produces routing to the OLDER room while Beckett confirms the new one. That
   * is a silent lie the user cannot see: the confirmation says "#12 reports in here now", the
   * grounding is seeded, and then every milestone and every filed receipt keeps landing somewhere
   * else. A flag would only let a caller opt into that failure, so there is no flag. Losing a ref is
   * not lossy for the loser either — it keeps its other work and stays a registered workspace.
   *
   * A thread that is not a registered workspace is a no-op (with a warn), never an implicit
   * registration — registration carries a parent channel id and a creator we do not have here, and
   * inventing one would route results into a channel nobody asked for.
   */
  attachTasks(threadId: string, taskRefs: string[]): void {
    const ws = this.byThread.get(threadId);
    const incoming = normalizeTaskRefs(taskRefs);
    if (!ws) {
      this.log.warn("attachTasks on a non-workspace thread; ignoring", { threadId, tasks: incoming });
      return;
    }
    // Withdraw first, and BEFORE the "nothing new" early return below. The case that matters is the
    // user who re-issues `&12` in this thread *because it didn't work*: the target already holds the
    // ref, so a merge-only path would no-op and routing would stay stuck on the other workspace
    // forever — the command would be permanently unable to fix the very thing it appears to fix.
    // Mirrors registerTaskThread: withdraw just these refs, never the other workspace itself.
    const yieldedThreadIds: string[] = [];
    for (const [otherId, other] of this.byThread) {
      if (otherId === threadId) continue;
      const kept = other.taskRefs.filter((ref) => !incoming.includes(ref));
      if (kept.length === other.taskRefs.length) continue;
      other.taskRefs = kept;
      yieldedThreadIds.push(otherId);
    }
    const merged = normalizeTaskRefs([...ws.taskRefs, ...incoming]);
    const unchanged =
      merged.length === ws.taskRefs.length && merged.every((ref, i) => ref === ws.taskRefs[i]);
    // A withdrawal ALONE is a real state change and must be persisted, even when the target's own
    // set is untouched. Only a fully inert call skips the write, so a repeated `&ref` in the one
    // thread that already owns the work still does not churn the state file.
    if (unchanged && !yieldedThreadIds.length) return;
    ws.taskRefs = merged;
    this.log.info("tasks attached to workspace", { threadId, tasks: merged, yieldedThreadIds });
    this.saveState();
  }

  /**
   * Release every piece of work a thread owns while keeping it a workspace. The thread is still a
   * place Beckett listens without an @mention; it simply no longer routes any results, so the next
   * `&ref` starts from a clean set instead of resurrecting whatever was attached weeks ago.
   */
  detachAll(threadId: string): void {
    const ws = this.byThread.get(threadId);
    if (!ws) return;
    if (!ws.taskRefs.length && !ws.runIds.length && !ws.branchRefs.length) return;
    this.log.info("workspace detached from all work", {
      threadId,
      tasks: ws.taskRefs,
      runs: ws.runIds,
      branches: ws.branchRefs,
    });
    ws.taskRefs = [];
    ws.runIds = [];
    ws.branchRefs = [];
    this.saveState();
  }

  /** Add a public branch ref (and the run executing it, when known) to a task workspace. */
  bindBranch(channelId: string, branchRef: string, runId?: string): void {
    const ws = this.byThread.get(channelId);
    if (!ws) return;
    const normalized = normalizeRef(branchRef);
    if (normalized && !ws.branchRefs.includes(normalized)) ws.branchRefs.push(normalized);
    if (runId && !ws.runIds.includes(runId)) ws.runIds.push(runId);
    this.saveState();
  }

  /**
   * Ground a deployed run in the workspace it was deployed from. No-op when `channelId` is not a
   * registered workspace (a run deployed from a plain channel has no workspace to bind to).
   */
  bindRun(channelId: string, runId: string): void {
    const ws = this.byThread.get(channelId);
    if (!ws || ws.runIds.includes(runId)) return;
    ws.runIds.push(runId);
    this.log.info("run bound to workspace", { threadId: channelId, run: runId });
    this.saveState();
  }

  /** Resolve an inbound Discord channel to its workspace context, if it is one. */
  contextFor(channelId: string): WorkspaceContext | null {
    const ws = this.byThread.get(channelId);
    if (!ws) return null;
    return {
      parentChannelId: ws.parentChannelId,
      name: ws.name,
      runIds: [...ws.runIds].sort(),
      taskRefs: [...ws.taskRefs],
      branchRefs: [...ws.branchRefs].sort(),
    };
  }

  /** Prefer the dedicated task workspace when routing a run milestone. */
  channelForRun(runId: string): string | null {
    for (const [threadId, workspace] of this.byThread) {
      if (workspace.runIds.includes(runId)) return threadId;
    }
    return null;
  }

  /** The thread a task's results belong in, or null to fall back to the origin channel. */
  channelForTask(taskRef: string): string | null {
    const normalized = normalizeRef(taskRef);
    for (const [threadId, workspace] of this.byThread) {
      if (workspace.taskRefs.includes(normalized)) return threadId;
    }
    return null;
  }

  private loadState(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, Record<string, unknown>>;
      for (const [threadId, rec] of Object.entries(raw)) {
        if (typeof rec?.parentChannelId !== "string") continue;
        // Tolerate the pre-wave shape: a scalar `taskRef` migrates into a one-element `taskRefs`.
        // Production state is being wiped, so this costs nothing — but a binding that vanishes on
        // restart is invisible until results post to the wrong channel, and that is worth a branch.
        const storedRefs = Array.isArray(rec.taskRefs)
          ? rec.taskRefs.filter((x): x is string => typeof x === "string")
          : typeof rec.taskRef === "string"
            ? [rec.taskRef]
            : [];
        this.byThread.set(threadId, {
          parentChannelId: rec.parentChannelId,
          name: typeof rec.name === "string" ? rec.name : "",
          // Pre-v7 state files carry `ticketIdents` here. They are dead routing keys (the tracker
          // is gone), so they are read and DROPPED rather than migrated — a tracker identifier can
          // never match a run id, and keeping them would only make `channelForRun` scan noise.
          runIds: Array.isArray(rec.runIds)
            ? rec.runIds.filter((x): x is string => typeof x === "string")
            : [],
          taskRefs: normalizeTaskRefs(storedRefs),
          branchRefs: Array.isArray(rec.branchRefs)
            ? rec.branchRefs.filter((x): x is string => typeof x === "string")
            : [],
        });
      }
    } catch (err) {
      this.log.warn("workspace state load failed; starting fresh", { err: String(err) });
    }
  }

  private saveState(): void {
    if (!this.stateFile) return;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(
        this.stateFile,
        JSON.stringify(Object.fromEntries(this.byThread.entries()), null, 2) + "\n",
        "utf8",
      );
    } catch (err) {
      this.log.warn("workspace state save failed", { err: String(err) });
    }
  }
}

/** Factory matching the repo's `createX` convention. */
export function createWorkspaceRegistry(opts: WorkspaceRegistryOptions = {}): WorkspaceRegistry {
  return new WorkspaceRegistry(opts);
}
