/**
 * Beckett — THE CONTRACT (`src/types.ts`)
 * =======================================================================================
 * This file is the **frozen contract** for the whole codebase. ~10 downstream modules
 * import their shared types and module interfaces from here. It is intentionally
 * implementation-free: types, interfaces, enums, and a few const unions only — NO logic.
 *
 * Anchored to the specs (see ./specs):
 *   - Spec 00 — canon & vocabulary
 *   - Spec 01 — architecture, config schema (§4), IPC (§7)
 *   - Spec 02 — Worker / HarnessDriver / WorkerEvent / WorkerSpend / scope / envelope
 *   - Spec 03 — SmokeAlarm / CheckIn / SuperviseDecision / nudge primitives
 *   - Spec 04 — TaskState / NodeState FSMs, Dag, Escalation, recovery
 *   - Spec 05 — Discord IncomingMessage / AwaitingReply
 *   - Spec 06 — Brain roles, HaikuClassification / ClarifyOutput / PlanOutput / StaffOutput
 *   - Spec 07 — Identity / ActionClass / PendingAction (agency gate)
 *   - Spec 08 — Memory knowledge graph (MemoryNode / RecallQuery / RememberIntent)
 *   - Spec 09 — persistence row types, EventRecord, learned-model outcome
 *   - Spec 10 — CLI id scheme, IPC command set, StatusReport
 *   - Spec 11 — AcceptanceCriteria / CheckResult / ReviewVerdict / GateResult
 *
 * Import style for the whole codebase: **explicit `.ts` extensions** (bun-native, enabled
 * by tsconfig `allowImportingTsExtensions`). e.g. `import { Task } from "./types.ts";`
 */

// =======================================================================================
// SECTION 1 — Primitive unions & enums (Spec 02 §2, Spec 04 §2)
// =======================================================================================

/**
 * A coding-agent CLI Beckett drives as a subprocess (Spec 00 glossary). Open-ended toward a
 * registry-validated string: `claude`/`codex`/`pi` are the in-tree core (kept as literals for
 * autocomplete), but the authoritative set of usable harnesses is the driver REGISTRY
 * (`src/drivers/index.ts` — `isRegisteredHarness` / `availableHarnesses`), not this union. That
 * dependency inversion lets an out-of-tree driver register itself without editing this contract.
 */
export type Harness = "claude" | "codex" | "pi" | (string & {});


/** Which concrete driver runs a harness process (Spec 02 §2). */
export type DriverKind = "claude-cli-stream" | "codex-exec-oneshot" | "pi-cli-stream";

/**
 * Reasoning depth; mapped per-harness at spawn (Spec 02 §9.1). `ultracode` (claude 2.1.203+,
 * `--effort ultracode`) combines xhigh reasoning with automatic workflow orchestration — only
 * claude honors it; other drivers treat it like any other configured effort string.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "ultracode";

/** Worker runtime lifecycle (Spec 02 §2, §10.1). `done` is set by GATE, not the driver. */
export type WorkerState =
  | "spawning" // worktree + process being created; no session_id yet
  | "running" // process alive, a turn in flight or idle awaiting input
  | "nudging" // a steer message is queued/written, not yet acked at a turn boundary
  | "paused" // checkpointed: process killed/idle, session_id retained, diff inspectable
  | "review" // turn loop ended, handed to REVIEW/GATE (Spec 11)
  | "done" // terminal: criteria satisfied (set by GATE)
  | "failed" // terminal: harness error / max-turns / max-wall-clock without success
  | "aborted"; // terminal: deliberately hard-stopped (Spec 03 decision)


// =======================================================================================
// SECTION 2 — Worker, scope, envelope, control (Spec 02 §2)
// =======================================================================================

/** Owned, non-overlapping write scope for a worker (Spec 02 §2, §8). */
export interface FileScope {
  /** Paths this worker MAY write, relative to repo root (e.g. ["src/auth/**"]). */
  ownedGlobs: string[];
  /** Optional explicit read allowlist; null = read anywhere in the worktree. */
  readGlobs: string[] | null;
  /** NL scope for the criteria/reviewer ("the auth module only"). */
  description: string;
}

/** Bounds effort/turns/wall-clock/network — never dollars (Spec 00 §4; Spec 02 §9). */
export interface ResourceEnvelope {
  effort: Effort; // reasoning depth; mapped per harness (Spec 02 §9.1)
  turnCap: number; // SOFT turn estimate — drives supervisor drift signals, never a hard kill
  // SOFT wall-clock estimate (s) feeding supervisor drift signals — NOT a hard kill. The hard
  // backstop cap is config.supervise.worker_hard_cap_s (drivers/proc.ts#hardCapSeconds); the old
  // 600s guillotine that read this field is gone (OPS-50).
  wallClockS: number;
  network: boolean; // outbound network allowed? default false, opt-in per node
}

/** Cumulative token counts for one turn / run (Spec 02 §7). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * Derived telemetry counters (Spec 02 §2/§7.3). Informational only — NEVER a budget gate
 * (Spec 00 §4 Economics: no USD ledger). `usdEstimate`: claude = stream cost, pi = accumulated
 * `usage.cost.total`, codex = static price-table estimate (null when the model isn't priced).
 */
export interface WorkerSpend {
  turns: number;
  toolCalls: number;
  tokens: TokenUsage;
  diffLines: { added: number; removed: number; files: number };
  usdEstimate: number | null;
}

/**
 * What actually happened to a steer (issue #19 — "queued" used to mean three different
 * things). `delivered` = acked into the live turn (claude echo). `queued` = written/buffered,
 * applies within THIS process's lifetime. `will-restart` = buffered by a one-shot harness and
 * will trigger a full relaunch after the current run. `dropped` = the worker already finished;
 * the text will never be applied (the dispatcher surfaces this on the ticket).
 */
export interface NudgeReceipt {
  accepted: "delivered" | "queued" | "will-restart" | "dropped";
  at: number; // epoch ms
}


// =======================================================================================
// SECTION 3 — WorkerEvent: normalized telemetry stream (Spec 02 §7)
// =======================================================================================

/** Why a harness failed (issue #17) — drives the dispatcher's per-class recovery policy. */
export type ErrorClass = "auth" | "rate_limit" | "crash" | "timeout" | "spawn";

/**
 * Both raw JSONL formats (claude stream-json / codex --json) normalize into this one
 * discriminated union (Spec 02 §7). The driver owns the raw parse; subscribers only see
 * WorkerEvent. CONTRACT: parsers MUST tolerate unknown raw types — switch on what you know,
 * map the rest to `kind:'unknown'`, never throw (Spec 02 §7.2; loom-desk Risk-A).
 */
export type WorkerEvent =
  | { kind: "session_started"; sessionId: string; model: string; ts: number }
  | { kind: "turn_started"; ts: number }
  | { kind: "assistant_text"; text: string; partial: boolean; ts: number }
  | { kind: "tool_call"; tool: string; input: unknown; toolId: string; ts: number }
  | { kind: "tool_result"; toolId: string; isError: boolean; ts: number }
  | {
      kind: "file_change";
      paths: { path: string; kind: "add" | "update" | "delete" }[];
      ts: number;
    }
  | { kind: "plan_update"; items: { text: string; done: boolean }[]; ts: number }
  | { kind: "user_echo"; text: string; ts: number } // claude --replay-user-messages ack
  | {
      kind: "hook_decision";
      decision: "allow" | "deny" | "ask" | "defer";
      reason?: string;
      ts: number;
    }
  | { kind: "turn_completed"; usage: TokenUsage; ts: number }
  | {
      kind: "finished";
      status: "success" | "error";
      subtype: string;
      structuredOutput: unknown | null;
      usage: TokenUsage;
      /**
       * Failure taxonomy (issue #17): WHY an error finish happened, so the dispatcher can pick
       * the right response — `auth` (hold for a human login), `rate_limit` (back off / fall
       * back), `timeout` (backstop cap), `spawn` (never became a process), `crash` (default
       * bounded retry). Absent on success.
       */
      errorClass?: ErrorClass;
      ts: number;
    }
  | { kind: "error"; message: string; ts: number }
  /**
   * Stall signal (issue #21): the driver watchdog saw NO progress event for
   * `supervise.worker_stall_s`. NON-terminal — the dispatcher escalates (nudge → abort+retry).
   * Emitted at most once per silent window; `idleMs` is time since the last progress event.
   */
  | { kind: "stalled"; idleMs: number; ts: number }
  /** Forward-compat fallthrough: any raw line we recognized but don't model (Spec 02 §7). */
  | { kind: "unknown"; raw: unknown; ts: number };

