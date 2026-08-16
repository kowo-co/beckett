/**
 * Beckett v6 — the extension contract (`src/ext/contract.ts`)
 * =======================================================================================
 * The FOUNDATION step of the v6 migration (issue #82). This module defines the ONE standard
 * contract every v6 extension registers through — the "plug n play" interface the whole v6
 * generation migrates onto. LIVE since the v6 boot wiring: `src/shell/main.ts` constructs the
 * one runtime `ExtensionRegistry` and hands it to the concierge, and nine capability modules
 * (mail, memory, image, cloudflare, github, secret, browser, quick, routines) register through
 * it. See {@link ../../docs/v6-architecture.md} for the full boundary + migration.
 *
 * WHY a new contract when v5 already has plug-in tables:
 * v5 STARTED the unification with the capability spine but never finished it, and two adjacent
 * mechanisms never joined:
 *   - `src/capability/index.ts`  — the `CapabilityRegistry` spine (one class, reused 5×: CLI, bus,
 *     stages, builtins, config). `src/dispatch/stages.ts` is `new CapabilityRegistry()`, not a
 *     separate registry — but bus/CLI bodies still live in cascades the spine meant to absorb.
 *   - `src/agent/registry.ts`    — live agent registry (#66/#55: named worker personas) — separate.
 *   - `src/drivers/index.ts`     — harness drivers (the original good seam) — separate.
 * One half-eaten spine plus two tables that never joined, plus no seam that carries lifecycle,
 * invocation, or a discovery catalog. That IS the "shoddily stacked" shape. v6 unifies them: an
 * {@link Extension} is
 * the v5 {@link Capability} GENERALIZED to also carry lifecycle, a discovery catalog, and a
 * single invocation entrypoint — the two things the @mention flow needs that the capability
 * spine never had. The existing facets (cliVerbs, busCommands, promptBlock, config) are carried
 * through UNCHANGED, so migrating a capability to an extension is additive, not a rewrite.
 *
 * SUBSUMES #55: the live agent registry becomes the backing store for an extension's `agents`
 * facet; its agents.json live-reload semantics are kept as-is (see the doc's reconciliation
 * note). This contract does not fork #55 — it re-homes it.
 */

import type { z } from "zod";
import type { Config, Logger, Paths } from "../types.ts";
import { ActionClass } from "../types.ts";
// The v5 facet vocabulary is carried through verbatim — an extension SUBSUMES a capability,
// it does not reinvent the surfaces a capability already lights up.
import type { BusCommand, CliVerb, PromptBlock } from "../capability/index.ts";

export { ActionClass };
export type { BusCommand, CliVerb, PromptBlock };

// =======================================================================================
// Manifest — who the extension is
// =======================================================================================

/**
 * Whether a module is part of the invariant v6 core or a pluggable extension. Core organs
 * register through the SAME contract (that is the point — one seam), but are tagged so the
 * boundary is machine-checkable and the doctor/catalog can present them distinctly.
 */
export type ExtensionKind = "core" | "extension";

/** The self-describing header every extension declares. */
export interface ExtensionManifest {
  /** Unique kebab-case id ("memory", "browser", "social"). The registry key. */
  id: string;
  /**
   * Semver-ish version string. Carried from day one because the v6 improve/rollback loop
   * (docs/v6.md § Improve) versions and reverts extensions the way it versions the daemon.
   */
  version: string;
  /** Human one-liner: what this extension is for. Surfaced to humans and the concierge. */
  summary: string;
  /** Default license posture for every capability that does not override it (Spec 07 §2.2). */
  actionClass: ActionClass;
  /** core organ vs bolted-on feature. Defaults to "extension" when omitted by the registry. */
  kind?: ExtensionKind;
}

// =======================================================================================
// Discovery — what the concierge routes over
// =======================================================================================

/**
 * One machine-readable capability an extension advertises. This is the heart of v6 "plug n
 * play": the Concierge does not match a command prefix (slash commands are dead) — it reads
 * the `description` of every advertised capability and routes an @mention to the right one.
 * The registry renders these into the concierge's system prompt ({@link ExtensionRegistry.catalog}),
 * which is exactly #55's "modular concierge prompting" generalized past agents to every organ.
 */
