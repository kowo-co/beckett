/**
 * Beckett — Observed-bot gateway primitive (`src/discord/observed.ts`)
 * =======================================================================================
 * A second, WEAKER exemption to the same loop-guard `federation.ts` exempts trusted peers
 * from (`if (msg.author.bot) return`). Some bots Beckett sits alongside are not other
 * Becketts and never will be — the motivating case is booper, a small from-scratch language
 * model that posts its generations into channels Beckett is in. Beckett should be able to
 * READ what booper says (it shows up in channel context and `beckett channels recall`), the
 * same way it reads anyone else's messages, but booper must never be able to ADDRESS
 * Beckett, claim a turn, or trigger a reply on its own — it has no conversational standing,
 * only a seat in the room.
 *
 * That is the whole distinction from federation: a peer is trusted to talk (federation.ts
 * lets it reach the directed-reply path); an observed bot is trusted only to be listened to
 * (the gateway lets its message through to normalization/storage, and the Concierge forces
 * `mentionsBot` false for it and never files it under `role:peer`). Two different trust
 * levels, two different lists — `isObservedBot` never consults `federation.peers`, and
 * `isFederatedPeer` never consults `observed_bots.ids`. Ships inert: an empty allowlist
 * reproduces today's "ignore all bots" behavior byte-for-byte.
 */

/**
 * Should the gateway let this bot message through to normalization/storage as an observed bot?
 * True only when the author is *listed* AND is not us — the daemon's own id is rejected even if
 * a fork mistakenly lists it, for the identical reason `isFederatedPeer` rejects it: reading our
 * own posts back is the exact mirror-feedback loop the bot-filter exists to stop.
 *
 * @param authorId  Discord user id of the message author (a bot).
 * @param ownId     This daemon's own bot user id (from `ClientReady`), or undefined pre-ready.
 * @param observed  Allow-listed observed bot ids (config `observed_bots.ids`).
 */
export function isObservedBot(
  authorId: string,
  ownId: string | undefined,
  observed: ReadonlySet<string>,
): boolean {
  if (ownId !== undefined && authorId === ownId) return false; // never read our own posts back
  return observed.has(authorId);
}