/**
 * A worker's own classification of what stopped it, mirrored by `../run/types.ts#BlockerClass`
 * (this file must not import from `src/run/` — nothing else here does — so the union is
 * re-declared verbatim; `src/run/types.ts` re-derives `BlockerClass` from this one).
 */
export type DoneBlockerClass =
  | "credential"
  | "admin-permission"
  | "product-decision"
  | "money"
  | "question"
  | "transient"
  | "continuation";

export interface DoneBlocker {
  class: DoneBlockerClass;
  detail: string;
  remedy: string;
  /** class "question" only: what should happen on silence. */
  defaultAnswer: string | null;
}

/** The structured "done-signal" both harnesses fill in when finished (Spec 02 §6). */
export interface DoneSignal {
  done: boolean;
  summary: string;
  filesChanged: string[];
  checksRun?: string[];
  /** Non-null ⇒ something outside the worker's reach stopped it. */
  blocker: DoneBlocker | null;
}

// =======================================================================================
// SECTION 4 — Acceptance criteria, checks, review, gate (Spec 11)
// =======================================================================================


// =======================================================================================
// SECTION 5 — Plan / DAG (Spec 04 §2, Spec 06 §4.3)
// =======================================================================================


// =======================================================================================
// SECTION 6 — Task & Node records (Spec 04 §2)
// =======================================================================================


// =======================================================================================
// SECTION 7 — Escalation, decisions, intake (Spec 04 §9, Spec 03 §4, Spec 06 §1)
// =======================================================================================


// =======================================================================================
// SECTION 8 — Supervise: smoke-alarms, check-ins, decisions (Spec 03)
// =======================================================================================


/** A paused worker's captured checkpoint (Spec 03 §5.2). */
export interface Checkpoint {
  workerId: string;
  at: number;
  sessionId: string;
  diff: string; // git diff (captured, not applied)
  diffStat: { files: number; bytes: number };
  lastTranscriptOffset: number;
  counters: WorkerSpend;
}


// =======================================================================================
// SECTION 9 — Brain outputs (Spec 06)
// =======================================================================================


// =======================================================================================
// SECTION 10 — Discord interface (Spec 05)
// =======================================================================================

/**
 * A file attached to an inbound Discord message (image / txt / pdf / md / anything).
 * Captured raw from the gateway; the shell downloads it locally so Beckett can `Read` it
 * (the parent loop is multimodal — image/pdf/text all go through the Read tool).
 */
export interface IncomingAttachment {
  id: string; // Discord attachment snowflake
  name: string; // original filename (e.g. "diagram.png")
  url: string; // CDN url to fetch the bytes
  contentType: string | null; // MIME from Discord (may be null for some uploads)
  size: number; // bytes, as reported by Discord
}

/** An embed quoted by a Discord message forward, reduced to safe display metadata. */
export interface IncomingForwardedEmbed {
  name: string;
  urls: string[];
}

/**
 * A link preview Discord attached to an ORDINARY message (issue #235). Discord attaches these a
 * beat AFTER the message itself, so the gateway settles them before the turn is built — without
 * that, a "@beckett what do you make of <url>" turn saw a bare link and improvised "nothing came
 * through on my end". Reduced to display metadata; the description is already truncated by the
 * gateway so a giant article preview cannot flood a turn.
 */
export interface IncomingLinkEmbed {
  title?: string;
  description?: string;
  url?: string;
}

/** An explicit @mention target on an inbound message: who the author actually addressed. */
export interface IncomingMentionTarget {
  /** Discord user id — the authority. */
  id: string;
  /** Display name at capture time (render label only — never authoritative). */
  name: string;
}

/** Original material carried by Discord's message-forward snapshot, not words authored by the sender. */
export interface IncomingMessageSnapshot {
  content: string;
  attachments: IncomingAttachment[];
  embeds: IncomingForwardedEmbed[];
}

/** A captured inbound Discord message (Spec 05 §2.1). */
export interface IncomingMessage {
  messageId: string;
  userId: string;
  /** The speaker's live Discord display name (guild nick → global name → username), if known. */
  authorDisplayName?: string;
  /** Live guild role ids for code-enforced capability gates; empty/absent in DMs and legacy tests. */
  roleIds?: string[];
  channelId: string;
  /** The channel's name at capture time (e.g. "media") — undefined for DMs, which have none. */
  channelName?: string;
  /**
   * The message arrived in a thread, not a top-level channel. Read straight off the live channel
   * so a thread Beckett was added to late (and therefore never registered as a workspace) is still
   * recognizable. Undefined means the gateway could not tell — a partial/uncached channel — never
   * "no": callers must treat undefined as unknown, not as a top-level channel.
   */
  isThread?: boolean;
  /** The thread's parent channel; undefined outside threads and when the parent is unknowable. */
  parentChannelId?: string;
  guildId: string | null;
  content: string;
  repliedToId: string | null; // the strong correlation key
  /** The referenced bot message carries Beckett's fixed atomic browser-question marker. */
  repliedToBrowserQuestion?: boolean;
  /** A bot reply reference could not be inspected; privacy-sensitive routing must fail closed. */
  repliedToBotUnverified?: boolean;
  mentionsBot: boolean;
  /**
   * Everyone this message explicitly @mentioned, in Discord's own order (issue #232). `mentionsBot`
   * answers only "was I addressed"; this answers "who was", which is what the ambient classifier
   * needs to stop guessing who is talking to whom. Absent (not empty) when the message mentioned
   * nobody, so the byte-shape of an ordinary message is unchanged.
   */
  mentionedUsers?: IncomingMentionTarget[];
  /**
   * Link previews attached to this message, settled by the gateway (issue #235). An empty ARRAY
   * means the gateway looked and Discord attached none; `undefined` means nothing looked at all
   * (a legacy/hand-built message), and the two are read differently — see `contentWithLinkEmbeds`.
   */
  embeds?: IncomingLinkEmbed[];
  authorIsBot: boolean;
  /**
   * Present ONLY when the author is an allow-listed trusted peer Beckett (federation). Its presence
   * is the sole in-turn signal that this author is a peer — a human leaves it undefined, and an
   * unlisted bot never reaches the Concierge at all (the gateway drops it). Carries the peer's bot
   * id and live display name so the turn can be stamped `role:peer` and addressed by name. When set,
   * `authorIsBot` is also true; the two are read together, never in isolation.
   */
  peer?: { botId: string; displayName: string };
  /**
   * Present ONLY when the author is an allow-listed observed bot (`observed_bots` config,
   * `src/discord/observed.ts`) — a bot Beckett is allowed to READ (e.g. booper) but that is
   * explicitly NOT a trusted peer: it cannot address Beckett, claim a turn, or trigger a reply
   * on its own (`mentionsBot` is forced false for it — see `normalize()`). Its sole effect is
   * letting the message through the loop-guard and into channel context/recall, distinguishably
   * from both a human and a `peer`. Mutually exclusive with `peer`; when set, `authorIsBot` is
   * also true.
   */
  observedBot?: { botId: string; displayName: string };
  createdAt: number;
  attachments: IncomingAttachment[]; // files dragged into the message (empty when none)
  /** Quoted originals attached to a Discord forward (empty/absent for ordinary messages). */
  forwardedSnapshots?: IncomingMessageSnapshot[];
}


/**
 * A single reaction ADDED to a message, normalized off the gateway's reaction event (#103). A
 * reaction is a second, cheaper trigger for the same actions a component click carries: authority
 * always comes from the Discord-authenticated {@link userId}, never from the emoji or the message
 * it lands on. The gateway drops reactions from bots (including Beckett) before this is built, and
 * fetches partial reactions/messages so an emoji on an uncached message still resolves its author
 * and components.
 */
