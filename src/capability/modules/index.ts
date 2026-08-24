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

// V6 Phase 1 (docs/v6-architecture.md §6): the first organs on the extension contract. Their
// FACTORIES entries below are the asCapability projections; these are the extensions themselves.
export { createImageExtension } from "./image.ts";
export { createSecretExtension } from "./secret.ts";
// V6 Phase 4 (docs/v6-architecture.md §6): the catalog cutover — the remaining bespoke modules
// on the extension contract. github/dns/deploy/mail carry real capabilities[]+invoke (daemon-safe
// throwing cores). Their FACTORIES entries below are the asCapability projections; these are
// the extensions.
export { createGithubExtension } from "./github.ts";
export { createDnsExtension, createDeployExtension } from "./cloudflare.ts";
export { createMailExtension } from "./mail.ts";
// V6 Phase 2: the first STATEFUL organ — lifecycle wraps the browser host subprocess + the
// background agent. Not in the v5 FACTORIES table: browser never had a spine slot (its CLI
// verb and bus bodies live in cli/beckett.ts and the concierge respectively).
export { createBrowserExtension } from "./browser.ts";
// The memory/quick/routines/reminders organs are NOT re-exported here — `shell/main.ts`
// imports each from its own module file (`./memory.ts`, `./quick.ts`, …), which is the one
// import style this table is standardizing on.

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
