/**
 * The capability spine (V5 Phase 0): the registry mirrors the driver registry's contract —
 * loud errors for anything unregistered, loud refusal of collisions — plus the lookup and
 * composition helpers the later phases dispatch through. Nothing here touches the live CLI
 * or bus: Phase 0 defines and proves the spine without wiring it.
 */

import { expect, test } from "bun:test";
import { z } from "zod";
import {
  ActionClass,
  type Capability,
  CapabilityRegistry,
  effectiveActionClass,
} from "./index.ts";
import { validateConfig } from "../config.ts";

function cap(overrides: Partial<Capability> & { id: string }): Capability {
  return {
    summary: `the ${overrides.id} capability`,
    actionClass: ActionClass.FREE,
    cliVerbs: [],
    busCommands: [],
    ...overrides,
  };
}

test("register + get + has + list mirror the driver registry contract", () => {
  const registry = new CapabilityRegistry();
  const memory = cap({ id: "memory" });
  registry.register(memory);
  expect(registry.has("memory")).toBeTrue();
  expect(registry.has("github")).toBeFalse();
  expect(registry.get("memory")).toBe(memory);
  expect(registry.list()).toEqual(["memory"]);
});

test("get throws the same loud shape as the driver registry for an unknown id", () => {
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "memory" }));
  expect(() => registry.get("nope")).toThrow(
    'beckett: no capability registered for "nope" (available: memory)',
  );
  expect(() => new CapabilityRegistry().get("nope")).toThrow("(available: none)");
});

test("duplicate capability id is refused loudly", () => {
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "memory" }));
  expect(() => registry.register(cap({ id: "memory" }))).toThrow(
    'capability "memory" is already registered',
  );
});

test("an empty id, verb name, or bus command name is refused", () => {
  const registry = new CapabilityRegistry();
  expect(() => registry.register(cap({ id: "  " }))).toThrow("non-empty id");
  expect(() =>
    registry.register(cap({ id: "a", cliVerbs: [{ name: " ", summary: "s", usage: "u" }] })),
  ).toThrow("empty name");
  expect(() =>
    registry.register(cap({ id: "b", busCommands: [{ name: "", summary: "s" }] })),
  ).toThrow("empty name");
});

test("a CLI verb collision across capabilities is refused and names both sides", () => {
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "tickets", cliVerbs: [{ name: "ticket create", summary: "s", usage: "u" }] }));
  expect(() =>
    registry.register(cap({ id: "impostor", cliVerbs: [{ name: "ticket create", summary: "s", usage: "u" }] })),
  ).toThrow('CLI verb "ticket create" is already registered by capability "tickets"');
  // The refused capability left no trace — not even its id.
  expect(registry.has("impostor")).toBeFalse();
});

test("a bus command collision across capabilities is refused and names both sides", () => {
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "channels", busCommands: [{ name: "channels.wipe", summary: "s" }] }));
  expect(() =>
    registry.register(cap({ id: "impostor", busCommands: [{ name: "channels.wipe", summary: "s" }] })),
  ).toThrow('bus command "channels.wipe" is already registered by capability "channels"');
  expect(registry.has("impostor")).toBeFalse();
});

test("a capability declaring the same verb or command twice is refused atomically", () => {
  const registry = new CapabilityRegistry();
  expect(() =>
    registry.register(
      cap({
        id: "dup",
        cliVerbs: [
          { name: "x", summary: "s", usage: "u" },
          { name: "x", summary: "s", usage: "u" },
        ],
      }),
    ),
  ).toThrow('declares CLI verb "x" twice');
  // Validation happens before any index is touched: a fresh registration of "x" works.
  expect(registry.has("dup")).toBeFalse();
  registry.register(cap({ id: "ok", cliVerbs: [{ name: "x", summary: "s", usage: "u" }] }));
  expect(registry.resolveCliVerb(["x"])?.capability.id).toBe("ok");

  expect(() =>
    registry.register(
      cap({
        id: "dup2",
        busCommands: [
          { name: "y.z", summary: "s" },
          { name: "y.z", summary: "s" },
        ],
      }),
    ),
  ).toThrow('declares bus command "y.z" twice');
});

test("resolveCliVerb prefers the longest match and returns the remaining argv", () => {
  const registry = new CapabilityRegistry();
  registry.register(
    cap({
      id: "tickets",
      cliVerbs: [
        { name: "ticket", summary: "fallback", usage: "u" },
        { name: "ticket create", summary: "create", usage: "u" },
      ],
    }),
  );
  const create = registry.resolveCliVerb(["ticket", "create", "--title", "x"]);
  expect(create?.verb.name).toBe("ticket create");
  expect(create?.rest).toEqual(["--title", "x"]);
  const bare = registry.resolveCliVerb(["ticket", "list"]);
  expect(bare?.verb.name).toBe("ticket"); // no "ticket list" registered → group fallback
  expect(bare?.rest).toEqual(["list"]);
  expect(registry.resolveCliVerb(["nope"])).toBeNull();
  expect(registry.resolveCliVerb([])).toBeNull();
});