export interface IncomingReaction {
  /** The reacted-to message id. */
  messageId: string;
  channelId: string;
  guildId: string | null;
  /** Discord-authenticated reacting user, never a value supplied by message content. */
  userId: string;
  /** Unicode emoji char (e.g. "✅") or a custom emoji's name; null when Discord sends neither. */
  emoji: string | null;
  /** Author id of the reacted-to message, or null when it could not be resolved. */
  messageAuthorId: string | null;
  /** custom_ids of the action components on the reacted-to message — transport data, never authority. */
  messageComponentIds: string[];
}


/**
 * A person's thread that just SURFACED to Beckett, normalized off the gateway's thread-create
 * event. These can be adopted as workspaces; Beckett-created numbered task threads use
 * {@link TaskThreadCreated}.
 *
 * "Surfaced" is deliberately broader than "created": Discord fires the same event when the bot is
 * merely ADDED to a thread that already existed, which is the ONLY signal we get for a thread that
 * predates the daemon. Both cases are delivered — {@link newlyCreated} tells them apart.
 */
export interface ThreadCreated {
  threadId: string;
  parentChannelId: string;
  /** The thread name the creator chose (may carry ticket identifiers, e.g. "OPS-120 auth"). */
  name: string;
  /** Discord user id of the thread creator. */
  creatorId: string;
  /**
   * True when the thread was just opened; false when Beckett was added to (or replayed into) a
   * thread that already existed. The live gateway always sets this; it is optional only so the
   * older hand-built event literals in tests keep compiling, and undefined should be read as
   * "provenance unknown", not as "newly created".
   */
  newlyCreated?: boolean;
}


/** Options for posting a reply (ambient model — always the origin channel, Spec 05 §3). */
/** The mutable portion of an existing Discord message. At least one field must be supplied. */
export interface DiscordMessageEditPayload {
  /** Replacement message text. An empty string deliberately clears the text. */
  content?: string;
  /** Replacement embeds. An empty array deliberately clears embeds. */
  embeds?: DiscordEmbed[];
  /**
   * Replacement message components (link + interaction buttons). Provided so a self-editing card
   * can keep its controls in step with state — a Merge button appears only once a PR exists. An
   * empty array deliberately clears the buttons; omitting the field leaves Discord's existing
   * components untouched.
   */
  buttons?: DiscordButton[];
  /** Replacement Components V2 card; clears the message's legacy content/embeds when present. */
  card?: DiscordCard;
}

export interface ReplyOptions {
  replyToMessageId?: string; // native reply-to for correlation
  /** Discord author id of replyToMessageId; enables only that person's native-reply notification. */
  replyToUserId?: string;
  files?: string[]; // local file paths to attach (image-only posts OK)
  embeds?: DiscordEmbed[]; // rich status cards; never carry raw diffs or secret account data
  buttons?: DiscordButton[]; // link and interaction controls; component clicks require no OAuth scope
  /** A Components V2 card. Mutually exclusive with content/embeds/buttons on the wire. */
  card?: DiscordCard;
  /**
   * Send content and attachments in exactly one Discord API message. This bypasses text
   * transforms, human-cadence splitting, and inter-message delays; over-2000 content is
   * rejected instead of silently weakening the one-message guarantee.
   */
  singleMessage?: boolean;
  /** Mark an atomic screenshot question so replies remain recognizable across daemon crashes. */
  browserQuestion?: boolean;
  /** Fail immediately instead of queueing when offline; used for expiring browser questions. */
  queueIfOffline?: boolean;
  /**
   * Discord user ids resolved from `--ping` (issue #10). Allow-listed on the first outgoing
   * message's `allowed_mentions` so the `<@id>` blobs `renderMentions` prepends to content
   * actually notify — without this they render but never ping (Discord's default is parse: []).
   */
  pingUserIds?: string[];
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Render-neutral subset of Discord's embed payload used by task, branch, and usage cards. */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordLinkButton {
  label: string;
  url: string;
}

/** A non-link message component. Its custom id is transport data, never authority. */
export interface DiscordActionButton {
  label: string;
  customId: string;
  /** Dangerous actions render red; everything else uses Discord's primary style. */
  danger?: boolean;
  /** Affirmative actions (merge, approve) render green. Wins over `danger` if both are set. */
  success?: boolean;
}

export type DiscordButton = DiscordLinkButton | DiscordActionButton;

// ── Components V2 cards ──────────────────────────────────────────────────────────────────────
// A render-neutral component tree (gateway-free, so cards stay pure + unit-testable) that the
// gateway lowers into discord.js V2 builders inside one accent-colored Container. A card
// REPLACES content/embeds/buttons on its message — Discord forbids mixing the V2 flag with
// legacy fields — so a message carries either a card or the legacy payload, never both.

/** One image in a card's media gallery. `url` is a CDN link or an `attachment://` reference. */
export interface DiscordCardImage {
  url: string;
  /** Alt text; also rendered as the item's caption on hover. */
  description?: string;
}

export type DiscordCardBlock =
  /** A markdown text display. `##` renders as a heading, `-# ` as subtext. */
  | { kind: "text"; text: string }
  /** A text block with at most one accessory button pinned to its right edge. */
  | { kind: "section"; text: string; accessory?: DiscordButton }
  /** A horizontal divider. */
  | { kind: "separator" }
  /** A row of up to five buttons. */
  | { kind: "actions"; buttons: DiscordButton[] }
  /** An inline image reel (max 10 items). */
  | { kind: "gallery"; images: DiscordCardImage[] };

export interface DiscordCard {
  /** The container's accent stripe colour. */
  color?: number;
  /** Ordered container children. Discord caps a container at 10 components — renderers budget. */
  blocks: DiscordCardBlock[];
}

/** A normalized button/select interaction after the gateway has deferred an ephemeral reply. */
export interface DiscordComponentInteraction {
  customId: string;
  /** Discord-authenticated clicking user, never a value supplied by custom_id/message content. */
  userId: string;
  channelId: string;
  isThread: boolean;
  parentChannelId?: string;
  channelName?: string;
  /** The message the clicked component is attached to — e.g. the task card, for creating a thread
   *  off it (#112). Read-only transport data like the rest of this interface; never authority. */
  messageId: string;
  /** The initial response was already deferred by the gateway inside Discord's three-second SLA. */
  editReply(content: string): Promise<void>;
}

export interface TaskThreadCreated {
  threadId: string;
  parentChannelId: string;
  name: string;
}

// =======================================================================================
// SECTION 11 — Identity & Agency (Spec 07)
// =======================================================================================

/** Gmail auth — OAuth tokens or app-password fallback (Spec 07 §2.1). */
export type GmailAuth =
  | {
      kind: "oauth";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      accessToken?: string;
      expiresAt?: number;
    }
  | { kind: "app-password"; appPassword: string };

/** Beckett's own identity surface (Spec 07 §2.1). Read-mostly. */
export interface Identity {
  name: string;
  github: {
    /** Login Beckett's work is attributed to (`beckett[bot]` under App auth). */
    account: string;
    /** Account or organization that owns Beckett-managed project repositories. */
    owner: string;
    pat: string; // NEVER logged — legacy PAT path; empty under GitHub App auth
    /**
     * GitHub App credentials (the identity since #114). Present → installation tokens are minted
     * per-target and `pat` is unused. NEVER logged. Typed loosely here to keep `types.ts`
     * dependency-free; the concrete shape is `GitHubAppCredentials` in `src/github/app.ts`.
     */
    app?: { appId: string; privateKeyPem: string; installationId?: number; slug?: string };
    apiBase: string;
    noreplyEmail: string;
  };
  gmail: {
    account: string;
    auth: GmailAuth;
  };
  discord: {
    botUser: string;
  };
  osUser: string; // "beckett" on loom-desk
}

/** Every action is exactly one class (Spec 07 §2.2). */
export enum ActionClass {
  FREE = "FREE", // reversible/internal → just do it, log it
  HANDSHAKE_GATED = "HANDSHAKE_GATED", // outward but expected → create PendingAction, ask once
  ALWAYS_ASK = "ALWAYS_ASK", // dangerous/irreversible-at-scale → never unattended
}

