/**
 * Beckett v6 — the quick extension (`src/capability/modules/quick.ts`)
 * =======================================================================================
 * Phase 3 of the v6 migration (docs/v6-architecture.md §6): the quick organ — the
 * fire-and-report NO-TICKET lane — on the extension contract, following the Phase 2
 * browser.ts shape. Its lifecycle re-homes what `shell/main.ts` used to hand-wire:
 *
 *   - `init` constructs the {@link QuickRunner} (which performs the quick-dir mkdir +
 *     artifact-retention sweep boot has always done at construction), closing over the
 *     daemon-injected `onDetachedResult` concierge callback, and
 *   - `stop` kills any straggler `claude -p` children (`runner.stopAll`) on the registry's
 *     teardown sweep — which `shell/main.ts` runs BEFORE `concierge.stop()`, so each
 *     straggler's "daemon shut down" result still routes through the live concierge.
 *
 * ONE runner instance serves every surface (the two-runner trap: a second instance would
 * split `max_concurrent` accounting, lane-full refusals, stopAll, and detached delivery).
 * The daemon reads it back through the {@link QuickExtension.runner} accessor to feed the
 * concierge's v5 `setQuickRunner` setter — the `quick.run`/`quick.list` bus command bodies
 * stay in `buildBusCapabilities` byte-identical (their not-wired refusal is pinned by
 * `src/concierge/bus-characterization.test.ts` against a bare Concierge), exactly the
 * Phase 2 split. The CLI `quick` verb IS carried here (unlike browser's, its body binds no
 * concierge state) and projects into its existing `cli/beckett.ts` spine slot via
 * `asCapability`, so the pinned help line and usage failures stay byte-identical.
 *
 * NO configSchema/configKey: the `quick` config fragment stays in `capability/builtins.ts`,
 * where the key is co-owned with the browser_* host fields — declaring it here would trip
 * the registry's config-key collision check and wrongly split ownership.
 */

import { join } from "node:path";
import { z } from "zod";
import { ActionClass, type Extension, type ExtensionContext } from "../../ext/contract.ts";
import { createQuickRunner, type QuickRun, type QuickRunner } from "../../quick/index.ts";
import { callBus, ControlBusTimeoutError, indeterminateBusTimeout } from "../../shell/control-bus.ts";
import { fail, out, parse } from "../../cli/io.ts";
import { quickDetachedMessage } from "../../cli/quick-output.ts";
import { pauseRefusal, readPause } from "../../pause.ts";

/**
 * What the daemon injects beyond {@link ExtensionContext}: the detached-result callback the
 * context cannot carry (it closes over the live concierge).
 */
export interface QuickExtensionDeps {
  /**
   * Deliver a DETACHED run's result (concierge.notifyQuickResult → an update turn). The CLI
   * process registers this extension too (for the verb projection) but never runs
   * lifecycle.init, so its callback is dead wiring — pass a no-op there.
   */
  onDetachedResult: (run: QuickRun) => void | Promise<void>;
  /** Test seam (the same DI spirit as browser.ts): swap the runner for a fake. */
  createRunner?: (ctx: ExtensionContext) => QuickRunner;
}

/** The built extension plus the accessor `shell/main.ts` wires into `concierge.setQuickRunner`. */
export interface QuickExtension extends Extension {
  /** The one daemon-owned quick runner. Throws before `lifecycle.init` has run. */
  runner(): QuickRunner;
}

// Deliberately permissive (no .min(1), no agent enum): the runner's own guards produce the
// pinned refusal strings (unknown agent, the computer-use → browser redirect, empty task,
// disabled, lane full) — a strict schema here would preempt them with a generic
// "invalid args", diverging the invoke path from the CLI/bus semantics.
const RunArgs = z.object({
  agent: z.string(),
  task: z.string(),
  /** Where the report routes. May only restate the origin channel, never redirect it. */
  channelId: z.string().optional(),
});

