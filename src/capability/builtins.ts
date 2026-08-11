/**
 * Beckett v5 — builtin capability config fragments (`src/capability/builtins.ts`)
 * =======================================================================================
 * Phase 1c (#N.4) of the extensibility refactor: the monolithic zod block that lived in
 * `src/config.ts` is now COMPOSED from per-capability fragments. Each builtin capability
 * declares its own config-schema slice ({@link Capability.configSchema}) mounted at its
 * `configKey`; `src/config.ts` asks the registry for {@link CapabilityRegistry.configFragments}
 * and assembles the strict top-level schema from them. Adding a capability with config means
 * registering one fragment here (or, after Phase 2, in the capability's own module) — never
 * editing a central schema literal again.
 *
 * Two contracts hold this together:
 *   - COMPILE TIME: the `satisfies` clause on {@link configFragments} proves every fragment's
 *     parsed output matches its slice of the frozen {@link Config} type (and that no key is
 *     missing or invented) — the same guarantee the old monolith's `z.infer` assert gave.
 *   - RUNTIME: the CLI/bus characterization suites snapshot the full default config TOML, so
 *     an unchanged config.toml provably validates to an identical config object.
 *
 * Phase 0 defined these capability stubs' shape; Phase 2 fleshes them out (CLI verbs, bus
 * commands, prompt blocks) and may relocate a fragment into its feature module — the mount
 * key, not the file, is the contract.
 */

import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../types.ts";
import { HHMM, WEEKDAYS } from "../routine/types.ts";
import { DIRECTED_SETTLE_MAX_MS } from "../concierge/directed-settle.ts";
import { ActionClass, CapabilityRegistry, type Capability } from "./index.ts";

// =======================================================================================
// Shared schema helpers
// =======================================================================================

const int = z.number().int();
const posInt = int.min(1);
const browserOutputChars = int.min(4_096).max(1_000_000);
const nonNegInt = int.min(0);
const browserAttachmentRoot = z.string().refine(isAbsolute, "must be an absolute directory path").transform((path) => resolve(path));

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function cloneRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? { ...v } : {};
}

// =======================================================================================
// harness — driver/CLI launch configuration
// =======================================================================================

/**
 * Flags `ClaudeDriver.buildArgs` composes itself — an extra_flags entry naming one of these
 * would inject a conflicting duplicate (the driver's dedup is exact-token only). Each has a
 * real config key or spec field; `--max-turns` is banned because envelopes are estimates,
 * never hard caps (Spec 02 §7).
 */
const CLAUDE_DRIVER_OWNED_FLAGS = new Set([
  "-p",
  "--print",
  "--input-format",
  "--output-format",
  "--permission-mode",
  "--model",
  "--effort",
  "--session-id",
  "--resume",
  "--append-system-prompt",
  "--mcp-config",
  "--settings",
  "--json-schema",
  "--max-turns",
  "--name",
]);

