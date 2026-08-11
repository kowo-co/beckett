/**
 * Dream input assembly (issue #36): read-only, windowed to 24h, and — the load-bearing one —
 * DM windows are NEVER read. The DM proof is structural: the store's `recent()` is spied on,
 * so the test fails if a DM (or meta-less) channel's window is even LOADED, not just rendered.
 */

import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembleDreamInputs, type AssembleDreamDeps } from "./assemble.ts";
import { createChannelContextStore, type ChannelContextStore } from "../concierge/channel-context.ts";
import { createMemory, type MemoryStore } from "../memory/index.ts";
import { openLoop } from "../memory/loops.ts";
import { createCalibration } from "../memory/calibration.ts";
import type { Logger } from "../types.ts";

const dirs: string[] = [];
const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-07-26T10:30:00.000Z");
const RECENT = NOW.getTime() - 60 * 60_000; // 1h ago — inside the window
const ANCIENT = NOW.getTime() - 48 * 60 * 60_000; // 2 days ago — outside

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dream-assemble-"));
  dirs.push(dir);
  return dir;
}

function depsIn(dir: string, over: Partial<AssembleDreamDeps> = {}): AssembleDreamDeps {
  return {
    journalDir: join(dir, "journal"),
    dispatchEventsPath: join(dir, "events", "dispatch.jsonl"),
    memory: null,
    channels: null,
    logger: quiet,
    now: () => NOW,
    ...over,
  };
}

function channelStore(dir: string): ChannelContextStore {
  return createChannelContextStore({
    channelsDir: join(dir, "channels"),
    maxEntriesPerChannel: 200,
    maxAgeHours: 72,
    logger: quiet,
    now: () => NOW.getTime(),
  });
}

function entry(id: string, ts: number, content: string) {
  return { messageId: id, ts, authorId: "u1", authorName: "jason", content, kind: "user" as const };
}

test("DM windows are never read — not rendered, not even loaded (the in-code gate)", () => {
  const dir = sandbox();
  const store = channelStore(dir);

  // A guild channel, a DM (null guildId), and a channel with no recorded meta at all.
  store.noteMeta("guild-1", { name: "media", guildId: "g-1" });
  store.append("guild-1", entry("m1", RECENT, "GUILD-CONTENT talking about the beckett site"));
  store.noteMeta("dm-1", { name: null, guildId: null });
  store.append("dm-1", entry("m2", RECENT, "DM-SECRET do not surface this"));
  store.append("nometa-1", entry("m3", RECENT, "NOMETA-CONTENT private by default"));

  // The spy: recent() must never be called for the DM or the meta-less channel.
  const recentCalls: string[] = [];
  const spied: ChannelContextStore = {
    ...store,
    recent(channelId: string) {
      recentCalls.push(channelId);
      return store.recent(channelId);
    },
  };

  const inputs = assembleDreamInputs(depsIn(dir, { channels: spied }));
  const channels = inputs.sections.find((s) => s.key === "channels")!;

  expect(channels.text).toContain("GUILD-CONTENT");
  expect(channels.sourceIds).toEqual(["channel:guild-1"]);
  // Neither excluded channel's content appears ANYWHERE in the assembled input…
  const whole = JSON.stringify(inputs);
  expect(whole).not.toContain("DM-SECRET");
  expect(whole).not.toContain("NOMETA-CONTENT");
  expect(whole).not.toContain("dm-1");
  // …and their windows were never even loaded.
  expect(recentCalls).toEqual(["guild-1"]);
});

test("worker journals and run transitions are windowed to the last 24h", () => {
  const dir = sandbox();
  const journalDir = join(dir, "journal");
  mkdirSync(journalDir, { recursive: true });
  const recentIso = new Date(RECENT).toISOString();
  const ancientIso = new Date(ANCIENT).toISOString();
  writeFileSync(
    join(journalDir, "#31.log"),
    `${ancientIso} ▸ implement worker started (OLD-LINE)\n${recentIso} ✓ implement success (FRESH-LINE)\n`,
  );
  // A journal untouched for days is skipped by mtime before it is even read.
  const stale = join(journalDir, "#9.log");
  writeFileSync(stale, `${ancientIso} ▸ STALE-JOURNAL\n`);
  utimesSync(stale, new Date(ANCIENT), new Date(ANCIENT));

  mkdirSync(join(dir, "events"), { recursive: true });
  appendFileSync(
    join(dir, "events", "dispatch.jsonl"),
    JSON.stringify({ ts: recentIso, runId: "#31", runRef: "#31.1", branchRef: "b", stage: "state:in_review", outcome: "info", elapsedMs: 1, message: "implement → review" }) + "\n" +
    JSON.stringify({ ts: ancientIso, runId: "#2", runRef: "#2.1", branchRef: "b", stage: "state:done", outcome: "info", elapsedMs: 1, message: "OLD-TRANSITION" }) + "\n",
  );

  const inputs = assembleDreamInputs(depsIn(dir));
  const journals = inputs.sections.find((s) => s.key === "journals")!;
  expect(journals.text).toContain("FRESH-LINE");
  expect(journals.text).not.toContain("OLD-LINE");
  expect(journals.text).not.toContain("STALE-JOURNAL");
  expect(journals.sourceIds).toEqual(["journal:#31"]);

  const transitions = inputs.sections.find((s) => s.key === "transitions")!;
  expect(transitions.text).toContain("#31.1 state:in_review");
  expect(transitions.text).not.toContain("OLD-TRANSITION");
  expect(transitions.sourceIds).toEqual(["run:#31.1"]);
});

test("open loops and fresh calibration records ride in with stable source ids", async () => {
  const dir = sandbox();
  const memory: MemoryStore = createMemory({ memoryDir: join(dir, "memory"), logger: quiet, git: false });
  await openLoop(memory, {
    name: "ship-the-site",
    kind: "commitment",
    due: "2026-07-30",
    source: "discord:123/456",
    description: "ship the site refresh",
  });
  await createCalibration(memory, {
    kind: "veto",
    channel: "123",
    about: "unprompted-deploys",
    reason: "not on a friday",
    source: "discord:123/789",
    observed: "2026-07-26",
  });

  const inputs = assembleDreamInputs(depsIn(dir, { memory }));
  const loops = inputs.sections.find((s) => s.key === "loops")!;
  expect(loops.sourceIds).toEqual(["loop:ship-the-site"]);
  expect(loops.text).toContain("ship the site refresh");
  const calibration = inputs.sections.find((s) => s.key === "calibration")!;
  expect(calibration.sourceIds.length).toBe(1);
  expect(calibration.text).toContain("not on a friday");
  expect(inputs.sourceIds).toContain("loop:ship-the-site");
});

test("an empty day assembles empty (the quiet-day short-circuit) and absent sources degrade to notes", () => {
  const dir = sandbox();
  const inputs = assembleDreamInputs(depsIn(dir));
  expect(inputs.empty).toBe(true);
  expect(inputs.sourceIds).toEqual([]);
  // memory/channels absent → honest notes, no throw.
  expect(inputs.notes.join(" ")).toContain("no memory store");
  expect(inputs.notes.join(" ")).toContain("no channel store");
});
