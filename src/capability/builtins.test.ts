/**
 * Coverage for the builtin config fragments (`src/capability/builtins.ts`) — the V5 Phase 1c
 * contract: the top-level config schema is COMPOSED from per-capability fragments, and the
 * composition validates identically to the retired monolith (the byte-level proof is the
 * `deploy/config.toml.example` drift test + the CLI characterization snapshot of
 * `config print-default`; these tests pin the composition mechanics themselves).
 */

import { expect, test } from "bun:test";
import { builtinCapabilities, builtinCapabilityRegistry, configFragments } from "./builtins.ts";
import { composeConfigSchema, defaultConfig, validateConfig } from "../config.ts";

test("every top-level config key is owned by exactly one builtin capability fragment", () => {
  const fragmentKeys = Object.keys(configFragments);
  // The fully-defaulted config is the ground truth for "what keys exist".
  expect(fragmentKeys.sort()).toEqual(Object.keys(defaultConfig()).sort());
  // …and each mounts through a registered capability (configKey → fragment), none dropped.
  const registered = builtinCapabilityRegistry().configFragments();
  expect([...registered.keys()].sort()).toEqual(fragmentKeys.sort());
});

test("fragment order is registration order — the observable TOML section order", () => {
  const registry = builtinCapabilityRegistry();
  expect([...registry.configFragments().keys()]).toEqual(Object.keys(configFragments));
});

test("builtin capabilities are config-only stubs in Phase 1c (verbs/commands arrive in later phases)", () => {
  for (const capability of builtinCapabilities()) {
    expect(capability.configSchema).toBeDefined();
    expect(capability.cliVerbs).toEqual([]);
    expect(capability.busCommands).toEqual([]);
  }
});

test("the composed schema parses an empty config to the fully-defaulted Config", () => {
  const composed = composeConfigSchema(builtinCapabilityRegistry());
  const parsed = composed.safeParse({});
  expect(parsed.success).toBe(true);
  expect(parsed.success && parsed.data).toEqual(defaultConfig());
});

test("a top-level key no capability claims is still a loud refuse-to-start", () => {
  expect(() => validateConfig({ not_a_capability: {} })).toThrow(/refusing to start/);
});

// #158 — the concierge chat/routing/filing seat ships on Sonnet 5 at medium effort. Pinned so a
// silent regression back to Opus (the pre-#158 default) fails CI. quick.model must stay Sonnet 5.
test("the shipped concierge default is claude-sonnet-5 at medium effort", () => {
  const config = defaultConfig();
  expect(config.concierge.model).toBe("claude-sonnet-5");
  expect(config.concierge.effort).toBe("medium");
  // Guardrail: the swap must not have touched the (already-Sonnet) quick lane.
  expect(config.quick.model).toBe("claude-sonnet-5");
});

// overhaul B-P16 (Task 4) — [proactive_sweep] repos is the sweep's ONE explicit opt-in list.
test("[proactive_sweep] repos defaults to empty", () => {
  const config = defaultConfig();
  expect(config.proactive_sweep.repos).toEqual([]);
});

test("a repo entry that isn't owner/name is refused at config load", () => {
  expect(() => validateConfig({ proactive_sweep: { repos: ["not-owner-slash-name"] } })).toThrow(
    /owner\/name/,
  );
});
