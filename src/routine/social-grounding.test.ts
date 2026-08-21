import { expect, test } from "bun:test";
import {
  buildGroundingBlock,
  needsGroundingSources,
  GROUNDING_UNAVAILABLE_NOTE,
  type GroundingDeps,
} from "./social-grounding.ts";
import type { OwnHistoryItem } from "./own-history.ts";

const NOW = new Date("2026-08-21T12:00:00.000Z");

function baseDeps(overrides: Partial<GroundingDeps> = {}): GroundingDeps {
  return {
    fetchModelNews: async () => ({ ok: true, items: [] }),
    fetchTechNews: async () => ({ items: [], errors: [] }),
    ownHistory: () => [],
    now: () => NOW,
    ...overrides,
  };
}

// ── needsGroundingSources ────────────────────────────────────────────────────────────────────

test("a plain compose instruction needs grounding sources", () => {
  expect(needsGroundingSources("Compose today's shitpost — one fresh, in-voice line.")).toBe(true);
});

test("a watch-lane EVENT TRIGGER subject skips grounding — it's already sourced from the item", () => {
  expect(needsGroundingSources("EVENT TRIGGER (not a scheduled lane): the model-news feed...")).toBe(false);
});

test("a TIMELINE REPLY ROUND skips grounding — it's sourced from the live page", () => {
  expect(needsGroundingSources("TIMELINE REPLY ROUND: open the home timeline...")).toBe(false);
});

// ── buildGroundingBlock ──────────────────────────────────────────────────────────────────────

test("returns the honest unavailable note when every source is empty and nothing errored", async () => {
  const block = await buildGroundingBlock(baseDeps());
  expect(block).toBe(GROUNDING_UNAVAILABLE_NOTE);
});

test("includes the feed error inline when every source is empty because feeds failed", async () => {
  const block = await buildGroundingBlock(
    baseDeps({
      fetchModelNews: async () => ({ ok: false, reason: "feed returned HTTP 503" }),
      fetchTechNews: async () => ({ items: [], errors: ["hacker news down"] }),
    }),
  );
  expect(block).toContain(GROUNDING_UNAVAILABLE_NOTE);
  expect(block).toContain("feed returned HTTP 503");
  expect(block).toContain("hacker news down");
});

test("formats real tech-news items and own-history items into the SOURCES block", async () => {
  const history: OwnHistoryItem[] = [
    { id: "1", summary: "a deploy that ate itself", at: "2026-08-20T10:00:00.000Z", source: "run ledger" },
  ];
  const block = await buildGroundingBlock(
    baseDeps({
      fetchModelNews: async () => ({
        ok: true,
        items: [
          {
            id: "m1",
            title: "New model shipped",
            summary: "a summary",
            tags: [],
            source: { url: "https://example.com/m1" },
            publishedAt: "2026-08-20T00:00:00.000Z",
            newModel: true,
            models: ["m1"],
            removedModels: [],
          },
        ],
      }),
      fetchTechNews: async () => ({
        items: [
          {
            id: "hn-1",
            title: "Something happened in tech",
            summary: "100 points",
            url: "https://example.com/hn1",
            publishedAt: "2026-08-21T00:00:00.000Z",
            source: "hacker news",
          },
        ],
        errors: [],
      }),
      ownHistory: () => history,
    }),
  );
  expect(block).toContain("SOURCES FOR THIS RUN");
  expect(block).toContain("New model shipped");
  expect(block).toContain("Something happened in tech");
  expect(block).toContain("a deploy that ate itself");
  expect(block).toContain("run ledger");
});

test("drops a stale tech-news item (older than the grounding recency window)", async () => {
  const block = await buildGroundingBlock(
    baseDeps({
      fetchTechNews: async () => ({
        items: [
          {
            id: "hn-old",
            title: "Ancient history",
            summary: "old",
            url: "https://example.com/old",
            publishedAt: "2020-01-01T00:00:00.000Z",
            source: "hacker news",
          },
        ],
        errors: [],
      }),
    }),
  );
  expect(block).not.toContain("Ancient history");
  expect(block).toBe(GROUNDING_UNAVAILABLE_NOTE);
});

test("never throws even if a fetcher or the own-history reader itself throws", async () => {
  const block = await buildGroundingBlock(
    baseDeps({
      fetchModelNews: async () => {
        throw new Error("network exploded");
      },
      fetchTechNews: async () => {
        throw new Error("also exploded");
      },
      ownHistory: () => {
        throw new Error("fs exploded");
      },
    }),
  );
  expect(block).toContain(GROUNDING_UNAVAILABLE_NOTE);
});
