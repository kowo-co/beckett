/**
 * Beckett v6 — the extension registry (`src/ext/registry.ts`)
 * =======================================================================================
 * The single registry every v6 extension registers through, and the seam the core dispatches
 * to them across. It generalizes the four v5 plug-in tables (drivers, capabilities, agents,
 * stages — see {@link ./contract.ts}) into one, and adds the two things the @mention flow
 * needs that none of them had:
 *
 *   - DISCOVERY: {@link ExtensionRegistry.catalog} renders every advertised capability into a
 *     compact block the concierge routes over. Slash commands are dead; the concierge reads
 *     descriptions and picks — this is #55's "modular concierge prompting" made general.
 *   - DISPATCH: {@link ExtensionRegistry.invoke} validates a call (capability exists, args match
 *     the schema) and routes it to the owning extension's single `invoke` entrypoint.
 *
 * Registration is loud on any collision (duplicate extension id, capability id, CLI verb, bus
 * command, or config key), exactly like {@link CapabilityRegistry}: two extensions can never
 * silently shadow one another, and an extension advertising a capability it cannot service is
 * refused at registration rather than failing at dispatch.
 *
 * LIVE since the v6 boot wiring: `shell/main.ts` holds the ONE runtime instance (registered
 * organs, initAll/startAll/stopAll folded into boot/shutdown) and the concierge serves
 * `ext.invoke`/`ext.catalog` from it over the control bus. The license enforcement
 * (`src/agency`) stays upstream — the registry routes, it never widens.
 */

import type { z } from "zod";
import type { Logger } from "../types.ts";
import {
  effectiveActionClass,
  type ActionClass,
  type Extension,
  type ExtensionCapability,
  type ExtensionContext,
  type ExtensionHealth,
  type ExtensionInvocation,
  type ExtensionResult,
  type LifecycleStartPhase,
  type StageFacet,
} from "./contract.ts";

/** A resolved capability plus the extension that owns it. */
export interface ResolvedCapability {
  extension: Extension;
  capability: ExtensionCapability;
}

/** One line of the discovery catalog the concierge routes over. */
export interface CatalogEntry {
  extensionId: string;
  capabilityId: string;
  description: string;
  actionClass: ActionClass;
  examples: string[];
}

/** A single extension's health verdict, tagged with its id, for the doctor/observation window. */
export interface ExtensionHealthReport extends ExtensionHealth {
  extensionId: string;
}

/**
 * Render the discovery catalog as the ONE compact block the concierge's system prompt carries
 * (docs/v6-architecture.md §6, Phase 2+): capability id + router prose, one line each.
 * Deterministic — entries arrive in registration order — so the composed prompt is stable
 * across launches and never thrashes the prompt cache. An empty catalog renders to "" so an
 * unwired/empty registry leaves the prompt byte-identical.
 */
export function renderCatalogBlock(entries: CatalogEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `- ${entry.capabilityId} — ${entry.description}`);
  return (
    `<extension-catalog>\n` +
    `Capabilities registered with the daemon's extension registry. This is the discovery ` +
    `surface — when a request fits one, dispatch it through its usual beckett verb/skill:\n` +
    `${lines.join("\n")}\n` +
    `</extension-catalog>`
  );
}

/** A registered stage facet plus the id of the extension that contributed it. */
interface ResolvedStage {
  extensionId: string;
  stage: StageFacet;
}

export class ExtensionRegistry {
  private readonly byId = new Map<string, Extension>();
  private readonly byCapabilityId = new Map<string, ResolvedCapability>();
  private readonly byCliVerb = new Map<string, string>(); // verb name → extension id
  private readonly byBusCommand = new Map<string, string>(); // command name → extension id
  // Worker stages (v6 Phase 5). Two indices because staffing resolves state→stage: a duplicate
  // ENTRY STATE is as dangerous as a duplicate name (insertion-order lookup would silently
  // shadow the first claimant), so both are global namespaces guarded at registration.
  private readonly byStageName = new Map<string, ResolvedStage>();
  private readonly byStageEntryState = new Map<string, ResolvedStage>();

