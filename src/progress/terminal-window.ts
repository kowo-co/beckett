/**
 * Beckett — the live-progress card's terminal window (`src/progress/terminal-window.ts`)
 * =======================================================================================
 * {@link renderTerminalWindow} is the whole feature: a pure, deterministic function that turns a
 * run's raw ticket-journal lines (`./journal.ts`'s exact wire shape — the same lines
 * `../run/activity.ts#deriveActivity` reads) into a fixed-height monospace pane for a Discord
 * Components V2 card. No model, no network, no fs — the caller (`./live-card.ts`) supplies the
 * lines, sourced off the SAME journal the activity blurb and `beckett journal --tail` already
 * read. There is no second capture path and no tmux.
 *
 * Two shaping decisions:
 *   - **Fixed window, not a scrollbar.** Discord has no scrollable component; "scrolling" here
 *     means each render keeps only the last {@link TERMINAL_WINDOW_LINES} lines and the EDIT
 *     replaces the whole pane, so watching the card update over time is what makes it scroll.
 *   - **Redact before truncate.** A secret split across the truncation boundary must still be
 *     caught, so {@link ../discord/redact.ts redactSecrets} runs on the full line before it is
 *     cut to {@link TERMINAL_LINE_MAX_CHARS}.
 */
import { redactSecrets } from "../discord/redact.ts";
import { STAMP_PREFIX } from "../run/activity.ts";

/**
 * Lines shown at once. Matches `../run/activity.ts#ACTIVITY_CONTEXT_LINES` — the same "enough to
 * see a rhythm, small enough nobody has to scroll Discord's own message view to read it" budget
 * that module already settled on for the same journal. At ~100 chars/line this renders as a
 * single-screen code block on both desktop and mobile Discord clients.
 */
export const TERMINAL_WINDOW_LINES = 15;

/** Long lines are cut, not wrapped — a wrapped `Bash` hint would blow the fixed height. */
export const TERMINAL_LINE_MAX_CHARS = 100;

/** Shown when a run has produced no journal-worthy activity yet. */
const EMPTY_WINDOW = "(no activity yet)";

/**
 * Render the fixed-height terminal window: redact, strip each line's leading ISO timestamp (the
 * card has its own relative-time stamp; repeating it 15x is noise), truncate to
 * {@link TERMINAL_LINE_MAX_CHARS}, keep only the last {@link TERMINAL_WINDOW_LINES}, and fence the
 * result as a code block so Discord renders it monospace.
 *
 * `rawLines` may be longer than the window (the caller can hand over a whole journal read) —
 * trimming to the visible window happens HERE, so this function alone is what "scroll" tests
 * exercise.
 */
export function renderTerminalWindow(rawLines: string[]): string {
  const cleaned = rawLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => redactSecrets(line.replace(STAMP_PREFIX, "")))
    .map((line) => truncateLine(line, TERMINAL_LINE_MAX_CHARS));
  const windowed = cleaned.slice(-TERMINAL_WINDOW_LINES);
  const body = windowed.length > 0 ? windowed.join("\n") : EMPTY_WINDOW;
  return `\`\`\`\n${body}\n\`\`\``;
}

function truncateLine(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
