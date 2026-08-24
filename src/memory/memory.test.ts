/**
 * Memory subsystem tests (OPS-121 "better memory").
 * Pins: recall across wordings (stemming + full-body scan), targeted --type/--name filters,
 * cross-session retrieval (a fresh store instance sees what another wrote), write-time dedup,
 * and the maintenance pass (TTL/supersede archiving, duplicate merge, flag band, dry-run) —
 * all with the no-data-loss guarantee (archive, never delete).
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, recallOver, type MemoryStore } from "./index.ts";
import { stem, scoreNode, nodeSimilarity } from "./search.ts";
import { planMaintenance, startRoutineMaintenance, TTL_GRACE_MS } from "./maintain.ts";
import { AGED_OBSERVATION_DAYS } from "./freshness.ts";
import type { Logger, MemoryNode } from "../types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const quietLog: Logger = (() => {
  const q = { debug() {}, info() {}, warn() {}, error() {}, child: () => q };
  return q as unknown as Logger;
})();

function tempStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "beckett-memory-"));
  tmpDirs.push(dir);
  return { store: createMemory({ memoryDir: dir, logger: quietLog, git: false }), dir };
}

async function seedWorld(store: MemoryStore): Promise<void> {
  await store.remember({
    op: "create",
    name: "jason",
    type: "person",
    description: "Primary user and owner — talks casual lowercase",
    body: "GitHub frgmt0. Works from [[loom-desk]].",
    source: "manual",
    reason: "test seed",
  });
  await store.remember({
    op: "create",
    name: "loom-desk",
    type: "env",
    description: "Ubuntu host where beckett runs",
    body: "Projects live under ~/Projects. The cloudflared tunnel token lives in ~/.cloudflared/config.yml.",
    source: "manual",
    reason: "test seed",
  });
  await store.remember({
    op: "create",
    name: "docs-site",
    type: "project",
    description: "Deploy the docs site to Cloudflare Pages",
    source: "manual",
    reason: "test seed",
  });
}

// ── stemming + scoring primitives ────────────────────────────────────────────────────────

test("stem collapses plural/-ed/-ing/-e variants onto one form", () => {
  expect(stem("deployed")).toBe(stem("deploy"));
  expect(stem("deploying")).toBe(stem("deploys"));
  expect(stem("released")).toBe(stem("release"));
  expect(stem("memories")).toBe(stem("memory"));
  expect(stem("running")).toBe("run");
});

test("scoreNode matches a fact buried in the body, not just the description", () => {
  const node = {
    name: "loom-desk",
    type: "env",
    description: "Ubuntu host where beckett runs",
    metadata: {},
    body: "The cloudflared tunnel token lives in ~/.cloudflared/config.yml.",
  } as unknown as MemoryNode;
  expect(scoreNode("cloudflared token", node)).toBeGreaterThan(0);
  expect(scoreNode("kubernetes cluster", node)).toBe(0);
});

// ── recall: wording variance + targeted filters + cross-session ─────────────────────────

test("recall surfaces the right node when the query wording differs from the stored fact", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const r = await store.recall({ text: "how are we deploying the documentation site?" });
  expect(r.hits.length).toBeGreaterThan(0);
  expect(r.hits[0]!.node.name).toBe("docs-site"); // "deploying" → "deploy", "site" exact
});

test("recall finds body-only facts (full-node scan, not just the index line)", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const r = await store.recall({ text: "where is the cloudflared tunnel token" });
  expect(r.hits.map((h) => h.node.name)).toContain("loom-desk");
});

test("recall --type is a hard filter; empty query with a filter lists the filtered set", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const typed = await store.recall({ text: "", filter: { types: ["person"] } });
  expect(typed.hits.map((h) => h.node.name)).toEqual(["jason"]);
  const scored = await store.recall({ text: "deploy the site", filter: { types: ["project"] } });
  expect(scored.hits.every((h) => h.node.type === "project")).toBe(true);
});

test("recall --name always returns the named node, even if the query text is unrelated", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const r = await store.recall({ text: "completely unrelated words", filter: { names: ["jason"] } });
  expect(r.hits.map((h) => h.node.name)).toEqual(["jason"]);
});

test("cross-session: a FRESH store instance over the same dir sees earlier writes", async () => {
  const { store, dir } = tempStore();
  await seedWorld(store);
  const secondSession = createMemory({ memoryDir: dir, logger: quietLog, git: false });
  const r = await secondSession.recall({ text: "who is the owner jason" });
  expect(r.hits[0]!.node.name).toBe("jason");
  expect(r.index.length).toBe(3); // the always-loaded global index is complete
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("[[jason]]");
});

// ── remember: write-time dedup ────────────────────────────────────────────────────────────

test("remember coerces a reworded duplicate create into an update of the existing node", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "marketing-team",
    type: "person",
    description: "The marketing team at Acme handles all campaign work",
    source: "manual",
    reason: "seed",
  });
  const node = await store.remember({
    op: "create",
    name: "the-marketing-team",
    type: "person",
    description: "Marketing team at Acme handling the campaign work",
    source: "manual",
    reason: "dup attempt",
  });
  expect(node.name).toBe("marketing-team"); // updated, not duplicated
  const g = store.buildGraph();
  expect(g.nodes.has("the-marketing-team")).toBe(false);
});

test("remember rejects a description-less create instead of orphaning an unparseable file", async () => {
  const { store, dir } = tempStore();
  await expect(
    store.remember({ op: "create", name: "no-desc", type: "reference", source: "manual", reason: "seed" }),
  ).rejects.toThrow(/description/);
  const files = readdirSync(dir, { recursive: true }) as string[];
  expect(files.some((f) => String(f).includes("no-desc"))).toBe(false); // nothing landed on disk
});

// ── remember: the always-loaded MEMORY.md index tracks the current claim (issue #96) ─────

/** The MEMORY.md line for `name`, minus the `- [[name]] — ` prefix (age flag included). */
function indexHook(dir: string, name: string): string | undefined {
  const line = readFileSync(join(dir, "MEMORY.md"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`- [[${name}]]`));
  return line?.replace(new RegExp(`^- \\[\\[${name}\\]\\] — `), "");
}

