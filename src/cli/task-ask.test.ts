/**
 * W2B — `beckett task ask`: the concierge's one-call lookup for "how's that going?".
 *
 * The command resolves a run by id / slug / linked task ref and reports the cross-session address
 * of its LIVE worker plus the material to answer from records instead (spec.md checklist progress
 * + a journal tail), so the ~90s no-reply fallback costs no second call. It never messages anyone
 * — the concierge session owns that conversation.
 */
import { expect, test } from "bun:test";
import type { Run, RunState } from "../run/types.ts";
import {
  askRun,
  DEFAULT_ASK_QUESTION,
  parseTaskAskArgs,
  resolveRun,
  TaskAskUsageError,
  type AskRunStoreLike,
  type TaskAskDeps,
} from "./task-ask.ts";

function makeRun(over: Partial<Run> = {}): Run {
  const slug = over.slug ?? "oauth-middleware";
  return {
    id: over.id ?? `run-20260810-${slug}`,
    slug,
    title: "add oauth middleware",
    prompt: "add oauth middleware to the gateway",
    channelId: "chan-1",
    requesterId: "user-1",
    taskRef: null,
    ultracode: false,
    cast: null,
    repo: null,
    state: "implementing",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:30:00.000Z",
    workspace: "/tmp/wt/oauth",
    branch: `beckett/run-${slug}`,
    baseSha: null,
    sessionIds: { implement: "sess-1" },
    sessionName: `beckett-run-${slug}`,
    reviewCycles: 0,
    prUrl: null,
    error: null,
    ...over,
  };
}

function fakeDeps(runs: Run[], over: Partial<TaskAskDeps> = {}): TaskAskDeps & { journalCalls: Array<[string, number]> } {
  const journalCalls: Array<[string, number]> = [];
  const store: AskRunStoreLike = {
    get: (id) => runs.find((r) => r.id === id) ?? null,
    bySlug: (slug) => runs.find((r) => r.slug === slug) ?? null,
    list: () => [...runs],
  };
  return {
    store,
    journalCalls,
    readChecklist: () => ({ total: 5, done: 3, hasPlaceholder: false }),
    readJournalTail: (runId, lines) => {
      journalCalls.push([runId, lines]);
      return ["12:00 implement | started", "12:20 implement | edit src/mw.ts"];
    },
    ...over,
  };
}

// ── argv ───────────────────────────────────────────────────────────────────────────────────

test("parseTaskAskArgs: a run reference is required", () => {
  expect(() => parseTaskAskArgs([])).toThrow(TaskAskUsageError);
  expect(() => parseTaskAskArgs(["--question", "hi"])).toThrow(TaskAskUsageError);
});

test("parseTaskAskArgs: --question overrides the doctrine default, valueless --question is a usage error", () => {
  expect(parseTaskAskArgs(["run-1"]).question).toBe(DEFAULT_ASK_QUESTION);
  expect(parseTaskAskArgs(["run-1", "--question", "  are you stuck?  "]).question).toBe("are you stuck?");
  expect(() => parseTaskAskArgs(["run-1", "--question"])).toThrow(TaskAskUsageError);
});

// ── resolution ─────────────────────────────────────────────────────────────────────────────

test("resolveRun: by full id, by slug, and by linked task ref (with or without the #)", () => {
  const linked = makeRun({ slug: "retry-logic", taskRef: "#12.1" });
  const runs = [makeRun(), linked];
  const store = fakeDeps(runs).store;
  expect(resolveRun(store, "run-20260810-oauth-middleware")!.slug).toBe("oauth-middleware");
  expect(resolveRun(store, "oauth-middleware")!.slug).toBe("oauth-middleware");
  expect(resolveRun(store, "#12.1")!.slug).toBe("retry-logic");
  expect(resolveRun(store, "12.1")!.slug).toBe("retry-logic");
  expect(resolveRun(store, "nope")).toBeNull();
});

