/**
 * Nightly self-repair: recurrence threshold, clustering, ledger idempotency, dry-run
 * files nothing, and the pass runs even while work is in flight. No harness, no Discord, no git.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import type { Config, Logger, Paths } from "../types.ts";
import { clusterEvents, extractSite, type ErrorEvent } from "./cluster.ts";
import { isFiled, ledgerPath, readLedger, recordFiled, SIGNATURE_MARKER, writeLedger } from "./ledger.ts";
import { runSelfRepair } from "./run.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(): { config: Config; paths: Paths; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-self-repair-"));
  dirs.push(dir);
  const config = defaultConfig();
  config.self_repair.channel_id = "";
  config.free_time.channel_id = "";
  return { config, paths: buildPaths(config, { BECKETT_DIR: dir }), dir };
}

function ev(over: Partial<ErrorEvent> & Pick<ErrorEvent, "message" | "at">): ErrorEvent {
  return { source: "test", site: null, ...over };
}

test("clustering collapses many instances of one signature into one finding", () => {
  const events: ErrorEvent[] = [
    ev({ at: "2026-08-24T01:00:00.000Z", message: "TypeError: x is not a function at src/run/store.ts:88" }),
    ev({ at: "2026-08-24T02:00:00.000Z", message: "TypeError: x is not a function at src/run/store.ts:88" }),
    ev({ at: "2026-08-24T03:00:00.000Z", message: "TypeError: x is not a function at src/run/store.ts:88" }),
    ev({
      at: "2026-08-24T04:00:00.000Z",
      message: "ECONNRESET from github at src/github/poll.ts:12",
    }),
    ev({
      at: "2026-08-24T05:00:00.000Z",
      message: "ECONNRESET from github at src/github/poll.ts:12",
    }),
  ];
  const clusters = clusterEvents(events);
  expect(clusters).toHaveLength(2);
  const store = clusters.find((c) => c.site === "src/run/store.ts:88")!;
  expect(store.count).toBe(3);
  expect(store.occasions).toBe(3);
  expect(store.sample).toContain("TypeError");
});

test("the recurrence threshold drops a one-off and keeps a repeat across occasions", () => {
  const oneOff = clusterEvents([
    ev({ at: "2026-08-24T01:00:00.000Z", message: "unique boom at src/a.ts:1" }),
  ]);
  expect(oneOff).toHaveLength(0);

  const sameMinute = clusterEvents([
    ev({ at: "2026-08-24T01:00:00.000Z", message: "retry storm at src/a.ts:1" }),
    ev({ at: "2026-08-24T01:00:30.000Z", message: "retry storm at src/a.ts:1" }),
  ]);
  expect(sameMinute).toHaveLength(0);

  const twoOccasions = clusterEvents([
    ev({ at: "2026-08-24T01:00:00.000Z", message: "retry storm at src/a.ts:1" }),
    ev({ at: "2026-08-24T01:02:00.000Z", message: "retry storm at src/a.ts:1" }),
  ]);
  expect(twoOccasions).toHaveLength(1);
});

test("the same crash with different run ids is one class", () => {
  const a = clusterEvents([
    ev({ at: "2026-08-24T01:00:00.000Z", message: "failed run-20260824-abc worker wk_deadbeef at src/x.ts:1" }),
    ev({ at: "2026-08-24T02:00:00.000Z", message: "failed run-20260825-xyz worker wk_cafebabe at src/x.ts:1" }),
  ]);
  expect(a).toHaveLength(1);
  expect(a[0]!.count).toBe(2);
  expect(extractSite("boom at src/foo/bar.ts:42:3")).toBe("src/foo/bar.ts:42");
});

test("the ledger prevents re-filing a signature already filed", async () => {
  const w = world();
  const events: ErrorEvent[] = [
    ev({ at: "2026-08-24T01:00:00.000Z", message: "boom at src/x.ts:1" }),
    ev({ at: "2026-08-24T02:00:00.000Z", message: "boom at src/x.ts:1" }),
  ];
  const filed: string[] = [];
  const deps = {
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => new Date("2026-08-24T07:00:00.000Z"),
    collect: async () => events,
    fileRun: async ({ title }: { title: string; prompt: string }) => {
      filed.push(title);
      return { runId: `run-20260824-${filed.length}` };
    },
    listLiveRuns: () => [],
    postShare: async () => {},
  };

  const first = await runSelfRepair(deps);
  expect(first.filed).toHaveLength(1);
  expect(filed).toHaveLength(1);
  const ledger = readLedger(ledgerPath(join(w.paths.beckettDir, "self-repair")));
  expect(isFiled(ledger, first.filed[0]!.signature)).toBe(true);

  const second = await runSelfRepair(deps);
  expect(second.filed).toHaveLength(0);
  expect(second.skippedAlreadyFiled).toContain(first.filed[0]!.signature);
  expect(filed).toHaveLength(1);
});

test("a dry run files nothing and posts nothing", async () => {
  const w = world();
  w.config.free_time.channel_id = "chan-ops";
  let posted = 0;
  let deployed = 0;
  const outcome = await runSelfRepair({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    dry: true,
    now: () => new Date("2026-08-24T07:00:00.000Z"),
    listLiveRuns: () => [
      { prompt: "unrelated implement", title: "live work", state: "implementing" },
    ],
    collect: async () => [
      ev({ at: "2026-08-24T01:00:00.000Z", message: "boom at src/x.ts:1" }),
      ev({ at: "2026-08-24T02:00:00.000Z", message: "boom at src/x.ts:1" }),
    ],
    fileRun: async () => {
      deployed += 1;
      return { runId: "nope" };
    },
    postShare: async () => {
      posted += 1;
    },
  });
  expect(outcome.dry).toBe(true);
  expect(outcome.clusters.length).toBe(1);
  expect(outcome.filed).toEqual([]);
  expect(outcome.entryPath).toBeNull();
  expect(deployed).toBe(0);
  expect(posted).toBe(0);
  expect(readLedger(ledgerPath(join(w.paths.beckettDir, "self-repair"))).filed).toEqual([]);
});

test("the pass runs to completion while other work is in flight", async () => {
  const w = world();
  let deployed = 0;
  const outcome = await runSelfRepair({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => new Date("2026-08-24T07:00:00.000Z"),
    listLiveRuns: () => [
      { prompt: "someone else's ticket", title: "live", state: "implementing" },
    ],
    collect: async () => [
      ev({ at: "2026-08-24T01:00:00.000Z", message: "boom at src/x.ts:1" }),
      ev({ at: "2026-08-24T02:00:00.000Z", message: "boom at src/x.ts:1" }),
    ],
    fileRun: async () => {
      deployed += 1;
      return { runId: "run-in-flight" };
    },
    postShare: async () => {},
  });
  expect(outcome.ran).toBe(true);
  expect(outcome.filed).toHaveLength(1);
  expect(deployed).toBe(1);
});

test("file cap stops the pass from deploying more than configured", async () => {
  const w = world();
  w.config.self_repair.file_cap = 2;
  const events: ErrorEvent[] = [];
  for (const site of ["src/a.ts:1", "src/b.ts:2", "src/c.ts:3"]) {
    events.push(ev({ at: "2026-08-24T01:00:00.000Z", message: `err at ${site}` }));
    events.push(ev({ at: "2026-08-24T02:00:00.000Z", message: `err at ${site}` }));
  }
  const deployed: string[] = [];
  const outcome = await runSelfRepair({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => new Date("2026-08-24T07:00:00.000Z"),
    collect: async () => events,
    fileRun: async ({ prompt }: { title: string; prompt: string }) => {
      deployed.push(prompt);
      return { runId: `run-${deployed.length}` };
    },
    listLiveRuns: () => [],
    postShare: async () => {},
  });
  expect(outcome.clusters.length).toBe(3);
  expect(outcome.filed.length).toBe(2);
  expect(deployed.length).toBe(2);
  expect(deployed[0]).toContain(SIGNATURE_MARKER);
  expect(deployed[0]).toContain("do not merge");
});

test("an open live run for a signature is treated as already filed", async () => {
  const w = world();
  const events: ErrorEvent[] = [
    ev({ at: "2026-08-24T01:00:00.000Z", message: "boom at src/x.ts:1" }),
    ev({ at: "2026-08-24T02:00:00.000Z", message: "boom at src/x.ts:1" }),
  ];
  const clusters = clusterEvents(events);
  const sig = clusters[0]!.signature;
  let deployed = 0;
  const outcome = await runSelfRepair({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => new Date("2026-08-24T07:00:00.000Z"),
    collect: async () => events,
    listLiveRuns: () => [
      { prompt: `${SIGNATURE_MARKER} ${sig}\nfix it`, title: "open", state: "implementing" },
    ],
    fileRun: async () => {
      deployed += 1;
      return { runId: "nope" };
    },
    postShare: async () => {},
  });
  expect(deployed).toBe(0);
  expect(outcome.skippedAlreadyFiled).toContain(sig);
});

test("the share line never dumps a stack or log line", async () => {
  const w = world();
  w.config.free_time.channel_id = "chan-ops";
  let posted = "";
  const outcome = await runSelfRepair({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => new Date("2026-08-24T07:00:00.000Z"),
    collect: async () => [
      ev({ at: "2026-08-24T01:00:00.000Z", message: "Error: ECONNRESET\n    at src/a.ts:1\n    at processTicks" }),
      ev({ at: "2026-08-24T02:00:00.000Z", message: "Error: ECONNRESET\n    at src/a.ts:1\n    at processTicks" }),
    ],
    fileRun: async () => ({ runId: "run-1" }),
    listLiveRuns: () => [],
    postShare: async (_channel: string, text: string) => {
      posted = text;
    },
  });
  expect(posted.startsWith("nightly self-repair:")).toBe(true);
  expect(posted.includes("ECONNRESET")).toBe(false);
  expect(posted.includes("processTicks")).toBe(false);
  expect(posted.endsWith(".")).toBe(false);
  expect(posted).toBe(posted.toLowerCase());
  expect(outcome.shared).toBe(posted);
});

test("sources: journal fail lines become events; successes do not", async () => {
  const w = world();
  mkdirSync(w.paths.journalDir, { recursive: true });
  writeFileSync(
    join(w.paths.journalDir, "run-1.log"),
    [
      "2026-08-24T01:00:00.000Z ▸ implement worker started (sonnet)",
      "2026-08-24T01:01:00.000Z ⚠ implement: TypeError: x is not a function at src/foo.ts:9",
      "2026-08-24T02:01:00.000Z ⚠ implement: TypeError: x is not a function at src/foo.ts:9",
      "2026-08-24T02:02:00.000Z ✓ implement success: all good",
    ].join("\n"),
    "utf8",
  );
  const { collectErrorEvents } = await import("./sources.ts");
  const events = await collectErrorEvents(w.paths, {
    now: new Date("2026-08-24T03:00:00.000Z"),
    lookbackMs: 7 * 24 * 60 * 60_000,
    readJournalctl: async () => [],
  });
  expect(events.length).toBe(2);
  expect(events.every((e) => e.message.includes("TypeError"))).toBe(true);
  expect(clusterEvents(events)).toHaveLength(1);
});

test("recordFiled is last-write-wins per signature", () => {
  const path = join(world().dir, "filed.json");
  let ledger = recordFiled(readLedger(path), {
    signature: "aa",
    filedAt: "t1",
    runId: "r1",
    title: "one",
  });
  ledger = recordFiled(ledger, { signature: "aa", filedAt: "t2", runId: "r2", title: "two" });
  writeLedger(path, ledger);
  const read = readLedger(path);
  expect(read.filed).toHaveLength(1);
  expect(read.filed[0]!.runId).toBe("r2");
});