test("update-then-read-index shows the NEW hook, not the old description", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create", name: "gh-token-note", type: "reference",
    description: "old claim about the token", body: "orig", source: "manual", reason: "seed",
  });
  expect(indexHook(dir, "gh-token-note")).toBe("old claim about the token");

  await store.remember({
    op: "update", name: "gh-token-note", type: "reference",
    description: "the refreshed one-line claim", body: "restated body", source: "manual", reason: "re-observe",
  });

  const idx = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(indexHook(dir, "gh-token-note")).toBe("the refreshed one-line claim");
  expect(idx).not.toContain("old claim about the token"); // the stale hook is gone
  expect(idx.match(/\[\[gh-token-note\]\]/g)!.length).toBe(1); // still exactly one line
});

test("regression (#96): a re-observation that restates the body drags the index hook with it", async () => {
  const { store, dir } = tempStore();
  // The exact shape that bit us: index says the thing is broken.
  await store.remember({
    op: "create", name: "cross-fork-pr-limit", type: "reference",
    description: "PAT can't open PRs on external repos; hand a compare link",
    body: "Tried it, got a 403.", source: "manual", reason: "seed",
  });
  expect(indexHook(dir, "cross-fork-pr-limit")).toContain("can't open PRs");

  // Re-observed and CONFIRMED WORKING — body restated, but the caller forgot the description.
  await store.remember({
    op: "update", name: "cross-fork-pr-limit", type: "reference",
    body: "CONFIRMED WORKING under the classic PAT — open cross-fork PRs natively.",
    source: "manual", reason: "re-observed 2026-07-02",
  });

  const idx = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(idx).not.toContain("can't open PRs"); // the always-loaded line no longer lies
  expect(indexHook(dir, "cross-fork-pr-limit")).toContain("CONFIRMED WORKING");
});

