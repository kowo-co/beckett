/**
 * Beckett — GitHub PR poller (`src/github/poll.ts`)
 * =======================================================================================
 * OPS-124 — watches the PRs Beckett opened on the kowo-co org and turns "what changed on my
 * PR" into a stream of material {@link PrPollEvent}s the Concierge relays in voice ("ro left 2
 * comments on #96", "CI failed on the memory branch", "#96 merged"). It mirrors the tracker poller
 * an in-memory snapshot per PR, diffed against a fresh read each tick, with
 * the diff persisted so a daemon restart never re-fires an old notification (the "notify re-fire
 * loop" hazard).
 *
 * WHAT IT WATCHES. The poller is registry-driven: {@link GitHubPrPoller.watch} is called by every
 * path that opens a PR — the dispatcher when a worker publishes one, and `beckett gh pr create`
 * (over the control bus) when one is opened by hand from the concierge seat — stamping the
 * originating channel onto the entry where one is knowable. It watches any PR *we opened*, wherever
 * it lives: a cross-fork PR into a third-party upstream is watched exactly like one on our own org
 * (#31 — the v1 "our-org-only" gate silently left every cross-org PR with no watcher at all). A PR
 * that was never registered is never polled, which is why an unknown PR produces nothing: there's
 * simply no entry for it. A watched repo that goes private or is deleted under us (a read that hard-
 * 404s/410s/403s for several ticks RUNNING) is dropped once, so it never becomes a poll that fails
 * forever every tick — while a transient failure (5xx, timeout, rate-limit, abuse block) is a no-op
 * that leaves the watch untouched, so one bad response never wipes the registry.
 *
 * WHAT COUNTS AS MATERIAL. New reviews (approval / changes-requested / plain review comment), new
 * conversation comments, a CI conclusion (failures loudest), a merge, or a close. Explicitly NOT
 * material: Beckett's own pushes (a head-sha move re-arms CI but emits nothing), draft churn (while
 * a PR is a draft its review/comment/CI signals are tracked-but-suppressed), and Beckett's own
 * reviews/comments (filtered by author login).
 *
 * READ-ONLY (v1). This module observes and relays. It never replies to a review and never merges —
 * merges stay a human handshake.
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions, ESM.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log.ts";
import type { Logger } from "../types.ts";
import {
  type CheckConclusion,
  type GitHubPrReader,
  type PrLifecycle,
  type PrPollEvent,
  type PrRef,
  type PrSignals,
  prKey,
} from "./types.ts";

/**
 * One watched PR's persisted state: the routing (from {@link GitHubPrPoller.watch}) plus the last
 * observed signal snapshot that the next tick diffs against. Serialized verbatim to `statePath`.
 */
interface PrState {
  // ── routing (stamped at watch time) ──
  repo: string;
  number: number;
  url: string;
  title: string;
  /** The run this PR carries (`run-20260810-oauth`), when it came from one. */
  runId?: string;
  channel?: string;
  addedAt: string;
  // ── snapshot (updated every successful read) ──
  /** False until the first read baselines this PR — the baseline read emits NOTHING (issue #33
   *  parity: seed the cursor at "now" so we never replay a PR's pre-existing history). */
  seeded: boolean;
  state: PrLifecycle;
  isDraft: boolean;
  headRefOid: string;
  /** Last CI conclusion we surfaced FOR `headRefOid` — reset to NONE when the head sha moves. */
  ciConclusion: CheckConclusion;
  seenReviewIds: string[];
  seenCommentIds: string[];
  /** Merged/closed already emitted → the entry is pruned on the next tick, never re-fired. */
  terminal: boolean;
  /** Count of CONSECUTIVE hard read failures (repo gone/forbidden). Reset to 0 on any successful
   *  read; the watch is dropped only once this reaches {@link HARD_FAILURES_BEFORE_DROP}, so a
   *  single bad response can never wipe it. A transient failure leaves this untouched. */
  hardFailures: number;
}