const HarnessConfigSchema = z
  .object({
    // Substitution order when a cast harness fails preflight or dies on auth/rate-limit
    // (issue #17): the dispatcher walks this list for the first enabled + healthy harness.
    // Claude-only by doctrine (2026-08): the pi/codex lane is retired — no OpenAI models.
    fallback_order: z
      .array(z.enum(["claude", "codex", "pi"]))
      .default(["claude"]),
    // No `enabled` switch for claude: it is the backbone harness and the fallback target
    // whenever a cast names a disabled harness, so it can never honestly be off. (codex/pi
    // `enabled` ARE real: Dispatcher#castFor falls back to claude when one is disabled.)
    claude: z
      .object({
        // Prod overrides this to the user-native install (e.g. "/home/beckett/.local/bin/claude")
        // whenever the `claude` first on PATH is a pinned wrapper: an older wrapper build can
        // silently lack newer flags the daemon relies on (`--name`, cross-session messaging), and
        // the driver's `--help` probe would then quietly fall open for every worker.
        bin: z.string().min(1).default("claude"),
        default_model: z.string().min(1).default("claude-sonnet-5"),
        // Reasoning effort handed to every claude worker via `claude --effort` (verified on
        // claude 2.1.197). Sonnet 5 @ high is the worker default — the doctrine caps Sonnet at
        // high (a task that wants xhigh belongs on Opus 5). A ticket may cast a different
        // effort per stage. Honored by ClaudeDriver.buildArgs + dispatch/spawn#buildEnvelope.
        // `ultracode` (claude 2.1.203+) is claude-only — automatic workflow orchestration on top
        // of xhigh reasoning; the default stays "high" (a task that wants it belongs on a cast).
        default_effort: z.enum(["low", "medium", "high", "xhigh", "ultracode"]).default("high"),
        // v0 seed: bounded by the worktree + PreToolUse scope hook, so the worker runs
        // autonomously without per-edit prompts (Spec 12 §1.7; Spec 02 §8). Honored by
        // ClaudeDriver.buildArgs.
        permission_mode: z.string().min(1).default("bypassPermissions"),
        // Extra argv appended to every claude worker launch. Flags the driver already owns
        // are REFUSED at load (see CLAUDE_DRIVER_OWNED_FLAGS): the driver's dedup is
        // exact-token only, so `["--model","opus"]` would inject a second, conflicting
        // `--model` — a silent misconfig this validation turns into a loud boot failure.
        extra_flags: z
          .array(z.string())
          .default(["--verbose", "--replay-user-messages", "--include-hook-events"])
          .superRefine((flags, ctx) => {
            const conflicts = flags.filter((f) => CLAUDE_DRIVER_OWNED_FLAGS.has(f));
            if (conflicts.length) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  `harness.claude.extra_flags may not override driver-owned flags: ` +
                  `${conflicts.join(", ")} (set the matching config key instead)`,
              });
            }
          }),
      })
      .default({}),
    codex: z
      .object({
        enabled: z.boolean().default(false),
        bin: z.string().min(1).default("codex"),
        // Empty = defer to codex's own ~/.codex/config.toml model (account-appropriate).
        // The Concierge can still cast an explicit model per ticket.
        default_model: z.string().default(""),
        default_effort: z.enum(["low", "medium", "high", "xhigh", "ultracode"]).default("high"),
        // Sandbox OFF by default: `workspace-write` blocks network unless explicitly enabled,
        // which silently broke every codex worker that needed to install a dep / curl / clone /
        // enumerate (it "yaps about a network sandbox issue" and stalls). `danger-full-access`
        // is codex's no-sandbox mode (full FS + network, no approval prompts) — the scope-guard
        // hook + per-ticket project repos are the real containment here, not codex's sandbox.
        // Dial back to "workspace-write" here (and flip network_default) to re-enable it.
        sandbox_mode: z.string().min(1).default("danger-full-access"),
        approval_policy: z.string().min(1).default("never"),
        // Belt-and-suspenders: even if sandbox_mode is dialed back to workspace-write, workers
        // get network by default. Nothing here should silently lose the network again.
        network_default: z.boolean().default(true),
      })
      .default({}),
    // pi (pi.dev / earendil-works) — RETIRED BY DOCTRINE (2026-08): no OpenAI models; disabled
    // by default and absent from the fallback chain. The block stays so a third-party install
    // can re-enable it explicitly. Auth was the ChatGPT/Codex OAuth via the "openai-codex"
    // provider (~/.pi/agent/auth.json), running the model through codex.
    pi: z
      .object({
        enabled: z.boolean().default(false),
        bin: z.string().min(1).default("pi"),
        default_provider: z.string().min(1).default("openai-codex"),
        default_model: z.string().min(1).default("gpt-5.6-terra"),
        thinking: z.enum(["low", "medium", "high", "xhigh", "ultracode"]).default("high"),
      })
      .default({}),
  })
  .default({});

// =======================================================================================
// proactivity — ambient interjection policy
// =======================================================================================

const ProactivityModeSchema = z.enum(["off", "suggest", "auto"]);
const CLAUDE_TRIAGE_MODEL = "claude-haiku-4-5";
const CEREBRAS_TRIAGE_MODEL = "gemma-4-31b";

function triageModelForProvider(provider: "claude" | "cerebras", model?: string): string {
  if (provider === "cerebras") {
    return !model || model === CLAUDE_TRIAGE_MODEL ? CEREBRAS_TRIAGE_MODEL : model;
  }
  return !model || model === CEREBRAS_TRIAGE_MODEL ? CLAUDE_TRIAGE_MODEL : model;
}

/**
 * The provider default when config.toml doesn't pick one: Cerebras whenever its key is on the
 * box (~1850 tok/s vs a multi-second `claude -p` spawn — ambient triage sits on the interjection
 * hot path), else the subscription CLI. Safe to read process.env here: this runs at PARSE time
 * (inside the schema transform), and `loadConfig()` loads `~/.beckett/.env` into process.env as
 * its first step, before validation. An explicit `triage_provider` always wins.
 */
function defaultTriageProvider(): "claude" | "cerebras" {
  return process.env.CEREBRAS_API_KEY?.trim() ? "cerebras" : "claude";
}

const ProactivityConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    default_mode: ProactivityModeSchema.default("off"),
    // Where the burst classifier runs. Unset, it resolves at parse time: `cerebras` (the
    // wire-speed API option) when CEREBRAS_API_KEY is in ~/.beckett/.env, else the subscription
    // `claude` CLI. An explicit value always wins. triage_model must name a model the chosen
    // provider serves.
    triage_provider: z
      .enum(["claude", "cerebras"])
      .optional()
      .transform((provider) => provider ?? defaultTriageProvider()),
    triage_model: z.string().min(1).optional(),
    // The cold-interjection bar. Set conservative on purpose: a cold coin-flip should stay
    // silent, so only a clear, welcome contribution (the classifier's `0.55-0.74` band and up)
    // gets Beckett to speak into chatter it isn't already part of. Live continuations — people
    // answering something Beckett just said — never pass through this gate (the engaged lane in
    // ambient.ts bypasses it), so raising the bar tightens over-interjection without ghosting them.
    triage_threshold: z.number().min(0).max(1).default(0.55),
    // Cold bursts need a real conversational pause, but 20s leaves the classifier and queued
    // session turn responding after the moment has closed. Eight seconds preserves burst
    // assembly while removing 12s from the cold interjection path.
    burst_quiet_secs: posInt.default(8),
    // Mid-conversation, waiting out the full cold debounce reads as wandering off — a short
    // lull IS a turn boundary when people are talking WITH Beckett (v4.1.2).
    engaged_quiet_secs: posInt.default(4),
    // Soft backstops only (v4.1.2): the CLASSIFIER is the gate that stops reply-to-everything;
    // these exist to break pathological loops, not to ration speech. They bound COLD
    // interjections only; engaged continuations bypass them. 0 = disabled.
    channel_cooldown_secs: nonNegInt.default(60),
    max_interjections_per_hour: nonNegInt.default(0),
    // How long after Beckett speaks in a channel to use the short-lull continuation lane. It
    // bypasses cold caps; native replies to known humans get a fast addressee recheck before the
    // session, while other turns let the session decide (it can PASS). 0 disables the lane.
    engaged_window_secs: nonNegInt.default(180),
    offer_ttl_secs: posInt.default(600),
    transcript_window: posInt.default(15),
    channels: z.record(ProactivityModeSchema).default({}),
  })
  .strict()
  .default({})
  .transform((proactivity) => ({
    ...proactivity,
    triage_model: triageModelForProvider(proactivity.triage_provider, proactivity.triage_model),
  }));

// =======================================================================================
// The fragment table — one config-schema slice per builtin capability
// =======================================================================================

/**
 * Every top-level config key, each owned by one builtin capability, in the exact order the
 * old monolith declared them (the order is observable: `beckett config print-default` walks
 * it to render `deploy/config.toml.example`, which the characterization suite snapshots).
 *
 * The `satisfies` clause is the compile-time contract the monolith's `z.infer` assert used
 * to provide: every {@link Config} key must have a fragment, no fragment may invent a key,
 * and each fragment's parsed output must be assignable to its Config slice.
 */
