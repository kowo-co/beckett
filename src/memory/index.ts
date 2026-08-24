/**
 * Beckett — Memory & Knowledge Graph (`src/memory/index.ts`)
 * =======================================================================================
 * The markdown knowledge-graph memory at `config.memory_dir` (~/.beckett/memory). Implements
 * the {@link Memory} contract from `../types.ts`:
 *
 *   - `recall(query)`  → a relevance-ranked bundle of memory snippets to inject into a brain
 *                        call (Spec 08 §3): always the cheap index, then description-scored
 *                        full-file hits, then one-hop link expansion. Recall NEVER truncates a
 *                        body — prompt budgeting is Spec 06's job (Spec 08 §3.4).
 *   - `remember(intent)` → create/update/append/link a memory file with dedup (Spec 08 §4),
 *                        regenerate `## Backlinks`, rewrite the always-loaded `MEMORY.md`
 *                        index, mirror to SQLite, log an event, and git-commit the memory repo.
 *   - `reindex()`      → rebuild the SQLite mirror from the markdown tree (Spec 09 §2.12).
 *   - `maintain(opts)` → the OPS-121 self-healing pass: archive expired/superseded nodes,
 *                        merge near-duplicates, flag borderline pairs. Planning is pure in
 *                        `./maintain.ts`; execution (file moves, link rewrites) lives here.
 *                        Nothing is ever deleted — archived files move to `archive/`
 *                        (excluded from the graph) and the dir is git-versioned.
 *
 * Retrieval scoring lives in `./search.ts` (OPS-121): stemmed, IDF-weighted, full-node
 * (body + metadata) keyword relevance — deliberately lexical and deterministic, not
 * embeddings. Cold stores rebuild from disk on every call. The daemon's warm store instead
 * reuses the graph and Moss handle while a metadata-only tree stamp keeps out-of-band edits
 * visible to the next query.
 *
 * Design choices honoring Spec 08:
 *   - **Files are canonical** (Spec 08 §2.4). Cold stores rebuild on every read/write; the warm
 *     daemon detects path/mtime/size changes before reuse, then rebuilds and re-syncs once. Thus
 *     an out-of-band `git pull` or manual edit remains visible without a daemon restart.
 *   - **A node's id is its `name`** (kebab-case), globally unique across the tree; `[[wikilinks]]`
 *     resolve by name regardless of folder (Spec 08 §1.1).
 *   - **Forward-refs are first-class**: `[[name]]` with no file yet is a valid dangling edge to a
 *     phantom node that upgrades in place when filled (Spec 08 §2.5).
 *   - **The index is derived from the parsed nodes**, and `MEMORY.md` is its on-disk
 *     materialization — so the index recall returns is always in sync with the files even if
 *     `MEMORY.md` is stale or hand-deleted.
 *
 * Dependency-free: the simple YAML frontmatter is parsed by a small in-file parser (no yaml lib),
 * per the module brief.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  IndexLine,
  Logger,
  Memory,
  MemoryEdge,
  MemoryGraph,
  MemoryNode,
  NodeType,
  RecallQuery,
  RelationType,
  RecallResult,
  RememberIntent,
  ScoredNode,
} from "../types.ts";
import { log as rootLog } from "../log.ts";
import {
  type Audience,
  canView,
  corpusStats,
  DEDUP_THRESHOLD,
  isInferenceNode,
  nodeSimilarity,
  provenanceOf,
  scoreNode,
} from "./search.ts";
import { MOSS_LEXICAL_SHARPENER_WEIGHT, mossScores, openMemoryMoss, syncMossWithGraph } from "./moss.ts";
import { indexAgeFlag } from "./freshness.ts";
import type { LocalMoss } from "../moss-local/index.ts";
import { planMaintenance, type MaintainReport } from "./maintain.ts";
import {
  agentRecall,
  AGENT_CANDIDATE_K,
  type AgentRecallDeps,
  type AgentRecallSession,
} from "./agent-recall.ts";
import { isBridgedNode, listBridgeFiles, loadBridgedNodes, syncBridgeDirs } from "./bridge.ts";

// =======================================================================================
// Tunables (Spec 08 §3, §4.2 — start conservative; favor flagging over auto-merge)
// =======================================================================================

/** Seeds fetched before link expansion when the query doesn't specify `k` (Spec 08 §3.2). */
const DEFAULT_K = 6;
/** Link-expansion hop depth when the query doesn't specify `hops` (Spec 08 §3.1). */
const DEFAULT_HOPS = 1;
/** A seed must beat this lexical score to qualify (Spec 08 §3.2 `RELEVANCE_FLOOR`). */
const RELEVANCE_FLOOR = 0;
/** Nodes updated within this window get a mild recall boost (fresh facts first on a tie). */
const RECENT_DAYS = 30;
/** Frontmatter fields whose `[[wikilinks]]` are structural edges (higher weight than prose). */
const STRUCTURAL_FIELDS = new Set(["members", "owners", "applies_to", "supersedes"]);
/** Reverse edges worth following on expansion; incidental prose backlinks are dropped (§3.2). */
const HIGH_VALUE_BACKLINK_FIELDS = new Set(["members", "owners", "applies_to", "supersedes"]);

/**
 * The closed relation vocabulary for typed edges (issue #60) — five types plus untyped. This is
 * deliberately NOT an extensible registry: a link's type is either one of these or absent.
 */
export const RELATION_TYPES = [
  "supersedes",
  "caused-by",
  "about",
  "contradicts",
  "part-of",
] as const;
const RELATION_ALT = RELATION_TYPES.join("|");
const RELATION_TYPE_SET: ReadonlySet<string> = new Set(RELATION_TYPES);

/**
 * A directed graph edge (Spec 08 §2.2), optionally typed + dated (issue #60):
 *
 *   [[name]]                          bare — untyped, undated (unchanged, zero migration)
 *   [[name|alias]]                    display alias           (unchanged)
 *   [[supersedes:name]]               typed edge
 *   [[supersedes:name @2026-07-14]]   typed + dated
 *   [[name @2026-07-14]]              untyped + dated
 *
 * Groups: 1 = relation type (closed vocab, optional), 2 = target name, 3 = display alias,
 * 4 = ISO observation date. A prefix that isn't in the vocab isn't a type — the `:` then can't
 * belong to a (colon-free) kebab name, so the whole token simply isn't a link. The alias group
 * is lazy so a trailing ` @YYYY-MM-DD` reads as the date, while an alias that itself contains
 * `@` (no valid trailing date) still absorbs it — bare and aliased links are untouched.
 */
const WIKILINK = new RegExp(
  `\\[\\[(?:(${RELATION_ALT}):)?([a-z0-9-]+)(?:\\|([^\\]]+?))?(?:\\s*@(\\d{4}-\\d{2}-\\d{2}))?\\]\\]`,
  "g",
);
/** Non-global copy for single-match parsing (a global regex's lastIndex is stateful). */
const WIKILINK_ONE = new RegExp(WIKILINK.source);

/** Subdirectory (top-level) that holds archived nodes — on disk, out of the graph. */
const ARCHIVE_DIR = "archive";

/**
 * The dream namespace's mandatory name shape (issue #36): the date the dream ran plus a slug.
 * The prefix is load-bearing — {@link MemoryStore.rememberDream} rejects anything else, so a
 * dream write can never collide with (or update) a node outside its own namespace.
 */
export const DREAM_NAME_RE = /^dream-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

/** Input to {@link MemoryStore.rememberDream}. Type/inference/source are NOT parameters — forced. */
export interface DreamRememberInput {
  /** `dream-YYYY-MM-DD-<slug>` — validated against {@link DREAM_NAME_RE}. */
  name: string;
  description: string;
  body?: string;
  /** The specific sources the inference was derived from (e.g. "journal:#31", "loop:x"). */
  provenance: string[];
  /** Logged into the memory git commit, like remember's reason. */
  reason: string;
}

/** Input to {@link MemoryStore.updateDream}. The node must already exist AND be a dream node. */
export interface DreamUpdateInput {
  /** `dream-YYYY-MM-DD-<slug>` of an EXISTING `type: dream` node. */
  name: string;
  /** Replaces the description when non-empty; omitted/blank keeps the current one. */
  description?: string;
  /** Replaces the body when provided (pass "" to clear it). */
  body?: string;
  /** Replaces the provenance list when non-empty; omitted keeps what the node already cites. */
  provenance?: string[];
  /** Logged into the memory git commit, like remember's reason. */
  reason: string;
}

/** Input to {@link MemoryStore.flagStaleNode} — a dream-namespace flag ABOUT another node. */
export interface DreamStaleFlagInput {
  /** `dream-YYYY-MM-DD-<slug>` for the flag node itself — a NEW node, create-only. */
  name: string;
  /** The node the flag is about. Must exist, and must NOT itself be a dream node. */
  target: string;
  /** Why the pass thinks the target has gone stale. Required — a flag with no reason is noise. */
  flagReason: string;
  /** Assembled source ids the suspicion is derived from. Required, same rule as a dream memory. */
  provenance: string[];
  /** Optional longer note for the flag's body. */
  body?: string;
  /** Logged into the memory git commit, like remember's reason. */
  reason: string;
}

/**
 * The free-time namespace's mandatory name shape (docs/freetime.md): the date the session ran
 * plus a slug. Same load-bearing prefix rule as {@link DREAM_NAME_RE} — a free-time session can
 * only ever create a node inside its own namespace, never name (and thereby update) one outside it.
 */
export const FREE_TIME_NAME_RE = /^free-time-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

/** Input to {@link MemoryStore.rememberFreeTime}. Type/inference/source are forced, not passed. */
export interface FreeTimeRememberInput {
  /** `free-time-YYYY-MM-DD-<slug>` — validated against {@link FREE_TIME_NAME_RE}. */
  name: string;
  description: string;
  body?: string;
  /** The session the note came out of (e.g. "free-time:2026-08-09-1a2b3c4d"). */
  provenance: string[];
  /**
   * `public` reaches the harness bridge index and therefore seeds future sessions — that is the
   * whole point of the namespace, and why the session gets to choose. `owner` keeps a note inside
   * the graph. There is no `dm` arm: a free-time session is in nobody's conversation.
   */
  visibility: "public" | "owner";
  /** Logged into the memory git commit, like remember's reason. */
  reason: string;
}

// isInferenceNode lives in ./search.ts (pure over nodes, cycle-free for agent-recall);
// re-exported here so write-path consumers import it alongside the store.
export { isInferenceNode } from "./search.ts";

/** Maps a node `type` to its conventional subdirectory (Spec 08 §1.1 — folders are cosmetic). */
const TYPE_FOLDER: Record<string, string> = {
  person: "people",
  project: "projects",
  preference: "prefs",
  env: "env",
  "worker-note": "workers",
  reference: "references",
  decision: "decisions",
  dream: "dreams",
  "free-time": "free-time",
};