/** The registration payload every PR-open path hands {@link GitHubPrPoller.watch}. */
export interface WatchRequest {
  repo: string;
  number: number;
  url: string;
  title: string;
  /** The run this PR carries, when it came from one. */
  runId?: string;
  channel?: string;
  /**
   * The PR author's login, when the caller knows it. It exists only for the defensive check in
   * {@link GitHubPrPoller.watch}: a registration is only ever issued for a PR we just opened, so an
   * absent author means "the open path vouches this is ours". A stamped author that is NOT us is the
   * one thing we refuse — a PR we did not author has no business being watched here.
   */
  author?: string;
}

export interface GitHubPrPollerDeps {
  reader: GitHubPrReader;
  /** Our GitHub login: the defensive author check in {@link GitHubPrPoller.watch} and the filter
   *  that suppresses Beckett's own reviews/comments both compare against it. */
  account: string;
  logger?: Logger;
  /** Self-schedule interval for {@link GitHubPrPoller.start} (seconds). Defaults to 60. */
  pollSecs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Durable transition-state + watch-registry path. Restart-safe when set. */
  statePath?: string;
}

/** The sink handed to {@link GitHubPrPoller.start}. */
export type PrEventSink = (events: PrPollEvent[]) => void | Promise<void>;

/** Review verdicts that are worth a ping (a plain "COMMENTED" review is a review comment). */
const MATERIAL_REVIEW = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);

/** One PR's per-tick read outcome: a live read, a HARD failure (repo genuinely gone), or a
 *  transient skip (leave the watch untouched and retry next tick). A hard failure is not itself a
 *  drop — {@link GitHubPrPoller.poll} only drops after {@link HARD_FAILURES_BEFORE_DROP} of them in
 *  a row, so a one-off bad response can never wipe a watch. */
type ReadResult =
  | { kind: "read"; entry: PrState; signals: PrSignals }
  | { kind: "hard-fail"; entry: PrState }
  | null;

/** How many CONSECUTIVE hard failures a PR must rack up before we drop its watch. One bad response
 *  must never be enough — a hard-looking blip that is actually transient (a momentary edge 404, a
 *  mislabelled 5xx) has to persist across this many ticks before we conclude the repo is truly
 *  gone. Any successful read resets the counter to zero. */
const HARD_FAILURES_BEFORE_DROP = 3;

/**
 * Classify a failed read. `"hard"` means the repo is genuinely gone or genuinely off-limits — a
 * 404/410, or a 403 that is a real "no access to this repo" — the only class that can (eventually)
 * drop a watch. EVERYTHING ELSE is `"transient"`: a 5xx, a network error/timeout, a primary OR
 * secondary rate-limit, an abuse-detection block, or any message we don't recognize. A transient
 * failure is a no-op — the snapshot is left exactly as it was so the PR retries next tick.
 *
 * The reader wraps `gh`'s stderr, so we match on the signatures GitHub emits. Transient is checked
 * FIRST and wins every tie: we would far rather retry a genuinely-dead repo a few extra times than
 * silently wipe a live watch on a maybe. Nothing unrecognized is ever treated as hard.
 */
function classifyReadFailure(message: string): "hard" | "transient" {
  const m = message.toLowerCase();
  // Transient takes priority. A secondary rate-limit / abuse block surfaces as a 403, so these must
  // be matched BEFORE the 403 → hard rule below, or we'd mistake throttling for a gone repo.
  if (
    m.includes("rate limit") ||
    m.includes("secondary rate") ||
    m.includes("abuse") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("network") ||
    m.includes("socket hang up") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("enotfound") ||
    m.includes("eai_again") ||
    m.includes("service unavailable") ||
    m.includes("bad gateway") ||
    m.includes("gateway timeout") ||
    /\b5\d\d\b/.test(m) // any 5xx
  ) {
    return "transient";
  }
  // Hard: the repo resolves to nothing, or we genuinely cannot see it (404 / 410 / a real 403).
  if (
    m.includes("could not resolve to a repository") ||
    m.includes("not found") ||
    m.includes("resource not accessible") ||
    m.includes("must have push access") ||
    /\b40[34]\b/.test(m) || // 403 forbidden / 404 not found
    /\b410\b/.test(m) // 410 gone
  ) {
    return "hard";
  }
  // Unrecognized → transient. We never drop a watch on a message we can't positively classify.
  return "transient";
}