/** Action types the gate classifies (Spec 07 §3). Open-ended core. */
export type ActionType =
  | "gh.branch.push"
  | "gh.pr.open"
  | "gh.pr.update"
  | "gh.pr.review"
  | "gh.pr.merge"
  | "gh.branch.delete"
  | "gmail.draft"
  | "gmail.send"
  | "fs.write"
  | "memory.write"
  | (string & {});

/** Context for an action-class decision (Spec 07 §3). */
export interface ActionContext {
  ref?: string; // git ref / branch
  repo?: string;
  external?: boolean; // crosses an org boundary?
  [k: string]: unknown;
}

/** The irreversible class of a staged pending action (Spec 09 §2.11). */
export type PendingActionClass =
  | "merge_pr"
  | "send_email"
  | "force_push"
  | "external_post"
  | "other";

/** A staged irreversible action awaiting a handshake answer (Spec 07 §5; Spec 09 §2.11). */
export interface PendingAction {
  id: string;
  taskId: string;
  userId: string;
  actionClass: PendingActionClass;
  payload: Record<string, unknown>; // the staged op: {pr_url}|{draft_id,to}|…
  promptText: string; // the handshake question
  postedMsgId?: string;
  status: "pending" | "approved" | "rejected" | "expired" | "executed";
  decidedBy?: string;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
}

/** The handshake question + classification for a gated action (Spec 07 §5). */
export interface HandshakeSpec {
  actionClass: PendingActionClass;
  promptText: string;
  payload: Record<string, unknown>;
  expiresAt?: number;
}

/** Result of a gate `perform` (Spec 07 §2.3). */
export type GateActionResult<T> =
  | { status: "done"; value: T }
  | { status: "pending"; pendingAction: PendingAction };

/** GitHub operations Beckett performs (Spec 07 §3.4). Most are FREE; merge is gated. */
export interface GitHubClient {
  pushBranch(repo: string, localRef: string, remoteBranch: string): Promise<void>;
  openPR(p: OpenPRParams): Promise<{ number: number; url: string }>;
  updatePR(repo: string, n: number, p: UpdatePRParams): Promise<void>;
  reviewPR(repo: string, n: number, r: ReviewParams): Promise<void>;
  mergePR(repo: string, n: number, strategy: MergeStrategy): Promise<void>;
  isGreen(repo: string, n: number): Promise<boolean>;
}

export interface OpenPRParams {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  /** Labels to apply on creation (e.g. `["proactive"]`). Absent/empty → an unlabelled PR. */
  labels?: string[];
}
export interface UpdatePRParams {
  title?: string;
  body?: string;
  base?: string;
}
export interface ReviewParams {
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
}
export type MergeStrategy = "merge" | "squash" | "rebase";

// =======================================================================================
// SECTION 12 — Memory knowledge graph (Spec 08)
// =======================================================================================

/** Memory node kind — open enum with a known core (Spec 08 §1.3). */
export type NodeType =
  | "person"
  | "project"
  | "preference"
  | "env"
  | "worker-note"
  | "reference"
  | "decision"
  // Dream-derived inference (issue #36): NEVER an observed fact. Created only by the nightly
  // dream pass through `MemoryStore.rememberDream` — the create-only write path that forces
  // `inference: true` + a provenance list and refuses to touch any existing node.
  | "dream"
  | (string & {});

/** One markdown memory file parsed into a node (Spec 08 §2). */
export interface MemoryNode {
  name: string; // kebab-case, unique == node id
  type: NodeType;
  description: string;
  metadata: Record<string, unknown>;
  body: string; // markdown sans frontmatter & generated Backlinks
  path: string; // absolute file path
  created: string;
  updated: string;
  source: "conversation" | "derived" | "env-scan" | "manual" | "import";
  confidence?: "high" | "medium" | "low";
  stale: boolean;
  phantom: boolean; // referenced but no file yet
  mtime: number;
}

/**
 * The closed vocabulary of typed edges between memories (issue #60). An edge with no
 * `rel` is untyped — a bare `[[name]]` still means "related" and nothing more. This set is
 * deliberately fixed (not an extensible registry): supersedes / caused-by / about /
 * contradicts / part-of, plus untyped.
 */
export type RelationType = "supersedes" | "caused-by" | "about" | "contradicts" | "part-of";

/** A wikilink edge between memory files (Spec 08 §2). */
export interface MemoryEdge {
  from: string;
  to: string;
  field: string; // "body" | "members" | "owners" | ...
  alias?: string;
  /** Relation type when the link names one from the closed vocab (issue #60); absent = untyped. */
  rel?: RelationType;
  /** ISO date (YYYY-MM-DD) the edge was observed, when the link carries one (issue #60). */
  date?: string;
}

/** One line of the MEMORY.md index (Spec 08 §2.3). */
export interface IndexLine {
  name: string;
  type: NodeType;
  description: string;
  /** Last substantive edit (ISO) — lets the always-loaded index self-flag old facts. */
  updated?: string;
}

/** The hydrated memory graph (Spec 08 §2). */
export interface MemoryGraph {
  nodes: Map<string, MemoryNode>;
  out: Map<string, MemoryEdge[]>;
  in: Map<string, MemoryEdge[]>;
  index: IndexLine[];
  builtAt: number;
}

/** A relevance-ranked node from recall (Spec 08 §3). */
export interface ScoredNode {
  node: MemoryNode;
  score: number;
  via: "match" | "link";
  reason: string;
}

/** A recall query against the graph (Spec 08 §3). */
export interface RecallQuery {
  text: string;
  hint?: { names?: string[]; types?: NodeType[] };
  /** Hard narrowing (OPS-121): only these types/names are candidates at all — a hint boosts,
   *  a filter excludes. Powers targeted `beckett recall --type person --name jason`. */
  filter?: { types?: NodeType[]; names?: string[] };
  k?: number; // seeds before expansion (default 6)
  hops?: number; // link expansion depth (default 1)
}

/** The bundle recall hands the brain (Spec 08 §3). */
export interface RecallResult {
  index: IndexLine[];
  hits: ScoredNode[];
  expanded: ScoredNode[];
  phantoms: string[];
  notes: string[];
}

/** A structured memory write intent (Spec 08 §4). Opus-gated, not a reflex. */
export interface RememberIntent {
  op: "create" | "update" | "append" | "link";
  name: string;
  type?: NodeType; // required for create
  description?: string;
  metadata?: Record<string, unknown>;
  body?: string;
  links?: { to: string; field: string; rel?: RelationType; date?: string }[];
  source: MemoryNode["source"];
  reason: string; // logged to the event log
}

// =======================================================================================
// SECTION 13 — Persistence: event log + row types (Spec 09)
// =======================================================================================


// ── SQLite row types (1:1 with the DDL; enums are the Spec 02/04 unions). Spec 09 §8 ──


// =======================================================================================
// SECTION 14 — Config & Paths (Spec 01 §4)
// =======================================================================================

/** Resolved filesystem paths (Spec 01 §4 [paths]; built from Config in paths.ts). */
export interface Paths {
  home: string;
  beckettDir: string;
  projects: string;
  db: string;
  eventsDir: string;
  logsDir: string;
  memoryDir: string;
  socket: string;
  /** Resolved append-only per-stage telemetry ledger path. */
  spend: string;
  configFile: string; // <beckettDir>/config.toml
  envFile: string; // <beckettDir>/.env
  personaFile: string; // <beckettDir>/persona.md
  attachmentsDir: string; // <beckettDir>/attachments — downloaded Discord attachments
  channelsDir: string; // <beckettDir>/channels — per-channel shared-context JSONL (OPS-80)
  accessFile: string; // <beckettDir>/access.txt — Discord user whitelist (invite-only beta)
  imagesDir: string; // <beckettDir>/images — generated images (beckett image)
  identitiesFile: string; // <beckettDir>/identities.json — per-user known/preferred names (OPS-42)
  accessPendingFile: string; // <beckettDir>/access-pending.json — grant requests awaiting owner approval
  maintainersFile: string; // <beckettDir>/maintainers.txt — owner-approved additions to the bundled maintainer seed (OPS-144)
  maintainersPendingFile: string; // <beckettDir>/maintainers-pending.json — maintainer grants awaiting owner approval
  peersFile: string; // <beckettDir>/peers.txt — owner-added trusted peer Beckett bot ids (federation)
  observedBotsFile: string; // <beckettDir>/observed-bots.txt — owner-added observed (read-only) bot ids
  announcedFile: string; // <beckettDir>/announced.txt — last commit SHA announced on restart (changelog)
  presetsFile: string; // <beckettDir>/presets.json — user-defined named cast presets (OPS-110)
  pauseFile: string; // <beckettDir>/pause.json — chat-only hold; existence IS the flag (src/pause.ts)
  journalDir: string; // <beckettDir>/journal — private per-ticket worker progress journals
  proposalsDir: string; // <beckettDir>/proposals — the proposal queue (issue #37)
  companyFile: string; // <beckettDir>/company.md — the CTO seat's company brief (src/company.ts)
  workspacesFile: string; // <beckettDir>/workspaces.json — user-opened thread → ticket routing
}

