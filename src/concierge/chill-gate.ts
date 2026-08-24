/**
 * Beckett — chilltext delivery gate (`src/concierge/chill-gate.ts`)
 * =======================================================================================
 * The ONE place every human-facing Concierge reply funnels through on its way to
 * `DiscordGateway.post` (v7 architecture doc, ctx-concierge.md §Outbound delivery seams — all
 * four call sites use this, nothing else does). Fail-open by construction: a bypass (flag off,
 * code fence, oversize, bare ack/URL) or a `null` transform both degrade to posting `text`
 * exactly as the caller handed it in, in one call, exactly like the pre-chilltext code did.
 *
 * A chilled reply becomes several bubbles posted in sequence with a human-cadence delay between
 * them; only the FIRST carries the caller's `postOpts` (the native reply-to, ping ids, …) —
 * bubbles after it post plainly, the same way a second Discord message in a human's own burst
 * would. Every bubble is `singleMessage: true`: chilltext already sized them, so Beckett's own
 * chunker/humanizer must not re-split or re-delay past `bubble_delay_ms`.
 *
 * Three structural guards run on the rewritten bubbles before they post, neither trusting the
 * rewrite model to have honored its contract:
 *
 *   - `enforceMentions` (`src/discord/mentions.ts`) repairs a `<@id>` ping the rewrite mangled
 *     into inert text.
 *   - `detectEchoedInput` (`./echo-guard.ts`) catches the way the rewrite has drifted twice
 *     before: on 2026-08-18 it handed the user's own triggering message back as Beckett's reply,
 *     pronouns inverted ("you're the CTO" — backwards), and on a later delivery it PREPENDED the
 *     user's own message verbatim onto the front of the real reply. Run PER BUBBLE, because only
 *     one bubble in a multi-bubble delivery drifted either time. A whole-bubble echo falls back to
 *     the un-chilled `text` this call was asked to restyle; a leading/trailing-span echo prefers
 *     shipping the guard's repaired remainder and only falls back to `text` wholesale when no
 *     repair is available — same fail-open shape as everything else here either way.
 *   - A third, distinct drift (2026-08-20): a bubble came back carrying a fragment of the
 *     rewrite's OWN delivery-format instructions, not anything from the conversation at all. Two
 *     checks run per bubble for this, both fully closed to `text` on a trip (no partial repair —
 *     prompt scaffolding is never worth salvaging part of): `detectPromptScaffolding` scores the
 *     bubble for the general SHAPE of delivery-contract language (message-count ranges, "return
 *     only" directives, …), and `detectEchoedInput` is reused a SECOND time per bubble — not
 *     against `input`, but against the `system` string this exact call resolved and sent — to
 *     catch a near-copy of our own prompt text. Neither check needs `input`, so both run even when
 *     no `input` was supplied to this call.
 *
 * That same 2026-08-18 incident was hard to diagnose because nothing durable recorded the
 * transform's before/after — only the posted (already-rewritten) bubble survived in the channel
 * store. `./chilltext-log.ts` closes that gap: every call below appends one JSONL record (input,
 * pre-chill text, chilltext's raw bubbles, what was actually posted, the echo guard's scores, the
 * outcome) when a caller supplies `logPath`, so `beckett chilltext-log` can show the exact
 * before/after pair for any delivery, not just the ones that happened to still be recent in the
 * channel transcript.
 */

import type { Config, DiscordGateway, Logger, ReplyOptions } from "../types.ts";
import { chillTransform, shouldBypassChill, type ChillTransformResult } from "../chilltext.ts";
import { enforceMentions } from "../discord/mentions.ts";
import {
  detectEchoedInput,
  detectPromptScaffolding,
  detectContentSubstitution,
  detectLeadingClauseSubstitution,
  detectPersonaSampleLineLeak,
  type PromptScaffoldResult,
  type PersonaLeakResult,
} from "./echo-guard.ts";
import { appendChillTransformLog, type ChillTransformLogRecord } from "./chilltext-log.ts";
import { outboundBubbleKey } from "../discord/outbound-dedupe.ts";