  /**
   * Register an extension, validating the WHOLE module before touching any index — a
   * half-registered extension (id claimed, a capability colliding) would be worse than a loud
   * refusal. Throws with a clear, attributable message on any collision or inconsistency.
   */
  register(extension: Extension): void {
    const id = extension.manifest.id;
    if (!id.trim()) throw new Error("beckett: an extension needs a non-empty manifest.id");
    if (!extension.manifest.version.trim()) {
      throw new Error(`beckett: extension "${id}" needs a non-empty manifest.version`);
    }
    if (this.byId.has(id)) {
      throw new Error(`beckett: extension "${id}" is already registered`);
    }

    // An extension that advertises capabilities MUST be able to service them.
    const capabilities = extension.capabilities ?? [];
    if (capabilities.length > 0 && !extension.invoke) {
      throw new Error(
        `beckett: extension "${id}" advertises capabilities but declares no invoke() to service them`,
      );
    }

    // --- validate capability ids (global namespace) ---
    const seenCaps = new Set<string>();
    for (const cap of capabilities) {
      if (!cap.id.trim()) {
        throw new Error(`beckett: extension "${id}" declares a capability with an empty id`);
      }
      if (seenCaps.has(cap.id)) {
        throw new Error(`beckett: extension "${id}" declares capability "${cap.id}" twice`);
      }
      seenCaps.add(cap.id);
      const clash = this.byCapabilityId.get(cap.id);
      if (clash) {
        throw new Error(
          `beckett: capability "${cap.id}" is already registered by extension "${clash.extension.manifest.id}" ` +
            `(extension "${id}" tried to register it too)`,
        );
      }
    }

    // --- validate CLI verbs ---
    const seenVerbs = new Set<string>();
    for (const verb of extension.cliVerbs ?? []) {
      if (!verb.name.trim()) {
        throw new Error(`beckett: extension "${id}" declares a CLI verb with an empty name`);
      }
      if (seenVerbs.has(verb.name)) {
        throw new Error(`beckett: extension "${id}" declares CLI verb "${verb.name}" twice`);
      }
      seenVerbs.add(verb.name);
      const holder = this.byCliVerb.get(verb.name);
      if (holder) {
        throw new Error(
          `beckett: CLI verb "${verb.name}" is already registered by extension "${holder}" ` +
            `(extension "${id}" tried to register it too)`,
        );
      }
    }

    // --- validate bus commands ---
    const seenCommands = new Set<string>();
    for (const command of extension.busCommands ?? []) {
      if (!command.name.trim()) {
        throw new Error(`beckett: extension "${id}" declares a bus command with an empty name`);
      }
      if (seenCommands.has(command.name)) {
        throw new Error(`beckett: extension "${id}" declares bus command "${command.name}" twice`);
      }
      seenCommands.add(command.name);
      const holder = this.byBusCommand.get(command.name);
      if (holder) {
        throw new Error(
          `beckett: bus command "${command.name}" is already registered by extension "${holder}" ` +
            `(extension "${id}" tried to register it too)`,
        );
      }
    }

    // --- validate stage facets (global stage-name + entry-state namespaces, v6 Phase 5) ---
    const seenStages = new Set<string>();
    const seenEntryStates = new Set<string>();
    for (const stage of extension.stages ?? []) {
      if (!stage.name.trim()) {
        throw new Error(`beckett: extension "${id}" declares a stage with an empty name`);
      }
      if (seenStages.has(stage.name)) {
        throw new Error(`beckett: extension "${id}" declares stage "${stage.name}" twice`);
      }
      seenStages.add(stage.name);
      const stageHolder = this.byStageName.get(stage.name);
      if (stageHolder) {
        throw new Error(
          `beckett: stage "${stage.name}" is already registered by extension "${stageHolder.extensionId}" ` +
            `(extension "${id}" tried to register it too)`,
        );
      }
      if (stage.entryState !== undefined) {
        if (seenEntryStates.has(stage.entryState)) {
          throw new Error(
            `beckett: extension "${id}" declares two stages staffing entry state "${stage.entryState}"`,
          );
        }
        seenEntryStates.add(stage.entryState);
        const stateHolder = this.byStageEntryState.get(stage.entryState);
        if (stateHolder) {
          throw new Error(
            `beckett: entry state "${stage.entryState}" already staffs stage "${stateHolder.stage.name}" of ` +
              `extension "${stateHolder.extensionId}" (extension "${id}" stage "${stage.name}" tried to claim it too)`,
          );
        }
      }
    }

    // --- validate config key ---
    const configKey = extension.configKey ?? id;
    if (extension.configSchema) {
      for (const [otherId, other] of this.byId) {
        const otherKey = other.configKey ?? otherId;
        if (other.configSchema && otherKey === configKey) {
          throw new Error(
            `beckett: config key "${configKey}" is claimed by both extension "${otherId}" and "${id}"`,
          );
        }
      }
    }

    // All checks passed — commit to every index.
    this.byId.set(id, extension);
    for (const cap of capabilities) this.byCapabilityId.set(cap.id, { extension, capability: cap });
    for (const verb of extension.cliVerbs ?? []) this.byCliVerb.set(verb.name, id);
    for (const command of extension.busCommands ?? []) this.byBusCommand.set(command.name, id);
    for (const stage of extension.stages ?? []) {
      this.byStageName.set(stage.name, { extensionId: id, stage });
      if (stage.entryState !== undefined) {
        this.byStageEntryState.set(stage.entryState, { extensionId: id, stage });
      }
    }
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Registered extension ids, in registration order. */
  list(): string[] {
    return [...this.byId.keys()];
  }

  /** Resolve an extension by id. Throws the same loud shape as the driver/capability registries. */
  get(id: string): Extension {
    const extension = this.byId.get(id);
    if (!extension) {
      throw new Error(
        `beckett: no extension registered for "${id}" (available: ${this.list().join(", ") || "none"})`,
      );
    }
    return extension;
  }

  /** Resolve a capability by its namespaced id, or null. */
  resolveCapability(capabilityId: string): ResolvedCapability | null {
    return this.byCapabilityId.get(capabilityId) ?? null;
  }

  // --- worker stages (v6 Phase 5) ---
  // The registry indexes the CONTRACT's structural {@link StageFacet}; dispatch widens it back
  // to its full StageDefinition through its own view (`dispatch/stages.ts#stageViewOf`), keeping
  // `src/ext` free of dispatch-domain types. Stages never appear in {@link catalog} — they are
  // staffed by the run supervisor, not routed from an @mention.

  /** The registered stage facet named `name`, or undefined for an unregistered stage. */
  stage(name: string): StageFacet | undefined {
    return this.byStageName.get(name)?.stage;
  }

  /** The stage a run entering `state` should staff, if any (unique — enforced at register()). */
  stageForState(state: string): StageFacet | undefined {
    return this.byStageEntryState.get(state)?.stage;
  }

  /** Registered stage names, in registration order (diagnostics). */
  stageNames(): string[] {
    return [...this.byStageName.keys()];
  }

  /**
   * The discovery catalog: every advertised capability across all extensions, in registration
   * order. This is what the concierge renders into its system prompt to route @mentions —
   * descriptions and examples included, license posture resolved.
   */
  catalog(): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const extension of this.byId.values()) {
      for (const cap of extension.capabilities ?? []) {
        entries.push({
          extensionId: extension.manifest.id,
          capabilityId: cap.id,
          description: cap.description,
          actionClass: effectiveActionClass(extension, cap),
          examples: cap.examples ?? [],
        });
      }
    }
    return entries;
  }

  /**
   * Dispatch a call to the owning extension. Validates in order: capability exists → args match
   * its `input` schema (when declared) → the extension has an `invoke`. Returns the extension's
   * {@link ExtensionResult}, or an `ok:false` result with a clear error on any validation miss,
   * so a caller never has to distinguish "no such capability" from "the extension threw".
   *
   * NOTE: the license gate ({@link ../agency}) is NOT enforced here — the registry routes;
   * the core enforces action-class before it ever calls invoke. Keeping them separate is the
   * v6 rule (`docs/v6.md` § The license): the registry never widens what an extension may do.
   */
  async invoke(call: ExtensionInvocation, ctx: ExtensionContext): Promise<ExtensionResult> {
    const resolved = this.byCapabilityId.get(call.capabilityId);
    if (!resolved) {
      return { ok: false, error: `beckett: no capability "${call.capabilityId}" is registered` };
    }
    const { extension, capability } = resolved;

    let args = call.args;
    if (capability.input) {
      const parsed = (capability.input as z.ZodTypeAny).safeParse(call.args);
      if (!parsed.success) {
        return {
          ok: false,
          error: `beckett: invalid args for "${call.capabilityId}": ${parsed.error.message}`,
        };
      }
      args = parsed.data as Record<string, unknown>;
    }

    if (!extension.invoke) {
      // Unreachable via register() (it refuses capabilities without invoke), but total by design.
      return { ok: false, error: `beckett: extension "${extension.manifest.id}" has no invoke()` };
    }
    return extension.invoke({ ...call, args }, ctx);
  }

  // --- lifecycle orchestration (stateful extensions) ---

  /**
   * One init/start pass in registration order, with per-organ error isolation: a throwing
   * `best-effort` organ (the default) is logged and skipped so one broken extension cannot
   * take the rest of the boot down; a `fail-fast` organ ({@link LifecycleFailPolicy}) rethrows
   * and aborts the sweep — concierge-grade organs opt in.
   */
  private async sweep(
    hook: "init" | "start",
    ctx: ExtensionContext,
    phase?: LifecycleStartPhase,
  ): Promise<void> {
    for (const extension of this.byId.values()) {
      const fn = extension.lifecycle?.[hook];
      if (!fn) continue;
      if (phase && (extension.lifecycle?.startPhase ?? "early") !== phase) continue;
      try {
        await fn(ctx);
      } catch (err) {
        if ((extension.lifecycle?.failPolicy ?? "best-effort") === "fail-fast") throw err;
        ctx.logger.warn(`extension ${hook} failed`, {
          extension: extension.manifest.id,
          error: (err as Error).message ?? String(err),
        });
      }
    }
  }

  /** Run every extension's `init` in registration order (per-organ isolation, see {@link sweep}). */
  async initAll(ctx: ExtensionContext): Promise<void> {
    await this.sweep("init", ctx);
  }

  /**
   * Run `start` for every extension in the given boot stage ({@link LifecycleStartPhase}), in
   * registration order with per-organ isolation. The daemon calls this twice: `"early"` before
   * the pollers prime (crash recovery), `"late"` once the live system is up (schedulers whose
   * fires dispatch into it). Calling with no phase starts everything — the pre-staging behavior,
   * kept for tests and single-stage embedders.
   */
  async startAll(ctx: ExtensionContext, phase?: LifecycleStartPhase): Promise<void> {
    await this.sweep("start", ctx, phase);
  }

  /**
   * Run every extension's `stop` in REVERSE registration order (teardown mirrors setup).
   * Always best-effort — a throwing stop is logged and never blocks the rest of the drain,
   * matching the daemon shutdown's hand-wired per-organ try/catch.
   */
  async stopAll(logger?: Logger): Promise<void> {
    for (const extension of [...this.byId.values()].reverse()) {
      try {
        await extension.lifecycle?.stop?.();
      } catch (err) {
        logger?.warn("extension shutdown failed", {
          extension: extension.manifest.id,
          error: (err as Error).message ?? String(err),
        });
      }
    }
  }

  /**
   * Collect a health verdict from every extension that declares one. A THROWING probe is a
   * verdict too — it becomes `ok:false` with the error as detail, and collection continues,
   * so one broken probe can never blind the doctor to the rest.
   */
  async health(): Promise<ExtensionHealthReport[]> {
    const reports: ExtensionHealthReport[] = [];
    for (const extension of this.byId.values()) {
      const probe = extension.lifecycle?.health;
      if (!probe) continue;
      try {
        const verdict = await probe();
        reports.push({ extensionId: extension.manifest.id, ...verdict });
      } catch (err) {
        reports.push({
          extensionId: extension.manifest.id,
          ok: false,
          detail: (err as Error).message ?? String(err),
        });
      }
    }
    return reports;
  }

  /**
   * The composed config fragments: `configKey` (default: the extension id) → zod schema. The
   * core mounts these into the top-level config schema instead of the monolith — the same move
   * {@link CapabilityRegistry.configFragments} makes, carried onto the unified contract.
   */
  configFragments(): Map<string, z.ZodTypeAny> {
    const fragments = new Map<string, z.ZodTypeAny>();
    for (const [id, extension] of this.byId) {
      if (!extension.configSchema) continue;
      fragments.set(extension.configKey ?? id, extension.configSchema);
    }
    return fragments;
  }
}
