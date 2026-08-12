/**
 * V6 Phase 1 — image + secret on the extension contract (docs/v6-architecture.md §6).
 * Pins the seam end-to-end on the first two migrated organs: registration + discovery
 * (catalog), schema-validated dispatch (invoke never exits the process — refusals come back
 * as ok:false results), the fail-first env preflight, and the asCapability projection the
 * CLI registers until Phase 4. The organs' CLI surface stays pinned separately by
 * `src/cli/characterization.test.ts`.
 */

import { expect, test } from "bun:test";
import { ActionClass, CapabilityRegistry } from "../index.ts";
import { asCapability, ExtensionRegistry, type ExtensionContext } from "../../ext/index.ts";
import {
  createDeployExtension,
  createDnsExtension,
  createGithubExtension,
  createImageExtension,
  createMailExtension,
  createSecretExtension,
} from "./index.ts";
import { validateConfig } from "../../config.ts";
import { buildPaths } from "../../paths.ts";
import type { Logger } from "../../types.ts";

function ctx(): ExtensionContext {
  const config = validateConfig({});
  const quiet = { info() {}, warn() {}, debug() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  return { config, paths: buildPaths(config, {}), logger: quiet };
}

function registryWithBoth(): { registry: ExtensionRegistry; deps: ExtensionContext } {
  const deps = ctx();
  const registry = new ExtensionRegistry();
  registry.register(createImageExtension(deps));
  registry.register(createSecretExtension(deps));
  return { registry, deps };
}

/** Run a block with an env key temporarily unset, restoring whatever was there. */
async function withoutEnv<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

// ── registration + discovery ─────────────────────────────────────────────────────────────

test("image + secret register on the extension contract and advertise their capabilities", () => {
  const { registry } = registryWithBoth();
  expect(registry.list()).toEqual(["image", "secret"]);
  const catalog = registry.catalog();
  expect(catalog.map((e) => e.capabilityId)).toEqual(["image.generate", "secret.request"]);
  // The catalog is what the concierge routes over — every entry needs real routing prose.
  for (const entry of catalog) {
    expect(entry.description.length).toBeGreaterThan(40);
    expect(entry.examples.length).toBeGreaterThan(0);
  }
});

test("both organs are stateless: no lifecycle, so the health surface is empty", async () => {
  const { registry } = registryWithBoth();
  expect(await registry.health()).toEqual([]);
});

// ── dispatch: validation refusals come back as results, never exits ──────────────────────

test("invoke refuses an unknown capability with ok:false", async () => {
  const { registry, deps } = registryWithBoth();
  const r = await registry.invoke({ capabilityId: "image.nope", args: {} }, deps);
  expect(r.ok).toBeFalse();
  expect(r.error).toContain('no capability "image.nope"');
});

test("image.generate validates args at the seam: empty prompt and video-without-fal refuse", async () => {
  const { registry, deps } = registryWithBoth();
  const empty = await registry.invoke({ capabilityId: "image.generate", args: {} }, deps);
  expect(empty.ok).toBeFalse();
  expect(empty.error).toContain("invalid args");

  const video = await registry.invoke(
    { capabilityId: "image.generate", args: { prompt: "a cat", video: true } },
    deps,
  );
  expect(video.ok).toBeFalse();
  expect(video.error).toContain("fal video model");
});

test("secret.request refuses name+fields together and neither, via the schema refine", async () => {
  const { registry, deps } = registryWithBoth();
  const both = await registry.invoke(
    { capabilityId: "secret.request", args: { name: "K", fields: "user,pass" } },
    deps,
  );
  expect(both.ok).toBeFalse();
  expect(both.error).toContain("exactly one of");

  const neither = await registry.invoke({ capabilityId: "secret.request", args: {} }, deps);
  expect(neither.ok).toBeFalse();
  expect(neither.error).toContain("exactly one of");
});

test("secret.request keeps the intake validators: bad env name and keychain-without-entry refuse", async () => {
  const { registry, deps } = registryWithBoth();
  const badName = await registry.invoke(
    { capabilityId: "secret.request", args: { name: "not a key" } },
    deps,
  );
  expect(badName.ok).toBeFalse();
  expect(badName.error).toContain("environment key");

  const noEntry = await registry.invoke(
    { capabilityId: "secret.request", args: { fields: "user,pass" } },
    deps,
  );
  expect(noEntry.ok).toBeFalse();
  expect(noEntry.error).toContain("--entry");
});

test("secret.request preflights Cloudflare creds BEFORE touching systemd/tunnels", async () => {
  const { registry, deps } = registryWithBoth();
  const r = await withoutEnv(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_TUNNEL_ID"], () =>
    registry.invoke({ capabilityId: "secret.request", args: { name: "MY_KEY" } }, deps),
  );
  expect(r.ok).toBeFalse();
  expect(r.error).toContain("CLOUDFLARE_API_TOKEN");
});

// ── the Phase 1–4 bridge: the CLI registers the projection ───────────────────────────────

test("asCapability projects the carried v5 facets so the CLI spine slot is unchanged", () => {
  const deps = ctx();
  const image = asCapability(createImageExtension(deps));
  const secret = asCapability(createSecretExtension(deps));

  expect(image.id).toBe("image");
  expect(image.cliHelp).toBe("image");
  expect(image.skillDoc).toBe(".claude/skills/image/SKILL.md");
  expect(image.cliVerbs.map((v) => v.name)).toEqual(["image"]);
  expect(typeof image.cliVerbs[0]!.run).toBe("function");

  expect(secret.id).toBe("secret");
  expect(secret.cliHelp).toBe("secret request");
  expect(secret.cliVerbs.map((v) => v.name)).toEqual(["secret"]);

  // Both projections register cleanly into the v5 spine (the CLI's exact move).
  const spine = new CapabilityRegistry();
  spine.register(image);
  spine.register(secret);
  expect(spine.resolveCliVerb(["image", "a", "cat"])!.capability.id).toBe("image");
  expect(spine.resolveCliVerb(["secret", "request"])!.capability.id).toBe("secret");
});

// ── V6 Phase 4 — github + dns + deploy + mail (catalog cutover) ─────────────────────────────

function registryWithPhase4(): { registry: ExtensionRegistry; deps: ExtensionContext } {
  const deps = ctx();
  const registry = new ExtensionRegistry();
  registry.register(createGithubExtension(deps));
  registry.register(createDnsExtension(deps));
  registry.register(createDeployExtension(deps));
  registry.register(createMailExtension(deps));
  return { registry, deps };
}

test("github/dns/deploy/mail register and advertise their capabilities with real routing prose", () => {
  const { registry } = registryWithPhase4();
  expect(registry.list()).toEqual(["github", "dns", "deploy", "mail"]);
  const catalog = registry.catalog();
  expect(catalog.map((e) => e.capabilityId)).toEqual([
    "github.repo-create", "github.repo-star", "github.pr-open", "github.pr-merge",
    "github.pr-close", "github.pr-status", "github.pr-review",
    "github.issue-create", "github.issue-list", "github.issue-comment", "github.push",
    "dns.list", "dns.upsert", "dns.remove",
    "deploy.list", "deploy.create", "deploy.remove",
    "mail.inbox", "mail.send", "mail.list", "mail.read",
  ]);
  for (const entry of catalog) {
    expect(entry.description.length).toBeGreaterThan(40);
    expect(entry.examples.length).toBeGreaterThan(0);
  }
});

test("all four leaf organs are stateless: the health surface is empty", async () => {
  const { registry } = registryWithPhase4();
  expect(await registry.health()).toEqual([]);
});

test("outward capabilities carry non-FREE catalog postures; reads stay FREE", () => {
  const { registry } = registryWithPhase4();
  const posture = new Map(registry.catalog().map((e) => [e.capabilityId, e.actionClass]));
  // The real postures ride per-capability; the manifest stays FREE for the projection (below).
  expect(posture.get("github.push")).toBe(ActionClass.ALWAYS_ASK);
  expect(posture.get("github.pr-merge")).toBe(ActionClass.HANDSHAKE_GATED);
  expect(posture.get("github.pr-status")).toBe(ActionClass.FREE);
  expect(posture.get("github.issue-create")).toBe(ActionClass.HANDSHAKE_GATED);
  expect(posture.get("github.issue-comment")).toBe(ActionClass.HANDSHAKE_GATED);
  expect(posture.get("github.issue-list")).toBe(ActionClass.FREE);
  expect(posture.get("deploy.create")).toBe(ActionClass.HANDSHAKE_GATED);
  expect(posture.get("deploy.list")).toBe(ActionClass.FREE);
  expect(posture.get("mail.send")).toBe(ActionClass.HANDSHAKE_GATED);
  expect(posture.get("mail.list")).toBe(ActionClass.FREE);
  expect(posture.get("dns.upsert")).toBe(ActionClass.FREE);
});

test("invoke validates args at the seam across the four organs (refusals, never exits)", async () => {
  const { registry, deps } = registryWithPhase4();
  const repo = await registry.invoke({ capabilityId: "github.repo-create", args: {} }, deps);
  expect(repo.ok).toBeFalse();
  expect(repo.error).toContain("invalid args");

  const dnsUpsert = await registry.invoke({ capabilityId: "dns.upsert", args: { name: "x" } }, deps);
  expect(dnsUpsert.ok).toBeFalse();
  expect(dnsUpsert.error).toContain("invalid args");

  const deployCreate = await registry.invoke({ capabilityId: "deploy.create", args: { name: "x" } }, deps);
  expect(deployCreate.ok).toBeFalse();
  expect(deployCreate.error).toContain("port or a service");

  const mailSend = await registry.invoke({ capabilityId: "mail.send", args: { to: "a@b.c" } }, deps);
  expect(mailSend.ok).toBeFalse();
  expect(mailSend.error).toContain("invalid args");
});

test("preflight refusals fire BEFORE any side effect, from every organ's invoke", async () => {
  const { registry, deps } = registryWithPhase4();
  const dnsR = await withoutEnv(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"], () =>
    registry.invoke({ capabilityId: "dns.list", args: {} }, deps),
  );
  expect(dnsR.ok).toBeFalse();
  expect(dnsR.error).toContain("CLOUDFLARE_API_TOKEN");

  const deployR = await withoutEnv(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"], () =>
    registry.invoke({ capabilityId: "deploy.list", args: {} }, deps),
  );
  expect(deployR.ok).toBeFalse();
  expect(deployR.error).toContain("CLOUDFLARE_API_TOKEN");

  const mailR = await withoutEnv(["AGENTMAIL_API_KEY"], () =>
    registry.invoke({ capabilityId: "mail.inbox", args: {} }, deps),
  );
  expect(mailR.ok).toBeFalse();
  expect(mailR.error).toContain("AGENTMAIL_API_KEY");

  // repo-star is FREE (no origin gate), so it reaches the credential preflight in buildGh. Provide
  // an account so identity resolution gets PAST the account check and lands on the preflight. Strip
  // the WHOLE credential chain, not just the PAT: on a box where the GitHub App is configured
  // (every prod worker), leaving GITHUB_APP_* in place mints a real installation token and turns
  // this into a live star call against the fake repo — a 404 instead of the refusal.
  const savedAccount = process.env.GITHUB_ACCOUNT;
  process.env.GITHUB_ACCOUNT = "beckett";
  try {
    const ghR = await withoutEnv(
      ["GITHUB_PAT", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_APP_PRIVATE_KEY_PEM"],
      () =>
        registry.invoke({ capabilityId: "github.repo-star", args: { repo: "a/b", starred: true } }, deps),
    );
    expect(ghR.ok).toBeFalse();
    expect(ghR.error).toContain("GITHUB_PAT");
  } finally {
    if (savedAccount === undefined) delete process.env.GITHUB_ACCOUNT;
    else process.env.GITHUB_ACCOUNT = savedAccount;
  }
});

test("outward mutating capabilities refuse without an authenticated origin (defense in depth)", async () => {
  const { registry, deps } = registryWithPhase4();
  // The origin gate runs BEFORE the client is built, so this is env-independent.
  const push = await registry.invoke(
    { capabilityId: "github.push", args: { repo: "a/b", branch: "x", dir: "/tmp" } },
    deps,
  );
  expect(push.ok).toBeFalse();
  expect(push.error).toContain("authenticated authorized request");

  const deployCreate = await registry.invoke(
    { capabilityId: "deploy.create", args: { name: "x", port: 3000 } },
    deps,
  );
  expect(deployCreate.ok).toBeFalse();
  expect(deployCreate.error).toContain("authenticated authorized request");
});

test("asCapability projects the phase-4 organs' v5 facets (incl. the worker-append promptBlocks)", () => {
  const deps = ctx();
  const github = asCapability(createGithubExtension(deps));
  const dns = asCapability(createDnsExtension(deps));
  const deploy = asCapability(createDeployExtension(deps));
  const mail = asCapability(createMailExtension(deps));

  // Manifest action-class stays FREE so the CLI spine slot is byte-identical.
  expect(github.actionClass).toBe(ActionClass.FREE);
  expect(github.id).toBe("github");
  expect(github.cliHelp).toBe("gh repo|pr|issue|push|app");
  expect(github.cliVerbs.map((v) => v.name)).toEqual(["gh"]);
  // The worker-append promptBlocks must survive the projection (the characterization suite
  // never exercises workerSystemAppend, so a drop would be silent).
  expect(github.promptBlock?.priority).toBe(10);
  expect(typeof github.promptBlock?.render).toBe("function");
  expect(deploy.promptBlock?.priority).toBe(30);

  expect(dns.cliHelp).toBe("dns ls|add|rm");
  expect(deploy.cliHelp).toBe("deploy <name>|ls|rm");
  expect(mail.cliHelp).toBe("mail inbox|send|ls|read");

  // All four project cleanly into the v5 spine (the CLI's exact move).
  const spine = new CapabilityRegistry();
  spine.register(github);
  spine.register(dns);
  spine.register(deploy);
  spine.register(mail);
  expect(spine.resolveCliVerb(["gh", "repo"])!.capability.id).toBe("github");
  expect(spine.resolveCliVerb(["deploy", "ls"])!.capability.id).toBe("deploy");
  expect(spine.resolveCliVerb(["mail", "inbox"])!.capability.id).toBe("mail");
});
