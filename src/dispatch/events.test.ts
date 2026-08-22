import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchEventBus, formatDispatchEvent, formatDispatchTrace, readDispatchEvents } from "./events.ts";

describe("DispatchEventBus", () => {
  test("persists before asynchronously invoking a failed live sink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-events-"));
    const path = join(dir, "dispatch.jsonl");
    let persistedWhenSinkRan = false;
    const bus = new DispatchEventBus({
      path,
      liveSink: () => {
        persistedWhenSinkRan = readFileSync(path, "utf8").includes('"runId":"ticket-1"');
        throw new Error("Discord unavailable");
      },
      onSinkError: () => {},
    });
    try {
      const event = bus.emit({ runId: "ticket-1", runRef: "OPS-1", branchRef: "beckett/ops-1", stage: "implement", outcome: "started" });
      expect(event.elapsedMs).toBe(0);
      expect(readDispatchEvents(path, "OPS-1")).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(persistedWhenSinkRan).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("emitEphemeral notifies the live sink without touching the durable ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-dispatch-events-"));
    const path = join(dir, "dispatch.jsonl");
    const seen: string[] = [];
    const bus = new DispatchEventBus({ path, liveSink: (event) => void seen.push(event.stage) });
    try {
      bus.emit({ runId: "run-1", runRef: "run-1", branchRef: "b", stage: "implement", outcome: "started" });
      const blurb = bus.emitEphemeral({
        runId: "run-1",
        runRef: "run-1",
        branchRef: "b",
        stage: "activity",
        outcome: "info",
        message: "editing index.html",
      });
      expect(blurb.message).toBe("editing index.html");
      expect(blurb.ts).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toEqual(["implement", "activity"]);
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
      expect(readDispatchEvents(path, "run-1").map((e) => e.stage)).toEqual(["implement"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trace is ordered and failures render as an unmistakable alert", () => {
    const events = [
      { ts: "2026-01-01T00:00:00.000Z", runId: "ticket-1", runRef: "OPS-1", branchRef: "beckett/ops-1", stage: "implement", outcome: "started" as const, elapsedMs: 0 },
      { ts: "2026-01-01T00:10:00.000Z", runId: "ticket-1", runRef: "OPS-1", branchRef: "beckett/ops-1", stage: "implement:timeout", outcome: "failed" as const, elapsedMs: 600000, error: "worker hard-cap timeout" },
    ];
    expect(formatDispatchEvent(events[1]!)).toContain("🚨 ALERT");
    expect(formatDispatchTrace(events, "OPS-1")).toContain("implement:timeout");
  });

  // #4: the channel gets the digest; `beckett ticket trace` keeps the whole forensic row —
  // including what a restart-killed worker was saying when the daemon took it down.
  test("an interrupted run keeps its full detail in the trace without an alert", () => {
    const event = {
      ts: "2026-01-01T00:22:04.000Z",
      runId: "ticket-1",
      runRef: "#2.1",
      branchRef: "beckett/task-2-1",
      stage: "implement",
      outcome: "interrupted" as const,
      elapsedMs: 1_324_000,
      message: "worker exited with error (stopped by a daemon restart)",
      error: "I'll start by getting oriented in the repo.",
    };
    const line = formatDispatchEvent(event);
    expect(line).not.toContain("ALERT");
    expect(line).toContain("INTERRUPTED");
    expect(line).toContain("getting oriented");
  });

  // The ledger is append-only and predates the ticket rip-out, so a live `dispatch.jsonl` holds
  // rows keyed `ticketId`/`ticketRef`. History must stay traceable without rewriting the file.
  test("pre-v7 rows keyed ticketId/ticketRef read back on the run keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-events-legacy-"));
    try {
      const path = join(dir, "dispatch.jsonl");
      writeFileSync(
        path,
        JSON.stringify({
          ts: "2026-01-01T00:00:00.000Z", ticketId: "tkt-1", ticketRef: "OPS-1",
          branchRef: "beckett/ops-1", stage: "implement", outcome: "started", elapsedMs: 0,
        }) + "\n",
        "utf8",
      );
      const [row] = readDispatchEvents(path, "OPS-1");
      expect(row).toBeDefined();
      expect(row!.runId).toBe("tkt-1");
      expect(row!.runRef).toBe("OPS-1");
      expect(row).not.toHaveProperty("ticketId");
      // Reachable by the id as well as the ref, exactly as a current row is.
      expect(readDispatchEvents(path, "tkt-1")).toHaveLength(1);
      expect(formatDispatchTrace(readDispatchEvents(path, "OPS-1"), "OPS-1")).toContain("OPS-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
