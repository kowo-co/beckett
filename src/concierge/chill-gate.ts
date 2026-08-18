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
 * Two structural guards run on the rewritten bubbles before they post, neither trusting the
 * rewrite model to have honored its contract:
 *
 *   - `enforceMentions` (`src/discord/mentions.ts`) repairs a `<@id>` ping the rewrite mangled
 *     into inert text.
 *   - `detectEchoedInput` (`./echo-guard.ts`) catches the OTHER way the rewrite has drifted: on
 *     2026-08-18 it handed the user's own triggering message back as Beckett's reply, pronouns
 *     inverted ("you're the CTO" — backwards). Run PER BUBBLE, because only one bubble in a
 *     multi-bubble delivery drifted that time; a tripped bubble falls back to the un-chilled
 *     `text` this call was asked to restyle, same fail-open shape as everything else here.
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
import { detectEchoedInput } from "./echo-guard.ts";
import { appendChillTransformLog, type ChillTransformLogRecord } from "./chilltext-log.ts";

/** How much of a bubble/input to keep in a trip's warning log — enough to diagnose, not a full dump. */
const LOG_SNIPPET_CHARS = 200;

function truncateForLog(text: string): string {
  return text.length > LOG_SNIPPET_CHARS ? `${text.slice(0, LOG_SNIPPET_CHARS)}…` : text;
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
  /** Test seam: inject a fake echo guard instead of `detectEchoedInput`. */
  echoGuard?: typeof detectEchoedInput;
  /**
   * Path to the chilltext transform transcript (`./chilltext-log.ts`). Opt-in, same shape as
   * `recordPost`: when omitted, nothing is logged and nothing on disk is touched — real call sites
   * pass `buildPaths(config).chilltextLog`. A write failure here never blocks or drops a delivery.
   */
  logPath?: string;
}

const defaultSleep = (ms: number): Promise<void> => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

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
    const messageId = await gateway.post(channelId, text, postOpts);
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
    const messageId = await gateway.post(channelId, text, postOpts);
    recordPost?.(channelId, text, messageId);
    logTransform({ outcome: threw ? "threw" : "fallback", durationMs: transformDurationMs, bubbles: null });
    return messageId;
  }

  // The chilltext rewrite is a lossy LLM pass that has, on at least one real delivery, handed the
  // user's own triggering message back as Beckett's reply (pronouns inverted). Score each bubble
  // against `input` and fall back to the un-chilled `text` for just the bubble that drifted — the
  // other bubbles in the same delivery are very likely fine and should post exactly as rewritten.
  type EchoScore = { echoed: boolean; contentScore: number | null; fullScore: number | null };
  const NOT_CHECKED: EchoScore = { echoed: false, contentScore: null, fullScore: null };
  let echoScores: EchoScore[];
  let echoChecked: string[];
  if (input) {
    echoScores = [];
    echoChecked = result.messages.map((bubble) => {
      try {
        const check = echoGuard(bubble, input);
        echoScores.push({ echoed: check.echoed, contentScore: check.contentScore, fullScore: check.fullScore });
        if (!check.echoed) return bubble;
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
  } else {
    echoScores = result.messages.map(() => NOT_CHECKED);
    echoChecked = result.messages;
  }

  // The chilltext rewrite has also, intermittently, mangled a `<@id>` ping into inert text (bare
  // `@id`, angle brackets stripped) — which renders as a raw number and notifies nobody, defeating
  // the whole point of `--ping`. `enforceMentions` structurally repairs every id in
  // `postOpts.pingUserIds` back to a real `<@id>` in the FIRST bubble (the only one the gateway
  // allow-lists), regardless of what the model returned. Runs AFTER the echo guard so it still
  // lands the ping correctly even when the first bubble was just replaced with the original text.
  const messages = enforceMentions(echoChecked, postOpts?.pingUserIds ?? []);

  logTransform({
    outcome: "ok",
    durationMs: transformDurationMs,
    bubbles: result.messages.map((rewritten, i) => ({
      rewritten,
      posted: messages[i]!,
      echoFallback: echoScores[i]!.echoed,
      echoContentScore: echoScores[i]!.contentScore,
      echoFullScore: echoScores[i]!.fullScore,
    })),
  });

  let firstId: string | null = null;
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await sleep(cfg!.bubble_delay_ms);
    const bubble = messages[i]!;
    const bubbleOpts: ReplyOptions = { ...(i === 0 ? postOpts : {}), singleMessage: true };
    const messageId = await gateway.post(channelId, bubble, bubbleOpts);
    if (i === 0) firstId = messageId;
    recordPost?.(channelId, bubble, messageId);
  }
  return firstId!;
}
