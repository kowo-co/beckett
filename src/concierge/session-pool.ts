/**
 * SessionPool — per-channel concierge sessions (OPS-80 §9.3, the deferred "per-scope sessions").
 *
 * v4.0 ran ONE `claude -p` session for the entire Discord surface, so every turn — every user,
 * every channel, every DM — serialized through a single pump: while Beckett thought about one
 * request, everyone else waited in line behind a fast-ack. The pool removes that bottleneck by
 * keying sessions to a SCOPE (the Discord channel — a DM is its own channel), so conversations in
 * different channels run truly concurrently, bounded by a shared {@link TurnGate}.
 *
 * This also hard-partitions the model transcript the way the shared-context store already
 * partitions injection: a DM's session never hosts guild turns at all, closing the model-side
 * DM↔guild bleed that doctrine alone used to hold (multiplayer design doc §6.1 honest residual).
 *
 * Cross-channel continuity is deliberately NOT the transcript's job anymore: the knowledge graph
 * (global), the per-channel context store, and the cross-channel awareness footer carry it — the
 * same seams a rotation has always relied on.
 *
 * Process economics: each session is one `claude` child. The pool bounds LIVE children
 * (`max_live_sessions`) by recycling the least-recently-used IDLE session's child — its transcript
 * survives (`--resume` on the next turn), exactly the existing timeout-recycle semantics. An idle
 * timer applies the same treatment to sessions quiet for `idle_recycle_minutes`.
 *
 * Tests can pin a single fixed session (the legacy injection surface) — every scope then resolves
 * to it and the pool degrades to v4.0 behavior, keeping the existing test fleet meaningful.
 */
import type { Logger } from "../types.ts";
import { log as rootLog } from "../log.ts";
import type { TurnMessage } from "./index.ts";
import { coerceDiscordTurnOutput, type DiscordTurnOutput } from "./output.ts";

/** The slice of ConciergeSession the pool routes through (structural — no runtime import cycle). */
export interface PoolSession {
  start?(): Promise<void>;
  stop(): Promise<void>;
  /** String is legacy support for injected test doubles; real sessions return DiscordTurnOutput. */
  ask(message: TurnMessage, meta?: unknown, opts?: { priority?: boolean }): Promise<DiscordTurnOutput | string>;
  requestReload?(): void;
  /** Perform a due context rotation only if this scope is quiet; true when it rotated. */
  rotateWhileIdle?(): Promise<boolean>;
  queueDepth?(): number;
  currentSessionId?(): string;
  getCurrentMeta?(): unknown;
  stats?(): Record<string, unknown>;
  /** Kill the child process, keep the session (`--resume` on the next turn). */
  recycle?(reason: string): void;
  /** Cancel the turn generating right now (issue #117); false when nothing is live. */
  cancelLiveTurn?(reason: string): boolean;
  /** Whether the live turn has already invoked a tool (it's doing work, not composing). */
  liveTurnToolUse?(): boolean;
  /** Hand a message to the turn generating right now, without cancelling it (see injectLiveTurn). */
  injectIntoLiveTurn?(text: string, messageId?: string): "injected" | "no-live-turn" | "capped";
  /** Drop queued (not-yet-started) turns the predicate matches; count dropped (queue-free UX). */
  supersedeQueuedTurns?(match: (meta: unknown) => boolean, onSuperseded?: (meta: unknown) => void): number;
  /** Start a recycled child's relaunch without a turn (issue #153); no-op when live/stopped. */
  prewarm?(): void;
  hasLiveChild?(): boolean;
  /** Per-process issuer credential exported into the child env (bus-op correlation, §9.3). */
  busToken?(): string;
}

export interface SessionPoolOptions {
  /** "channel" = one session per channel id; "global" = every scope resolves to one session. */
  scope: "channel" | "global";
  /** Live `claude` children allowed before LRU idle recycling kicks in. */
  maxLiveSessions: number;
  /** Recycle a session's child after this much idle time (0/negative disables the timer). */
  idleRecycleMs: number;
  /**
   * Called when an idle, child-less entry is evicted from the pool (its per-scope state persists
   * on disk, so the scope resumes on its next turn). Lets the owner drop per-scope caches — e.g.
   * the Concierge's awareness-suppression map — so neither side grows without bound.
   */
  onEvict?: (scopeKey: string) => void;
  /** Build a real session for a scope key. Unused when {@link fixedSession} is set. */
  makeSession: (scopeKey: string) => PoolSession;
  /**
   * Pin every scope to ONE session (test injection / legacy single-session mode). The pool never
   * starts, stops-all still stops it once, and scope keys collapse to {@link GLOBAL_SCOPE}.
   */
  fixedSession?: PoolSession;
  logger?: Logger;
}

