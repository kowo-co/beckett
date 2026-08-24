/**
 * Dream input assembly reads THREE logs: the durable guild channel windows in
 * `../concierge/channel-context.ts`, the per-ticket worker journals, and the dispatch event
 * ledger. DMs are never read, anything outside the window is elided, and every rendered line
 * carries a provenance id prefixed with the source it came from.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelContextStore, type ChannelContextStore, type ChannelEntry } from "../concierge/channel-context.ts";
import { DispatchEventBus } from "../dispatch/events.ts";
import { assembleDreamInputs, channelSourceId, dispatchSourceId, journalSourceId } from "./assemble.ts";
import type { Logger } from "../types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

const NOW = new Date("2026-08-19T10:00:00.000Z");

function store(): ChannelContextStore {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dream-assemble-"));
  dirs.push(dir);
  return createChannelContextStore({
    channelsDir: join(dir, "channels"),
    maxEntriesPerChannel: 500,
    maxAgeHours: 24 * 30,
    logger: quiet,
    now: () => NOW.getTime(),
  });
}

function entry(over: Partial<ChannelEntry> & { messageId: string; ts: number }): ChannelEntry {
  return {
    authorId: "111",
    authorName: "ro",
    content: "hey",
    kind: "user",
    ...over,
  };
}

test("a channel with no recorded meta at all is never read (fail-closed default)", () => {
  const channels = store();
  channels.append("chan-nometa", entry({ messageId: "1", ts: NOW.getTime() - 60_000 }));
  const inputs = assembleDreamInputs({ channels, windowHours: 24, logger: quiet, now: () => NOW });
  expect(inputs.empty).toBe(true);
  expect(inputs.sections).toHaveLength(0);
});

test("a DM channel (null guildId) is never read, even with messages in the window", () => {
  const channels = store();
  channels.noteMeta("chan-dm", { name: null, guildId: null });
  channels.append("chan-dm", entry({ messageId: "1", ts: NOW.getTime() - 60_000, content: "secret dm content" }));
  const inputs = assembleDreamInputs({ channels, windowHours: 24, logger: quiet, now: () => NOW });
  expect(inputs.empty).toBe(true);
  expect(JSON.stringify(inputs)).not.toContain("secret dm content");
});

test("a guild channel in the window is read, with message-granular provenance ids", () => {
  const channels = store();
  channels.noteMeta("chan-guild", { name: "general", guildId: "999" });
  channels.append("chan-guild", entry({ messageId: "m1", ts: NOW.getTime() - 60_000, content: "jason prefers terse updates" }));
  channels.append("chan-guild", entry({ messageId: "m2", ts: NOW.getTime() - 30_000, kind: "beckett", authorId: "beckett", authorName: "beckett", content: "noted" }));

  const inputs = assembleDreamInputs({ channels, windowHours: 24, logger: quiet, now: () => NOW });
  expect(inputs.empty).toBe(false);
  expect(inputs.sections).toHaveLength(1);
  const section = inputs.sections[0]!;
  expect(section.channelId).toBe("chan-guild");
  expect(section.kind).toBe("channel");
  expect(section.channelName).toBe("#general");
  expect(section.sourceIds).toEqual([channelSourceId("chan-guild", "m1"), channelSourceId("chan-guild", "m2")]);
  expect(section.text).toContain("channel:chan-guild:m1");
  expect(section.text).toContain("jason prefers terse updates");
  expect(inputs.sourceIds).toEqual(section.sourceIds);
});

test("messages outside the window are excluded and never contribute provenance", () => {
  const channels = store();
  channels.noteMeta("chan-guild", { name: "general", guildId: "999" });
  channels.append("chan-guild", entry({ messageId: "old", ts: NOW.getTime() - 48 * 60 * 60_000, content: "two days ago" }));
  channels.append("chan-guild", entry({ messageId: "new", ts: NOW.getTime() - 60_000, content: "an hour ago" }));

  const inputs = assembleDreamInputs({ channels, windowHours: 24, logger: quiet, now: () => NOW });
  expect(inputs.sourceIds).toEqual([channelSourceId("chan-guild", "new")]);
  expect(inputs.sections[0]!.text).not.toContain("two days ago");
});

test("no channel store at all degrades to an honest empty assembly, never a throw", () => {
  const inputs = assembleDreamInputs({ channels: null, windowHours: 24, logger: quiet, now: () => NOW });
  expect(inputs.empty).toBe(true);
  expect(inputs.notes.some((n) => n.includes("no channel store"))).toBe(true);
});

// ── the OTHER two logs (the pass reads the logs, plural) ─────────────────────────────────

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dream-logs-"));
  dirs.push(dir);
  return dir;
}

/** One journal line as `TicketJournal` writes it: an ISO stamp, a space, then the text. */
function journalLine(at: Date, text: string): string {
  return `${at.toISOString()} ${text}\n`;
}

