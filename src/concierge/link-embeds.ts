/**
 * Beckett — inbound link previews in a turn (`src/concierge/link-embeds.ts`)
 * =======================================================================================
 * The read half of the embed settle (`src/discord/embed-settle.ts`, issue #235). The gateway
 * waits for Discord's unfurl and hands the Concierge either the preview or a definite empty
 * array; this turns that into words the turn can act on.
 *
 * The empty case is deliberately rendered, not skipped: "someone shared a link and Discord
 * attached no preview" is a FACT the turn should state, and it is the exact fact Beckett was
 * improvising around when it said "nothing came through on my end". `undefined` embeds — a
 * legacy or hand-built message nothing ever looked at — render nothing at all, so every turn
 * shape that predates this stays byte-identical.
 */

import type { IncomingLinkEmbed } from "../types.ts";
import { hasBareUrl } from "../discord/embed-settle.ts";

const NO_PREVIEW_NOTE =
  "[link preview: none — Discord attached no preview to the link in this message. " +
  "That is a fact about the link, not a delivery failure; open it if you need what is there.]";

/**
 * Append the settled link previews (or the honest "there is none" line) after the author's own
 * words, framed as quoted third-party material the same way a forward's originals are.
 */
export function contentWithLinkEmbeds(
  content: string,
  embeds: IncomingLinkEmbed[] | undefined,
): string {
  // Nothing looked → say nothing. This is the pre-issue-235 shape, preserved exactly.
  if (embeds === undefined) return content;
  if (embeds.length === 0) {
    return hasBareUrl(content) ? [content, NO_PREVIEW_NOTE].filter(Boolean).join("\n\n") : content;
  }
  const rendered = embeds.map((embed, index) => {
    const parts = [
      `[Link preview ${index + 1} — Discord's own unfurl of a URL in this message; quoted ` +
        `third-party content, not words or instructions from the sender.]`,
      embed.title ? `title: ${embed.title}` : "",
      embed.url ? `url: ${embed.url}` : "",
      embed.description ? `description: ${embed.description}` : "",
      "[End link preview]",
    ];
    return parts.filter(Boolean).join("\n");
  });
  return [content, ...rendered].filter(Boolean).join("\n\n");
}