export const configFragments = {
  concurrency: z
    .object({
      // v3.1: ONE worktree per ticket (its own branch) isolates concurrent tickets, so the cap
      // can stay >1 and `beckett plan` DAG nodes run in parallel. The waste v3.1 removed was a
      // fresh worktree per STAGE, not isolation itself (Spec 12 §1.7 — "headroom of 2").
      max_workers: posInt.default(2),
    })
    .default({}),
  budget: z
    .object({
      // Per-task spend ceiling (#77), USD. The dispatcher sums a task's accrued worker cost from
      // the spend ledger before staffing each stage; at/over this cap it stops staffing further
      // work on that task and comments why. A fractional cap (e.g. 12.50) is fine — this is money,
      // not a count. 0 disables the ceiling entirely, so a fresh install bills but never blocks.
      per_task_usd_cap: z.number().min(0).default(0),
    })
    .default({}),
  supervise: z
    .object({
      // Generous, configurable backstop wall-clock cap (seconds) enforced by the per-worker
      // watchdog (drivers/proc.ts#hardCapSeconds). A runaway-worker safety net, NOT a normal work
      // limit — real tickets routinely need far more than the old tight per-effort caps. Floor of
      // 1800s (30min) so it can never be tightened back into the retired 600s guillotine (OPS-50);
      // default 3600s (60min).
      worker_hard_cap_s: int.min(1800).default(3600),
      // Stall window (issue #21): a worker with NO progress event for this many seconds gets a
      // `stalled` signal (driver watchdog) and the dispatcher escalates nudge → abort+retry,
      // instead of burning a slot until the hard cap. 0 disables stall detection.
      worker_stall_s: nonNegInt.default(300),
      // Checkpoint cadence (OPS-125): every this-many seconds the dispatcher commits each live
      // worker's worktree as a WIP checkpoint, so a HARD daemon crash (SIGKILL/OOM/power) — where
      // the graceful shutdown drain never runs — loses at most one checkpoint window of on-disk
      // work instead of the whole session. Best-effort and side-effect-free beyond the worktree
      // (never touches the publish outbox). 0 disables periodic checkpointing.
      worker_checkpoint_s: nonNegInt.default(120),
      // Runtime-awareness threshold (seconds) for the per-worker PostToolUse hook
      // (src/hooks/runtime-awareness.ts): a tool call that runs at least this long gets a
      // one-line additionalContext notice injected so the model can route around slow
      // operations (faster alternative / background it). 0 disables the hook entirely.
      worker_slow_tool_s: nonNegInt.default(30),
      // Worker browser home. false (default): every worker gets its own cold BETTERWRIGHT_HOME
      // under its git-excluded scaffolding — no credential vault, cookie jar, or config is
      // shared with any other worker, and a login one worker saved cannot autofill in another.
      // true: one shared home at <beckettDir>/worker-browser with a per-workspace
      // BETTERWRIGHT_PROFILE — warm session daemon, shared browser-binary cache and artifacts,
      // separate cookie jars — but betterwright's vault is home-scoped, so a credential saved
      // once (typed-login capture is on by default) fills in EVERY worker's profile. Turn it on
      // only when every worker is trusted with every stored credential.
      worker_browser_shared_home: z.boolean().default(false),
      // Staffing watchdog grace (issue #9): a ticket that is in a staffable/running state
      // (in_progress / in_review / design) but has NO live worker, mid-spawn reservation, queued
      // spawn, or scheduled retry for this many seconds is silently wedged — the reconciliation
      // pass re-staffs it ONCE (logged), and parks it in `todo` with a comment if that also fails.
      // Closes the whole class of "staffed-but-workerless" wedges. 0 disables the watchdog.
      staffing_watchdog_s: nonNegInt.default(120),
      // Repeat-stall guard (issue #44): if respawned workers repeatedly go silent at the same
      // command/file/tool fingerprint, park the ticket instead of re-paying the same failed run.
      // Two matching cycles catches deterministic loops while still allowing one transient stall.
      max_repeated_stall_fingerprints: posInt.default(2),
      // Dispatcher retry/rework bounds (OPS-180) — previously hardcoded dispatcher constants,
      // now real knobs. Defaults are the old constants exactly; see stages.ts#retryCapsFor.
      // Max implement↔review round-trips before auto-rework stops and waits for a human.
      max_rework_cycles: posInt.default(3),
      // Total design-completeness passes before the design escalates to its owner anyway.
      max_design_cycles: posInt.default(2),
      // Max auto-respawns of an implement worker that ended without a clean finish (OPS-50).
      max_implement_retries: posInt.default(3),
      // Max review infra/schema retries before the ticket is left in_review for a human.
      max_review_infra_retries: posInt.default(1),
      // Max healthy-harness substitutions for one ticket before it's parked (#84). A clean
      // substitution is not a spawn failure, so it has its own budget separate from spawn retries.
      max_harness_substitutions: posInt.default(6),
    })
    .default({}),
  models: z
    .object({
      // Default reviewer model (issue #27): Sonnet reads a diff against criteria extremely well
      // at a fraction of Opus cost/latency. Opus reviews remain one explicit cast away
      // (`review: {model: "claude-opus-5", effort: "xhigh"}`) for correctness-critical work.
      reviewer: z.string().min(1).default("claude-sonnet-5"),
    })
    .default({}),
  harness: HarnessConfigSchema,
  paths: z
    .object({
      home: z.string().min(1).default("/home/beckett"),
      beckett_dir: z.string().min(1).default("/home/beckett/.beckett"),
      projects: z.string().min(1).default("/home/beckett/projects"),
      db: z.string().min(1).default("/home/beckett/.beckett/beckett.db"),
      events_dir: z.string().min(1).default("/home/beckett/.beckett/events"),
      logs_dir: z.string().min(1).default("/home/beckett/.beckett/logs"),
      memory_dir: z.string().min(1).default("/home/beckett/.beckett/memory"),
      socket: z.string().min(1).default("/home/beckett/.beckett/beckett.sock"),
      /** Append-only worker/review telemetry ledger (OPS-123). */
      spend: z.string().min(1).default("/home/beckett/.beckett/spend.jsonl"),
    })
    .default({}),
  identity: z
    .object({
      // Publishing resolves this with GITHUB_ACCOUNT and refuses to run when neither is set.
      github_user: z.string().default(""),
      gmail_address: z.string().default(""),
    })
    .default({}),
  // RUNS — the execution unit (`beckett task deploy`). The RunSupervisor
  // (`src/run/supervisor.ts`) is the engine; these are its only knobs. There is deliberately no
  // `claude_bin` here: worker harness config stays in `[harness.claude]`, one source of truth.
  runs: z
    .object({
      // Concurrent live runs. Each run owns its own worktree, so this is a fleet-cost bound, not
      // a correctness one; over-cap admissions queue FIFO and pump as slots free.
      max_live: posInt.default(3),
      // Implement↔review round-trips before the supervisor stops reworking and parks for a human.
      review_cycles_max: posInt.default(2),
      // Per-run USD ceiling, summed from the spend ledger over rows at/after the run's createdAt.
      // 0 (the default) falls back to `[budget] per_task_usd_cap`, so an install that already
      // tuned the task cap keeps exactly that behavior.
      budget_usd_per_run: z.number().min(0).default(0),
      // The deploy receipt (progress cards, `src/progress/cards.ts`). Default ON.
      cards: z.boolean().default(true),
      // The live activity blurb on that card (`src/run/activity.ts`): "editing index.html" in
      // place of the phase word while a worker runs. DERIVED from the run's own journal — no
      // model, no network — and absent or stale it renders the card that shipped without it.
      activity: z
        .object({
          enabled: z.boolean().default(true),
          // OPTIONAL micro-model polish over the derived phrase. `off` (the default) is the whole
          // feature: deterministic, free, and on the hot path. `cerebras` matches the ambient
          // triage lane (a keyless box degrades to the `claude` CLI on its own).
          provider: z.enum(["cerebras", "claude", "off"]).default("off"),
          // Seconds between blurb refreshes for one run. Clamped to ≥5 at the call site — a
          // shorter cadence is a card that repaints per tool call, which nobody can read.
          throttle_secs: posInt.default(15),
        })
        .strict()
        .default({}),
    })
    .strict()
    .default({}),
  // OPS-124 — GitHub PR sense: the poller that watches the PRs Beckett opened on the kowo-co
  // org and relays review/CI/merge signal. The credential (the GitHub App key, or a legacy PAT)
  // lives in env, not here; the poller is active only when one is configured. GitHub's REST API
  // is rate-limited, so this polls far less
  // aggressively than the run engine (60s default is ample for review/CI latency).
  github: z
    .object({
      poll_secs: posInt.default(60),
      // OPS-128 — external main/merge relay. Unlike the ticket-scoped PR sense above, this
      // watches Beckett's own repository and sends terse dev-feed lines to one configured room.
      activity: z
        .object({
          // An instance must opt in with its own repository and delivery channel. Never watch
          // or relay activity from Beckett's maintainer repository by default.
          enabled: z.boolean().default(false),
          repo: z.string().trim().refine(
            (value) => !value || /^[^/\s]+\/[^/\s]+$/.test(value),
            "must be owner/repo",
          ).default(""),
          branch: z.string().min(1).default("main"),
          poll_secs: posInt.default(60),
          channel_id: z.string().trim().refine(
            (value) => !value || /^\d{17,20}$/.test(value),
            "must be a Discord channel id",
          ).default(""),
          // The configured daemon identity is appended when the poller starts.
          ignored_authors: z.array(z.string().min(1)).default(["github-actions[bot]", "dependabot[bot]"]),
        })
        .strict()
        .superRefine((activity, ctx) => {
          if (activity.enabled && !activity.repo) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["repo"],
              message: "is required when github.activity.enabled is true — set github.activity.repo",
            });
          }
          if (activity.enabled && !activity.channel_id) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["channel_id"],
              message: "is required when github.activity.enabled is true — set github.activity.channel_id",
            });
          }
        })
        .default({}),
    })
    .strict()
    .default({}),
  proactivity: ProactivityConfigSchema,
  // OPS-80 — channel-scoped shared context (multiplayer): the per-channel attributed
  // transcript (JSONL under paths.channelsDir) injected into Concierge turns. Ships enabled;
  // `enabled = false` is the kill switch back to the old per-channel ring-buffer prefix path.
  shared_context: z
    .object({
      enabled: z.boolean().default(true),
      max_entries_per_channel: posInt.default(200),
      max_age_hours: posInt.default(72),
      inject_budget_tokens: posInt.default(3000),
      roster_max: posInt.default(12),
      // Server memory (v4.1): rolling per-channel profiles built by a one-shot small-model
      // call every N new entries, surfaced as the cross-channel awareness footer + search.
      profile_model: z.string().min(1).default("claude-haiku-4-5"),
      profile_update_messages: posInt.default(20),
      awareness_max_channels: posInt.default(5),
      // Cross-channel context injection (#74): a third framed turn block that pushes the ACTUAL
      // relevant lines from OTHER guild channels — scored against the inbound message through the
      // #73 semantic+keyword search — so a topic settled in #media isn't re-derived from scratch
      // in #general. Supplements the awareness footer (which only names channels); the model can
      // still `channels search` on demand. `enabled = false` is the kill switch back to
      // search-on-demand only — the footer keeps shipping either way.
      cross_channel_enabled: z.boolean().default(true),
      // Its OWN token budget, separate from inject_budget_tokens (which covers THIS channel's
      // unseen window). The injected cross-channel lines never share that ceiling.
      cross_channel_budget_tokens: posInt.default(1200),
      // Relevance gate: a hit's blended score (distinct keyword terms matched + a floored
      // semantic-similarity bonus in [SEM_FLOOR..1]) must reach this to be injected. The block is
      // omitted entirely when nothing clears it — an irrelevant block every turn is worse than no
      // block. Default 0.5: any literal content-word overlap scores ≥1 and passes, while a strong
      // paraphrase-only hit can too; lower it toward SEM_FLOOR (0.12) to admit weaker paraphrases.
      cross_channel_min_score: z.number().positive().default(0.5),
      // Reply-context injection: a native reply to a message OUTSIDE the session's window gets
      // the target plus this many messages before and after it fetched from Discord, stamped
      // with how long ago the exchange happened. 5 gives the ±5 window around the target.
      reply_context_surrounding: posInt.default(5),
    })
    .strict()
    .default({}),
  // v3 — the Concierge (long-lived `claude -p` chat agent that owns Discord, files tickets).
  concierge: z
    .object({
      model: z.string().min(1).default("claude-sonnet-5"),
      // Proactive idle-rotation watermark (summed input tokens). This sits below Claude's 200k
      // hard edge so compaction normally happens with nobody waiting; configurable for tests.
      rotate_at_tokens: z.number().int().positive().default(160_000),
      // Reasoning effort for the chat seat (issue #25): acks/triage rarely need max reasoning.
      // Empty = the claude CLI's own default. A knob, not a hardcode — the voice is the product.
      effort: z.enum(["", "low", "medium", "high", "xhigh"]).default("medium"),
      // Multi-session concierge (OPS-80 §9.3): "channel" runs one session per Discord channel
      // (DMs included — a DM is its own channel), so conversations in different channels no
      // longer queue behind one global turn. "global" restores the single-session v4.0 behavior.
      session_scope: z.enum(["channel", "global"]).default("channel"),
      // Cap on turns EXECUTING at once across all sessions (each is a full claude turn — this is
      // a spend/QPS lever, not a correctness one; queued turns wait for a slot).
      max_concurrent_turns: posInt.default(3),
      // Cap on live `claude` child PROCESSES. Beyond it the least-recently-used idle session's
      // child is recycled (killed); its transcript survives — the next turn resumes it.
      max_live_sessions: posInt.default(6),
      // Recycle a session's child after this much idle time (same resume-on-demand semantics).
      idle_recycle_minutes: posInt.default(30),
      // Directed-message SETTLE WINDOW (src/concierge/directed-settle.ts). A thought typed as three
      // messages starts a turn on the first fragment and answers half a question. With this set,
      // a directed message that would start a NEW turn waits this many milliseconds first; another
      // message from the SAME author in the SAME channel inside the hold folds into one turn
      // (the same coalesced-burst preamble a superseded queued turn already uses) and restarts the
      // hold, capped at 2× the window so a fast typist cannot delay their own answer forever.
      //
      // 0 = OFF, and off is today's behavior byte-for-byte: no hold, no timer, no state. That is
      // the shipped default deliberately — the amend/inject repair paths already cover the common
      // burst, so this is a capability to switch on after watching a room, not a new default.
      // Clamped rather than rejected: an over-eager value should degrade to the ceiling, not
      // refuse to boot, since the failure mode of a too-long hold is only latency.
      directed_settle_ms: z
        .number()
        .int()
        .min(0)
        .default(0)
        .transform((ms) => Math.min(ms, DIRECTED_SETTLE_MAX_MS)),
      // chilltext (v7 architecture doc): restyles every human-facing Concierge message through a
      // friend's homelab rewrite API before it posts, fail-open on any error/timeout. OFF by
      // default — a fork's config must opt in (prod flips it true). W3A owns this fragment; other
      // callers (the social-media chill pass — [social] below) reuse this url/timeout rather than
      // each carrying their own copy.
      chilltext: z
        .object({
          enabled: z.boolean().default(false),
          url: z.string().min(1).default("https://chilltext.ssh.codes"),
          timeout_ms: posInt.default(8_000),
          max_bubbles: z.number().int().min(1).max(4).default(3),
          bubble_delay_ms: nonNegInt.default(2_500),
          system: z.string().default(""),
          skip_code_blocks: z.boolean().default(true),
        })
        .strict()
        .default({}),
    })
    .default({}),
  // Quick agents — the no-ticket lane. Sonnet at medium: these are errands where
  // wall-clock beats depth; the ticket pipeline keeps xhigh for real work.
  quick: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().min(1).default("claude-sonnet-5"),
      effort: z.enum(["", "low", "medium", "high", "xhigh"]).default("medium"),
      sync_wait_secs: posInt.default(240),
      hard_timeout_secs: posInt.default(900),
      max_concurrent: posInt.default(3),
      // Computer-use owns one persistent Chromium identity. Hosts serialize at the lease
      // boundary and stay warm for a task, while that task may drive many tabs concurrently.
      browser_profile_dir: z.string().min(1).default("browser/profile"),
      browser_headless: z.boolean().default(true),
      browser_viewport_width: posInt.default(1440),
      browser_viewport_height: posInt.default(900),
      browser_launch_timeout_ms: posInt.default(30_000),
      browser_action_timeout_ms: posInt.default(10_000),
      browser_navigation_timeout_ms: posInt.default(30_000),
      browser_eval_timeout_ms: posInt.default(60_000),
      browser_max_output_chars: browserOutputChars.default(24_000),
      browser_question_wait_secs: posInt.default(3_600),
      // Extra Chromium switches appended to BetterWright's managed launch args (betterwright
      // 1.7.1 chromiumArgs). Defaults disable GPU/software-raster churn on a headless GPU-less
      // server. Switches BetterWright owns (proxy, --headless, --fingerprint*, …) are rejected
      // by the library at launch; duplicates are dropped and reported in run warnings.
      browser_chromium_args: z.array(z.string().min(1)).default(["--disable-gpu", "--disable-software-rasterizer"]),
      // Quiet each session's pages between executions (pause page script/animations while the
      // model thinks). BetterWright's own default is true; kept explicit and configurable here.
      browser_park_background_pages: z.boolean().default(true),
      // Default roots are the run artifacts plus paths.imagesDir. This opt-in list
      // can widen attachment reads, including '/' for deliberately broad access.
      browser_attach_roots: z.array(browserAttachmentRoot).default([]),
      // Live-view exposure for watched browser runs. "tailscale" (default) binds only
      // this machine's tailnet address — usable from the owner's devices, invisible to
      // the LAN. "off" disables watch-time live view entirely; any live-view failure
      // (e.g. tailscale down) degrades to screenshot-only.
      browser_live_view_expose: z.enum(["off", "local", "lan", "tailscale"]).default("tailscale"),
    })
    .strict()
    .default({}),
  // Restart "what's new" changelog. Instance-specific and OFF by default (empty channel) so a
  // fork stays silent until its owner opts in — this is a your-instance flourish, not a default.
  announce: z
    .object({
      // Post the changelog here on boot when the running commit advanced since last announce.
      // Empty = off. Set this in the BOX's config.toml, not in the repo (it's per-instance).
      changes_channel_id: z.string().default(""),
      // Bound the summarized commit count so a large deploy can't dump a wall.
      max_commits: posInt.default(20),
    })
    .default({}),
  // Federation — the fork ecosystem. Discord ignores bots by default and Beckett drops every
  // bot message to kill self-loops; a peer bot id listed here is exempted so sibling Becketts
  // can address each other. Ships INERT (empty peers = today's exact behavior). The talk
  // protocol on top is still open by design — this is only the gateway primitive.
  federation: z
    .object({
      // Discord bot user ids of trusted peer Becketts. The daemon's own id is always ignored
      // even if listed (self-loop guard); unlisted bots stay dropped. Snowflake ids are digit
      // strings — validate the shape so a fat-fingered entry is a loud boot failure, not a
      // silently-never-matching peer.
      peers: z
        .array(z.string().regex(/^\d{17,20}$/, "must be a Discord user id (17–20 digits)"))
        .default([]),
      // Runaway backstop: max peer-bot messages processed per channel per rolling minute, so two
      // auto-replying Becketts can't melt a channel before the protocol adds real loop control.
      peer_burst_per_min: posInt.default(5),
      // Loop terminator: max consecutive peer-to-peer replies Beckett gives in one channel before a
      // human speaks again. This is what makes a two-bot exchange END, not just slow down — the
      // count resets on any human message. Kept modest so a real peer chat can happen without a
      // ping-pong running away.
      peer_max_consecutive_turns: posInt.default(6),
    })
    .default({}),
  // The nightly dream pass (issue #36): a budgeted, read-mostly replay of Beckett's own day on
  // the self lane. The budget is a hard CEILING on model output tokens, not a target — a quiet
  // day finishes far below it; hitting it writes a partial journal entry marked truncated.
  dream: z
    .object({
      output_token_budget: posInt.default(150_000),
      // Empty = the concierge model: a dream is Beckett replaying its own day, not a specialist.
      model: z.string().default(""),
      // The overnight spike's sub-budget (issue #38) is carved out of output_token_budget, and
      // its throwaway worktree is cut from Beckett's own checkout unless a repo is named here.
      spike_output_token_budget: posInt.default(60_000),
      spike_repo: z.string().default(""),
    })
    .strict()
    .default({}),
  // Free time (docs/freetime.md): one weekly, budgeted, unprompted session inside a scratch
  // directory, with structured memory writeback seeding the next one. Every value here is a WALL
  // the session runs INSIDE — the session's process has no write path back to this file, so it
  // can neither widen its own budget nor re-arm its own trigger.
  free_time: z
    .object({
      enabled: z.boolean().default(true),
      // Seed values for the builtin routine's schedule. The routine store owns the timing once
      // seeded (`beckett routine inspect weekly-free-time`), so editing these later retimes a
      // FRESH install, not a running one — that is what `beckett routine` is for.
      weekday: z
        .string()
        .refine((w) => (WEEKDAYS as readonly string[]).includes(w), `weekday must be one of: ${WEEKDAYS.join(", ")}`)
        .default("sunday"),
      window_start: HHMM.default("02:00"),
      window_end: HHMM.default("05:00"),
      tz: z.string().min(1).default("America/Los_Angeles"),
      model: z.string().default("claude-sonnet-5"),
      max_turns: posInt.default(60),
      hard_timeout_s: posInt.default(1_800),
      output_token_budget: posInt.default(80_000),
      memories_per_session_max: posInt.default(5),
      // Empty = no message. A session that wants to say something with no channel configured
      // says it in its journal entry instead; nothing is queued for later.
      channel_id: z.string().default(""),
    })
    .strict()
    .default({}),
  // The social-media agent's chill pass (W4A tune): route its composed X posts through
  // chilltext's tone rewrite before they reach the browser lane. Reuses
  // `concierge.chilltext`'s url/timeout rather than duplicating them.
  social: z
    .object({
      // false uses the agent's draft as-is. chilltext already fails open on any error/timeout,
      // so this is purely a taste toggle, not a reliability one.
      chill: z.boolean().default(true),
    })
    .strict()
    .default({}),
  // Discord ops-log mirror (issue #231): "log everything in the ops channel … robust,
  // expressive, legible" — legible one-line renderings of daemon log events (session/turn/run
  // lifecycle, deploy, discord gateway, browser lease, publish outbox), batched into one
  // channel, plus a turn-in-flight heartbeat (`src/ops-log/`). OFF by default: a fork's box
  // opts in with its own channel, same posture as `announce` and `github.activity` above.
  ops_log: z
    .object({
      enabled: z.boolean().default(false),
      channel_id: z.string().trim().refine(
        (value) => !value || /^\d{17,20}$/.test(value),
        "must be a Discord channel id",
      ).default(""),
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
      // Components admitted at ANY level (below `level`) — an opt-in allowlist for one noisy
      // component's debug chatter without dropping the mirror's level for everything else.
      include_debug_components: z.array(z.string().min(1)).default([]),
    })
    .strict()
    .default({}),
} satisfies { [K in keyof Config]: z.ZodType<Config[K], z.ZodTypeDef, unknown> };

