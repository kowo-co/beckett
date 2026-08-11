/**
 * Beckett — `beckett task ask` (`src/cli/task-ask.ts`)
 * =======================================================================================
 * The concierge's LOOKUP for "hey, how's that middleware going?" (W2B). Someone asks about work
 * in flight; the concierge resolves the run and gets, in ONE call, everything it needs to either
 * ask the live worker directly or answer from records:
 *
 *   {runId, state, live, sessionName, checklist, journalTail, question, hint}
 *
 * WHAT THIS COMMAND DELIBERATELY DOES NOT DO: message the worker. The concierge session owns that
 * conversation — it has its own `SendMessage` tool and its own cross-session address, so IT sends
 * (addressed to `sessionName`) and IT receives the reply as a peer turn. A CLI subprocess can't
 * receive the answer at all: it would have to spawn a session, hold a socket, and hand the reply
 * back through stdout, which is a second messaging path for no gain. So this prints the address
 * and the fallback material, and the model does the talking.
 *
 * FALLBACK IS ALWAYS IN THE ENVELOPE (W2B deliverable 4): doctrine gives a peer reply ~90s before
 * the concierge answers from records instead. That fallback must not cost another round trip, so
 * `checklist` (spec.md progress) and `journalTail` (the last ~15 worker journal lines) ride along
 * on every invocation — live or not. A run that is queued, done, failed or parked has no worker to
 * message: `live` is false, `sessionName` is null, and the same fields carry the whole answer.
 */
import type { Run, RunState } from "../run/types.ts";
import { fail, out, parse } from "./io.ts";

export const TASK_ASK_USAGE = 'usage: beckett task ask <runId|slug|#N.x> [--question "…"]';

/** Journal lines carried for the answer-from-records fallback (deliberately a tail, not a dump). */
export const ASK_JOURNAL_TAIL_LINES = 15;

/**
 * The run states where a worker session is actually LIVE and addressable. `queued` has no worker
 * yet; `publishing` is Beckett's own push/PR step (the worker is gone); `done`/`failed`/
 * `cancelled`/`parked` are over. Only these two mean "there is someone in there to ask".
 */
const ASKABLE_STATES: ReadonlySet<RunState> = new Set<RunState>(["implementing", "reviewing"]);

/** The question doctrine (W3B) asks with when the caller supplies none. */
export const DEFAULT_ASK_QUESTION =
  "where are you at, and how much longer? answer in 2-4 sentences, then continue working.";

/** A usage problem, raised so {@link runTaskAsk} owns the single `fail()` (helpers stay testable). */
export class TaskAskUsageError extends Error {}

function usage(msg: string): never {
  throw new TaskAskUsageError(`${msg}\n${TASK_ASK_USAGE}`);
}

/** The minimal slice of the real `RunStore` (`../run/store.ts`) this CLI reads. */
export interface AskRunStoreLike {
  get(id: string): Run | null;
  bySlug(slug: string): Run | null;
  list(): Run[];
}

export interface TaskAskDeps {
  store: AskRunStoreLike;
  /** The run's journal play-by-play, most recent `lines` lines (see `../progress/journal.ts`). */
  readJournalTail: (runId: string, lines: number) => string[];
  /**
   * spec.md checklist progress for a workspace; null when there's no readable spec.md yet.
   * Injected rather than read here so this module stays pure — `core.ts` already owns the one
   * reader (`readRunChecklist`, the `../run/spec-file.ts` codec `task show` and the spec-gate
   * hook agree on), and a second copy could drift from it.
   */
  readChecklist: (workspace: string | null) => AskChecklist | null;
}

export interface AskChecklist {
  total: number;
  done: number;
  hasPlaceholder: boolean;
}

export interface TaskAskOutput {
  runId: string;
  slug: string;
  title: string;
  state: RunState;
  /** True iff a worker session is live and addressable at {@link sessionName}. */
  live: boolean;
  /** The cross-session address to `SendMessage`, or null when nothing is live to ask. */
  sessionName: string | null;
  /** The question to put to the worker (`--question`, else {@link DEFAULT_ASK_QUESTION}). */
  question: string;
  /** Origin channel — the concierge relays the answer back here with `beckett discord reply`. */
  channelId: string | null;
  branch: string;
  workspace: string | null;
  prUrl: string | null;
  error: string | null;
  updatedAt: string;
  checklist: AskChecklist | null;
  journalTail: string[];
  /** What to do with all of the above, in one line — the model reads this first. */
  hint: string;
}