export class GitHubPrPoller {
  private readonly reader: GitHubPrReader;
  private readonly account: string;
  private readonly logger: Logger;
  private readonly pollSecs: number;
  private readonly now: () => number;
  private readonly statePath?: string;

  private readonly entries = new Map<string, PrState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private sink: PrEventSink | null = null;
  private pokePending = false;

  private lastPollAt: number | null = null;
  private consecutiveFailures = 0;

  constructor(deps: GitHubPrPollerDeps) {
    this.reader = deps.reader;
    this.account = deps.account;
    this.logger = deps.logger ?? log.child("github.poll");
    this.pollSecs = deps.pollSecs ?? 60;
    this.now = deps.now ?? Date.now;
    this.statePath = deps.statePath;
    this.load();
  }

  // ── registration ─────────────────────────────────────────────────────────────────────────

  /**
   * Start watching a PR we just opened. Idempotent: re-watching a known PR only refreshes its
   * routing (channel/title), never its snapshot, so a re-open can't replay history. Persists
   * immediately so the registration survives a restart.
   *
   * There is NO org gate here (#31): the old "repo owner == our account" check dropped exactly the
   * cross-fork PRs into third-party upstreams that most need watching — a PR I open on someone
   * else's repo, closed and reimplemented upstream with nobody watching. Registration is only ever
   * issued for a PR we opened, and reading a third-party PR is fine with the classic PAT we already
   * use for cross-fork PRs. The one remaining guard is a genuine safety condition, not a scope
   * limit: if the caller stamped an author and it is demonstrably NOT us, this is someone else's PR
   * we were handed by mistake — refuse it. An absent author is the vouched-ours common case.
   */
  watch(req: WatchRequest): void {
    if (req.author && req.author.toLowerCase() !== this.account.toLowerCase()) {
      this.logger.debug("not watching PR we did not author", {
        repo: req.repo,
        number: req.number,
        author: req.author,
      });
      return;
    }
    const key = prKey(req.repo, req.number);
    const existing = this.entries.get(key);
    if (existing) {
      // Refresh routing only — a channel may have been unknown at first open, or the title edited.
      existing.url = req.url || existing.url;
      existing.title = req.title || existing.title;
      if (req.runId) existing.runId = req.runId;
      if (req.channel) existing.channel = req.channel;
      this.persist();
      return;
    }
    this.entries.set(key, {
      repo: req.repo,
      number: req.number,
      url: req.url,
      title: req.title,
      runId: req.runId,
      channel: req.channel,
      addedAt: new Date(this.now()).toISOString(),
      seeded: false,
      state: "OPEN",
      isDraft: false,
      headRefOid: "",
      ciConclusion: "NONE",
      seenReviewIds: [],
      seenCommentIds: [],
      terminal: false,
      hardFailures: 0,
    });
    this.logger.info("watching PR", { repo: req.repo, number: req.number, channel: req.channel ?? null });
    this.persist();
    this.poke();
  }

  // ── primary surface ──────────────────────────────────────────────────────────────────────