export const createQuickExtension =
  (deps: QuickExtensionDeps) =>
  (ctx: ExtensionContext): QuickExtension => {
    // Built by lifecycle.init, torn down by lifecycle.stop. Construction does the quick-dir
    // mkdir + retention sweep (as boot always has), but spawns nothing until the first run.
    let runner: QuickRunner | null = null;

    function requireRunner(): QuickRunner {
      if (!runner) throw new Error("the quick extension is not initialized (lifecycle.init has not run)");
      return runner;
    }

    /**
     * The carried v5 CLI verb — `cli/beckett.ts::runQuick` moved verbatim (the CLI
     * characterization suite pins its usage failures and daemon-down bus errors). `out`/`fail`
     * are CLI-surface only: this run function is dispatched by the CLI spine in a `beckett`
     * process, never by the daemon — daemon dispatch goes through `invoke` below.
     */
    async function runQuick(argv: string[]): Promise<void> {
      const sock = join(ctx.paths.beckettDir, "control.sock");
      const [sub, ...rest] = argv;
      if (sub === "list") {
        // The CLI's generic bus() helper, inlined byte-identical.
        try {
          const res = await callBus(sock, "quick.list", {});
          if (!res.ok) fail(res.error ?? "command failed");
          out(res.data ?? { ok: true });
        } catch (err) {
          fail((err as Error).message);
        }
      }
      const { _, flags } = parse(rest);
      const agent = sub?.trim();
      const task = _.join(" ").trim();
      if (!agent || !task) {
        fail('usage: beckett quick <quick-code|repo-explorer> "<task>" [--channel <id>]  |  beckett quick list');
      }
      const held = readPause(ctx.paths.pauseFile);
      if (held) fail(pauseRefusal(held, "dispatch a quick agent"));
      try {
        // The one custom bus timeout: the run may block the whole sync window for its report.
        const res = await callBus(
          sock,
          "quick.run",
          { agent, task, channelId: flags.channel ? String(flags.channel) : undefined },
          (ctx.config.quick.sync_wait_secs + 30) * 1000,
        );
        if (!res.ok) fail(res.error ?? "quick run failed");
        const data = res.data as { done?: boolean; detached?: boolean; runId: string; state?: string; result?: string };
        if (data.detached) {
          out(quickDetachedMessage(agent, data.runId, ctx.config.quick.sync_wait_secs));
        }
        out(`[quick:${data.runId} state:${data.state}]\n${data.result ?? ""}`);
      } catch (err) {
        if (err instanceof ControlBusTimeoutError) {
          // The runner acks within the sync window (done, or detached with a runId) and this timeout
          // sits 30s past it, so a trip here means a stuck daemon, not a failed run — the run may be
          // dispatching and its result will still arrive as a quick-agent update turn (#137).
          fail(indeterminateBusTimeout(err, "`beckett status` (the quick lane) — a detached run reports back as a quick-agent update turn"));
        }
        fail((err as Error).message);
      }
    }

    return {
      manifest: {
        id: "quick",
        version: "1.0.0",
        // The v5 spine literal's exact summary — asCapability projects it into the CLI slot.
        summary: "the NO-TICKET lane: dispatch a short-lived specialist harness",
        actionClass: ActionClass.FREE,
        kind: "extension",
      },

      // --- v6 discovery + dispatch (router prose sourced from .claude/skills/quick/SKILL.md) ---
      capabilities: [
        {
          id: "quick.run",
          description:
            "Dispatch a short-lived specialist for an errand BETWEEN an inline answer and a " +
            "ticket: quick-code takes a small coding errand in a scratch dir (one-off scripts, " +
            "file transforms, conversions — never project repos); repo-explorer shallow-clones " +
            "a repo and returns a tight brief answering your question. Blocks up to the sync " +
            "window for the report, then detaches — a detached run's result arrives later as a " +
            "quick-agent update turn in the origin channel. No ticket, no worker, no worktree; " +
            "browser/computer-use work goes to the browser lane instead.",
          input: RunArgs,
          examples: [
            "write a script that dedupes the attached wordlist; input at /path/x.txt",
            "clone anthropics/claude-code and tell me how its hook system works",
          ],
        },
      ],

      // Dispatches the SAME runner the bus/CLI paths use, and NEVER exits the process: every
      // failure — including a pre-init call and the runner's own guard throws — comes back as
      // an ok:false result the caller can surface.
      invoke: async (call) => {
        try {
          if (call.capabilityId !== "quick.run") {
            return { ok: false, error: `quick: unknown capability "${call.capabilityId}"` };
          }
          const a = call.args as z.infer<typeof RunArgs>;
          // Defense in depth, the same rule as browser.task: identity comes from the
          // token-derived origin (the core strips caller-supplied userId/channelId before
          // dispatch); an args channel may only RESTATE the origin channel, never redirect a
          // detached report somewhere the request was not made.
          const requestedChannelId = a.channelId?.trim();
          if (requestedChannelId && call.origin?.channelId && requestedChannelId !== call.origin.channelId) {
            return { ok: false, error: "quick runs must report back to the channel where the request began" };
          }
          // quick.run is FREE (a read/report lane) so an unauthenticated origin is allowed —
          // mirroring the v5 bus verb, where a token-less caller runs with a null requester.
          const channelId = requestedChannelId || call.origin?.channelId || null;
          const outcome = await requireRunner().run(a.agent, a.task, channelId, call.origin?.userId ?? null);
          // The {done,state,result,runId} | {detached,runId} outcome — the exact shape the
          // v5 bus command returns, so callers never diverge by path.
          return { ok: true, data: outcome };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      lifecycle: {
        // Construction re-homed from shell/main.ts: the runner does its quick-dir mkdir +
        // artifact-retention sweep here (boot-time, before any live part starts) and spawns
        // nothing until the first run.
        init: () => {
          runner =
            deps.createRunner?.(ctx) ??
            createQuickRunner({
              config: ctx.config,
              logger: ctx.logger.child("quick"),
              onDetachedResult: deps.onDetachedResult,
            });
        },
        // Quick agents are ephemeral by contract — kill stragglers on the teardown sweep.
        // shell/main.ts runs that sweep before concierge.stop(), so each straggler's "daemon
        // shut down" result still routes through the live concierge.
        stop: async () => {
          if (runner) await runner.stopAll();
        },
        health: () => {
          if (!runner) return { ok: false, detail: "not initialized" };
          const s = runner.stats();
          return { ok: true, detail: `${s.running}/${ctx.config.quick.max_concurrent} running` };
        },
      },

      // --- carried v5 facets: the CLI verb + its pinned help token, projected into the same
      // cli/beckett.ts spine slot via asCapability. Bus commands stay concierge-owned (their
      // bodies bind this.quickRunner and the issuer mention — see the header).
      cliVerbs: [
        {
          name: "quick",
          summary: "run quick-code | repo-explorer and block for its report",
          usage: 'beckett quick <quick-code|repo-explorer> "<task>" [--channel <id>]  |  beckett quick list',
          run: runQuick,
        },
      ],
      busCommands: [],
      cliHelp: "quick <agent>|list",
      skillDoc: ".claude/skills/quick/SKILL.md",

      runner: requireRunner,
    };
  };
