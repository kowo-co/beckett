/**
 * The nightly dream pass: both conservatism caps (adds and maintenance), the provenance
 * requirement, the absence of a busy gate (it runs at its time), the shape of the one Discord
 * line, and what `--dry` does and does not touch — including the spend row it DOES write.
 * Everything here is either a pure function or an injected-harness run — no real `claude`
 * process, no Discord, no git commit noise beyond the in-memory MemoryStore's own tmpdir repo.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import type { Config, Logger, Paths } from "../types.ts";
import { createMemory } from "../memory/index.ts";
import { createChannelContextStore, type ChannelEntry } from "../concierge/channel-context.ts";
import { listDreamEntries, readDreamEntry } from "./journal.ts";
import { channelSourceId } from "./assemble.ts";
import {
  dreamMemoryName,
  planDreamMaintenance,
  planDreamMemories,
  renderReportLine,
  runDreamPass,
  type DreamRunDeps,
  type DreamRunOutcome,
} from "./run.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-19T12:00:00.000Z"); // 05:00 America/Los_Angeles
const DATE = "2026-08-19";

function world(): { config: Config; paths: Paths; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dream-run-"));
  dirs.push(dir);
  const config = defaultConfig();
  return { config, paths: buildPaths(config, { BECKETT_DIR: dir }), dir };
}

function seedChannel(paths: Paths, channelId: string, entries: ChannelEntry[]): void {
  const channels = createChannelContextStore({
    channelsDir: paths.channelsDir,
    maxEntriesPerChannel: 500,
    maxAgeHours: 24 * 30,
    logger: quiet,
    now: () => NOW.getTime(),
  });
  channels.noteMeta(channelId, { name: "general", guildId: "999" });
  for (const e of entries) channels.append(channelId, e);
}

function entry(over: Partial<ChannelEntry> & { messageId: string; ts: number }): ChannelEntry {
  return { authorId: "111", authorName: "jason", content: "hey", kind: "user", ...over };
}

function baseDeps(over: Partial<DreamRunDeps> = {}): DreamRunDeps {
  const { config, paths } = world();
  return {
    config,
    paths,
    logger: quiet,
    now: () => NOW,
    memory: createMemory({ memoryDir: paths.memoryDir, git: false, logger: quiet }),
    channels: null, // no sessions by default — the quiet-day path
    journalDir: null, // the other two logs are opted into per-test
    dispatchLedger: null,
    callModel: async () => ({ text: JSON.stringify({ summary: "quiet", memories: [] }), outputTokens: 10 }),
    postShare: async () => {},
    ...over,
  };
}

/** A DreamRunOutcome shaped just enough for `renderReportLine`, with the splits defaulted. */
function outcome(over: Partial<DreamRunOutcome>): DreamRunOutcome {
  return {
    quiet: false,
    sessionsReviewed: 0,
    memoriesWritten: [],
    memoriesPlanned: [],
    memoriesUpdated: [],
    memoriesRetired: [],
    flagsWritten: [],
    maintenancePlanned: [],
    ...over,
  } as unknown as DreamRunOutcome;
}

// ── the conservatism cap (requirement 3) ──────────────────────────────────────────────────

test("planDreamMemories enforces the per-night cap by position, dropping the rest with a reason", () => {
  const known = new Set(["channel:c:1", "channel:c:2", "channel:c:3"]);
  const entries = [
    { slug: "a", description: "decision a", provenance: ["channel:c:1"] },
    { slug: "b", description: "decision b", provenance: ["channel:c:2"] },
    { slug: "c", description: "decision c — over the cap", provenance: ["channel:c:3"] },
  ];
  const plan = planDreamMemories(entries, { date: DATE, max: 2, knownSourceIds: known });
  expect(plan.keep.map((m) => m.name)).toEqual([dreamMemoryName(DATE, "a")!, dreamMemoryName(DATE, "b")!]);
  expect(plan.dropped).toHaveLength(1);
  expect(plan.dropped[0]).toContain("conservatism cap");
});

// ── provenance is required and non-empty (requirement 2) ─────────────────────────────────