export const GLOBAL_SCOPE = "global";

interface PoolEntry {
  session: PoolSession;
  /** start() in flight or settled — every ask awaits it so a turn can't race the launch. */
  ready: Promise<void>;
  /** Set once ready resolved — lets ask() skip the await (and stay synchronous up to session.ask). */
  started: boolean;
  lastUsedAt: number;
}

export class SessionPool {
  private readonly opts: SessionPoolOptions;
  private readonly log: Logger;
  private readonly entries = new Map<string, PoolEntry>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleSweeping = false;
  private stopped = false;
  /** Legacy parity: a fixed session is started exactly once, by warm() (i.e. Concierge.start()). */
  private fixedStarted = false;

  constructor(opts: SessionPoolOptions) {
    this.opts = opts;
    this.log = (opts.logger ?? rootLog).child("concierge.pool");
    if (opts.fixedSession) {
      // Pre-seeded as started: legacy fakes expect ask() to reach session.ask synchronously, and
      // the real single-session mode never gated asks on start() either (ask() self-relaunches).
      this.entries.set(GLOBAL_SCOPE, {
        session: opts.fixedSession,
        ready: Promise.resolve(),
        started: true,
        lastUsedAt: Date.now(),
      });
    }
  }

  /** Channel id → scope key. Fixed-session and global modes collapse everything to one scope. */
  scopeKey(channelId: string): string {
    if (this.opts.fixedSession || this.opts.scope === "global") return GLOBAL_SCOPE;
    return channelId.trim() || GLOBAL_SCOPE;
  }

  /**
   * The session for a channel, created (and started) on first use. Synchronous by design — the
   * queue-depth fast-ack check needs it without awaiting; {@link ask} awaits readiness itself.
   */
  sessionFor(channelId: string): PoolSession {
    return this.entryFor(channelId).session;
  }

  private entryFor(channelId: string): PoolEntry {
    const key = this.scopeKey(channelId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.stopped) throw new Error("concierge session pool is stopped");
    const session = this.opts.makeSession(key);
    const entry: PoolEntry = {
      session,
      ready: Promise.resolve(),
      started: false,
      lastUsedAt: Date.now(),
    };
    entry.ready = (session.start?.() ?? Promise.resolve()).then(
      () => {
        entry.started = true;
      },
      (err) => {
        // A failed launch must not poison the scope forever — drop the entry so the next turn
        // retries a fresh start, and surface the failure to the awaiting ask().
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw err instanceof Error ? err : new Error(String(err));
      },
    );
    // Mark the rejection handled: the synchronous sessionFor() path (the fast-ack queue-depth
    // check) may never await `ready` — a failed launch must surface to the next ask(), not as an
    // unhandled rejection that can take down the daemon.
    entry.ready.catch(() => undefined);
    this.entries.set(key, entry);
    this.enforceLiveCap(key);
    this.armIdleTimer();
    return entry;
  }

  /**
   * Kick a channel's EXISTING session into relaunching its recycled child ahead of the turn
   * (issue #153). Deliberately does NOT create an entry: entryFor() starts a session child and
   * live-cap-recycles other sessions' children as side effects — too heavy for a speculative
   * signal. A brand-new scope pays its first spawn inside ask() exactly as before; a scope
   * whose start() is still in flight is skipped (its launch IS the warm-up).
   */
  prewarm(channelId: string): void {
    if (this.stopped) return;
    const entry = this.entries.get(this.scopeKey(channelId));
    if (!entry || !entry.started) return;
    // The idle sweep must not reap the child we just asked for before the turn lands.
    entry.lastUsedAt = Date.now();
    entry.session.prewarm?.();
  }