export interface TaskAskInput {
  ref: string;
  question: string;
}

/** Parse + validate `beckett task ask`'s argv. Pure. */
export function parseTaskAskArgs(argv: string[]): TaskAskInput {
  const { _, flags } = parse(argv);
  const ref = (_[0] ?? "").trim();
  if (!ref) usage("a run is required: pass its id, slug, or linked task ref");
  const raw = flags.question;
  if (raw === true) usage("--question needs a value");
  const question = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_ASK_QUESTION;
  return { ref, question };
}

/** `#12.1` / `12.1` / `#12` — a public task ref, the third way to name a run. */
function isTaskRef(ref: string): boolean {
  return /^#?\d+(\.\d+)*$/.test(ref);
}

/**
 * Resolve a run by id (`run-…`), slug, or linked task ref (`#N.x`). Tried in that order, and a
 * miss falls through to the next form rather than failing early: the concierge types whichever
 * handle it has in front of it, and a slug like `run-oauth` is a legal slug as well as an id
 * prefix. Returns null when nothing matches.
 */
export function resolveRun(store: AskRunStoreLike, ref: string): Run | null {
  const key = ref.trim();
  if (!key) return null;
  if (key.startsWith("run-")) {
    const byId = store.get(key);
    if (byId) return byId;
  }
  if (isTaskRef(key)) {
    const wanted = key.startsWith("#") ? key : `#${key}`;
    // The NEWEST match wins (`list()` is createdAt-ascending): one task ref can be re-deployed
    // more than once, and "how's that going?" always means the run happening now.
    const matches = store.list().filter((run) => run.taskRef === wanted);
    return matches[matches.length - 1] ?? null;
  }
  return store.bySlug(key) ?? store.get(key);
}

function hintFor(run: Run, live: boolean, sessionName: string | null, question: string): string {
  if (live) {
    return (
      `SendMessage to "${sessionName}": "${question}"` +
      (run.channelId ? ` — then relay the answer with \`beckett discord reply --channel ${run.channelId}\`.` : ".") +
      ` If no reply lands within ~90s, answer from the checklist and journalTail below instead.`
    );
  }
  return (
    `No live worker session for this run (state "${run.state}") — do NOT message anyone; ` +
    `answer from the state, checklist and journalTail below.`
  );
}

/**
 * The decision logic behind `beckett task ask`, minus the `out()`/`process.exit`. Throws
 * {@link TaskAskUsageError} on a bad invocation or an unknown run; the caller
 * ({@link runTaskAsk}) is the only one that turns that into `fail()`.
 */
export function askRun(argv: string[], deps: TaskAskDeps): TaskAskOutput {
  const { ref, question } = parseTaskAskArgs(argv);
  const run = resolveRun(deps.store, ref);
  if (!run) usage(`no such run: ${ref}`);
  const live = ASKABLE_STATES.has(run.state);
  const sessionName = live ? run.sessionName : null;
  return {
    runId: run.id,
    slug: run.slug,
    title: run.title,
    state: run.state,
    live,
    sessionName,
    question,
    channelId: run.channelId,
    branch: run.branch,
    workspace: run.workspace,
    prUrl: run.prUrl,
    error: run.error,
    updatedAt: run.updatedAt,
    checklist: deps.readChecklist(run.workspace),
    journalTail: deps.readJournalTail(run.id, ASK_JOURNAL_TAIL_LINES),
    hint: hintFor(run, live, sessionName, question),
  };
}

/** The verb: JSON on stdout, `error: …` on stderr — same contract as every other CLI verb. */
export function runTaskAsk(argv: string[], deps: TaskAskDeps): void {
  try {
    out(askRun(argv, deps));
  } catch (err) {
    if (err instanceof TaskAskUsageError) fail(err.message);
    throw err;
  }
}