test("planDreamMemories drops a candidate with no provenance", () => {
  const plan = planDreamMemories(
    [{ slug: "x", description: "a fact", provenance: [] }],
    { date: DATE, max: 5, knownSourceIds: new Set() },
  );
  expect(plan.keep).toHaveLength(0);
  expect(plan.dropped[0]).toContain("no provenance");
});

test("planDreamMemories drops a candidate whose provenance names a source that was never assembled", () => {
  const plan = planDreamMemories(
    [{ slug: "x", description: "a fact", provenance: ["channel:made-up:999"] }],
    { date: DATE, max: 5, knownSourceIds: new Set(["channel:real:1"]) },
  );
  expect(plan.keep).toHaveLength(0);
  expect(plan.dropped[0]).toContain("unknown sources");
});

test("planDreamMemories keeps a well-formed candidate with real provenance", () => {
  const plan = planDreamMemories(
    [{ slug: "Jason Prefers Terse Updates", description: "jason prefers terse updates", note: "seen twice", provenance: ["channel:c:1", "channel:c:2"] }],
    { date: DATE, max: 5, knownSourceIds: new Set(["channel:c:1", "channel:c:2"]) },
  );
  expect(plan.keep).toHaveLength(1);
  expect(plan.keep[0]!.name).toBe(`dream-${DATE}-jason-prefers-terse-updates`);
  expect(plan.keep[0]!.provenance).toEqual(["channel:c:1", "channel:c:2"]);
});

// ── NO busy gate: the pass runs at its time (ro's call — the old skip is gone) ────────────

test("the pass RUNS while work is in flight — a live fleet no longer refuses it", async () => {
  // The world this used to refuse in: a run ledger with a live run, a busy box. There is no
  // busy signal to inject any more (`src/dream/gate.ts` is deleted), so the only thing that
  // could refuse tonight would be a code path that reads the fleet itself — and there is none.
  const deps = baseDeps();
  const channels = createChannelContextStore({
    channelsDir: deps.paths.channelsDir,
    maxEntriesPerChannel: 500,
    maxAgeHours: 24 * 30,
    logger: quiet,
    now: () => NOW.getTime(),
  });
  channels.noteMeta("chan-1", { name: "general", guildId: "999" });
  channels.append("chan-1", entry({ messageId: "m1", ts: NOW.getTime() - 60_000, content: "ship on fridays" }));
  writeFileSync(
    join(deps.paths.beckettDir, "runs.json"),
    JSON.stringify({ version: 1, runs: [{ id: "run_live", status: "running" }] }),
  );

  let modelCalled = false;
  let posted = false;
  const result = await runDreamPass({
    ...deps,
    channels,
    callModel: async () => {
      modelCalled = true;
      return {
        text: JSON.stringify({
          summary: "jason set a shipping cadence",
          memories: [
            {
              slug: "ship-on-fridays",
              description: "jason wants releases shipped on fridays",
              provenance: [channelSourceId("chan-1", "m1")],
            },
          ],
        }),
        outputTokens: 42,
      };
    },
    postShare: async () => {
      posted = true;
    },
  });

  expect(result.refused).toBeNull();
  expect(modelCalled).toBe(true);
  expect(result.wrote).toBe(true);
  expect(posted).toBe(true);
  expect(result.memoriesWritten).toEqual([`dream-${DATE}-ship-on-fridays`]);
});

test("a --dry run is not gated either: it builds the prompt with work in flight", async () => {
  const deps = baseDeps();
  const channels = createChannelContextStore({
    channelsDir: deps.paths.channelsDir,
    maxEntriesPerChannel: 500,
    maxAgeHours: 24 * 30,
    logger: quiet,
    now: () => NOW.getTime(),
  });
  channels.noteMeta("chan-1", { name: "general", guildId: "999" });
  channels.append("chan-1", entry({ messageId: "m1", ts: NOW.getTime() - 60_000 }));
  writeFileSync(
    join(deps.paths.beckettDir, "runs.json"),
    JSON.stringify({ version: 1, runs: [{ id: "run_live", status: "running" }] }),
  );

  const result = await runDreamPass({ ...deps, channels, dry: true });
  expect(result.refused).toBeNull();
  expect(result.prompt.length).toBeGreaterThan(0);
});