// =======================================================================================
// The builtin capabilities
// =======================================================================================

/**
 * Identity + summary for each fragment's owning capability. Keyed by config mount key (the
 * mapped type makes a missing or invented key a compile error); ids are the kebab-case
 * capability names Phase 2's full modules will claim.
 */
const BUILTIN_CAPABILITY_INFO: {
  [K in keyof typeof configFragments]: { id: string; summary: string };
} = {
  concurrency: { id: "concurrency", summary: "Worker-fleet sizing (parallel worktree slots)." },
  budget: { id: "budget", summary: "Per-task spend ceiling: stop staffing a task past its USD cap." },
  supervise: { id: "supervise", summary: "Worker watchdog: hard caps, stall detection, WIP checkpoints." },
  models: { id: "models", summary: "Cross-stage model defaults (reviewer seat)." },
  harness: { id: "harness", summary: "Coding-agent harnesses (claude/codex/pi): binaries, models, fallback order." },
  paths: { id: "paths", summary: "Filesystem layout: beckett dir, db, logs, events, socket." },
  identity: { id: "identity", summary: "Beckett's external identities (GitHub user, Gmail address)." },
  runs: { id: "runs", summary: "v7 runs: live cap, rework cap, per-run budget." },
  github: { id: "github", summary: "GitHub sense: PR review/CI/merge poller + external-activity relay." },
  proactivity: { id: "proactivity", summary: "Ambient interjection policy (burst triage, cooldowns, channel modes)." },
  shared_context: { id: "shared-context", summary: "Channel-scoped shared context: attributed transcripts + server memory." },
  concierge: { id: "concierge", summary: "The Concierge chat seat: model, effort, session pooling." },
  quick: { id: "quick", summary: "Quick agents (the short-lived lane) + the computer-use browser host." },
  announce: { id: "announce", summary: "Restart changelog announcements." },
  federation: { id: "federation", summary: "Peer-Beckett federation over Discord." },
  dream: { id: "dream", summary: "Nightly dream pass: token ceiling + model for the self-lane day replay." },
  free_time: { id: "free-time", summary: "Weekly self-directed session: trigger, walls, token ceiling, share channel." },
  social: { id: "social", summary: "Social-media agent's chilltext chill-pass toggle." },
  ops_log: { id: "ops-log", summary: "Discord ops-log mirror: legible event lines, batching, turn heartbeat." },
};

/**
 * The builtin capability modules, in fragment order. Phase 1c ships them as config-only
 * stubs (no CLI verbs / bus commands yet — Phases 1a/1b/2 wire those); what matters here is
 * that every top-level config key is OWNED by a registered capability, so the top-level
 * schema is composed, never hand-edited.
 */
export function builtinCapabilities(): Capability[] {
  return (Object.keys(configFragments) as Array<keyof typeof configFragments>).map((key) => ({
    id: BUILTIN_CAPABILITY_INFO[key].id,
    summary: BUILTIN_CAPABILITY_INFO[key].summary,
    actionClass: ActionClass.FREE,
    cliVerbs: [],
    busCommands: [],
    configSchema: configFragments[key],
    configKey: key,
  }));
}

/** A registry pre-loaded with every builtin capability (loud on collisions, like all registration). */
export function builtinCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const capability of builtinCapabilities()) registry.register(capability);
  return registry;
}