export interface ExtensionCapability {
  /** Namespaced id ("memory.recall", "browser.exec"). Globally unique across all extensions. */
  id: string;
  /**
   * Natural-language description — what this can do and WHEN to reach for it. This is the text
   * the concierge's router reads, so it is prose for an LLM, not a usage string for a parser.
   */
  description: string;
  /** Per-capability override of the extension's default action-class. */
  actionClass?: ActionClass;
  /**
   * Optional zod schema for the invocation args. The registry validates a call against this
   * BEFORE it reaches {@link Extension.invoke}, so an extension body never re-parses raw input.
   */
  input?: z.ZodTypeAny;
  /** Optional example phrasings ("remember that…", "what do you know about…") to sharpen routing. */
  examples?: string[];
}

// =======================================================================================
// Worker stages — the dispatcher facet an extension can contribute (v6 Phase 5)
// =======================================================================================

/**
 * One worker stage an extension contributes to the dispatcher's state machine. Deliberately a
 * STRUCTURAL marker — the same discipline as `Capability`'s `BusRequestLike` — so this contract
 * never imports dispatch-domain types: the real stage shape (`src/dispatch/stages.ts`'s
 * `StageDefinition`, carrying prompt builders and cast defaults) structurally satisfies this, and
 * dispatch-side consumers widen back to it through their own stage view (`stageViewOf`). Stage
 * names and entry states are GLOBAL namespaces across all extensions (like capability ids); the
 * registry refuses collisions loudly so no stage — and no state→stage staffing — can silently
 * shadow another.
 *
 * Stages are NOT discovery: they never appear in {@link ExtensionRegistry.catalog}. The run
 * supervisor staffs a stage when a run enters its state; the concierge never routes an @mention
 * to one.
 */
export interface StageFacet {
  /** Unique stage name ("implement", "review"). The registry key. */
  readonly name: string;
  /**
   * Run state whose entry staffs this stage (a `RunState` — kept a bare `string` so `src/ext`
   * stays free of run-domain types); absent for a stage only reachable by name.
   */
  readonly entryState?: string;
}

// =======================================================================================
// Invocation — the ONE dispatch entrypoint
// =======================================================================================

/**
 * Provenance an extension may need to do its job, kept STRUCTURAL so the contract has zero
 * dependency on discord/run-domain types (the same discipline as `Capability`'s `BusRequestLike`).
 */
export interface InvocationOrigin {
  /** Which surface the call came from ("discord", "cli", "routine", "goal-ledger", …). */
  surface?: string;
  channelId?: string;
  userId?: string;
  /** The ticket identifier when the call rides a worker/dispatch context. */
  ticket?: string;
}

/** A single dispatch from the concierge (or another core caller) to an extension. */
export interface ExtensionInvocation {
  /** The advertised capability being invoked. Must exist in the extension's catalog. */
  capabilityId: string;
  /** The call arguments — validated against the capability's `input` schema by the registry. */
  args: Record<string, unknown>;
  /** Where the call came from, for extensions that scope behavior by surface/audience. */
  origin?: InvocationOrigin;
}

/**
 * The result of an invocation. Deliberately minimal for the skeleton: `ok` + a data payload,
 * or `ok:false` + an error the concierge can surface. Richer shapes (streaming, follow-up
 * intents, staged pending-actions for the gate) layer on in later phases without changing the
 * seam.
 */
export interface ExtensionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// =======================================================================================
// Lifecycle — for stateful extensions (memory retrieval, the browser subprocess)
// =======================================================================================

/** What an extension factory/lifecycle gets — the same runtime context as {@link CapabilityDeps}. */
export interface ExtensionContext {
  config: Config;
  paths: Paths;
  logger: Logger;
}

/** A single health verdict, consumed by `beckett doctor` and the v6 observation window. */
export interface ExtensionHealth {
  ok: boolean;
  /** One-line detail when not ok (or a status note when ok). */
  detail?: string;
}

/**
 * How the registry's init/start sweeps treat this extension when a hook throws.
 *   - `best-effort` (default) — log and keep sweeping, mirroring the daemon's hand-wired
 *     per-organ try/catch (a broken mail poller must not take Discord/tickets down).
 *   - `fail-fast` — rethrow and abort the boot, for concierge-grade organs whose failed
 *     start must fail the whole daemon.
 * `stop` is always best-effort: teardown never blocks on one organ's failure.
 */
export type LifecycleFailPolicy = "best-effort" | "fail-fast";