// ── `--dry` writes nothing and posts nothing ──────────────────────────────────────────────

test("--dry builds the prompt and the plan but writes no entry, no memory, and posts nothing", async () => {
  const deps = baseDeps();
  seedChannel(deps.paths, "chan-1", [
    entry({ messageId: "m1", ts: NOW.getTime() - 60_000, content: "jason: from now on ship on fridays" }),
  ]);
  let posted = false;
  const outcome = await runDreamPass({
    ...deps,
    channels: createChannelContextStore({
      channelsDir: deps.paths.channelsDir,
      maxEntriesPerChannel: 500,
      maxAgeHours: 24 * 30,
      logger: quiet,
      now: () => NOW.getTime(),
    }),
    callModel: async () => ({
      text: JSON.stringify({
        summary: "jason set a shipping cadence",
        memories: [
          {
            slug: "ship-on-fridays",
            description: "jason wants releases shipped on fridays",
            provenance: [channelSourceId("chan-1", "m1")],
          },
        ],
      }),
      outputTokens: 42,
    }),
    postShare: async () => {
      posted = true;
    },
    dry: true,
  });

  expect(outcome.dry).toBe(true);
  expect(outcome.wrote).toBe(false);
  expect(outcome.path).toBeNull();
  expect(outcome.prompt.length).toBeGreaterThan(0);
  expect(outcome.memoriesWritten).toEqual([`dream-${DATE}-ship-on-fridays`]);
  expect(posted).toBe(false);
  expect(listDreamEntries(join(deps.paths.beckettDir, "dreams"))).toHaveLength(0);

  // Nothing landed in the memory graph either — `--dry` never calls rememberDream.
  const g = deps.memory!.buildGraph();
  expect(g.nodes.has(`dream-${DATE}-ship-on-fridays`)).toBe(false);
});

// ── a real run: quiet night ────────────────────────────────────────────────────────────────

test("a quiet night (no sessions) writes a thin entry, calls no model, and posts the quiet line", async () => {
  let modelCalled = false;
  const deps = baseDeps({
    callModel: async () => {
      modelCalled = true;
      return { text: "{}", outputTokens: 1 };
    },
  });
  const outcome = await runDreamPass(deps);
  expect(outcome.quiet).toBe(true);
  expect(outcome.wrote).toBe(true);
  expect(modelCalled).toBe(false);
  expect(outcome.shared).toBe(renderReportLine(outcome));
  expect(readDreamEntry(join(deps.paths.beckettDir, "dreams"), DATE)).toContain("Nothing in the window");
});

// ── a real run: sessions worth keeping ─────────────────────────────────────────────────────

test("a real run with real sessions commits through rememberDream and posts one short line", async () => {
  const deps = baseDeps();
  const channels = createChannelContextStore({
    channelsDir: deps.paths.channelsDir,
    maxEntriesPerChannel: 500,
    maxAgeHours: 24 * 30,
    logger: quiet,
    now: () => NOW.getTime(),
  });
  channels.noteMeta("chan-1", { name: "general", guildId: "999" });
  channels.append("chan-1", entry({ messageId: "m1", ts: NOW.getTime() - 60_000, content: "jason: from now on ship on fridays" }));

  const outcome = await runDreamPass({
    ...deps,
    channels,
    callModel: async () => ({
      text: JSON.stringify({
        summary: "jason set a shipping cadence",
        memories: [
          {
            slug: "ship-on-fridays",
            description: "jason wants releases shipped on fridays",
            provenance: [channelSourceId("chan-1", "m1")],
          },
        ],
      }),
      outputTokens: 42,
    }),
  });

  expect(outcome.wrote).toBe(true);
  expect(outcome.memoriesWritten).toEqual([`dream-${DATE}-ship-on-fridays`]);
  expect(outcome.shared).not.toBeNull();
  expect(outcome.shared).not.toContain("m1"); // never a raw session/message id in the Discord line
  expect(outcome.shared).not.toContain("jason: from now on"); // never a transcript dump

  const node = deps.memory!.buildGraph().nodes.get(`dream-${DATE}-ship-on-fridays`)!;
  expect(node.type).toBe("dream");
  expect(node.metadata.inference).toBe(true);
  expect(node.metadata.provenance).toEqual([channelSourceId("chan-1", "m1")]);

  const raw = readFileSync(outcome.path!, "utf8");
  expect(raw).toContain(`dream-${DATE}-ship-on-fridays`);
});

