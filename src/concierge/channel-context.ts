/**
 * Channel-scoped shared context store (OPS-80 §3).
 * =======================================================================================
 * The multiplayer wedge: when Beckett answers anyone in a channel it should reason over
 * the recent conversation among *everyone* there, not just the mention in front of it.
 * Today's ambient ring buffer is in-memory (lost on every deploy), has holes exactly
 * where Beckett was involved, and forgets Beckett's own replies. This module is the
 * durable replacement: one JSONL file per channel of attributed entries, bounded by a
 * hard count cap and a sessionId-keyed watermark committed only after a successful turn, so a
 * failed/queued turn is never allowed to skip lines — while a rotation/fresh session
 * self-invalidates the watermark and gets a full catch-up window.
 *
 * Two standing rules shape everything here:
 *   - Capture must NEVER break a turn: every fs failure is caught + logged, the store
 *     degrades to its in-memory cache and never throws into the caller.
 *   - channelId is a path component: anything outside a strict allowlist is refused
 *     outright so a hostile id can never traverse out of the channels dir.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  channelDocId,
  channelDocument,
  channelEntryText,
  channelMossDir,
  cosineSim,
  embedLocal,
  openChannelMoss,
  RANKING_SEMANTIC_WEIGHT,
  SEM_FLOOR,
  SEM_TOPK_CAP,
  SEM_WEIGHT,
  type LocalMoss,
  type MossDocument,
} from "./channel-moss.ts";
import { STOP_WORDS } from "../moss-local/index.ts";
import type { IncomingMentionTarget, IncomingMessageSnapshot, Logger } from "../types.ts";

/** One captured message in a channel's shared window. */
export interface ChannelEntry {
  /** Discord id, or synthetic id for Beckett's own posts. */
  messageId: string;
  /** Epoch ms. */
  ts: number;
  /** Discord user id; "beckett" sentinel for our own posts. */
  authorId: string;
  /** Display name at capture time (render label only — never authoritative). */
  authorName: string;
  /** Raw text (attachments already folded in by the caller). */
  content: string;
  /** Discord's native reply target, when present. Optional for backward-compatible stored rows. */
  repliedToId?: string | null;
  /**
   * Explicit @mention targets on this message (issue #232). Carried into the record so the ambient
   * classifier's snapshot knows who the author actually addressed, not merely that someone spoke.
   * Absent on rows written before this field existed, and on messages that mentioned nobody.
   */
  mentions?: IncomingMentionTarget[];
  kind: "user" | "beckett";
  /**
   * Quoted originals from a Discord forward, when this entry captured one (#111). Kept on the
   * entry so a later mention/DM turn from the SAME author can fold the forwarded material into
   * its own turn even though the forward itself never mentioned the bot.
   */
  forwardedSnapshots?: IncomingMessageSnapshot[];
}

/**
 * Channel-level metadata captured alongside entries (server memory, v4.1): the name lets
 * awareness/search speak in `#channel` terms; guildId scopes server-wide features. A null
 * guildId marks a DM channel — server-wide search/awareness MUST exclude those in code.
 */
export interface ChannelMeta {
  name: string | null;
  guildId: string | null;
}

/** The rolling LLM-built profile of a channel: what's being talked about there. */
export interface ChannelProfile {
  summary: string;
  topics: string[];
  updatedAt: number;
  /** Newest entry id at profile time — staleness is measured from here. */
  lastMessageId: string;
  entryCount: number;
}

/** One channel's stats for listing/awareness: bounded-window counts + latest names. */
export interface ChannelInfo {
  channelId: string;
  name: string | null;
  guildId: string | null;
  entryCount: number;
  /** Newest stored Discord/synthetic message id; boot reconciliation fetches after this. */
  lastMessageId: string;
  lastTs: number;
  /** Distinct recent speaker display names (latest capture wins), capped. */
  participants: string[];
  profile: ChannelProfile | null;
}

export interface ChannelSearchHit {
  channelId: string;
  channelName: string | null;
  entry: ChannelEntry;
  /** Neighbouring entries (±radius) so a hit carries its conversation, not one orphan line. */
  context: ChannelEntry[];
  /** Distinct query terms matched — the ranking key before recency. */
  score: number;
}

export interface ChannelSearchOptions {
  /** Max hits returned across all channels (default 8). */
  limit?: number;
  /** Restrict to one channel (still guild-gated — a DM id yields nothing). */
  channelId?: string;
  /** Restrict to channels of this guild. */
  guildId?: string;
  /** Entries either side of a hit included as context (default 2). */
  contextRadius?: number;
}

