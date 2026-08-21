import { expect, test } from "bun:test";
import { fetchAllTechNewsFeeds, fetchHackerNewsFeed, fetchStatuspageIncidents } from "./tech-news.ts";

const GITHUB_STATUS_FEED_URL = "https://www.githubstatus.com/api/v2/incidents.json";
const CLOUDFLARE_STATUS_FEED_URL = "https://www.cloudflarestatus.com/api/v2/incidents.json";

// ── fetchHackerNewsFeed — defensive against a third-party feed ──────────────────────────────

test("parses a well-formed Hacker News front-page response", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        hits: [
          {
            objectID: "123",
            title: "Rust rewrite of everything",
            url: "https://example.com/rust",
            points: 400,
            num_comments: 88,
            created_at: "2026-08-20T12:00:00.000Z",
          },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const res = await fetchHackerNewsFeed({ fetchImpl });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: "hn-123",
      title: "Rust rewrite of everything",
      url: "https://example.com/rust",
      source: "hacker news",
    });
  }
});

test("drops a hit with no title rather than failing the whole round", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ hits: [{ objectID: "1" }, { objectID: "2", title: "real story" }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  const res = await fetchHackerNewsFeed({ fetchImpl });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.items.map((i) => i.id)).toEqual(["hn-2"]);
});

test("a non-200 HN response is reported, not thrown", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const res = await fetchHackerNewsFeed({ fetchImpl });
  expect(res.ok).toBe(false);
});

test("a network failure is reported, not thrown", async () => {
  const fetchImpl = (async () => {
    throw new Error("DNS failure");
  }) as unknown as typeof fetch;
  const res = await fetchHackerNewsFeed({ fetchImpl });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("DNS failure");
});

test("an unparseable body is reported, not thrown", async () => {
  const fetchImpl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
  const res = await fetchHackerNewsFeed({ fetchImpl });
  expect(res.ok).toBe(false);
});

// ── fetchStatuspageIncidents — shared by GitHub + Cloudflare status ─────────────────────────

test("parses a well-formed Statuspage incidents response", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        incidents: [
          {
            id: "inc-1",
            name: "Elevated error rates on the API",
            status: "resolved",
            impact: "minor",
            shortlink: "https://stspg.io/abc",
            created_at: "2026-08-19T09:00:00.000Z",
            updated_at: "2026-08-19T10:30:00.000Z",
          },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const res = await fetchStatuspageIncidents(GITHUB_STATUS_FEED_URL, "github status", { fetchImpl });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: "github status-inc-1",
      title: "Elevated error rates on the API",
      url: "https://stspg.io/abc",
      publishedAt: "2026-08-19T10:30:00.000Z",
      source: "github status",
    });
  }
});

test("a Statuspage response missing the incidents array is reported, not thrown", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ page: {} }), { status: 200 })) as unknown as typeof fetch;
  const res = await fetchStatuspageIncidents(CLOUDFLARE_STATUS_FEED_URL, "cloudflare status", { fetchImpl });
  expect(res.ok).toBe(false);
});

// ── fetchAllTechNewsFeeds — aggregates, never blinded by one broken feed ────────────────────

test("aggregates every feed's items and never lets one failure blind the others", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("algolia")) {
      return new Response(JSON.stringify({ hits: [{ objectID: "1", title: "hn story" }] }), { status: 200 });
    }
    if (String(url).includes("githubstatus")) {
      return new Response("boom", { status: 500 });
    }
    return new Response(JSON.stringify({ incidents: [{ id: "cf-1", name: "cloudflare hiccup" }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await fetchAllTechNewsFeeds({ fetchImpl });
  expect(result.items.map((i) => i.source).sort()).toEqual(["cloudflare status", "hacker news"]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("HTTP 500");
});
