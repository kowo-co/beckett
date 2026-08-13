/**
 * Discord `--ping` target resolution + mention rendering (issue #10)
 * =======================================================================================
 * The one shared place `--ping <target>` gets turned into a real, notifying Discord mention.
 * Every CLI surface that accepts `--ping` (discord reply/ack, task create/start, …) resolves
 * through {@link resolvePingTargets} once at send time, then renders with {@link renderMentions}.
 * Kept out of each call site because the resolution rules (id / `<@id>` / identity-map name) and
 * the render rules (dedupe, order-preserving, skip-if-already-in-body) must behave identically
 * everywhere a ping shows up, not just wherever they were implemented first.
 */

import { loadIdentities } from "./identity.ts";

const SNOWFLAKE = /^\d{1,20}$/;
const MENTION_BLOB = /^<@!?(\d{1,20})>$/;

/**
 * Resolve `--ping` targets to Discord user ids, in first-seen order, deduped. Accepts (in order
 * of preference) a raw snowflake, an already-wrapped `<@id>`/`<@!id>` blob, or a name known to the
 * identity map (`known_name` / `preferred_address` / `display_name`, case-insensitive).
 *
 * Throws — rather than dropping the target or sending a broken `<@name>` into the channel — when
 * any target resolves to nothing, naming every unresolved target and every name on file so the
 * caller can fix a typo immediately.
 */
export function resolvePingTargets(targets: string[], identitiesFile: string): string[] {
  const map = loadIdentities(identitiesFile);
  const byName = new Map<string, string>();
  for (const [id, identity] of Object.entries(map)) {
    for (const name of [identity.known_name, identity.preferred_address, identity.display_name]) {
      if (name) byName.set(name.toLowerCase(), id);
    }
  }

  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const target = raw.trim();
    const wrapped = target.match(MENTION_BLOB)?.[1];
    const id = wrapped ?? (SNOWFLAKE.test(target) ? target : byName.get(target.toLowerCase()));
    if (!id) {
      unresolved.push(raw);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    resolved.push(id);
  }

  if (unresolved.length > 0) {
    const known = [...new Set(byName.keys())].sort();
    throw new Error(
      `unknown --ping target${unresolved.length > 1 ? "s" : ""}: ${unresolved.join(", ")}` +
        (known.length > 0 ? ` — known names: ${known.join(", ")}` : " — no names are known yet"),
    );
  }
  return resolved;
}

/**
 * Prepend resolved mentions to outgoing message content: one space-joined line of `<@id>`
 * mentions (deduped, order-preserving), a newline, then the body unchanged. A mention already
 * present verbatim in the body is not added a second time. Returns `body` unchanged when there is
 * nothing left to add.
 */
export function renderMentions(body: string, userIds: string[]): string {
  const seen = new Set<string>();
  const line: string[] = [];
  for (const id of userIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const mention = `<@${id}>`;
    if (body.includes(mention)) continue;
    line.push(mention);
  }
  if (line.length === 0) return body;
  return `${line.join(" ")}\n${body}`;
}

/**
 * Match every form a single mention id can take on its way through a lossy text rewrite — the
 * valid `<@id>` / `<@!id>`, and the mangled shapes the chilltext LLM has actually produced:
 * a bare `@id` (angle brackets stripped — inert plain text that notifies nobody), a spaced
 * `< @id >`, and a backticked `` `<@id>` ``. The id is an exact digit run, so `(?![0-9])` keeps
 * a ping for `123` from matching inside `1234`. Used only to DELETE these before a clean copy is
 * re-inserted; never to notify off of what the model returned.
 */
function mentionStripRe(id: string): RegExp {
  // Anchored at the `@`/`<`, not on leading whitespace: consuming the space on BOTH sides would
  // fuse the words a mention sat between ("hey @id there" -> "heythere"). Trailing whitespace is
  // eaten so a stripped mention leaves at most one space, which the caller's tidy pass collapses.
  return new RegExp("`?<?[ \\t]*@[ \\t]*!?[ \\t]*" + id + "(?![0-9])[ \\t]*>?[ \\t]*`?", "g");
}

/**
 * Structurally guarantee that every id in `pingUserIds` survives the chilltext gate as a real,
 * notifying `<@id>` — regardless of what the rewrite model returned. This is enforcement, not
 * persuasion: the model's output is never trusted to have kept the mention intact.
 *
 * For each ping id we strip EVERY form of it (valid or mangled — see {@link mentionStripRe}) out
 * of every bubble, then prepend one clean, deduped, order-preserving `<@id>` line to the first
 * surviving bubble. That makes three things true at once, which is exactly what `--ping` promises:
 *   - a bare `@id` / `< @id >` / backticked / dropped mention is repaired back to `<@id>`;
 *   - the mention lands in exactly ONE posted bubble, never duplicated across bubbles;
 *   - it lands in the FIRST bubble — the only one the gateway allow-lists for `allowed_mentions`,
 *     so it actually pings instead of merely rendering.
 *
 * Bubbles with no ping ids are returned untouched: this only ever moves mention tokens, never the
 * surrounding prose the voice gate produced.
 */
export function enforceMentions(bubbles: string[], pingUserIds: string[]): string[] {
  const ids = [...new Set(pingUserIds.map((s) => s.trim()).filter((s) => SNOWFLAKE.test(s)))];
  if (ids.length === 0) return bubbles;

  const stripped = bubbles.map((bubble) => {
    let out = bubble;
    let changed = false;
    for (const id of ids) {
      out = out.replace(mentionStripRe(id), () => {
        changed = true;
        return "";
      });
    }
    if (!changed) return bubble;
    // Tidy only the seams a removed mention left behind — collapse the doubled space left where
    // an inline mention was, drop trailing spaces and the blank line a removed mention line
    // leaves, and trim. Ordinary prose in bubbles we did not touch is returned verbatim above.
    return out
      .replace(/[ \t]{2,}/g, " ")
      .replace(/ *\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  });

  const kept = stripped.filter((bubble) => bubble.length > 0);
  const line = ids.map((id) => `<@${id}>`).join(" ");
  if (kept.length === 0) return [line];
  kept[0] = `${line}\n${kept[0]}`;
  return kept;
}