/** Deterministic metadata key order for clean one-line git diffs (Spec 08 §4.5). */
const META_ORDER = [
  "type",
  // person
  "emails", "role", "aliases", "members", "timezone",
  // project
  "status", "repo", "owners", "channels", "deadline",
  // preference
  "scope", "applies_to",
  // env
  "subtype", "path", "verified",
  // worker-note
  "harness", "model", "task_type", "derived_from", "stat_window", "n_samples",
  // reference
  "url", "domain",
  // decision
  "decided", "supersedes",
  // calibration
  "kind", "channel", "about", "reason",
  // dream (issue #36) — the inference marker + the sources the inference was derived from,
  // plus the stale-flag pair a dream node carries when it is ABOUT another node rather than a
  // standalone inference (`MemoryStore.flagStaleNode`).
  "inference", "provenance", "flag_target", "flag_reason",
];
/** Provenance fields rendered last (Spec 08 §1.2; visibility/provenance from multiplayer §7). */
const META_TAIL = [
  "visibility", "dm_with",
  "created", "updated", "source", "source_user", "source_name",
  "confidence", "ttl", "archived", "archived_reason",
];

// =======================================================================================
// Construction
// =======================================================================================

/** Dependencies for the memory subsystem (the daemon wires these). */
export interface MemoryDeps {
  /** Absolute path to the memory dir (Paths.memoryDir, e.g. ~/.beckett/memory). */
  memoryDir: string;
  /** Logger; defaults to the root logger's `memory` child. */
  logger?: Logger;
  /** Git-version the memory dir on every write (Spec 08 §8.2). Default true; best-effort. */
  git?: boolean;
  /** Keep the parsed graph and Moss sync warm, invalidating only when the markdown tree changes. */
  warm?: boolean;
  /**
   * Harness auto-memory dirs (`~/.claude/projects/<slug>/memory`) cross-linked into the graph
   * as READ-ONLY nodes, with the graph's public index published back (issue #160 — see
   * `./bridge.ts` for the full authority split). Absent/empty ⇒ no bridging, byte-identical
   * pre-bridge behavior.
   */
  bridgeDirs?: string[];
}

/** Build the {@link Memory} implementation. */
export function createMemory(deps: MemoryDeps): MemoryStore {
  return new MemoryStore(deps);
}

// =======================================================================================
// The implementation
// =======================================================================================

export class MemoryStore implements Memory {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly git: boolean;
  private readonly warm: boolean;
  /** Read-only harness auto-memory dirs folded into the graph (issue #160, ./bridge.ts). */
  private readonly bridgeDirs: string[];
  /** Daemon-only cache: a cheap path/mtime/size stamp detects external edits without re-parsing or hashing nodes. */
  private warmGraph?: { graph: MemoryGraph; stamp: string };
  /** The graph whose documents have already been diff-synced to the warm Moss handle. */
  private mossSyncedGraph?: MemoryGraph;
  /** Single in-process async mutex serializing writes (Spec 08 §8.1). */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** Raw file contents captured during the last build (for content-hash + surgical edits). */
  private rawCache = new Map<string, string>();
  /** The local Moss index serving recall's ranking (issue #20); opened lazily, cached. */
  private moss?: LocalMoss;

  constructor(deps: MemoryDeps) {
    this.dir = deps.memoryDir;
    this.logger = deps.logger ?? rootLog.child("memory");
    this.git = deps.git ?? true;
    this.warm = deps.warm ?? false;
    this.bridgeDirs = deps.bridgeDirs ?? [];
  }

  // ── recall (Spec 08 §3; retrieval served by local Moss since issue #20) ────────────

  async recall(q: RecallQuery & { audience?: Audience }): Promise<RecallResult> {
    const g = this.graphForRecall();
    const scoreOf = await this.mossScorer(q.text, g);
    return recallOver(q, g, scoreOf);
  }

  /**
   * Agentic recall (issue #26): moss/grep retrieves the top ~15 candidate notes, the fail-closed
   * visibility gate runs in code, and THEN a small LLM agent (luna via pi, or haiku via
   * `claude -p` — never the API) reads only those gated candidates and either passes a concise
   * relevant note or returns a clean PASS. The returned {@link AgentRecallSession} supports a
   * probing follow-up. `base` is the underlying score-ranked recall — the same bundle {@link
   * recall} returns, and the graceful fallback the agent degrades to if the model is unavailable.
   *
   * The candidate set handed to the agent is `base.hits`, which {@link recallOver} has ALREADY
   * gated per {@link Audience}: a scoped note the viewer can't see never reaches the agent.
   */
  async recallAgentic(
    q: RecallQuery & { audience?: Audience },
    deps: AgentRecallDeps = {},
  ): Promise<{ base: RecallResult; agent: AgentRecallSession }> {
    // Pull a wider candidate pool than default recall (the agent, not the score, is the judge).
    const base = await this.recall({ ...q, k: q.k ?? AGENT_CANDIDATE_K });
    const agent = await agentRecall(base.hits, q.text, {
      logger: this.logger.child("agent"),
      ...deps,
    });
    return { base, agent };
  }

  /**
   * Rank the query through the local Moss index (#31.1): sync the index to the graph
   * just built (which also migrates a pre-moss store on first contact and heals
   * out-of-band edits/deletes), then score via Moss's hybrid retrieval. Returns
   * `undefined` — the lexical fallback — when the runtime is unavailable: retrieval
   * degrades, recall never breaks. Visibility is deliberately NOT Moss's job: recallOver
   * gates every node in code, fail-closed, whatever the scorer says.
   */
  private async mossScorer(
    text: string,
    g: MemoryGraph,
  ): Promise<((node: MemoryNode) => number) | undefined> {
    try {
      const moss = await this.openMoss();
      // A warm daemon already has this exact graph's documents indexed. Avoid the old per-recall
      // full-node SHA-256 diff pass; a changed markdown-tree stamp creates a new graph and syncs once.
      if (!this.warm || this.mossSyncedGraph !== g) {
        await syncMossWithGraph(moss, g);
        this.mossSyncedGraph = g;
      }
      if (!text.trim()) return undefined; // filter-only recall — nothing to rank
      const scores = mossScores(moss, text);
      // Moss's hybrid rank remains primary. Keep the 0.025 lexical sharpener inside Moss's
      // keyword-matched set: scoring every graph node was a second full-corpus ranking pass.
      // Its normalization can therefore differ from the old corpus-wide sharpener, but its
      // bounded contribution limits any resulting score delta to <= 0.025.
      const matchedNodes = [...g.nodes.values()].filter((node) => scores.has(node.name));
      const stats = corpusStats(matchedNodes);
      const lexicalScores = new Map(
        matchedNodes.map((node) => [node.name, scoreNode(text, node, stats)]),
      );
      const lexicalMax = Math.max(...lexicalScores.values(), 1);
      return (node) =>
        (scores.get(node.name) ?? 0) +
        MOSS_LEXICAL_SHARPENER_WEIGHT * (lexicalScores.get(node.name) ?? 0) / lexicalMax;
    } catch (err) {
      this.logger.warn("memory: moss retrieval unavailable — using the lexical fallback", {
        err: String(err),
      });
      return undefined;
    }
  }

  private async openMoss(): Promise<LocalMoss> {
    this.moss ??= await openMemoryMoss(this.dir, this.logger);
    return this.moss;
  }

  /**
   * Release the Moss retrieval handle: clear its pending 50ms persist timer and settle any
   * in-flight durable write before returning (delegates to {@link LocalMoss.close}). A store is
   * otherwise fire-and-forget — nothing closes it — so a caller that tears down the memory dir
   * right after a write/recall (e.g. a test `rmSync`-ing its tmpdir in `afterEach`) can race the
   * coalescing timer's `mkdir` against the delete and see an ENOENT (or a resurrected temp dir).
   * Await `close()` first and that race is gone. Idempotent; the handle reopens lazily on reuse.
   */
  async close(): Promise<void> {
    await this.moss?.close();
    this.moss = undefined;
  }

  /** Post-write index sync for remember/maintain/reindex — best-effort, never throws
   *  (recall's own sync heals any miss on the next call). */
  private async syncMossQuietly(g: MemoryGraph): Promise<void> {
    try {
      await syncMossWithGraph(await this.openMoss(), g);
      this.mossSyncedGraph = g;
    } catch (err) {
      this.logger.warn("memory: moss index sync failed — recall will resync", { err: String(err) });
    }
  }

  // ── remember (Spec 08 §4) ──────────────────────────────────────────────────────────

  async remember(intent: RememberIntent): Promise<MemoryNode> {
    return this.withLock(() => this.rememberLocked(intent));
  }

  private async rememberLocked(intent: RememberIntent): Promise<MemoryNode> {
    // Writes can alter several files (including backlinks); never retain a partially-built graph.
    this.warmGraph = undefined;
    this.mossSyncedGraph = undefined;
    if (!intent.name || !/^[a-z0-9-]+$/.test(intent.name)) {
      throw new Error(`memory.remember: invalid node name '${intent.name}' (must be kebab-case)`);
    }
    await this.ensureDir();
    let g = this.buildGraph();

    // 1. Dedup: does a node already cover this fact? (Spec 08 §4.2)
    const existing = findExisting(intent, g);
    const usePrev = existing != null && !existing.phantom;
    const op: RememberIntent["op"] = usePrev
      ? intent.op === "create"
        ? "update"
        : intent.op
      : "create";

    // 2. Compose the node content (Spec 08 §4.4).
    const built = usePrev
      ? mergeInto(existing!, intent)
      : buildNewContent(intent);
    applyLinks(built, intent.links);

    const name = usePrev ? existing!.name : intent.name;
    const type = String(built.metadata.type ?? intent.type ?? existing?.type ?? "");
    if (!type) {
      throw new Error(`memory.remember: 'type' is required to create node '${name}'`);
    }
    // parseMemoryFile requires a description; writing without one would land an unparseable
    // file on disk that every future graph build skips — an invisible, orphaned memory.
    if (!built.description.trim()) {
      throw new Error(`memory.remember: 'description' is required for node '${name}'`);
    }
    const path = usePrev && existing!.path ? existing!.path : this.pathFor(name, type);

    // 3. Atomic write of the primary file (Spec 08 §8.1). Its own ## Backlinks reflect the
    //    inbound edges already present in the graph (e.g. phantom links being filled in).
    const primary: MemoryNode = {
      name,
      type,
      description: built.description,
      metadata: built.metadata,
      body: built.body,
      path,
      created: String(built.metadata.created ?? ""),
      updated: String(built.metadata.updated ?? ""),
      source: (built.metadata.source as MemoryNode["source"]) ?? intent.source,
      confidence: built.metadata.confidence as MemoryNode["confidence"],
      stale: isExpired(built.metadata.ttl),
      phantom: false,
      mtime: Date.now(),
    };
    this.atomicWrite(path, renderNode(primary, g));

    // 4. Rebuild the graph from disk (now includes the new node + its out-edges), then
    //    refresh the ## Backlinks of every real out-target (Spec 08 §2.5, §4.4).
    g = this.buildGraph();
    for (const e of g.out.get(name) ?? []) {
      const target = g.nodes.get(e.to);
      // A bridged (harness-origin) target is read-only: its cross-store backlink exists in
      // the graph, never in the harness file (issue #160).
      if (target && !target.phantom && !isBridgedNode(target) && target.name !== name) {
        this.refreshBacklinksOnDisk(target, g);
      }
    }

    // 5. Regenerate the always-loaded index (Spec 08 §4.5) + mirror + event + commit,
    //    and keep the moss retrieval index in step with the write (issue #20).
    this.atomicWrite(join(this.dir, "MEMORY.md"), renderIndex(g));
    await this.commit(`memory: ${op} ${name}`);
    await this.syncMossQuietly(g);
    this.syncBridge(g);

    const result = g.nodes.get(name);
    if (!result) throw new Error(`memory.remember: node '${name}' missing after write`);
    return result;
  }