  /**
   * One poll cycle. Prune the PRs that reached a terminal state last tick (their merged/closed
   * event already fired), then read + diff every remaining watched PR. Never throws: a TRANSIENT
   * read failure for one PR is logged and skipped, leaving its snapshot untouched so it retries next
   * tick, while a repo that HARD-fails (404/410/genuine-403) for {@link HARD_FAILURES_BEFORE_DROP}
   * ticks running — proving it deleted or gone private — has its entry dropped once so it never
   * becomes a poll that fails forever. At most one watch is dropped per sweep, so a shared fault
   * can't wipe the registry. Mutates + persists the snapshot BEFORE returning events, so a crash
   * between persist and relay loses a ping rather than re-firing one.
   */
  async poll(): Promise<PrPollEvent[]> {
    // Drop terminal entries from the registry (their event fired last tick). They are gone from the
    // durable file after this, so a restart can never re-poll — or re-fire — a finished PR.
    let pruned = false;
    for (const [key, entry] of this.entries) {
      if (entry.terminal) {
        this.entries.delete(key);
        pruned = true;
      }
    }

    const active = [...this.entries.values()];
    const results = await Promise.all(
      active.map(async (entry): Promise<ReadResult> => {
        try {
          const signals = await this.reader.prSignals(entry.repo, entry.number);
          return { kind: "read", entry, signals };
        } catch (err) {
          const message = (err as Error).message;
          // Only a HARD failure — a 404/410 or a genuine "no access" 403 — is a candidate for
          // dropping, and even then not until HARD_FAILURES_BEFORE_DROP of them in a row (counted
          // below). Everything else — a network blip, a timeout, a rate-limit, an abuse block, a
          // transient 5xx — is transient: leave the snapshot untouched and try again next tick.
          if (classifyReadFailure(message) === "hard") return { kind: "hard-fail", entry };
          this.logger.warn("prSignals failed — skipping PR this tick (transient)", {
            repo: entry.repo,
            number: entry.number,
            error: message,
          });
          return null;
        }
      }),
    );

    // A hard failure is a definitive read (the repo answered "gone"), not a blip, so — like a
    // successful read — it counts as the tick making progress for health purposes. Only a tick
    // where EVERY active PR failed transiently (or there was nothing to read) is a non-progressing
    // one that arms the consecutive-failure alarm.
    if (results.some((r) => r !== null)) {
      this.consecutiveFailures = 0;
      this.lastPollAt = this.now();
    } else if (active.length > 0) {
      this.consecutiveFailures += 1;
    }

    const events: PrPollEvent[] = [];
    let changed = pruned;
    // A single sweep may drop AT MOST ONE watch. If a shared fault (a brief org-wide 403, say) makes
    // several PRs look hard on the same tick, we refuse to wipe the whole registry in one pass:
    // the rest keep their (now at-threshold) counters and would drop one-per-tick only if the fault
    // truly persists — by which point a real transient would have cleared and reset them.
    let droppedThisSweep = false;
    for (const result of results) {
      if (!result) continue;
      if (result.kind === "hard-fail") {
        result.entry.hardFailures += 1;
        changed = true;
        if (result.entry.hardFailures < HARD_FAILURES_BEFORE_DROP) {
          // Not yet convinced the repo is gone — one bad response is never enough. No warn spam:
          // debug only, so the eventual drop is still a SINGLE warn line.
          this.logger.debug("hard read failure — not dropping yet (needs consecutive failures)", {
            repo: result.entry.repo,
            number: result.entry.number,
            hardFailures: result.entry.hardFailures,
          });
          continue;
        }
        if (droppedThisSweep) {
          // At threshold, but this sweep already spent its one drop — defer to a later tick so a
          // shared fault can't clear more than one watch at once.
          this.logger.debug("unreadable PR at drop threshold — deferring (one drop per sweep)", {
            repo: result.entry.repo,
            number: result.entry.number,
          });
          continue;
        }
        // Threshold reached: the repo has answered "gone" HARD_FAILURES_BEFORE_DROP ticks running.
        // ONE log line, then the entry is gone from the registry (and the durable file below), so it
        // never turns into a poll that fails forever every tick.
        this.entries.delete(prKey(result.entry.repo, result.entry.number));
        droppedThisSweep = true;
        this.logger.warn("dropping unreadable PR (repo went private or was deleted)", {
          repo: result.entry.repo,
          number: result.entry.number,
          hardFailures: result.entry.hardFailures,
        });
        continue;
      }
      // A successful read clears any accumulated hard-failure streak: a repo that answers again was
      // only ever transiently gone.
      if (result.entry.hardFailures !== 0) {
        result.entry.hardFailures = 0;
        changed = true;
      }
      const before = JSON.stringify(result.entry);
      events.push(...this.diff(result.entry, result.signals));
      if (JSON.stringify(result.entry) !== before) changed = true;
    }

    if (changed) this.persist();
    return events;
  }