/** How much of a bubble/input to keep in a trip's warning log — enough to diagnose, not a full dump. */
const LOG_SNIPPET_CHARS = 200;

function truncateForLog(text: string): string {
  return text.length > LOG_SNIPPET_CHARS ? `${text.slice(0, LOG_SNIPPET_CHARS)}…` : text;
}

/** Split the pre-chill reply into its blank-line-separated blocks — the unit
 * `reconcileBubblesWithBlocks` matches chilltext's returned bubbles against. A reply with no blank
 * line at all is one block: itself. */
function splitIntoBlocks(text: string): string[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return blocks.length > 0 ? blocks : [text];
}

/** One entry in the reconciled bubble/block sequence, in the original bubbles' relative order —
 * covers both what actually gets POSTED (`kind !== "dropped"`) and what was dropped, purely for
 * logging. */
interface ReconciledEntry {
  kind: "bubble" | "block-fallback" | "dropped";
  /** What should be posted for this entry (`kind !== "dropped"`), or the fabricated bubble text
   * that never posts at all (`kind === "dropped"`). */
  text: string;
  /** The chilltext bubble this entry came from. `null` for a `"block-fallback"` with no bubble at
   * all — every other kind always has one. */
  rewritten: string | null;
  /** Index into the ORIGINAL bubbles array this entry came from. `null` for a `"block-fallback"`
   * with no bubble at all. */
  sourceIndex: number | null;
  /** `detectContentSubstitution`'s containment score for the matched (bubble, block) pair. `null`
   * when there was no bubble to score (a `"block-fallback"` with no bubble, or a `"dropped"` bubble
   * that matched no block at all). */
  fidelityScore: number | null;
  /** True when this entry's fallback was forced by `detectLeadingClauseSubstitution` (the
   * 2026-08-24 incident) rather than by the whole-message containment score alone — see that
   * function's doc in `./echo-guard.ts`. Only ever set on the bubble matched to the FIRST block.
   * Omitted (not `false`) otherwise. */
  leadingClauseFail?: boolean;
  /** `detectLeadingClauseSubstitution`'s score, alongside `leadingClauseFail`. `undefined` when the
   * check didn't run for this entry. */
  leadingClauseScore?: number | null;
}

/**
 * Reconcile chilltext's returned bubbles against the blank-line blocks of the pre-chill reply —
 * the guard against BOTH shapes of the 2026-08-21 incident (channel 1520986792373911622, plus a
 * third occurrence found on retroactive analysis, 2026-08-19T05:12:08.718Z):
 *
 *   - INJECTION: chilltext returns a surplus bubble with nothing behind it — more bubbles than the
 *     reply had blocks, and the extra one is fabricated persona text. That bubble is dropped
 *     outright, never posted; it is never a candidate for the delivery at all, unlike every other
 *     guard in this file which falls back to something truthful.
 *   - SUBSTITUTION: the count lines up, but a bubble's content has nothing to do with the block it
 *     was supposedly rewritten from. That bubble is replaced with the block, verbatim — same
 *     fail-open shape as `detectEchoedInput`'s whole-bubble fallback.
 *
 * Both are decided by ONE monotonic walk over the bubbles, advancing a block cursor only when the
 * bubble IN HAND relates better to a LATER block than to the current one. That "only when
 * justified" rule is what keeps this safe against chilltext's ordinary, harmless re-chunking: one
 * block legitimately split into several bubbles just matches the same block repeatedly (the cursor
 * never advances on its own), and several blocks merged into fewer bubbles advances the cursor
 * exactly as many times as the bubbles justify — it never speculatively skips ahead. A block the
 * walk never lands a bubble on (content genuinely dropped, not merged) falls back to posting that
 * block verbatim, in its correct order — a lost block is a defect same as a fabricated one, so this
 * never lets one disappear silently.
 *
 * Returns every entry in original-bubble order — matched bubbles, block-only fallbacks, and
 * dropped bubbles, interleaved as they actually occurred — so a caller can both post
 * (`kind !== "dropped"`) and log (every entry) from one pass.
 */
