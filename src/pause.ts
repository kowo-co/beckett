/**
 * Beckett — the chat-only pause (`src/pause.ts`)
 * =======================================================================================
 * The operational hold: chat stays on, outward work stops. A `pause.json` file next to the
 * socket — not a config key — because the brake must be (a) instant, (b) readable by both the
 * long-lived daemon and short-lived CLI subprocesses without a reload, (c) survivable across a
 * restart, and (d) removable by hand without editing a boot-validated, strict-zod config. Config
 * is parsed once at boot (`src/config.ts`); this file is read fresh on every check.
 *
 * EXISTENCE of `pause.json` IS the flag. Its contents are detail, never the source of truth — a
 * garbled file (partial write, hand-edited garbage) still reads as PAUSED, because a corrupt
 * brake failing "on" is safe and a corrupt brake silently failing "off" is not.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The operational hold: chat stays on, outward work stops. Existence of the file IS the flag. */
export interface PauseState {
  /** ISO8601 when the hold was taken. */
  pausedAt: string;
  /** The one honest sentence Beckett repeats. Null when nobody gave one. */
  reason: string | null;
  /** Who took the hold, when the caller knows (a Discord user id or a shell username). */
  by: string | null;
}

/** Absolute path of the hold file — `<beckettDir>/pause.json` (also `Paths.pauseFile`). */
export function pauseFilePath(beckettDir: string): string {
  return join(beckettDir, "pause.json");
}

/**
 * Read the hold. Absent file → null (not paused). Present but corrupt/unparseable → a hold with
 * `pausedAt` from the file's mtime and a null reason: EXISTENCE is the flag, contents are only
 * detail, so a garbled brake is never silently treated as "off".
 */
export function readPause(file: string): PauseState | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<PauseState>;
    return {
      pausedAt: typeof parsed.pausedAt === "string" ? parsed.pausedAt : statSync(file).mtime.toISOString(),
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      by: typeof parsed.by === "string" ? parsed.by : null,
    };
  } catch {
    return { pausedAt: statSync(file).mtime.toISOString(), reason: null, by: null };
  }
}

/** Take the hold (idempotent: re-pausing rewrites the reason, keeps the original `pausedAt`). */
export function writePause(file: string, state: PauseState): PauseState {
  const existing = readPause(file);
  const merged: PauseState = { ...state, pausedAt: existing?.pausedAt ?? state.pausedAt };
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

/** Lift the hold. Returns true when a hold was actually removed. */
export function clearPause(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
  } catch {
    return false;
  }
  return true;
}

/** The one-sentence refusal a CLI surface prints on stderr. Always starts `paused:`. */
export function pauseRefusal(state: PauseState, action: string): string {
  return (
    `paused: beckett is on hold (chat only) since ${state.pausedAt} — refusing to ${action}. ` +
    `reason: ${state.reason ?? "none given"}. lift it with \`beckett resume\`.`
  );
}

/** The SYSTEM note prepended to every concierge turn while the hold is on. */
export function pauseTurnNote(state: PauseState): string {
  return (
    `[SYSTEM: YOU ARE PAUSED (chat only) since ${state.pausedAt}. Reason: ${state.reason ?? "none given"}.\n` +
    `You can talk, recall, read files, search, and answer questions — do all of that normally.\n` +
    `You cannot deploy runs, quick agents, or browser tasks: those commands will refuse, and the\n` +
    `supervisor will not staff anything new. If someone asks for work, say so in ONE honest line\n` +
    `(paused, what it would take to lift it: \`beckett resume\`) and do not promise to start.]`
  );
}
