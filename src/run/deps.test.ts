import { describe, expect, test } from "bun:test";
import { pathOverlaps, readiness } from "./deps.ts";
import type { Run } from "./types.ts";

function run(over: Partial<Run> = {}): Run {
  const slug = over.slug ?? "r";
  return {
    id: over.id ?? `run-20260810-${slug}`,
    slug,
    title: "t",
    prompt: "p",
    channelId: null,
    requesterId: null,
    taskRef: null,
    ultracode: false,
    cast: null,
    repo: over.repo === undefined ? "gateway" : over.repo,
    state: over.state ?? "queued",
    createdAt: over.createdAt ?? "2026-08-10T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-08-10T00:00:00.000Z",
    workspace: null,
    branch: `beckett/run-${slug}`,
    baseSha: null,
    sessionIds: {},
    sessionName: `beckett-run-${slug}`,
    reviewCycles: 0,
    continuations: 0,
    autoResumes: 0,
    prUrl: null,
    error: null,
    published: null,
    blocker: null,
    question: null,
    proof: null,
    landingMode: null,
    deps: over.deps ?? [],
    files: over.files ?? [],
  };
}

describe("pathOverlaps", () => {
  test("an exact path collision is an overlap", () => {
    expect(pathOverlaps(["src/cli/core.ts"], ["src/cli/core.ts"])).toEqual(["src/cli/core.ts"]);
  });

  test("a directory prefix contains the file under it, in both directions", () => {
    expect(pathOverlaps(["src/run/"], ["src/run/types.ts"])).toEqual(["src/run/types.ts"]);
    expect(pathOverlaps(["src/run/types.ts"], ["src/run/"])).toEqual(["src/run/types.ts"]);
  });

  test("no overlap between unrelated paths", () => {
    expect(pathOverlaps(["src/cli/core.ts"], ["src/run/types.ts"])).toEqual([]);
  });
});

describe("readiness", () => {
  test("a run with no declared files never collides", () => {
    const a = run({ id: "run-a", state: "queued", files: [] });
    const b = run({ id: "run-b", state: "implementing", files: ["src/run/supervisor.ts"] });
    expect(readiness(a, [a, b])).toEqual({ ready: true, waitsOn: [], autoDeps: [] });
  });

  test("a done sibling is not a blocker", () => {
    const a = run({ id: "run-a", state: "queued", deps: ["run-b"] });
    const b = run({ id: "run-b", state: "done" });
    expect(readiness(a, [a, b])).toEqual({ ready: true, waitsOn: [], autoDeps: [] });
  });

  test("an explicit dep that failed keeps the dependent waiting", () => {
    const a = run({ id: "run-a", state: "queued", deps: ["run-b"] });
    const b = run({ id: "run-b", state: "failed" });
    const result = readiness(a, [a, b]);
    expect(result.ready).toBe(false);
    expect(result.waitsOn).toEqual(["run-b"]);
  });

  test("a cancelled explicit dep clears — it is never coming back", () => {
    const a = run({ id: "run-a", state: "queued", deps: ["run-b"] });
    const b = run({ id: "run-b", state: "cancelled" });
    expect(readiness(a, [a, b])).toEqual({ ready: true, waitsOn: [], autoDeps: [] });
  });

  test("a sibling still `queued` in the ledger but already staffing in memory counts as in flight", () => {
    // Two runs deployed back-to-back with overlapping files: the first is admitted and mid-spawn
    // (worktree being cut) while its ledger row still says `queued`. Without the in-flight set the
    // second would pass the gate and both would run on the same files.
    const a = run({ id: "run-a", state: "queued", files: ["src/run/supervisor.ts"], createdAt: "2026-08-16T00:01:00.000Z" });
    const b = run({ id: "run-b", state: "queued", files: ["src/run/"], createdAt: "2026-08-16T00:00:00.000Z" });
    expect(readiness(a, [a, b]).ready).toBe(true);
    const result = readiness(a, [a, b], new Set(["run-b"]));
    expect(result.ready).toBe(false);
    expect(result.waitsOn).toEqual(["run-b"]);
    expect(result.autoDeps).toEqual(["run-b"]);
  });

  test("a run whose files overlap an in-flight sibling on the same repo waits, and records the auto dep", () => {
    const a = run({ id: "run-a", state: "queued", files: ["src/run/supervisor.ts"] });
    const b = run({ id: "run-b", state: "reviewing", files: ["src/run/"] });
    const result = readiness(a, [a, b]);
    expect(result.ready).toBe(false);
    expect(result.waitsOn).toEqual(["run-b"]);
    expect(result.autoDeps).toEqual(["run-b"]);
  });

  test("overlapping files on a DIFFERENT repo never collide", () => {
    const a = run({ id: "run-a", state: "queued", repo: "gateway", files: ["src/run/supervisor.ts"] });
    const b = run({ id: "run-b", state: "reviewing", repo: "other", files: ["src/run/"] });
    expect(readiness(a, [a, b])).toEqual({ ready: true, waitsOn: [], autoDeps: [] });
  });

  test("an in-flight sibling with no declared files is never an auto dep", () => {
    const a = run({ id: "run-a", state: "queued", files: ["src/run/supervisor.ts"] });
    const b = run({ id: "run-b", state: "implementing", files: [] });
    expect(readiness(a, [a, b])).toEqual({ ready: true, waitsOn: [], autoDeps: [] });
  });

  test("a failed sibling with overlapping files does not block — the auto edge is not a persisted dep", () => {
    // Finding 22: the auto edge is recomputed from `run.files` on every call and never written
    // into `run.deps`, so once the sibling leaves an in-flight state the overlap simply stops
    // being reported — there is no stale persisted `deps` entry left to clear.
    const a = run({ id: "run-a", state: "queued", files: ["src/run/supervisor.ts"] });
    const b = run({ id: "run-b", state: "failed", files: ["src/run/"] });
    expect(readiness(a, [a, b])).toEqual({ ready: true, waitsOn: [], autoDeps: [] });
  });

  test("a sibling `awaiting_input` with overlapping files blocks admission", () => {
    const a = run({ id: "run-a", state: "queued", files: ["src/run/supervisor.ts"] });
    const b = run({ id: "run-b", state: "awaiting_input", files: ["src/run/"] });
    const result = readiness(a, [a, b]);
    expect(result.ready).toBe(false);
    expect(result.autoDeps).toEqual(["run-b"]);
  });

  test("a sibling `parked` with overlapping files blocks admission", () => {
    const a = run({ id: "run-a", state: "queued", files: ["src/run/supervisor.ts"] });
    const b = run({ id: "run-b", state: "parked", files: ["src/run/"] });
    const result = readiness(a, [a, b]);
    expect(result.ready).toBe(false);
    expect(result.autoDeps).toEqual(["run-b"]);
  });

  test("a dependency cycle is broken, newest run waits", () => {
    const older = run({ id: "run-a", createdAt: "2026-08-10T00:00:00.000Z", deps: ["run-b"] });
    const newer = run({ id: "run-b", createdAt: "2026-08-11T00:00:00.000Z", deps: ["run-a"] });
    const older_result = readiness(older, [older, newer]);
    expect(older_result.ready).toBe(true);
    const newer_result = readiness(newer, [older, newer]);
    expect(newer_result.ready).toBe(false);
    expect(newer_result.waitsOn).toEqual(["run-a"]);
  });
});