/** The full validated config (Spec 01 §4). Every key has a default so an empty config boots. */
export type ProactivityMode = "off" | "suggest" | "auto";

export interface Config {
  concurrency: {
    max_workers: number;
  };
  budget: {
    /** Per-task spend ceiling in USD (#77): when a task's accrued worker cost (summed from the
     *  spend ledger) reaches this, the dispatcher stops staffing further work on it and comments
     *  why. 0 (default) disables the ceiling. A task with no ledger rows reads as $0, so tickets
     *  that predate the ledger are never blocked. */
    per_task_usd_cap: number;
  };
  supervise: {
    /** Generous backstop wall-clock cap (s) the per-worker watchdog enforces — a runaway safety
     *  net, not a work limit (drivers/proc.ts#hardCapSeconds). Floor 1800, default 14400 (4h);
     *  a value under the floor falls back to the default. Tripping it parks the run as a
     *  `timeout` naming this knob, never as a crash. */
    worker_hard_cap_s: number;
    /** Stall window (s): no progress event for this long → the driver emits a `stalled` signal
     *  and the dispatcher escalates (nudge → abort+retry). 0 disables. Default 300 (issue #21). */
    worker_stall_s: number;
    /** Checkpoint cadence (s): commit each live worker's worktree this often so a hard daemon
     *  crash loses at most one window of on-disk WIP, not the whole session. 0 disables. Default
     *  120 (OPS-125). */
    worker_checkpoint_s: number;
    /** Soft edge on the wall-clock cap (B7): this many seconds before `worker_hard_cap_s` fires,
     *  every live worker still running gets exactly one steer telling it to wrap up and emit its
     *  done-signal now. 0 disables the warning. Default 300 (5min). Rides the checkpoint pass
     *  (`checkpointLiveRuns`), so it also needs `worker_checkpoint_s > 0` to fire. */
    wrap_up_lead_s: number;
    /** Runtime-awareness threshold (s): a worker tool call running at least this long gets a
     *  PostToolUse additionalContext notice so the model can route around slow operations.
     *  0 disables the hook. Default 30. */
    worker_slow_tool_s: number;
    /** Worker browser home. false (default): a cold private BETTERWRIGHT_HOME per worker, so no
     *  credential vault, cookie jar, or config crosses between workers. true: one shared home at
     *  `<beckettDir>/worker-browser` with a per-workspace `BETTERWRIGHT_PROFILE` — warm daemon,
     *  shared binary cache/artifacts, separate cookie jars — but the vault is home-scoped, so any
     *  credential one worker saves autofills in all of them. */
    worker_browser_shared_home: boolean;
    /** Staffing-watchdog grace (s): a ticket in a staffable state with no live worker, mid-spawn
     *  reservation, queued spawn, or scheduled retry for this long is re-staffed once (logged),
     *  then parked in todo with a comment if that also fails. 0 disables. Default 120 (issue #9). */
    staffing_watchdog_s: number;
    /** Identical silent-worker fingerprints allowed before the dispatcher parks the ticket rather
     *  than repeating the same respawn forever. Default 2 (issue #44). */
    max_repeated_stall_fingerprints: number;
    /** Max implement↔review round-trips before auto-rework stops and waits for a human.
     *  Default 3 (was the dispatcher's MAX_REWORK_CYCLES constant; OPS-180). */
    max_rework_cycles: number;
    /** Total design-completeness passes before the design is escalated to its owner anyway.
     *  Default 2 (was MAX_DESIGN_CYCLES; OPS-180). */
    max_design_cycles: number;
    /** Max auto-respawns of an implement worker that ended without a clean finish (OPS-50)
     *  before the ticket is parked in todo. Default 3 (was MAX_IMPLEMENT_RETRIES; OPS-180). */
    max_implement_retries: number;
    /** Max review infra/schema retries before the ticket is left in_review for a human.
     *  Default 1 (was MAX_REVIEW_INFRA_RETRIES; OPS-180). */
    max_review_infra_retries: number;
    /** Max healthy-harness substitutions (auth/rate-limit recovery) for one ticket before the
     *  dispatcher stops thrashing across harnesses and parks it. A clean substitution is NOT a
     *  spawn failure, so it has its OWN budget, separate from `max_implement_retries` (#84).
     *  Default 6. */
    max_harness_substitutions: number;
  };
  models: {
    /** Default review-stage model (issue #27); per-ticket casts override. */
    reviewer: string;
  };
  harness: {
    /** Substitution order when a cast harness is unhealthy (issue #17 fallback chain). */
    fallback_order: Harness[];
    // No `enabled` for claude: it is the backbone harness and the fallback for every disabled
    // cast — a switch that can't honestly be turned off is config theater (issue #31).
    claude: {
      bin: string;
      default_model: string;
      default_effort: Effort;
      permission_mode: string;
      extra_flags: string[];
    };
    codex: {
      enabled: boolean;
      bin: string;
      default_model: string;
      default_effort: Effort;
      sandbox_mode: string;
      approval_policy: string;
      network_default: boolean;
    };
    pi: {
      enabled: boolean;
      bin: string;
      /** Provider id (pi `--provider`). "openai-codex" = ChatGPT/Codex OAuth backend. */
      default_provider: string;
      /** Model id (pi `--model`). e.g. "gpt-5.6-terra" (default) or "gpt-5.6-luna" (cheap lane). */
      default_model: string;
      /** Reasoning depth (pi `--thinking`). */
      thinking: Effort;
    };
  };
  paths: {
    home: string;
    beckett_dir: string;
    projects: string;
    db: string;
    events_dir: string;
    logs_dir: string;
    memory_dir: string;
    socket: string;
    /** Append-only per-stage telemetry JSONL ledger. */
    spend: string;
  };
  identity: {
    github_user: string;
    gmail_address: string;
  };
  /** Runs — the execution unit driven by `src/run/supervisor.ts`. */
  runs: {
    /** Concurrent live runs; over-cap admissions queue FIFO. Default 3. */
    max_live: number;
    /** Implement↔review round-trips before the supervisor parks the run for a human. Default 2. */
    review_cycles_max: number;
    /** Implement passes an out-of-turn worker gets before the supervisor parks it. Default 2. */
    continuation_max: number;
    /** Auto-resumes a death BECKETT ITSELF caused (wall-clock cap) gets before the supervisor
     *  stops re-spawning it and parks it (B7, `./run/death.ts`). Default 2. */
    auto_resume_max: number;
    /** Seconds an `awaiting_input` run waits for an answer before its own timer fires (B8,
     *  `./run/supervisor.ts`). Default 1800. */
    question_wait_s: number;
    /** Re-check passes an `unverified` run gets before the watchdog holds it for a human instead
     *  of re-assembling its proof forever (B12, `./run/proof.ts`). Default 20. */
    proof_recheck_max: number;
    /** Per-run USD ceiling; 0 falls back to `[budget] per_task_usd_cap`. Default 0. */
    budget_usd_per_run: number;
    /**
     * The deploy receipt: one progress card per run (`src/progress/cards.ts`), edited off the
     * dispatch event bus. Default ON.
     */
    cards: boolean;
    /**
     * The live activity blurb on a run card (`src/run/activity.ts`): what the worker is doing
     * right now, refreshed off its journal while the run is live.
     */
    activity: {
      /** Off entirely → cards render exactly as they did before blurbs existed. Default ON. */
      enabled: boolean;
      /** OPTIONAL micro-model polish; `off` (the default) keeps the derived phrase, free. */
      provider: "cerebras" | "claude" | "off";
      /** Floor between blurb refreshes for one run, seconds (clamped to ≥5). Default 15. */
      throttle_secs: number;
    };
  };
  /**
   * Proactive rot sweep: the EXPLICIT repo opt-in list, `owner/name`. Empty (the default) sweeps
   * nothing — there is no "all my repos" switch. This list is config-authoritative on every
   * routine-store load (not seed-only), so it is the ONE source of truth for which repos are
   * ever touched.
   */
  proactive_sweep: {
    repos: string[];
  };
  /** OPS-124 — GitHub PR poller. The credential lives in env; active only when one is set. */
  github: {
    /** How often to re-read watched PRs' review/CI/merge signal (seconds). */
    poll_secs: number;
    /** External commits and merged PRs from Beckett's own repository, relayed to the dev feed. */
    activity: {
      enabled: boolean;
      repo: string;
      branch: string;
      poll_secs: number;
      channel_id: string;
      /** Daemon/deploy automation accounts whose commits and PRs are intentionally silent. */
      ignored_authors: string[];
    };
  };
  /** Ambient interjection policy. Ships disabled; per-channel modes are opt-in. */
  proactivity: {
    enabled: boolean;
    default_mode: ProactivityMode;
    /** Classifier backend: subscription `claude` CLI, or Cerebras' API (CEREBRAS_API_KEY). */
    triage_provider: "claude" | "cerebras";
    triage_model: string;
    triage_threshold: number;
    burst_quiet_secs: number;
    /** Quiet needed to flush a burst DURING an engaged conversation (a lull, not silence). */
    engaged_quiet_secs: number;
    channel_cooldown_secs: number;
    max_interjections_per_hour: number;
    /** Post-speech window in which a channel's chatter is an engaged continuation (no triage/caps). */
    engaged_window_secs: number;
    offer_ttl_secs: number;
    transcript_window: number;
    channels: Record<string, ProactivityMode>;
  };
  /**
   * OPS-80 — channel-scoped shared context (multiplayer): the per-channel attributed
   * transcript injected into Concierge turns. `enabled = false` restores the old
   * per-channel ring-buffer prefix path exactly.
   */
  shared_context: {
    enabled: boolean;
    /** Hard count cap per channel in the store. */
    max_entries_per_channel: number;
    /** Entries older than this are expired at read/compaction. */
    max_age_hours: number;
    /** Per-turn injection ceiling (chars/4 token heuristic). */
    inject_budget_tokens: number;
    /** Max participants named in the roster line. */
    roster_max: number;
    /** Model for the one-shot per-channel profile summarizer (server memory, v4.1). */
    profile_model: string;
    /** New entries in a channel before its profile is rebuilt. */
    profile_update_messages: number;
    /** Max other channels named in the cross-channel awareness footer. */
    awareness_max_channels: number;
    /** #74 — inject the actual relevant lines from other guild channels, not just the footer. Kill switch: false. */
    cross_channel_enabled: boolean;
    /** Own token budget for the cross-channel context block (separate from inject_budget_tokens). */
    cross_channel_budget_tokens: number;
    /** Minimum blended relevance score a cross-channel hit must clear to be injected (else the block is omitted). */
    cross_channel_min_score: number;
    /**
     * Messages fetched either side of a reply target that sits outside the session's window
     * (the "message plus N before and after" reply-context injection).
     */
    reply_context_surrounding: number;
  };
  /** v3 — the Concierge agent that owns Discord and files tickets. */
  concierge: {
    model: string;
    /** Proactive summed-input-token watermark at which an idle Concierge session rotates. */
    rotate_at_tokens: number;
    /** Reasoning effort for the chat seat ("" = the claude CLI default; issue #25). */
    effort: "" | "low" | "medium" | "high" | "xhigh";
    /** "channel" = one session per Discord channel (concurrent conversations); "global" = the legacy single session. */
    session_scope: "channel" | "global";
    /** Turns executing at once across all concierge sessions (queued turns wait for a slot). */
    max_concurrent_turns: number;
    /** Live `claude` child processes; beyond it idle sessions are recycled (resume-on-demand). */
    max_live_sessions: number;
    /** Idle minutes before a session's child is recycled (transcript survives via --resume). */
    idle_recycle_minutes: number;
    /**
     * Directed-message settle window in ms (src/concierge/directed-settle.ts). A directed message
     * that would start a NEW turn waits this long first; another message from the same author in
     * the same channel inside the hold folds into ONE turn (the existing coalesced-burst preamble)
     * and restarts the hold, capped at 2× the window. **0 = OFF and is the default** — off is
     * today's behavior byte-for-byte. Clamped to 3000 by the schema.
     */
    directed_settle_ms: number;
    /**
     * chilltext (v7 architecture doc): restyles every human-facing Concierge message through a
     * friend's homelab rewrite API before it posts, fail-open on any error/timeout. OFF by
     * default — a fork's config must opt in (prod flips it true). W3A's own gate reads this;
     * other chill-pass callers (e.g. `[social].chill`) reuse it rather than each carrying a copy.
     */
    chilltext: {
      enabled: boolean;
      /** Base URL of the chilltext service; `${url}/chill` is POSTed. */
      url: string;
      /** Abort the POST after this long; a timeout is a normal fail-open, not an error log. */
      timeout_ms: number;
      /** Upper bound on bubbles the service may split a reply into (1–4 upstream). */
      max_bubbles: number;
      /** Delay between posting successive bubbles of one chilled reply (human texting cadence). */
      bubble_delay_ms: number;
      /**
       * ESCAPE HATCH — empty by default and meant to stay empty. The gate's system prompt is
       * derived from `~/.beckett/persona.md` (`src/chill-system.ts`), the one place the voice is
       * written down. A non-empty value here REPLACES that persona-derived prompt for every
       * message; use it to debug a rewrite, not to define how Beckett sounds.
       */
      system_override: string;
      /** Reserved for a future per-message override; the client-side ``` bypass is unconditional. */
      skip_code_blocks: boolean;
    };
    /**
     * Memory primer: a per-turn SYSTEM block of relevant memory-graph notes, auto-selected by
     * relevance to the message via the fast lexical retriever (never an LLM call on the turn
     * path). Self audience — owner-scoped facts ride along, dm-scoped facts never do.
     */
    memory_primer: {
      enabled: boolean;
      /** Notes injected per turn, before per-session change-suppression trims already-seen ones. */
      max_notes: number;
      /** Total rendered chars per turn; bodies truncate at a sentence boundary past this. */
      max_chars: number;
      /** Relevance gate: a fraction of the TOP hit's score (not an absolute) below which a hit is omitted. */
      min_score: number;
    };
  };
  /**
   * Quick agents — the NO-TICKET lane: short-lived specialist `claude -p` harnesses
   * (`computer-use`, `quick-code`, `repo-explorer`) the Concierge dispatches via
   * `beckett quick` for errands between "answer inline" and "file a ticket".
   */
  quick: {
    enabled: boolean;
    /** Model for quick harnesses (speed matters more than depth here). */
    model: string;
    /** Reasoning effort for quick harnesses ("" = the claude CLI default). */
    effort: "" | "low" | "medium" | "high" | "xhigh";
    /** How long the dispatching bus call blocks before detaching (result then arrives as an update turn). */
    sync_wait_secs: number;
    /** Backstop wall-clock cap — past this the child is killed and that IS the result. */
    hard_timeout_secs: number;
    /** Reject new runs past this many live ones ("quick lane is full — retry or file a ticket"). */
    max_concurrent: number;
    /** Dedicated automation profile, absolute or relative to paths.beckett_dir. */
    browser_profile_dir: string;
    /** The production browser is headless; false is useful only for local diagnosis. */
    browser_headless: boolean;
    browser_viewport_width: number;
    browser_viewport_height: number;
    browser_launch_timeout_ms: number;
    browser_action_timeout_ms: number;
    browser_navigation_timeout_ms: number;
    browser_eval_timeout_ms: number;
    /** Per-tool output budget before the runtime truncates noisy page data. */
    browser_max_output_chars: number;
    /** How long a screenshot-backed user question may remain parked before expiring. */
    browser_question_wait_secs: number;
    /** Extra Chromium switches appended to BetterWright's managed launch args. */
    browser_chromium_args: string[];
    /** Quiet each session's pages between executions (betterwright default is also true). */
    browser_park_background_pages: boolean;
    /** Extra absolute roots whose validated media files a browser run may attach. */
    browser_attach_roots: string[];
    /** Live-view exposure preset for watched runs; "off" disables watch-time live view. */
    browser_live_view_expose: "off" | "local" | "lan" | "tailscale";
  };
  /**
   * Restart "what's new" announcement — instance-specific, OFF by default (empty channel), so a
   * fork inherits silence. When set, on boot with newer code than last announced the Concierge
   * posts a short, in-voice changelog to the channel (derived from git commit subjects).
   */
  announce: {
    /** Discord channel id to post the changelog to. Empty = feature off. */
    changes_channel_id: string;
    /** Cap on commits summarized in one announcement (a big deploy shouldn't dump 50 lines). */
    max_commits: number;
  };
  /**
   * Federation — talking to OTHER Becketts (the fork ecosystem). Discord ignores bots by
   * default (Beckett drops every `author.bot` message to kill self-loops); a peer whose bot
   * user id is listed here is exempted, so sibling Becketts can address each other. Ships
   * INERT: an empty `peers` list preserves today's "ignore all bots" behavior exactly. The
   * conversation protocol on top (addressing, handshakes, loop semantics) is deliberately
   * still open — this is only the primitive that makes peer messages *reach* the Concierge.
   */
  federation: {
    /** Discord bot user ids of trusted peer Becketts. Your OWN id is always ignored even if
     *  listed (self-loop guard); an unlisted bot is dropped as before. Default: none. */
    peers: string[];
    /** Runaway backstop: max peer-bot messages the gateway will process per channel per
     *  rolling minute, so two auto-replying Becketts can never melt a channel. Default 5. */
    peer_burst_per_min: number;
    /** Loop terminator: max CONSECUTIVE peer-to-peer replies Beckett gives in one channel before a
     *  human must speak. Unlike the per-minute burst cap this is what makes a two-bot exchange
     *  provably END rather than merely slow down; the count resets on any human message. Default 6. */
    peer_max_consecutive_turns: number;
  };
  /**
   * Observed bots — a bot Beckett is allowed to READ (e.g. booper, a from-scratch language
   * model that posts its generations into channels Beckett sits in) without treating it as a
   * peer Beckett. This is a strictly WEAKER trust level than `federation`: an observed bot's
   * messages are normalized and stored like any other message — they show up in channel
   * context and `beckett channels recall`/`search` — but the bot can never address Beckett,
   * claim a turn, or trigger a reply on its own (`normalize()` forces `mentionsBot` false for
   * it). Two different trust levels, two different lists: an id here is never treated as a
   * federation peer, and the peer set is never consulted for this gate. Ships INERT for a
   * fork with an empty `ids` list; this instance's default seeds booper's id.
   */
  observed_bots: {
    /** Discord bot user ids Beckett may read but never talk to. Your OWN id is always ignored
     *  even if listed (same loop-guard as federation); an unlisted bot is dropped as before. */
    ids: string[];
    /** Runaway backstop: max observed-bot messages the gateway will store per channel per
     *  rolling minute, so a chatty bot can never flood the channel store. Default 5. */
    burst_per_min: number;
  };
  /**
   * Free time (docs/freetime.md): one weekly, budgeted, unprompted session in a scratch
   * directory, with structured memory writeback seeding the next one. Every number here is a
   * WALL, not a dial the session can reach: the session runs as its own process and has no
   * write path to this file.
   */
  free_time: {
    /** The human off-switch. False = the routine's fire is refused before anything spawns. */
    enabled: boolean;
    /** Weekday the builtin routine is SEEDED on (one of `WEEKDAYS`, `src/routine/types.ts`);
     *  after the seed, the routine store owns the timing and `beckett routine` edits it. */
    weekday: string;
    /** Fuzz window the seeded routine's fire time is rolled inside (24h HH:MM, local to `tz`). */
    window_start: string;
    window_end: string;
    /** IANA tz for that window. Matches the other weekly builtins' home timezone. */
    tz: string;
    /** Model the session runs on. A session is Beckett with time, not a specialist. */
    model: string;
    /** Turn cap on the one harness call. */
    max_turns: number;
    /** Wall-clock cap on the one harness call, in seconds. A wedged child is killed, not waited on. */
    hard_timeout_s: number;
    /** Hard ceiling on model OUTPUT tokens per session. A session that cannot fit does not launch. */
    output_token_budget: number;
    /** Most durable memories one session may write. Over-cap entries are dropped and counted. */
    memories_per_session_max: number;
    /** Channel the optional one-line share posts to. Empty = the session says nothing to anyone. */
    channel_id: string;
  };
  /** The social-media agent's chilltext chill pass (W4A tune): reuses `concierge.chilltext`. */
  social: {
    /** Route composed X posts through chilltext before they reach the browser lane. Default
     *  true; chilltext already fails open, so false is purely a taste toggle. */
    chill: boolean;
  };
  /** Discord ops-log mirror (issue #231): legible one-line renderings of daemon log events,
   *  batched into one channel, plus a turn-in-flight heartbeat. `src/ops-log/`. */
  ops_log: {
    /** Master switch. Default false — the DEPLOY config (not this repo's example) turns it on. */
    enabled: boolean;
    /** Discord channel id the mirror posts into. Empty means inactive even if enabled=true. */
    channel_id: string;
    /** Minimum level mirrored to Discord — independent of BECKETT_LOG_LEVEL, which gates stderr. */
    level: LogLevel;
    /** Components admitted at ANY level even below `level` — an opt-in allowlist for one noisy
     *  component's debug chatter without dropping the global level for everything else. */
    include_debug_components: string[];
  };
}

