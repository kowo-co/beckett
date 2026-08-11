/**
 * Beckett — the `beckett` CLI spine: verb routing + composed help (`src/cli/spine.ts`)
 * =======================================================================================
 * The static routing table the entry (`src/cli/beckett.ts`) resolves argv against BEFORE it
 * loads any verb body (issue #91). Every entry carries only metadata — its help token and its
 * verbs' names — plus a `load()` that `import()`s the handler on demand. Nothing here reaches a
 * verb implementation at module-eval time, so the router never pays for the browser runtime
 * (playwright), the Discord gateway (discord.js), or agentmail just to print an unknown-command
 * error or route to a cheap verb.
 *
 * The array ORDER is the help order and the registration order — byte-identical to the old
 * `CLI_SPINE_ORDER` / `CapabilityRegistry` walk, which the CLI characterization suite pins.
 * Core verbs live in `./core.ts`; capability verbs (image/secret/mail/memory/quick/routine/gh/
 * dns/deploy) are built from their extension module lazily, exactly as the daemon builds them,
 * and their `cliHelp` tokens are mirrored here from those modules (kept honest by the suite).
 */

/**
 * What a capability factory is handed. Typed off `./context.ts` via `typeof import(...)` (a TYPE
 * position — no static `from`, so it neither loads at runtime nor pulls context into the entry's
 * eval-time graph; the entry stays io + spine only).
 */
type CapabilityDeps = (typeof import("./context.ts"))["capabilityDeps"];

/** A verb body, fully bound to its context — the entry just hands it the argv tail. */
export type RunFn = (argv: string[]) => Promise<unknown>;

/** The minimal shape the spine reads off a built capability extension. */
interface ExtLike {
  cliVerbs?: Array<{ name: string; run?: (argv: string[], ctx: { config: CapabilityDeps["config"]; logger: CapabilityDeps["logger"] }) => Promise<unknown> }>;
}

interface SpineVerb {
  name: string;
  load: () => Promise<RunFn>;
}

interface SpineEntry {
  id: string;
  /** The token this capability contributes to the composed `beckett` command list. Omitted → unadvertised. */
  cliHelp?: string;
  verbs: SpineVerb[];
}

/** Lazy-load a CORE verb handler out of `./core.ts` (all core bodies share that one module). */
function core(pick: (m: typeof import("./core.ts")) => RunFn): () => Promise<RunFn> {
  return async () => pick(await import("./core.ts"));
}

/**
 * Lazy-load a CAPABILITY verb: build the extension from its own module (never the barrel, which
 * would statically drag every sibling's heavy runtime in), then bind the named verb's `run` to a
 * CLI context. One `beckett <verb>` builds exactly one extension.
 */
function ext(build: (deps: CapabilityDeps) => Promise<ExtLike>, name: string): () => Promise<RunFn> {
  return async () => {
    const { capabilityDeps } = await import("./context.ts");
    const extension = await build(capabilityDeps);
    const verb = extension.cliVerbs?.find((v) => v.name === name);
    if (!verb?.run) throw new Error(`beckett: capability verb "${name}" has no run body`);
    const ctx = { config: capabilityDeps.config, logger: capabilityDeps.logger };
    return (argv: string[]) => verb.run!(argv, ctx);
  };
}

