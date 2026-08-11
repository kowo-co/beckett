/**
 * Beckett — inbound embed settle (`src/discord/embed-settle.ts`)
 * =======================================================================================
 * Discord delivers a message with a bare URL BEFORE it has unfurled that URL: MESSAGE_CREATE
 * carries no embed, and the preview arrives moments later as a MESSAGE_UPDATE Beckett does not
 * act on. The turn therefore saw a naked link and improvised "nothing came through on my end"
 * (issue #235).
 *
 * The fix lives here rather than in the Concierge because it is smaller here: `normalize` is the
 * single choke point every inbound message already passes through, so ONE await in front of it
 * delays exactly the link-bearing messages and nothing else. No config knob — a fixed, short
 * constant, applied only when all three conditions hold (a bare URL, no embed yet, and a message
 * young enough for an embed to still be in flight).
 */

/** How long to wait for Discord to attach a link preview. Deliberately config-free (issue #235). */
export const EMBED_SETTLE_MS = 2_000;

/**
 * Past this age an absent embed is a FACT, not a race: Discord unfurls within a second or two, and
 * downtime reconciliation re-normalizes hours-old messages through the same path. Without this the
 * catch-up after a long outage would sleep two seconds per link it replays.
 */
export const EMBED_SETTLE_MAX_AGE_MS = 30_000;

/** The shape settling needs — satisfied by discord.js `Message` and by hand-built test doubles. */
export interface SettleableMessage {
  content?: string;
  embeds?: readonly unknown[];
  createdTimestamp?: number;
  fetch?: (force?: boolean) => Promise<unknown>;
}

const defaultSleep = (ms: number): Promise<void> => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

/**
 * Does this text carry a URL Discord would unfurl? Code spans are stripped first (a link inside
 * a fence is sample text, not a link the author is sharing), and `<https://…>` is excluded because
 * the angle brackets are Discord's own "do not embed this" syntax — waiting on a preview that is
 * suppressed by construction would be two seconds spent for nothing.
 */
export function hasBareUrl(content: string | undefined): boolean {
  if (!content) return false;
  const withoutCode = content.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  for (const match of withoutCode.matchAll(/https?:\/\/[^\s<>]+/g)) {
    const before = withoutCode[match.index - 1];
    if (before !== "<") return true;
  }
  return false;
}

/**
 * Give an unfurl-in-flight a brief moment to land, then re-read the message. Returns the message
 * to normalize FROM — the re-fetched copy when one was obtained, the original otherwise. Never
 * throws: a deleted or unfetchable message degrades to the copy already in hand, which is exactly
 * the pre-issue-235 behavior.
 */
export async function settleEmbeds<M extends SettleableMessage>(
  msg: M,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    waitMs?: number;
    maxAgeMs?: number;
    now?: () => number;
  } = {},
): Promise<M> {
  if (msg.embeds && msg.embeds.length > 0) return msg;
  if (!hasBareUrl(msg.content)) return msg;
  if (typeof msg.fetch !== "function") return msg;
  const now = opts.now ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? EMBED_SETTLE_MAX_AGE_MS;
  if (typeof msg.createdTimestamp === "number" && now() - msg.createdTimestamp > maxAgeMs) return msg;
  await (opts.sleep ?? defaultSleep)(opts.waitMs ?? EMBED_SETTLE_MS);
  try {
    const refetched = await msg.fetch(true);
    return (refetched ?? msg) as M;
  } catch {
    return msg;
  }
}