  // ── rememberDream (issue #36 — the dream pass's ONLY memory write path) ──────────────

  /**
   * Create-only write for a dream-derived INFERENCE. This is deliberately narrower than
   * {@link remember} — the containment is structural, not prompted:
   *
   *   - the name MUST match {@link DREAM_NAME_RE} (`dream-YYYY-MM-DD-<slug>`), so a dream can
   *     never name (and thereby update) an existing non-dream node;
   *   - if ANY node or file already answers to the name, it throws — no update, no append, no
   *     similarity dedup/merge. A dream physically cannot edit or delete an existing memory.
   *   - `metadata.type = "dream"`, `inference: true`, and the non-empty `provenance` list are
   *     forced here, whatever the caller passes;
   *   - the backlink-refresh sweep that {@link remember} runs over link targets is SKIPPED:
   *     a dream write touches exactly one new node file plus the generated MEMORY.md index.
   *     (`## Backlinks` sections are derived state; the graph's edges come from the files.)
   */
  async rememberDream(input: DreamRememberInput): Promise<MemoryNode> {
    return this.withLock(() => this.rememberDreamLocked(input));
  }

  private async rememberDreamLocked(input: DreamRememberInput): Promise<MemoryNode> {
    const provenance = (input.provenance ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (DREAM_NAME_RE.test(input.name) && input.description?.trim() && !provenance.length) {
      throw new Error(`memory.rememberDream: a dream memory needs a non-empty provenance list ('${input.name}')`);
    }
    return this.createOnlyLocked({
      method: "rememberDream",
      noun: "dream",
      name: input.name,
      nameRe: DREAM_NAME_RE,
      nameShape: "dream-YYYY-MM-DD-<kebab-slug>",
      type: "dream",
      description: input.description ?? "",
      body: input.body,
      metadata: { inference: true, provenance },
      reason: input.reason,
    });
  }

  // ── dream MAINTENANCE (update / retire / flag) ───────────────────────────────────────
  //
  // The dream pass reviews its OWN namespace as well as the day's sessions, so it needs more
  // than "add": a superseded inference should be corrected, a wrong one retired, and a
  // non-dream node the day's sessions contradict should be FLAGGED for a human. All three are
  // deliberately separate methods rather than a widening of `rememberDream`, and each carries
  // its own namespace check, so the create-only guarantee that path exists for is untouched:
  //
  //   - `updateDream` / `retireDream` refuse any name that is not `dream-YYYY-MM-DD-<slug>` AND
  //     any node whose `metadata.type` is not `dream`. A dream can still never reach a fact.
  //   - `flagStaleNode` writes a NEW dream-namespace node ABOUT the target. The target's file is
  //     not touched by a byte — the flag is a claim a human (or `memory maintain`) adjudicates,
  //     never an edit to somebody's observed fact.
  //   - Retirement is an ARCHIVE, never an unlink — the store's "nothing is ever deleted"
  //     invariant holds for the dream namespace exactly as it does everywhere else.

  /** Update an EXISTING dream-namespace node in place. Refuses anything outside the namespace. */
  async updateDream(input: DreamUpdateInput): Promise<MemoryNode> {
    return this.withLock(() => this.updateDreamLocked(input));
  }

  private async updateDreamLocked(input: DreamUpdateInput): Promise<MemoryNode> {
    const name = String(input.name ?? "").trim();
    // Same discipline as `rememberLocked`: never decide against a cached graph on a write path.
    this.warmGraph = undefined;
    this.mossSyncedGraph = undefined;
    const node = this.requireDreamNode("updateDream", name);
    const provenance = (input.provenance ?? []).map((s) => String(s).trim()).filter(Boolean);
    const description = String(input.description ?? "").trim() || node.description;
    if (!description) throw new Error(`memory.updateDream: 'description' is required for '${name}'`);

    this.warmGraph = undefined;
    this.mossSyncedGraph = undefined;
    await this.ensureDir();
    let g = this.buildGraph();
    const now = nowIso();
    const next: MemoryNode = {
      ...node,
      description,
      body: input.body === undefined ? node.body : String(input.body).trim(),
      metadata: {
        ...node.metadata,
        type: "dream",
        inference: true,
        ...(provenance.length ? { provenance } : {}),
        updated: now,
      },
      updated: now,
      mtime: Date.now(),
    };
    this.atomicWrite(node.path, renderNode(next, g));

    g = this.buildGraph();
    this.atomicWrite(join(this.dir, "MEMORY.md"), renderIndex(g));
    await this.commit(`memory: dream update ${name} (${input.reason})`);
    await this.syncMossQuietly(g);
    this.syncBridge(g);
    const result = g.nodes.get(name);
    if (!result) throw new Error(`memory.updateDream: node '${name}' missing after write`);
    return result;
  }

  /**
   * Retire an EXISTING dream-namespace node: the file moves to `archive/` with `archived` /
   * `archived_reason` stamped, exactly as {@link maintain} archives. This is the dream pass's
   * "delete" — the node leaves the graph, the bytes stay recoverable, and nothing outside the
   * dream namespace can ever be named here.
   */
  async retireDream(name: string, reason: string): Promise<void> {
    return this.withLock(() => this.retireDreamLocked(name, reason));
  }

  private async retireDreamLocked(rawName: string, reason: string): Promise<void> {
    const name = String(rawName ?? "").trim();
    this.warmGraph = undefined;
    this.mossSyncedGraph = undefined;
    const node = this.requireDreamNode("retireDream", name);
    await this.ensureDir();
    let g = this.buildGraph();
    this.archiveFile(node, reason || "retired by the nightly dream pass", g);
    g = this.buildGraph();
    this.atomicWrite(join(this.dir, "MEMORY.md"), renderIndex(g));
    await this.commit(`memory: dream retire ${name} (${reason})`);
    await this.syncMossQuietly(g);
    this.syncBridge(g);
  }

  /**
   * Write a dream-namespace STALE FLAG about a node outside the namespace. The flag is a normal
   * create-only dream node carrying `flag_target` / `flag_reason` plus the provenance the
   * suspicion came from; the target file is never read-modified-written. Refuses to flag another
   * dream node (a pass that wants to correct its own inference has `updateDream`/`retireDream`)
   * and refuses a target that does not exist (a flag on a phantom is not evidence of anything).
   */
  async flagStaleNode(input: DreamStaleFlagInput): Promise<MemoryNode> {
    return this.withLock(() => this.flagStaleNodeLocked(input));
  }

  private async flagStaleNodeLocked(input: DreamStaleFlagInput): Promise<MemoryNode> {
    const target = String(input.target ?? "").trim();
    const flagReason = String(input.flagReason ?? "").trim();
    const provenance = (input.provenance ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (!flagReason) {
      throw new Error(`memory.flagStaleNode: a stale flag needs a reason ('${input.name}')`);
    }
    if (!provenance.length) {
      throw new Error(`memory.flagStaleNode: a stale flag needs a non-empty provenance list ('${input.name}')`);
    }
    this.warmGraph = undefined;
    this.mossSyncedGraph = undefined;
    const node = this.buildGraph().nodes.get(target);
    if (!node || node.phantom) {
      throw new Error(`memory.flagStaleNode: no such node to flag: '${target}'`);
    }
    if (node.type === "dream" || DREAM_NAME_RE.test(target)) {
      throw new Error(
        `memory.flagStaleNode: '${target}' is a dream node — use updateDream/retireDream inside the namespace`,
      );
    }
    return this.createOnlyLocked({
      method: "flagStaleNode",
      noun: "dream",
      name: input.name,
      nameRe: DREAM_NAME_RE,
      nameShape: "dream-YYYY-MM-DD-<kebab-slug>",
      type: "dream",
      description: `possibly stale: ${target} — ${flagReason}`,
      body: input.body,
      metadata: { inference: true, provenance, flag_target: target, flag_reason: flagReason },
      reason: input.reason,
    });
  }

  /** The one namespace check both in-place dream writes share. Throws with the calling method. */
  private requireDreamNode(method: string, name: string): MemoryNode {
    if (!DREAM_NAME_RE.test(name)) {
      throw new Error(
        `memory.${method}: invalid dream node name '${name}' (must be dream-YYYY-MM-DD-<kebab-slug>)`,
      );
    }
    const node = this.buildGraph().nodes.get(name);
    if (!node || node.phantom || !node.path) {
      throw new Error(`memory.${method}: no such dream node: '${name}'`);
    }
    if (node.type !== "dream") {
      throw new Error(`memory.${method}: '${name}' is not a dream node (type: ${node.type})`);
    }
    return node;
  }

  /**
   * Create-only write for a free-time session's durable note (docs/freetime.md). The SAME
   * containment as {@link rememberDream}, one namespace over: the name must match
   * {@link FREE_TIME_NAME_RE}, an existing node or file under that name throws instead of being
   * updated, and the session id rides along as provenance. `inference: true` is forced — a note
   * written by a model with nobody watching is a claim, not an observation, and the bridge index
   * labels it as one.
   *
   * `visibility` is the session's own call and is the reason this method exists: a `public` note
   * reaches the harness bridge index ({@link ./bridge.ts}) and seeds the next session, which is
   * the continuity the whole feature is for. `owner` keeps it inside the graph.
   */
  async rememberFreeTime(input: FreeTimeRememberInput): Promise<MemoryNode> {
    return this.withLock(() => this.rememberFreeTimeLocked(input));
  }

  private async rememberFreeTimeLocked(input: FreeTimeRememberInput): Promise<MemoryNode> {
    const provenance = (input.provenance ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (FREE_TIME_NAME_RE.test(input.name) && input.description?.trim() && !provenance.length) {
      throw new Error(
        `memory.rememberFreeTime: a free-time memory needs a non-empty provenance list ('${input.name}')`,
      );
    }
    const visibility = input.visibility === "owner" ? "owner" : "public";
    return this.createOnlyLocked({
      method: "rememberFreeTime",
      noun: "free-time",
      name: input.name,
      nameRe: FREE_TIME_NAME_RE,
      nameShape: "free-time-YYYY-MM-DD-<kebab-slug>",
      type: "free-time",
      description: input.description ?? "",
      body: input.body,
      metadata: { inference: true, provenance, visibility },
      reason: input.reason,
    });
  }

  /**
   * The shared body of every NAMESPACED, CREATE-ONLY write (`rememberDream`, `rememberFreeTime`).
   * Deliberately narrower than {@link remember} — the containment is structural, not prompted:
   *
   *   - the name MUST match the namespace's regex, so the writer can never name (and thereby
   *     update) an existing node outside its own namespace;
   *   - if ANY node or file already answers to the name, it throws — no update, no append, no
   *     similarity dedup/merge. Neither caller can physically edit or delete an existing memory.
   *   - `metadata.type` and the caller's forced fields are set here, whatever else was passed;
   *   - the backlink-refresh sweep that {@link remember} runs over link targets is SKIPPED: one
   *     new node file plus the generated MEMORY.md index. (`## Backlinks` sections are derived
   *     state; the graph's edges come from the files.)
   */
  private async createOnlyLocked(opts: {
    /** The public method name, so every refusal reads as the caller a human actually invoked. */
    method: string;
    /** How the namespace is spoken about in a refusal ("dream", "free-time"). */
    noun: string;
    name: string;
    nameRe: RegExp;
    nameShape: string;
    type: string;
    description: string;
    body?: string;
    metadata: Record<string, unknown>;
    reason: string;
  }): Promise<MemoryNode> {
    const { method, noun, name } = opts;
    if (!opts.nameRe.test(name)) {
      throw new Error(`memory.${method}: invalid ${noun} node name '${name}' (must be ${opts.nameShape})`);
    }
    if (!opts.description?.trim()) {
      throw new Error(`memory.${method}: 'description' is required for '${name}'`);
    }
    this.warmGraph = undefined;
    this.mossSyncedGraph = undefined;
    await this.ensureDir();
    let g = this.buildGraph();

    const prior = g.nodes.get(name);
    if (prior && !prior.phantom) {
      throw new Error(`memory.${method}: '${name}' already exists — ${noun} memories are create-only`);
    }
    const path = this.pathFor(name, opts.type);
    if (existsSync(path)) {
      // A file the graph didn't parse (malformed/archived remnant) still blocks: never overwrite.
      throw new Error(`memory.${method}: a file already exists at ${path} — ${noun} memories are create-only`);
    }

    const now = nowIso();
    const node: MemoryNode = {
      name,
      type: opts.type,
      description: opts.description.trim(),
      metadata: {
        type: opts.type,
        ...opts.metadata,
        created: now,
        updated: now,
        source: "derived",
      },
      body: (opts.body ?? "").trim(),
      path,
      created: now,
      updated: now,
      source: "derived",
      stale: false,
      phantom: false,
      mtime: Date.now(),
    };
    this.atomicWrite(path, renderNode(node, g));

    // Rebuild for the derived index; deliberately NO refreshBacklinksOnDisk sweep (see above).
    g = this.buildGraph();
    this.atomicWrite(join(this.dir, "MEMORY.md"), renderIndex(g));
    await this.commit(`memory: ${noun} ${name} (${opts.reason})`);
    await this.syncMossQuietly(g);
    this.syncBridge(g);

    const result = g.nodes.get(name);
    if (!result) throw new Error(`memory.${method}: node '${name}' missing after write`);
    return result;
  }

  // ── maintain (OPS-121 — routine staleness pruning + dedup) ───────────────────────────

  /**
   * One self-healing pass: archive expired/superseded nodes, merge near-duplicates,
   * report borderline pairs and phantoms. `dryRun` plans without touching disk.
   * Serialized behind the same write lock as remember.
   */
  async maintain(opts: { dryRun?: boolean } = {}): Promise<MaintainReport> {
    return this.withLock(() => this.maintainLocked(opts));
  }

  private async maintainLocked(opts: { dryRun?: boolean }): Promise<MaintainReport> {
    this.warmGraph = undefined;
    this.mossSyncedGraph = undefined;
    await this.ensureDir();
    let g = this.buildGraph();
    // `scanned` is how many memory files the pass SAW, not how many parsed cleanly — the ticket's
    // contract (issue #97) is that maintain sees the whole store. Count the enumerated tree, so a
    // file that failed to parse still shows up in the total (buildGraph logged why it dropped)
    // rather than silently shrinking the number and hiding that the store is bigger than the graph.
    const files = this.listMarkdownFiles();
    const scanned = files.length;
    // Bridged (harness-origin) nodes are read-only imports (issue #160): the harness store
    // owns their lifecycle, so no archive/merge/aging action may target one. A planned
    // cross-store merge demotes to a flag — the report still surfaces "these look like the
    // same fact across stores", but nothing ever writes under a harness root.
    const plan = excludeBridgedFromPlan(planMaintenance(g, Date.now()), g);
    // A phantom is a link to a name with NO file. A name that DOES have a file on disk but
    // failed to parse (e.g. a truncated write) is a broken file, not a missing one — reporting
    // it as a phantom sends a re-`remember` down the wrong path and manufactures a false gap in
    // the graph (issue #97). Drop those from the phantom list here, where the filesystem is in
    // reach; buildGraph already logged the parse failure that made the node invisible.
    const onDisk = new Set(files.map((p) => basename(p, ".md")));
    const phantoms = plan.phantoms.filter((name) => !onDisk.has(name));
    const report: MaintainReport = { scanned, ...plan, phantoms, dryRun: Boolean(opts.dryRun) };
    if (report.dryRun || (plan.archives.length === 0 && plan.merges.length === 0)) return report;

    // Merges first: they rewrite inbound links, which archiving must not race.
    for (const m of plan.merges) {
      const canonical = g.nodes.get(m.canonical);
      const dup = g.nodes.get(m.duplicate);
      if (!canonical || !dup || canonical.phantom || dup.phantom) continue;
      this.mergeNodes(canonical, dup, g);
      g = this.buildGraph(); // later actions must see the rewritten tree
    }
    for (const a of plan.archives) {
      const node = g.nodes.get(a.name);
      if (!node || node.phantom || !node.path) continue;
      this.archiveFile(node, a.reason + (a.by ? ` by ${a.by}` : ""), g);
    }

    // Everything moved/rewritten — settle derived state: backlinks, index, moss, git.
    g = this.buildGraph();
    for (const n of g.nodes.values()) {
      if (!n.phantom && n.path && !isBridgedNode(n)) this.refreshBacklinksOnDisk(n, g);
    }
    this.atomicWrite(join(this.dir, "MEMORY.md"), renderIndex(g));
    await this.syncMossQuietly(g); // archived/merged nodes leave the retrieval index too
    this.syncBridge(g);
    await this.commit(
      `memory: maintenance (${plan.archives.length} archived, ${plan.merges.length} merged)`,
    );
    this.logger.info("memory: maintenance executed", {
      archived: plan.archives.map((a) => a.name).join(",") || "-",
      merged: plan.merges.map((m) => `${m.duplicate}→${m.canonical}`).join(",") || "-",
      flagged: plan.flagged.length,
    });
    return report;
  }

  /**
   * Fold `dup` into `canonical`: rewrite inbound `[[dup]]` wikilinks to the canonical name,
   * append the duplicate's full description+body under a dated "Merged from" heading (no
   * content is lost), union the aliases (including the duplicate's name, so future
   * remember/recall by the old name resolves here), then archive the duplicate's file.
   * Note: bare (non-wikilink) structural-field references to the old name are NOT rewritten —
   * they degrade to a phantom, which the maintenance report surfaces.
   */
  private mergeNodes(canonical: MemoryNode, dup: MemoryNode, g: MemoryGraph): void {
    const now = nowIso();
    for (const e of g.in.get(dup.name) ?? []) {
      const from = g.nodes.get(e.from);
      // Never rewrite a bridged (harness-origin) linker: its file is read-only to the graph;
      // the stale link degrades to a phantom the maintenance report surfaces (issue #160).
      if (!from || from.phantom || !from.path || from.name === dup.name || isBridgedNode(from)) continue;
      this.rewriteWikilinks(from.path, dup.name, canonical.name);
    }

    const metadata: Record<string, unknown> = { ...dup.metadata, ...canonical.metadata };
    const aliases = new Set<string>([
      ...asStringArray(canonical.metadata.aliases),
      ...asStringArray(dup.metadata.aliases),
      dup.name,
    ]);
    aliases.delete(canonical.name);
    metadata.aliases = [...aliases];
    metadata.updated = now;

    const dupPart = [dup.description, dup.body].filter(Boolean).join("\n\n");
    const mergedBody = `${canonical.body.trim()}\n\n## Merged from ${dup.name} (${now.slice(0, 10)})\n\n${dupPart}`;
    const body = renameWikilinkTarget(mergedBody, dup.name, canonical.name).trim();

    this.atomicWrite(
      canonical.path,
      renderNode({ ...canonical, metadata, body, updated: now, mtime: Date.now() }, g),
    );
    this.archiveFile(dup, `merged into ${canonical.name}`, g);
  }

  /** Move a node's file into `archive/` with `archived`/`archived_reason` stamped — never a
   *  delete. Archived files are invisible to the graph (listMarkdownFiles skips the folder). */
  private archiveFile(node: MemoryNode, reason: string, g: MemoryGraph): void {
    const metadata = { ...node.metadata, archived: nowIso(), archived_reason: reason };
    let dest = join(this.dir, ARCHIVE_DIR, basename(node.path));
    for (let i = 2; existsSync(dest); i++) {
      dest = join(this.dir, ARCHIVE_DIR, basename(node.path).replace(/\.md$/, `-${i}.md`));
    }
    this.atomicWrite(dest, renderNode({ ...node, metadata }, g));
    try {
      unlinkSync(node.path);
    } catch (err) {
      this.logger.warn("memory: could not remove archived original", {
        path: node.path,
        err: String(err),
      });
    }
  }

  /** Retarget every wikilink pointing at `from` in one file (body AND frontmatter), preserving
   *  any relation type, alias, and observation date on each edge (issue #60). */
  private rewriteWikilinks(path: string, from: string, to: string): void {
    let raw: string;
    try {
      raw = this.rawCache.get(path) ?? readFileSync(path, "utf8");
    } catch {
      return;
    }
    const next = renameWikilinkTarget(raw, from, to);
    if (next !== raw) {
      this.atomicWrite(path, next);
      this.rawCache.set(path, next);
    }
  }

  // ── reindex ──────────────────────────────────────────────────────────────────────────

  /** Rebuild + validate the in-memory graph from the markdown tree (the files ARE the store —
   *  the v2 SQLite mirror was deleted with the rest of the retired stack, issue #28), and
   *  bring the moss retrieval index back in step with it (issue #20). */
  async reindex(): Promise<void> {
    this.warmGraph = undefined;
    this.mossSyncedGraph = undefined;
    const g = this.buildGraph();
    await this.syncMossQuietly(g);
    this.syncBridge(g);
  }

  /**
   * Direction graph → harness of the cross-store bridge (issue #160): publish this store's
   * public index into each configured harness auto-memory dir (`beckett-graph-index.md` plus
   * a one-line `MEMORY.md` pointer). Best-effort by contract — a bridge failure logs and
   * never fails the write that triggered it.
   */
  private syncBridge(g: MemoryGraph): void {
    if (this.bridgeDirs.length) syncBridgeDirs(g, this.bridgeDirs, this.logger);
  }

  // ── graph build (Spec 08 §2.3) ──────────────────────────────────────────────────────

  /** Return the daemon's graph when the markdown tree has not changed; cold stores rebuild as before. */
  private graphForRecall(): MemoryGraph {
    if (!this.warm) return this.buildGraph();
    const stamp = this.graphStamp();
    if (this.warmGraph?.stamp === stamp) return this.warmGraph.graph;
    const graph = this.buildGraph();
    // Cache the PRE-build stamp: a file edited mid-build then mismatches on the next recall
    // and triggers one extra rebuild. Re-stamping after the build would fold that edit into
    // the cached stamp without it being in the graph — a stale cache with no invalidation.
    this.warmGraph = { graph, stamp };
    return graph;
  }

  /** A metadata-only change detector. Content is parsed and hashed only after a real tree change.
   *  Bridged harness files stamp too, so an out-of-band harness edit reaches the next recall. */
  private graphStamp(): string {
    return [...this.listMarkdownFiles(), ...listBridgeFiles(this.bridgeDirs)]
      .sort()
      .map((path) => {
        try {
          const stat = statSync(path);
          return `${path}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${path}:gone`;
        }
      })
      .join("|");
  }

  /** Parse the whole memory tree into the in-memory knowledge graph. */
  buildGraph(): MemoryGraph {
    this.rawCache.clear();
    const nodes = new Map<string, MemoryNode>();
    const out = new Map<string, MemoryEdge[]>();
    const inE = new Map<string, MemoryEdge[]>();

    const files = this.listMarkdownFiles();
    const parsed: { node: MemoryNode; edges: MemoryEdge[] }[] = [];
    for (const path of files) {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        this.logger.warn("memory: unreadable file skipped", { path, err: String(err) });
        continue;
      }
      try {
        const pe = parseMemoryFile(path, raw, mtimeOf(path));
        this.rawCache.set(path, raw);
        parsed.push(pe);
      } catch (err) {
        // A malformed file is a build error surfaced to the log, never a throw (Spec 08 §1.1).
        this.logger.warn("memory: malformed file skipped", { path, err: String(err) });
      }
    }

    // 1. Real nodes — last-writer-by-mtime wins on a duplicate name (Spec 08 §1.1, §2.3).
    for (const { node } of parsed) {
      const prev = nodes.get(node.name);
      if (prev) {
        // Newer mtime wins; an exact mtime tie breaks on path so the winner is deterministic
        // regardless of readdir order.
        const keepNew = node.mtime !== prev.mtime ? node.mtime > prev.mtime : node.path > prev.path;
        this.logger.warn("memory: duplicate node name; newer mtime wins", {
          name: node.name,
          kept: keepNew ? node.path : prev.path,
        });
        if (!keepNew) continue;
      }
      nodes.set(node.name, node);
    }

    // 1b. Cross-store bridge (issue #160): fold the harness auto-memory in as READ-ONLY
    //     nodes. Natives were seated first, and a bridged node NEVER displaces one — on a
    //     name collision the graph's own node wins whatever the mtimes say, because the graph
    //     store is authoritative under its own root (the harness fact stays reachable in its
    //     own store). Every write path checks `isBridgedNode` before touching a file, so no
    //     remember/maintain/backlink pass can ever write under a harness root.
    const bridged = this.bridgeDirs.length ? loadBridgedNodes(this.bridgeDirs, this.logger) : [];
    const keptBridged: typeof bridged = [];
    for (const b of bridged) {
      if (nodes.has(b.node.name)) continue;
      nodes.set(b.node.name, b.node);
      keptBridged.push(b);
    }

    // 2. Wire edges, minting phantom nodes for unresolved forward-refs (Spec 08 §2.5).
    for (const { node, edges } of parsed) {
      // Only the surviving (kept) node's edges count, to avoid double-wiring a duplicate.
      if (nodes.get(node.name)?.path !== node.path) continue;
      for (const e of edges) {
        if (!nodes.has(e.to)) nodes.set(e.to, phantomNode(e.to));
        pushEdge(out, e.from, e);
        pushEdge(inE, e.to, e);
      }
    }
    // 2b. Bridged edges wire the same way — this is what resolves the graph's cross-store
    //     [[wikilinks]] (and vice versa) into real edges instead of phantom noise.
    for (const { edges } of keptBridged) {
      for (const e of edges) {
        if (!nodes.has(e.to)) nodes.set(e.to, phantomNode(e.to));
        pushEdge(out, e.from, e);
        pushEdge(inE, e.to, e);
      }
    }

    const index = buildIndex(nodes);
    return { nodes, out, in: inE, index, builtAt: Date.now() };
  }

  // ── filesystem helpers (Spec 08 §8.1) ───────────────────────────────────────────────

  private listMarkdownFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    let rels: string[];
    try {
      rels = readdirSync(this.dir, { recursive: true }) as string[];
    } catch {
      return [];
    }
    return rels
      .filter((r) => {
        if (!r.endsWith(".md") || r === "MEMORY.md") return false;
        const segments = r.split(/[\\/]/);
        // Archived nodes stay on disk but out of the graph (OPS-121 maintenance).
        return !segments.includes(".git") && segments[0] !== ARCHIVE_DIR;
      })
      .map((r) => join(this.dir, r));
  }

  private pathFor(name: string, type: string): string {
    const folder = TYPE_FOLDER[type] ?? slug(type) ?? "misc";
    return join(this.dir, folder, `${name}.md`);
  }

  private async ensureDir(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    // The .moss/ retrieval cache (issue #20) is derived, partly binary, and rewritten on
    // every write — keep it out of the memory repo's history (commit uses `git add -A`).
    const gitignore = join(this.dir, ".gitignore");
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, ".moss/\n");
    } else if (!readFileSync(gitignore, "utf8").split(/\r?\n/).includes(".moss/")) {
      writeFileSync(gitignore, readFileSync(gitignore, "utf8").replace(/\n?$/, "\n") + ".moss/\n");
    }
    if (this.git && !existsSync(join(this.dir, ".git"))) {
      await this.runGit(["init", "-q"]);
    }
  }

  /** Write to `<path>.tmp` then rename — atomic on the same fs (Spec 08 §8.1). */
  private atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  }

  /**
   * Surgically replace a file's `## Backlinks` block without re-rendering human-authored
   * prose above it (Spec 08 §1.4 — the section is generated, everything above is authored).
   */
  private refreshBacklinksOnDisk(node: MemoryNode, g: MemoryGraph): void {
    let raw: string;
    try {
      raw = this.rawCache.get(node.path) ?? readFileSync(node.path, "utf8");
    } catch {
      return;
    }
    const head = frontmatterHead(raw);
    const body = stripGeneratedBacklinks(splitFrontmatter(raw).body).trim();
    const next = head + "\n" + composeBody(body, backlinkLines(g, node.name));
    if (next !== raw) {
      this.atomicWrite(node.path, next);
      this.rawCache.set(node.path, next);
    }
  }

  // ── git versioning (Spec 08 §8.2) ───────────────────────────────────────────────────

  private async commit(message: string): Promise<void> {
    if (!this.git) return;
    if (!existsSync(join(this.dir, ".git"))) return;
    await this.runGit(["add", "-A"]);
    // -c flags avoid a dependency on a global git identity for the memory repo.
    await this.runGit([
      "-c",
      "user.email=beckett@localhost",
      "-c",
      "user.name=beckett",
      "commit",
      "-q",
      "-m",
      message,
      "--allow-empty",
    ]);
  }

  private async runGit(args: string[]): Promise<void> {
    try {
      const proc = Bun.spawn(["git", "-C", this.dir, ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`git exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      }
    } catch (err) {
      // Versioning is best-effort; a missing git binary never breaks memory (Spec 08 §8.2).
      this.logger.debug("memory: git command failed", { args: args.join(" "), err: String(err) });
    }
  }

  // ── write serialization (Spec 08 §8.1) ──────────────────────────────────────────────

  private withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    // Keep the chain alive regardless of this op's outcome.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Strip maintenance actions aimed at bridged (harness-origin, read-only) nodes (issue #160):
 * the harness store owns its own facts' lifecycle. Pure over the plan + graph:
 *   - archives naming a bridged node are dropped (a ttl-expired harness note is the harness
 *     seat's business);
 *   - merges touching one demote to a `flagged` pair — the report still says "these two look
 *     like the same fact across stores", but no merge ever rewrites a harness file;
 *   - aged-observation entries for bridged nodes drop (re-observation is per-store too).
 * Phantoms pass through untouched: with the bridge in the graph, a cross-store link is no
 * longer a phantom at all, so what remains is genuinely dangling in one store or the other.
 */
function excludeBridgedFromPlan(
  plan: ReturnType<typeof planMaintenance>,
  g: MemoryGraph,
): ReturnType<typeof planMaintenance> {
  const bridged = (name: string): boolean => {
    const n = g.nodes.get(name);
    return n ? isBridgedNode(n) : false;
  };
  const flagged = [...plan.flagged];
  for (const m of plan.merges) {
    if (bridged(m.canonical) || bridged(m.duplicate)) {
      flagged.push({ a: m.canonical, b: m.duplicate, similarity: m.similarity });
    }
  }
  return {
    ...plan,
    archives: plan.archives.filter((a) => !bridged(a.name)),
    merges: plan.merges.filter((m) => !bridged(m.canonical) && !bridged(m.duplicate)),
    flagged,
    agedObservations: plan.agedObservations.filter((o) => !bridged(o.name)),
  };
}

// =======================================================================================
// Recall (pure over the graph — Spec 08 §3.2)
// =======================================================================================

/**
 * Score + expand a query against a built graph. Exported for testing/Spec 06 reuse.
 *
 * `q.audience` is the hard, fail-closed visibility gate (multiplayer §9.1): it is applied to
 * every seed AND every one-hop expansion target, so a scoped fact never appears — not even as
 * a backlink/expansion stub. No audience (or no viewer id) ⇒ only public nodes are returned.
 *
 * `scoreOf` is the pluggable relevance scorer (issue #20): MemoryStore.recall passes the
 * moss-served ranking; when absent (direct engine calls, moss unavailable) the original
 * lexical scorer runs. The scorer ONLY ranks — filters, hint/name boosts, recency,
 * staleness, link expansion, and above all the visibility gate stay right here, in code.
 */
export function recallOver(
  q: RecallQuery & { audience?: Audience },
  g: MemoryGraph,
  scoreOf?: (node: MemoryNode) => number,
): RecallResult {
  const k = q.k ?? DEFAULT_K;
  const hops = q.hops ?? DEFAULT_HOPS;
  const audience = q.audience;
  const now = Date.now();

  // Evaluate ttl expiry against recall-time `now`, not the parse-time `node.stale` flag: the
  // warm daemon reuses a graph until the tree changes, so a ttl that lapses while the graph
  // sits cached would otherwise keep full ranking indefinitely. Expiry is monotonic, so this
  // is always a superset of the parse-time flag.
  const staleNow = (node: MemoryNode): boolean => isExpired(node.metadata.ttl, now);

  // The single fail-closed visibility chokepoint: canView re-parses a node's provenance on
  // every call, and every node is gated up to three times per recall (seed, expansion, index).
  // Memoize the verdict per node name so provenanceOf runs at most once per node per recall.
  const verdicts = new Map<string, boolean>();
  const visible = (node: MemoryNode): boolean => {
    let v = verdicts.get(node.name);
    if (v === undefined) {
      v = canView(node, audience);
      verdicts.set(node.name, v);
    }
    return v;
  };

  // Targeted retrieval (OPS-121): --type / --name narrow the candidate set BEFORE scoring,
  // so `beckett recall --type person` is a precise fetch, not a fuzzy ranking.
  const typeFilter = q.filter?.types?.length ? new Set(q.filter.types) : null;
  const nameFilter = q.filter?.names?.length ? new Set(q.filter.names) : null;
  const candidates = g.index.filter(
    (line) =>
      (!typeFilter || typeFilter.has(line.type)) && (!nameFilter || nameFilter.has(line.name)),
  );

  // Tier 2 — score every candidate against the task; honor explicit hints. The scorer
  // (search.ts) stems and IDF-weights over name/aliases/description/metadata/BODY, so a fact
  // buried mid-note or worded differently ("deploying" vs "deploy") still surfaces. With no
  // query text but a filter, the filter IS the query: return the filtered set, freshest first.
  const stats = scoreOf ? undefined : corpusStats(g.nodes.values());
  const hasText = q.text.trim() !== "";
  const seeds: ScoredNode[] = candidates
    .map((line): ScoredNode | null => {
      const node = g.nodes.get(line.name);
      if (!node) return null;
      if (!visible(node)) return null; // hard, fail-closed audience gate
      if (!hasText) {
        if (!typeFilter && !nameFilter) return null;
        return { node, score: recency(node, now), via: "match", reason: "filter match" };
      }
      let s = scoreOf ? scoreOf(node) : scoreNode(q.text, node, stats);
      if (q.hint?.names?.includes(node.name)) s += 100;
      if (q.hint?.types?.includes(node.type)) s += 5;
      if (nameFilter?.has(node.name)) s += 100; // an explicitly named node is never ranked out
      if (s <= RELEVANCE_FLOOR) return null;
      // Freshness shaping. The ×1.15 multiplier is calibrated for lexical magnitudes, where
      // real ties are common and relative gaps are wide. Moss's rank-fused scores are
      // compressed (a few % between adjacent ranks), so multiplying would let freshness leap
      // several relevance ranks; there it degrades to a pure tie-breaker (issue #20).
      s = scoreOf ? s + (recency(node, now) - 1) * 1e-3 : s * recency(node, now);
      if (staleNow(node)) s *= 0.5; // deprioritize, don't drop (Spec 08 §1.5)
      return { node, score: s, via: "match", reason: "relevance match" };
    })
    .filter((x): x is ScoredNode => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  // Tier 3 — one-hop (configurable) link expansion (Spec 08 §3.2).
  const seen = new Set(seeds.map((s) => s.node.name));
  const expanded: ScoredNode[] = [];
  const phantomsSeen = new Set<string>();
  let frontier = seeds.map((s) => s.node.name);
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const name of frontier) {
      const outE = g.out.get(name) ?? [];
      // Follow high-value structural backlinks AND any typed edge (issue #60): when the
      // superseded/caused fact is what surfaced, the superseding/causing one is exactly the
      // linked context recall should weigh alongside it.
      const backE = (g.in.get(name) ?? []).filter(
        (e) => HIGH_VALUE_BACKLINK_FIELDS.has(e.field) || e.rel !== undefined,
      );
      for (const e of [...outE, ...backE]) {
        // For an out-edge we hop to `to`; for a high-value backlink we hop to the linker `from`.
        const target = outE.includes(e) ? e.to : e.from;
        if (seen.has(target)) continue;
        const node = g.nodes.get(target);
        // A hidden node is never traversed or stubbed — the same fail-closed gate as seeds.
        if (!node || !visible(node)) continue;
        seen.add(target);
        next.push(target);
        if (node.phantom) phantomsSeen.add(node.name);
        expanded.push({
          node,
          score: edgeWeight(e),
          via: "link",
          reason: edgeReason(e, outE.includes(e), name),
        });
      }
    }
    frontier = next;
  }

  const notes: string[] = [];
  for (const x of [...seeds, ...expanded]) {
    if (staleNow(x.node)) notes.push(`${x.node.name} is stale (ttl ${String(x.node.metadata.ttl)})`);
  }

  return {
    // The index rides along on every recall — filter it under the SAME gate as hits/expansions:
    // even a scoped node's name + description is a leak to the wrong audience (multiplayer §9.1).
    index: g.index.filter((line) => {
      const node = g.nodes.get(line.name);
      return node ? visible(node) : false; // unknown ⇒ fail closed, like everything here
    }),
    hits: seeds,
    expanded: expanded.sort((a, b) => b.score - a.score),
    phantoms: [...phantomsSeen],
    notes,
  };
}

/**
 * Mild freshness shaping under the dated-observation model: every node is an observation made
 * at a point in time, and a NEWER observation of the world should win ties against an older
 * one — while the older one is never dropped (it's the honest record of then, and often still
 * true). Recently touched observations keep their boost (≤30d ×1.15, ≤180d ×1.05); untouched
 * ones gently sink past a year (0.92) and past two (0.85). This is presentation ordering, not
 * judgment: `stale` (ttl-expired) remains the only hard demotion, and maintain.ts's aged-
 * observation list is a re-observation queue, never an archive-by-age list.
 */
function recency(node: MemoryNode, now: number): number {
  const t = Date.parse(node.updated || node.created);
  if (!Number.isFinite(t)) return 1;
  const days = (now - t) / 86_400_000;
  if (days <= RECENT_DAYS) return 1.15;
  if (days <= 180) return 1.05;
  if (days <= 365) return 1;
  if (days <= 730) return 0.92;
  return 0.85;
}

function edgeWeight(e: MemoryEdge): number {
  // A typed relation is an intentional edge (issue #60), so it outranks an incidental prose
  // mention even when it lives in the body — this is how recall weighs a superseding fact above
  // the one it superseded. Untyped body mentions stay the weakest signal.
  if (e.rel) return 5;
  return e.field === "body" ? 2 : 5; // structural edges outrank incidental prose mentions
}

/**
 * Human-readable expansion reason that surfaces an edge's relation type and observation date
 * (issue #60), so a recall answer can say "supersedes X (observed 2026-07-14)" instead of a bare
 * "linked". `seed` is the frontier node the hop started from; `isOut` distinguishes an out-edge
 * (seed → target) from a followed backlink (linker → seed). A frontmatter field that is itself a
 * relation name (e.g. `supersedes:`) reads as that relation even without an inline `rel:` prefix.
 */
function edgeReason(e: MemoryEdge, isOut: boolean, seed: string): string {
  const when = e.date ? ` (observed ${e.date})` : "";
  const rel = e.rel ?? (RELATION_TYPE_SET.has(e.field) ? (e.field as RelationType) : undefined);
  if (rel) {
    // Directional statement "subject rel object": for an out-edge the seed is the subject and
    // the expanded target (e.to) the object; for a backlink the linking node (e.from) is.
    return isOut ? `${seed} ${rel} ${e.to}${when}` : `${e.from} ${rel} ${seed}${when}`;
  }
  return `linked ${isOut ? "to" : "from"} ${seed} via ${e.field}${when}`;
}

// =======================================================================================
// Dedup + content composition (Spec 08 §4.2 / §4.4)
// =======================================================================================

interface NodeContent {
  metadata: Record<string, unknown>;
  description: string;
  body: string;
}

/** Find a node that already covers this fact, to coerce create→update (Spec 08 §4.2).
 *  Bridged (harness-origin) nodes are excluded from every arm: a remember can never merge
 *  into — and thereby write — a read-only harness file (issue #160). A save that reuses a
 *  bridged node's name creates a NATIVE node, which then shadows the bridged one in the
 *  graph (native wins the name), while the harness file stays untouched. */
function findExisting(intent: RememberIntent, g: MemoryGraph): MemoryNode | null {
  // 1. Exact (non-phantom) name hit.
  const byName = g.nodes.get(intent.name);
  if (byName && !byName.phantom && !isBridgedNode(byName)) return byName;

  // 2. Alias hit (slug-compared).
  const target = slug(intent.name);
  for (const n of g.nodes.values()) {
    if (n.phantom || isBridgedNode(n)) continue;
    if (asStringArray(n.metadata.aliases).map(slug).includes(target)) return n;
  }

  // 3. A phantom with this name → fill it in (upgrade, not create).
  if (byName?.phantom) return byName;

  // 4. High-similarity description/name match of the SAME type → likely the same fact.
  //    Stemmed similarity (search.ts), so "deploying the docs" collides with "deploy docs".
  //    But a similarity (non-exact-name) match must NOT cross a visibility boundary: the
  //    metadata merge would rewrite scope, so a dm-scoped save could swallow/flip a public
  //    node (and vice versa). Only match a node whose effective visibility+dm_with equals the
  //    intended save's — the same provenanceOf rule the maintenance pass uses (maintain.ts).
  //    (Exact name/alias/phantom hits above are identity, not similarity, so they still merge
  //    with the explicit-flag-wins scope rule regardless of the prior scope.)
  if (!intent.description) return null;
  const intended = provenanceOf({ metadata: intent.metadata ?? {} });
  let best: { node: MemoryNode; sim: number } | null = null;
  for (const n of g.nodes.values()) {
    if (n.phantom || isBridgedNode(n)) continue;
    if (intent.type && n.type !== intent.type) continue;
    const p = provenanceOf(n);
    if (p.visibility !== intended.visibility || p.dmWith !== intended.dmWith) continue;
    const sim = nodeSimilarity({ name: intent.name, description: intent.description }, n);
    if (!best || sim > best.sim) best = { node: n, sim };
  }
  return best && best.sim >= DEDUP_THRESHOLD ? best.node : null;
}

function buildNewContent(intent: RememberIntent): NodeContent {
  const now = nowIso();
  const metadata: Record<string, unknown> = { type: intent.type, ...(intent.metadata ?? {}) };
  metadata.created = metadata.created ?? now;
  metadata.updated = now;
  metadata.source = intent.source;
  return {
    metadata,
    description: (intent.description ?? "").trim(),
    body: (intent.body ?? "").trim(),
  };
}

function mergeInto(existing: MemoryNode, intent: RememberIntent): NodeContent {
  const now = nowIso();
  const metadata: Record<string, unknown> = { ...existing.metadata, ...(intent.metadata ?? {}) };
  metadata.type = intent.type ?? existing.metadata.type ?? existing.type;
  metadata.created = existing.metadata.created ?? now;
  metadata.updated = now;
  if (intent.source) metadata.source = intent.source;

  let body = existing.body.trim();
  if (intent.body != null) {
    body = intent.op === "append" ? `${body}\n\n${intent.body.trim()}`.trim() : intent.body.trim();
  }

  // The MEMORY.md one-liner is derived from `description`, and it's the ONLY thing loaded into
  // every session (the body is invisible until a recall pulls the file). So a re-observation
  // that restates the body but forgets to restate the description leaves the always-loaded hook
  // asserting the OLD, now-contradicted claim — the corrected body never reaches the reader
  // until something forces a recall (issue #96: a node's body said cross-fork PRs were CONFIRMED
  // WORKING while its index line still read "PAT can't open PRs", and that stale hook drove a
  // wrong answer three weeks later). An `op: "update"` REPLACES the body, so it's a full
  // re-statement: when it carries a new body but no new description, refresh the hook FROM that
  // new body's leading line so the index can never contradict it. `append` is accretion (the
  // body still leads with the prior statement), so its existing hook stays.
  const restatedHook =
    intent.op === "update" && intent.body != null && body ? leadLine(body) : "";
  const description = intent.description?.trim() || restatedHook || existing.description;

  return { metadata, description, body };
}

/** First substantive line of a body as a one-line hook: strips a leading list/heading/quote
 *  marker, collapses whitespace. Empty when the body has no prose line (keeps the caller's
 *  fallback in play). Used to refresh a restated memory's index one-liner (issue #96). */
function leadLine(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*>]|#{1,6}|\d+[.)])\s+/, "").trim();
    if (line && !/^\[\[[a-z0-9-]+\]\]$/.test(line)) return line.replace(/\s+/g, " ");
  }
  return "";
}

/** Materialize `links` into the content so the next graph build re-extracts them (Spec 08 §2.2).
 *  A link may carry a relation type + observation date (issue #60); both are optional and a bare
 *  link stays bare. An unknown type or malformed date is dropped, never emitted. */
function applyLinks(content: NodeContent, links?: RememberIntent["links"]): void {
  if (!links) return;
  for (const { to, field, rel, date } of links) {
    if (!/^[a-z0-9-]+$/.test(to)) continue;
    const relPart = rel && RELATION_TYPE_SET.has(rel) ? `${rel}:` : "";
    const datePart = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? ` @${date}` : "";
    const wl = `[[${relPart}${to}${datePart}]]`;
    if (STRUCTURAL_FIELDS.has(field)) {
      const arr = asStringArray(content.metadata[field]);
      if (!arr.some((x) => extractName(x) === to)) arr.push(wl);
      content.metadata[field] = arr;
    } else if (![...content.body.matchAll(WIKILINK)].some((m) => m[2] === to)) {
      // Don't double-link a target the body already references in any form (bare/typed/dated).
      content.body = `${content.body.trim()}\n\n${wl}`.trim();
    }
  }
}

// =======================================================================================
// Parse: file → node + edges (Spec 08 §2.2)
// =======================================================================================

/** Parse one memory markdown file into a node and its outgoing edges. */
export function parseMemoryFile(
  path: string,
  raw: string,
  mtime: number,
): { node: MemoryNode; edges: MemoryEdge[] } {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseYaml(frontmatter) as Record<string, unknown>;
  const meta = (fm.metadata ?? {}) as Record<string, unknown>;
  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  const type = typeof meta.type === "string" ? meta.type : "";
  if (!name || !description || !type) {
    throw new Error(`missing required frontmatter (name/description/metadata.type) in ${path}`);
  }

  const cleanBody = stripGeneratedBacklinks(body).trim();
  const edges: MemoryEdge[] = [];
  const seen = new Set<string>();
  const add = (
    to: string,
    field: string,
    extra: { alias?: string; rel?: RelationType; date?: string } = {},
  ) => {
    // Key on rel too: two typed edges to the same target (e.g. `[[supersedes:x]]` and
    // `[[about:x]]`) are distinct relations, not a duplicate to collapse.
    const key = `${field} ${extra.rel ?? ""} ${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: name, to, field, alias: extra.alias, rel: extra.rel, date: extra.date });
  };

  // (a) structural edges from link-typed frontmatter fields (higher weight).
  for (const field of STRUCTURAL_FIELDS) {
    for (const v of asStringArray(meta[field])) {
      const m = matchWikilink(v);
      if (m) add(m.name, field, { alias: m.alias, rel: m.rel, date: m.date });
    }
  }
  // (b) prose edges from the body — but NOT from inside code (fenced blocks or inline `spans`).
  //     A note that documents the memory format writes literal `[[name]]` / `[[wikilinks]]`
  //     examples in backticks; those are illustrations, not edges. Extracting them mints bogus
  //     phantom nodes (`name`, `wikilinks`) that the maintenance report then flags forever.
  for (const m of stripCodeForLinks(cleanBody).matchAll(WIKILINK)) {
    add(m[2]!, "body", { rel: m[1] as RelationType | undefined, alias: m[3], date: m[4] });
  }

  const node: MemoryNode = {
    name,
    type,
    description,
    metadata: meta,
    body: cleanBody,
    path,
    created: String(meta.created ?? ""),
    updated: String(meta.updated ?? ""),
    source: (meta.source as MemoryNode["source"]) ?? "manual",
    confidence: meta.confidence as MemoryNode["confidence"],
    stale: isExpired(meta.ttl),
    phantom: false,
    mtime,
  };
  return { node, edges };
}

function phantomNode(name: string): MemoryNode {
  return {
    name,
    type: "reference",
    description: "",
    metadata: {},
    body: "",
    path: "",
    created: "",
    updated: "",
    source: "derived",
    stale: false,
    phantom: true,
    mtime: 0,
  };
}

// =======================================================================================
// Render: node → markdown + index + backlinks (Spec 08 §1, §4.5)
// =======================================================================================

/** Render a full memory file (frontmatter + body + generated backlinks). */
export function renderNode(node: MemoryNode, g: MemoryGraph): string {
  let fm = "---\n";
  // Same rule as metadata values: an ALL-DIGIT name must be quoted or the YAML parser reads it
  // back as a Number and `parseMemoryFile` drops the file as nameless. Person files are named
  // for a Discord snowflake (`people/<discord-user-id>.md`), so this is the difference between
  // a readable node and an invisible one. Kebab-case names are unaffected (rendered bare).
  fm += `name: ${serializeMaybeQuoted(node.name)}\n`;
  fm += `description: >\n  ${node.description.replace(/\s+/g, " ").trim()}\n`;
  fm += "metadata:\n";
  for (const [key, value] of orderedMeta(node.metadata)) {
    fm += `  ${key}: ${serializeMeta(value)}\n`;
  }
  fm += "---\n";
  return fm + "\n" + composeBody(node.body.trim(), backlinkLines(g, node.name));
}

/** Append/replace the `## Backlinks` block onto a body (Spec 08 §1.4). */
function composeBody(body: string, links: string[]): string {
  const base = body.trim();
  if (links.length === 0) return base + "\n";
  const section = "## Backlinks\n" + links.map((l) => `- ${l}`).join("\n") + "\n";
  return (base ? base + "\n\n" : "") + section;
}

/** Inbound edges rendered as `[[from]] (field)` lines, deduped + stably sorted (Spec 08 §2.5).
 *  A typed and/or dated edge (issue #60) annotates the field: `[[from]] (supersedes, 2026-07-14)`
 *  so the relation and its observation date ride along on the generated backlink. */
function backlinkLines(g: MemoryGraph, name: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of (g.in.get(name) ?? []).slice().sort((a, b) =>
    a.from === b.from ? a.field.localeCompare(b.field) : a.from.localeCompare(b.from),
  )) {
    const rel = e.rel ?? (RELATION_TYPE_SET.has(e.field) ? e.field : undefined);
    const parts = [rel ?? e.field, e.date].filter(Boolean);
    const line = `[[${e.from}]] (${parts.join(", ")})`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** Build the in-memory index (Spec 08 §1.7) from the real nodes — `MEMORY.md`'s source. */
function buildIndex(nodes: Map<string, MemoryNode>): IndexLine[] {
  const lines: IndexLine[] = [];
  for (const n of nodes.values()) {
    if (n.phantom) continue;
    lines.push({ name: n.name, type: n.type, description: n.description, updated: n.updated });
  }
  return lines.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : String(a.type).localeCompare(String(b.type)),
  );
}

/** Render `MEMORY.md` deterministically so a single-fact change is a single-line diff (§4.5).
 *  PUBLIC nodes only: MEMORY.md is the always-loaded convenience materialization, read into
 *  arbitrary sessions (including ones serving non-owners), so even a scoped node's name +
 *  one-line description landing in it would leak past the fail-closed recall gate (multiplayer
 *  §9.1). Scoped facts are reachable only through `recall` with a proper audience. */
export function renderIndex(g: MemoryGraph): string {
  // Fail closed like recall: a line whose node is missing (or unparseable) is omitted too.
  // Bridged (harness-origin) nodes are excluded outright — this file materializes THIS store;
  // the harness store keeps its own index, and the bridge publishes the reverse direction
  // into it (issue #160, ./bridge.ts).
  const lines = g.index.filter((line) => {
    const node = g.nodes.get(line.name);
    return node ? !isBridgedNode(node) && provenanceOf(node).visibility === "public" : false;
  });
  let out = "# Beckett Memory Index\n";
  out += `<!-- GENERATED. Do not edit. Regenerated on every memory write. last: ${nowIso()}, ${lines.length} public nodes (scoped nodes are omitted — recall with an audience) -->\n`;
  const now = Date.now();
  let lastType: string | null = null;
  for (const line of lines) {
    if (line.type !== lastType) {
      out += `\n## ${line.type}\n`;
      lastType = String(line.type);
    }
    // Age flag on old lines (dated observations, alita-style "current vs history" honesty):
    // MEMORY.md is ALWAYS loaded, so it's the cheapest place to teach every session that a line
    // untouched for 90+ days is an observation FROM THEN — still on the record, never deleted,
    // just anchored to its time. The fact stays; its date travels with it.
    // Dream nodes carry their nature into the always-loaded index: an inference read cold
    // must never pass for an observed fact (issue #36).
    const node = g.nodes.get(line.name);
    const inference = node && isInferenceNode(node) ? "[inference] " : "";
    out += `- [[${line.name}]] — ${inference}${line.description}${indexAgeFlag(line.updated, now)}\n`;
  }
  return out;
}

function orderedMeta(metadata: Record<string, unknown>): [string, unknown][] {
  const keys = Object.keys(metadata);
  const taken = new Set<string>();
  const result: [string, unknown][] = [];
  const take = (k: string) => {
    if (k in metadata && !taken.has(k)) {
      taken.add(k);
      result.push([k, metadata[k]]);
    }
  };
  for (const k of META_ORDER) take(k);
  for (const k of keys.filter((k) => !META_ORDER.includes(k) && !META_TAIL.includes(k)).sort()) {
    take(k);
  }
  for (const k of META_TAIL) take(k);
  return result;
}

// =======================================================================================
// YAML frontmatter parser (dependency-free; handles the Spec 08 §1.2 subset)
// =======================================================================================

/** Split a `---`-fenced frontmatter block from the markdown body. */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: text };
  return { frontmatter: m[1]!, body: text.slice(m[0].length) };
}