  /**
   * Diff one PR's fresh read against its snapshot, MUTATING the snapshot to the read and returning
   * the material events. The seed path (first-ever read) records baselines and emits nothing.
   */
  private diff(entry: PrState, s: PrSignals): PrPollEvent[] {
    const ref: PrRef = {
      repo: entry.repo,
      number: entry.number,
      url: s.url || entry.url,
      title: s.title || entry.title,
      runId: entry.runId,
      channel: entry.channel,
    };

    if (!entry.seeded) {
      entry.seeded = true;
      entry.state = s.state;
      entry.isDraft = s.isDraft;
      entry.headRefOid = s.headRefOid;
      entry.ciConclusion = s.checkConclusion === "FAILURE" || s.checkConclusion === "SUCCESS" ? s.checkConclusion : "NONE";
      entry.seenReviewIds = s.reviews.map((r) => r.id);
      entry.seenCommentIds = s.comments.map((c) => c.id);
      entry.url = ref.url;
      entry.title = ref.title;
      // Opened and already merged/closed before our first read → record terminal, emit nothing.
      if (s.state !== "OPEN") entry.terminal = true;
      return [];
    }

    const events: PrPollEvent[] = [];
    const prevState = entry.state;

    // A head-sha move is Beckett's own push (or a rebase): NOT an event. Re-arm CI so the new run's
    // conclusion fires fresh — that's how "CI failed on the memory branch" reaches the person after
    // a push. `updatedAt`/title may also drift; keep the snapshot current.
    if (s.headRefOid && s.headRefOid !== entry.headRefOid) {
      entry.headRefOid = s.headRefOid;
      entry.ciConclusion = "NONE";
    }
    entry.isDraft = s.isDraft;
    entry.url = ref.url;
    entry.title = ref.title;

    // Draft churn is noise: while a PR is a draft, mark everything seen so nothing replays when it
    // leaves draft, but surface none of it.
    const suppress = s.isDraft;

    const seenReviews = new Set(entry.seenReviewIds);
    for (const review of [...s.reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
      if (seenReviews.has(review.id)) continue;
      seenReviews.add(review.id);
      if (suppress) continue;
      if (review.author.toLowerCase() === this.account.toLowerCase()) continue; // our own review
      if (!MATERIAL_REVIEW.has(review.state)) continue; // PENDING/DISMISSED — not material
      events.push({ kind: "review", pr: ref, review });
    }
    entry.seenReviewIds = [...seenReviews];

    const seenComments = new Set(entry.seenCommentIds);
    for (const comment of [...s.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (seenComments.has(comment.id)) continue;
      seenComments.add(comment.id);
      if (suppress) continue;
      if (comment.author.toLowerCase() === this.account.toLowerCase()) continue; // our own comment
      events.push({ kind: "comment", pr: ref, comment });
    }
    entry.seenCommentIds = [...seenComments];

    // CI: only a terminal conclusion, only once per head sha (deduped on `ciConclusion`). Failures
    // are loud but not spammy — the same failure won't re-fire until a new push re-arms the signal.
    if (!suppress && (s.checkConclusion === "SUCCESS" || s.checkConclusion === "FAILURE")) {
      if (s.checkConclusion !== entry.ciConclusion) {
        entry.ciConclusion = s.checkConclusion;
        events.push({ kind: "ci", pr: ref, conclusion: s.checkConclusion });
      }
    }

    // Lifecycle: merge and close each fire exactly once, then the entry is pruned next tick.
    entry.state = s.state;
    if (s.state === "MERGED" && prevState !== "MERGED") {
      entry.terminal = true;
      events.push({ kind: "merged", pr: ref });
    } else if (s.state === "CLOSED" && prevState !== "CLOSED") {
      entry.terminal = true;
      events.push({ kind: "closed", pr: ref });
    }

    return events;
  }

  // ── convenience self-scheduling surface ──────────────────────────────────────────────────

  /**
   * Poll every `pollSecs` and hand each batch to `onEvents`. Runs one tick immediately so a PR that
   * gained a review while the daemon was down surfaces promptly. Ticks never overlap. Idempotent.
   */
  async start(onEvents: PrEventSink): Promise<void> {
    if (this.timer) return;
    this.sink = onEvents;
    this.logger.info("github PR poller started", { pollSecs: this.pollSecs, watching: this.entries.size });
    void this.tickOnce(onEvents);
    this.timer = setInterval(() => void this.tickOnce(onEvents), this.pollSecs * 1000);
  }

  /** Stop the self-scheduled interval (no-op if not running). The snapshot is retained. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("github PR poller stopped");
    }
  }

  /** Poll-loop health for `beckett status`, mirroring the tracker poller's `stats()`. */
  stats(): { lastPollAt: number | null; lastPollAgeMs: number | null; consecutiveFailures: number; watching: number } {
    return {
      lastPollAt: this.lastPollAt,
      lastPollAgeMs: this.lastPollAt === null ? null : this.now() - this.lastPollAt,
      consecutiveFailures: this.consecutiveFailures,
      watching: this.entries.size,
    };
  }

  /** Run one tick NOW (used after {@link watch} so a fresh PR is baselined promptly). */
  poke(): void {
    if (!this.sink || !this.timer) return;
    if (this.ticking) {
      this.pokePending = true;
      return;
    }
    void this.tickOnce(this.sink);
  }

  private async tickOnce(onEvents: PrEventSink): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const events = await this.poll();
      if (events.length > 0) await onEvents(events);
    } catch (err) {
      this.logger.error("github poll tick handler failed", { error: (err as Error).message });
    } finally {
      this.ticking = false;
      if (this.pokePending) {
        this.pokePending = false;
        setTimeout(() => this.poke(), 0);
      }
    }
  }