// =======================================================================================
// SECTION 15 — IPC envelope & command set (Spec 01 §7, Spec 10 §8)
// =======================================================================================


/** Daemon introspection reply for `status` (Spec 10 §7/§8.4). */
export interface StatusReport {
  pid: number;
  uptimeMs: number;
  bunVersion: string;
  liveWorkers: number;
  queuedNodes: number;
  activeTasks: number;
  discord: {
    connected: boolean;
    lastEventAgeMs: number | null;
  };
  recovery: {
    recovering: boolean;
    resumedWorkers: number;
  };
}

// =======================================================================================
// SECTION 16 — Module interfaces (dependency inversion; daemon wires concrete impls)
// =======================================================================================

/**
 * The two-implementation spawn/steer/abort surface (Spec 02 §3). The control plane and DAG
 * executor never touch a CLI directly — they hold a HarnessDriver and call these methods.
 */
export interface HarnessDriver {
  readonly kind: DriverKind;
  /** Create worktree (if needed), launch, return once sessionId is known. spawning→running. */
  spawn(spec: SpawnSpec): Promise<SpawnResult>;
  /** Soft steer. claude: stdin user line (next turn boundary). codex: queued for resume. */
  sendNudge(msg: string): Promise<NudgeReceipt>;
  /** Checkpoint (claude: quiesce; codex: stop auto-resume). */
  pause(): Promise<void>;
  /** Re-attach a paused/crashed worker via --resume / exec resume (same cwd). */
  resume(): Promise<void>;
  /** Hard stop: SIGTERM→SIGKILL the group, retain sessionId. */
  abort(reason: string): Promise<void>;
  /** Subscribe to the normalized event stream. Returns an unsubscribe fn. */
  onEvent(cb: (e: WorkerEvent) => void): () => void;
  /** Snapshot of derived counters (cheap; reads accumulators + git diff --stat). */
  getTelemetry(): WorkerSpend;
  /**
   * Drain any steering that was buffered but never reached the model (issue #22): claude buffers
   * while paused/dead; one-shot harnesses buffer for a resume a crash can pre-empt. Called by
   * the spawn glue at finish so unapplied user words are re-routed, never silently dropped.
   */
  drainUnappliedNudges?(): string[];
}

