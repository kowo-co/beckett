/**
 * Beckett — the shell entrypoint (`src/shell/main.ts`)
 * =======================================================================================
 * Boots the ticket-queue system and wires the four moving parts together:
 *
 *   1. Config + env — `loadConfig()` reads `~/.beckett/config.toml` (the `[tracker]` /
 *      `[concierge]` sections) and loads `~/.beckett/.env`.
 *   2. BoredClient — the only module that speaks HTTP to the loopback bored tracker
 *      (BECKETT_BORED_URL, default http://127.0.0.1:7770).
 *   3. Poller — polls bored every `config.tracker.poll_secs`, diffs snapshots, and
 *      hands each batch of {@link PollEvent}s to the dispatcher.
 *   4. Dispatcher — the state machine: spawns implement/review workers, steers them from
 *      ticket comments, aborts on cancel, advances ticket state on finish.
 *   5. Concierge — the long-lived `claude -p` chat agent that owns Discord and files tickets.
 *
 * The Concierge and the poll→dispatch loop are independent: the Concierge writes tickets into
 * the tracker, the poller observes them, the dispatcher acts. They never call each other
 * directly — the tracker is the shared queue.
 *
 * Run it with `bun run v4` (see package.json) or `bun src/shell/main.ts`. The `v4` script name
 * and the `beckett-v4.service` unit are kept for continuity with the 4.0.0 multiplayer release;
 * only the file was renamed from `v4-main.ts` (see docs/ARCHITECTURE.md "Entrypoint & cutover").
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions, ESM.
 */

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { recordBoot, recordCleanShutdown, uptimeLedgerPath } from "../uptime.ts";
import { log as rootLog } from "../log.ts";
import type { Config, Harness, Logger } from "../types.ts";
import type { Ticket } from "../tracker/types.ts";
import { projectSlug } from "../tracker/cast.ts";
import { createTrackerClient, type TrackerClient } from "../tracker/client.ts";
import { boredBaseUrl } from "../bored/client.ts";
import { createTrackerPoller, type TrackerPoller } from "../tracker/poll.ts";
import { BECKETT_COMMENT_MARKER, createDispatcher, type Dispatcher } from "../dispatch/dispatcher.ts";
import { createStagesExtension, stageViewOf } from "../dispatch/stages.ts";
import { createProgressCardService, type ProgressCardService } from "../progress/cards.ts";
import { createGitHubPrPoller, type GitHubPrPoller } from "../github/poll.ts";
import { createGitHubActivityPoller, type GitHubActivityPoller } from "../github/activity.ts";
import { parsePrUrl } from "../github/types.ts";
import { preflightFor } from "../drivers/index.ts";
import { cardsChannelId, createConcierge, currentGitCommit, type Concierge } from "../concierge/index.ts";
import { createDiscordGateway, DiscordJsGateway } from "../discord/gateway.ts";
import { PresenceController, type PresenceInputs } from "../discord/presence.ts";
import { isDeployActive } from "./deploy-activity.ts";
import { VoiceGateway, type VoiceBackendFactory } from "../discord/voice/gateway.ts";
import { classify, loadAccess, type AccessLevel } from "../discord/access.ts";
import { loadMaintainers } from "../discord/maintainers.ts";
import { createSystemMetricsReader } from "../system-metrics.ts";
import { createStatusSnapshotCollector } from "../status/snapshot.ts";
import { createStatusDashboardService, statusDashboardMessagePath, type StatusDashboardService } from "../status/service.ts";
import type { QuickRunner } from "../quick/index.ts";
import type { BrowserRuntime } from "../browser/runtime.ts";
import type { BrowserAgent } from "../browser/agent.ts";
import { defaultKeychainReader } from "../secret/keychain-read.ts";
import { GitHubCli, githubAuth, githubConfigured, loadIdentity } from "../agency/index.ts";
import { resolveProjectOwner } from "../github/owner.ts";
import { LiveAgentRegistry } from "../agent/registry.ts";
import { createAgentRunner } from "../agent/invoke.ts";
import { TaskStore } from "../task/store.ts";
import { createBranchStatusService } from "../task/status.ts";
import { readLocalBranchStats } from "../git/branch-stats.ts";
import { CfDns, apexDomain } from "../agency/cloudflare.ts";
import { TunnelDeployer } from "./deploy.ts";
import { PreviewManager, fetchProbe, type PreviewTicket } from "../preview/index.ts";
import { serveBuild } from "../preview/serve-build.ts";
import { createFrontendScreenshotHook, type ScreenshotTicketRef } from "../preview/screenshot.ts";
import { gitBranchForTicket } from "../git/branch-name.ts";
import { reconcileTaskTickets } from "../task/reconcile.ts";
import { createAgentMailApi, defaultMailStateFile, safeMailError } from "../mail/index.ts";
import { createAgentMailPoller, defaultMailListenerStateFile, type AgentMailPoller } from "../mail/listener.ts";
import { ExtensionRegistry, type ExtensionContext } from "../ext/index.ts";
import { pendingConfigurationProblems, startPendingConfigurationDaemon } from "./pending.ts";
// NOTE: the Phase 4 organs (github/dns/deploy/mail) are deliberately NOT daemon-registered yet —
// deploy.create's in-daemon host side effects (cloudflared + ~/.cloudflared/config.yml) need
// sign-off first (cli-cascade spec, open question 5).
import {
  createBrowserExtension,
  createImageExtension,
  createSecretExtension,
} from "../capability/modules/index.ts";
// Phase 3 quick wiring: a separate import line so concurrent organ migrations stay additive.
import { createQuickExtension } from "../capability/modules/quick.ts";
// Phase 3b routines wiring: same additive-import posture.
import { createRoutinesExtension } from "../capability/modules/routines.ts";
// Phase 6 memory wiring (the LAST organ): same additive-import posture.
import { createMemoryExtension } from "../capability/modules/memory.ts";

/**
 * Root under which every ticket builds its OWN project repo — one directory per code project,
 * e.g. `~/Projects/balloons`. Override via `BECKETT_PROJECTS_ROOT`.
 */
const PROJECTS_ROOT = process.env.BECKETT_PROJECTS_ROOT?.trim() || join(homedir(), "Projects");

/**
 * The git repo a ticket's worker runs in (v3.1): the ticket's OWN project repo at
 * `<PROJECTS_ROOT>/<slug>`, pushed to `<owner>/<slug>` — fully decoupled from Beckett's own
 * source repo (`~/beckett`, which a worker never touches). The slug is the ticket's
 * Concierge-named `project`, or the ticket identifier when unnamed (a per-ticket sandbox). The
 * dispatcher provisions the repo (clone if it exists on GitHub, else `git init`) before spawning.
 */
function resolveRepoRoot(ticket: Ticket): string {
  return join(PROJECTS_ROOT, projectSlug(ticket.project || ticket.identifier || "scratch"));
}

/**
 * The file paths a branch changed vs. `main`, for frontend-preview detection (#76). Best-effort:
 * a missing repo/branch or any git failure yields an empty list (no preview), never a throw.
 */
