/**
 * Beckett — general tech-news feeds (`src/routine/tech-news.ts`)
 * =======================================================================================
 * The general-tech-news half of the social-media agent's mandatory grounding step (real-sources
 * ticket, Half 1): `./model-news.ts`'s `MODEL_NEWS_FEED_URL` only ever reports AI model releases,
 * and ro's ask was for tech news generally, not just models. This wires two more real, public,
 * no-auth JSON feeds alongside it, fetched and defensively parsed the SAME way
 * `fetchModelNewsFeed` is — a non-200, a timeout, unparseable JSON, or one malformed item never
 * throws, and never blinds the caller to whatever else the feed still says.
 *
 *   - Hacker News' front page (Algolia's public search API) — general tech news, the "wide world
 *     of tech" the system prompt's TOPIC DOCTRINE already asks for.
 *   - GitHub's and Cloudflare's status pages (both Statuspage.io-hosted, so one parser serves
 *     both) — the "infra outages" lane, and a fittingly real antidote to the exact bug this
 *     feature fixes (the account's most recent fabricated post invented a Cloudflare outage).
 *
 * Every item normalizes to {@link TechNewsItem} so `./social-grounding.ts` can format one list
 * regardless of which feed an item came from.
 */

import { z } from "zod";

export interface TechNewsItem {
  id: string;
  title: string;
  summary: string;
  url: string | null;
  publishedAt: string;
  source: string;
}

const HACKER_NEWS_FEED_URL = "https://hn.algolia.com/api/v1/search?tags=front_page";
const GITHUB_STATUS_FEED_URL = "https://www.githubstatus.com/api/v2/incidents.json";
const CLOUDFLARE_STATUS_FEED_URL = "https://www.cloudflarestatus.com/api/v2/incidents.json";

/** How long a single feed request is allowed to hang before it counts as a broken round. */
const TECH_NEWS_FETCH_TIMEOUT_MS = 8_000;

type TechNewsFetchResult = { ok: true; items: TechNewsItem[] } | { ok: false; reason: string };

/** Shared fetch+timeout+JSON-parse plumbing — the same defensive shape `fetchModelNewsFeed` uses. */
async function fetchJsonFeed(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch },
  parse: (raw: unknown) => TechNewsFetchResult,
): Promise<TechNewsFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TECH_NEWS_FETCH_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, reason: `feed request failed: ${(err as Error).message}` };
  }
  if (!res.ok) return { ok: false, reason: `feed returned HTTP ${res.status}` };
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    return { ok: false, reason: `feed body is not valid JSON: ${(err as Error).message}` };
  }
  return parse(raw);
}

const HnHitSchema = z
  .object({
    objectID: z.string(),
    title: z.string().optional(),
    story_title: z.string().optional(),
    url: z.string().optional(),
    story_url: z.string().optional(),
    points: z.number().optional(),
    num_comments: z.number().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();
const HnFeedSchema = z.object({ hits: z.array(z.unknown()) }).passthrough();

/** Hacker News' front page via Algolia's public search API — no auth, stable, widely used. */
export async function fetchHackerNewsFeed(
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; url?: string } = {},
): Promise<TechNewsFetchResult> {
  return fetchJsonFeed(opts.url ?? HACKER_NEWS_FEED_URL, opts, (raw) => {
    const shape = HnFeedSchema.safeParse(raw);
    if (!shape.success) return { ok: false, reason: "hacker news feed has no hits array" };
    const items: TechNewsItem[] = [];
    for (const candidate of shape.data.hits) {
      const parsed = HnHitSchema.safeParse(candidate);
      if (!parsed.success) continue; // one malformed hit is dropped, not fatal
      const hit = parsed.data;
      const title = hit.title || hit.story_title || "";
      if (!title) continue;
      items.push({
        id: `hn-${hit.objectID}`,
        title,
        summary: `${hit.points ?? 0} points, ${hit.num_comments ?? 0} comments on Hacker News`,
        url: hit.url || hit.story_url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        publishedAt: hit.created_at ?? "",
        source: "hacker news",
      });
    }
    return { ok: true, items };
  });
}

const StatuspageIncidentSchema = z
  .object({
    id: z.string(),
    name: z.string().optional().default(""),
    status: z.string().optional().default(""),
    impact: z.string().optional().default(""),
    shortlink: z.string().optional(),
    created_at: z.string().optional().default(""),
    updated_at: z.string().optional().default(""),
  })
  .passthrough();
const StatuspageFeedSchema = z.object({ incidents: z.array(z.unknown()) }).passthrough();

/** A Statuspage.io-hosted incident feed — GitHub's and Cloudflare's status pages both use it. */
export async function fetchStatuspageIncidents(
  url: string,
  source: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<TechNewsFetchResult> {
  return fetchJsonFeed(url, opts, (raw) => {
    const shape = StatuspageFeedSchema.safeParse(raw);
    if (!shape.success) return { ok: false, reason: `${source} feed has no incidents array` };
    const items: TechNewsItem[] = [];
    for (const candidate of shape.data.incidents) {
      const parsed = StatuspageIncidentSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const inc = parsed.data;
      if (!inc.name) continue;
      items.push({
        id: `${source}-${inc.id}`,
        title: inc.name,
        summary: `status: ${inc.status || "unknown"}, impact: ${inc.impact || "unknown"}`,
        url: inc.shortlink ?? null,
        publishedAt: inc.updated_at || inc.created_at,
        source,
      });
    }
    return { ok: true, items };
  });
}

/**
 * Fetch every general tech-news feed (Hacker News + both status pages) concurrently. Never
 * throws and never lets one feed's failure blind the caller to the others — each result is
 * reported independently, and the caller (`./social-grounding.ts`) decides how to present a
 * partial round.
 */
export async function fetchAllTechNewsFeeds(
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ items: TechNewsItem[]; errors: string[] }> {
  const results = await Promise.all([
    fetchHackerNewsFeed(opts),
    fetchStatuspageIncidents(GITHUB_STATUS_FEED_URL, "github status", opts),
    fetchStatuspageIncidents(CLOUDFLARE_STATUS_FEED_URL, "cloudflare status", opts),
  ]);
  const items: TechNewsItem[] = [];
  const errors: string[] = [];
  for (const result of results) {
    if (result.ok) items.push(...result.items);
    else errors.push(result.reason);
  }
  return { items, errors };
}