  // ── durable state ────────────────────────────────────────────────────────────────────────

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Record<string, PrState & { ticket?: string }>;
      for (const [key, entry] of Object.entries(raw)) {
        if (entry && typeof entry.repo === "string" && typeof entry.number === "number") {
          // Terminal entries that were persisted but never pruned (a crash before the next tick)
          // are dropped on load — they've already fired, and reloading them would re-poll a dead PR.
          if (entry.terminal) continue;
          this.entries.set(key, {
            ...entry,
            seenReviewIds: Array.isArray(entry.seenReviewIds) ? entry.seenReviewIds : [],
            seenCommentIds: Array.isArray(entry.seenCommentIds) ? entry.seenCommentIds : [],
            // Default for entries persisted before this field existed. It is a purely in-flight
            // streak counter, so starting a reloaded entry at 0 is correct — a restart mid-outage
            // simply re-earns the streak against a live repo (and clears instantly if it recovered).
            hardFailures: typeof entry.hardFailures === "number" ? entry.hardFailures : 0,
            // Rows persisted before the ticket rip-out carry `ticket` (a tracker identifier) where
            // `runId` now sits. It is still the routing handle the concierge looks the work up by,
            // so carry it across rather than dropping a live PR's origin on one restart.
            ...(entry.runId === undefined && typeof entry.ticket === "string" ? { runId: entry.ticket } : {}),
          });
        }
      }
      this.logger.info("loaded github PR watch state", { watching: this.entries.size });
    } catch (err) {
      this.logger.warn("github PR state file unreadable; starting empty", {
        path: this.statePath,
        error: (err as Error).message,
      });
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const body = JSON.stringify(Object.fromEntries(this.entries), null, 2) + "\n";
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, this.statePath);
    } catch (err) {
      this.logger.warn("github PR state persist failed", {
        path: this.statePath,
        error: (err as Error).message,
      });
    }
  }
}

/** Factory matching the repo's `createX(deps)` convention. */
export function createGitHubPrPoller(deps: GitHubPrPollerDeps): GitHubPrPoller {
  return new GitHubPrPoller(deps);
}
