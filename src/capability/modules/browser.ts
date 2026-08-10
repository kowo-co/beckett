/**
 * Beckett v6 — the browser extension (`src/capability/modules/browser.ts`)
 * =======================================================================================
 * Phase 2 of the v6 migration (docs/v6-architecture.md §6): the FIRST STATEFUL organ on the
 * extension contract. Its lifecycle re-homes the two subprocess families the daemon used to
 * hand-wire in `shell/main.ts`:
 *
 *   1. the persistent-Chromium HOST subprocess, owned by the isolated {@link BrowserRuntime}
 *      (construction is inert — the host spawns lazily inside the runtime on first
 *      `acquire()`, so `init` never double-starts it), and
 *   2. the per-run `claude -p` LEG subprocesses, owned by the background {@link BrowserAgent}.
 *
 * Ordering constraints the lifecycle carries (they are the reason the hooks split this way):
 *   - `start` (agent.recover — the durable-ledger restart-cancellation re-report) rides the
 *     registry's startAll sweep, which `shell/main.ts` runs AFTER `concierge.start()` and the
 *     dispatcher's crash recovery — outcomes must never re-report into a dead concierge.
 *   - `stop` settles live runs first (`agent.stopAll`) and only THEN kills the host
 *     (`runtime.stop`) — the exact order of the v5 hand-wired shutdown.
 *
 * The concierge's seven `browser.*` bus command bodies stay in `buildBusCapabilities`
 * byte-identical (they bind issuer-token auth, channel locks, and keychain redaction — all
 * concierge-private state), and the CLI `browser` verb stays in its `cli/beckett.ts` spine
 * slot: Phase 2 re-homes LIFECYCLE and adds the v6 discovery/dispatch surface, nothing else.
 * `browser.eval` (the internal MCP↔daemon bridge) is deliberately NOT advertised — the
 * concierge must never route an @mention to it.
 */

import { join } from "node:path";
import { z } from "zod";
import { ActionClass, type Extension, type ExtensionContext } from "../../ext/contract.ts";
import { createBrowserRuntime, type BrowserRuntime } from "../../browser/runtime.ts";
import {
  createBrowserAgent,
  type BrowserAgent,
  type BrowserAgentQuestion,
  type BrowserAgentRun,
} from "../../browser/agent.ts";
import type { KeychainReader } from "../../secret/keychain-read.ts";

/**
 * What the daemon injects beyond {@link ExtensionContext}: the keychain reader and the
 * concierge callbacks the context cannot carry (they close over the live concierge).
 */
export interface BrowserExtensionDeps {
  /** Jingle keychain reader for `--creds` runs; absent → credentialed dispatches refuse. */
  keychain?: KeychainReader;
  /** Surface one blocking question to the origin channel; resolves to the Discord anchor id. */
  onQuestion: (run: BrowserAgentRun, question: BrowserAgentQuestion) => Promise<string>;
  /** Report a terminal run to the concierge (update turn). Throwing keeps the run undelivered. */
  onOutcome: (run: BrowserAgentRun) => void | Promise<void>;
  /** Test seams (the same DI spirit as agent.ts's `spawn`): swap the subprocess owners for fakes. */
  createRuntime?: (ctx: ExtensionContext) => BrowserRuntime;
  createAgent?: (ctx: ExtensionContext, runtime: BrowserRuntime) => BrowserAgent;
}

/** The built extension plus the accessors `shell/main.ts` wires into the concierge's v5 setters. */
export interface BrowserExtension extends Extension {
  /** The daemon-owned persistent-Chromium runtime. Throws before `lifecycle.init` has run. */
  runtime(): BrowserRuntime;
  /** The dedicated background browser agent. Throws before `lifecycle.init` has run. */
  agent(): BrowserAgent;
}

