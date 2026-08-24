#!/usr/bin/env bun
/**
 * Harvester for the memory-recall eval's corpus (`scripts/eval/memory-recall-corpus.json`).
 *
 * Run: bun scripts/eval/memory-recall-harvest.ts [--memory-dir <dir>] [--channels-dir <dir>]
 *
 * Reads the live memory graph and channel store on THIS box and writes the checked-in fixture
 * the eval runs against, so the corpus is real conversation and real notes rather than invented
 * text. Two things are deliberate:
 *
 *   - **Timestamps become ages.** Every channel entry is stored as `ageMinutes` before the
 *     corpus's notional "now", so the store's TTL bound is exercised reproducibly forever
 *     instead of aging the whole fixture out three days after it was cut.
 *   - **It refuses to publish secrets.** Owner-scoped and dm-scoped notes are dropped outright
 *     (they are exactly the ones holding vault pointers), and Discord user ids are replaced with
 *     stable synthetic ids. The eval measures retrieval; it does not need anyone's real ids.
 *
 * The output is checked in. Re-run it only to refresh the corpus, and re-read the diff before
 * committing — this writes real conversation into a repo that gets published.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CORPUS_PATH, type ChannelFixture, type MemoryRecallCorpus, type NoteFixture } from "./memory-recall-corpus.ts";

const DEFAULT_MEMORY_DIR = join(homedir(), ".beckett", "memory");
const DEFAULT_CHANNELS_DIR = join(homedir(), ".beckett", "channels");

/** Author ids are pseudonymized to stable synthetic ids; display handles are already pseudonyms. */
function synthId(realId: string, map: Map<string, string>): string {
  const existing = map.get(realId);
  if (existing) return existing;
  const id = `90000000000000${String(map.size + 1).padStart(4, "0")}`;
  map.set(realId, id);
  return id;
}

/** Split a note file into its YAML-ish frontmatter block and the markdown body. */
function splitFrontmatter(raw: string): { front: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return { front: {}, body: raw.trim() };
  const front: Record<string, string> = {};
  let key: string | null = null;
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\s*)([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[2]!;
      const value = kv[3]!.trim();
      front[key] = value === ">" || value === "|" ? "" : value.replace(/^["']|["']$/g, "");
    } else if (key && line.trim()) {
      front[key] = `${front[key] ?? ""}${front[key] ? " " : ""}${line.trim()}`;
    }
  }
  return { front, body: (m[2] ?? "").trim() };
}

function harvestNotes(dir: string): NoteFixture[] {
  const out: NoteFixture[] = [];
  for (const rel of (readdirSync(dir, { recursive: true }) as string[]).sort()) {
    if (!rel.endsWith(".md") || basename(rel) === "MEMORY.md") continue;
    if (rel.split(/[\\/]/).some((p) => p === ".git" || p === ".moss" || p === "archive")) continue;
    const { front, body } = splitFrontmatter(readFileSync(join(dir, rel), "utf8"));
    // Fail CLOSED: anything scoped to the owner or a DM is where the vault pointers live, and
    // this fixture gets published. Only notes explicitly readable by everyone ship.
    const visibility = front.visibility ?? "public";
    if (visibility !== "public") continue;
    const name = front.name ?? basename(rel, ".md");
    out.push({
      name,
      type: front.type ?? rel.split(/[\\/]/)[0] ?? "fact",
      description: front.description ?? "",
      // Backlink sections are generated, not stated content — they add index noise, not facts.
      body: body.replace(/\n## Backlinks[\s\S]*$/, "").trim(),
      updated: front.updated ?? front.created ?? "2026-08-01T00:00:00.000Z",
    });
  }
  return out;
}

/**
 * Rewrite inline `<@id>` mentions through the SAME synthetic-id map the author ids use, so a
 * person is one consistent pseudonym everywhere and no real Discord id reaches the published
 * fixture. The token shape is preserved because the retriever tokenizes over it.
 */
function scrubMentions(content: string, ids: Map<string, string>): string {
  return content.replace(/<@([!&]?)(\d+)>/g, (_m, bang: string, id: string) => `<@${bang}${synthId(id, ids)}>`);
}

function harvestChannels(dir: string, ids: Map<string, string>): { channels: ChannelFixture[]; nowMs: number } {
  const metaFile = join(dir, "channels-meta.json");
  const metas: Record<string, { name: string | null; guildId: string | null }> = existsSync(metaFile)
    ? (JSON.parse(readFileSync(metaFile, "utf8")).channels ?? {})
    : {};
  const raw: Array<{ channelId: string; entries: Array<Record<string, unknown>> }> = [];
  let newest = 0;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".jsonl")) continue;
    const channelId = basename(file, ".jsonl");
    const entries = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (entries.length === 0) continue;
    // DMs (no guildId) are private one-to-one conversation — never published.
    if (!metas[channelId]?.guildId) continue;
    for (const e of entries) newest = Math.max(newest, Number(e.ts ?? 0));
    raw.push({ channelId, entries });
  }
  // "now" sits one minute past the newest captured line, so ages are all positive and the
  // freshest entry is effectively live.
  const nowMs = newest + 60_000;
  const channels = raw.map(({ channelId, entries }) => ({
    channelId,
    name: metas[channelId]!.name,
    guildId: metas[channelId]!.guildId,
    entries: entries.map((e) => ({
      messageId: String(e.messageId),
      ageMinutes: Math.round((nowMs - Number(e.ts)) / 60_000),
      authorId: e.kind === "beckett" ? "beckett" : synthId(String(e.authorId), ids),
      authorName: String(e.authorName),
      content: scrubMentions(String(e.content), ids),
      kind: e.kind === "beckett" ? ("beckett" as const) : ("user" as const),
    })),
  }));
  return { channels, nowMs };
}

const argv = process.argv.slice(2);
let memoryDir = DEFAULT_MEMORY_DIR;
let channelsDir = DEFAULT_CHANNELS_DIR;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--memory-dir") memoryDir = argv[++i]!;
  else if (argv[i] === "--channels-dir") channelsDir = argv[++i]!;
  else throw new Error(`usage: bun scripts/eval/memory-recall-harvest.ts [--memory-dir <dir>] [--channels-dir <dir>]`);
}
if (!existsSync(memoryDir)) throw new Error(`memory dir not found: ${memoryDir}`);
if (!existsSync(channelsDir)) throw new Error(`channels dir not found: ${channelsDir}`);

const ids = new Map<string, string>();
const notes = harvestNotes(memoryDir);
const { channels } = harvestChannels(channelsDir, ids);

const corpus: MemoryRecallCorpus = {
  version: 1,
  description:
    "Real notes from Beckett's memory graph and real guild-channel conversation, harvested by " +
    "scripts/eval/memory-recall-harvest.ts. Owner/DM-scoped notes and DM channels are excluded; " +
    "author ids are synthetic. Channel entries carry ageMinutes, not timestamps, so retention " +
    "bounds stay reproducible.",
  notes,
  channels,
};
writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
console.log(
  `wrote ${CORPUS_PATH}\n  ${notes.length} notes, ${channels.length} channels, ` +
    `${channels.reduce((n, c) => n + c.entries.length, 0)} entries`,
);