/** Inputs to spawn one harness process (Spec 02 §3). */
export interface SpawnSpec {
  workerId: string;
  prompt: string; // the node task (initial user turn)
  systemAppend: string; // criteria + scope + worker-persona (businesslike)
  workspace: string; // worktree path
  scope: FileScope;
  envelope: ResourceEnvelope;
  model: string;
  sessionId?: string; // optional caller-minted UUID (claude --session-id); else captured
  /**
   * Crash recovery (issue #20): when set, the driver LAUNCHES IN RESUME MODE against this
   * persisted session/thread id instead of starting fresh — `prompt` becomes the next user turn
   * of the restored transcript (claude `--resume`, pi `--session`, `codex exec resume`).
   * Takes precedence over {@link sessionId}.
   */
  resumeSessionId?: string;
  mcpConfigPath?: string;
  doneSchemaPath: string; // JSON-schema file for the structured done-signal
  // v3.1: external settings file (claude --settings) carrying the scope-guard hook. Used when the
  // worker runs IN the project checkout (no worktree) so we never clobber the project's own
  // .claude/settings.json — claude layers --settings on top rather than replacing it.
  settingsPath?: string;
  /**
   * Cross-session address (claude `--name`, ≥2.1.224): lets the concierge and other live sessions
   * message this worker by name (ListAgents/SendMessage). Unset = the harness's auto-name (cwd
   * folder). Omitted entirely (never passed as an empty flag) when the installed claude binary
   * doesn't advertise `--name` support (see {@link ClaudeDriver}'s cached `--help` probe).
   */
  sessionName?: string;
  /**
   * Extra top-level keys merged into the worker's `--settings` JSON on top of the driver's own
   * (e.g. `crossSessionInbound: "accept"`) — an escape hatch for callers (ultracode's
   * `workflowSizeGuideline`, future run-scoped knobs). Must not contain `hooks` (see
   * {@link renderClaudeSettings}); `writeWorkerMeta`/`renderClaudeSettings` ignore that key if present.
   */
  settingsExtra?: Record<string, unknown>;
}