const TaskArgs = z.object({
  task: z.string().trim().min(1, "browser.task needs a non-empty task"),
  /** Jingle keychain entry name backing the run's `secrets` object; the name only, never values. */
  credsEntry: z
    .string()
    .optional()
    .describe(
      "Jingle keychain entry name (e.g. \"x-account\") whose fields the run gets as `secrets.*`. " +
        "REQUIRED whenever the task involves a login, signup, or any stored credential — naming " +
        "the entry only inside the task text does NOT load it, and the run will have no " +
        "credentials at all. Pass the entry name, never a secret value.",
    ),
  /** Conversation background the agent should know but not treat as instructions. */
  context: z.string().optional(),
  /** Must match the origin's channel when given — a run only reports where it was authorized. */
  channelId: z.string().optional(),
});

const ExecArgs = z.object({
  code: z.string().trim().min(1, "browser.exec needs a non-empty BetterWright script"),
});

const WatchArgs = z.object({
  runId: z.string().trim().min(1, "browser.watch needs a runId"),
  tail: z.number().int().positive().optional(),
  screenshot: z.boolean().optional(),
});

const SteerArgs = z.object({
  runId: z.string().trim().min(1, "browser.steer needs a runId"),
  note: z.string().trim().min(1, "browser.steer needs a non-empty note"),
});

const StopArgs = z.object({
  runId: z.string().trim().min(1, "browser.stop needs a runId"),
  reason: z.string().optional(),
});