/** Return the exact `---...---` frontmatter header text (including fences) of a raw file. */
function frontmatterHead(raw: string): string {
  const text = raw.replace(/^﻿/, "");
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? m[0].replace(/\r?\n?$/, "\n") : "";
}

/** Remove the generated `## Backlinks` section (to its next `## ` heading or EOF) — §1.4. */
export function stripGeneratedBacklinks(body: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Backlinks\s*$/i.test(l));
  if (start === -1) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+(?!Backlinks)/i.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

interface YamlLine {
  indent: number;
  text: string;
}

/** Parse a YAML frontmatter block into a plain object (maps, sequences, scalars, folded). */
export function parseYaml(block: string): Record<string, unknown> {
  const lines = block.split(/\r?\n/);
  const result = parseYamlMap(lines, 0, lines.length, -1).value;
  return (result ?? {}) as Record<string, unknown>;
}

function lineInfo(rawLine: string): YamlLine | null {
  if (rawLine.trim() === "") return null;
  const indent = rawLine.length - rawLine.replace(/^ +/, "").length;
  return { indent, text: rawLine.slice(indent) };
}

/** Parse a mapping whose keys sit at `> parentIndent`, within [start, end). */
function parseYamlMap(
  lines: string[],
  start: number,
  end: number,
  parentIndent: number,
): { value: Record<string, unknown>; next: number } {
  const map: Record<string, unknown> = {};
  let i = start;
  let mapIndent = -1;

  while (i < end) {
    const info = lineInfo(lines[i]!);
    if (info === null) {
      i++;
      continue;
    }
    if (info.indent <= parentIndent) break;
    if (mapIndent === -1) mapIndent = info.indent;
    if (info.indent !== mapIndent) {
      // Should not happen for well-formed files; skip stray deeper lines defensively.
      i++;
      continue;
    }

    const content = stripInlineComment(info.text);
    const colon = findKeyColon(content);
    if (colon === -1) {
      i++;
      continue;
    }
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    i++;

    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const folded = rest[0] === ">";
      const { value, next } = readBlockScalar(lines, i, end, mapIndent, folded);
      map[key] = value;
      i = next;
    } else if (rest === "") {
      // Nested map or sequence (or null if nothing deeper).
      const peek = nextMeaningful(lines, i, end);
      if (peek && peek.info.indent > mapIndent) {
        if (peek.info.text.startsWith("- ")) {
          const { value, next } = parseYamlSeq(lines, i, end, mapIndent);
          map[key] = value;
          i = next;
        } else {
          const { value, next } = parseYamlMap(lines, i, end, mapIndent);
          map[key] = value;
          i = next;
        }
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseScalarOrFlow(rest);
    }
  }

  return { value: map, next: i };
}

