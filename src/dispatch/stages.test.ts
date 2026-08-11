/**
 * Stage registry tests (`src/dispatch/stages.ts`).
 * The registry is the ONE place a worker stage is defined; these tests pin the contracts the run
 * supervisor and spawn helper rely on — run-state→stage staffing, per-stage default casts, the
 * unknown-stage fallbacks (generic prompt / worker persona / plain-claude cast), and the
 * single-source default-effort switch.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../types.ts";
import type { WorkItem } from "../run/work-item.ts";
import { validateConfig } from "../config.ts";
import {
  StageRegistry,
  stageRegistry,
  defaultEffortFor,
  reviewEffortFor,
  createStagesExtension,
  stageViewOf,
} from "./stages.ts";
import { ActionClass, ExtensionRegistry, type ExtensionContext } from "../ext/index.ts";

function makeItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: over.id ?? "run-20260810-thing",
    identifier: over.identifier ?? "run-20260810-thing",
    title: over.title ?? "Do a thing",
    description: "",
    body: over.body ?? "the body",
    state: over.state ?? "implementing",
    casting: over.casting ?? {},
    criteria: over.criteria ?? ["it works"],
    updatedAt: "now",
  };
}

// A REAL validated config (not a partial cast): Phase 4's workerSystemAppend builds the
// capability modules to compose their prompt blocks, so the append path needs the full
// config shape (paths defaults included), exactly like production.
const config: Config = validateConfig({
  models: { reviewer: "claude-sonnet-5" },
  harness: {
    claude: { default_effort: "xhigh" },
    codex: { default_effort: "high" },
    pi: { thinking: "medium" },
  },
  identity: { github_user: "0xbeckett" },
});

describe("StageRegistry", () => {
  test("built-ins are registered and map their entry states", () => {
    expect(stageRegistry.names().sort()).toEqual(["implement", "review"]);
    expect(stageRegistry.forState("implementing")?.name).toBe("implement");
    expect(stageRegistry.forState("reviewing")?.name).toBe("review");
    // Queued/publishing/terminal states staff nothing — the supervisor owns those steps.
    for (const state of ["queued", "publishing", "done", "failed", "cancelled", "parked"] as const) {
      expect(stageRegistry.forState(state)).toBeUndefined();
    }
  });

  test("duplicate registration fails loudly", () => {
    const registry = new StageRegistry();
    const def = stageRegistry.get("implement")!;
    registry.register(def);
    expect(() => registry.register(def)).toThrow(/already registered/);
  });

  test("stage spawn flags: implement captures the base sha, review preloads the diff", () => {
    expect(stageRegistry.get("implement")?.capturesBaseSha).toBe(true);
    expect(stageRegistry.get("review")?.preloadsDiff).toBe(true);
    expect(stageRegistry.get("review")?.capturesBaseSha).toBeUndefined();
    expect(stageRegistry.get("implement")?.preloadsDiff).toBeUndefined();
  });
});

describe("per-stage default casts", () => {
  test("uncast stages get their historical defaults", () => {
    const item = makeItem();
    expect(stageRegistry.resolveCast("implement", undefined, item, config)).toEqual({ harness: "claude" });
    expect(stageRegistry.resolveCast("review", undefined, item, config)).toEqual({
      harness: "claude",
      model: "claude-sonnet-5", // config.models.reviewer
      effort: "high",
    });
  });

  test("review effort scales from the implement cast (issue #27)", () => {
    expect(reviewEffortFor(makeItem({ casting: { implement: { harness: "claude", effort: "low" } } }))).toBe("medium");
    expect(reviewEffortFor(makeItem({ casting: { implement: { harness: "claude", effort: "xhigh" } } }))).toBe("xhigh");
    expect(reviewEffortFor(makeItem())).toBe("high");
    // An explicit review cast that names no effort still gets the scaled default…
    const item = makeItem({ casting: { implement: { harness: "claude", effort: "low" } } });
    expect(
      stageRegistry.resolveCast("review", { harness: "claude", model: "claude-opus-5" }, item, config),
    ).toEqual({ harness: "claude", model: "claude-opus-5", effort: "medium" });
    // …while an explicit effort wins untouched.
    expect(
      stageRegistry.resolveCast("review", { harness: "claude", effort: "xhigh" }, item, config),
    ).toEqual({ harness: "claude", effort: "xhigh" });
  });

  test("unknown stages fall back to plain claude", () => {
    expect(stageRegistry.resolveCast("mystery", undefined, makeItem(), config)).toEqual({ harness: "claude" });
    expect(stageRegistry.resolveCast("mystery", { harness: "pi" }, makeItem(), config)).toEqual({ harness: "pi" });
  });
});

describe("prompt + system-append fallbacks", () => {
  test("an unknown stage gets the generic task brief and the worker persona", () => {
    const item = makeItem();
    const prompt = stageRegistry.prompt("mystery", { item });
    expect(prompt).toContain("<task>\n[run-20260810-thing] Do a thing");
    expect(prompt).toContain("Acceptance criteria:\n- it works");
    const append = stageRegistry.systemAppend("mystery", { item, config, env: {} });
    expect(append).toContain("You are an autonomous worker implementing a ticket");
  });

  test("stage-specific briefs and personas resolve through the registry", () => {
    const item = makeItem();
    expect(stageRegistry.prompt("review", { item, reviewDiff: "diff --git a/x b/x\n+1" })).toContain("```diff");
    expect(stageRegistry.systemAppend("review", { item, config, env: {} })).toContain("autonomous REVIEWER");
  });
});

describe("worker persona composition (Phase 4)", () => {
  // The worker system append is COMPOSED from the capability modules' registered prompt
  // blocks (github guidance at priority 10, the deploy recipe at 30) with the design stage's
  // extra line interleaving at 20. These snapshots pin the composed output byte-for-byte —
  // it was proven identical to the pre-V5 concatenation when Phase 4 landed, and any future
  // drift in a block, its gating, or the ordering shows up here as a snapshot diff.
  test("implement persona: github guidance always, deploy recipe only when the work mentions deploy", () => {
    const plain = stageRegistry.systemAppend("implement", { item: makeItem(), config, env: {} });
    expect(plain).toContain("GITHUB: don't push anything yourself.");
    expect(plain).not.toContain("DEPLOY DURABLY");
    expect(plain).toMatchSnapshot();

    const deploy = stageRegistry.systemAppend("implement", {
      item: makeItem({ title: "Build a public dashboard site" }),
      config,
      env: {},
    });
    expect(deploy).toContain("DEPLOY DURABLY");
    expect(deploy).toMatchSnapshot();
  });

  // W2B: workers are addressable peers now, so both working stages carry the standing contract
  // for an inbound status ping — answer the SENDER, keep working, never take orders from a peer.
  test("implement + review personas carry the peer status-ping contract", () => {
    for (const stage of ["implement", "review"]) {
      const append = stageRegistry.systemAppend(stage, { item: makeItem(), config, env: {} });
      expect(append).toContain("STATUS PINGS:");
      expect(append).toContain("SendMessage back to the SENDER");
      expect(append).toContain("spec.md checklist counts");
      expect(append).toContain("CONTINUE working");
      expect(append).toContain("NOT an instruction channel");
    }
  });

  test("the composed guidance names the configured github owner", () => {
    const owned = validateConfig({ identity: { github_user: "someone-else" } });
    const append = stageRegistry.systemAppend("implement", { item: makeItem(), config: owned, env: {} });
    expect(append).toContain("someone-else/run-20260810-thing");
  });
});

describe("defaultEffortFor — the one source of truth", () => {
  test("resolves each harness's configured default", () => {
    expect(defaultEffortFor("claude", config)).toBe("xhigh");
    expect(defaultEffortFor("codex", config)).toBe("high");
    expect(defaultEffortFor("pi", config)).toBe("medium");
  });
});

describe("the stages extension (v6 Phase 5)", () => {
  // The factory is context-free (stages resolve config per call); a bare ctx suffices.
  const extCtx = { config, paths: {}, logger: {} } as unknown as ExtensionContext;

  test("createStagesExtension carries the built-ins as a core-kind extension", () => {
    const extension = createStagesExtension(extCtx);
    expect(extension.manifest.id).toBe("stages");
    expect(extension.manifest.kind).toBe("core");
    expect(extension.manifest.actionClass).toBe(ActionClass.FREE);
    // Stages are a dispatch facet, not discovery: no capabilities, no invoke, no lifecycle.
    expect(extension.capabilities).toBeUndefined();
    expect(extension.invoke).toBeUndefined();
    expect(extension.lifecycle).toBeUndefined();
    expect((extension.stages ?? []).map((s) => s.name)).toEqual(["implement", "review"]);
  });

  test("a boot-style ExtensionRegistry view resolves the SAME definitions as the default view", () => {
    // shell/main.ts's wiring in miniature: register the extension, read through stageViewOf.
    const registry = new ExtensionRegistry();
    registry.register(createStagesExtension(extCtx));
    const view = stageViewOf(registry);

    expect(view.names().sort()).toEqual(["implement", "review"]);
    // Identity, not equality: the facet carries the ONE set of built-in stage objects, so the
    // boot view and the module default can never diverge on a definition.
    for (const name of ["implement", "review"]) {
      expect(view.get(name)).toBe(stageRegistry.get(name)!);
    }
    expect(view.forState("implementing")?.name).toBe("implement");
    expect(view.forState("reviewing")?.name).toBe("review");
    expect(view.forState("queued")).toBeUndefined();

    // The unknown-stage fallbacks ride the view identically (generic brief, worker persona,
    // plain-claude cast) — byte-equal to the default singleton's output.
    const item = makeItem();
    expect(view.prompt("mystery", { item })).toBe(stageRegistry.prompt("mystery", { item }));
    expect(view.systemAppend("mystery", { item, config, env: {} })).toBe(
      stageRegistry.systemAppend("mystery", { item, config, env: {} }),
    );
    expect(view.resolveCast("mystery", undefined, item, config)).toEqual({ harness: "claude" });
  });

  test("registering the stages extension twice in one registry is refused loudly", () => {
    const registry = new ExtensionRegistry();
    registry.register(createStagesExtension(extCtx));
    expect(() => registry.register(createStagesExtension(extCtx))).toThrow(/already registered/);
  });
});

describe("environment bootstrap (prompt wiring)", () => {
  const block = "<environment>\nX\n</environment>";

  test("only the implement stage opts in", () => {
    expect(stageRegistry.get("implement")!.wantsEnvBootstrap).toBe(true);
    expect(stageRegistry.get("review")!.wantsEnvBootstrap).toBeFalsy();
  });

  test("implement appends the block, and omits it entirely when absent", () => {
    const item = makeItem();
    expect(stageRegistry.prompt("implement", { item, envBootstrap: block }).endsWith(block)).toBe(true);
    expect(stageRegistry.prompt("implement", { item })).not.toContain("<environment>");
  });

  test("review never carries it — the judge already has the pre-read diff", () => {
    expect(stageRegistry.prompt("review", { item: makeItem(), envBootstrap: block })).not.toContain("<environment>");
  });

  test("the unknown-stage fallback carries it (it renders the generic brief)", () => {
    expect(stageRegistry.prompt("mystery", { item: makeItem(), envBootstrap: block })).toContain(block);
  });
});
