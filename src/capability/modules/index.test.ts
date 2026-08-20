/**
 * The normalized capability modules (V5 Phase 2): the factory table mirrors the driver
 * registry's contract — loud errors for anything unregistered, and the id-match invariant so
 * a mis-keyed module can never silently shadow another capability. The modules' observable
 * CLI behavior is pinned separately by the characterization suite
 * (`src/cli/characterization.test.ts`); these tests prove the table and the built shapes.
 */

import { expect, test } from "bun:test";
import { CapabilityRegistry, type CapabilityDeps } from "../index.ts";
import {
  availableCapabilityModules,
  createCapability,
  getCapabilityFactory,
  hasCapabilityModule,
} from "./index.ts";
import { validateConfig } from "../../config.ts";
import { buildPaths } from "../../paths.ts";
import type { Logger } from "../../types.ts";

function deps(): CapabilityDeps {
  const config = validateConfig({});
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return { config, paths: buildPaths(config, {}), logger: quiet };
}

test("every formerly-bespoke module is on the common factory shape", () => {
  expect(availableCapabilityModules().sort()).toEqual(
    ["codemap", "deploy", "dns", "github", "image", "mail", "memory", "secret"],
  );
  expect(hasCapabilityModule("github")).toBeTrue();
  expect(hasCapabilityModule("nope")).toBeFalse();
});

test("an unregistered module id fails loudly, the driver-registry way", () => {
  expect(() => getCapabilityFactory("nope")).toThrow(
    'beckett: no capability module registered for "nope"',
  );
});

test("every module builds a capability matching its table key and registers through the spine", () => {
  const registry = new CapabilityRegistry();
  for (const id of availableCapabilityModules()) {
    const capability = createCapability(id, deps());
    expect(capability.id).toBe(id);
    // Self-describing: a summary, at least one CLI verb, every verb runnable.
    expect(capability.summary.length).toBeGreaterThan(0);
    expect(capability.cliVerbs.length).toBeGreaterThan(0);
    for (const verb of capability.cliVerbs) expect(typeof verb.run).toBe("function");
    // Registers cleanly — no id/verb/bus collisions across the whole normalized set.
    registry.register(capability);
  }
  expect(registry.list().sort()).toEqual(availableCapabilityModules().sort());
});

test("the normalized modules keep the exact CLI verbs the cascade served", () => {
  const registry = new CapabilityRegistry();
  for (const id of availableCapabilityModules()) registry.register(createCapability(id, deps()));
  const verbs = registry.cliVerbs().map(({ verb }) => verb.name).sort();
  expect(verbs).toEqual(["codemap", "deploy", "dns", "gh", "image", "mail", "memory", "recall", "secret"]);
  // recall + memory both belong to the memory module (OPS-121 kept both spellings).
  expect(registry.resolveCliVerb(["recall", "x"])!.capability.id).toBe("memory");
  expect(registry.resolveCliVerb(["memory", "recall", "x"])!.capability.id).toBe("memory");
});