export interface SpawnResult {
  sessionId: string;
  pid: number;
}


/** One message in a fetched reply-context window (see DiscordGateway.fetchMessageContext). */
export interface ReplyContextMessage {
  messageId: string;
  /** Discord's own timestamp, epoch ms. */
  ts: number;
  authorId: string;
  /** Display name at fetch time (render label only — never authoritative). */
  authorName: string;
  content: string;
  /** True for Beckett's own posts (the gateway knows its bot id; the Concierge doesn't). */
  isBeckett: boolean;
  /** True on the single message the live turn is replying to. */
  isTarget: boolean;
}

/** Holds the discord.js connection; ambient in→same-channel out (Spec 05). */
export interface DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Post to a channel; returns the bot message id (for reply correlation). */
  post(channelId: string, content: string, opts?: ReplyOptions): Promise<string>;
  /**
   * Post a single image and return its Discord CDN URL (or null when it can't be resolved). Used to
   * surface a frontend result screenshot as a channel ping AND to embed that hosted image on the
   * ticket record (#75). Never throws — degrades to null.
   */
  postImage?(channelId: string, content: string, filePath: string): Promise<string | null>;
  /**
   * Edit an existing bot message. Rejections are typed DiscordMessageEditError subclasses so
   * periodic callers can distinguish a deleted message from retryable Discord outages.
   */
  editMessage(channelId: string, messageId: string, payload: DiscordMessageEditPayload): Promise<void>;
  /** Delete one bot-authored message when a privacy-critical ledger write fails. */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /** Author id of a message, or null if it no longer exists — the authorship check behind the
   *  `beckett discord delete` verb (issue #35), which refuses anything not authored by Beckett. */
  fetchMessageAuthorId(channelId: string, messageId: string): Promise<string | null>;
  /** Beckett's own Discord user id once connected (undefined before login). */
  botUserId(): string | undefined;
  /** Trigger the typing indicator in a channel (~10s; re-call to keep it alive). */
  sendTyping(channelId: string): Promise<void>;
  /** Register the inbound message handler (intake + awaiting-reply resolution). */
  onMessage(cb: (m: IncomingMessage) => void | Promise<void>): void;
  /**
   * Fetch user messages newer than a stored channel cursor, normalized exactly like gateway events.
   * Optional while older injected test transports are phased out.
   */
  fetchMessagesAfter?(channelId: string, after: string): Promise<IncomingMessage[]>;
  /**
   * Fetch one message plus up to `surrounding` messages before and after it (oldest first,
   * the target flagged) — the context for a reply to a message outside the session's window.
   * Returns null when the target is gone or unreachable (deleted, no access): the caller
   * degrades to no injection. Optional so injected test transports need no fake.
   */
  fetchMessageContext?(
    channelId: string,
    messageId: string,
    opts?: { surrounding?: number },
  ): Promise<ReplyContextMessage[] | null>;
  /**
   * Register the handler for threads PEOPLE create (bot-created threads are filtered out at the
   * gateway). The Concierge registers each as a ticket workspace so messages inside it are
   * directed turns without an @mention. Beckett itself never opens threads — the old bot-spawned
   * activity/progress threads are gone; the worker firehose goes to the private ticket journal.
   */
  onThreadCreate(cb: (t: ThreadCreated) => void | Promise<void>): void;
  /**
   * Register a button/select component callback. The concrete gateway defers every component
   * ephemerally before calling this, so handlers may do slow work and only edit the reply.
   */
  onInteraction?(cb: (interaction: DiscordComponentInteraction) => void | Promise<void>): void;
  /**
   * Register the handler for reactions ADDED to a message (#103). The gateway fetches partial
   * reactions/messages and drops bot reactions (incl. Beckett's own) before calling this, so the
   * handler always sees a fully-resolved reaction from a human. Optional because injected partial
   * test gateways predate this surface — guard with `typeof gateway.onReaction === "function"`.
   */
  onReaction?(cb: (reaction: IncomingReaction) => void | Promise<void>): void;
  /**
   * Add a single reaction to a message — the cheapest acknowledgement Discord offers (#103). The
   * emoji is a unicode char (e.g. "✅") or a `name:id` custom-emoji ref. Optional so injected test
   * gateways need no fake; guard with `typeof gateway.addReaction === "function"`.
   */
  addReaction?(channelId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * Join a thread so Beckett stays subscribed to it and a post can unarchive it. Best-effort:
   * implementations swallow permission/unknown-channel failures and never reject. Optional
   * because injected partial test gateways predate this surface — guard with
   * `typeof gateway.joinThread === "function"` exactly like {@link onThreadCreate}'s callers do.
   */
  joinThread?(threadId: string): Promise<void>;
  /** Create or rename the dedicated Discord workspace for a numbered task. */
  createTaskThread?(channelId: string, name: string): Promise<TaskThreadCreated>;
  /**
   * Start a thread off a specific message (#112) — the one-click "Attach to thread" path from a
   * plain channel. Reuses the message's thread if it already has one instead of erroring. Optional
   * so injected partial test gateways predate this surface.
   */
  createThreadFromMessage?(channelId: string, messageId: string, name: string): Promise<TaskThreadCreated>;
  isConnected(): boolean;
  lastEventAgeMs(): number | null;
}


/** Recall + write over the markdown knowledge graph (Spec 08). */
export interface Memory {
  recall(q: RecallQuery): Promise<RecallResult>;
  remember(intent: RememberIntent): Promise<MemoryNode>;
  /** Rebuild the SQL mirror from the md tree (Spec 09 §2.12). */
  reindex(): Promise<void>;
}


/** Minimal structured logger surface (src/log.ts). */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** A child logger that tags every line with a component name. */
  child(component: string): Logger;
}