  /** Ensure a scope's session is up NOW (boot fail-fast for the dedicated system scope). */
  async warm(channelId: string): Promise<void> {
    const entry = this.entryFor(channelId);
    if (this.opts.fixedSession && !this.fixedStarted) {
      // Legacy parity: Concierge.start() used to be the one start() call on the injected session.
      this.fixedStarted = true;
      await this.opts.fixedSession.start?.();
      return;
    }
    await entry.ready;
  }

  /** Run one turn on the channel's session (creates/starts/resumes it as needed). */
  async ask(
    channelId: string,
    message: TurnMessage,
    meta?: unknown,
    opts?: { priority?: boolean },
  ): Promise<DiscordTurnOutput> {
    const entry = this.entryFor(channelId);
    // Synchronous up to session.ask() when the session is already up — queue admission (and the
    // priority jump) must not lose a race to an intervening microtask.
    if (!entry.started) await entry.ready;
    entry.lastUsedAt = Date.now();
    try {
      // Real ConciergeSessions return this discriminated value after validating Claude's
      // structured_output. Coercion only keeps pre-existing untyped injected test doubles usable;
      // assistant text from a real model never reaches this boundary.
      return coerceDiscordTurnOutput(await entry.session.ask(message, meta, opts));
    } finally {
      entry.lastUsedAt = Date.now();
    }
  }

  /**
   * Metas of turns EXECUTING right now, across every session (reply-claim correlation under
   * concurrency). Empty when nothing runs. `tracksMeta()` distinguishes "no live turn" from
   * "injected fake session that doesn't track meta at all" (the legacy test surface).
   */
  currentMetas(): unknown[] {
    const metas: unknown[] = [];
    for (const { session } of this.entries.values()) {
      const meta = session.getCurrentMeta?.();
      if (meta) metas.push(meta);
    }
    return metas;
  }

  /** True iff every session exposes meta tracking (real sessions do; fake test doubles may not). */
  tracksMeta(): boolean {
    for (const { session } of this.entries.values()) {
      if (typeof session.getCurrentMeta !== "function") return false;
    }
    return true;
  }

  /**
   * Exact bus-op correlation (OPS-80 §9.3): resolve an issuer token — the secret a session exports
   * into its child's env — to the meta of the turn EXECUTING on that session right now. Returns
   * null for an unknown/stale token or a token whose session is between turns: the caller must
   * deny rather than fall back to guessing by channel.
   */
  metaForToken(token: string): unknown {
    if (!token) return null;
    for (const { session } of this.entries.values()) {
      if (session.busToken?.() === token) return session.getCurrentMeta?.() ?? null;
    }
    return null;
  }

  /**
   * Cancel the turn generating on a channel's session (issue #117 — in-flight interrupt). Returns
   * false when nothing is live, OR when the live turn belongs to a DIFFERENT channel — which only
   * happens in the collapsed global/fixed-session mode where one session hosts every channel; a
   * channel-scoped session (production) always matches. A system/update turn (no channel meta) is
   * never cancelled: only a directed turn for THIS channel is superseded by an amending message.
   *
   * `opts.byUserId` narrows WHO may supersede a directed turn (the multitasking fix); `opts.amends`
   * narrows WHICH messages may (issue #138). With `byUserId` set, a directed (non-ambient) turn is
   * cancelled only when ALL hold:
   *   - the live turn belongs to the same author (someone else's turn is never their amendment);
   *   - the live turn has not yet invoked a tool — once it's dispatching/recalling/editing,
   *     killing it loses real work, so the new message queues as a priority turn instead and is
   *     answered right after, with the finished work in context;
   *   - the new message plausibly AMENDS the ask (`amends` not explicitly false). A same-author
   *     interjection that restates nothing — banter, a reaction-in-words — must not kill a live
   *     answer; it falls through to the caller's inject/queue path instead. The caller supplies
   *     the deterministic amend signal (see messagePlausiblyAmends); the pool only honours it.
   * An AMBIENT turn is always cancellable by a directed message, banter or not (a person outranks
   * an interjection the model was still composing). Without `opts`, legacy unconditional behavior.
   */
  cancelLiveTurn(channelId: string, reason: string, opts?: { byUserId?: string; amends?: boolean }): boolean {
    const entry = this.entries.get(this.scopeKey(channelId));
    if (!entry) return false;
    const meta = entry.session.getCurrentMeta?.() as
      | { channelId?: string; userId?: string; ambient?: boolean }
      | null
      | undefined;
    if (!meta || meta.channelId !== channelId) return false;
    if (opts?.byUserId !== undefined && !meta.ambient) {
      if (meta.userId !== opts.byUserId) return false;
      if (entry.session.liveTurnToolUse?.() === true) return false;
      if (opts.amends === false) return false;
    }
    return entry.session.cancelLiveTurn?.(reason) ?? false;
  }