/** Parse a block sequence whose `- ` items sit at `> parentIndent`. */
function parseYamlSeq(
  lines: string[],
  start: number,
  end: number,
  parentIndent: number,
): { value: unknown[]; next: number } {
  const seq: unknown[] = [];
  let i = start;
  let seqIndent = -1;
  while (i < end) {
    const info = lineInfo(lines[i]!);
    if (info === null) {
      i++;
      continue;
    }
    if (info.indent <= parentIndent) break;
    if (seqIndent === -1) seqIndent = info.indent;
    if (info.indent !== seqIndent || !info.text.startsWith("- ")) break;
    const item = stripInlineComment(info.text.slice(2)).trim();
    seq.push(parseScalarOrFlow(item));
    i++;
  }
  return { value: seq, next: i };
}

function nextMeaningful(
  lines: string[],
  start: number,
  end: number,
): { idx: number; info: YamlLine } | null {
  for (let i = start; i < end; i++) {
    const info = lineInfo(lines[i]!);
    if (info) return { idx: i, info };
  }
  return null;
}

/** Read a `>`/`|` block scalar: all lines indented deeper than the key's indent. */
function readBlockScalar(
  lines: string[],
  start: number,
  end: number,
  keyIndent: number,
  folded: boolean,
): { value: string; next: number } {
  const collected: string[] = [];
  let i = start;
  let blockIndent = -1;
  while (i < end) {
    const rawLine = lines[i]!;
    if (rawLine.trim() === "") {
      collected.push("");
      i++;
      continue;
    }
    const indent = rawLine.length - rawLine.replace(/^ +/, "").length;
    if (indent <= keyIndent) break;
    if (blockIndent === -1) blockIndent = indent;
    collected.push(rawLine.slice(Math.min(blockIndent, indent)));
    i++;
  }
  // Trim trailing blank lines.
  while (collected.length && collected[collected.length - 1] === "") collected.pop();
  const value = folded
    ? collected.map((l) => l.trim()).join(" ").replace(/\s+/g, " ").trim()
    : collected.join("\n");
  return { value, next: i };
}