test("worker journals are a real source, with journal:<ticket>:<line> provenance", () => {
  const dir = scratch();
  const journalDir = join(dir, "journal");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(
    join(journalDir, "OPS-9.log"),
    journalLine(new Date(NOW.getTime() - 48 * 60 * 60_000), "▸ implement worker started (opus)") +
      journalLine(new Date(NOW.getTime() - 90 * 60_000), "  · Edit  src/dream/run.ts") +
      journalLine(new Date(NOW.getTime() - 60 * 60_000), "✓ review passed"),
  );

  const inputs = assembleDreamInputs({ channels: null, journalDir, windowHours: 24, logger: quiet, now: () => NOW });
  const section = inputs.sections.find((s) => s.kind === "journal")!;
  expect(section.channelId).toBe("OPS-9");
  // Line 1 is two days old — out of the window, and therefore out of the vocabulary. The ids
  // are FILE positions, so the surviving lines keep their real line numbers (2 and 3).
  expect(section.sourceIds).toEqual([journalSourceId("OPS-9", 2), journalSourceId("OPS-9", 3)]);
  expect(section.text).toContain("journal:OPS-9:2");
  expect(section.text).toContain("review passed");
  expect(section.text).not.toContain("worker started");
  expect(inputs.empty).toBe(false);
});

test("the dispatch ledger is a real source, with dispatch:<runId>:<n> provenance per run", () => {
  const dir = scratch();
  const ledger = join(dir, "dispatch.jsonl");
  const bus = new DispatchEventBus({ path: ledger, now: () => NOW.getTime() - 30 * 60_000 });
  bus.emit({ runId: "run_a", runRef: "#12", stage: "implement", outcome: "started" });
  bus.emit({ runId: "run_a", runRef: "#12", stage: "review", outcome: "failed", error: "tests red" });
  bus.emit({ runId: "run_b", runRef: "#13", stage: "implement", outcome: "passed" });

  const inputs = assembleDreamInputs({
    channels: null,
    dispatchLedger: ledger,
    windowHours: 24,
    logger: quiet,
    now: () => NOW,
  });
  const sections = inputs.sections.filter((s) => s.kind === "dispatch");
  expect(sections.map((s) => s.channelId).sort()).toEqual(["run_a", "run_b"]);
  const a = sections.find((s) => s.channelId === "run_a")!;
  // `n` counts within the RUN, not the shared file — run_b's single row is :1, not :3.
  expect(a.sourceIds).toEqual([dispatchSourceId("run_a", 1), dispatchSourceId("run_a", 2)]);
  expect(sections.find((s) => s.channelId === "run_b")!.sourceIds).toEqual([dispatchSourceId("run_b", 1)]);
  expect(a.text).toContain("tests red");
});

test("all three sources land in one assembly, each keeping its own provenance prefix", () => {
  const channels = store();
  channels.noteMeta("chan-guild", { name: "general", guildId: "999" });
  channels.append("chan-guild", entry({ messageId: "m1", ts: NOW.getTime() - 60_000 }));

  const dir = scratch();
  const journalDir = join(dir, "journal");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(join(journalDir, "OPS-9.log"), journalLine(new Date(NOW.getTime() - 60_000), "✓ review passed"));
  const ledger = join(dir, "dispatch.jsonl");
  new DispatchEventBus({ path: ledger, now: () => NOW.getTime() - 60_000 }).emit({
    runId: "run_a",
    runRef: "#12",
    stage: "implement",
    outcome: "passed",
  });

  const inputs = assembleDreamInputs({ channels, journalDir, dispatchLedger: ledger, windowHours: 24, logger: quiet, now: () => NOW });
  expect(inputs.sections.map((s) => s.kind)).toEqual(["channel", "journal", "dispatch"]);
  expect(inputs.sourceIds).toEqual([
    channelSourceId("chan-guild", "m1"),
    journalSourceId("OPS-9", 1),
    dispatchSourceId("run_a", 1),
  ]);
});

test("a journal dir and a ledger that do not exist yet are simply skipped, never a throw", () => {
  const dir = scratch();
  const inputs = assembleDreamInputs({
    channels: null,
    journalDir: join(dir, "nope"),
    dispatchLedger: join(dir, "nope.jsonl"),
    windowHours: 24,
    logger: quiet,
    now: () => NOW,
  });
  expect(inputs.empty).toBe(true);
  expect(inputs.sections).toHaveLength(0);
});
