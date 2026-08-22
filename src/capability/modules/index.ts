/**
 * Beckett v5 — the normalized capability modules (`src/capability/modules/index.ts`)
 * =======================================================================================
 * Phase 2 of the extensibility refactor: the formerly-bespoke capability modules — github,
 * dns+deploy (cloudflare), image, memory, mail, secret — on the ONE common factory shape
 * ({@link CapabilityFactory}), looked up through the same table posture as the harness
 * driver registry (`drivers/index.ts`): add a factory entry, implement the interface, done.
 *
 * Consumers (today: `cli/beckett.ts::buildCliCapabilities`) never import a module file
 * directly — they ask this table by id and register the built {@link Capability} in a
 * {@link CapabilityRegistry}. Asking for anything unregistered fails loudly rather than
 * silently degrading, and a module whose built id disagrees with its table key is a wiring
 * bug caught at build time, not a silently shadowed capability.
 */

import type { Capability, CapabilityDeps, CapabilityFactory } from "../index.ts";
import { createCodemapCapability } from "./codemap.ts";
import { createDeployCapability, createDnsCapability } from "./cloudflare.ts";
import { createGithubCapability } from "./github.ts";
import { createImageCapability } from "./image.ts";
import { createMailCapability } from "./mail.ts";
import { createMemoryCapability } from "./memory.ts";
import { createSecretCapability } from "./secret.ts";

export { createDeployCapability, createDnsCapability } from "./cloudflare.ts";
export { createGithubCapability } from "./github.ts";
export { createImageCapability } from "./image.ts";
export { createMailCapability } from "./mail.ts";
export { createMemoryCapability } from "./memory.ts";
export { createSecretCapability } from "./secret.ts";
// V6 Phase 1 (docs/v6-architecture.md §6): the first organs on the extension contract. Their
// table entries above are the asCapability projections; these are the extensions themselves.
export { createImageExtension } from "./image.ts";
export { createSecretExtension } from "./secret.ts";
// V6 Phase 4 (docs/v6-architecture.md §6): the catalog cutover — the remaining bespoke modules
// on the extension contract. github/dns/deploy/mail carry real capabilities[]+invoke (daemon-safe
// throwing cores). Their FACTORIES entries below are the asCapability projections; these are
// the extensions.
export { createGithubExtension } from "./github.ts";
export { createDnsExtension, createDeployExtension } from "./cloudflare.ts";
export { createMailExtension } from "./mail.ts";
// V6 Phase 6: the memory organ proper — lifecycle owns the daemon's warm store + the nightly
// maintain loop (startPhase "late"), capabilities memory.recall/memory.remember derive their
// Audience from the token-derived origin INSIDE memory code (docs/v6-architecture.md §7). The
// CLI verbs are carried and projected into their spine slot exactly as before.
export { createMemoryExtension } from "./memory.ts";
export type { MemoryExtension, MemoryExtensionDeps } from "./memory.ts";
// V6 Phase 2: the first STATEFUL organ — lifecycle wraps the browser host subprocess + the
// background agent. Not in the v5 FACTORIES table: browser never had a spine slot (its CLI
// verb and bus bodies live in cli/beckett.ts and the concierge respectively).
export { createBrowserExtension } from "./browser.ts";
export type { BrowserExtension, BrowserExtensionDeps } from "./browser.ts";
// V6 Phase 3: the quick organ — lifecycle wraps the short-lived specialist runner; the CLI
// verb is carried and projected into its spine slot. Not in the v5 FACTORIES table: like
// browser, quick never had one (its bus bodies live in the concierge).
export { createQuickExtension } from "./quick.ts";
export type { QuickExtension, QuickExtensionDeps } from "./quick.ts";
// V6 Phase 3b: the routines organ — the first extension whose lifecycle.start runs a
// BACKGROUND LOOP (the cron scheduler, startPhase "late"); the CLI verb is carried and
// projected into its spine slot. Not in the v5 FACTORIES table: like browser/quick, routine
// never had one (its spine slot was an inline literal in cli/beckett.ts).
export { createRoutinesExtension } from "./routines.ts";
export type { RoutinesExtension, RoutinesExtensionDeps } from "./routines.ts";
// V6 Phase 3b (reminders, ro's ask): same shape as routines — the tick loop is a BACKGROUND
// LOOP (startPhase "late"); the CLI verb is carried and projected into its spine slot. Not in
// the v5 FACTORIES table: like routine, reminders never had one.
export { createRemindersExtension } from "./reminders.ts";
export type { RemindersExtension, RemindersExtensionDeps } from "./reminders.ts";

/** The capability-id → factory table (the analog of `drivers/index.ts::FACTORIES`). */
const FACTORIES: Record<string, CapabilityFactory> = {
  github: createGithubCapability,
  dns: createDnsCapability,
  deploy: createDeployCapability,
  image: createImageCapability,
  mail: createMailCapability,
  memory: createMemoryCapability,
  secret: createSecretCapability,
  // File-level repo map injected into every worker persona. Pull this one line (and the
  // worktree-cut write) if the §7 after-measurement gate says the ~5k-token tax doesn't pay.
  codemap: createCodemapCapability,
};

/** Whether a normalized module is registered for `id`. */
export function hasCapabilityModule(id: string): boolean {
  return id in FACTORIES && FACTORIES[id] !== undefined;
}

/** The set of capability ids with a normalized module in this build. */
export function availableCapabilityModules(): string[] {
  return Object.keys(FACTORIES).filter((id) => FACTORIES[id] !== undefined);
}

/**
 * Resolve the factory for a capability module. Throws a clear error for an unregistered id so
 * the caller escalates instead of silently doing nothing.
 */
export function getCapabilityFactory(id: string): CapabilityFactory {
  const factory = FACTORIES[id];
  if (!factory) {
    throw new Error(
      `beckett: no capability module registered for "${id}" ` +
        `(available: ${availableCapabilityModules().join(", ") || "none"})`,
    );
  }
  return factory;
}

/**
 * Build a capability module for the given id. Convenience over {@link getCapabilityFactory},
 * plus the id-match invariant: a module claiming a different id than its table key can never
 * silently shadow another capability.
 */
export function createCapability(id: string, deps: CapabilityDeps): Capability {
  const capability = getCapabilityFactory(id)(deps);
  if (capability.id !== id) {
    throw new Error(
      `beckett: capability module registered as "${id}" built a capability claiming id "${capability.id}"`,
    );
  }
  return capability;
}