export const SPINE: SpineEntry[] = [
  { id: "status", cliHelp: "status [--pretty]", verbs: [{ name: "status", load: core((m) => m.runStatus) }] },
  { id: "version", cliHelp: "version [bump]", verbs: [{ name: "version", load: core((m) => m.runVersion) }] },
  { id: "doctor", cliHelp: "doctor [--json]", verbs: [{ name: "doctor", load: core((m) => m.runDoctor) }] },
  {
    id: "concierge",
    cliHelp: "reload | persona",
    verbs: [
      { name: "reload", load: core((m) => m.runReload) },
      { name: "persona", load: core((m) => m.runPersona) },
    ],
  },
  {
    id: "mail",
    cliHelp: "mail inbox|send|ls|read",
    verbs: [{ name: "mail", load: ext(async (d) => (await import("../capability/modules/mail.ts")).createMailExtension(d), "mail") }],
  },
  { id: "access", cliHelp: "access ls|grant|revoke", verbs: [{ name: "access", load: core((m) => m.runAccess) }] },
  { id: "maintainer", cliHelp: "maintainer ls|grant|revoke", verbs: [{ name: "maintainer", load: core((m) => m.runMaintainer) }] },
  { id: "federation", cliHelp: "federation ls|add|remove", verbs: [{ name: "federation", load: core((m) => m.runFederation) }] },
  { id: "channels", cliHelp: "channels list|search|recall|wipe", verbs: [{ name: "channels", load: core((m) => m.runChannels) }] },
  { id: "identity", cliHelp: "identity set|show|list", verbs: [{ name: "identity", load: core((m) => m.runIdentity) }] },
  {
    id: "discord",
    cliHelp: "discord reply|ack|react|decline|delete",
    verbs: [
      { name: "discord reply", load: core((m) => m.runDiscordReply) },
      { name: "discord ack", load: core((m) => m.runDiscordAck) },
      { name: "discord react", load: core((m) => m.runDiscordReact) },
      { name: "discord decline", load: core((m) => m.runDiscordDecline) },
      { name: "discord delete", load: core((m) => m.runDiscordDelete) },
    ],
  },
  { id: "proactivity", cliHelp: "proactivity status|set|off", verbs: [{ name: "proactivity", load: core((m) => m.runProactivity) }] },
  {
    id: "quick",
    cliHelp: "quick <agent>|list",
    verbs: [{ name: "quick", load: ext(async (d) => (await import("../capability/modules/quick.ts")).createQuickExtension({ onDetachedResult: () => {} })(d), "quick") }],
  },
  { id: "browser", cliHelp: "browser <task>|status|watch|steer|stop|exec", verbs: [{ name: "browser", load: core((m) => m.runBrowser) }] },
  {
    id: "routines",
    cliHelp: "routine list|inspect|add|remove|fire",
    verbs: [
      // `routine deps-update` is the scheduler's routine BODY (no help token of its own); the
      // two-word name always wins the longest-match resolve over the bare `routine` below it.
      { name: "routine deps-update", load: ext(async (d) => (await import("../capability/modules/routines.ts")).createRoutinesExtension({})(d), "routine deps-update") },
      { name: "routine", load: ext(async (d) => (await import("../capability/modules/routines.ts")).createRoutinesExtension({})(d), "routine") },
    ],
  },
  { id: "agent", cliHelp: "agent ls|show|add|new|invoke|rm", verbs: [{ name: "agent", load: core((m) => m.runAgent) }] },
  {
    id: "image",
    cliHelp: "image",
    verbs: [{ name: "image", load: ext(async (d) => (await import("../capability/modules/image.ts")).createImageExtension(d), "image") }],
  },
  { id: "eval", cliHelp: "eval <author/model> [--short|--full]", verbs: [{ name: "eval", load: core((m) => m.runEval) }] },
  { id: "site", cliHelp: "site deploy", verbs: [{ name: "site", load: core((m) => m.runSite) }] },
  { id: "task", cliHelp: "task create|branch|start|deploy|ask|steer|cancel|show|list|trace", verbs: [{ name: "task", load: core((m) => m.runTask) }] },
  { id: "preset", cliHelp: "preset ls|show", verbs: [{ name: "preset", load: core((m) => m.runPreset) }] },
  {
    // The end-of-ticket motion as ONE verb: PR → CI → merge → the guarded redeploy. Sits next to
    // `gh` because that's the surface it wraps; its body is its own module (never core.ts) so a
    // `beckett finish` is the only invocation that pays for the agency/GitHub graph.
    id: "finish",
    cliHelp: 'finish -m "<message>"',
    verbs: [{ name: "finish", load: async () => (await import("./finish.ts")).runFinish }],
  },
  {
    id: "github",
    cliHelp: "gh repo|pr|issue|push",
    verbs: [{ name: "gh", load: ext(async (d) => (await import("../capability/modules/github.ts")).createGithubExtension(d), "gh") }],
  },
  {
    id: "dns",
    cliHelp: "dns ls|add|rm",
    verbs: [{ name: "dns", load: ext(async (d) => (await import("../capability/modules/cloudflare.ts")).createDnsExtension(d), "dns") }],
  },
  {
    id: "deploy",
    cliHelp: "deploy <name>|ls|rm",
    verbs: [{ name: "deploy", load: ext(async (d) => (await import("../capability/modules/cloudflare.ts")).createDeployExtension(d), "deploy") }],
  },
  {
    id: "secret",
    cliHelp: "secret request",
    verbs: [{ name: "secret", load: ext(async (d) => (await import("../capability/modules/secret.ts")).createSecretExtension(d), "secret") }],
  },
  {
    id: "memory",
    cliHelp: 'recall "<query>" [--type t] [--name n] [--as-self | --viewer id] | memory recall|remember|show|maintain',
    verbs: [
      { name: "recall", load: ext(async (d) => (await import("../capability/modules/memory.ts")).createMemoryExtension({})(d), "recall") },
      { name: "memory", load: ext(async (d) => (await import("../capability/modules/memory.ts")).createMemoryExtension({})(d), "memory") },
    ],
  },
  {
    id: "loops",
    cliHelp: "loops [--all|--json] | loops open|note|close|drop",
    verbs: [{ name: "loops", load: async () => (await import("./loops-cli.ts")).runLoops }],
  },
  {
    id: "calibration",
    cliHelp: "calibration [--channel <id>|--about <slug>|--json] | calibration veto|hit",
    verbs: [{ name: "calibration", load: async () => (await import("./calibration-cli.ts")).runCalibration }],
  },
  {
    id: "dream",
    cliHelp: "dream ls|show <date> | dream propose|proposals ls|show|accept|reject | dream spikes ls|show",
    verbs: [{ name: "dream", load: async () => (await import("./dream-cli.ts")).runDream }],
  },
  {
    id: "free-time",
    cliHelp: "free-time run [--dry] | free-time ls|show <id>",
    verbs: [{ name: "free-time", load: async () => (await import("../freetime/cli.ts")).runFreeTimeCli }],
  },

  { id: "spend", verbs: [{ name: "spend", load: core((m) => m.runSpend) }] },
  { id: "journal", verbs: [{ name: "journal", load: core((m) => m.runJournal) }] },
  { id: "config", verbs: [{ name: "config", load: core((m) => m.runConfig) }] },
  { id: "rpc", verbs: [{ name: "rpc", load: core((m) => m.runRpc) }] },
];