function reconcileBubblesWithBlocks(blocks: string[], bubbles: string[]): ReconciledEntry[] {
  interface RawMatch {
    bubble: string;
    sourceIndex: number;
    blockIndex: number | null;
    score: number | null;
    leadingClauseFail?: boolean;
    leadingClauseScore?: number | null;
  }
  // A bubble with no content words at all (a bare "ok") has nothing to score — treat it as a
  // perfect fit either way, so it never drives the cursor by itself.
  const matchScore = (bubble: string, block: string) => detectContentSubstitution(bubble, block).score ?? 1;

  const raw: RawMatch[] = [];
  let bi = 0;
  bubbles.forEach((bubble, sourceIndex) => {
    // Advance the block cursor only when this bubble fits the NEXT block strictly better than the
    // current one — a genuine comparison, not just "current fails a threshold" (two consecutive
    // blocks that happen to share a quoted phrase can both clear the threshold; picking whichever
    // fits better is what keeps that from mis-binding a bubble to the wrong one).
    while (bi < blocks.length - 1 && matchScore(bubble, blocks[bi + 1]!) > matchScore(bubble, blocks[bi]!)) {
      bi++;
    }
    let check: { unrelated: boolean; score: number | null } =
      bi < blocks.length ? detectContentSubstitution(bubble, blocks[bi]!) : { unrelated: true, score: null };
    // The leading-clause check (2026-08-24 incident) runs ONLY for the bubble landing on block 0 —
    // the one carrying the reply's opening clause. Every OTHER bubble matched to block 0 (a block
    // legitimately split into several bubbles) covers a LATER fragment of it and would misfire
    // against the block's own opener, so `sourceIndex === 0` (the first bubble chilltext returned)
    // is the proxy for "this is the bubble that's supposed to open the reply." Only runs when the
    // whole-message containment check already passed — a bubble it already flagged unrelated needs
    // no second opinion.
    let leadingClauseFail: boolean | undefined;
    let leadingClauseScore: number | null | undefined;
    if (sourceIndex === 0 && bi === 0 && !check.unrelated && blocks.length > 0) {
      const lead = detectLeadingClauseSubstitution(bubble, blocks[0]!);
      leadingClauseScore = lead.score;
      if (lead.unrelated) {
        leadingClauseFail = true;
        check = { unrelated: true, score: check.score };
      }
    }
    if (bi < blocks.length && !check.unrelated) {
      raw.push({ bubble, sourceIndex, blockIndex: bi, score: check.score, leadingClauseFail, leadingClauseScore });
    } else {
      // `check.score` survives into the dropped entry even though the bubble didn't match — it's
      // the whole-message containment score, and for a `leadingClauseFail` drop specifically it's
      // the number that proves the whole-message check alone would have passed this bubble.
      raw.push({ bubble, sourceIndex, blockIndex: null, score: check.score, leadingClauseFail, leadingClauseScore });
    }
  });

  const entries: ReconciledEntry[] = [];
  let rawPtr = 0;
  const flushDropped = () => {
    while (rawPtr < raw.length && raw[rawPtr]!.blockIndex === null) {
      const r = raw[rawPtr]!;
      entries.push({
        kind: "dropped",
        text: r.bubble,
        rewritten: r.bubble,
        sourceIndex: r.sourceIndex,
        // `r.score` is `null` for a genuine surplus bubble (never scored against any block at
        // all). For a `leadingClauseFail` drop it's the whole-message CONTAINMENT score that
        // passed — worth keeping in the log precisely because it's the number that proves the
        // whole-message check alone would have let this bubble through.
        fidelityScore: r.score,
        ...(r.leadingClauseFail ? { leadingClauseFail: true, leadingClauseScore: r.leadingClauseScore ?? null } : {}),
      });
      rawPtr++;
    }
  };
  for (let k = 0; k < blocks.length; k++) {
    flushDropped();
    let matchedAny = false;
    while (rawPtr < raw.length && raw[rawPtr]!.blockIndex === k) {
      const r = raw[rawPtr]!;
      entries.push({ kind: "bubble", text: r.bubble, rewritten: r.bubble, sourceIndex: r.sourceIndex, fidelityScore: r.score });
      matchedAny = true;
      rawPtr++;
    }
    if (!matchedAny) {
      entries.push({ kind: "block-fallback", text: blocks[k]!, rewritten: null, sourceIndex: null, fidelityScore: null });
    }
  }
  flushDropped();
  return entries;
}

