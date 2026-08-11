/**
 * Beckett v6 — the dns + deploy extensions (`src/capability/modules/cloudflare.ts`)
 * =======================================================================================
 * The two Cloudflare-backed surfaces — `beckett dns …` (zone-scoped records via
 * `agency/cloudflare.ts::CfDns`) and `beckett deploy …` (cloudflared named-tunnel ingress +
 * a CNAME via `shell/deploy.ts::TunnelDeployer`) — on the v6 extension contract (Phase 4,
 * docs/v6-architecture.md §6). They stay TWO extensions (two ids, two help tokens, exactly the
 * command list the CLI has always advertised) but live together here because they share the
 * credential gate and the CfDns client, the same pairing as their implementations.
 *
 * Each surface has two entrypoints over shared throwing cores (client construction + env
 * preflight):
 *   - the CLI verb keeps its historical flag parse + `out`/`fail` byte-for-byte (the CLI
 *     characterization suite pins it; thrown core errors surface via `main().catch(fail)`), and
 *   - the `dns.*` / `deploy.*` capabilities are the v6 dispatch surface: zod-validated args in,
 *     an {@link ExtensionResult} out — never `out`/`fail`, so the daemon can dispatch them.
 *
 * DNS is FREE (a record is a reversible proposal you can delete). DEPLOY acts OUTWARD (it stands
 * a public URL up), so its mutating capabilities carry a non-FREE per-capability posture (forward
 * ext.invoke catalog metadata) and an in-body authenticated-origin backstop — while the manifest
 * action-class stays FREE so the {@link asCapability} projection the v5 spine registers is
 * byte-identical. `createDnsCapability`/`createDeployCapability` remain the projections for the
 * v5 factory table.
 */

import { z } from "zod";
import { ActionClass, type Extension, type ExtensionFactory } from "../../ext/contract.ts";
import { asCapability } from "../../ext/compat.ts";
import type { Capability, CapabilityDeps } from "../index.ts";
import { CfDns, DEFAULT_APEX_DOMAIN, apexDomain } from "../../agency/cloudflare.ts";
import { TunnelDeployer } from "../../shell/deploy.ts";
import { withDeployMarker } from "../../shell/deploy-activity.ts";
import { resolveBeckettDir } from "../../paths.ts";
import { fail, out, parse } from "../../cli/io.ts";
import type { Logger } from "../../types.ts";

/** Throwing preflight + CfDns construction, shared by the CLI wrapper and `dns.*` invoke. */
function buildDnsClient(logger: Logger): CfDns {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
  if (!token) throw new Error("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare DNS is unavailable");
  if (!zoneId) throw new Error("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to your Cloudflare zone id");
  return new CfDns({ token, zoneId, logger });
}

/** Throwing preflight + TunnelDeployer construction, shared by the CLI wrapper and `deploy.*` invoke. */
function buildDeployer(logger: Logger): TunnelDeployer {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
  if (!token) throw new Error("no CLOUDFLARE_API_TOKEN in ~/.beckett/.env — Cloudflare is unavailable");
  if (!zoneId) throw new Error("no CLOUDFLARE_ZONE_ID in ~/.beckett/.env — set it to your Cloudflare zone id");
  const dns = new CfDns({ token, zoneId, logger });
  return new TunnelDeployer({ tunnelId: process.env.CLOUDFLARE_TUNNEL_ID, dns, logger });
}

// ── dns invocation schemas ───────────────────────────────────────────────────────────────────

const DnsListArgs = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
});

const DnsUpsertArgs = z.object({
  name: z.string().trim().min(1, "dns.upsert needs a record name"),
  content: z.string().trim().min(1, "dns.upsert needs record content"),
  type: z.string().optional(),
  /** Cloudflare-proxied (orange cloud). Defaults true, matching the CLI. */
  proxied: z.boolean().optional(),
  ttl: z.number().int().positive().optional(),
});

const DnsRemoveArgs = z.object({
  name: z.string().trim().min(1, "dns.remove needs a record name"),
  type: z.string().optional(),
});

// ── deploy invocation schemas ──────────────────────────────────────────────────────────────