/** verb-name → its lazy loader (built once from the spine). */
const VERB_LOADERS = new Map<string, () => Promise<RunFn>>();
for (const entry of SPINE) {
  for (const verb of entry.verbs) {
    if (VERB_LOADERS.has(verb.name)) throw new Error(`beckett: CLI verb "${verb.name}" is declared twice in the spine`);
    VERB_LOADERS.set(verb.name, verb.load);
  }
}

/**
 * Resolve a CLI invocation to its verb loader, longest match first: for `["discord","reply",…]`
 * a registered "discord reply" wins over "discord". Returns null when nothing matches (→ the
 * entry's unknown-command refusal). Mirrors the old `CapabilityRegistry.resolveCliVerb` (≤2-word
 * verbs), so `beckett discord` with no bare "discord" verb still falls through to the help.
 */
export function resolveVerb(argv: string[]): { load: () => Promise<RunFn>; rest: string[] } | null {
  for (let take = Math.min(argv.length, 2); take >= 1; take--) {
    const name = argv.slice(0, take).join(" ");
    const load = VERB_LOADERS.get(name);
    if (load) return { load, rest: argv.slice(take) };
  }
  return null;
}

/** The composed `beckett` command list: every spine entry's `cliHelp` token, in order, " | "-joined. */
export function composeCliHelp(): string {
  return SPINE.map((entry) => entry.cliHelp?.trim())
    .filter((token): token is string => !!token)
    .join(" | ");
}
