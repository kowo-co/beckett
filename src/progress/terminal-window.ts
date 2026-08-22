/**
 * Beckett — the training progress card's terminal window (`src/progress/terminal-window.ts`)
 * =======================================================================================
 * {@link renderTerminalWindow} is the whole feature: a pure, deterministic function that turns
 * raw log lines into a fixed-height monospace pane for a Discord Components V2 card. No model,
 * no network, no fs — the caller (`./training-card.ts`) supplies the lines.
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

/** Leading ISO stamp on journal-shaped lines — stripped so the pane isn't 15 clocks. */
const STAMP_PREFIX = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/;

/**
 * Lines shown at once. Small enough nobody has to scroll Discord's own message view to read it.
 * At ~100 chars/line this renders as a single-screen code block on both desktop and mobile Discord clients.
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
