/**
 * Free time (docs/freetime.md): the fail-closed writeback contract, the memory cap + naming
 * rules, the pre-claim idle gate, prompt assembly (seeded and cold), and the receipt the journal
 * entry is built from. Everything here is a pure function or an injected-harness run — no
 * `claude` process, no Discord, no git.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import type { Config, Logger, Paths } from "../types.ts";
import { createMemory } from "../memory/index.ts";
import { SELF_AUDIENCE } from "../memory/search.ts";
import { localDate } from "../dream/run.ts";
import {
  FREE_TIME_DENIED_PERMISSIONS,
  buildFreeTimePrompt,
  composeFreeTimeEntry,
  freeTimeDeferReason,
  freeTimeMemoryName,
  listFreeTimeEntries,
  parseFreeTimeWriteback,
  planFreeTimeMemories,
  renderFreeTimeSeed,
  runFreeTime,
  trimShare,
  type FreeTimeRunDeps,
  type FreeTimeRunOutcome,
} from "./run.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-09T10:30:00.000Z"); // 03:30 America/Los_Angeles

function world(): { config: Config; paths: Paths; dir: string; date: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-free-time-"));
  dirs.push(dir);
  const config = defaultConfig();
  return { config, paths: buildPaths(config, { BECKETT_DIR: dir }), dir, date: localDate(NOW, config.free_time.tz) };
}

// ── the writeback contract (fail-closed) ───────────────────────────────────────────────

test("a well-formed writeback parses; every malformed one becomes a note, never a throw", () => {
  const good = parseFreeTimeWriteback(
    JSON.stringify({
      did: ["read my own dispatcher"],
      learned: ["the retry path is not what I thought"],
      abandoned: ["a rewrite of the scheduler"],
      want_next_time: ["look at the concierge queue"],
      memories: [{ name_slug: "retry-path", body: "the retry path fires twice\nnoticed while reading", visibility: "owner" }],
      share: "spent an hour reading my own retry code. it lies.",
    }),
  );
  expect(good.problem).toBeNull();
  expect(good.writeback?.did).toEqual(["read my own dispatcher"]);
  expect(good.writeback?.memories[0]?.visibility).toBe("owner");

  // Each failure mode names itself and yields NO writeback — a session that cannot say what it
  // did says nothing, rather than having something inferred on its behalf.
  for (const [raw, needle] of [
    [null, "no writeback.json"],
    ["", "empty"],
    ["   ", "empty"],
    ["not json at all", "not valid JSON"],
    ["[1,2,3]", "agreed shape"],
    [JSON.stringify({ did: "a string, not a list" }), "agreed shape"],
    [JSON.stringify({ memories: [{ name_slug: 5, body: "x" }] }), "agreed shape"],
  ] as Array<[string | null, string]>) {
    const parsed = parseFreeTimeWriteback(raw);
    expect(parsed.writeback).toBeNull();
    expect(parsed.problem ?? "").toContain(needle);
  }
});

test("a writeback with only some keys keeps the rest empty — an empty session is a valid one", () => {
  const parsed = parseFreeTimeWriteback(JSON.stringify({ did: ["nothing much"] }));
  expect(parsed.problem).toBeNull();
  expect(parsed.writeback).toEqual({
    did: ["nothing much"],
    learned: [],
    abandoned: [],
    want_next_time: [],
    memories: [],
    share: "",
  });
});

test("a fenced writeback still parses (the harness likes fences)", () => {
  const parsed = parseFreeTimeWriteback('```json\n{"did":["a"],"share":"b"}\n```');
  expect(parsed.problem).toBeNull();
  expect(parsed.writeback?.share).toBe("b");
});

// ── memory naming, capping, and refusal ────────────────────────────────────────────────

test("node names are namespaced to the date, and an unusable slug has no name at all", () => {
  expect(freeTimeMemoryName("2026-08-09", "Retry Path!")).toBe("free-time-2026-08-09-retry-path");
  expect(freeTimeMemoryName("2026-08-09", "  --already-kebab-- ")).toBe("free-time-2026-08-09-already-kebab");
  expect(freeTimeMemoryName("2026-08-09", "")).toBeNull();
  expect(freeTimeMemoryName("2026-08-09", "!!!")).toBeNull();
  // A slug cannot escape its namespace by carrying a path (or anything else non-kebab).
  expect(freeTimeMemoryName("2026-08-09", "../../persona")).toBe("free-time-2026-08-09-persona");
  expect(freeTimeMemoryName("not-a-date", "x")).toBeNull();
});

test("the cap drops by position and every refusal is counted with its reason", () => {
  const entries = [
    { name_slug: "one", body: "first line\nbody" },
    { name_slug: "!!!", body: "bad slug" },
    { name_slug: "two", body: "   " },
    { name_slug: "three", body: "kept" },
    { name_slug: "three", body: "dupe" },
    { name_slug: "four", body: "kept too", visibility: "owner" as const },
    { name_slug: "five", body: "over the cap" },
  ];
  const plan = planFreeTimeMemories(entries, { date: "2026-08-09", max: 3 });
  expect(plan.keep.map((m) => m.name)).toEqual([
    "free-time-2026-08-09-one",
    "free-time-2026-08-09-three",
    "free-time-2026-08-09-four",
  ]);
  expect(plan.keep[0]).toMatchObject({ description: "first line", body: "body", visibility: "public" });
  expect(plan.keep[2]!.visibility).toBe("owner");
  expect(plan.dropped.join("; ")).toContain("!!! (unusable slug)");
  expect(plan.dropped.join("; ")).toContain("two (empty body)");
  expect(plan.dropped.join("; ")).toContain("three (duplicate slug in the same session)");
  expect(plan.dropped.join("; ")).toContain("five (over the 3-per-session cap)");
});

test("visibility defaults to public — public is what reaches the next session", () => {
  const plan = planFreeTimeMemories([{ name_slug: "a", body: "line" }], { date: "2026-08-09", max: 5 });
  expect(plan.keep[0]!.visibility).toBe("public");
});

// ── the idle gate (consulted BEFORE the period is claimed) ─────────────────────────────

test("free time only fires on a quiet machine, and says which half is not quiet", () => {
  expect(freeTimeDeferReason({ fleetIdle: true, conciergeQuiet: true })).toBeNull();
  expect(freeTimeDeferReason({ fleetIdle: false, conciergeQuiet: true })).toContain("worker fleet is busy");
  expect(freeTimeDeferReason({ fleetIdle: true, conciergeQuiet: false })).toContain("turns in flight");
  const both = freeTimeDeferReason({ fleetIdle: false, conciergeQuiet: false }) ?? "";
  expect(both).toContain("worker fleet is busy");
  expect(both).toContain("turns in flight");
});

// ── prompt assembly ────────────────────────────────────────────────────────────────────

test("a seeded prompt carries last time forward; a cold one says so instead of faking one", () => {
  const seed = renderFreeTimeSeed([
    { name: "free-time-2026-08-02-retry", description: "the retry path fires twice", body: "found while reading", updated: "2026-08-02T00:00:00.000Z" },
  ]);
  expect(seed).toContain("the retry path fires twice");
  expect(seed).toContain("(2026-08-02)");

  const base = {
    date: "2026-08-09",
    scratchDir: "/tmp/ft/2026-08-09-abcd1234",
    maxTurns: 60,
    budget: 80_000,
    memoriesMax: 5,
    canShare: true,
  };
  const warm = buildFreeTimePrompt({ ...base, seed });
  expect(warm).toContain("Last time:");
  expect(warm).toContain("the retry path fires twice");
  expect(warm).toContain("this time is yours");
  expect(warm).toContain(base.scratchDir);
  expect(warm).toContain("writeback.json");
  expect(warm).toContain("80000 output tokens");

  const cold = buildFreeTimePrompt({ ...base, seed: "" });
  expect(cold).not.toContain("Last time:");
  expect(cold).toContain("This is the first one");

  // With no share channel configured the prompt does not dangle an offer it cannot honor.
  const quietPrompt = buildFreeTimePrompt({ ...base, seed: "", canShare: false });
  expect(quietPrompt).toContain("no share channel is configured");
});

test("the empty seed renders as the empty string, not as a heading with nothing under it", () => {
  expect(renderFreeTimeSeed([])).toBe("");
});

// ── the receipt / journal entry ────────────────────────────────────────────────────────

test("the entry carries the receipt in its meta header and never invents a section", () => {
  const outcome: FreeTimeRunOutcome = {
    id: "2026-08-09-abcd1234",
    date: "2026-08-09",
    scratchDir: "/tmp/ft/2026-08-09-abcd1234",
    entryPath: null,
    ran: true,
    dry: false,
    did: ["read the dispatcher"],
    learned: [],
    abandoned: [],
    wantNextTime: ["the concierge queue"],
    memoriesWritten: ["free-time-2026-08-09-retry"],
    memoriesDropped: ["x (unusable slug)"],
    shared: "read my own retry code",
    outputTokens: 90_000,
    budget: 80_000,
    truncated: true,
    timedOut: false,
    seed: "",
    prompt: "",
    note: null,
  };
  const entry = composeFreeTimeEntry(outcome, "weekly-free-time");
  expect(entry).toContain("# free time — 2026-08-09 (2026-08-09-abcd1234)");
  expect(entry).toContain("output_tokens: 90000 / 80000");
  expect(entry).toContain("truncated: true");
  expect(entry).toContain("memories: free-time-2026-08-09-retry");
  expect(entry).toContain("memories_dropped: x (unusable slug)");
  expect(entry).toContain("- read the dispatcher");
  // An empty list is a dash, not an omission: "learned nothing" is a real answer.
  expect(entry).toContain("## learned\n—");
});

test("share text is squeezed to one readable line, and silence stays silence", () => {
  expect(trimShare("")).toBe("");
  expect(trimShare("  spent \n an hour  reading ")).toBe("spent an hour reading");
  const long = trimShare("x".repeat(900));
  expect(long.length).toBe(500);
  expect(long.endsWith("…")).toBe(true);
});

// ── one whole run, with the harness and the share injected ─────────────────────────────

test("a run writes the writeback into a dated entry, posts ONE share, and never throws", async () => {
  const w = world();
  const posted: Array<{ channelId: string; text: string }> = [];
  w.config.free_time.channel_id = "chan-1";

  const outcome = await runFreeTime({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => NOW,
    memory: null,
    routineId: "weekly-free-time",
    callHarness: async (prompt, opts) => {
      // The session writes its own writeback into the scratch dir — the ONLY channel out.
      expect(prompt).toContain("this time is yours");
      writeFileSync(
        join(opts.cwd, "writeback.json"),
        JSON.stringify({
          did: ["poked at the scheduler"],
          learned: ["the claim happens before dispatch"],
          memories: [{ name_slug: "claim-order", body: "the claim happens before dispatch" }],
          share: "spent the night reading my own scheduler",
        }),
      );
      // The walls ride the settings file, not the prompt.
      const settings = JSON.parse(readFileSync(opts.settingsPath, "utf8")) as Record<string, unknown>;
      expect(JSON.stringify(settings)).toContain("scope-guard");
      expect((settings.permissions as { deny: string[] }).deny).toEqual(FREE_TIME_DENIED_PERMISSIONS);
      return { text: "done", outputTokens: 1_234 };
    },
    postShare: async (channelId, text) => {
      posted.push({ channelId, text });
    },
  });

  expect(outcome.ran).toBe(true);
  expect(outcome.truncated).toBe(false);
  expect(outcome.outputTokens).toBe(1_234);
  expect(outcome.did).toEqual(["poked at the scheduler"]);
  expect(outcome.shared).toBe("spent the night reading my own scheduler");
  expect(posted).toEqual([{ channelId: "chan-1", text: "spent the night reading my own scheduler" }]);
  // No memory store in this world: the note is refused and COUNTED, never silently lost.
  expect(outcome.memoriesWritten).toEqual([]);
  expect(outcome.memoriesDropped.join("; ")).toContain("no memory store");

  const entries = listFreeTimeEntries(join(w.paths.beckettDir, "free-time"));
  expect(entries).toHaveLength(1);
  expect(readFileSync(entries[0]!.path, "utf8")).toContain("- poked at the scheduler");
});

test("a written memory lands create-only in the free-time namespace, and seeds the next session", async () => {
  const w = world();
  const store = createMemory({ memoryDir: w.paths.memoryDir, logger: quiet, git: false });
  const harness = (slug: string): FreeTimeRunDeps["callHarness"] => async (_prompt, opts) => {
    writeFileSync(
      join(opts.cwd, "writeback.json"),
      JSON.stringify({ memories: [{ name_slug: slug, body: "the claim happens before dispatch\nread it twice" }] }),
    );
    return { text: "", outputTokens: 10 };
  };
  const base = { config: w.config, paths: w.paths, logger: quiet, now: () => NOW, memory: store };

  const first = await runFreeTime({ ...base, callHarness: harness("claim-order") });
  expect(first.memoriesWritten).toEqual([`free-time-${w.date}-claim-order`]);
  const node = (await store.recall({ text: "claim", filter: { types: ["free-time"] }, audience: SELF_AUDIENCE }))
    .hits.map((h) => h.node)
    .find((n) => n.name === `free-time-${w.date}-claim-order`)!;
  expect(node.type).toBe("free-time");
  expect(node.metadata.visibility).toBe("public");
  expect(node.metadata.provenance).toEqual([`free-time:${first.id}`]);
  expect(node.description).toBe("the claim happens before dispatch");

  // The same name a second time is REFUSED, not merged — and the refusal is a counted drop, not
  // a failed run. A free-time session cannot edit a memory, including one it wrote itself.
  const second = await runFreeTime({ ...base, callHarness: harness("claim-order") });
  expect(second.memoriesWritten).toEqual([]);
  expect(second.memoriesDropped.join("; ")).toContain("create-only");

  // And that memory is what the NEXT session opens with — the continuity the feature is for.
  const third = await runFreeTime({ ...base, dry: true });
  expect(third.seed).toContain("the claim happens before dispatch");
  expect(third.prompt).toContain("Last time:");
});

test("a session that dies mid-thought still leaves a dated entry, and nothing is shared", async () => {
  const w = world();
  w.config.free_time.channel_id = "chan-1";
  let shares = 0;
  const outcome = await runFreeTime({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => NOW,
    memory: null,
    callHarness: async () => {
      throw new Error("free-time session timed out after 1800s");
    },
    postShare: async () => {
      shares += 1;
    },
  });
  expect(outcome.ran).toBe(false);
  expect(outcome.timedOut).toBe(true);
  expect(outcome.entryPath).not.toBeNull();
  expect(shares).toBe(0);
  expect(readFileSync(outcome.entryPath!, "utf8")).toContain("timed_out: true");
});

test("--dry assembles the prompt and stops: no harness, no entry, no share", async () => {
  const w = world();
  let called = 0;
  const outcome = await runFreeTime({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => NOW,
    memory: null,
    dry: true,
    callHarness: async () => {
      called += 1;
      return { text: "", outputTokens: 0 };
    },
  });
  expect(called).toBe(0);
  expect(outcome.ran).toBe(false);
  expect(outcome.entryPath).toBeNull();
  expect(outcome.prompt).toContain("this time is yours");
  expect(listFreeTimeEntries(join(w.paths.beckettDir, "free-time"))).toHaveLength(0);
});

test("a zero ceiling means the session never launches, and says so on disk", async () => {
  const w = world();
  w.config.free_time.output_token_budget = 0;
  let called = 0;
  const outcome = await runFreeTime({
    config: w.config,
    paths: w.paths,
    logger: quiet,
    now: () => NOW,
    memory: null,
    callHarness: async () => {
      called += 1;
      return { text: "", outputTokens: 0 };
    },
  });
  expect(called).toBe(0);
  expect(outcome.ran).toBe(false);
  expect(outcome.note ?? "").toContain("ceiling");
  expect(readFileSync(outcome.entryPath!, "utf8")).toContain("ran: false");
});