test("a new memory still appends exactly one index line; a deleted one drops its line", async () => {
  const { store, dir } = tempStore();
  await seedWorld(store); // jason, loom-desk, docs-site
  const before = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(before.match(/^- \[\[/gm)!.length).toBe(3);

  await store.remember({
    op: "create", name: "new-fact", type: "decision",
    description: "a brand new one-liner",
    metadata: { ttl: new Date(Date.now() - TTL_GRACE_MS - 86_400_000).toISOString() },
    source: "manual", reason: "add",
  });
  const after = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(after.match(/^- \[\[/gm)!.length).toBe(4); // one line appended
  expect(indexHook(dir, "new-fact")).toBe("a brand new one-liner");

  // Retiring a node (archived on ttl expiry — nothing is ever hard-removed) drops its index line.
  await store.maintain();
  const pruned = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(pruned.match(/^- \[\[/gm)!.length).toBe(3);
  expect(pruned).not.toContain("[[new-fact]]");
});

test("preserves ordering and the · upd freshness flag when an update rewrites a hook", async () => {
  const { store, dir } = tempStore();
  await seedWorld(store);
  // Backdate loom-desk's `updated` so its index line earns the 90d+ ` · upd YYYY-MM-DD` flag.
  const desk = store.buildGraph().nodes.get("loom-desk")!;
  const stale = "2020-01-01";
  writeFileSync(
    desk.path,
    readFileSync(desk.path, "utf8").replace(/updated: .*/, `updated: ${stale}`),
  );
  utimesSync(desk.path, new Date(`${stale}T00:00:00Z`), new Date(`${stale}T00:00:00Z`));

  // An unrelated update regenerates the WHOLE index — loom-desk's aged flag must survive it,
  // and the deterministic type→name ordering must be untouched.
  await store.remember({
    op: "update", name: "jason", type: "person",
    description: "Primary user and owner — talks casual lowercase", body: "still here",
    source: "manual", reason: "touch",
  });
  const after = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(after).toContain(`· upd ${stale}`); // loom-desk still self-flags as an aged observation
  // Ordering is stable: grouped by type, then name — [env] loom-desk, [person] jason, [project] docs-site.
  expect(after.match(/^- \[\[[a-z-]+\]\]/gm)).toEqual([
    "- [[loom-desk]]", "- [[jason]]", "- [[docs-site]]",
  ]);
});

// ── maintenance: staleness, supersede, dedup merge, dry-run, no data loss ────────────────

test("maintain archives a node whose ttl expired past the grace window (file preserved)", async () => {
  const { store, dir } = tempStore();
  await seedWorld(store);
  await store.remember({
    op: "create",
    name: "beta-freeze",
    type: "decision",
    description: "Feature freeze for the beta until launch",
    metadata: { ttl: new Date(Date.now() - TTL_GRACE_MS - 86_400_000).toISOString() },
    source: "manual",
    reason: "seed",
  });
  const report = await store.maintain();
  expect(report.archives.map((a) => a.name)).toEqual(["beta-freeze"]);
  const g = store.buildGraph();
  expect(g.nodes.has("beta-freeze")).toBe(false); // out of the graph…
  const archived = readdirSync(join(dir, "archive"));
  expect(archived.some((f) => f.startsWith("beta-freeze"))).toBe(true); // …but never deleted
  const raw = readFileSync(join(dir, "archive", archived.find((f) => f.startsWith("beta-freeze"))!), "utf8");
  expect(raw).toContain("Feature freeze");
  expect(raw).toContain("archived_reason: expired-ttl");
});

test("maintain keeps a node whose ttl expired but is still inside the grace window", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "fresh-expiry",
    type: "decision",
    description: "Recently expired decision still in grace",
    metadata: { ttl: new Date(Date.now() - 3_600_000).toISOString() },
    source: "manual",
    reason: "seed",
  });
  const report = await store.maintain();
  expect(report.archives).toEqual([]);
  expect(store.buildGraph().nodes.get("fresh-expiry")?.stale).toBe(true); // deprioritized, not dropped
});

test("recall notices a ttl that expired AFTER the graph was built (warm daemon)", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "expiring-freeze",
    type: "decision",
    description: "Temporary feature freeze decision",
    metadata: { ttl: new Date(Date.now() + 50).toISOString() },
    source: "manual",
    reason: "seed",
  });
  const g = store.buildGraph();
  expect(g.nodes.get("expiring-freeze")!.stale).toBe(false); // not yet expired at parse time
  await new Promise((r) => setTimeout(r, 120)); // ttl lapses while the graph sits cached
  const r = recallOver({ text: "temporary feature freeze decision" }, g);
  expect(r.notes.some((n) => n.startsWith("expiring-freeze is stale"))).toBe(true);
});

