/**
 * Unit cover for the turn's retrieval selection core. These are the exact functions
 * `scripts/eval/memory-recall.ts` scores recall@k against, so pinning their admission rules here
 * is what keeps that number honest — a silent change to the floor, the budget or the dedup shows
 * up as a failing test rather than a quietly worse prompt.
 */

import { expect, test } from "bun:test";
import { crossChannelQueryTerms, memoryPrimerQuery, selectChannelContext, selectPrimerNotes } from "./turn-recall.ts";
import type { ChannelEntry } from "./channel-context.ts";
import type { ScoredNode } from "../types.ts";

function note(name: string, score: number, body = "", description = `about ${name}`): ScoredNode {
  return {
    node: {
      name,
      type: "project",
      description,
      metadata: {},
      body,
      path: `/tmp/${name}.md`,
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-08-01T00:00:00.000Z",
      source: "conversation",
      stale: false,
      phantom: false,
      mtime: 0,
    },
    score,
    via: "match",
    reason: "test",
  };
}

function entry(messageId: string, content: string): ChannelEntry {
  return {
    messageId,
    ts: Date.parse("2026-08-01T12:00:00.000Z"),
    authorId: "u1",
    authorName: "ro",
    content,
    kind: "user",
  };
}

function hit(channelId: string, messageId: string, score: number, content = `line ${messageId}`) {
  return {
    channelId,
    channelName: channelId,
    entry: entry(messageId, content),
    context: [entry(messageId, content)],
    score,
  };
}

// =======================================================================================
// query gates
// =======================================================================================

test("crossChannelQueryTerms keeps content words and drops filler", () => {
  expect(crossChannelQueryTerms("Where does the postgres failover runbook live?").sort()).toEqual(
    ["does", "failover", "live", "postgres", "runbook"].sort(),
  );
  expect(crossChannelQueryTerms("ok!!")).toEqual([]);
  // Deduped, so a repeated word does not double-weight the query.
  expect(crossChannelQueryTerms("deploy deploy deploy")).toEqual(["deploy"]);
});

test("memoryPrimerQuery strips mentions and urls, and refuses acknowledgments", () => {
  expect(memoryPrimerQuery("<@123> what is the deploy target for the site?")).toBe(
    "what is the deploy target for the site?",
  );
  expect(memoryPrimerQuery("see https://example.com/a/b for the detail here")).toBe("see  for the detail here");
  expect(memoryPrimerQuery("thanks a lot")).toBe("");
  expect(memoryPrimerQuery("ok")).toBe("");
  expect(memoryPrimerQuery("short")).toBe("");
});

// =======================================================================================
// the memory-graph primer
// =======================================================================================

test("selectPrimerNotes floors on a FRACTION of the top hit, not an absolute score", () => {
  // Same relative shape at two wildly different scales must admit the same notes — that is the
  // whole reason the floor is relative (recall's scorer has no fixed range).
  for (const scale of [1, 100]) {
    const { names } = selectPrimerNotes(
      [note("a", 1.0 * scale), note("b", 0.6 * scale), note("c", 0.2 * scale)],
      { maxNotes: 5, maxChars: 10_000, minScore: 0.5 },
    );
    expect(names).toEqual(["a", "b"]);
  }
});

test("selectPrimerNotes caps at maxNotes and suppresses notes the session already saw", () => {
  const hits = [note("a", 1), note("b", 0.9), note("c", 0.8)];
  expect(selectPrimerNotes(hits, { maxNotes: 2, maxChars: 10_000, minScore: 0.5 }).names).toEqual(["a", "b"]);
  expect(
    selectPrimerNotes(hits, { maxNotes: 2, maxChars: 10_000, minScore: 0.5, seen: new Set(["a"]) }).names,
  ).toEqual(["b", "c"]);
});

test("selectPrimerNotes always admits the top note even when it alone busts the char budget", () => {
  const { lines, names } = selectPrimerNotes([note("a", 1, "x".repeat(500)), note("b", 0.9, "y".repeat(500))], {
    maxNotes: 5,
    maxChars: 10,
    minScore: 0.5,
  });
  expect(names).toEqual(["a"]);
  expect(lines).toHaveLength(1);
});

// =======================================================================================
// the channel relevance block
// =======================================================================================

test("selectChannelContext drops hits under the floor, already-seen hits, and the excluded channel", () => {
  const hits = [hit("c1", "m1", 0.9), hit("c1", "m2", 0.2), hit("c2", "m3", 0.8)];
  expect(selectChannelContext(hits, { minScore: 0.5, budgetTokens: 1000 }).keys).toEqual(["c1:m1", "c2:m3"]);
  expect(
    selectChannelContext(hits, { minScore: 0.5, budgetTokens: 1000, seen: new Set(["c1:m1"]) }).keys,
  ).toEqual(["c2:m3"]);
  expect(
    selectChannelContext(hits, { minScore: 0.5, budgetTokens: 1000, excludeChannelId: "c1" }).keys,
  ).toEqual(["c2:m3"]);
});

test("selectChannelContext leaving excludeChannelId unset makes the CURRENT channel eligible", () => {
  // The 'already said here' fix: with no exclusion, this channel's own older windows can ride.
  const { keys } = selectChannelContext([hit("c1", "m1", 0.9)], { minScore: 0.5, budgetTokens: 1000 });
  expect(keys).toEqual(["c1:m1"]);
});

test("selectChannelContext trims to budget and reports what it dropped", () => {
  const big = "z".repeat(200);
  const sel = selectChannelContext([hit("c1", "m1", 0.9, big), hit("c2", "m2", 0.8, big)], {
    minScore: 0.5,
    budgetTokens: 20, // 80 chars — the first block alone exceeds it
  });
  expect(sel.keys).toEqual(["c1:m1"]); // the top hit always rides
  expect(sel.droppedForBudget).toBe(1);
});
