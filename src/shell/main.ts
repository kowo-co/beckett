/**
 * Beckett — the shell entrypoint (`src/shell/main.ts`)
 * =======================================================================================
 * Boots the daemon and wires its moving parts together:
 *
 *   1. Config + env — `loadConfig()` reads `~/.beckett/config.toml` and `~/.beckett/.env`.
 *   2. RunStore — the run ledger at `<beckettDir>/runs.json`, written by `beckett task deploy`.
 *   3. RunSupervisor — the engine: admits runs off the `run.deploy` bus ping, spawns
 *      implement/review workers, steers them, publishes, and advances run state on finish.
 *   4. Concierge — the long-lived `claude -p` chat agent that owns Discord and deploys runs.
 *
 * The Concierge and the run engine are independent: the Concierge deploys work by writing a run
 * (one CLI call) and pinging the bus; the supervisor acts on it. They never call each other
 * directly — the run ledger is the shared queue.
 *
 * Run it with `bun run v4` (see package.json) or `bun src/shell/main.ts`. The `v4` script name
 * and the `beckett-v4.service` unit are kept for continuity with the 4.0.0 multiplayer release;
 * only the file was renamed from `v4-main.ts` (see docs/ARCHITECTURE.md "Entrypoint & cutover").
 *
 * Import style (whole repo, bun-native): explicit `.ts` extensions, ESM.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config.ts";
import { buildPaths } from "../paths.ts";
import { readPause } from "../pause.ts";
import { seedCompanyBrief } from "../company.ts";
import { recordBoot, recordCleanShutdown, uptimeLedgerPath } from "../uptime.ts";
import { log as rootLog } from "../log.ts";
import type { Config, Harness, Logger } from "../types.ts";
import { RunStore } from "../run/store.ts";
import type { CiVerdict, RunState } from "../run/types.ts";
import { createRunSupervisor, runProjectSlug, runSpecReader, type RunSupervisor } from "../run/supervisor.ts";
import { createStagesExtension, stageViewOf } from "../dispatch/stages.ts";
import { createProgressCardService, shouldObserveRunCard, type ProgressCardService } from "../progress/cards.ts";
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
import { defaultKeychainStore } from "../secret/keychain.ts";
import { createCapabilityPreflight } from "../capability/preflight.ts";
import { GitHubCli, githubAuth, githubConfigured, loadIdentity } from "../agency/index.ts";
import { resolveProjectOwner } from "../github/owner.ts";
import { LiveAgentRegistry } from "../agent/registry.ts";
import { createAgentRunner } from "../agent/invoke.ts";
import { TaskStore } from "../task/store.ts";
import { createBranchStatusService } from "../task/status.ts";
import { createRunTaskSync } from "../task/run-sync.ts";
import { createAgentMailApi, defaultMailStateFile, safeMailError } from "../mail/index.ts";
import { createAgentMailPoller, defaultMailListenerStateFile, type AgentMailPoller } from "../mail/listener.ts";
import { ExtensionRegistry, type ExtensionContext } from "../ext/index.ts";
import { opsLogEnabled, startOpsLogSink, type OpsLogSink } from "../ops-log/index.ts";
import { ActionClass } from "../capability/index.ts";
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
 * Root under which every run builds its OWN project repo — one directory per code project,
 * e.g. `~/Projects/balloons`. Override via `BECKETT_PROJECTS_ROOT`.
 */
const PROJECTS_ROOT = process.env.BECKETT_PROJECTS_ROOT?.trim() || join(homedir(), "Projects");

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
  prPoller: GitHubPrPoller | null;
  activityPoller: GitHubActivityPoller | null;
  mailPoller: AgentMailPoller | null;
  /** The run engine (`src/run/supervisor.ts`) — the daemon's only staffing loop. */
  runSupervisor: RunSupervisor;
  concierge: Concierge;
  voiceGateway: VoiceGateway;
  statusDashboard: StatusDashboardService;
  quick: QuickRunner;
  browserAgent: BrowserAgent;
  browser: BrowserRuntime;
  extensions: ExtensionRegistry;
  lifecycleLedgerPath: string;
  opsLog: OpsLogSink | null;
}