test("maintain archives a superseded decision", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "old-plan",
    type: "decision",
    description: "Ship the site from the tunnel host",
    source: "manual",
    reason: "seed",
  });
  await store.remember({
    op: "create",
    name: "new-plan",
    type: "decision",
    description: "Ship the site from Cloudflare Pages edge",
    links: [{ to: "old-plan", field: "supersedes" }],
    source: "manual",
    reason: "seed",
  });
  const report = await store.maintain();
  expect(report.archives).toEqual([
    { name: "old-plan", reason: "superseded", by: "new-plan", detail: "superseded by new-plan" },
  ]);
  const g = store.buildGraph();
  expect(g.nodes.has("new-plan")).toBe(true);
  expect(g.nodes.get("old-plan")?.phantom ?? true).toBe(true); // only the dangling ref remains
});

test("maintain merges near-identical nodes: content kept, alias added, inbound links rewritten", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create",
    name: "site-deploy",
    type: "project",
    description: "Deploy the docs site to Cloudflare Pages",
    metadata: { created: "2026-01-01T00:00:00.000Z" },
    body: "Canonical body.",
    source: "manual",
    reason: "seed",
  });
  // Bypass write-time dedup deliberately (as if written by an older Beckett) by writing the
  // near-duplicate with a disjoint description first, then editing the file on disk.
  await store.remember({
    op: "create",
    name: "site-deploying",
    type: "project",
    description: "zzz placeholder wording completely different",
    metadata: { created: "2026-02-01T00:00:00.000Z" },
    body: "Duplicate body with an extra detail: uses wrangler.",
    source: "manual",
    reason: "seed",
  });
  const dupPath = store.buildGraph().nodes.get("site-deploying")!.path;
  const raw = readFileSync(dupPath, "utf8").replace(
    "zzz placeholder wording completely different",
    "Deploying the docs site to Cloudflare Pages",
  );
  await Bun.write(dupPath, raw);
  await store.remember({
    op: "create",
    name: "observer",
    type: "reference",
    description: "Notes that link to the duplicate",
    body: "See [[site-deploying]] for details.",
    source: "manual",
    reason: "seed",
  });

  const report = await store.maintain();
  expect(report.merges).toEqual([
    { canonical: "site-deploy", duplicate: "site-deploying", similarity: expect.any(Number) },
  ]);

  const g = store.buildGraph();
  const canonical = g.nodes.get("site-deploy")!;
  expect(canonical.body).toContain("Canonical body.");
  expect(canonical.body).toContain("Merged from site-deploying");
  expect(canonical.body).toContain("uses wrangler"); // duplicate's content preserved
  expect(canonical.metadata.aliases).toContain("site-deploying"); // old name still resolves
  expect(g.nodes.get("site-deploying")?.phantom ?? true).toBe(true);
  expect(readFileSync(g.nodes.get("observer")!.path, "utf8")).toContain("[[site-deploy]]"); // link retargeted
  expect(existsSync(join(dir, "archive"))).toBe(true);

  // And the old name keeps working through remember's alias dedup.
  const again = await store.remember({
    op: "update",
    name: "site-deploying",
    description: "Deploy the docs site to Cloudflare Pages",
    source: "manual",
    reason: "post-merge write",
  });
  expect(again.name).toBe("site-deploy");
});