// ── the Discord line never dumps raw content (requirement 5) ─────────────────────────────

/** The longest line `renderReportLine` may ever emit — mirrors REPORT_LINE_MAX_CHARS in run.ts. */
const LINE_MAX = 180;

test("renderReportLine is always a short, lowercase line and never echoes provenance/content", () => {
  expect(renderReportLine(outcome({ quiet: true }))).not.toMatch(/[A-Z]/);

  const nothingKept = outcome({ sessionsReviewed: 3 });
  expect(renderReportLine(nothingKept)).toContain("3");

  const kept = outcome({
    sessionsReviewed: 2,
    memoriesWritten: ["dream-2026-08-19-a", "dream-2026-08-19-b"],
  });
  const line = renderReportLine(kept);
  expect(line).toContain("2");
  expect(line).not.toContain("dream-2026-08-19-a");
});

test("renderReportLine says WHY, not just how many — the why-clause is the accepted descriptions", () => {
  const line = renderReportLine(
    outcome({
      sessionsReviewed: 2,
      memoriesWritten: ["dream-2026-08-19-a"],
      memoriesPlanned: [
        { name: "dream-2026-08-19-a", description: "jason wants releases shipped on fridays", body: "", provenance: ["channel:c:1"] },
      ],
    }),
  );
  expect(line).toBe("dreamed on 2 channels from yesterday, kept 1 note: jason wants releases shipped on fridays");
});

test("renderReportLine lowercases capitals and strips a trailing period the model wrote", () => {
  const line = renderReportLine(
    outcome({
      sessionsReviewed: 1,
      memoriesWritten: ["dream-2026-08-19-a"],
      memoriesPlanned: [
        { name: "dream-2026-08-19-a", description: "Jason Prefers Terse Updates.", body: "", provenance: ["channel:c:1"] },
      ],
    }),
  );
  expect(line).toBe("dreamed on 1 channel from yesterday, kept 1 note: jason prefers terse updates");
  expect(line).not.toMatch(/[A-Z]/);
  expect(line.endsWith(".")).toBe(false);
});

test("renderReportLine caps the JOINED line, not merely each item — three memories stay one line", () => {
  const long = (n: number) =>
    `Decision ${n}: the team agreed, after a very long discussion nobody wants repeated, that the ${n}th thing is now true?`;
  const line = renderReportLine(
    outcome({
      sessionsReviewed: 3,
      memoriesWritten: ["dream-2026-08-19-a", "dream-2026-08-19-b", "dream-2026-08-19-c"],
      memoriesPlanned: [1, 2, 3].map((n) => ({
        name: `dream-2026-08-19-${n}`,
        description: long(n),
        body: "",
        provenance: ["channel:c:1"],
      })),
    }),
  );
  expect(line.length).toBeLessThanOrEqual(LINE_MAX);
  expect(line).not.toMatch(/[A-Z]/);
  expect(/[.?!,;: ]$/.test(line)).toBe(false);
  expect(line).toContain("kept 3 notes");
});

test("renderReportLine reports adds, updates and flags as a SPLIT, not one blended number", () => {
  const line = renderReportLine(
    outcome({
      sessionsReviewed: 2,
      memoriesWritten: ["dream-2026-08-19-a"],
      memoriesPlanned: [
        { name: "dream-2026-08-19-a", description: "ship on fridays", body: "", provenance: ["channel:c:1"] },
      ],
      memoriesUpdated: ["dream-2026-08-01-old"],
      memoriesRetired: ["dream-2026-07-01-wrong"],
      flagsWritten: ["dream-2026-08-19-stale-jason"],
      maintenancePlanned: [
        { op: "update", target: "dream-2026-08-01-old", description: "now fridays, not mondays", body: "", provenance: ["channel:c:1"] },
      ],
    }),
  );
  expect(line).toContain("kept 1 note");
  expect(line).toContain("updated 1");
  expect(line).toContain("retired 1");
  expect(line).toContain("flagged 1 as stale");
  expect(line.length).toBeLessThanOrEqual(LINE_MAX);
});