export interface ChannelContextStoreOptions {
  /** `<beckettDir>/channels` — created lazily (mkdirSync recursive before first write). */
  channelsDir: string;
  /** Hard count cap per channel. */
  maxEntriesPerChannel: number;
  /** TTL in hours, enforced at read + compaction. */
  maxAgeHours: number;
  logger: Logger;
  /** Injectable clock for deterministic tests (default Date.now). */
  now?: () => number;
  /** Appends per channel between compaction rewrites (default 25). */
  compactEvery?: number;
}

export interface ChannelContextStore {
  append(channelId: string, entry: ChannelEntry): void;
  /** The bounded live window: TTL + count cap applied, oldest → newest. Returns a copy. */
  recent(channelId: string): ChannelEntry[];
  /** Entries this session hasn't seen. Reading is deliberately non-mutating; mark only after its turn succeeds. */
  takeUnseen(channelId: string, sessionId: string): ChannelEntry[];
  /** Advance the watermark without reading (an ambient turn already surfaced the window itself). */
  markSeen(channelId: string, sessionId: string, lastMessageId: string): void;
  /** Delete one channel's stored window (or ALL channels when omitted) + their watermarks, meta and profiles. Returns the wiped channel ids. */
  wipe(channelId?: string): string[];
  /** Record channel name/guild seen on a message; persists only when something changed. */
  noteMeta(channelId: string, meta: ChannelMeta): void;
  getMeta(channelId: string): ChannelMeta | null;
  /** Every channel with a non-empty bounded window, newest activity first. */
  listChannels(): ChannelInfo[];
  /**
   * Search across stored windows, blending a semantic pass (the local Moss index) with the
   * literal keyword pass. HARD-scoped to guild channels: a channel with no recorded meta or a
   * null guildId (DMs, pre-meta data) is never searched — privacy is enforced here, not in
   * doctrine. Synchronous: it uses the index only once {@link ensureIndexed} has primed it, and
   * always falls back to the keyword scorer when the index is missing or fails.
   */
  search(query: string, opts?: ChannelSearchOptions): ChannelSearchHit[];
  /**
   * Bring the semantic index up to date with the current guild windows (open it on first
   * call, then reconcile only the channels that changed since the last call — never a rebuild
   * per query). Await it before {@link search} for semantic ranking; skipping it degrades
   * search to the keyword scorer. Best-effort — a broken runtime is logged, never thrown.
   */
  ensureIndexed(): Promise<void>;
  getProfile(channelId: string): ChannelProfile | null;
  /** Write a channel's rolling profile; the store stamps `updatedAt`. */
  setProfile(channelId: string, profile: Omit<ChannelProfile, "updatedAt">): void;
}

// channelId doubles as a filename component; only word chars, dots, dashes — no separators.
const CHANNEL_ID_RE = /^[\w.-]{1,64}$/;
const DEFAULT_COMPACT_EVERY = 25;
const JSONL_EXT = ".jsonl";
const WATERMARKS_FILE = "watermarks.json";
const META_FILE = "channels-meta.json";
const PROFILES_FILE = "profiles.json";
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_CONTEXT_RADIUS = 2;
const PARTICIPANTS_CAP = 8;
const NAME_MAX = 100;

interface WatermarkRecord {
  lastMessageId: string;
  sessionId: string;
}

/**
 * Create the per-channel shared-context store. All state lives under `channelsDir`:
 * `<channelId>.jsonl` per channel plus one `watermarks.json`. Every method is
 * best-effort — fs errors are logged and swallowed, never thrown into the caller.
 */