/** Find the `:` that separates a YAML key from its value (skips `::`/quotes/brackets). */
function findKeyColon(s: string): number {
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inS) {
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === '"' && s[i - 1] !== "\\") inD = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0 && (i === s.length - 1 || s[i + 1] === " ")) return i;
  }
  return -1;
}

/** Strip a trailing ` # comment` that is not inside quotes/brackets. */
function stripInlineComment(line: string): string {
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inS) {
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === '"' && line[i - 1] !== "\\") inD = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "#" && depth === 0 && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).replace(/\s+$/, "");
    }
  }
  return line;
}

function parseScalarOrFlow(s: string): unknown {
  const t = s.trim();
  if (t.startsWith("[")) return parseFlowSeq(t);
  if (t.startsWith("{")) return parseFlowMap(t);
  return parseScalar(t);
}

function parseFlowSeq(s: string): unknown[] {
  const inner = s.replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return splitTopLevel(inner).map((x) => parseScalarOrFlow(x.trim()));
}

function parseFlowMap(s: string): Record<string, unknown> {
  const inner = s.replace(/^\{/, "").replace(/\}$/, "");
  const obj: Record<string, unknown> = {};
  if (inner.trim() === "") return obj;
  for (const pair of splitTopLevel(inner)) {
    const colon = findKeyColon(pair);
    if (colon === -1) continue;
    obj[pair.slice(0, colon).trim()] = parseScalarOrFlow(pair.slice(colon + 1).trim());
  }
  return obj;
}