/**
 * WHEN in the boot sequence an extension's `start` runs. The daemon's organs genuinely start
 * at two different stages, and the v5 ordering is load-bearing:
 *   - `early` (default) — before the pollers prime: crash recovery that must land before the
 *     tracker re-staffs work (the browser agent's stranded-run re-report).
 *   - `late` — after the pollers, mail, and the rest of the live system are up: schedulers
 *     whose fires DISPATCH into that system (the routine cron loop; memory's nightly
 *     maintain in Phase 6). Starting these early would race their own dependencies.
 * One flat startAll could not honor both without silently reordering the boot.
 */
export type LifecycleStartPhase = "early" | "late";

/**
 * Optional lifecycle hooks. Stateless extensions (github, image) declare none. Stateful ones
 * (memory holds retrieval indices, browser owns a subprocess) implement what they need:
 *   - `init`  — build state, open connections; may run before the daemon accepts traffic.
 *   - `start` — begin any background loops (a poller, a nightly maintain pass), at
 *               `startPhase` in the boot order.
 *   - `stop`  — tear down cleanly on daemon shutdown / hot-reload.
 *   - `health`— the doctor/observation-window probe.
 * The registry orchestrates these across all extensions in registration order.
 */
export interface ExtensionLifecycle {
  /** Sweep error policy for `init`/`start`. Defaults to `best-effort`. */
  failPolicy?: LifecycleFailPolicy;
  /** Which boot stage runs this extension's `start`. Defaults to `early`. */
  startPhase?: LifecycleStartPhase;
  init?: (ctx: ExtensionContext) => Promise<void> | void;
  start?: (ctx: ExtensionContext) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  health?: () => Promise<ExtensionHealth> | ExtensionHealth;
}

// =======================================================================================
// The Extension — the one contract everything registers through
// =======================================================================================

/**
 * A self-describing v6 extension. `manifest` is the only required field; everything else is a
 * facet the extension opts into. The NEW-in-v6 facets are `capabilities` + `invoke` (discovery
 * and dispatch — the @mention flow) and `lifecycle` (stateful organs). The rest are the v5
 * capability facets, carried unchanged so migration is additive.
 */
export interface Extension {
  manifest: ExtensionManifest;

  // --- v6: discovery + dispatch (the plug-n-play core) ---
  /** Machine-readable capabilities the concierge discovers and routes over. */
  capabilities?: ExtensionCapability[];
  /**
   * The single dispatch entrypoint. The registry validates the call (capability exists, args
   * match the schema) before invoking this, so the body handles only already-validated input.
   * Required whenever `capabilities` is non-empty; an extension advertising capabilities it
   * cannot service is a wiring bug the registry refuses at registration.
   */
  invoke?: (call: ExtensionInvocation, ctx: ExtensionContext) => Promise<ExtensionResult>;

  // --- v6: lifecycle (stateful extensions) ---
  lifecycle?: ExtensionLifecycle;

  // --- v6: worker stages (Phase 5 — the dispatcher's pluggable stage facet) ---
  /**
   * Worker stages this extension contributes ({@link StageFacet}). Registered into the global
   * stage-name and entry-state namespaces (loud refusal on collision, like capability ids), and
   * deliberately excluded from the discovery catalog — the dispatcher staffs stages from ticket
   * states; the concierge never routes an @mention to one.
   */
  stages?: readonly StageFacet[];

  // --- v5 facets, subsumed unchanged ---
  cliVerbs?: CliVerb[];
  busCommands?: BusCommand[];
  promptBlock?: PromptBlock;
  configSchema?: z.ZodTypeAny;
  /** Where the config fragment mounts in config.toml; defaults to `manifest.id`. */
  configKey?: string;
  /**
   * The token this extension contributes to the auto-generated `beckett` command list —
   * `Capability.cliHelp` carried through (Phase 1: the CLI help stays byte-identical when an
   * organ migrates). Omitted → its verbs work but stay unadvertised.
   */
  cliHelp?: string;
  /** Optional pointer to the extension's SKILL.md (stays a plain file — zero coupling). */
  skillDoc?: string;
}

/**
 * The common factory shape (mirrors {@link CapabilityFactory} and {@link DriverFactory}): the
 * caller threads the resolved runtime context in; the module never loads config or resolves
 * paths itself.
 */
export type ExtensionFactory = (ctx: ExtensionContext) => Extension;

/** The effective action-class of a capability: its own override, else the extension default. */
export function effectiveActionClass(
  extension: Extension,
  capability: { actionClass?: ActionClass },
): ActionClass {
  return capability.actionClass ?? extension.manifest.actionClass;
}
