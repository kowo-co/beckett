/**
 * Beckett — Observed-bot list, the living file (`src/discord/observed-bots.ts`)
 * =======================================================================================
 * The owner-managed half of the observed-bot primitive (`observed.ts`). `config.observed_bots.ids`
 * is a *baseline* set by whoever provisions the box (permanent, deploy-managed). THIS file —
 * `~/.beckett/observed-bots.txt` — is the **living** list the owner grows on the fly from Discord:
 * "@beckett add booper to what you can see" appends here and takes effect immediately, no restart.
 * The gateway reads the union of the two.
 *
 * Modeled deliberately on `peers.ts` (same newline-delimited-id-file shape, same read-fresh
 * pattern) but kept as its own file rather than reused: a bot on THIS list is not a peer and
 * must never be treated as one, and the two lists are owned by conceptually different doctrine
 * (who may talk to Beckett vs. what Beckett may read) even though the on-disk mechanics match.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A Discord bot user id is a snowflake: 17–20 digits. Reject anything else at the door. */
export const OBSERVED_BOT_ID_RE = /^\d{17,20}$/;

/** Is `id` a syntactically valid Discord user id? (Shape only — not "does this bot exist".) */
export function isValidObservedBotId(id: string): boolean {
  return OBSERVED_BOT_ID_RE.test(id.trim());
}

/**
 * Load the living observed-bot set from `observedBotsFile`. Newline-delimited ids; blank lines
 * and `#` comments ignored; malformed lines skipped (so a hand-edit typo can't poison the set).
 * Never throws — a missing or unreadable file is an empty set (nothing extra observed).
 */
export function loadObservedBots(observedBotsFile: string): Set<string> {
  const out = new Set<string>();
  try {
    if (!existsSync(observedBotsFile)) return out;
    for (const raw of readFileSync(observedBotsFile, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (isValidObservedBotId(line)) out.add(line);
    }
  } catch {
    // degrade to empty — a broken file must never take the gateway down
  }
  return out;
}

/** Atomic full-file write (temp + rename) so a crash mid-write can't truncate the list. */
function writeObservedBots(observedBotsFile: string, ids: Iterable<string>): void {
  mkdirSync(dirname(observedBotsFile), { recursive: true });
  const body =
    "# Beckett observed bots — bot ids Beckett may READ but never talk to (one per line).\n" +
    "# Owner-managed live from Discord (@beckett add/remove); no restart needed.\n" +
    [...ids].join("\n") +
    "\n";
  const tmp = `${observedBotsFile}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, observedBotsFile);
}

export interface ObservedBotMutation {
  ok: boolean;
  /** 'added' | 'already' | 'removed' | 'absent' | 'invalid' — the precise outcome. */
  status: "added" | "already" | "removed" | "absent" | "invalid";
  id: string;
  /** The full observed-bot set AFTER the mutation (for read-back / confirmation). */
  ids: string[];
}

/**
 * Add an observed-bot id to the living file. Idempotent (a re-add is `already`, still ok).
 * Rejects a malformed id as `invalid` (ok:false) rather than writing garbage the gateway would
 * ignore.
 */
export function addObservedBot(observedBotsFile: string, id: string): ObservedBotMutation {
  const clean = id.trim();
  if (!isValidObservedBotId(clean)) {
    return { ok: false, status: "invalid", id: clean, ids: [...loadObservedBots(observedBotsFile)] };
  }
  const ids = loadObservedBots(observedBotsFile);
  if (ids.has(clean)) return { ok: true, status: "already", id: clean, ids: [...ids] };
  ids.add(clean);
  writeObservedBots(observedBotsFile, ids);
  return { ok: true, status: "added", id: clean, ids: [...ids] };
}

/** Remove an observed-bot id. Removing one that isn't present is `absent` (still ok:true — no-op). */
export function removeObservedBot(observedBotsFile: string, id: string): ObservedBotMutation {
  const clean = id.trim();
  const ids = loadObservedBots(observedBotsFile);
  if (!ids.has(clean)) return { ok: true, status: "absent", id: clean, ids: [...ids] };
  ids.delete(clean);
  writeObservedBots(observedBotsFile, ids);
  return { ok: true, status: "removed", id: clean, ids: [...ids] };
}