export interface DeliverChilledOptions {
  /** The user's triggering message, forwarded to chilltext as `input` (recommended, not required). */
  input?: string;
  /** Reply-to/ping/etc. opts the FIRST posted bubble carries; later bubbles post plainly. */
  postOpts?: ReplyOptions;
  gateway: DiscordGateway;
  /** `config.concierge.chilltext`. May be `undefined` on a hand-built test config — treated as off. */
  cfg: Config["concierge"]["chilltext"] | undefined;
  /**
   * The persona file the chilltext voice is derived from (`paths.personaFile`). Omitted ⇒ the
   * default `<beckettDir>/persona.md`; a missing file just means chilltext's own default voice,
   * never a dropped message.
   */
  personaPath?: string;
  logger?: Logger;
  /** Force one bubble (the early-ack seam: a progress line must stay one atomic message). */
  single?: boolean;
  /**
   * Called once for every message this delivery actually posts (each chilled bubble, or the
   * single bypass/fallback post), so the shared context record stays exactly in step with what
   * landed in Discord. Owned entirely by `deliverChilled` — a caller that ALSO records the
   * returned id against its own full pre-chill `text` duplicates whatever this already recorded
   * for the first bubble under that same id (the OPS-80 "mega message" bug: one store entry
   * claiming the whole reply, sitting alongside the individual bubbles it was chilled into).
   */
  recordPost?: (channelId: string, text: string, messageId: string | null) => void;
  /** Test seam: skip the real delay. Defaults to `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: inject a fake transform instead of `chillTransform` (and its real fetch/network). */
  transform?: typeof chillTransform;
  /** Test seam: inject a fake echo guard instead of `detectEchoedInput`. Also used for the
   * prompt-text-echo check (against the resolved `system` string) — same function, same contract. */
  echoGuard?: typeof detectEchoedInput;
  /** Test seam: inject a fake prompt-scaffolding guard instead of `detectPromptScaffolding`. */
  promptGuard?: typeof detectPromptScaffolding;
  /** Test seam: inject a fake persona-sample-line guard instead of `detectPersonaSampleLineLeak`. */
  personaGuard?: typeof detectPersonaSampleLineLeak;
  /**
   * Path to the chilltext transform transcript (`./chilltext-log.ts`). Opt-in, same shape as
   * `recordPost`: when omitted, nothing is logged and nothing on disk is touched — real call sites
   * pass `buildPaths(config).chilltextLog`. A write failure here never blocks or drops a delivery.
   */
  logPath?: string;
  /**
   * Identity of this delivery (the mention/ambient message id). Combined with channel and bubble
   * index into {@link ReplyOptions.idempotencyKey} so the same bubble cannot be posted twice if
   * auto-post and `beckett discord reply` both fire, or if `gateway.post` is retried.
   */
  deliveryId?: string;
}

const defaultSleep = (ms: number): Promise<void> => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

function bubbleOpts(
  postOpts: ReplyOptions | undefined,
  deliveryId: string | undefined,
  channelId: string,
  bubbleIndex: number,
): ReplyOptions | undefined {
  if (!deliveryId) return postOpts;
  return { ...postOpts, idempotencyKey: outboundBubbleKey(deliveryId, channelId, bubbleIndex) };
}

/**
 * Post `text` to `channelId`, chilled through the configured API when eligible, falling back to
 * one plain post of the original text on any bypass or failure. Returns the id of the FIRST
 * message posted — callers use it exactly as they used the old `gateway.post` return value
 * (reply-correlation anchor, `ackMessageId`, `messageId` in a bus response, …).
 */