test("maintain only FLAGS a borderline pair (identical desc, mostly different names)", async () => {
  const { store } = tempStore();
  await store.remember({
    op: "create",
    name: "jason-design",
    type: "preference",
    description: "Jason wants editorial experience-first design with real craft",
    source: "manual",
    reason: "seed",
  });
  // Write-time dedup would (correctly) collapse this pair today, so plant the borderline
  // duplicate the way it really occurs: pre-existing on disk from an older Beckett.
  await store.remember({
    op: "create",
    name: "jason-taste",
    type: "preference",
    description: "zzz totally unrelated placeholder wording",
    source: "manual",
    reason: "seed",
  });
  const path = store.buildGraph().nodes.get("jason-taste")!.path;
  await Bun.write(
    path,
    readFileSync(path, "utf8").replace(
      "zzz totally unrelated placeholder wording",
      "Jason wants editorial experience-first design with real craft",
    ),
  );
  const report = await store.maintain();
  expect(report.merges).toEqual([]);
  expect(report.flagged.length).toBe(1);
  const g = store.buildGraph();
  expect(g.nodes.has("jason-design")).toBe(true);
  expect(g.nodes.has("jason-taste")).toBe(true); // both survive — human's call
});

test("maintain --dry-run plans without touching the store", async () => {
  const { store, dir } = tempStore();
  await store.remember({
    op: "create",
    name: "doomed",
    type: "decision",
    description: "Will be archived when executed",
    metadata: { ttl: "2020-01-01T00:00:00.000Z" },
    source: "manual",
    reason: "seed",
  });
  const before = readdirSync(dir, { recursive: true });
  const report = await store.maintain({ dryRun: true });
  expect(report.dryRun).toBe(true);
  expect(report.archives.map((a) => a.name)).toEqual(["doomed"]);
  expect(readdirSync(dir, { recursive: true })).toEqual(before);
  expect(store.buildGraph().nodes.has("doomed")).toBe(true);
});

// ── plan + scheduler plumbing ─────────────────────────────────────────────────────────────

test("planMaintenance is pure and reports phantoms", async () => {
  const { store } = tempStore();
  await seedWorld(store); // jason's body links [[loom-desk]] (real); add a dangling ref
  await store.remember({
    op: "create",
    name: "note",
    type: "reference",
    description: "A note referencing someone we have not met",
    body: "Ask [[mystery-person]] about it.",
    source: "manual",
    reason: "seed",
  });
  const plan = planMaintenance(store.buildGraph(), Date.now());
  expect(plan.phantoms).toEqual(["mystery-person"]);
  expect(plan.archives).toEqual([]);
});

// A fake `MaintenanceScheduler` (`maintain.ts`) that captures the boot-delay/interval callbacks
// instead of arming real timers, so the test drives passes on demand — no real `setTimeout` wait,
// no race against CI contention deciding how many real 20ms ticks land inside a real 60ms window.
function fakeMaintenanceScheduler() {
  let timeoutCb: (() => void | Promise<void>) | null = null;
  let intervalCb: (() => void | Promise<void>) | null = null;
  return {
    setTimeout(cb: () => void | Promise<void>) {
      timeoutCb = cb;
      return "timeout";
    },
    setInterval(cb: () => void | Promise<void>) {
      intervalCb = cb;
      return "interval";
    },
    clearTimeout(h: unknown) {
      if (h === "timeout") timeoutCb = null;
    },
    clearInterval(h: unknown) {
      if (h === "interval") intervalCb = null;
    },
    async fireTimeout() {
      await timeoutCb?.();
    },
    async fireInterval() {
      await intervalCb?.();
    },
  };
}

test("startRoutineMaintenance runs the boot pass, then each interval tick, and stop() halts the schedule", async () => {
  let runs = 0;
  const scheduler = fakeMaintenanceScheduler();
  const handle = startRoutineMaintenance({
    maintain: async () => {
      runs++;
      return { scanned: 0, archives: [], merges: [], flagged: [], phantoms: [], agedObservations: [], dryRun: false };
    },
    logger: quietLog,
    initialDelayMs: 5,
    intervalMs: 20,
    scheduler,
  });

  await scheduler.fireTimeout(); // the boot-delay pass
  expect(runs).toBe(1);

  await scheduler.fireInterval();
  await scheduler.fireInterval();
  expect(runs).toBe(3);

  handle.stop();
  await scheduler.fireInterval(); // cleared by stop() — a no-op now
  expect(runs).toBe(3);
});

// ── maintenance: SEE the whole store, report accurately (issue #97) ──────────────────────

