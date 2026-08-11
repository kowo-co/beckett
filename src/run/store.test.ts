import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(now?: () => Date): { path: string; store: RunStore } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-runs-"));
  dirs.push(dir);
  const path = join(dir, "runs.json");
  return { path, store: new RunStore(path, now ? { now } : {}) };
}

const CLOCK = () => new Date("2026-08-10T12:00:00.000Z");

describe("create", () => {
  test("mints a date+slug id, branch, and sessionName from the title", async () => {
    const { store } = makeStore(CLOCK);
    const run = await store.create({ title: "OAuth Middleware!!", prompt: "add oauth middleware" });
    expect(run.id).toBe("run-20260810-oauth-middleware");
    expect(run.slug).toBe("oauth-middleware");
    expect(run.branch).toBe("beckett/run-oauth-middleware");
    expect(run.sessionName).toBe("beckett-run-oauth-middleware");
    expect(run.state).toBe("queued");
    expect(run.createdAt).toBe(run.updatedAt);
    expect(run.sessionIds).toEqual({});
    expect(run.reviewCycles).toBe(0);
    expect(run.workspace).toBeNull();
    expect(run.cast).toBeNull();
  });

  test("an explicit slug hint is normalized and preferred over the title", async () => {
    const { store } = makeStore(CLOCK);
    const run = await store.create({ title: "OAuth Middleware", prompt: "…", slug: "  Custom Slug  " });
    expect(run.slug).toBe("custom-slug");
    expect(run.id).toBe("run-20260810-custom-slug");
  });

  test("dedupes slug collisions with -2, -3… across every existing run regardless of date", async () => {
    const { store } = makeStore(CLOCK);
    const first = await store.create({ title: "Retry logic", prompt: "…" });
    const second = await store.create({ title: "Retry logic", prompt: "…" });
    const third = await store.create({ title: "Retry logic", prompt: "…" });
    expect(first.slug).toBe("retry-logic");
    expect(second.slug).toBe("retry-logic-2");
    expect(third.slug).toBe("retry-logic-3");
    expect(second.branch).toBe("beckett/run-retry-logic-2");
    expect(second.sessionName).toBe("beckett-run-retry-logic-2");
    expect(second.id).toBe("run-20260810-retry-logic-2");
  });

  test("passes through optional fields and defaults null/false", async () => {
    const { store } = makeStore(CLOCK);
    const run = await store.create({
      title: "Task",
      prompt: "do the thing",
      channelId: "chan1",
      requesterId: "user1",
      taskRef: "#12.1",
      ultracode: true,
      repo: "some-repo",
      cast: { implement: { harness: "claude", model: "claude-opus-5" } },
    });
    expect(run.channelId).toBe("chan1");
    expect(run.requesterId).toBe("user1");
    expect(run.taskRef).toBe("#12.1");
    expect(run.ultracode).toBe(true);
    expect(run.repo).toBe("some-repo");
    expect(run.cast).toEqual({ implement: { harness: "claude", model: "claude-opus-5" } });
  });
});

describe("get / bySlug / list / live", () => {
  test("get and bySlug read back a created run; unknown ids/slugs return null", async () => {
    const { store } = makeStore(CLOCK);
    const run = await store.create({ title: "Widget", prompt: "…" });
    expect(store.get(run.id)?.slug).toBe("widget");
    expect(store.bySlug("widget")?.id).toBe(run.id);
    expect(store.get("run-nope")).toBeNull();
    expect(store.bySlug("nope")).toBeNull();
  });

  test("list filters by state when given", async () => {
    const { store } = makeStore(CLOCK);
    const a = await store.create({ title: "A", prompt: "…" });
    const b = await store.create({ title: "B", prompt: "…" });
    await store.update(b.id, { state: "done" });
    expect(store.list().map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(store.list({ states: ["done"] }).map((r) => r.id)).toEqual([b.id]);
    expect(store.list({ states: ["queued"] }).map((r) => r.id)).toEqual([a.id]);
  });

  test("live returns only non-terminal runs", async () => {
    const { store } = makeStore(CLOCK);
    const queued = await store.create({ title: "Queued", prompt: "…" });
    const implementing = await store.create({ title: "Implementing", prompt: "…" });
    const done = await store.create({ title: "Done", prompt: "…" });
    const failed = await store.create({ title: "Failed", prompt: "…" });
    const cancelled = await store.create({ title: "Cancelled", prompt: "…" });
    await store.update(implementing.id, { state: "implementing" });
    await store.update(done.id, { state: "done" });
    await store.update(failed.id, { state: "failed" });
    await store.update(cancelled.id, { state: "cancelled" });
    const liveIds = store.live().map((r) => r.id).sort();
    expect(liveIds).toEqual([queued.id, implementing.id].sort());
  });
});

describe("update", () => {
  test("patches fields and bumps updatedAt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-runs-"));
    dirs.push(dir);
    const path = join(dir, "runs.json");
    let clock = Date.parse("2026-08-10T12:00:00.000Z");
    const store = new RunStore(path, { now: () => new Date(clock) });
    const run = await store.create({ title: "Widget", prompt: "…" });
    clock += 60_000;
    const updated = await store.update(run.id, { state: "implementing", workspace: "/tmp/w" });
    expect(updated.state).toBe("implementing");
    expect(updated.workspace).toBe("/tmp/w");
    expect(updated.updatedAt).not.toBe(run.updatedAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(run.updatedAt));
  });

  test("throws for an unknown run id", async () => {
    const { store } = makeStore(CLOCK);
    await expect(store.update("run-nope", { state: "done" })).rejects.toThrow(/no such run/);
  });
});

describe("durability", () => {
  test("a fresh store instance re-reads a run persisted by another instance (atomic write)", async () => {
    const { path, store: first } = makeStore(CLOCK);
    const run = await first.create({ title: "Persisted", prompt: "…" });

    const restored = new RunStore(path);
    expect(restored.get(run.id)?.title).toBe("Persisted");

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.runs).toHaveLength(1);
  });

  test("concurrent creators receive unique ids with no lost writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-runs-"));
    dirs.push(dir);
    const path = join(dir, "runs.json");
    const stores = Array.from({ length: 8 }, () => new RunStore(path));
    const created = await Promise.all(
      stores.map((s, i) => s.create({ title: `Concurrent ${i}`, prompt: "…", slug: `c${i}` })),
    );
    expect(new Set(created.map((r) => r.id)).size).toBe(8);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.runs).toHaveLength(8);
  });

  test("a missing runs.json reads as a fresh empty ledger with no throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-runs-"));
    dirs.push(dir);
    const store = new RunStore(join(dir, "runs.json"));
    expect(store.list()).toEqual([]);
    expect(store.live()).toEqual([]);
  });

  test("a corrupt runs.json degrades to a fresh empty ledger instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-runs-"));
    dirs.push(dir);
    const path = join(dir, "runs.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "{ this is not valid json", "utf8");
    const store = new RunStore(path);
    expect(store.list()).toEqual([]);
  });

  test("a schema-invalid runs.json (e.g. bad state) also degrades to empty rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-runs-"));
    dirs.push(dir);
    const path = join(dir, "runs.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, runs: [{ id: "run-x", state: "not-a-real-state" }] }),
      "utf8",
    );
    const store = new RunStore(path);
    expect(store.list()).toEqual([]);
  });
});