const DeployCreateArgs = z
  .object({
    name: z.string().trim().min(1, "deploy.create needs a name"),
    /** Local port to expose (becomes http://localhost:<port>). */
    port: z.number().int().min(1).max(65535).optional(),
    /** Full local service URL (alternative to `port`). */
    service: z.string().optional(),
  })
  .refine((a) => Boolean(a.service?.trim()) || a.port !== undefined, {
    message: "deploy.create needs a port or a service url",
  });

const DeployRemoveArgs = z.object({
  name: z.string().trim().min(1, "deploy.remove needs a name"),
});

export const createDnsExtension: ExtensionFactory = ({ logger }): Extension => {
  // The former `cli/beckett.ts::runDns`, observable behavior unchanged: flag parse + out/fail
  // stay here; the env gate + client construction come from the shared {@link buildDnsClient}
  // core, whose throws surface via main().catch(fail) with the same messages.
  async function runDns(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const dns = buildDnsClient(logger);
    const { _, flags } = parse(rest);

    if (sub === "ls") {
      out(await dns.list({
        name: flags.name ? String(flags.name) : undefined,
        type: flags.type ? String(flags.type) : undefined,
      }));
    }
    if (sub === "add") {
      const name = _[0];
      if (!name || !flags.content) {
        fail("usage: beckett dns add <name> --content <c> [--type CNAME] [--proxied|--no-proxied] [--ttl N]");
      }
      // proxied defaults to true; --no-proxied or --proxied=false turns it off.
      const proxied = flags["no-proxied"] ? false : flags.proxied === "false" ? false : true;
      out(await dns.upsert({
        name,
        type: flags.type ? String(flags.type) : "CNAME",
        content: String(flags.content),
        proxied,
        ttl: flags.ttl ? Number(flags.ttl) : undefined,
      }));
    }
    if (sub === "rm") {
      const name = _[0];
      if (!name) fail("usage: beckett dns rm <name> [--type T]");
      out(await dns.remove(name, flags.type ? String(flags.type) : undefined));
    }
    fail("usage: beckett dns ls [--name N] [--type T] | add <name> --content <c> [...] | rm <name> [--type T]");
  }

  return {
    manifest: {
      id: "dns",
      version: "1.0.0",
      summary: "zone-scoped Cloudflare DNS, token from env (see the deploy skill)",
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // --- v6 discovery + dispatch (DNS records are reversible — every capability stays FREE) ---
    capabilities: [
      {
        id: "dns.list",
        description:
          "List DNS records on the configured Cloudflare zone, optionally filtered by name or " +
          "type. A pure read — use to check what hostnames resolve or whether a record exists.",
        input: DnsListArgs,
        examples: ["what DNS records point at the zone?", "is there a CNAME for x-tool?"],
      },
      {
        id: "dns.upsert",
        description:
          "Create or update one DNS record on the zone (CNAME by default, proxied by default). " +
          "Reversible — you can remove it. Short names expand to the zone apex. Use to point a " +
          "hostname somewhere.",
        input: DnsUpsertArgs,
        examples: ["point x-tool at my-tunnel as a proxied CNAME"],
      },
      {
        id: "dns.remove",
        description:
          "Delete a DNS record from the zone by name (and optional type). Use to tear down a " +
          "hostname you no longer serve.",
        input: DnsRemoveArgs,
        examples: ["remove the x-tool DNS record"],
      },
    ],
    invoke: async (call) => {
      try {
        switch (call.capabilityId) {
          case "dns.list": {
            const a = call.args as z.infer<typeof DnsListArgs>;
            const data = await buildDnsClient(logger).list({ name: a.name, type: a.type });
            return { ok: true, data };
          }
          case "dns.upsert": {
            const a = call.args as z.infer<typeof DnsUpsertArgs>;
            const data = await buildDnsClient(logger).upsert({
              name: a.name,
              type: a.type ?? "CNAME",
              content: a.content,
              proxied: a.proxied ?? true,
              ttl: a.ttl,
            });
            return { ok: true, data };
          }
          case "dns.remove": {
            const a = call.args as z.infer<typeof DnsRemoveArgs>;
            const data = await buildDnsClient(logger).remove(a.name, a.type);
            return { ok: true, data };
          }
          default:
            return { ok: false, error: `dns: unknown capability "${call.capabilityId}"` };
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    // --- v5 facets, carried through unchanged ---
    cliHelp: "dns ls|add|rm",
    skillDoc: ".claude/skills/deploy/SKILL.md",
    cliVerbs: [
      {
        name: "dns",
        summary: "list/upsert/remove records on the configured Cloudflare zone",
        usage: "beckett dns ls [--name N] [--type T] | add <name> --content <c> [...] | rm <name> [--type T]",
        run: runDns,
      },
    ],
    busCommands: [],
  };
};

export const createDeployExtension: ExtensionFactory = ({ logger }): Extension => {
  // The former `cli/beckett.ts::runDeploy`, observable behavior unchanged: flag parse + out/fail
  // stay here; the env gate + deployer construction come from the shared {@link buildDeployer}
  // core, whose throws surface via main().catch(fail) with the same messages.
  async function runDeploy(argv: string[]): Promise<void> {
    const [sub, ...rest] = argv;
    const deployer = buildDeployer(logger);
    const { _, flags } = parse(rest);

    if (sub === "ls") {
      out(deployer.list());
    }
    if (sub === "rm") {
      const name = _[0];
      if (!name) fail("usage: beckett deploy rm <name>");
      out(await deployer.remove(name));
    }
    // `beckett deploy <name> --port <p>` | `--service <url>`  (sub is the name here)
    if (sub && sub !== "ls" && sub !== "rm") {
      const name = sub;
      const service = flags.service
        ? String(flags.service)
        : flags.port
          ? `http://localhost:${Number(flags.port)}`
          : "";
      if (!service) fail("usage: beckett deploy <name> --port <p> | --service http://localhost:<p>");
      // Mark the deploy in-flight for the daemon's presence tick (#132), cleared when it settles.
      out(await withDeployMarker(resolveBeckettDir(), () => deployer.deploy({ name, service })));
    }
    fail("usage: beckett deploy <name> --port <p> | deploy ls | deploy rm <name>");
  }

  return {
    manifest: {
      id: "deploy",
      version: "1.0.0",
      summary: "cloudflared named-tunnel ingress + a CNAME via CfDns (see the deploy skill)",
      // FREE at the manifest layer for the byte-identical projection; deploy acts outward, so
      // its mutating capabilities carry a non-FREE per-capability posture below.
      actionClass: ActionClass.FREE,
      kind: "extension",
    },

    // --- v6 discovery + dispatch ---
    capabilities: [
      {
        id: "deploy.list",
        description:
          "List the named tunnel deployments currently configured (name → public URL). A pure " +
          "read — use to see what apps are already thrown up at <name>.<zone apex>.",
        examples: ["what's currently deployed?"],
      },
      {
        id: "deploy.create",
        description:
          `Throw a locally-running app up at <name>.${apexDomain()} — creates BOTH the cloudflared ` +
          "tunnel ingress AND the public DNS record in one call. Acts outward (a live public URL), " +
          "so announce the URL in voice. Give a local port or a full service url.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: DeployCreateArgs,
        examples: ["deploy the app on port 3000 at my-demo", "put the mockup up at staging --service http://localhost:8080"],
      },
      {
        id: "deploy.remove",
        description:
          "Tear down a named deployment — removes its tunnel ingress and DNS record. Use to take a " +
          "previously-deployed app offline.",
        actionClass: ActionClass.HANDSHAKE_GATED,
        input: DeployRemoveArgs,
        examples: ["take down the my-demo deployment"],
      },
    ],
    invoke: async (call) => {
      try {
        switch (call.capabilityId) {
          case "deploy.list": {
            return { ok: true, data: buildDeployer(logger).list() };
          }
          case "deploy.create": {
            if (!call.origin?.userId) return { ok: false, error: "deploy: standing up a public URL needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof DeployCreateArgs>;
            const service = a.service?.trim() ? a.service.trim() : `http://localhost:${a.port}`;
            // Mark the deploy in-flight for the daemon's presence tick (#132), cleared when it settles.
            const data = await withDeployMarker(resolveBeckettDir(), () => buildDeployer(logger).deploy({ name: a.name, service }));
            return { ok: true, data };
          }
          case "deploy.remove": {
            if (!call.origin?.userId) return { ok: false, error: "deploy: removing a deployment needs an authenticated authorized request" };
            const a = call.args as z.infer<typeof DeployRemoveArgs>;
            const data = await buildDeployer(logger).remove(a.name);
            return { ok: true, data };
          }
          default:
            return { ok: false, error: `deploy: unknown capability "${call.capabilityId}"` };
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    // --- v5 facets, carried through unchanged ---
    cliHelp: "deploy <name>|ls|rm",
    skillDoc: ".claude/skills/deploy/SKILL.md",
    cliVerbs: [
      {
        name: "deploy",
        summary: `throw a locally-running app up at <name>.${apexDomain()}`,
        usage: "beckett deploy <name> --port <p> | deploy ls | deploy rm <name>",
        run: runDeploy,
      },
    ],
    busCommands: [],
    // The deploy-durability recipe in a worker persona (composed into the system append by
    // `stages.ts::workerSystemAppend`). Priority 30 keeps the historical persona order: github
    // guidance (10) → stage extras (20) → this recipe last. asCapability projects it.
    promptBlock: {
      id: "deploy",
      priority: 30,
      render: ({ ticket, slug }) => {
        if (!ticket || !slug) return "";
        const wantsDeploy = ticketMentionsDeploy(ticket);
        const isFrontend = ticketTouchesFrontend(ticket);
        const isVisual = isFrontend || ticketMentionsVisualWork(ticket);
        if (!wantsDeploy && !isVisual) return "";
        const apex = apexDomain();
        const parts: string[] = [];
        if (wantsDeploy) parts.push(deployDurabilityNote(slug, apex));
        if (isVisual) {
          parts.push(
            "For visual/frontend work, use the BetterWright MCP browser tool to open your local URL and capture a screenshot; never hunt for a Chrome binary or write service units just to inspect it.",
          );
        }
        // NOT composed: the review-preview brief (#76, {@link previewBriefNote}). Its CREATE side
        // is worker-driven (`beckett deploy <slug>-preview`) but its teardown implementor — the
        // PreviewManager, wired through the ticket dispatcher — went with the dispatcher in the
        // v7 rip-out and has no boot wiring on the run engine. Ordering every frontend branch to
        // stand up a durable public host while promising "Beckett tears it down automatically"
        // would leak a hostname, a DNS record, a tunnel ingress and an enabled `systemd --user`
        // unit per run, forever, behind a prompt that says otherwise. Restore this line in the
        // same change that wires `PreviewManager.teardown` into the supervisor's done/cancel path.
        return parts.join("\n");
      },
    },
  };
};

/** The v5 factory-table shapes: the {@link asCapability} projections of the extensions above. */
export function createDnsCapability(deps: CapabilityDeps): Capability {
  return asCapability(createDnsExtension(deps));
}

export function createDeployCapability(deps: CapabilityDeps): Capability {
  return asCapability(createDeployExtension(deps));
}

/**
 * Durable-deploy guidance baked into every implement worker's system prompt (v3.1 robustness).
 * The recurring footgun (OPS-15, OPS-17, OPS-19): workers improvise their own deploy — a
 * foreground server that dies on session end, a server bound somewhere the tunnel can't reach, or
 * a hand-edited ingress with no DNS record — so the URL 404s / never resolves and burns review
 * cycles. The fix is to give ONE exact path and forbid every improvised alternative, then make the
 * worker prove the public URL responds before it may call the ticket done. Slug- and apex-
 * parameterized so the recipe names the worker's real hostname (`<slug>.<zone apex>`); the apex
 * comes from the resolved Cloudflare zone ({@link apexDomain}), defaulting to this install's zone.
 */
export function deployDurabilityNote(slug: string, apex: string = DEFAULT_APEX_DOMAIN): string {
  return (
    `DEPLOY DURABLY (only if the ticket needs a public URL): there is exactly ONE supported path, ` +
    `and improvising your own is the #1 cause of dead links here. Do these three steps, nothing else:\n` +
    `  1. Serve the build on a local port with a server that SURVIVES your session: write a ` +
    `\`systemd --user\` unit and \`systemctl --user enable --now <unit>\`. Bind it to 127.0.0.1 (the ` +
    `tunnel reaches localhost). A foreground process (\`python -m http.server\`, \`vite\`, ` +
    `\`bun run dev\`) or a bare \`&\`/\`nohup\` job is FORBIDDEN — it dies when you exit and the link 404s.\n` +
    `  2. Run \`beckett deploy ${slug} --port <thePort>\`. That command (and ONLY that command) ` +
    `creates BOTH the Cloudflare tunnel ingress AND the public DNS record for ` +
    `\`${slug}.${apex}\`. NEVER hand-edit \`~/.cloudflared/config.yml\` or touch DNS yourself — ` +
    `that leaves a half-deploy with an ingress but no DNS, which never resolves.\n` +
    `  3. VERIFY before you call the ticket done: ` +
    `\`curl -fsS -o /dev/null -w '%{http_code}' https://${slug}.${apex}\` must print 200. If it ` +
    `can't resolve or returns 502, the deploy is NOT done (your unit isn't running, or ` +
    `\`beckett deploy\` didn't run) — fix it and re-check. Never report a URL you haven't curled.`
  );
}

/**
 * True when the ticket's text suggests it needs a public URL/deploy — gates the ~300-token
 * deploy-durability recipe so pure-code tickets don't carry it in every brief (issue #25).
 */
export function ticketMentionsDeploy(ticket: { title: string; body: string; criteria: string[] }): boolean {
  const text = `${ticket.title}\n${ticket.body}\n${ticket.criteria.join("\n")}`;
  return /deploy|url|site|website|host|serve|public|page|frontend|dashboard|http|tunnel|dns/i.test(text);
}

/**
 * True when the ticket's text reads like BROWSER-FACING FRONTEND work — the gate for the review
 * preview brief (#76). Kept text-based (a heuristic nudge for the worker); the daemon does the
 * authoritative diff-based detection before it ever surfaces a URL. Narrower than
 * {@link ticketMentionsDeploy}: a plain "deploy the API" ticket shouldn't ask for a page preview.
 */
export function ticketTouchesFrontend(ticket: { title: string; body: string; criteria: string[] }): boolean {
  const text = `${ticket.title}\n${ticket.body}\n${ticket.criteria.join("\n")}`;
  return /frontend|front-end|\bui\b|\bux\b|web ?app|webpage|\bpage\b|dashboard|component|react|vue|svelte|tailwind|css|html|styling|stylesheet|landing|responsive/i.test(text);
}

/** Visual work needs a browser look even when its ticket does not use frontend vocabulary. */
export function ticketMentionsVisualWork(ticket: { title: string; body: string; criteria: string[] }): boolean {
  const text = `${ticket.title}\n${ticket.body}\n${ticket.criteria.join("\n")}`;
  return /\bvisual\b|typography|\bvoxel|canvas|animation|particle|\bgame\b|look and feel|design/i.test(text);
}

/**
 * The review-preview recipe (#76): stand the built frontend up at the DETERMINISTIC
 * `<slug>-preview` hostname (not `<slug>`), so reviewers — and Beckett — find it without a
 * round-trip, and Beckett can tear it down on land/cancel. Reuses the durable deploy path above;
 * parameterized by slug + zone apex so it names the worker's real hostname.
 *
 * ⚠ NOT CURRENTLY IN ANY WORKER BRIEF. The teardown half of the contract this text promises
 * ("Beckett tears it down automatically…") lived in `PreviewManager` wired through the ticket
 * dispatcher, and has no wiring on the v7 run engine. The block is deliberately not composed into
 * the deploy promptBlock above until that teardown is re-wired — create-without-teardown is a
 * per-run leak of a public hostname, a DNS record, a tunnel ingress and a systemd unit. Kept
 * (rather than deleted) because the recipe itself is correct and the re-wiring is a known
 * follow-up; the ONLY thing missing is a caller for `PreviewManager.teardown`.
 */
export function previewBriefNote(slug: string, apex: string = DEFAULT_APEX_DOMAIN): string {
  return (
    `PREVIEW FOR REVIEW (only if this branch changes a FRONTEND): reviewers should be able to OPEN ` +
    `the page, not just read the diff. Before you finish, stand up a durable preview the SAME way as ` +
    `the deploy recipe — but at the FIXED name \`${slug}-preview\` (NOT \`${slug}\`): build the ` +
    `frontend, serve the build on a local port from a \`systemd --user\` unit, then ` +
    `\`beckett deploy ${slug}-preview --port <thePort>\`, and verify ` +
    `\`curl -fsS -o /dev/null -w '%{http_code}' https://${slug}-preview.${apex}\` prints 200. That ` +
    `exact hostname is where reviewers and Beckett look for the preview while the ticket is in ` +
    `review; Beckett tears it down automatically when the ticket lands or is cancelled, so you ` +
    `don't need to remove it yourself. Never post a localhost/127.0.0.1 URL as the preview.`
  );
}