export const createBrowserExtension =
  (deps: BrowserExtensionDeps) =>
  (ctx: ExtensionContext): BrowserExtension => {
    // Built by lifecycle.init, torn down by lifecycle.stop. Both are CONSTRUCTED there but
    // stay inert until first use — the host subprocess spawns only on the first acquire().
    let runtime: BrowserRuntime | null = null;
    let agent: BrowserAgent | null = null;

    function requireRuntime(): BrowserRuntime {
      if (!runtime) throw new Error("the browser extension is not initialized (lifecycle.init has not run)");
      return runtime;
    }
    function requireAgent(): BrowserAgent {
      if (!agent) throw new Error("the browser extension is not initialized (lifecycle.init has not run)");
      return agent;
    }

    /** One inline evaluation gets its own session; runtime admission enforces only its lane cap. */
    async function execOneOff(code: string, channelId: string | null): Promise<unknown> {
      const rt = requireRuntime();
      // The kill switch intentionally restores the former global-lease UX, including protecting
      // an accepted queue→live handoff from an inline acquire race.
      if ((rt.stats().maxConcurrentLeases ?? 1) <= 1) {
        const busyRun = requireAgent()
          .stats()
          .runs.find((run) => run.state === "running" || run.state === "waiting" || run.state === "queued");
        if (busyRun) {
          throw new Error(
            busyRun.state === "queued"
              ? `the background browser agent has run ${busyRun.runId} queued for the browser - ` +
                  `it starts the moment the lease frees; wait for the queue to drain or dispatch this as a background task`
              : `the background browser agent holds the browser (run ${busyRun.runId}, ${busyRun.state}) - ` +
                  `use \`beckett browser watch/steer\` on that run instead, or wait for it to finish`,
          );
        }
      }
      const runId = `inline-${crypto.randomUUID()}`;
      const controlToken = crypto.randomUUID();
      const artifactsDir = join(ctx.paths.beckettDir, "browser-agent", "inline", runId);
      try {
        await rt.acquire({ runId, channelId, artifactsDir, controlToken });
        return await rt.evaluate(runId, code, controlToken);
      } finally {
        if (rt.hasLease(runId)) await rt.release(runId, false).catch(() => undefined);
      }
    }

    return {
      manifest: {
        id: "browser",
        version: "1.0.0",
        summary:
          "the browser lane: daemon-owned persistent Chromium + the dedicated background browser agent",
        // Browser runs act outward on live sites under stored credentials — never unattended.
        actionClass: ActionClass.ALWAYS_ASK,
        kind: "extension",
      },

      // --- v6 discovery + dispatch (router prose sourced from .claude/skills/browser/SKILL.md) ---
      capabilities: [
        {
          id: "browser.task",
          description:
            "Dispatch a self-contained browser/computer-use task to the dedicated background " +
            "agent — the default for anything with more than one step, anything needing " +
            "credentials, and anything that might take a while (a signup, a login-and-do-" +
            "something, posting a draft). Returns immediately with a runId and starts at once " +
            "in its own browser session while capacity remains; past the concurrent-session cap " +
            "it queues (the return carries its position) and starts automatically when a lane " +
            "frees — never re-dispatch. Questions surface as one Discord anchor for that run; " +
            "the outcome comes back as an update turn.",
          input: TaskArgs,
          examples: [
            "check https://example.com/status — is the API listed as degraded?",
            "log in to x.com and post the draft thread (credsEntry: \"x-account\")",
            "sign up for the beta with the team email (credsEntry: \"team-email\")",
          ],
        },
        {
          id: "browser.exec",
          description:
            "Run ONE BetterWright JavaScript one-off inline in its own browser session — a quick " +
            "read of a live page (\"is the site up?\", \"what does this page say right now?\"). " +
            "It can run beside background tasks and refuses only when its session is busy or all " +
            "concurrent browser lanes are full. No credentials; reads and trivially reversible " +
            "clicks only.",
          actionClass: ActionClass.FREE,
          input: ExecArgs,
          examples: ["await page.goto('https://example.com/status'); return snapshot()"],
        },
        {
          id: "browser.watch",
          description:
            "Snapshot exactly the background browser run named by runId: its state (including " +
            "queued), redacted activity journal, and — while that run is live — a fresh page " +
            "screenshot from its own session. Use when someone asks what it is doing, or before " +
            "steering. While the run is live the response also carries liveViewUrl — a private " +
            "watch-the-browser-live link (treat it like a password; share it only with the " +
            "requesting person).",
          actionClass: ActionClass.FREE,
          input: WatchArgs,
          examples: ["what is the browser run doing right now?"],
        },
        {
          id: "browser.steer",
          description:
            "Deliver mid-run guidance to exactly the background browser run named by runId: a " +
            "running run gets the note in its next tool result, a run parked on its question " +
            "resumes with it, and a queued run folds it into its launch input. Other concurrent " +
            "runs are untouched. Use when the person changes their mind or adds a constraint.",
          actionClass: ActionClass.FREE,
          input: SteerArgs,
          examples: ["use the annual plan, not monthly — the person just corrected it"],
        },
        {
          id: "browser.stop",
          description:
            "Cancel exactly the background browser run named by runId: a live run is killed " +
            "cleanly and only its session released, while a queued run is removed before it " +
            "starts. Both still report a cancelled outcome turn; other concurrent runs continue. " +
            "Use for \"never mind\" or a run stuck beyond steering.",
          actionClass: ActionClass.FREE,
          input: StopArgs,
          examples: ["stop the browser run, the person cancelled the request"],
        },
      ],

      // Routes to the agent/runtime and NEVER exits the process: every failure — including a
      // pre-init call — comes back as an ok:false result the caller can surface.
      invoke: async (call) => {
        // The `call.origin` identity is TRUSTED here because the core derives it from the
        // issuing turn before dispatch (`ext.invoke` strips caller-supplied userId/channelId);
        // this body enforces the same gates as the v5 bus verbs — an origin identity on
        // everything that acts, and the run-belongs-to-its-channel lock on task/steer/stop.
        try {
          switch (call.capabilityId) {
            case "browser.task": {
              const a = call.args as z.infer<typeof TaskArgs>;
              const agent = requireAgent();
              const origin = call.origin;
              if (!origin?.userId || !origin.channelId) {
                return { ok: false, error: "browser tasks need an authenticated authorized request" };
              }
              const requestedChannelId = a.channelId?.trim();
              if (requestedChannelId && requestedChannelId !== origin.channelId) {
                return { ok: false, error: "browser tasks must return to the channel where the authorized request began" };
              }
              const result = await agent.run(a.task, {
                channelId: origin.channelId,
                requesterId: origin.userId,
                credsEntry: a.credsEntry ?? null,
                context: a.context ?? null,
              });
              return { ok: true, data: result };
            }
            case "browser.exec": {
              const a = call.args as z.infer<typeof ExecArgs>;
              requireRuntime();
              if (!call.origin?.userId || !call.origin.channelId) {
                return { ok: false, error: "inline browser scripts need an authenticated authorized request" };
              }
              return { ok: true, data: await execOneOff(a.code, call.origin.channelId) };
            }
            case "browser.watch": {
              const a = call.args as z.infer<typeof WatchArgs>;
              const inspection = await requireAgent().inspect(a.runId, {
                ...(a.tail !== undefined ? { tail: a.tail } : {}),
                ...(a.screenshot !== undefined ? { screenshot: a.screenshot } : {}),
              });
              if (!inspection) return { ok: false, error: `browser run ${a.runId} is unknown` };
              return { ok: true, data: inspection };
            }
            case "browser.steer": {
              const a = call.args as z.infer<typeof SteerArgs>;
              const agent = requireAgent();
              if (!call.origin?.userId || !call.origin.channelId) {
                return { ok: false, error: "steering needs an authenticated authorized request" };
              }
              const inspection = await agent.inspect(a.runId, { tail: 1, screenshot: false });
              if (!inspection) return { ok: false, error: `browser run ${a.runId} is unknown` };
              if (inspection.run.channelId !== call.origin.channelId) {
                return { ok: false, error: "browser runs can only be steered from the channel that dispatched them" };
              }
              const delivery = await agent.steer(a.runId, a.note);
              return { ok: true, data: { runId: a.runId, delivery } };
            }
            case "browser.stop": {
              const a = call.args as z.infer<typeof StopArgs>;
              const agent = requireAgent();
              if (!call.origin?.userId || !call.origin.channelId) {
                return { ok: false, error: "stopping a run needs an authenticated authorized request" };
              }
              const inspection = await agent.inspect(a.runId, { tail: 1, screenshot: false });
              if (!inspection) return { ok: false, error: `browser run ${a.runId} is unknown` };
              if (inspection.run.channelId !== call.origin.channelId) {
                return { ok: false, error: "browser runs can only be stopped from the channel that dispatched them" };
              }
              await agent.stop(a.runId, a.reason);
              return { ok: true, data: { runId: a.runId, state: "cancelled" } };
            }
            default:
              return { ok: false, error: `browser: unknown capability "${call.capabilityId}"` };
          }
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      lifecycle: {
        // Construction only — both owners stay inert (no host spawn, no legs) until first use.
        init: () => {
          runtime =
            deps.createRuntime?.(ctx) ??
            createBrowserRuntime({ config: ctx.config, logger: ctx.logger.child("browser") });
          agent =
            deps.createAgent?.(ctx, runtime) ??
            createBrowserAgent({
              config: ctx.config,
              logger: ctx.logger.child("browser-agent"),
              browser: runtime,
              ...(deps.keychain ? { keychain: deps.keychain } : {}),
              onQuestion: deps.onQuestion,
              onOutcome: deps.onOutcome,
            });
        },
        // Rides the registry's startAll sweep — after concierge.start() and dispatcher crash
        // recovery — so restart-cancellation reports land in a live concierge.
        start: async () => {
          await requireAgent().recover();
        },
        // Legs settle before the host dies: stopAll finalizes live runs (their "daemon shut
        // down" outcomes still route through the still-live concierge), THEN the host is killed.
        stop: async () => {
          if (agent) {
            try {
              await agent.stopAll();
            } catch (error) {
              ctx.logger.warn("browser-agent shutdown failed", { error: (error as Error).message });
            }
          }
          if (runtime) await runtime.stop();
        },
        health: () => {
          if (!runtime || !agent) return { ok: false, detail: "not initialized" };
          const host = runtime.stats();
          const runs = agent.stats();
          return {
            ok: true,
            detail:
              `host ${host.ready ? "up" : "idle"} (${host.launches} launches, ${host.evaluations} evals); ` +
              `runs: ${runs.running} running, ${runs.waiting} waiting, ${runs.queued} queued`,
          };
        },
      },

      // --- v5 facets: deliberately empty in Phase 2. The CLI `browser` verb keeps its
      // cli/beckett.ts spine slot and the seven bus bodies stay concierge-owned (see header).
      cliVerbs: [],
      busCommands: [],
      skillDoc: ".claude/skills/browser/SKILL.md",

      runtime: requireRuntime,
      agent: requireAgent,
    };
  };