  /**
   * Fold a message into the turn generating on a channel's session right now, instead of
   * cancelling it or queueing it (the third path beside {@link cancelLiveTurn} and plain
   * queueing — see ConciergeSession.injectIntoLiveTurn for why this exists at all).
   *
   * Deliberately the SAME eligibility gate as {@link cancelLiveTurn}'s `byUserId` branch, not a
   * new one: `"no-live-turn"` when nothing is live for this channel (or, in collapsed
   * global/fixed-session mode, the live turn belongs to a different channel); `"not-eligible"`
   * when the live turn is ambient (no directed author to fold into) or belongs to a DIFFERENT
   * author than `opts.byUserId` — someone else's in-flight turn is not this person's to steer,
   * the same cross-author hazard #117's guard exists to prevent. Unlike cancelLiveTurn there is
   * no tool-use branch to check: injection is the tool-use case (that's the whole point), so
   * eligibility never depends on whether a tool has already run.
   *
   * `opts.messageId` rides along so the session can track WHICH message it swallowed — an injection
   * that races the live turn's own `result` is answered by nobody unless something remembers it
   * (ConciergeSession.injectIntoLiveTurn).
   */
  injectLiveTurn(
    channelId: string,
    text: string,
    opts: { byUserId: string; messageId?: string },
  ): "injected" | "no-live-turn" | "not-eligible" | "capped" {
    const entry = this.entries.get(this.scopeKey(channelId));
    if (!entry) return "no-live-turn";
    const meta = entry.session.getCurrentMeta?.() as
      | { channelId?: string; userId?: string; ambient?: boolean }
      | null
      | undefined;
    if (!meta || meta.channelId !== channelId) return "no-live-turn";
    if (meta.ambient || meta.userId !== opts.byUserId) return "not-eligible";
    return entry.session.injectIntoLiveTurn?.(text, opts.messageId) ?? "no-live-turn";
  }

  /**
   * Drop queued same-channel turns the predicate matches (see ConciergeSession.supersedeQueuedTurns).
   * Channel-scoped like {@link cancelLiveTurn}: in collapsed global/fixed-session mode the
   * predicate's own meta checks keep other channels' turns untouched. Returns the count dropped.
   * `onSuperseded` receives each dropped turn's meta, oldest first, so the caller can carry its
   * text into the surviving turn rather than losing it.
   */
  supersedeQueuedTurns(
    channelId: string,
    match: (meta: unknown) => boolean,
    onSuperseded?: (meta: unknown) => void,
  ): number {
    const entry = this.entries.get(this.scopeKey(channelId));
    if (!entry) return 0;
    return entry.session.supersedeQueuedTurns?.(match, onSuperseded) ?? 0;
  }

  /** The live sessionId for a channel's scope (watermarks + awareness suppression are keyed to it). */
  sessionIdFor(channelId: string): string {
    return this.sessionFor(channelId).currentSessionId?.() ?? "";
  }

  /** Persona/doctrine reload for every live session (each re-grounds at its own turn boundary). */
  requestReloadAll(): void {
    for (const { session } of this.entries.values()) session.requestReload?.();
  }

  /** Per-scope session health + pool shape, for `beckett status`. */
  stats(): Record<string, unknown> {
    const sessions: Record<string, unknown> = {};
    let liveChildren = 0;
    for (const [key, { session }] of this.entries) {
      sessions[key] = session.stats?.() ?? {};
      if (session.hasLiveChild?.()) liveChildren += 1;
    }
    return {
      scope: this.opts.fixedSession ? "global" : this.opts.scope,
      sessions: this.entries.size,
      liveChildren,
      maxLiveSessions: this.opts.maxLiveSessions,
      perSession: sessions,
    };
  }