export function createChannelContextStore(opts: ChannelContextStoreOptions): ChannelContextStore {
  const { channelsDir, maxEntriesPerChannel, maxAgeHours, logger } = opts;
  const now = opts.now ?? Date.now;
  const compactEvery = opts.compactEvery ?? DEFAULT_COMPACT_EVERY;

  // Per-channel in-memory cache, loaded lazily on first touch. Trimmed to the count
  // cap on append; TTL is applied at read so entries expire without a write.
  const cache = new Map<string, ChannelEntry[]>();
  const appendsSinceCompact = new Map<string, number>();
  // Warn once per hostile id — a misbehaving caller shouldn't flood the log.
  const warnedChannelIds = new Set<string>();
  let watermarks: Record<string, WatermarkRecord> | null = null;

  // ── semantic index (issue #73) — a disposable Moss cache derived from the guild windows.
  // `moss` is opened lazily by ensureIndexed(); `indexed` mirrors which messageIds are in it,
  // `dirty` is the set of channels whose index slice needs reconciling. `mossFailed` latches a
  // broken runtime so search stays on the keyword fallback without retrying every call.
  let moss: LocalMoss | null = null;
  let mossOpening: Promise<LocalMoss | null> | null = null;
  let mossFailed = false;
  const indexed = new Map<string, Set<string>>();
  const dirty = new Set<string>();

  function markIndexDirty(channelId: string): void {
    if (mossFailed) return;
    dirty.add(channelId);
  }

  function channelFile(channelId: string): string {
    return join(channelsDir, `${channelId}${JSONL_EXT}`);
  }

  function validChannelId(channelId: string): boolean {
    if (CHANNEL_ID_RE.test(channelId)) return true;
    if (!warnedChannelIds.has(channelId)) {
      warnedChannelIds.add(channelId);
      logger.warn("rejecting invalid channel id", { channelId });
    }
    return false;
  }

  /**
   * Re-materialize the stored mention targets. A malformed or partial row loses only its mentions
   * (the entry itself still stands) — an @mention list is enrichment, never load-bearing.
   */
  function parseMentions(raw: unknown): IncomingMentionTarget[] {
    if (!Array.isArray(raw)) return [];
    const targets: IncomingMentionTarget[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const { id, name } = item as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || typeof name !== "string" || !id || !name) continue;
      targets.push({ id, name });
    }
    return targets;
  }

  /** Re-materialize one line; anything structurally off is dropped (counted by the caller). */
  function parseEntry(line: string): ChannelEntry | null {
    try {
      const raw = JSON.parse(line) as Partial<ChannelEntry>;
      if (
        typeof raw.messageId === "string" &&
        typeof raw.authorId === "string" &&
        typeof raw.authorName === "string" &&
        typeof raw.content === "string" &&
        typeof raw.ts === "number" &&
        Number.isFinite(raw.ts) &&
        (raw.repliedToId === undefined || raw.repliedToId === null || typeof raw.repliedToId === "string") &&
        (raw.kind === "user" || raw.kind === "beckett")
      ) {
        const mentions = parseMentions(raw.mentions);
        return {
          messageId: raw.messageId,
          ts: raw.ts,
          authorId: raw.authorId,
          authorName: raw.authorName,
          content: raw.content,
          ...(raw.repliedToId !== undefined ? { repliedToId: raw.repliedToId } : {}),
          ...(mentions.length > 0 ? { mentions } : {}),
          kind: raw.kind,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** TTL + count cap, oldest → newest. Pure — bounds are always computed from `now()`. */
  function bounded(entries: ChannelEntry[]): ChannelEntry[] {
    const cutoff = now() - maxAgeHours * 3_600_000;
    const live = entries.filter((e) => e.ts >= cutoff);
    return live.slice(Math.max(0, live.length - maxEntriesPerChannel));
  }

  /** Rewrite the channel file to exactly the bounded window (tmp + rename). */
  function compact(channelId: string): void {
    const window = bounded(cache.get(channelId) ?? []);
    try {
      mkdirSync(channelsDir, { recursive: true });
      const file = channelFile(channelId);
      const tmp = `${file}.tmp`;
      const body = window.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(tmp, body.length > 0 ? body + "\n" : "", "utf8");
      renameSync(tmp, file);
    } catch (err) {
      logger.warn("channel context compaction failed", {
        channelId,
        error: (err as Error).message,
      });
      // A failed rename (or a crash between write and rename) strands the tmp forever —
      // nothing else reads or removes it. Clean up best-effort; next compaction rewrites it.
      try {
        rmSync(`${channelFile(channelId)}.tmp`, { force: true });
      } catch {
        /* best-effort */
      }
    }
    appendsSinceCompact.set(channelId, 0);
    // Compaction can drop entries out of the bounded window — the index must shed them too.
    markIndexDirty(channelId);
  }

  /**
   * Load a channel's file into the cache on first touch. Tolerant per-line parse:
   * malformed lines are dropped with one warn carrying the counts. If the load shrank
   * anything (malformed / expired / over-cap lines) the file is compacted immediately.
   */
  function ensureLoaded(channelId: string): ChannelEntry[] {
    const cached = cache.get(channelId);
    if (cached) return cached;

    const parsed: ChannelEntry[] = [];
    let dropped = 0;
    let fileExisted = false;
    try {
      const file = channelFile(channelId);
      if (existsSync(file)) {
        fileExisted = true;
        for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          const entry = parseEntry(line);
          if (entry) parsed.push(entry);
          else dropped += 1;
        }
      }
    } catch (err) {
      logger.warn("channel context load failed", { channelId, error: (err as Error).message });
    }
    if (dropped > 0) {
      logger.warn("dropped malformed channel context lines", {
        channelId,
        dropped,
        kept: parsed.length,
      });
    }

    const window = bounded(parsed);
    cache.set(channelId, window);
    appendsSinceCompact.set(channelId, 0);
    // Compact only when the load actually shed lines — a pure read of a clean (or
    // absent) file must not touch disk.
    if (fileExisted && (dropped > 0 || window.length !== parsed.length)) compact(channelId);
    return window;
  }

  function watermarkPath(): string {
    return join(channelsDir, WATERMARKS_FILE);
  }

  /** Tolerant load: missing/corrupt file or wrong shape degrades to empty. */
  function loadWatermarks(): Record<string, WatermarkRecord> {
    try {
      const file = watermarkPath();
      if (!existsSync(file)) return {};
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        channels?: Record<string, unknown>;
      };
      const channels = parsed?.channels;
      if (!channels || typeof channels !== "object" || Array.isArray(channels)) return {};
      const out: Record<string, WatermarkRecord> = {};
      for (const [id, val] of Object.entries(channels)) {
        if (!val || typeof val !== "object" || Array.isArray(val)) continue;
        const v = val as Record<string, unknown>;
        if (typeof v.lastMessageId === "string" && typeof v.sessionId === "string") {
          out[id] = { lastMessageId: v.lastMessageId, sessionId: v.sessionId };
        }
      }
      return out;
    } catch (err) {
      logger.warn("channel context watermarks unreadable, starting empty", {
        error: (err as Error).message,
      });
      return {};
    }
  }

  function getWatermarks(): Record<string, WatermarkRecord> {
    if (watermarks === null) watermarks = loadWatermarks();
    return watermarks;
  }

  /** Atomic tmp + rename; failure keeps the in-memory watermarks authoritative. */
  function persistWatermarks(): void {
    try {
      mkdirSync(channelsDir, { recursive: true });
      const file = watermarkPath();
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ channels: getWatermarks() }, null, 2) + "\n", "utf8");
      renameSync(tmp, file);
    } catch (err) {
      logger.warn("channel context watermark persist failed", {
        error: (err as Error).message,
      });
    }
  }

  // ── channel meta + profiles (server memory, v4.1) — same tolerant-load/atomic-persist
  // shape as the watermarks: corrupt files degrade to empty, persist failures keep the
  // in-memory copy authoritative.
  let metas: Record<string, ChannelMeta> | null = null;
  let profiles: Record<string, ChannelProfile> | null = null;

  function loadJsonMap<T>(fileName: string, parseVal: (v: Record<string, unknown>) => T | null): Record<string, T> {
    try {
      const file = join(channelsDir, fileName);
      if (!existsSync(file)) return {};
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { channels?: Record<string, unknown> };
      const channels = parsed?.channels;
      if (!channels || typeof channels !== "object" || Array.isArray(channels)) return {};
      const out: Record<string, T> = {};
      for (const [id, val] of Object.entries(channels)) {
        if (!val || typeof val !== "object" || Array.isArray(val)) continue;
        const v = parseVal(val as Record<string, unknown>);
        if (v !== null) out[id] = v;
      }
      return out;
    } catch (err) {
      logger.warn("channel context sidecar unreadable, starting empty", {
        file: fileName,
        error: (err as Error).message,
      });
      return {};
    }
  }

  function persistJsonMap(fileName: string, map: Record<string, unknown>): void {
    try {
      mkdirSync(channelsDir, { recursive: true });
      const file = join(channelsDir, fileName);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ channels: map }, null, 2) + "\n", "utf8");
      renameSync(tmp, file);
    } catch (err) {
      logger.warn("channel context sidecar persist failed", {
        file: fileName,
        error: (err as Error).message,
      });
    }
  }

  function getMetas(): Record<string, ChannelMeta> {
    if (metas === null) {
      metas = loadJsonMap<ChannelMeta>(META_FILE, (v) =>
        (typeof v.name === "string" || v.name === null) && (typeof v.guildId === "string" || v.guildId === null)
          ? { name: v.name, guildId: v.guildId }
          : null,
      );
    }
    return metas;
  }

  function getProfiles(): Record<string, ChannelProfile> {
    if (profiles === null) {
      profiles = loadJsonMap<ChannelProfile>(PROFILES_FILE, (v) =>
        typeof v.summary === "string" &&
        Array.isArray(v.topics) &&
        v.topics.every((t) => typeof t === "string") &&
        typeof v.updatedAt === "number" &&
        Number.isFinite(v.updatedAt) &&
        typeof v.lastMessageId === "string" &&
        typeof v.entryCount === "number"
          ? {
              summary: v.summary,
              topics: v.topics as string[],
              updatedAt: v.updatedAt,
              lastMessageId: v.lastMessageId,
              entryCount: v.entryCount,
            }
          : null,
      );
    }
    return profiles;
  }

  /** Every channel this store knows about: cached, on disk, or named in a sidecar. */
  function knownChannelIds(): Set<string> {
    const known = new Set<string>([...cache.keys(), ...Object.keys(getMetas()), ...Object.keys(getProfiles())]);
    try {
      for (const name of readdirSync(channelsDir)) {
        if (name.endsWith(JSONL_EXT)) known.add(name.slice(0, -JSONL_EXT.length));
      }
    } catch {
      // Missing/unreadable dir — nothing more on disk.
    }
    for (const id of known) if (!CHANNEL_ID_RE.test(id)) known.delete(id);
    return known;
  }

  /** Channels eligible for server-wide features: known guild, matching the requested scope. DMs never. */
  function guildChannelIds(guildId?: string): string[] {
    const ms = getMetas();
    return [...knownChannelIds()].filter((id) => {
      const m = ms[id];
      if (!m || m.guildId === null) return false;
      return guildId === undefined || m.guildId === guildId;
    });
  }

  // ── semantic index lifecycle (issue #73) ───────────────────────────────────────────────

  /** Open (once) the Moss index, hydrating `indexed` from any persisted docs. Latches failure. */
  async function openMoss(): Promise<LocalMoss | null> {
    if (mossFailed) return null;
    if (moss) return moss;
    if (!mossOpening) {
      mossOpening = (async () => {
        try {
          const m = await openChannelMoss(channelsDir, logger);
          for (const d of m.list()) {
            const cid = d.metadata?.channelId;
            const mid = d.metadata?.messageId;
            if (typeof cid === "string" && typeof mid === "string") {
              (indexed.get(cid) ?? indexed.set(cid, new Set()).get(cid)!).add(mid);
            }
          }
          // First contact: reconcile every guild window (initial build / migrate a pre-index
          // store) and every channel already in the persisted index (prune stale/no-longer-guild).
          for (const id of guildChannelIds()) dirty.add(id);
          for (const id of indexed.keys()) dirty.add(id);
          return m;
        } catch (err) {
          logger.warn("channel search: local moss unavailable — using the keyword fallback", {
            error: (err as Error).message,
          });
          mossFailed = true;
          return null;
        }
      })();
    }
    moss = await mossOpening;
    return moss;
  }

  /**
   * Reconcile the dirty channels' index slices against their live guild windows: upsert
   * newly-appended entries (content is immutable per messageId, so an already-indexed id is
   * never re-embedded), delete entries that dropped out of the window (compaction/TTL) and
   * everything belonging to a channel that is not — or no longer — a guild channel. Incremental
   * by construction: an unchanged store reconciles nothing.
   */
  async function reconcileIndex(m: LocalMoss): Promise<void> {
    if (dirty.size === 0) return;
    const targets = [...dirty];
    dirty.clear();
    const ms = getMetas();
    const upserts: MossDocument[] = [];
    const deletes: string[] = [];
    for (const id of targets) {
      if (!CHANNEL_ID_RE.test(id)) continue;
      const meta = ms[id];
      const isGuild = !!meta && meta.guildId !== null;
      const have = indexed.get(id) ?? new Set<string>();
      const want = new Set<string>();
      if (isGuild) {
        for (const e of bounded(ensureLoaded(id))) {
          const doc = channelDocument(id, e);
          if (!doc) continue;
          want.add(e.messageId);
          if (!have.has(e.messageId)) upserts.push(doc);
        }
      }
      for (const mid of have) if (!want.has(mid)) deletes.push(channelDocId(id, mid));
      if (want.size > 0) indexed.set(id, want);
      else indexed.delete(id);
    }
    if (deletes.length > 0) await m.delete(deletes);
    if (upserts.length > 0) await m.upsert(upserts);
    await m.flush();
  }

  /** Drop the in-memory index handle and delete its on-disk cache (a wipe / reset). */
  function dropIndex(): void {
    moss?.dispose();
    moss = null;
    mossOpening = null;
    mossFailed = false;
    indexed.clear();
    dirty.clear();
    try {
      rmSync(channelMossDir(channelsDir), { recursive: true, force: true });
    } catch {
      /* best-effort — the cache rebuilds from the windows on the next ensureIndexed */
    }
  }

  return {
    append(channelId: string, entry: ChannelEntry): void {
      if (!validChannelId(channelId)) return;
      const entries = ensureLoaded(channelId);
      entries.push({ ...entry });
      // Cheap shift keeps the cache at the count cap; TTL waits for read/compaction.
      while (entries.length > maxEntriesPerChannel) entries.shift();
      try {
        mkdirSync(channelsDir, { recursive: true });
        writeFileSync(channelFile(channelId), JSON.stringify(entry) + "\n", {
          flag: "a",
          encoding: "utf8",
        });
      } catch (err) {
        logger.warn("channel context append failed", {
          channelId,
          error: (err as Error).message,
        });
      }
      markIndexDirty(channelId);
      const appends = (appendsSinceCompact.get(channelId) ?? 0) + 1;
      if (appends >= compactEvery) compact(channelId);
      else appendsSinceCompact.set(channelId, appends);
    },

    recent(channelId: string): ChannelEntry[] {
      if (!validChannelId(channelId)) return [];
      return bounded(ensureLoaded(channelId)).map((e) => ({ ...e }));
    },

    takeUnseen(channelId: string, sessionId: string): ChannelEntry[] {
      if (!validChannelId(channelId)) return [];
      const window = bounded(ensureLoaded(channelId)).map((e) => ({ ...e }));
      if (window.length === 0) return [];
      const marks = getWatermarks();
      const mark = marks[channelId];
      let unseen = window;
      // A watermark is live only for the session that set it; a rotation/fresh session
      // gets the full window. A watermark id that aged out of the window also yields
      // everything — better to repeat than to silently drop.
      if (mark && mark.sessionId === sessionId) {
        const idx = window.findIndex((e) => e.messageId === mark.lastMessageId);
        if (idx !== -1) unseen = window.slice(idx + 1);
      }
      return unseen;
    },

    markSeen(channelId: string, sessionId: string, lastMessageId: string): void {
      if (!validChannelId(channelId)) return;
      const marks = getWatermarks();
      const existing = marks[channelId];
      // Monotonic per (channelId, sessionId): a turn that started EARLIER can still resolve
      // and call markSeen LATER than a turn for the same session that started after it (the
      // mid-flow injection wiring commits the injected message's watermark immediately, then
      // the original turn's own stale, pre-injection watermark commits after). Without this
      // guard that later, smaller commit would silently regress the cursor backward and
      // takeUnseen would re-surface a message the session already absorbed. A mark for a
      // DIFFERENT sessionId, or an id that aged out of the window, has no ordering to compare
      // against — treat it as "no prior mark" and accept, matching takeUnseen's own fallback.
      if (existing && existing.sessionId === sessionId) {
        const window = bounded(ensureLoaded(channelId));
        const existingIdx = window.findIndex((e) => e.messageId === existing.lastMessageId);
        const incomingIdx = window.findIndex((e) => e.messageId === lastMessageId);
        if (existingIdx !== -1 && incomingIdx !== -1 && incomingIdx < existingIdx) return;
      }
      marks[channelId] = { lastMessageId, sessionId };
      persistWatermarks();
    },

    noteMeta(channelId: string, meta: ChannelMeta): void {
      if (!validChannelId(channelId)) return;
      // Names are render labels for `#channel` speak — single line, bounded, never trusted.
      const name =
        meta.name === null ? null : meta.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) || null;
      const ms = getMetas();
      const cur = ms[channelId];
      if (cur && cur.name === name && cur.guildId === meta.guildId) return;
      ms[channelId] = { name, guildId: meta.guildId };
      persistJsonMap(META_FILE, ms);
      // A guildId that just appeared/changed flips whether this channel is indexable.
      if (!cur || cur.guildId !== meta.guildId) markIndexDirty(channelId);
    },

    getMeta(channelId: string): ChannelMeta | null {
      if (!validChannelId(channelId)) return null;
      const m = getMetas()[channelId];
      return m ? { ...m } : null;
    },

    listChannels(): ChannelInfo[] {
      const ms = getMetas();
      const ps = getProfiles();
      const out: ChannelInfo[] = [];
      for (const id of knownChannelIds()) {
        const window = bounded(ensureLoaded(id));
        if (window.length === 0) continue;
        const names = new Map<string, string>();
        for (const e of window) if (e.kind === "user") names.set(e.authorId, e.authorName);
        const profile = ps[id];
        out.push({
          channelId: id,
          name: ms[id]?.name ?? null,
          guildId: ms[id]?.guildId ?? null,
          entryCount: window.length,
          lastMessageId: window[window.length - 1]!.messageId,
          lastTs: window[window.length - 1]!.ts,
          participants: [...names.values()].slice(0, PARTICIPANTS_CAP),
          profile: profile ? { ...profile, topics: [...profile.topics] } : null,
        });
      }
      return out.sort((a, b) => b.lastTs - a.lastTs);
    },

    async ensureIndexed(): Promise<void> {
      const m = await openMoss();
      if (!m) return;
      try {
        await reconcileIndex(m);
      } catch (err) {
        logger.warn("channel search: index sync failed — search will use the keyword fallback", {
          error: (err as Error).message,
        });
      }
    },

    search(query: string, opts: ChannelSearchOptions = {}): ChannelSearchHit[] {
      // Keyword terms: distinct, stopwords stripped so "the/is/of" no longer inflate a score.
      const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].filter(
        (t) => !STOP_WORDS.has(t),
      );
      const trimmed = query.trim();
      if (terms.length === 0 && !trimmed) return [];
      const limit = Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT);
      const radius = Math.max(0, opts.contextRadius ?? DEFAULT_CONTEXT_RADIUS);
      const ms = getMetas();
      let ids = guildChannelIds(opts.guildId);
      if (opts.channelId !== undefined) ids = ids.filter((id) => id === opts.channelId);
      const idSet = new Set(ids);

      // Semantic pass (issue #73): when the index is primed (ensureIndexed already awaited) and
      // healthy, retrieve candidates through Moss and score each by calibrated cosine over the
      // offline embeddings, floored to reject hash-collision noise. Failure is caught and the
      // keyword pass carries the search alone — a search never hard-errors. DMs cannot appear:
      // they are never indexed, and every hit is re-gated to `idSet` (guild windows) below.
      const semScores = new Map<string, number>();
      if (!mossFailed && moss && moss.docCount > 0 && trimmed) {
        try {
          const qEmb = embedLocal(trimmed);
          const topK = Math.min(moss.docCount, SEM_TOPK_CAP);
          for (const hit of moss.query(trimmed, undefined, { topK, semanticWeight: RANKING_SEMANTIC_WEIGHT }).docs) {
            const cid = hit.metadata?.channelId;
            const mid = hit.metadata?.messageId;
            if (typeof cid !== "string" || typeof mid !== "string" || !idSet.has(cid)) continue;
            const rel = cosineSim(qEmb, embedLocal(hit.text));
            if (rel >= SEM_FLOOR) semScores.set(channelDocId(cid, mid), rel);
          }
        } catch (err) {
          logger.warn("channel search: semantic scoring failed — keyword only", {
            error: (err as Error).message,
          });
          semScores.clear();
        }
      }

      // Blended score = distinct keyword terms matched (a crude trailing-s stem catches
      // movie/movies) + the semantic relevance of a passing hit, then recency. Windows are
      // hard-capped per channel, so a full scan stays cheap.
      const raw: Array<{ channelId: string; index: number; window: ChannelEntry[]; score: number }> = [];
      for (const id of ids) {
        const window = bounded(ensureLoaded(id));
        for (let i = 0; i < window.length; i++) {
          const hay = channelEntryText(window[i]!).toLowerCase();
          let score = 0;
          for (const t of terms) {
            const stem = t.replace(/s$/, "");
            if (hay.includes(t) || (stem.length >= 3 && hay.includes(stem))) score += 1;
          }
          const sem = semScores.get(channelDocId(id, window[i]!.messageId));
          if (sem !== undefined) score += SEM_WEIGHT * sem;
          if (score > 0) raw.push({ channelId: id, index: i, window, score });
        }
      }
      raw.sort((a, b) => b.score - a.score || b.window[b.index]!.ts - a.window[a.index]!.ts);

      const hits: ChannelSearchHit[] = [];
      const accepted = new Map<string, number[]>();
      for (const r of raw) {
        if (hits.length >= limit) break;
        // A hit inside an accepted hit's context radius adds no new conversation — skip it.
        const near = accepted.get(r.channelId) ?? [];
        if (near.some((j) => Math.abs(j - r.index) <= radius)) continue;
        near.push(r.index);
        accepted.set(r.channelId, near);
        const lo = Math.max(0, r.index - radius);
        const hi = Math.min(r.window.length, r.index + radius + 1);
        hits.push({
          channelId: r.channelId,
          channelName: ms[r.channelId]?.name ?? null,
          entry: { ...r.window[r.index]! },
          context: r.window.slice(lo, hi).map((e) => ({ ...e })),
          score: r.score,
        });
      }
      return hits;
    },

    getProfile(channelId: string): ChannelProfile | null {
      if (!validChannelId(channelId)) return null;
      const p = getProfiles()[channelId];
      return p ? { ...p, topics: [...p.topics] } : null;
    },

    setProfile(channelId: string, profile: Omit<ChannelProfile, "updatedAt">): void {
      if (!validChannelId(channelId)) return;
      const ps = getProfiles();
      ps[channelId] = { ...profile, topics: [...profile.topics], updatedAt: now() };
      persistJsonMap(PROFILES_FILE, ps);
    },

    wipe(channelId?: string): string[] {
      const marks = getWatermarks();
      const ms = getMetas();
      const ps = getProfiles();
      let targets: string[];
      if (channelId !== undefined) {
        if (!validChannelId(channelId)) return [];
        targets = [channelId];
      } else {
        // Sweep everything we know about: files on disk plus any cache/sidecar entries
        // whose files never made it to disk.
        const known = knownChannelIds();
        for (const id of Object.keys(marks)) if (CHANNEL_ID_RE.test(id)) known.add(id);
        targets = [...known];
      }

      const wiped: string[] = [];
      let marksChanged = false;
      let metasChanged = false;
      let profilesChanged = false;
      for (const id of targets) {
        let removed = false;
        try {
          const file = channelFile(id);
          if (existsSync(file)) {
            rmSync(file);
            removed = true;
          }
          // A crash mid-compaction may have stranded a tmp — a wipe must not leave message
          // content behind in it (this is the privacy path).
          rmSync(`${file}.tmp`, { force: true });
        } catch (err) {
          logger.warn("channel context wipe failed", { channelId: id, error: (err as Error).message });
        }
        // An empty cache entry is just a lazy-load artifact, not stored state.
        const cached = cache.get(id);
        if (cache.delete(id) && cached !== undefined && cached.length > 0) removed = true;
        appendsSinceCompact.delete(id);
        if (marks[id]) {
          delete marks[id];
          marksChanged = true;
          removed = true;
        }
        if (ms[id]) {
          delete ms[id];
          metasChanged = true;
          removed = true;
        }
        // The profile is derived FROM message content — wiping the messages must take the
        // summary of them along (this is still the privacy path).
        if (ps[id]) {
          delete ps[id];
          profilesChanged = true;
          removed = true;
        }
        if (removed) wiped.push(id);
      }
      if (marksChanged) persistWatermarks();
      if (metasChanged) persistJsonMap(META_FILE, ms);
      if (profilesChanged) persistJsonMap(PROFILES_FILE, ps);
      // The index is derived from message content — a wipe (the privacy path) must take it
      // along, at rest too. Drop the whole cache; it rebuilds from surviving windows on the
      // next ensureIndexed. dispose() first so an orphaned persist timer can't rewrite the
      // files we just deleted.
      dropIndex();
      return wiped;
    },
  };
}

/**
 * Render one entry as an attributed transcript line, matching the Concierge's in-turn frame
 * format exactly: ids on user lines so attribution is mechanical, bare `beckett` sentinel for
 * our own posts, and multi-line bodies nested 4 deep so content can never forge frame structure
 * (a fake stamp or SYSTEM header at column 0). `withDate` adds the day for cross-channel
 * recall/search output, where a bare "14:03" could be days old.
 */
export function renderEntryLine(e: ChannelEntry, opts?: { withDate?: boolean }): string {
  const iso = new Date(e.ts).toISOString();
  const stamp = opts?.withDate ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16);
  const who = e.kind === "beckett" ? "beckett" : `${e.authorName} (user:${e.authorId})`;
  return `  [${stamp}] ${who}: ${e.content.replace(/\r?\n/g, "\n    ")}`;
}
