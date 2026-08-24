/**
 * Beckett — nightly self-repair clustering (`src/self-repair/cluster.ts`)
 * =======================================================================================
 * A hundred instances of one bug is ONE finding. The pass exists to catch the class, not the
 * instance: group by a signature of (normalized message + recoverable file:line), then keep
 * only clusters that have recurred across distinct occasions.
 *
 * Pure module — no I/O. The collectors in {@link ./sources.ts} feed it; the runner decides
 * what to file.
 */

import { createHash } from "node:crypto";

/** One raw error observation, already pulled off a real surface. */
export interface ErrorEvent {
  /** ISO-8601 when this instance happened (best-effort; missing timestamps are dropped). */
  at: string;
  /** Which surface produced it — recorded on the finding so a brief can cite evidence. */
  source: string;
  /** Exact error text, truncated only at collection time. */
  message: string;
  /** `file:line` recovered from a stack or journal line, when one is there. */
  site: string | null;
}

/** One clustered defect. A finding with no evidence attached is never emitted. */
export interface ErrorCluster {
  signature: string;
  normalized: string;
  site: string | null;
  count: number;
  /** Distinct occasion buckets (default: wall-clock minute). */
  occasions: number;
  firstSeen: string;
  lastSeen: string;
  /** One exact sample of the error text — the brief carries this, not a dump of every line. */
  sample: string;
  sources: string[];
}

export interface RecurrenceThreshold {
  /** Seen at least this many times. Default 2. */
  minCount: number;
  /** Across at least this many distinct occasions. Default 2. */
  minOccasions: number;
  /** Two timestamps in the same bucket are one occasion. Default 60s. */
  occasionMs: number;
}

const DEFAULT_RECURRENCE: RecurrenceThreshold = {
  minCount: 2,
  minOccasions: 2,
  occasionMs: 60_000,
};

const SITE_RE = /((?:src|tests|scripts|bench|deploy)\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs|tsx)):(\d+)/;

/** Recover `file:line` from a stack or journal line when the collector did not already have one. */
export function extractSite(text: string): string | null {
  const m = text.match(SITE_RE);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

/**
 * Collapse the parts of a message that make two instances of the same bug look different:
 * ids, timestamps, absolute paths, raw numbers. What remains is the class.
 */
function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\brun-\d{8}-[a-z0-9-]+\b/gi, "<run>")
    .replace(/\bwk_[a-z0-9]+\b/gi, "<wk>")
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z\b/gi, "<ts>")
    .replace(/\/(?:home|tmp|var)\/[^\s"'`]+/g, "<path>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable short id for a (normalized message + site) pair. */
function signatureOf(normalized: string, site: string | null): string {
  const material = `${normalized}\n${site ?? ""}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function clusterEvents(
  events: ErrorEvent[],
  threshold: RecurrenceThreshold = DEFAULT_RECURRENCE,
): ErrorCluster[] {
  const groups = new Map<string, ErrorEvent[]>();
  for (const event of events) {
    if (!event.message.trim()) continue;
    if (!Number.isFinite(Date.parse(event.at))) continue;
    const site = event.site ?? extractSite(event.message);
    const normalized = normalizeMessage(event.message);
    if (!normalized) continue;
    const signature = signatureOf(normalized, site);
    const list = groups.get(signature) ?? [];
    list.push({ ...event, site });
    groups.set(signature, list);
  }

  const clusters: ErrorCluster[] = [];
  for (const [signature, list] of groups) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const occasions = countOccasions(list.map((e) => Date.parse(e.at)), threshold.occasionMs);
    const sources = [...new Set(list.map((e) => e.source))].sort();
    clusters.push({
      signature,
      normalized: normalizeMessage(first.message),
      site: first.site,
      count: list.length,
      occasions,
      firstSeen: first.at,
      lastSeen: last.at,
      sample: first.message,
      sources,
    });
  }

  return clusters
    .filter((c) => qualifies(c, threshold))
    .sort((a, b) => b.count - a.count || b.occasions - a.occasions || a.signature.localeCompare(b.signature));
}

/** A one-off is an incident; a repeat across occasions is a defect. */
function qualifies(cluster: ErrorCluster, threshold: RecurrenceThreshold = DEFAULT_RECURRENCE): boolean {
  return cluster.count >= threshold.minCount && cluster.occasions >= threshold.minOccasions;
}

function countOccasions(timestamps: number[], bucketMs: number): number {
  const buckets = new Set<number>();
  for (const ts of timestamps) buckets.add(Math.floor(ts / bucketMs));
  return buckets.size;
}