/**
 * Construct and start the whole stack. Returns the booted system so the caller can wire shutdown.
 * The Concierge is started first (fail fast on a bad `claude` launch); the run supervisor starts
 * after crash recovery so nothing re-staffs into a half-built system.
 */
async function boot(): Promise<BootedSystem> {
  const config = loadConfig();
  const logger = rootLog.child("shell.v4");

  logger.info("booting beckett v4", {
    version: BECKETT_VERSION,
    conciergeModel: config.concierge.model,
    projectsRoot: PROJECTS_ROOT,
  });

  // Deterministic GitHub publishing: when a run reaches done, its project repo is pushed to
  // `<owner>/<slug>` (public) so the links Beckett hands out actually resolve — instead of
  // relying on the worker to push, which it skipped and left repos that 404'd. Built from the
  // GitHub identity; no credential makes it undefined → the supervisor skips publishing and says so.
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
  // merge signal back to the run's channel. Registry-driven — the supervisor's `onPrOpened` hook
  // (below) registers each PR at open time with its origin channel. Read-only: it observes and
  // relays, never replies or merges. Skipped without a credential (nothing to read GitHub with).
  const paths = buildPaths(config);
  const beckettDir = paths.beckettDir;
  seedCompanyBrief(paths.companyFile, logger);
  // Lifecycle history starts now; a previous unmatched boot becomes an explicit unclean restart.
  // `recordBoot`'s own boot event `at` is captured here and threaded into the status provider
  // below as the ONE canonical boot instant (issue #248 review finding 1): before this, the
  // ledger line and the status provider's `bootedAt` were two independent `Date.now()` reads
  // taken milliseconds apart, so `beckett status deploy-state`'s exact-match corroboration check
  // could never pass in production. Single source now — they're identical by construction, not
  // by coincidence.
  const lifecycleLedgerPath = uptimeLedgerPath(beckettDir);
  const bootEvents = recordBoot(lifecycleLedgerPath);
  const bootedAtIso = bootEvents[bootEvents.length - 1]!.at;
  const bootedAtMs = Date.parse(bootedAtIso);
  // Same fix, same shape, for the OTHER daemon-truth field (finding 2): read the running code's
  // commit ONCE, right here at boot, instead of re-running `git rev-parse` inside the status
  // provider on every call. A fresh `git rev-parse` mid-deploy-window (new commit checked out on
  // disk, old daemon process still answering) would report the NEW commit next to the OLD boot
  // time — the mirror image of the incident issue #248 exists to close. This daemon serves the
  // commit it was actually built and started from, for its whole lifetime.
  const commitAtBoot = (await currentGitCommit(join(import.meta.dir, "..", ".."))).short;
  const tasks = new TaskStore(join(beckettDir, "tasks.json"));
  // The Concierge and dashboard deliberately share this one gateway connection.
  const gateway = createDiscordGateway({ config, logger: logger.child("discord") });

  // Discord ops-log mirror (OPS-231): "log everything in the ops channel … robust, expressive,
  // legible." OFF by default (a fresh/local install stays silent); the deploy config's own
  // [ops_log] section is what turns it on for the owner's box, same posture as `announce` and
  // `github.activity` above. Registered early (right after the gateway exists) so it can mirror
  // everything that follows, including the rest of boot.
  const opsLog: OpsLogSink | null =
    opsLogEnabled(config.ops_log)
      ? startOpsLogSink({
          config: config.ops_log,
          post: (channelId, content) => gateway.post(channelId, content),
          logger,
        })
      : null;
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

  // Concierge — owns Discord (and the private run journal the supervisor feeds). Constructed here
  // (cheap, no I/O) so its progress sink can be wired into the supervisor below; started further
  // down (FIRST of the live parts) so a bad claude launch fails the whole boot early.
  const concierge = createConcierge({
    config,
    logger: logger.child("concierge"),
    gateway,
    tasks,
    branchStatus: createBranchStatusService({
      store: tasks,
      ...(githubReader ? { github: githubReader } : {}),
      githubOwner: identity.github.owner,
    }),
  });

  // The v6 extension seam (docs/v6-architecture.md §6): the ONE runtime registry the daemon
  // dispatches extensions through — `ext.invoke`/`ext.catalog` on the control bus read it via
  // the concierge. Constructed BEFORE the run supervisor (worker stages resolve through this
  // registry); the stateful organs register further down, once their collaborators exist.
  // Registration order is teardown-reverse, and must honor concierge-first/pollers-last for
  // organs that migrate.
  const extensions = new ExtensionRegistry();
  const extCtx: ExtensionContext = { config, paths, logger };
  // The worker-stages facet: the built-ins (implement/review) as ONE core-kind extension. Stateless, no capabilities (never @mention-routed, absent from
  // the catalog), so registering it first constrains no lifecycle ordering below.
  extensions.register(createStagesExtension(extCtx));

  // The run ledger — constructed before the card service, which needs it for the checklist reader.
  const runStore = new RunStore(join(beckettDir, "runs.json"));
  // Zero-token progress cards: CODE keeps one status message per active run, edited straight off
  // the dispatch event bus — no Concierge involvement, honoring "the Concierge and the run engine
  // never call each other directly". Channel: the event's stamped originChannel, else the task
  // registry's thread/origin (same precedent as the PR re-watch loop below). `runs.cards`
  // (default ON — the deploy receipt) is the one switch.
  const runCardsEnabled = config.runs?.cards ?? true;
  const progressCards: ProgressCardService | null = runCardsEnabled
    ? createProgressCardService({
        gateway,
        statePath: join(beckettDir, "progress-cards.json"),
        resolveChannel: (event) => {
          if (event.channel) return event.channel;
          const hit = tasks.findByRun(event.runId) ?? tasks.findByRun(event.runRef);
          return hit ? hit.task.threadId ?? hit.task.originChannelId ?? null : null;
        },
        // The run card's checklist line (spec.md progress) — cards.ts stays fs-free, this reads
        // the run's live workspace off the same store the run engine drives.
        specReader: runSpecReader(runStore),
        logger: logger.child("progress-cards"),
      })
    : null;

  // The task registry ↔ run engine bridge (`../task/run-sync.ts`): what keeps `beckett task list`,
  // the #104 task card, the branch card and the Merge button moving as a run works. Without it a
  // started branch sits at "ready" forever — see that module's header for the whole rationale.
  const taskSync = createRunTaskSync({
    tasks,
    projectSlugOf: runProjectSlug,
    githubOwner: identity.github.owner,
    logger: logger.child("task-sync"),
  });

  // The capability preflight's browser-lane probe (overhaul B10). `browserExtension` is
  // constructed AFTER the supervisor (its lifecycle callbacks close over the concierge), so this
  // is a late-bound closure: null until the extension exists, and reads as healthy while it does
  // — a run's admission must never treat "not built yet" as "the lane is down".
  let browserLaneHealth: (() => { ok: boolean; detail: string }) | null = null;
  const capabilityPreflight = createCapabilityPreflight({
    ...(githubAuth(identity).app ? { github: githubAuth(identity).app! } : {}),
    keychain: defaultKeychainReader,
    browserLane: () => browserLaneHealth?.() ?? { ok: true, detail: "unknown" },
  });

  // B12: does a run's PR still resolve, and what did CI say (`RunSupervisor.finalizePublish`'s
  // `assembleProof`). Wired only when a GitHub credential is configured — the exact condition
  // `prPoller` above already keys on — so an install with none degrades `prResolves` to `null`
  // ("not asserted"), never to a false `unverified`.
  const verifyPr = githubReader
    ? async (prUrl: string) => {
        const parsed = parsePrUrl(prUrl);
        if (!parsed) throw new Error(`could not parse a repo/number out of PR url: ${prUrl}`);
        const signals = await githubReader.prSignals(parsed.repo, parsed.number);
        const ci: CiVerdict =
          signals.checkConclusion === "SUCCESS"
            ? "success"
            : signals.checkConclusion === "FAILURE"
              ? "failed"
              : signals.checkConclusion === "PENDING"
                ? "pending"
                : "none";
        return { resolves: signals.state !== "CLOSED", ci };
      }
    : undefined;

  // The RUN engine — `beckett task deploy` files a Run, and this drives it implement → review →
  // publish → done. It is the daemon's ONLY staffing loop.
  const runSupervisor = createRunSupervisor({
    store: runStore,
    config,
    stages: stageViewOf(extensions),
    // `run.repo === null` is BECKETT ITSELF, not a per-run sandbox: the flagship default
    // (`beckett task deploy "…"` with no --repo) must land in Beckett's own checkout. The slug
    // resolver is shared with the supervisor so the repo root and the publish target can never
    // point at two different repositories.
    resolveRepoRoot: (run) => join(PROJECTS_ROOT, runProjectSlug(run)),
    publishRepo,
    ...(verifyPr ? { verifyPr } : {}),
    // `frontendProof` (a UI screenshot for `runs` with `uiWork: true`) is intentionally NOT wired
    // — `../preview/screenshot.ts#createFrontendScreenshotHook` has no production caller yet and
    // wiring it needs a one-shot browser capture this daemon does not have a small seam for.
    // Omitted degrades `screenshotPath` to `null` (a named gap on UI-touching runs), never to a
    // false `unverified` on non-UI work — see `RunSupervisorDeps.frontendProof`'s doc comment.
    capabilityPreflight,
    progress: concierge.progressSink(),
    dispatchEventsPath: join(paths.eventsDir, "dispatch.jsonl"),
    dispatchLiveSink: (event) => {
      // `runs.cards` (default ON) is this lane's own switch — the deploy receipt posts
      // independently of the ticket dispatcher's `progress.cards_as_code` above.
      if (shouldObserveRunCard(progressCards, runCardsEnabled)) void progressCards?.observe(event);
      return concierge.postDispatchEvent(event);
    },
    publishOutboxPath: join(beckettDir, "run-publish-outbox.jsonl"),
    runtimeStatePath: join(beckettDir, "run-state.json"),
    spendLedgerPath: paths.spend,
    pauseFilePath: paths.pauseFile,
    preflight: (harness) => preflightFor(harness, config),
    // The closed loop: every run transition reaches the concierge, which decides whether it is
    // worth telling the person who asked. Fire-and-forget by contract — the supervisor logs and
    // continues if this throws, so a Discord hiccup can never wedge the engine.
    onStateChange: (event) => {
      // The user-facing board first (fire-and-forget, same contract), then the voice.
      void taskSync.onStateChange(event);
      concierge.notify(event);
    },
    onPrOpened: ({ prUrl, run }) => {
      const parsed = parsePrUrl(prUrl);
      if (!parsed) return;
      // The task registry's PR link: what puts the artifact on the card and arms the Merge
      // button, what `concierge.stampPrState` updates on merge/close, and what the boot PR
      // re-watch loop below scans for. Recorded whether or not a poller exists.
      void taskSync.onPrOpened(run, { repo: parsed.repo, number: parsed.number, url: prUrl });
      if (!prPoller) return;
      prPoller.watch({
        repo: parsed.repo,
        number: parsed.number,
        url: prUrl,
        title: run.title,
        // The PR poller is keyed by the RUN id — its relays land on the run's own channel.
        runId: run.id,
        ...(run.channelId ? { channel: run.channelId } : {}),
      });
    },
    onPublished: ({ url, kind, prUrl, run }) => void taskSync.onPublished(run, { url, kind, prUrl }),
    logger: logger.child("run"),
  });
  // `beckett task deploy` pings `run.deploy` on the control bus; `beckett task steer` pings
  // `run.steer`; `beckett task cancel` (and the task card's Cancel button) pings `run.cancel`.
  // Registered post-construction because the supervisor needs the concierge's progress sink, so it
  // cannot exist when the concierge builds its own bus surface.
  concierge.registerBusCapability({
    id: "runs",
    summary: "v7 runs: deploy admission, mid-flight steering, and cancellation",
    actionClass: ActionClass.FREE,
    cliVerbs: [],
    busCommands: [
      {
        name: "run.deploy",
        summary: "admit a freshly-created run for staffing",
        handle: async (req) => {
          const runId = typeof req.args.runId === "string" ? req.args.runId.trim() : "";
          if (!runId) return { ok: false, error: "run.deploy needs a runId" };
          // THREAD GROUNDING: work deployed from inside a workspace thread binds to it here, at
          // the one moment both ids are in hand (`task deploy` stamps the channel onto the ping).
          // Without this a thread's runIds stay empty, so an unmentioned "how's it going?" has no
          // run to name and updates fall back to the run's stamped channel.
          const channelId = typeof req.args.channelId === "string" ? req.args.channelId.trim() : "";
          if (channelId) concierge.bindRunToWorkspace(channelId, runId);
          await runSupervisor.admit(runId);
          return { ok: true, data: { runId } };
        },
      },
      {
        name: "run.cancel",
        summary: "stop a live run: abort its worker and mark it cancelled",
        handle: async (req) => {
          const runId = typeof req.args.runId === "string" ? req.args.runId.trim() : "";
          if (!runId) return { ok: false, error: "run.cancel needs a runId" };
          const reason = typeof req.args.reason === "string" && req.args.reason.trim() ? req.args.reason.trim() : undefined;
          const outcome = await runSupervisor.cancel(runId, reason);
          if (outcome === "unknown") return { ok: false, error: `no such run: ${runId}` };
          return { ok: true, data: { runId, outcome } };
        },
      },
      {
        name: "run.courier",
        summary: "a human published this run's work by hand: mark it done/shipped (couriered), never cancelled",
        handle: async (req) => {
          const runId = typeof req.args.runId === "string" ? req.args.runId.trim() : "";
          if (!runId) return { ok: false, error: "run.courier needs a runId" };
          const prUrl = typeof req.args.prUrl === "string" ? req.args.prUrl.trim() : "";
          if (prUrl && !/\/pull\/\d+(?:$|[/?#])/.test(prUrl)) {
            return { ok: false, error: `run.courier --pr-url must be a pull-request URL (…/pull/<n>), got: ${prUrl}` };
          }
          const outcome = await runSupervisor.courier(runId);
          if (outcome === "unknown") return { ok: false, error: `no such run: ${runId}` };
          if (outcome === "not-eligible") {
            return { ok: false, error: `run ${runId} is not publishing or parked — nothing for a courier to have shipped` };
          }
          if (prUrl && (outcome === "done" || outcome === "already-terminal")) {
            await runSupervisor.backfillCourierPrUrl(runId, prUrl);
          }
          return { ok: true, data: { runId, outcome, ...(prUrl ? { prUrl } : {}) } };
        },
      },
      {
        name: "run.steer",
        summary: "deliver a note to a live run (nudge), or buffer it for its next stage",
        handle: async (req) => {
          const runId = typeof req.args.runId === "string" ? req.args.runId.trim() : "";
          const note = typeof req.args.note === "string" ? req.args.note : "";
          if (!runId || !note.trim()) return { ok: false, error: "run.steer needs a runId and a note" };
          const delivery = await runSupervisor.steer(runId, note);
          return { ok: true, data: { runId, delivery } };
        },
      },
      {
        name: "run.resume",
        summary:
          "clear a parked run's blocker and re-staff the stage it was held from, or answer an awaiting_input run's question",
        handle: async (req) => {
          const runId = typeof req.args.runId === "string" ? req.args.runId.trim() : "";
          if (!runId) return { ok: false, error: "run.resume needs a runId" };
          const note = typeof req.args.note === "string" && req.args.note.trim() ? req.args.note.trim() : undefined;
          const answer = typeof req.args.answer === "string" ? req.args.answer : undefined;
          const outcome = await runSupervisor.resume(runId, { note, answer });
          if (outcome === "unknown") return { ok: false, error: `no such run: ${runId}` };
          if (outcome === "not-parked") return { ok: false, error: `run ${runId} is not parked — nothing to resume` };
          if (outcome === "not-awaiting") {
            return {
              ok: false,
              error: `run ${runId} is not awaiting_input — nothing to answer (use --note instead of --answer)`,
            };
          }
          if (outcome === "publish-blocked") {
            return {
              ok: false,
              error: `run ${runId} parked mid-publish — use \`beckett task courier ${runId}\` instead of resume`,
            };
          }
          return { ok: true, data: { runId, resumed: true } };
        },
      },
    ],
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
    keychainStore: defaultKeychainStore,
    onQuestion: (run, question) => concierge.notifyBrowserQuestion(run, question),
    onOutcome: (run) => concierge.notifyBrowserOutcome(run),
  })({ config, paths, logger });
  extensions.register(browserExtension);
  // Backfills the capability preflight's late-bound probe (declared above the supervisor,
  // before this extension existed) now that `lifecycle.health` is reachable. The browser
  // module's own `health()` is synchronous (`src/capability/modules/browser.ts`) even though the
  // generic `ExtensionLifecycle` contract allows an async one — cast rather than widen the
  // preflight's dep type to a Promise it never actually returns here.
  browserLaneHealth = () => {
    const h = browserExtension.lifecycle?.health?.() as { ok: boolean; detail?: string } | undefined;
    return h ? { ok: h.ok, detail: h.detail ?? "" } : { ok: true, detail: "unknown" };
  };
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
    // The free-time idle gate (docs/freetime.md), read at fire time: an unprompted session waits
    // for a machine with nothing else to do. Both are cheap in-memory census reads — the
    // scheduler asks them on the tick that would otherwise claim the period.
    isFleetIdle: () => runSupervisor.live().length === 0,
    conciergeQuiet: () => concierge.queueDepth() === 0,
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
  concierge.setStatusProvider(async () => ({
    version: BECKETT_VERSION,
    // Boot-captured (see above), never a fresh `git rev-parse` per call — process truth, not
    // disk truth, for the whole life of this daemon.
    commit: commitAtBoot,
    pid: process.pid,
    // Absolute boot time (issue #248), not just elapsed seconds: "up since T" is what lets a
    // reader compare THIS daemon's boot against a deploy's timestamp without doing clock math
    // against whenever the status call happened to run. `beckett status deploy-state` is the
    // consumer that turns this into daemon-truth for "is the new version actually live". Same
    // value `recordBoot` wrote to uptime.jsonl (see above) — not a second, later `Date.now()`.
    bootedAt: bootedAtIso,
    uptimeSecs: Math.round((Date.now() - bootedAtMs) / 1000),
    runs: runSupervisor.live(),
    quick: quick.stats(),
    browser: browser.stats(),
    browserAgent: browserAgent.stats(),
    extensions: await extensions.health(),
    supervisor: { lastReconcileAt: runSupervisor.lastReconcileAt() },
    githubPr: prPoller ? prPoller.stats() : null,
    githubActivity: activityPoller ? { repo: activityConfig.repo, branch: activityConfig.branch } : null,
    paused: readPause(paths.pauseFile),
    proactiveSweep: { repos: config.proactive_sweep.repos },
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
    // Health staleness is measured against the engine's OWN cadence: the staffing watchdog tick.
    pollIntervalMs: Math.max(1, config.supervise.staffing_watchdog_s) * 1_000,
    runs: {
      live: () => runSupervisor.live().map((row) => ({ state: row.state as RunState })),
      lastTickAt: () => runSupervisor.lastReconcileAt(),
    },
    metrics: createSystemMetricsReader(),
    lifecycleLedgerPath,
    spendPath: paths.spend,
  });
  // Bot presence, driven off the status-snapshot tick (#132). One deriver, one sink: the gateway
  // bot user (discord.js setPresence). The controller only emits on a real change and rate-floors
  // sends; the sink catches its own errors.
  const presenceController = new PresenceController({
    logger: logger.child("discord.presence"),
    sinks: {
      setPresence: (data) => {
        const client = gateway instanceof DiscordJsGateway ? gateway.discordClient() : undefined;
        client?.user?.setPresence(data);
      },
    },
  });
  const statusDashboard = createStatusDashboardService({
    gateway,
    // The env-overridable cards channel (`disabled` → null): the staging daemon (#141) runs the
    // dashboard for its presence side effects but posts nothing into prod's cards channel.
    channelId: cardsChannelId(),
    statePath: statusDashboardMessagePath(beckettDir),
    collectSnapshot: async () => {
      const snapshot = await statusCollector.collect();
      // Assemble the board off in-memory stats already gathered this tick. `update` is
      // fire-and-forget (it never rejects) so a presence hiccup cannot stall the dashboard cycle.
      const browser = browserAgent.stats();
      const inputs: PresenceInputs = {
        degraded: snapshot.health.some((h) => h.reachable === false),
        deployInFlight: isDeployActive(beckettDir),
        browserRunLive: browser.running > 0 || browser.waiting > 0,
        branchesInFlight: runSupervisor.live().filter((row) => row.workerId !== null).length,
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
        if (!branch.pullRequest || !branch.run) continue;
        prPoller.watch({
          repo: branch.pullRequest.repo,
          number: branch.pullRequest.number,
          url: branch.pullRequest.url,
          title: branch.title,
          runId: branch.run.runId,
          channel: task.threadId ?? task.originChannelId,
        });
      }
    }
  }
  // The run engine: crash-recover its own ledger (sweeping processes a crashed daemon orphaned
  // and committing their ghost WIP), drain durable publish rows, re-admit every live run, then arm
  // its checkpoint + staffing loops.
  await runSupervisor.start();

  // EARLY extension background loops start here — after crash recovery (so a migrated organ
  // never races the recovery block) and BEFORE the pollers, which stay last so events only flow
  // once everything else is ready to consume them. The browser agent's recover() rides this
  // sweep (issue #58): stranded runs re-report into the now-live concierge, queued runs
  // re-queue. Organs whose loops DISPATCH into the live system (schedulers) start in the
  // "late" sweep further down instead — see LifecycleStartPhase.
  await extensions.startAll(extCtx, "early");

  // GitHub PR sense (OPS-124): start watching after the engine is live, so any PR opened during
  // boot recovery already has a home. Each material transition lands as a Concierge update turn —
  // the same routing as run updates. Best-effort: a poll failure never affects the rest.
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

  logger.info("beckett online", { liveRuns: runSupervisor.live().length });

  return { config, logger, prPoller, activityPoller, mailPoller, runSupervisor, concierge, voiceGateway, statusDashboard, quick, browserAgent, browser, extensions, lifecycleLedgerPath, opsLog };
}

/** Tear the system down in reverse boot order. Best-effort: one failure never blocks the rest. */
async function shutdown(sys: BootedSystem, signal: string): Promise<void> {
  sys.logger.info("shutting down beckett", { signal });
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
  sys.runSupervisor.stop();
  sys.prPoller?.stop();
  sys.activityPoller?.stop();
  sys.mailPoller?.stop();
  // Mirrors startAll's boot position (just before the pollers started). The registry sweep is
  // best-effort per organ — a throwing stop is logged, never blocks the rest of the drain.
  // The browser organ tears down inside this sweep: agent.stopAll settles live runs as errors
  // (their outcomes still route through the still-live concierge below), THEN the host dies.
  // The quick organ (Phase 3) drains here too: stragglers are killed ahead of concierge.stop
  // below, so their "daemon shut down" results can still route through it.
  await sys.extensions.stopAll(sys.logger);
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
  // Stopped LAST (issue #231): every other stop() above logs on its way down, and the mirror
  // should get a chance to carry as much of that as possible before it flushes and unregisters.
  try {
    await sys.opsLog?.stop();
  } catch (err) {
    sys.logger.warn("ops-log mirror shutdown failed", { error: (err as Error).message });
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

export { boot, shutdown, main };
export type { BootedSystem };