  /** Stop every session and refuse further creation (daemon shutdown). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    const sessions = [...this.entries.values()].map((e) => e.session);
    this.entries.clear();
    await Promise.all(
      sessions.map((s) =>
        s.stop().catch((err) => this.log.warn("session stop failed", { err: String(err) })),
      ),
    );
  }

  // ── child-process economics ────────────────────────────────────────────────────────────────

  /** Over the live-children cap? Recycle LRU idle sessions' children (never the busy, never `keep`). */
  private enforceLiveCap(keep: string): void {
    const live = [...this.entries.entries()].filter(([, e]) => e.session.hasLiveChild?.() === true);
    // The `keep` scope was just created and is ABOUT to spawn a child — count it now, or the pool
    // would run one child over the cap until the next creation.
    const pending = live.some(([key]) => key === keep) ? 0 : 1;
    let excess = live.length + pending - Math.max(1, this.opts.maxLiveSessions);
    if (excess <= 0) return;
    const victims = live
      .filter(([key, e]) => key !== keep && (e.session.queueDepth?.() ?? 0) === 0)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, entry] of victims) {
      if (excess <= 0) break;
      entry.session.recycle?.("session pool live-child cap");
      this.log.info("recycled idle concierge session child (live cap)", { scope: key });
      excess -= 1;
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer || this.stopped) return;
    const idleMs = this.opts.idleRecycleMs;
    if (!(idleMs > 0)) return;
    const tick = Math.max(30_000, Math.min(idleMs, 5 * 60_000));
    this.idleTimer = setInterval(() => void this.idleSweep(Date.now()), tick);
    // Never keep the process alive just for housekeeping (bun timers support unref).
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** One idle-housekeeping pass: proactively rotate, then recycle long-idle children/entries. */
  private idleSweep(now: number): void {
    if (this.idleSweeping) return;
    const idleMs = this.opts.idleRecycleMs;
    for (const [key, entry] of this.entries) {
      if ((entry.session.queueDepth?.() ?? 0) > 0) continue;
      if (now - entry.lastUsedAt < idleMs) continue;
      const rotate = entry.session.rotateWhileIdle;
      if (rotate) {
        // Keep the timer synchronous for legacy/fake sessions while a real rotation runs in the
        // background. The session's own idle mutex handles a turn racing this promise.
        this.idleSweeping = true;
        void rotate.call(entry.session).then(
          (rotated) => {
            this.idleSweeping = false;
            if (this.entries.get(key) !== entry || (entry.session.queueDepth?.() ?? 0) > 0) return;
            if (rotated) {
              entry.lastUsedAt = now;
              this.log.info("rotated idle concierge session", { scope: key });
            } else {
              this.reapIdleEntry(key, entry);
            }
          },
          (err) => {
            this.idleSweeping = false;
            this.log.warn("idle concierge rotation failed", { scope: key, err: String(err) });
            this.reapIdleEntry(key, entry);
          },
        );
        // Serialize maintenance rotations: these are deliberately outside TurnGate, so don't
        // fan out a whole pool of one-shot handoffs at one timer tick.
        return;
      }
      this.reapIdleEntry(key, entry);
    }
  }

  private reapIdleEntry(key: string, entry: PoolEntry): void {
    if (entry.session.hasLiveChild?.() === true) {
      entry.session.recycle?.("idle session recycle");
      this.log.info("recycled idle concierge session child (idle timer)", { scope: key });
    } else {
      // Long-idle and child-less: drop the entry entirely so the pool (and the owner's
      // per-scope caches) can't grow one entry per channel forever. The scope's session state
      // is on disk — its next turn recreates the entry and resumes the same conversation.
      this.entries.delete(key);
      this.opts.onEvict?.(key);
      void entry.session
        .stop()
        .catch((err) => this.log.warn("evicted session stop failed", { err: String(err) }));
      this.log.info("evicted idle concierge session entry", { scope: key });
    }
  }
}

export function createSessionPool(opts: SessionPoolOptions): SessionPool {
  return new SessionPool(opts);
}