export async function deliverChilled(
  channelId: string,
  text: string,
  opts: DeliverChilledOptions,
): Promise<string> {
  const { gateway, cfg, postOpts, input, single, logger, recordPost } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const transform = opts.transform ?? chillTransform;
  const echoGuard = opts.echoGuard ?? detectEchoedInput;
  const promptGuard = opts.promptGuard ?? detectPromptScaffolding;
  const personaGuard = opts.personaGuard ?? detectPersonaSampleLineLeak;
  const logPath = opts.logPath;
  const startedAt = Date.now();
  // Every return point below appends exactly one transcript record; only the shared fields differ.
  const logTransform = (fields: Omit<ChillTransformLogRecord, "ts" | "channelId" | "input" | "agentOutput">) => {
    if (!logPath) return;
    appendChillTransformLog(
      logPath,
      { ts: new Date().toISOString(), channelId, input: input ?? null, agentOutput: text, ...fields },
      logger,
    );
  };

  if (shouldBypassChill(text, cfg)) {
    const messageId = await gateway.post(channelId, text, bubbleOpts(postOpts, opts.deliveryId, channelId, 0));
    recordPost?.(channelId, text, messageId);
    logTransform({ outcome: "bypassed", durationMs: Date.now() - startedAt, bubbles: null });
    return messageId;
  }

  let result: ChillTransformResult | null = null;
  let threw = false;
  try {
    result = await transform(cfg!, { input, agentOutput: text, single, personaPath: opts.personaPath });
  } catch (err) {
    // chillTransform is documented to never throw, but a test double or a future caller might —
    // this is the fail-open backstop that keeps a delivery gate from ever losing a reply to it.
    logger?.warn("chilltext transform threw — falling back to the original text", { error: String(err) });
    result = null;
    threw = true;
  }
  const transformDurationMs = Date.now() - startedAt;

  if (!result) {
    const messageId = await gateway.post(channelId, text, bubbleOpts(postOpts, opts.deliveryId, channelId, 0));
    recordPost?.(channelId, text, messageId);
    logTransform({ outcome: threw ? "threw" : "fallback", durationMs: transformDurationMs, bubbles: null });
    return messageId;
  }

  // The chilltext rewrite is a lossy LLM pass that has, on real deliveries, drifted in two
  // different ways: handing the user's own triggering message back as Beckett's reply (pronouns
  // inverted, or prepended onto the front of the real reply — the `input`-echo checks below), and
  // separately, handing back a fragment of its OWN delivery-format instructions (the
  // prompt-scaffolding checks below). Every check runs PER BUBBLE and falls back to the un-chilled
  // `text` only for the bubble that drifted — the other bubbles in the same delivery are very
  // likely fine and should post exactly as rewritten.
  type EchoScore = { echoed: boolean; contentScore: number | null; fullScore: number | null; repaired: boolean };
  const NOT_CHECKED: EchoScore = { echoed: false, contentScore: null, fullScore: null, repaired: false };
  type PromptLeakScore = PromptScaffoldResult & { textEcho: boolean };
  const NO_PROMPT_LEAK: PromptLeakScore = { leaked: false, signals: [], textEcho: false };
  const NO_PERSONA_LEAK: PersonaLeakResult = { leaked: false, matchedClause: null };

  // The persona sample-line clauses (2026-08-21, 2026-08-24 incidents) this bubble set gets checked
  // against — echoed back by `transform` itself (`ChillTransformResult.sampleLines`), same reasoning
  // as `systemPrompt` below: a second read here could, in principle, catch the persona file mid-edit
  // and disagree with what this call's `chillTransform` actually saw. `[]` when the persona file had
  // none (missing, or no sample-lines section) — nothing to check against, never a blocked delivery.
  const sampleLines = result.sampleLines ?? [];

  // The `system` text THIS call actually sent, echoed back by `transform` itself (`ChillTransformResult.system`)
  // rather than re-resolved here — a second resolution would re-read the persona file off disk a
  // second time and could, in principle, land on a different answer than what was actually sent.
  // `undefined` when this call sent no `system` at all (missing persona file, empty override):
  // nothing to compare a bubble against for the prompt-text-echo check below.
  const systemPrompt = result.system;

  const echoScores: EchoScore[] = [];
  const promptLeakScores: PromptLeakScore[] = [];
  const personaLeakScores: PersonaLeakResult[] = [];
  const echoChecked: string[] = result.messages.map((bubble) => {
    // Prompt-scaffolding check first, on every bubble regardless of `input` — neither signal
    // needs the user's message, only the bubble's own shape and the prompt this call sent.
    let leak: PromptLeakScore = NO_PROMPT_LEAK;
    try {
      const shape = promptGuard(bubble);
      const textEcho = systemPrompt !== undefined && echoGuard(bubble, systemPrompt, text).echoed;
      leak = { leaked: shape.leaked || textEcho, signals: shape.signals, textEcho };
    } catch (err) {
      // Same fail-open contract as every guard here: a broken check must never block or drop a
      // bubble that chilltext already successfully produced.
      logger?.warn("prompt-scaffolding guard threw — keeping the rewritten bubble", { error: String(err) });
    }
    promptLeakScores.push(leak);
    if (leak.leaked) {
      // Fails fully closed — no partial repair for this class, unlike the input-echo edge case
      // below: prompt scaffolding is never worth salvaging part of a bubble around.
      logger?.warn("chilltext bubble echoed its own delivery instructions — falling back to the original text", {
        signals: leak.signals,
        promptTextEcho: leak.textEcho,
        bubble: truncateForLog(bubble),
      });
      // No echo-vs-input check on a bubble already discarded — keep echoScores/personaLeakScores
      // index-aligned with `result.messages` for the logTransform mapping below.
      echoScores.push(NOT_CHECKED);
      personaLeakScores.push(NO_PERSONA_LEAK);
      return text;
    }

    // Persona sample-line substitution check (2026-08-21 whole-bubble, 2026-08-24 opening-clause-
    // only) — also unconditional on `input`, and also fails fully closed: unlike the input-echo
    // check below, there is no partial repair for a bubble carrying fabricated persona text.
    let persona: PersonaLeakResult = NO_PERSONA_LEAK;
    try {
      persona = personaGuard(bubble, text, sampleLines);
    } catch (err) {
      logger?.warn("persona sample-line guard threw — keeping the rewritten bubble", { error: String(err) });
    }
    personaLeakScores.push(persona);
    if (persona.leaked) {
      logger?.warn(
        "chilltext bubble contains a persona sample line the agent never said — falling back to the original text",
        { matchedClause: persona.matchedClause, bubble: truncateForLog(bubble) },
      );
      echoScores.push(NOT_CHECKED);
      return text;
    }

    if (!input) {
      echoScores.push(NOT_CHECKED);
      return bubble;
    }
    try {
      const check = echoGuard(bubble, input, text);
      echoScores.push({
        echoed: check.echoed,
        contentScore: check.contentScore,
        fullScore: check.fullScore,
        repaired: check.repaired !== null,
      });
      if (!check.echoed) return bubble;
      if (check.repaired !== null) {
        logger?.warn("chilltext bubble echoed the user's own input at one edge — shipping the repaired remainder", {
          contentScore: check.contentScore,
          fullScore: check.fullScore,
          bubble: truncateForLog(bubble),
          input: truncateForLog(input),
        });
        return check.repaired;
      }
      logger?.warn("chilltext bubble echoed the user's own input back — falling back to the original text", {
        contentScore: check.contentScore,
        fullScore: check.fullScore,
        bubble: truncateForLog(bubble),
        input: truncateForLog(input),
      });
      return text;
    } catch (err) {
      // Mirrors the transform's own fail-open contract: a broken guard must never block or
      // drop a bubble that chilltext already successfully produced.
      logger?.warn("echo guard threw — keeping the rewritten bubble", { error: String(err) });
      echoScores.push(NOT_CHECKED);
      return bubble;
    }
  });

  // The chilltext rewrite has also, intermittently, mangled a `<@id>` ping into inert text (bare
  // `@id`, angle brackets stripped) — which renders as a raw number and notifies nobody, defeating
  // the whole point of `--ping`. `enforceMentions` structurally repairs every id in
  // `postOpts.pingUserIds` back to a real `<@id>` in the FIRST bubble (the only one the gateway
  // allow-lists), regardless of what the model returned. Runs AFTER the echo guard so it still
  // lands the ping correctly even when the first bubble was just replaced with the original text.
  const mentionRepaired = enforceMentions(echoChecked, postOpts?.pingUserIds ?? []);

  // The last guard: content substitution/injection (2026-08-21). Neither of the checks above
  // catches a bubble that just isn't a rewrite of anything in the reply at all — `input`-echo and
  // prompt-scaffolding are both checks against a DIFFERENT text, and a fabricated bubble can score
  // zero on both (the real incident did) while still not being caught. `single` forces exactly one
  // message for the caller (the early-ack seam) — never let a fallback split it into more.
  const blocks = single ? [text] : splitIntoBlocks(text);
  const reconciled = reconcileBubblesWithBlocks(blocks, mentionRepaired);
  for (const entry of reconciled) {
    if (entry.kind === "dropped" && entry.leadingClauseFail) {
      logger?.warn(
        "chilltext bubble's opening clause doesn't match the reply's opening clause — falling back to the original block",
        { leadingClauseScore: entry.leadingClauseScore, bubble: truncateForLog(entry.text) },
      );
    } else if (entry.kind === "dropped") {
      logger?.warn(
        "chilltext returned a surplus bubble unrelated to any block of the reply — dropping it, never posting fabricated content",
        { bubble: truncateForLog(entry.text) },
      );
    } else if (entry.kind === "block-fallback" && entry.rewritten === null) {
      logger?.warn("no chilltext bubble corresponded to this block of the reply — falling back to posting it verbatim", {
        block: truncateForLog(entry.text),
      });
    } else if (entry.kind === "block-fallback") {
      logger?.warn("chilltext bubble is unrelated to the block it was rewritten from — falling back to the original block", {
        fidelityScore: entry.fidelityScore,
        bubble: truncateForLog(entry.rewritten ?? ""),
        block: truncateForLog(entry.text),
      });
    }
  }
  const messages = reconciled.filter((e) => e.kind !== "dropped").map((e) => e.text);

  logTransform({
    outcome: "ok",
    durationMs: transformDurationMs,
    bubbles: reconciled.map((entry) => {
      const i = entry.sourceIndex;
      const echo = i !== null ? echoScores[i]! : NOT_CHECKED;
      const leak = i !== null ? promptLeakScores[i]! : NO_PROMPT_LEAK;
      const persona = i !== null ? personaLeakScores[i]! : NO_PERSONA_LEAK;
      return {
        // The RAW bubble chilltext returned, before the echo/prompt guards touched it — same
        // convention `rewritten` has always had here. `entry.rewritten` is the POST-guard text
        // (what the fidelity check actually scored), which can differ from this when an earlier
        // guard already repaired the bubble.
        rewritten: i !== null ? result.messages[i]! : null,
        posted: entry.kind === "dropped" ? null : entry.text,
        echoFallback: echo.echoed,
        echoContentScore: echo.contentScore,
        echoFullScore: echo.fullScore,
        ...(echo.repaired ? { echoRepaired: true } : {}),
        ...(leak.leaked ? { promptLeak: true, promptLeakSignals: leak.signals, promptTextEcho: leak.textEcho } : {}),
        ...(persona.leaked ? { personaLeak: true, personaLeakLine: persona.matchedClause } : {}),
        fidelityScore: entry.fidelityScore,
        ...(entry.kind === "block-fallback" ? { fidelityFallback: true } : {}),
        ...(entry.kind === "dropped" ? { fidelityDropped: true } : {}),
        ...(entry.leadingClauseFail ? { leadingClauseFallback: true, leadingClauseScore: entry.leadingClauseScore ?? null } : {}),
      };
    }),
  });

  let firstId: string | null = null;
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await sleep(cfg!.bubble_delay_ms);
    const bubble = messages[i]!;
    const bubbleOptsForPost: ReplyOptions = {
      ...(i === 0 ? postOpts : {}),
      singleMessage: true,
      ...bubbleOpts(undefined, opts.deliveryId, channelId, i),
    };
    const messageId = await gateway.post(channelId, bubble, bubbleOptsForPost);
    if (i === 0) firstId = messageId;
    recordPost?.(channelId, bubble, messageId);
  }
  return firstId!;
}