/** Split on top-level commas, honoring quotes and nested brackets. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inS) {
      buf += c;
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      buf += c;
      if (c === '"' && s[i - 1] !== "\\") inD = false;
      continue;
    }
    if (c === "'") {
      inS = true;
      buf += c;
    } else if (c === '"') {
      inD = true;
      buf += c;
    } else if (c === "[" || c === "{") {
      depth++;
      buf += c;
    } else if (c === "]" || c === "}") {
      depth = Math.max(0, depth - 1);
      buf += c;
    } else if (c === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return Number.parseFloat(t);
  return t;
}

// =======================================================================================
// YAML serialization (deterministic, round-trippable through the parser above)
// =======================================================================================

function serializeMeta(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map(serializeFlowItem).join(", ") + "]";
  return serializeMaybeQuoted(String(v));
}

function serializeFlowItem(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(String(v)); // always quote strings inside flow arrays (safe)
}

function serializeMaybeQuoted(s: string): string {
  if (s === "") return '""';
  // An all-digit STRING value must always be quoted: a bare scalar round-trips through the YAML
  // parser as a Number, silently corrupting any id past 2^53 (Discord snowflakes are 17–20
  // digits). This generalizes the former per-key id allowlist so ANY future digit-valued key
  // (dm_with, source_user, a not-yet-invented one) survives as an exact string. (Numeric-typed
  // metadata never reaches here — serializeMeta renders `number`s directly.)
  if (/^\d+$/.test(s)) return JSON.stringify(s);
  // Plain scalar is safe only for simple, comment/flow-free tokens (dates, slugs, paths, emails).
  const safe = /^[A-Za-z0-9][A-Za-z0-9 _.\-:/@+]*$/.test(s) && !/:\s/.test(s) && !/\s#/.test(s);
  return safe ? s : JSON.stringify(s);
}

// =======================================================================================
// Small utilities
// =======================================================================================

/**
 * Blank out code regions so body wikilink extraction never treats a documented `[[name]]`
 * example as a real edge (Spec 08 §2.2 — links are prose, not code samples). Fenced blocks
 * (``` / ~~~) and inline `code spans` are replaced with equal-length runs of spaces, which
 * removes any `[[...]]` inside them while leaving every real link's text and position intact.
 */