test("resolveRun: a task ref reused across re-deploys resolves to the LATEST run", () => {
  const older = makeRun({ slug: "retry-logic", taskRef: "#12.1", state: "failed" });
  const newer = makeRun({ slug: "retry-logic-2", taskRef: "#12.1", state: "implementing" });
  const store = fakeDeps([older, newer]).store;
  expect(resolveRun(store, "#12.1")!.slug).toBe("retry-logic-2");
});

test("askRun: an unknown run is a usage error, not a crash", () => {
  expect(() => askRun(["ghost"], fakeDeps([]))).toThrow(TaskAskUsageError);
});

// ── live vs terminal ───────────────────────────────────────────────────────────────────────

test("a LIVE run reports the worker's cross-session address, checklist and journal tail", () => {
  const deps = fakeDeps([makeRun({ state: "implementing" })]);
  const out = askRun(["oauth-middleware"], deps);

  expect(out.live).toBe(true);
  expect(out.sessionName).toBe("beckett-run-oauth-middleware");
  expect(out.state).toBe("implementing");
  expect(out.checklist).toEqual({ total: 5, done: 3, hasPlaceholder: false });
  expect(out.journalTail).toHaveLength(2);
  // The fallback material rides along on the SAME call — no second lookup at the 90s mark.
  expect(deps.journalCalls).toEqual([["run-20260810-oauth-middleware", 15]]);
  expect(out.question).toBe(DEFAULT_ASK_QUESTION);
  // The hint names the address to SendMessage and the channel to relay the answer into.
  expect(out.hint).toContain("beckett-run-oauth-middleware");
  expect(out.hint).toContain("--channel chan-1");
  expect(out.hint).toContain("~90s");
});

test("a reviewing run is live too (its reviewer is a session as much as the implementer)", () => {
  const out = askRun(["oauth-middleware"], fakeDeps([makeRun({ state: "reviewing" })]));
  expect(out.live).toBe(true);
  expect(out.sessionName).toBe("beckett-run-oauth-middleware");
});

test("states with no worker session report live:false and no address to message", () => {
  const noSession: RunState[] = ["queued", "publishing", "done", "failed", "cancelled", "parked"];
  for (const state of noSession) {
    const out = askRun(["oauth-middleware"], fakeDeps([makeRun({ state })]));
    expect(out.live).toBe(false);
    expect(out.sessionName).toBeNull();
    expect(out.state).toBe(state);
    // The records ARE the answer here, so they must still be in the envelope.
    expect(out.checklist).toEqual({ total: 5, done: 3, hasPlaceholder: false });
    expect(out.journalTail).toHaveLength(2);
    expect(out.hint).toContain("do NOT message");
  }
});

test("a terminal run still carries the outcome fields the concierge answers from", () => {
  const out = askRun(
    ["oauth-middleware"],
    fakeDeps([makeRun({ state: "failed", error: "review cycles exhausted", prUrl: null })]),
  );
  expect(out.error).toBe("review cycles exhausted");
  expect(out.branch).toBe("beckett/run-oauth-middleware");
  expect(out.updatedAt).toBe("2026-08-10T12:30:00.000Z");
});

// ── best-effort reads ──────────────────────────────────────────────────────────────────────

test("a missing spec.md / empty journal degrades to nulls, never an error", () => {
  const deps = fakeDeps([makeRun({ workspace: null })], {
    readChecklist: () => null,
    readJournalTail: () => [],
  });
  const out = askRun(["oauth-middleware"], deps);
  expect(out.checklist).toBeNull();
  expect(out.journalTail).toEqual([]);
  expect(out.live).toBe(true); // still addressable — the reads are context, not liveness
});

test("--question rides into the output and the hint verbatim", () => {
  const out = askRun(["oauth-middleware", "--question", "are you blocked on anything?"], fakeDeps([makeRun()]));
  expect(out.question).toBe("are you blocked on anything?");
  expect(out.hint).toContain("are you blocked on anything?");
});
