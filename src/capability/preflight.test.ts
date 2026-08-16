/**
 * Capability preflight tests (`src/capability/preflight.ts`, overhaul B10).
 * All fakes — no network. Severity policy is the thing under test: only `not-installed` /
 * `no-such-owner` block; everything else is advisory, and every throwing check fails open.
 */
import { describe, expect, test } from "bun:test";
import { createCapabilityPreflight, renderCapabilityGaps } from "./preflight.ts";
import type { AccessDiagnosis } from "../github/app.ts";

function target(over: Partial<{ repo: string | null; prompt: string }> = {}) {
  return { repo: over.repo === undefined ? "acme/widgets" : over.repo, prompt: over.prompt ?? "add a feature" };
}

describe("github check", () => {
  test("an uninstalled org is a blocking gap carrying the install link", async () => {
    const diagnosis: AccessDiagnosis = { status: "not-installed", owner: "acme", installUrl: "https://github.com/apps/beckett/installations/new" };
    const preflight = createCapabilityPreflight({ github: { diagnoseAccess: async () => diagnosis } });
    const inv = await preflight(target());
    expect(inv.gaps).toHaveLength(1);
    expect(inv.gaps[0]!.kind).toBe("github-not-installed");
    expect(inv.gaps[0]!.severity).toBe("blocking");
    expect(inv.gaps[0]!.fix).toBe(diagnosis.installUrl);
    expect(inv.checked).toContain("github");
  });

  test("no such owner is blocking and does not offer an install link as the fix", async () => {
    const diagnosis: AccessDiagnosis = { status: "no-such-owner", owner: "acmee" };
    const preflight = createCapabilityPreflight({ github: { diagnoseAccess: async () => diagnosis } });
    const inv = await preflight(target({ repo: "acmee/widgets" }));
    expect(inv.gaps).toHaveLength(1);
    expect(inv.gaps[0]!.kind).toBe("github-no-such-owner");
    expect(inv.gaps[0]!.severity).toBe("blocking");
    expect(inv.gaps[0]!.fix).not.toMatch(/^https?:\/\//);
  });

  test("an installed org with the repo unselected is advisory, not blocking", async () => {
    const diagnosis: AccessDiagnosis = {
      status: "repo-not-selected",
      owner: "acme",
      repo: "acme/widgets",
      installationId: 1,
      installUrl: "https://github.com/apps/beckett/installations/new",
    };
    const preflight = createCapabilityPreflight({ github: { diagnoseAccess: async () => diagnosis } });
    const inv = await preflight(target());
    expect(inv.gaps).toHaveLength(1);
    expect(inv.gaps[0]!.severity).toBe("advisory");
    expect(inv.gaps[0]!.kind).toBe("github-repo-not-selected");
  });

  test("repo-not-selected-or-missing is also advisory", async () => {
    const diagnosis: AccessDiagnosis = {
      status: "repo-not-selected-or-missing",
      owner: "acme",
      repo: "acme/widgets",
      installationId: 1,
      installUrl: "https://github.com/apps/beckett/installations/new",
    };
    const preflight = createCapabilityPreflight({ github: { diagnoseAccess: async () => diagnosis } });
    const inv = await preflight(target());
    expect(inv.gaps[0]!.severity).toBe("advisory");
  });

  test("an ok diagnosis produces no gaps", async () => {
    const diagnosis: AccessDiagnosis = { status: "ok", owner: "acme", installationId: 1, repositorySelection: "all" };
    const preflight = createCapabilityPreflight({ github: { diagnoseAccess: async () => diagnosis } });
    const inv = await preflight(target());
    expect(inv.gaps).toHaveLength(0);
    expect(inv.checked).toContain("github");
  });

  test("no repo target never runs the github check", async () => {
    let called = false;
    const preflight = createCapabilityPreflight({
      github: {
        diagnoseAccess: async () => {
          called = true;
          return { status: "ok", owner: "acme", installationId: 1, repositorySelection: "all" };
        },
      },
    });
    const inv = await preflight(target({ repo: null }));
    expect(called).toBe(false);
    expect(inv.checked).not.toContain("github");
  });
});

describe("keychain check", () => {
  test("a jingle entry named in the prompt but absent from the vault is advisory", async () => {
    const preflight = createCapabilityPreflight({ keychain: { list: async () => ["x-account"] } });
    const inv = await preflight(target({ prompt: "use the jingle entry huggingface" }));
    expect(inv.gaps).toHaveLength(1);
    expect(inv.gaps[0]!.kind).toBe("keychain-entry-missing");
    expect(inv.gaps[0]!.severity).toBe("advisory");
    expect(inv.gaps[0]!.subject).toBe("huggingface");
  });

  test("an entry that exists produces no gap", async () => {
    const preflight = createCapabilityPreflight({ keychain: { list: async () => ["huggingface"] } });
    const inv = await preflight(target({ prompt: "use the jingle entry huggingface" }));
    expect(inv.gaps).toHaveLength(0);
  });

  test("a prompt that names no entry never calls list()", async () => {
    let called = false;
    const preflight = createCapabilityPreflight({
      keychain: {
        list: async () => {
          called = true;
          return [];
        },
      },
    });
    const inv = await preflight(target({ prompt: "add a feature", repo: null }));
    expect(called).toBe(false);
    expect(inv.gaps).toHaveLength(0);
  });

  test("credsEntry: syntax is also recognized", async () => {
    const preflight = createCapabilityPreflight({ keychain: { list: async () => [] } });
    const inv = await preflight(target({ prompt: "dispatch with credsEntry: huggingface", repo: null }));
    expect(inv.gaps).toHaveLength(1);
    expect(inv.gaps[0]!.subject).toBe("huggingface");
  });
});

describe("browser check", () => {
  test("browser intent with a down lane is advisory", async () => {
    const preflight = createCapabilityPreflight({ browserLane: () => ({ ok: false, detail: "host crashed" }) });
    const inv = await preflight(target({ prompt: "log in to the site and screenshot the page", repo: null }));
    expect(inv.gaps).toHaveLength(1);
    expect(inv.gaps[0]!.kind).toBe("browser-lane-down");
    expect(inv.gaps[0]!.severity).toBe("advisory");
    expect(inv.gaps[0]!.detail).toContain("host crashed");
  });

  test("browser intent with a healthy lane is silent", async () => {
    const preflight = createCapabilityPreflight({ browserLane: () => ({ ok: true, detail: "fine" }) });
    const inv = await preflight(target({ prompt: "log in to the site", repo: null }));
    expect(inv.gaps).toHaveLength(0);
    expect(inv.checked).toContain("browser");
  });

  test("no browser intent never probes the lane", async () => {
    let called = false;
    const preflight = createCapabilityPreflight({
      browserLane: () => {
        called = true;
        return { ok: false, detail: "down" };
      },
    });
    const inv = await preflight(target({ prompt: "refactor the config loader", repo: null }));
    expect(called).toBe(false);
    expect(inv.checked).not.toContain("browser");
  });
});

describe("fail-open", () => {
  test("a throwing check is dropped and the inventory still returns", async () => {
    const preflight = createCapabilityPreflight({
      github: {
        diagnoseAccess: async () => {
          throw new Error("network down");
        },
      },
      keychain: { list: async () => [] },
    });
    const inv = await preflight(target({ prompt: "use the jingle entry huggingface" }));
    expect(inv.checked).toContain("github");
    // The github check threw, but the keychain check still ran and reported its own gap.
    expect(inv.gaps.some((g) => g.kind === "keychain-entry-missing")).toBe(true);
    expect(inv.gaps.some((g) => g.kind.startsWith("github"))).toBe(false);
  });

  test("a throwing keychain check is dropped without touching other checks", async () => {
    const preflight = createCapabilityPreflight({
      keychain: {
        list: async () => {
          throw new Error("jingle not on PATH");
        },
      },
      browserLane: () => ({ ok: false, detail: "down" }),
    });
    const inv = await preflight(target({ prompt: "log in with the jingle entry x", repo: null }));
    expect(inv.gaps.some((g) => g.kind === "keychain-entry-missing")).toBe(false);
    expect(inv.gaps.some((g) => g.kind === "browser-lane-down")).toBe(true);
  });

  test("a throwing browser lane probe is dropped", async () => {
    const preflight = createCapabilityPreflight({
      browserLane: () => {
        throw new Error("boom");
      },
    });
    const inv = await preflight(target({ prompt: "log in to the site", repo: null }));
    expect(inv.gaps).toHaveLength(0);
  });
});

describe("renderCapabilityGaps", () => {
  test("puts blocking first and separates advisories", () => {
    const rendered = renderCapabilityGaps([
      { kind: "keychain-entry-missing", subject: "x", detail: "advisory detail", fix: "advisory fix", severity: "advisory" },
      { kind: "github-not-installed", subject: "acme", detail: "blocking detail", fix: "blocking fix", severity: "blocking" },
    ]);
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("this run needs you before it can land:");
    const blockingIdx = lines.findIndex((l) => l.includes("blocking detail"));
    const advisoryHeaderIdx = lines.findIndex((l) => l === "also worth clearing (not blocking):");
    const advisoryIdx = lines.findIndex((l) => l.includes("advisory detail"));
    expect(blockingIdx).toBeGreaterThan(0);
    expect(advisoryHeaderIdx).toBeGreaterThan(blockingIdx);
    expect(advisoryIdx).toBeGreaterThan(advisoryHeaderIdx);
  });

  test("empty gaps render empty", () => {
    expect(renderCapabilityGaps([])).toBe("");
  });
});
