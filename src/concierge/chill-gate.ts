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
 */

import type { Config, DiscordGateway, Logger, ReplyOptions } from "../types.ts";
import { chillTransform, shouldBypassChill, type ChillTransformResult } from "../chilltext.ts";
import { enforceMentions } from "../discord/mentions.ts";

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

  if (shouldBypassChill(text, cfg)) {
    const messageId = await gateway.post(channelId, text, postOpts);
    recordPost?.(channelId, text, messageId);
    return messageId;
  }

  let result: ChillTransformResult | null = null;
  try {
    result = await transform(cfg!, { input, agentOutput: text, single, personaPath: opts.personaPath });
  } catch (err) {
    // chillTransform is documented to never throw, but a test double or a future caller might —
    // this is the fail-open backstop that keeps a delivery gate from ever losing a reply to it.
    logger?.warn("chilltext transform threw — falling back to the original text", { error: String(err) });
    result = null;
  }

  if (!result) {
    const messageId = await gateway.post(channelId, text, postOpts);
    recordPost?.(channelId, text, messageId);
    return messageId;
  }

  // The chilltext rewrite is a lossy LLM pass that has, intermittently, mangled a `<@id>` ping
  // into inert text (bare `@id`, angle brackets stripped) — which renders as a raw number and
  // notifies nobody, defeating the whole point of `--ping`. `enforceMentions` structurally repairs
  // every id in `postOpts.pingUserIds` back to a real `<@id>` in the FIRST bubble (the only one the
  // gateway allow-lists), regardless of what the model returned. Belt-and-braces to any prompt ask.
  const messages = enforceMentions(result.messages, postOpts?.pingUserIds ?? []);

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