test("renderReportLine still says 'nothing durable' when a pass only reviewed and changed nothing", () => {
  expect(renderReportLine(outcome({ sessionsReviewed: 4 }))).toBe(
    "reviewed 4 channels from yesterday — nothing durable enough to keep",
  );
});

test("renderReportLine says 'logs', not '0 channels', on a night with journals but no conversation", () => {
  const line = renderReportLine(
    outcome({
      sessionsReviewed: 0,
      sourcesReviewed: 2,
      memoriesWritten: ["dream-2026-08-19-a"],
      memoriesPlanned: [
        { name: "dream-2026-08-19-a", description: "the deploy lane keeps bouncing on typecheck", body: "", provenance: ["journal:OPS-9:2"] },
      ],
    }),
  );
  expect(line).toBe("dreamed on 2 logs from yesterday, kept 1 note: the deploy lane keeps bouncing on typecheck");
});

// ── the maintenance half (update / retire / flag), and its own cap ────────────────────────

const MAINT_OPTS = {
  date: DATE,
  max: 3,
  knownSourceIds: new Set(["channel:c:1"]),
  dreamNodes: new Set([`dream-2026-08-01-old`]),
  otherNodes: new Set(["jason"]),
  takenNames: new Set<string>(),
};

test("planDreamMaintenance keeps a well-formed update, retire, and flag", () => {
  const plan = planDreamMaintenance(
    [
      { op: "update", target: "dream-2026-08-01-old", description: "now fridays, not mondays", provenance: ["channel:c:1"] },
      { op: "flag", target: "jason", description: "says he moved teams", provenance: ["channel:c:1"] },
    ],
    MAINT_OPTS,
  );
  expect(plan.dropped).toEqual([]);
  expect(plan.keep.map((k) => k.op)).toEqual(["update", "flag"]);
  expect(plan.keep[1]!.flagName).toBe(`dream-${DATE}-stale-jason`);
});

test("planDreamMaintenance refuses to update or retire anything outside the dream namespace", () => {
  const plan = planDreamMaintenance(
    [
      { op: "update", target: "jason", description: "rewritten", provenance: ["channel:c:1"] },
      { op: "retire", target: "some-project", description: "dead", provenance: ["channel:c:1"] },
    ],
    MAINT_OPTS,
  );
  expect(plan.keep).toHaveLength(0);
  expect(plan.dropped).toHaveLength(2);
  for (const d of plan.dropped) expect(d).toContain("may only edit its own namespace");
});

test("planDreamMaintenance refuses a flag with no evidence from tonight's assembly", () => {
  const plan = planDreamMaintenance(
    [
      { op: "flag", target: "jason", description: "vibes", provenance: [] },
      { op: "flag", target: "jason", description: "vibes", provenance: ["channel:made-up:9"] },
      { op: "flag", target: "nobody", description: "who?", provenance: ["channel:c:1"] },
    ],
    MAINT_OPTS,
  );
  expect(plan.keep).toHaveLength(0);
  expect(plan.dropped[0]).toContain("no provenance");
  expect(plan.dropped[1]).toContain("unknown sources");
  expect(plan.dropped[2]).toContain("no such node");
});

test("planDreamMaintenance enforces the configurable prune cap by position", () => {
  const entries = [1, 2, 3].map((n) => ({
    op: "flag" as const,
    target: `person-${n}`,
    description: `looks stale ${n}`,
    provenance: ["channel:c:1"],
  }));
  const plan = planDreamMaintenance(entries, {
    ...MAINT_OPTS,
    max: 2,
    otherNodes: new Set(["person-1", "person-2", "person-3"]),
  });
  expect(plan.keep).toHaveLength(2);
  expect(plan.dropped[0]).toContain("2-per-night prune cap");
});