/** The store's on-disk memory count, the same way the graph build enumerates it. */
function mdFileCount(dir: string): number {
  return (readdirSync(dir, { recursive: true }) as string[]).filter(
    (r) => r.endsWith(".md") && r !== "MEMORY.md" && !r.split(/[\\/]/).includes("archive"),
  ).length;
}

test("maintain scans every memory file; a linked memory that exists on disk is not a phantom", async () => {
  const { store, dir } = tempStore();
  await seedWorld(store); // jason's body links [[loom-desk]] — a real, on-disk target
  const report = await store.maintain({ dryRun: true });
  // Every .md the store holds is scanned — no fraction of the tree left unseen.
  expect(report.scanned).toBe(mdFileCount(dir));
  // The linked-and-present node resolves to a real node, never a manufactured phantom.
  expect(report.phantoms).not.toContain("loom-desk");
  expect(store.buildGraph().nodes.get("loom-desk")?.phantom ?? true).toBe(false);
});

test("maintain does not mint phantoms from literal [[name]] examples inside code spans/fences", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  // A note that DOCUMENTS the memory format: illustrative links live in backticks and a fence,
  // one genuine dangling link lives in prose. Only the prose link is a real (phantom) edge.
  await store.remember({
    op: "create",
    name: "memory-format-note",
    type: "reference",
    description: "How wikilinks work in this store",
    body: [
      "A `[[name]]` in frontmatter is a graph edge; `[[wikilinks]]` resolve by name.",
      "",
      "```",
      "example: [[fenced-placeholder]] is not a real link",
      "```",
      "",
      "But this one is genuine: ask [[unmet-person]] about it.",
    ].join("\n"),
    source: "manual",
    reason: "seed",
  });
  const report = await store.maintain({ dryRun: true });
  expect(report.phantoms).not.toContain("name");
  expect(report.phantoms).not.toContain("wikilinks");
  expect(report.phantoms).not.toContain("fenced-placeholder");
  expect(report.phantoms).toContain("unmet-person"); // a real prose link still counts
});

test("maintain does not report a name with a broken file on disk as a phantom", async () => {
  const { store, dir } = tempStore();
  await seedWorld(store);
  // A real memory links to `[[courier-note]]`, whose file exists but failed to parse (a
  // truncated write: empty name, no type). That's a broken file, not a missing one.
  await store.remember({
    op: "create",
    name: "references-courier",
    type: "reference",
    description: "Points at the courier note",
    body: "See [[courier-note]] for the details.",
    source: "manual",
    reason: "seed",
  });
  writeFileSync(join(dir, "courier-note.md"), '---\nname: ""\nmetadata:\n  node_type: memory\n---\n\nbody only.\n');
  const report = await store.maintain({ dryRun: true });
  expect(report.phantoms).not.toContain("courier-note");
  // The pass still SEES the broken file — it counts toward scanned, not silently dropped.
  expect(report.scanned).toBe(mdFileCount(dir));
});

test("maintain lists a memory whose updated date is past the aged threshold", async () => {
  const { store } = tempStore();
  await seedWorld(store);
  const desk = store.buildGraph().nodes.get("loom-desk")!;
  const aged = new Date(Date.now() - (AGED_OBSERVATION_DAYS + 30) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  writeFileSync(
    desk.path,
    readFileSync(desk.path, "utf8").replace(/updated: .*/, `updated: ${aged}`),
  );
  const report = await store.maintain({ dryRun: true });
  expect(report.agedObservations.map((a) => a.name)).toContain("loom-desk");
  const entry = report.agedObservations.find((a) => a.name === "loom-desk")!;
  expect(entry.ageDays).toBeGreaterThanOrEqual(AGED_OBSERVATION_DAYS);
});

test("nodeSimilarity treats reworded same facts as near-identical", () => {
  const a = { name: "deploy-docs", description: "Deploy the docs site to Cloudflare Pages" };
  const b = { name: "deploying-docs", description: "Deploying the docs sites to Cloudflare Pages" };
  expect(nodeSimilarity(a, b)).toBeGreaterThanOrEqual(0.9);
  const c = { name: "unrelated", description: "Weekly standup notes for the mobile app" };
  expect(nodeSimilarity(a, c)).toBeLessThan(0.3);
});