function stripCodeForLinks(body: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return body
    // Fenced blocks first (``` or ~~~, ≥3 of the same char), so a `[[link]]` on a fenced line
    // is gone before the inline pass can see its backticks.
    .replace(/(`{3,})[\s\S]*?\1/g, blank)
    .replace(/(~{3,})[\s\S]*?\1/g, blank)
    // Then inline spans: a run of backticks closed by an equal-length run (CommonMark spans).
    .replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, blank);
}

function matchWikilink(
  v: string,
): { name: string; alias?: string; rel?: RelationType; date?: string } | null {
  const m = v.match(WIKILINK_ONE);
  if (m) {
    return { name: m[2]!, alias: m[3], rel: m[1] as RelationType | undefined, date: m[4] };
  }
  const bare = v.trim();
  if (/^[a-z0-9-]+$/.test(bare)) return { name: bare };
  return null;
}

function extractName(v: string): string {
  const m = matchWikilink(v);
  return m ? m.name : v.trim();
}

/**
 * Retarget every `[[…name…]]` edge whose target is `from` to point at `to`, preserving that
 * edge's relation-type prefix, `|alias`, and ` @date` (issue #60). Used by merge/rename so a
 * typed or dated inbound link isn't silently downgraded to a bare (or broken) one.
 */
function renameWikilinkTarget(text: string, from: string, to: string): string {
  return text.replace(new RegExp(WIKILINK.source, "g"), (whole, rel, nm, alias, date) => {
    if (nm !== from) return whole;
    const relPart = rel ? `${rel}:` : "";
    const aliasPart = alias != null ? `|${alias}` : "";
    const datePart = date ? ` @${date}` : "";
    return `[[${relPart}${to}${aliasPart}${datePart}]]`;
  });
}

function pushEdge(map: Map<string, MemoryEdge[]>, key: string, e: MemoryEdge): void {
  const arr = map.get(key);
  if (arr) arr.push(e);
  else map.set(key, [e]);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Coerce a metadata value into an array of strings (single value, array, or absent). */
function asStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
}

function isExpired(ttl: unknown, now = Date.now()): boolean {
  if (typeof ttl !== "string" || ttl.trim() === "") return false;
  const t = Date.parse(ttl);
  return Number.isFinite(t) && t < now;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