test("a real pass updates, retires, and flags through the memory store — and reports the split", async () => {
  const deps = baseDeps();
  const memory = deps.memory!;
  // Two dream nodes from earlier passes, plus a plain fact the pass may only ever FLAG.
  await memory.rememberDream({
    name: "dream-2026-08-01-old",
    description: "releases ship on mondays",
    provenance: ["channel:chan-1:old"],
    reason: "seed",
  });
  await memory.rememberDream({
    name: "dream-2026-08-02-wrong",
    description: "an inference that did not survive",
    provenance: ["channel:chan-1:old"],
    reason: "seed",
  });
  await memory.remember({
    op: "create",
    name: "jason",
    type: "person",
    description: "jason, on the platform team",
    source: "conversation",
    reason: "seed",
  });

  const channels = createChannelContextStore({
    channelsDir: deps.paths.channelsDir,
    maxEntriesPerChannel: 500,
    maxAgeHours: 24 * 30,
    logger: quiet,
    now: () => NOW.getTime(),
  });
  channels.noteMeta("chan-1", { name: "general", guildId: "999" });
  channels.append("chan-1", entry({ messageId: "m1", ts: NOW.getTime() - 60_000, content: "we ship on fridays now, and i moved to infra" }));
  const src = channelSourceId("chan-1", "m1");

  const result = await runDreamPass({
    ...deps,
    channels,
    callModel: async () => ({
      text: JSON.stringify({
        summary: "a correction and a move",
        memories: [],
        maintenance: [
          { op: "update", target: "dream-2026-08-01-old", description: "releases ship on fridays", provenance: [src] },
          { op: "retire", target: "dream-2026-08-02-wrong", description: "superseded tonight", provenance: [src] },
          { op: "flag", target: "jason", description: "says he moved to infra", provenance: [src] },
        ],
      }),
      outputTokens: 20,
    }),
  });

  expect(result.maintenanceDropped).toEqual([]);
  expect(result.memoriesUpdated).toEqual(["dream-2026-08-01-old"]);
  expect(result.memoriesRetired).toEqual(["dream-2026-08-02-wrong"]);
  expect(result.flagsWritten).toEqual([`dream-${DATE}-stale-jason`]);

  const g = memory.buildGraph();
  expect(g.nodes.get("dream-2026-08-01-old")!.description).toBe("releases ship on fridays");
  expect(g.nodes.has("dream-2026-08-02-wrong")).toBe(false); // archived out of the graph
  const flag = g.nodes.get(`dream-${DATE}-stale-jason`)!;
  expect(flag.metadata.flag_target).toBe("jason");
  expect(flag.metadata.flag_reason).toBe("says he moved to infra");
  expect(flag.metadata.provenance).toEqual([src]);
  // The flagged fact itself was NEVER edited — a flag is a claim, not a rewrite.
  expect(g.nodes.get("jason")!.description).toBe("jason, on the platform team");

  expect(result.shared).toContain("updated 1");
  expect(result.shared).toContain("retired 1");
  expect(result.shared).toContain("flagged 1 as stale");
});

// ── the spend ledger: a dry run still costs money, so it still bills (docs/dream.md) ──────

test("--dry appends exactly one spend row, because the model call it makes is real", async () => {
  const deps = baseDeps();
  const channels = createChannelContextStore({
    channelsDir: deps.paths.channelsDir,
    maxEntriesPerChannel: 500,
    maxAgeHours: 24 * 30,
    logger: quiet,
    now: () => NOW.getTime(),
  });
  channels.noteMeta("chan-1", { name: "general", guildId: "999" });
  channels.append("chan-1", entry({ messageId: "m1", ts: NOW.getTime() - 60_000 }));

  await runDreamPass({
    ...deps,
    channels,
    dry: true,
    callModel: async () => ({ text: JSON.stringify({ summary: "s", memories: [] }), outputTokens: 42 }),
  });

  const rows = readFileSync(deps.paths.spend, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(rows).toHaveLength(1);
  expect(rows[0].stage).toBe("dream");
  expect(rows[0].tokensOut).toBe(42);
  expect(rows[0].outcome).toBe("done");
});

test("a quiet night makes no model call and therefore bills nothing", async () => {
  const deps = baseDeps();
  await runDreamPass(deps);
  expect(existsSync(deps.paths.spend)).toBe(false);
});