test("resolveBusCommand is an exact-name lookup returning null for the unknown", () => {
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "quick", busCommands: [{ name: "quick.run", summary: "s" }] }));
  expect(registry.resolveBusCommand("quick.run")?.capability.id).toBe("quick");
  expect(registry.resolveBusCommand("quick")).toBeNull();
});

test("cliVerbs()/busCommands() walk everything registered, in registration order", () => {
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "a", cliVerbs: [{ name: "alpha", summary: "s", usage: "u" }] }));
  registry.register(
    cap({
      id: "b",
      cliVerbs: [{ name: "beta", summary: "s", usage: "u" }],
      busCommands: [{ name: "b.go", summary: "s" }],
    }),
  );
  expect(registry.cliVerbs().map((v) => v.verb.name)).toEqual(["alpha", "beta"]);
  expect(registry.busCommands().map((c) => c.command.name)).toEqual(["b.go"]);
});

test("effectiveActionClass: the verb/command override wins over the capability default", () => {
  const capability = cap({ id: "gh", actionClass: ActionClass.FREE });
  expect(effectiveActionClass(capability, {})).toBe(ActionClass.FREE);
  expect(effectiveActionClass(capability, { actionClass: ActionClass.HANDSHAKE_GATED })).toBe(
    ActionClass.HANDSHAKE_GATED,
  );
});

test("an arg schema on a verb validates the parsed argv shape", () => {
  const schema = z.object({
    _: z.array(z.string()).length(1),
    flags: z.object({ board: z.string().optional() }).passthrough(),
  });
  const registry = new CapabilityRegistry();
  registry.register(
    cap({ id: "t", cliVerbs: [{ name: "ticket show", summary: "s", usage: "u", args: schema }] }),
  );
  const hit = registry.resolveCliVerb(["ticket", "show", "OPS-1"])!;
  expect(hit.verb.args!.safeParse({ _: ["OPS-1"], flags: {} }).success).toBeTrue();
  expect(hit.verb.args!.safeParse({ _: [], flags: {} }).success).toBeFalse();
});

test("configFragments maps configKey (default: id) → fragment and refuses key collisions", () => {
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "mail", configSchema: z.object({ enabled: z.boolean() }) }));
  registry.register(cap({ id: "imagegen", configKey: "image", configSchema: z.object({}) }));
  registry.register(cap({ id: "plain" })); // no fragment → not in the map
  const fragments = registry.configFragments();
  expect([...fragments.keys()]).toEqual(["mail", "image"]);

  registry.register(cap({ id: "impostor", configKey: "mail", configSchema: z.object({}) }));
  expect(() => registry.configFragments()).toThrow(
    'config key "mail" is claimed by both capability "mail" and "impostor"',
  );
});

test("composeCliHelp joins cliHelp tokens in registration order, skipping unlisted capabilities", () => {
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "status", cliHelp: "status [--pretty]" }));
  registry.register(cap({ id: "journal" })); // no token → the verb works but is unadvertised
  registry.register(cap({ id: "discord", cliHelp: "discord reply|decline" }));
  registry.register(cap({ id: "blank", cliHelp: "   " })); // whitespace-only → unlisted too
  expect(registry.composeCliHelp()).toBe("status [--pretty] | discord reply|decline");
});

test("composePrompt sorts by priority then id, drops empty renders, joins with single newlines", () => {
  const config = validateConfig({});
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "z-first", promptBlock: { id: "z-first", priority: -1, render: () => "FIRST" } }));
  registry.register(cap({ id: "b", promptBlock: { id: "b", render: () => "B-BLOCK" } }));
  registry.register(cap({ id: "a", promptBlock: { id: "a", render: () => "  A-BLOCK  " } }));
  registry.register(cap({ id: "empty", promptBlock: { id: "empty", render: () => "   " } }));
  registry.register(cap({ id: "silent" })); // no block at all
  expect(registry.composePrompt({ config })).toBe("FIRST\nA-BLOCK\nB-BLOCK");
});

test("composePrompt interleaves caller-supplied extra blocks by the same priority order", () => {
  const config = validateConfig({});
  const registry = new CapabilityRegistry();
  registry.register(cap({ id: "gh", promptBlock: { id: "gh", priority: 10, render: () => "GUIDANCE" } }));
  registry.register(cap({ id: "dep", promptBlock: { id: "dep", priority: 30, render: () => "RECIPE" } }));
  const stageLine = { id: "stage:design-only", priority: 20, render: () => "DESIGN-ONLY" };
  expect(registry.composePrompt({ config }, [stageLine])).toBe("GUIDANCE\nDESIGN-ONLY\nRECIPE");
});

test("composePrompt renders with the live config", () => {
  const config = validateConfig({ runs: { max_live: 7 } });
  const registry = new CapabilityRegistry();
  registry.register(
    cap({
      id: "runs",
      promptBlock: { id: "runs", render: ({ config: c }) => `max live runs: ${c.runs.max_live}` },
    }),
  );
  expect(registry.composePrompt({ config })).toBe("max live runs: 7");
});