function diffFileNames(repoRoot: string, branch: string): string[] {
  try {
    const r = Bun.spawnSync(["git", "-C", repoRoot, "diff", "--name-only", `main...${branch}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!r.success) return [];
    return r.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The files a ticket's BUILT worktree changed vs. its fork base (#75) — the diff that decides
 * whether a finished ticket earns a result screenshot, and of what. Runs in the worktree against
 * the captured base SHA so it reflects the built branch, not `main`. Best-effort: any git failure
 * yields an empty list (→ no screenshot), never a throw.
 */
function worktreeDiffNames(workspace: string, baseRef: string): string[] {
  try {
    const r = Bun.spawnSync(["git", "-C", workspace, "diff", "--name-only", baseRef], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!r.success) return [];
    return r.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Beckett version. v4.0 — the multiplayer release (OPS-80): channel-scoped shared context, so
 * everyone in a Discord channel collaborates with the same Beckett instead of getting isolated
 * per-user sessions. v4.2 adds per-CHANNEL sessions (OPS-80 §9.3): conversations in different
 * channels run concurrently through a bounded turn gate instead of queueing behind one global
 * session, and a DM's transcript is structurally partitioned from every guild channel's.
 * See CHANGELOG.md.
 */
// ONE version source (issue #29): package.json. The old hand-maintained constant drifted three
// ways (package.json 3.1.1 / this file 3.3.0 / CHANGELOG 3.3). Read at module load; the file
// sits at the repo root two levels up from src/shell/.
import pkg from "../../package.json" with { type: "json" };
export const BECKETT_VERSION: string = (pkg as { version: string }).version;

/** The live v4 system — held so {@link shutdown} can tear every part down in order. */
interface BootedSystem {
  config: Config;
  logger: Logger;
  client: TrackerClient;
  clients: Map<string, TrackerClient>;
  poller: TrackerPoller;
  pollers: Map<string, TrackerPoller>;
  prPoller: GitHubPrPoller | null;
  activityPoller: GitHubActivityPoller | null;
  mailPoller: AgentMailPoller | null;
  dispatcher: Dispatcher;
  concierge: Concierge;
  voiceGateway: VoiceGateway;
  statusDashboard: StatusDashboardService;
  quick: QuickRunner;
  browserAgent: BrowserAgent;
  browser: BrowserRuntime;
  extensions: ExtensionRegistry;
  lifecycleLedgerPath: string;
}

/**
 * Construct and start the whole v3 stack. Returns the booted system so the caller can wire
 * shutdown. The Concierge is started first (fail fast on a bad `claude` launch); the poller is
 * started last so events only flow once the dispatcher is ready to consume them.
 */
async function boot(): Promise<BootedSystem> {
  const config = loadConfig();
  const logger = rootLog.child("shell.v4");

  logger.info("booting beckett v4", {
    version: BECKETT_VERSION,
    tracker: boredBaseUrl(),
    defaultBoard: config.tracker.default_board,
    boards: config.tracker.boards,
    pollSecs: config.tracker.poll_secs,
    conciergeModel: config.concierge.model,
    projectsRoot: PROJECTS_ROOT,
  });

  // bored serves ONE managed board per instance — poll only the default board.
  const activeBoards = [config.tracker.default_board];
  const clients = new Map<string, TrackerClient>();
  for (const board of activeBoards) {
    clients.set(board, createTrackerClient({ config, board, logger: logger.child(`tracker.client.${board}`) }));
  }
  const client = clients.get(config.tracker.default_board) ?? clients.values().next().value!;
  const clientByProjectId = new Map<string, TrackerClient>();
  const pollerByProjectId = new Map<string, TrackerPoller>();

  // Deterministic GitHub publishing: when a ticket reaches done, its project repo is pushed to
  // `<owner>/<slug>` (public) so the links Beckett hands out actually resolve — instead of
  // relying on the worker to push, which it skipped and left repos that 404'd. Built from the
  // GitHub identity; no credential makes it undefined → the dispatcher skips publishing and says so.
  const identity = loadIdentity(config);
  const publishRepo = githubConfigured(identity)
    ? async (a: {
        slug: string;
        repoRoot: string;
        description: string;
        ticket?: string;
        targetBranch?: string;
        baseSha?: string;
        commitMessage?: string;
      }) => {
        const gh = new GitHubCli({
          ...githubAuth(identity),
          account: identity.github.account,
          // Per-project owner: Beckett's self-project repo moved to kowo-co (#114); all others stay
          // under the configured owner.
          owner: resolveProjectOwner(a.slug, config),
          apiBase: identity.github.apiBase,
          resolveRepoDir: () => a.repoRoot,
          logger: logger.child("gh"),
        });
        const r = await gh.ensurePublished({
          slug: a.slug,
          sourceDir: a.repoRoot,
          description: a.description,
          ticket: a.ticket,
          targetBranch: a.targetBranch,
          baseSha: a.baseSha,
          commitMessage: a.commitMessage,
        });
        return { url: r.url, kind: r.kind, prUrl: r.prUrl };
      }
    : undefined;
  if (!publishRepo) {
    logger.warn("no GitHub credentials — project repos will stay local-only (not pushed to GitHub)");
  }

  // GitHub PR sense (OPS-124): watch the PRs Beckett opens on the kowo-co org and relay review/CI/
  // merge signal back to the ticket's channel. Registry-driven — the dispatcher's `onPrOpened` hook
  // (below) registers each PR at open time with its origin channel. Read-only: it observes and
  // relays, never replies or merges. Skipped without a credential (nothing to read GitHub with).
  const paths = buildPaths(config);
  const beckettDir = paths.beckettDir;
  // Lifecycle history starts now; a previous unmatched boot becomes an explicit unclean restart.
  const lifecycleLedgerPath = uptimeLedgerPath(beckettDir);
  recordBoot(lifecycleLedgerPath);
  const tasks = new TaskStore(join(beckettDir, "tasks.json"));
  // The Concierge and dashboard deliberately share this one gateway connection.
  const gateway = createDiscordGateway({ config, logger: logger.child("discord") });
  const syncTaskBranch = async (ticket: Ticket, board: string, snapshot = false): Promise<void> => {
    if (!ticket.branchRef) return;
    const branch = await tasks.syncTicket(ticket, board);
    if (!snapshot || !branch?.git?.workspace || !branch.git.baseSha) return;
    try {
      const stats = await readLocalBranchStats(branch.git.workspace, branch.git.baseSha);
      await tasks.setDiff(branch.ref, {
        additions: stats.additions,
        deletions: stats.deletions,
        files: stats.changedFiles,
        commits: stats.commits,
      });
    } catch (err) {
      logger.warn("task branch diff snapshot failed", { branch: branch.ref, error: String(err) });
    }
  };
  const githubReader = githubConfigured(identity)
    ? new GitHubCli({
        ...githubAuth(identity),
        account: identity.github.account,
        owner: identity.github.owner,
        apiBase: identity.github.apiBase,
        resolveRepoDir: () => PROJECTS_ROOT,
        logger: logger.child("gh.read"),
      })
    : null;
  const prPoller: GitHubPrPoller | null = githubConfigured(identity)
    ? createGitHubPrPoller({
        reader: githubReader!,
        account: identity.github.account,
        pollSecs: config.github.poll_secs,
        statePath: join(beckettDir, "github-prs.json"),
        logger: logger.child("github.poll"),
      })
    : null;

  // OPS-128: a separate read-only feed for contributors pushing directly to Beckett's main or
  // merging PRs there. It uses the same credentialed GitHubCli boundary as every other GitHub
  // operation; deployment identities are advanced as watermarks but never become Discord lines.
  const activityConfig = config.github.activity;
  const activityPoller: GitHubActivityPoller | null = githubConfigured(identity) && activityConfig.enabled
    ? createGitHubActivityPoller({
        reader: githubReader!,
        repo: activityConfig.repo,
        branch: activityConfig.branch,
        pollSecs: activityConfig.poll_secs,
        statePath: join(beckettDir, "github-activity.json"),
        // Always suppress the actually configured daemon identity even if a box overrides it.
        ignoredAuthors: [...new Set([...activityConfig.ignored_authors, identity.github.account])],
        logger: logger.child("github.activity"),
      })
    : null;

  // 5. Concierge — owns Discord (and the private ticket journal the dispatcher feeds). Constructed
  //    here (cheap, no I/O) so its progress sink can be wired into the dispatcher below; started
  //    further down (FIRST of the live parts) so a bad claude launch fails the whole boot early.
  const concierge = createConcierge({
    config,
    logger: logger.child("concierge"),
    gateway,
    tracker: client,
    tasks,
    branchStatus: createBranchStatusService({
      store: tasks,
      ...(githubReader ? { github: githubReader } : {}),
      githubOwner: identity.github.owner,
    }),
  });

  // 3. Pollers — one per board, all feeding the same dispatcher. `start()` primes the
  //    snapshot first (so we don't replay history) then self-schedules every poll_secs.
  //    Constructed BEFORE the dispatcher so the dispatcher's instant-advance path (issue #33)
  //    can reference the correct board poller.
  const pollers = new Map<string, TrackerPoller>();
  for (const [board, boardClient] of clients) {
    pollers.set(
      board,
      createTrackerPoller({
        client: boardClient,
        logger: logger.child(`tracker.poll.${board}`),
        pollSecs: config.tracker.poll_secs,
        commentCursorPath: join(
          beckettDir,
          board === config.tracker.default_board ? "comment-cursors.json" : `comment-cursors-${board}.json`,
        ),
        snapshotPath: join(
          beckettDir,
          board === config.tracker.default_board ? "poll-snapshot.json" : `poll-snapshot-${board}.json`,
        ),
      }),
    );
  }
  const poller = pollers.get(config.tracker.default_board) ?? pollers.values().next().value!;
  // Health-check the tracker and pre-resolve board routing before polling. Boards are
  // independent, so run their within-board sequential checks concurrently. Each request uses the
  // client's 429 Retry-After/exponential-backoff wrapper. Failures remain non-fatal so a temporary
  // tracker outage does not take Discord down; the poller retries through its normal client
  // bootstrap on later ticks.
  // A board-less instance (#141 staging) skips the board entirely: no health-check, no reconcile,
  // no poll/dispatch below. The board is a shared HTTP service (BECKETT_BORED_URL), so this is the
  // one switch that keeps a second daemon off the production queue — and off the boot-time retry
  // storm an unreachable board would otherwise cost before Discord even connects.
  if (config.tracker.enabled) {
    await Promise.all(
      [...clients].map(async ([board, boardClient]) => {
        try {
          await boardClient.ensureProvisioned();
          const info = await boardClient.projectInfo();
          clientByProjectId.set(info.projectId, boardClient);
          const boardPoller = pollers.get(board);
          if (boardPoller) pollerByProjectId.set(info.projectId, boardPoller);
          // Poller priming intentionally emits recovery events only for active work. Reconcile the
          // complete board here as well so terminal/parked changes made while offline cannot leave
          // the public task registry stale or a dependent permanently held.
          await reconcileTaskTickets(tasks, await boardClient.listIssues(), board, (ticket, err) => {
            logger.warn("task branch boot reconciliation failed", {
              branch: ticket.branchRef,
              error: String(err),
            });
          });
        } catch (err) {
          logger.warn("tracker board health-check/pre-resolution failed", { board, error: (err as Error).message });
        }
      }),
    );
  } else {
    logger.warn("tracker disabled (config.tracker.enabled=false) — no board poll or dispatch");
  }
  const rememberRouting = (events: Ticket | Ticket[], board: string) => {
    const boardClient = clients.get(board);
    const boardPoller = pollers.get(board);
    for (const ticket of Array.isArray(events) ? events : [events]) {
      if (ticket.projectId && boardClient) clientByProjectId.set(ticket.projectId, boardClient);
      if (ticket.projectId && boardPoller) pollerByProjectId.set(ticket.projectId, boardPoller);
    }
  };

  // The v6 extension seam (docs/v6-architecture.md §6): the ONE runtime registry the daemon
  // dispatches extensions through — `ext.invoke`/`ext.catalog` on the control bus read it via
  // the concierge. Constructed BEFORE the dispatcher (Phase 5: worker stages resolve through
  // this registry); the stateful organs register further down, once their collaborators exist.
  // Registration order is teardown-reverse, and must honor concierge-first/pollers-last for
  // organs that migrate.
  const extensions = new ExtensionRegistry();
  const extCtx: ExtensionContext = { config, paths, logger };
  // Phase 5 — the worker-stages facet: the four built-ins (implement/review/design/design_check)
  // as ONE core-kind extension. Stateless, no capabilities (never @mention-routed, absent from
  // the catalog), so registering it first constrains no lifecycle ordering below.
  extensions.register(createStagesExtension(extCtx));

  // Branch previews (#76): while a frontend branch is in review, surface a live, externally-
  // reachable URL on its ticket instead of a diff; tear it down when it lands/cancels. The worker
  // stands the preview up via `beckett deploy <slug>-preview` (existing tunnel path); the daemon
  // owns verify-and-surface (never an internal/unreachable link) and teardown. Wired only when the
  // Cloudflare zone credentials exist — otherwise the dispatcher runs with no preview at all.
  const preview = ((): { ensure: (t: Ticket) => Promise<{ status: "ready"; url: string; host: string } | { status: "skipped"; reason: string }>; teardown: (t: Ticket) => Promise<void> } | undefined => {
    const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
    const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
    if (!token || !zoneId) return undefined;
    const previewLog = logger.child("preview");
    const dns = new CfDns({ token, zoneId, logger: previewLog });
    const deployer = new TunnelDeployer({ tunnelId: process.env.CLOUDFLARE_TUNNEL_ID, dns, logger: previewLog });
    const manager = new PreviewManager({
      deployer,
      probe: (url) => fetchProbe(url),
      changedFiles: async (pt) => {
        if (!pt.branchRef) return [];
        const repoRoot = join(PROJECTS_ROOT, pt.slug);
        const branch = gitBranchForTicket({ identifier: pt.id, branchRef: pt.branchRef });
        return diffFileNames(repoRoot, branch);
      },
      store: tasks,
      logger: previewLog,
      apex: apexDomain(),
    });
    const previewTicketOf = (t: Ticket): PreviewTicket => ({
      id: t.id,
      slug: projectSlug(t.project || t.identifier),
      branchRef: t.branchRef,
    });
    return {
      ensure: (t) => manager.ensure(previewTicketOf(t)),
      teardown: (t) => manager.teardown(previewTicketOf(t)),
    };
  })();

  // 4. Dispatcher — consumes PollEvents, owns the worker lifecycle. Its workers' granular event
  //    streams are mirrored into each ticket's Discord thread via the Concierge's progress hub.
  // Zero-token progress cards (progress.cards_as_code, default off): CODE keeps one status
  // message per active ticket in the ticket's origin channel, edited straight off the dispatch
  // event bus — no Concierge involvement, honoring "the Concierge and the poll-dispatch loop
  // never call each other directly". Channel: the event's stamped originChannel, else the task
  // registry's thread/origin (same precedent as the PR re-watch loop below).
  const progressCards: ProgressCardService | null = config.progress.cards_as_code
    ? createProgressCardService({
        gateway,
        statePath: join(beckettDir, "progress-cards.json"),
        resolveChannel: (event) => {
          if (event.channel) return event.channel;
          const hit =
            tasks.findByTicket(event.ticketId) ??
            tasks.findByTicket(event.ticketRef.replace(/^#/, ""));
          return hit ? hit.task.threadId ?? hit.task.originChannelId ?? null : null;
        },
        logger: logger.child("progress-cards"),
      })
    : null;

  const dispatcher = createDispatcher({
    client,
    clients: [...clients.values()],
    clientForProjectId: (projectId) => clientByProjectId.get(projectId),
    config,
    // v6 Phase 5: staff/cast/prompt worker stages through the boot registry's stage view — the
    // one ExtensionRegistry — instead of the module-local default table.
    stages: stageViewOf(extensions),
    resolveRepoRoot,
    publishRepo,
    progress: concierge.progressSink(),
    advanceOutboxPath: join(beckettDir, "advance-outbox.jsonl"),
    publishOutboxPath: join(beckettDir, "publish-outbox.jsonl"),
    // OPS-167: append before relaying to Discord. `postDispatchEvent` is deliberately not awaited
    // by the bus, so gateway outages degrade to an on-disk timeline rather than blocking dispatch.
    dispatchEventsPath: join(paths.eventsDir, "dispatch.jsonl"),
    dispatchLiveSink: (event) => {
      // Fire-and-forget: a card hiccup must never delay the digest relay, and neither is awaited
      // by the bus. Flag off ⇒ progressCards is null and this is behaviorally identical.
      if (progressCards) void progressCards.observe(event);
      return concierge.postDispatchEvent(event);
    },
    runtimeStatePath: join(beckettDir, "dispatcher-state.json"),
    spendLedgerPath: paths.spend,
    // Harness health probe (issue #17): a dead harness (binary gone, login expired) becomes one
    // clear substitution comment instead of a wedged ticket. ~5-min cached per harness.
    preflight: (harness) => preflightFor(harness, config),
    onBeforePublish: async ({ ticket }) => {
      if (!ticket.branchRef) return;
      const board = clientByProjectId.get(ticket.projectId)?.board() ?? config.tracker.default_board;
      // Snapshot against the original task base before an owned-repo push rebases onto a parallel
      // branch that reached main first. This persisted aggregate survives worktree teardown.
      await syncTaskBranch(ticket, board, true);
    },
    // Instant milestone path (issue #33): a dispatcher-written advance reaches Discord NOW
    // (concierge.notify) instead of after the next poll, and the poller's snapshot is synced so
    // the same transition isn't re-emitted as a duplicate ping ≤5s later.
    onAdvance: async (event) => {
      (pollerByProjectId.get(event.ticket.projectId) ?? poller).observe(event);
      if (event.ticket.branchRef) {
        const board = clientByProjectId.get(event.ticket.projectId)?.board() ?? config.tracker.default_board;
        try {
          // Publication snapshots completed contributions before any rebase. State advances only
          // update lifecycle here so the accurate pre-publish aggregate is never overwritten.
          await syncTaskBranch(event.ticket, board);
        } catch (err) {
          logger.warn("task branch state sync failed", { branch: event.ticket.branchRef, error: String(err) });
        }
      }
      concierge.notify(event);
    },
    onPublished: async ({ url, kind, ticket }) => {
      if (!ticket.branchRef) return;
      try {
        await tasks.setPublication(ticket.branchRef, {
          repo: `${identity.github.owner}/${projectSlug(ticket.project || ticket.identifier)}`,
          url,
          kind,
        });
      } catch (err) {
        logger.warn("task branch publication sync failed", { branch: ticket.branchRef, error: String(err) });
      }
    },
    // OPS-124: a PR Beckett just opened → start watching it, routed to the ticket's origin channel.
    // Parse the repo+number from the PR URL; a non-PR URL yields null and is ignored. #31: the
    // poller no longer drops PRs outside our org — a cross-fork PR into a third-party upstream is
    // watched exactly like one on our own org.
    //
    // What is stamped here is the FALLBACK destination, not the destination. A user-opened thread
    // that owns this work wins, but that is resolved when the event is relayed
    // (`Concierge.channelForPr`), never here: under the user-owned thread model `&12` writes the
    // attachment into the workspace registry only, and the person usually opens the room AFTER
    // the PR exists. Stamping a thread at open time would both miss those attachments and freeze
    // the wrong channel for the PR's whole life.
    onPrOpened: async ({ prUrl, ticket }) => {
      const parsed = parsePrUrl(prUrl);
      if (!parsed) return;
      if (ticket.branchRef) {
        try {
          await tasks.setPullRequest(ticket.branchRef, { repo: parsed.repo, number: parsed.number, url: prUrl });
        } catch (err) {
          logger.warn("task branch PR sync failed", { branch: ticket.branchRef, error: String(err) });
        }
      }
      if (prPoller) {
        prPoller.watch({
          repo: parsed.repo,
          number: parsed.number,
          url: prUrl,
          title: ticket.title,
          ticket: ticket.identifier,
          channel: ticket.originChannel,
        });
      }
    },
    onBranchWorkspace: ({ ticket, workspace, gitRef, baseSha }) => {
      if (!ticket.branchRef) return;
      void tasks.setGit(ticket.branchRef, {
        project: projectSlug(ticket.project || ticket.identifier),
        workspace,
        gitRef,
        baseSha,
      }).catch((err) => logger.warn("task branch Git sync failed", { branch: ticket.branchRef, error: String(err) }));
    },
    preview,
    logger: logger.child("dispatch"),
  });

  // Wire the Concierge's intervention levers (issue #21): `beckett ticket restaff` on the control
  // bus routes here. Done post-construction because the Concierge is built first (progress sink).
  concierge.setDispatcherOps({
    restaff: (id, harness) => dispatcher.restaff(id, harness as Harness | undefined),
    courier: (id) => dispatcher.courier(id),
  });

  // Instant tick on filing (issue #33): `beckett ticket create --channel …` pings the control bus;
  // poking the poller staffs the fresh ticket in well under a second instead of the 0–5s poll gap.
  concierge.setTicketFiledListener(() => {
    for (const p of pollers.values()) p.poke();
  });

  // #31: a PR opened by hand from the concierge seat (`beckett gh pr create`) reaches the poller
  // through the `pr.watch` bus op, which lands here. Wired only when a poller exists (a PAT is set);
  // otherwise the bus op reports its clean no-op. `watch` persists immediately, so a hand-opened PR
  // is durable the same way a dispatcher-opened one is and re-arms across a restart via the poller's
  // registry file.
  if (prPoller) concierge.setPrWatchRegistrar((req) => prPoller.watch(req));

  // Extension registration (the registry itself is constructed above, pre-dispatcher — Phase 5).
  // Phase 1 organs (stateless) register here; later phases move a migrating organ's setup into
  // lifecycle.{init,start} instead of adding boot lines.
  extensions.register(createImageExtension({ config, paths, logger: logger.child("image") }));
  extensions.register(createSecretExtension({ config, paths, logger: logger.child("secret") }));
  // Phase 4's github/dns/deploy/mail extensions carry daemon-safe invoke bodies but are NOT
  // registered here yet: exposing them through in-daemon `ext.invoke` (notably deploy.create's
  // cloudflared/host side effects) is an unresolved product decision (cli-cascade spec, open
  // question 5). The CLI registers them in its own ExtensionRegistry (cli/beckett.ts).
  // Phase 2 — the browser organ's lifecycle lives in the extension: init constructs the (inert)
  // runtime + background agent, start rides startAll (after concierge.start + crash recovery),
  // stop rides stopAll (agent legs settle, then the host dies). The concierge callbacks close
  // over the already-constructed concierge, which is why this registers here and not earlier.
  const browserExtension = createBrowserExtension({
    keychain: defaultKeychainReader,
    onQuestion: (run, question) => concierge.notifyBrowserQuestion(run, question),
    onOutcome: (run) => concierge.notifyBrowserOutcome(run),
  })({ config, paths, logger });
  extensions.register(browserExtension);
  // Phase 3 — the quick organ (the no-ticket lane) rides the extension lifecycle: init
  // constructs the runner (the quick-dir mkdir + artifact-retention sweep boot always did),
  // stop kills straggler runs on the teardown sweep — which runs BEFORE concierge.stop(), so
  // their "daemon shut down" results still route. A run that outlives its sync window reports
  // back through the Concierge as an update turn, exactly like a ticket milestone; that
  // detached-result callback closes over the concierge, which is why this registers here.
  const quickExtension = createQuickExtension({
    onDetachedResult: (run) => concierge.notifyQuickResult(run),
  })({ config, paths, logger });
  extensions.register(quickExtension);
  // Phase 3b — the routines organ (issue #62): init builds the store + scheduler deps INERT;
  // the cron loop arms only in the LATE startAll sweep below (startPhase "late"), after the
  // agent registry/runner and the rest of the live system exist. The dispatcher's dependencies
  // are LAZY accessors resolved at FIRE time — agentRegistry/agentRunner are consts declared
  // further down the boot, which is safe because nothing calls these before the late start.
  const routinesExtension = createRoutinesExtension({
    browserAgent: () => browserExtension.agent(),
    agentRegistry: () => agentRegistry,
    agentRunner: () => agentRunner,
    // Resolve the origin channel/requester at fire time from env so no id is baked into a
    // routine definition (BECKETT_ROUTINE_CHANNEL_ID / DISCORD_OWNER_ID).
    defaultOrigin: () => ({
      channelId: process.env.BECKETT_ROUTINE_CHANNEL_ID?.trim() ?? null,
      requesterId: process.env.DISCORD_OWNER_ID?.trim() ?? null,
    }),
  })({ config, paths, logger });
  extensions.register(routinesExtension);
  // Phase 6 — the memory organ, the LAST organ (docs/v6-architecture.md §6-§7): init builds the
  // ONE daemon-owned warm MemoryStore (warm graph + Moss handle survive each short-lived
  // `beckett recall` process); the nightly maintain loop arms in the LATE startAll sweep below
  // and stops inside the registry teardown. Registered LAST so its stop runs FIRST in the
  // stopAll sweep — the position closest to the old first-line memoryMaintenance.stop(). The
  // owner id is bound from env here (like the routines origin) so the extension stays env-free;
  // it grants the owner audience for `memory.recall`/`memory.remember` ext.invoke calls, whose
  // Audience is derived INSIDE the extension from the token-derived origin — never from args.
  const memoryExtension = createMemoryExtension({
    ownerId: () => process.env.DISCORD_OWNER_ID?.trim() ?? null,
  })({ config, paths, logger });
  extensions.register(memoryExtension);
  concierge.setExtensionRegistry(extensions, extCtx);

  // Extensions init before any live part starts (build state, open connections). Per-organ
  // isolation lives in the registry; only a fail-fast organ can abort the boot here.
  await extensions.initAll(extCtx);

  // The browser extension's init built the runtime + agent (the host subprocess itself stays
  // unspawned until the first acquire). Phase 2 keeps the concierge's seven browser.* bus
  // command bodies v5-shaped, so they still receive both through the setters.
  const browser = browserExtension.runtime();
  const browserAgent = browserExtension.agent();
  concierge.setBrowserRuntime(browser);
  concierge.setBrowserAgent(browserAgent);

  // Frontend result screenshot (#75): when a ticket that touched a frontend lands, serve its built
  // branch locally, capture ONE screenshot through the shared persistent browser, and attach it to
  // the ticket record (+ its channel ping). Wired here — not in the dispatcher's construction —
  // because the browser runtime is only built now. Best-effort throughout; `BECKETT_FRONTEND_SCREENSHOT=0`
  // opts a box out entirely.
  if (process.env.BECKETT_FRONTEND_SCREENSHOT !== "0") {
    const shotLog = logger.child("screenshot");
    const captureScreenshot = async (url: string, ticket: ScreenshotTicketRef): Promise<string | null> => {
      // The persistent browser is a single exclusive resource: yield it to any live background run
      // rather than racing for the lease. A missed screenshot is fine; a broken browser run is not.
      const busy = browserAgent
        .stats()
        ?.runs.some((run) => run.state === "running" || run.state === "waiting" || run.state === "queued");
      if (busy) {
        shotLog.info("browser busy — skipping screenshot", { ticket: ticket.identifier });
        return null;
      }
      const runId = `screenshot-${crypto.randomUUID()}`;
      const controlToken = crypto.randomUUID();
      const artifactsDir = join(beckettDir, "browser-agent", "screenshots", ticket.id, runId);
      try {
        await browser.acquire({ runId, channelId: ticket.originChannel ?? null, artifactsDir, controlToken });
        const code =
          `await page.goto(${JSON.stringify(url)}, { waitUntil: "load", timeout: 20000 });\n` +
          `await page.waitForTimeout(1500);\n` +
          `return await screenshot("frontend");`;
        const result = await browser.evaluate(runId, code, controlToken);
        return result.screenshots?.[0] ?? null;
      } catch (err) {
        shotLog.warn("screenshot capture failed", { ticket: ticket.identifier, error: (err as Error).message });
        return null;
      } finally {
        if (browser.hasLease(runId)) await browser.release(runId, false).catch(() => undefined);
      }
    };
    const attachScreenshot = async (ticket: ScreenshotTicketRef, pngPath: string): Promise<void> => {
      const caption = `📸 Frontend screenshot of the built branch for **${ticket.identifier}**.`;
      // Post to the channel first (when there is one): that upload also gives us a hosted URL to
      // embed on the ticket, since a tracker comment can render an image but cannot host bytes.
      let hostedUrl: string | null = null;
      if (ticket.originChannel) {
        try {
          hostedUrl = (await gateway.postImage?.(ticket.originChannel, caption, pngPath)) ?? null;
        } catch (err) {
          shotLog.warn("screenshot channel ping failed", { ticket: ticket.identifier, error: (err as Error).message });
        }
      }
      // Feed the task card's gallery reel: the hosted URL is evergreen CDN, so storing it on the
      // branch lets the next card refresh render the screenshot inline instead of only as a ping.
      if (hostedUrl) {
        try {
          const found = tasks.findByTicket(ticket.id) ?? tasks.findByTicket(ticket.identifier);
          if (found) {
            await tasks.addBranchImage(found.branch.ref, { url: hostedUrl, description: ticket.identifier });
          }
        } catch (err) {
          shotLog.warn("screenshot card-image store failed", { ticket: ticket.identifier, error: (err as Error).message });
        }
      }
      const body = hostedUrl
        ? `${BECKETT_COMMENT_MARKER}\n📸 **Frontend screenshot** of the built branch:\n\n![${ticket.identifier} frontend](${hostedUrl})`
        : `${BECKETT_COMMENT_MARKER}\n📸 **Frontend screenshot** of the built branch captured at \`${pngPath}\`.`;
      await client.addComment(ticket.id, body);
    };
    dispatcher.setScreenshotCapturer(
      createFrontendScreenshotHook({
        changedFiles: async (workspace, baseRef) => worktreeDiffNames(workspace, baseRef),
        serve: (repoRoot) => serveBuild(repoRoot, { logger: shotLog }),
        screenshot: captureScreenshot,
        attach: attachScreenshot,
        logger: shotLog,
      }),
    );
  }

  // The quick extension's init built the ONE runner every surface shares. Phase 3 keeps the
  // concierge's quick.run/quick.list bus command bodies v5-shaped (bus-characterization pins
  // their not-wired refusal), so the runner still arrives through the setter.
  const quick = quickExtension.runner();
  concierge.setQuickRunner(quick);

  // The memory extension's init built the ONE warm store. Phase 6 keeps the concierge's
  // `memory.recall` bus command body v5-shaped (like the browser.* verbs), so the store still
  // arrives through a setter — the lazy in-concierge construction is gone (a second warm graph
  // would silently diverge from this one).
  concierge.setMemoryStore(memoryExtension.store());

  // Ops visibility (issue #30): the `beckett status` bus command answers from this assembler —
  // the daemon-wide halves the Concierge can't see itself. The Concierge merges in its own
  // (Discord gateway, session) when serving the command.
  const bootedAt = Date.now();
  concierge.setStatusProvider(async () => ({
    version: BECKETT_VERSION,
    commit: (await currentGitCommit(join(import.meta.dir, "..", ".."))).short,
    pid: process.pid,
    uptimeSecs: Math.round((Date.now() - bootedAt) / 1000),
    workers: dispatcher.statusWorkers(),
    quick: quick.stats(),
    browser: browser.stats(),
    browserAgent: browserAgent.stats(),
    extensions: await extensions.health(),
    poller: {
      boards: Object.fromEntries([...pollers].map(([board, p]) => [board, p.stats()])),
      ...poller.stats(),
    },
    githubPr: prPoller ? prPoller.stats() : null,
    githubActivity: activityPoller ? { repo: activityConfig.repo, branch: activityConfig.branch } : null,
    tracker: {
      baseUrl: boredBaseUrl(),
      defaultBoard: config.tracker.default_board,
      boards: Object.fromEntries([...clients].map(([board, c]) => [board, c.stats()])),
      ...client.stats(),
    },
  }));

  // Start the Concierge FIRST (of the live parts) so a bad claude launch fails the whole boot
  //    before we begin polling. (Constructed above so its progress sink could be wired in.)
  await concierge.start();

  // ── Voice transport (#81) ──────────────────────────────────────────────────────────────────
  // Join/leave a voice channel, receive per-speaker audio, play audio back — TRANSPORT ONLY (no
  // STT/TTS in this branch). It rides the SAME gateway connection (a bot has one WebSocket; voice
  // uses that guild's adapter), so it is wired here, after the gateway is live via concierge.start.
  //
  // Authorization mirrors the four elevated verbs EXACTLY: owner + maintainers only, resolved
  // from Discord's AUTHENTICATED author id via the same classify()/access.txt/maintainers.txt
  // machinery the rest of the daemon uses — never from chat content. The gate is code-enforced
  // inside VoiceGateway (see canControlVoice).
  const voiceOwnerId = (): string | undefined => process.env.DISCORD_OWNER_ID?.trim() || undefined;
  const authorizeVoice = (userId: string): AccessLevel => {
    try {
      return classify(userId, voiceOwnerId(), loadAccess(paths.accessFile), loadMaintainers(paths.maintainersFile));
    } catch (err) {
      logger.warn("voice authorize classify failed; treating as outsider", { userId, error: String(err) });
      return "outsider";
    }
  };
  // The @discordjs/voice backend is imported LAZILY so a box missing its optional native/opus/
  // encryption deps degrades to "voice join fails with a clear error" rather than failing boot.
  const voiceBackendFactory: VoiceBackendFactory = async ({ guildId, channelId }) => {
    const client = gateway instanceof DiscordJsGateway ? gateway.discordClient() : undefined;
    if (!client) throw new Error("discord gateway not started; cannot join voice");
    const { createDiscordVoiceBackendFactory } = await import("../discord/voice/backend-discordjs.ts");
    return createDiscordVoiceBackendFactory(client, { logger: logger.child("voice.backend") })({
      guildId,
      channelId,
    });
  };
  const voiceGateway = new VoiceGateway({
    backendFactory: voiceBackendFactory,
    authorize: authorizeVoice,
    logger: logger.child("voice"),
  });

  // The dashboard is one durable message in the existing cards channel. Its collector owns all
  // I/O; the renderer remains a pure snapshot → embed function.
  const statusCollector = createStatusSnapshotCollector({
    version: BECKETT_VERSION,
    pollIntervalMs: config.tracker.poll_secs * 1_000,
    poller,
    tracker: client,
    metrics: createSystemMetricsReader(),
    lifecycleLedgerPath,
    spendPath: paths.spend,
  });
  // Bot presence + desktop RPC, both driven off the SAME status-snapshot tick (#132). One deriver,
  // two sinks: the gateway bot user (discord.js setPresence) and ~/.beckett/rpc-status.json (the
  // {details,state} shape the untouched RPC daemon in src/rpc/daemon.ts already reads). The
  // controller only emits on a real change and rate-floors sends; both sinks catch their own errors.
  const rpcStatusPath = join(beckettDir, "rpc-status.json");
  const presenceController = new PresenceController({
    logger: logger.child("discord.presence"),
    sinks: {
      setPresence: (data) => {
        const client = gateway instanceof DiscordJsGateway ? gateway.discordClient() : undefined;
        client?.user?.setPresence(data);
      },
      writeStatus: (payload) => {
        mkdirSync(dirname(rpcStatusPath), { recursive: true });
        const tmp = `${rpcStatusPath}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
        renameSync(tmp, rpcStatusPath);
      },
    },
  });
  const statusDashboard = createStatusDashboardService({
    gateway,
    // The env-overridable cards channel (`disabled` → null): the staging daemon (#141) runs the
    // dashboard for its presence/rpc side effects but posts nothing into prod's cards channel.
    channelId: cardsChannelId(),
    statePath: statusDashboardMessagePath(beckettDir),
    collectSnapshot: async () => {
      const snapshot = await statusCollector.collect();
      // Assemble the board off in-memory stats already gathered this tick — no extra poll of the
      // tracker. `update` is fire-and-forget (it never rejects) so a presence hiccup cannot stall
      // or fail the dashboard cycle.
      const browser = browserAgent.stats();
      const inputs: PresenceInputs = {
        degraded: snapshot.health.some((h) => h.reachable === false),
        deployInFlight: isDeployActive(beckettDir),
        browserRunLive: browser.running > 0 || browser.waiting > 0,
        branchesInFlight: dispatcher.statusWorkers().filter((w) => w.state === "live").length,
      };
      void presenceController.update(inputs);
      return snapshot;
    },
    logger: logger.child("status.dashboard"),
  });
  await statusDashboard.start();
  if (prPoller) {
    // Re-arm the watch list after a restart. Two sources, both restored here. (1) Hand-opened PRs
    // (`beckett gh pr create`, #31) live ONLY in the poller's own persisted registry
    // (github-prs.json) — its constructor already re-loaded them via `load()`, so they survive a
    // restart with no work needed in this loop. (2) Task-branch PRs live in the task store, a
    // separate file, and are re-watched below.
    //
    // This loop used to skip every task with no `threadId` and route the rest at that thread, which
    // made sense only while Beckett opened a thread per task: under the user-owned thread model
    // `threadId` is almost never set (`&12` writes the workspace registry, not the task), so the
    // skip silently stopped watching nearly every open PR across a restart. Watch them all and stamp
    // the ORIGIN channel as the fallback; the live destination is resolved per event in
    // `Concierge.channelForPr`, which consults the workspace registry. Re-watching is safe: a known
    // PR only refreshes its routing, and a newly-seeded one records its current state and emits
    // nothing.
    for (const task of tasks.list()) {
      for (const branch of task.branches) {
        if (!branch.pullRequest || !branch.ticket) continue;
        prPoller.watch({
          repo: branch.pullRequest.repo,
          number: branch.pullRequest.number,
          url: branch.pullRequest.url,
          title: branch.title,
          ticket: branch.ticket.identifier,
          channel: task.threadId ?? task.originChannelId,
        });
      }
    }
  }
  await dispatcher.replayAdvances();
  await dispatcher.replayPublishes();
  // Reconciling dependents reads the board; a board-less instance (#141) has none to reconcile.
  if (config.tracker.enabled) await dispatcher.reconcileDependents();

  // Crash recovery (issue #20): BEFORE the poller re-staffs anything, sweep worker processes a
  // crashed daemon orphaned, commit their ghost WIP, and arm session-resume hints so re-staffed
  // tickets continue their interrupted sessions instead of re-running from scratch.
  await dispatcher.recoverFromCrash();

  // Blip-proofing (OPS-125): with recovery done, arm the periodic worktree-checkpoint loop so a
  // HARD crash (SIGKILL / OOM / power) — where the graceful shutdown drain never runs — loses at
  // most one checkpoint window of in-flight WIP, not the whole session. The graceful path
  // (drainForShutdown) still commits WIP itself and stops this loop first.
  dispatcher.startCheckpointLoop();

  // Staffing watchdog (issue #9): arm the reconciliation pass that re-staffs — or, failing that,
  // parks with a comment — any ticket left silently staffed-but-workerless (the mid-spawn discard
  // race, or any other wedge). Runs after crash recovery so it never races the boot re-staff sweep.
  dispatcher.startStaffingWatchdog();

  // EARLY extension background loops start here — after crash recovery (so a migrated organ
  // never races the recovery block) and BEFORE the pollers, which stay last so events only flow
  // once everything else is ready to consume them. The browser agent's recover() rides this
  // sweep (issue #58): stranded runs re-report into the now-live concierge, queued runs
  // re-queue. Organs whose loops DISPATCH into the live system (schedulers) start in the
  // "late" sweep further down instead — see LifecycleStartPhase.
  await extensions.startAll(extCtx, "early");

  // Fan each board's poll batch to BOTH the dispatcher (acts on the work) and the Concierge
  // (surfaces milestones/errors back to the Discord conversation that filed the ticket). A
  // board-less instance (#141) never arms the pollers — nothing to poll, nothing to dispatch.
  if (config.tracker.enabled) await Promise.all(
    [...pollers].map(([board, p]) =>
      p.start((events) => {
        rememberRouting(events.map((event) => event.ticket), board);
        for (const event of events) {
          if (!event.ticket.branchRef) continue;
          void syncTaskBranch(event.ticket, board).catch((err) =>
            logger.warn("task branch poll sync failed", { branch: event.ticket.branchRef, error: String(err) })
          );
        }
        concierge.notify(events);
        return dispatcher.handle(events);
      }),
    ),
  );
  // GitHub PR sense (OPS-124): start watching after the dispatcher is live, so any PR opened during
  // boot recovery already has a home. Each material transition lands as a Concierge update turn —
  // the same routing as ticket updates. Best-effort: a poll failure never affects the rest.
  if (prPoller) {
    await prPoller.start((events) => concierge.notifyPrEvents(events));
  }
  if (activityPoller) {
    await activityPoller.start((events) => concierge.relayGitHubActivity(events, activityConfig.channel_id));
  }

  // OPS-173: AgentMail has no public daemon endpoint to register against (this service exposes
  // only its local Unix control socket), so use the durable polling fallback. The first poll is a
  // silent watermark; later IDs produce one queued SYSTEM turn through Concierge.notifyIncomingEmail.
  let mailPoller: AgentMailPoller | null = null;
  const agentMailApiKey = process.env.AGENTMAIL_API_KEY?.trim();
  if (agentMailApiKey) {
    try {
      mailPoller = createAgentMailPoller({
        api: createAgentMailApi(agentMailApiKey),
        inboxStateFile: defaultMailStateFile(beckettDir),
        stateFile: defaultMailListenerStateFile(beckettDir),
        onIncomingEmail: (email) => concierge.notifyIncomingEmail(email),
      });
      await mailPoller.start();
      logger.info("AgentMail incoming-email poller online");
    } catch (err) {
      // Email notify is additive: a transient AgentMail outage must not prevent Discord/tickets
      // from coming up. Keep SDK errors redacted just as the mail CLI does.
      logger.warn("AgentMail incoming-email poller failed to start", {
        error: safeMailError(err, agentMailApiKey),
      });
      mailPoller?.stop();
      mailPoller = null;
    }
  } else {
    logger.info("AgentMail incoming-email poller disabled (AGENTMAIL_API_KEY is not set)");
  }

  // Memory self-healing (OPS-121) now lives in the memory extension (Phase 6): the daily
  // maintain loop arms in the LATE startAll sweep below and stops inside extensions.stopAll.

  // Agent registry (issue #66): reusable worker personas defined/added WITHOUT a daemon redeploy —
  // agents.json is read LIVE (defensively; a bad/partial file logs-and-skips, never crashes the
  // daemon) every time the concierge enumerates OR a routine invokes an agent. This is the runtime
  // discovery surface #55.3 builds on.
  const agentRegistry = new LiveAgentRegistry(join(beckettDir, "agents.json"), {
    logger: logger.child("agent"),
  });
  concierge.setAgentRegistry(agentRegistry);

  // The generic invoke-lane (issue #55/#72): runs ANY registered agent by its definition. The
  // routine dispatcher below uses it to run the `social-media` agent, which AUTHORS the post; the
  // routine never composes text itself. Adding a future agent is `beckett agent add` — this runner
  // already knows how to run it, no core edit.
  const agentRunner = createAgentRunner({ config, logger: logger.child("agent-run") });

  // Routines (issue #62) live in the routines extension (Phase 3b): store, dispatcher closure,
  // cron loop, and the 5s prime all moved there — the loop arms in the LATE startAll sweep just
  // below, after the agent registry/runner above exist. Serve `beckett routine fire … --force`
  // from the control bus (a real, live dispatch) through the extension's scheduler accessor;
  // the dry-run path is CLI-local (build the plan, no daemon) so it can prove wiring with no post.
  concierge.setRoutineOps({
    fire: (id, opts) => routinesExtension.scheduler().fireNow(id, opts),
  });

  // LATE extension background loops start here — the whole live system (pollers, mail, agent
  // registry/runner) is up, so a scheduler whose fires DISPATCH into it can never race its own
  // dependencies. This is the sanctioned start position for startPhase: "late" organs (the
  // routine cron scheduler, Phase 3b; the memory maintain loop, Phase 6).
  await extensions.startAll(extCtx, "late");

  logger.info("beckett v4 online", { liveWorkers: dispatcher.live().length, boards: [...pollers.keys()] });

  return { config, logger, client, clients, poller, pollers, prPoller, activityPoller, mailPoller, dispatcher, concierge, voiceGateway, statusDashboard, quick, browserAgent, browser, extensions, lifecycleLedgerPath };
}

/** Tear the system down in reverse boot order. Best-effort: one failure never blocks the rest. */
async function shutdown(sys: BootedSystem, signal: string): Promise<void> {
  sys.logger.info("shutting down beckett v3", { signal });
  // The routine scheduler (Phase 3b) and the memory maintain loop (Phase 6) now stop inside
  // the extensions.stopAll sweep below — AFTER the pollers stop, not before them as the
  // hand-wired first-line stops used to. A clearInterval landing a beat later is accepted
  // (sanctioned in the v6 design resolution): routine fires stay per-period idempotent, and a
  // straggler maintain pass is serialized + best-effort by construction. Memory registered
  // LAST, so its stop runs FIRST in the reverse sweep.
  sys.statusDashboard.stop();
  // Leave any voice channel before the gateway goes down so Beckett doesn't linger connected.
  try {
    await sys.voiceGateway.leaveAll();
  } catch (err) {
    sys.logger.warn("voice leaveAll on shutdown failed", { error: (err as Error).message });
  }
  sys.prPoller?.stop();
  sys.activityPoller?.stop();
  sys.mailPoller?.stop();
  for (const p of sys.pollers.values()) p.stop();
  // Mirrors startAll's boot position (just before the pollers started). The registry sweep is
  // best-effort per organ — a throwing stop is logged, never blocks the rest of the drain.
  // The browser organ tears down inside this sweep: agent.stopAll settles live runs as errors
  // (their outcomes still route through the still-live concierge below), THEN the host dies.
  // The quick organ (Phase 3) drains here too: stragglers are killed ahead of concierge.stop
  // below, so their "daemon shut down" results can still route through it.
  await sys.extensions.stopAll(sys.logger);
  try {
    const drain = await sys.dispatcher.drainForShutdown(signal, 20_000);
    if (drain.timedOut) {
      sys.logger.warn("dispatcher shutdown drain did not finish before deadline", { ...drain });
    }
  } catch (err) {
    sys.logger.warn("dispatcher shutdown drain failed", { error: (err as Error).message });
  }
  try {
    await sys.concierge.stop();
  } catch (err) {
    sys.logger.warn("concierge shutdown failed", { error: (err as Error).message });
  }
  try {
    recordCleanShutdown(sys.lifecycleLedgerPath);
  } catch (err) {
    sys.logger.warn("uptime ledger clean-shutdown append failed", { error: (err as Error).message });
  }
}

/** Boot the system and install graceful-shutdown signal handlers. */
async function main(): Promise<void> {
  // A clean public install deliberately has no Discord token or subscription login yet. Do not
  // crash-loop while the operator completes those browser/device logins: expose a tiny status-only
  // daemon instead. Once every required item exists, the next service restart takes the normal boot.
  const config = loadConfig();
  const configurationProblems = pendingConfigurationProblems(config);
  if (configurationProblems.length > 0) {
    const stopPending = startPendingConfigurationDaemon({
      config,
      version: BECKETT_VERSION,
      problems: configurationProblems,
    });
    rootLog.child("shell.v4").warn("healthy-pending-configuration", { problems: configurationProblems });
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        stopPending();
        process.exit(0);
      });
    }
    return;
  }

  const sys = await boot();

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      void shutdown(sys, sig).finally(() => process.exit(0));
    });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    rootLog.child("shell.v4").error("beckett v4 failed to start", { err: String(err) });
    process.exit(1);
  });
}

export { boot, shutdown, main, resolveRepoRoot };
export type { BootedSystem };
