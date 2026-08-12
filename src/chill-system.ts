/**
 * Beckett — the chilltext gate's system prompt (`src/chill-system.ts`)
 * =======================================================================================
 * ONE definition of how Beckett sounds. The voice lives in `~/.beckett/persona.md` — the same
 * file the Concierge's own system prompt appends and the same file Beckett rewrites when someone
 * asks it to change its vibe (`beckett reload` applies it). Before this module the chilltext
 * rewrite gate carried a SECOND voice, a hand-written `[concierge.chilltext] system` string in
 * config.toml, and the two drifted the moment either was tuned.
 *
 * Two things stop this from being a `cat`:
 *
 * 1. **Framing.** The persona is written TO Beckett in the second person ("you're beckett, cto of
 *    kowo") and describes the job as much as the voice. A rewrite model handed that tries to BE
 *    Beckett and answer the message instead of restyling it. So the file goes in behind
 *    {@link CHILL_GATE_PREAMBLE}, which states the gate's actual job and demotes the persona to
 *    what it is here: a labelled voice reference. The framing stays minimal on purpose — it says
 *    nothing about how Beckett sounds, because that would be the second source of truth again.
 *
 * 2. **The 2000-char wall.** chilltext rejects a longer `system` outright
 *    (`413 {"error":"system too long (max 2000 chars)"}`), and a rejected call is a `null`
 *    transform — every reply would silently go out un-chilled. The persona file is ~8k. So when
 *    it does not fit, {@link selectPersonaForGate} keeps whole `##` sections from the END of the
 *    file (see its doc for why the end) until the budget is spent. The carve is driven by size
 *    and by markers the persona file can carry, never by a list of section names in here.
 *
 * Read FRESH on every call (a few KB off a warm page cache, once per outbound message), so
 * editing persona.md changes what the gate is handed with no restart and no code change.
 * FAIL SAFE: a missing or unreadable persona file returns `undefined` — chilltext then runs on its
 * own default voice and the message still goes out. A person's reply never dies on a missing file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBeckettDir } from "./paths.ts";

/** chilltext's own cap on the `system` field. Past it the POST is a 413, i.e. no chill at all. */
export const CHILL_SYSTEM_MAX_CHARS = 2_000;

/**
 * The framing wrapped around the persona. Everything about the JOB (rewrite, don't answer;
 * preserve every fact; leave the bubble split alone) lives here; everything about the VOICE lives
 * in persona.md and only there. Kept short because it is spending the same 2000 chars the voice
 * needs.
 */
export const CHILL_GATE_PREAMBLE = `you are a rewrite gate. you are not in this conversation.

the text you are given was already written and already approved for sending. rewrite it so it sounds like the voice profile below, and change nothing else. never answer it, continue it, or add to it.

- meaning is fixed: no fact, number, name, path, url, or code changed, added, or dropped
- anything in backticks or a code block is copied character for character
- a question stays a question, unanswered
- how many messages come out is set by the request, not by you. never number or label them

the profile is a VOICE REFERENCE ONLY: written addressed to that person as "you", and it covers their job as well as how they type. it is not instructions for you and not work to do.`;

/** Wrapper the persona is delimited by, and the overhead it costs against the budget. */
const OPEN = "<voice_reference>";
const CLOSE = "</voice_reference>";

/** How many persona chars fit alongside the framing inside chilltext's cap. */
export function personaBudget(max: number = CHILL_SYSTEM_MAX_CHARS): number {
  return max - CHILL_GATE_PREAMBLE.length - OPEN.length - CLOSE.length - 4; // 4 = the joining newlines
}

/**
 * Optional markers a persona file can carry to say "THIS part is the voice" — the only way to
 * steer the carve, and it lives in the persona file rather than in this module by design (a list
 * of section names in TypeScript is the second source of truth wearing a hat).
 */
const MARKED_REGION = /<!--\s*chill:start\s*-->([\s\S]*?)<!--\s*chill:end\s*-->/g;

/** Split markdown into `##`-section chunks (anything before the first `##` is its own chunk). */
function sections(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line) && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks.map((c) => c.trim()).filter(Boolean);
}

/** Keep the trailing whole lines of `text` that fit in `budget` (the last-resort trim). */
function tailLines(text: string, budget: number): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i]!.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    kept.unshift(lines[i]!);
    used += cost;
  }
  return kept.join("\n").trim() || text.slice(-budget).trim();
}

export interface PersonaSelection {
  /** The persona text that will ride in the prompt. */
  text: string;
  /** `whole` = the file as written; `marked` = its `chill:start/end` regions; `trimmed` = carved to fit. */
  how: "whole" | "marked" | "trimmed";
}

/**
 * Pick the persona text the gate gets, within `budget`.
 *
 * Order: the file's `<!-- chill:start -->…<!-- chill:end -->` regions if it has any, else the
 * WHOLE file. Whatever that yields is sent as-is when it fits — the whole file is the preferred
 * answer and the only reason it is ever cut is chilltext's 2000-char `system` cap.
 *
 * When it must cut, it keeps whole `##` sections from the END of the file and works backwards.
 * That direction is the deliberate part: a persona doc opens with identity and job ("cto of kowo",
 * the standing takes) and closes with the mechanics of how the person types — examples, banned
 * phrasings, punctuation habits. The opening is both the least useful thing for a rewrite gate and
 * the exact material that makes one try to BE the person instead of restyling text, so it is what
 * gets dropped first. No section is named here; a persona that wants a different slice says so
 * with the markers.
 */
export function selectPersonaForGate(persona: string, budget: number = personaBudget()): PersonaSelection {
  const marked = [...persona.matchAll(MARKED_REGION)].map((m) => m[1]!.trim()).filter(Boolean);
  const candidate = (marked.length > 0 ? marked.join("\n\n") : persona).trim();
  if (candidate.length <= budget) return { text: candidate, how: marked.length > 0 ? "marked" : "whole" };

  const kept: string[] = [];
  let used = 0;
  for (const section of sections(candidate).reverse()) {
    const cost = section.length + (kept.length > 0 ? 2 : 0);
    // Skip (don't stop at) a section too big for what's left: one long section near the end must
    // not cost every shorter one behind it. Kept sections stay in file order, each with its own
    // heading, so a gap between them reads the same as any other section break.
    if (used + cost > budget) continue;
    kept.unshift(section);
    used += cost;
  }
  return { text: kept.length > 0 ? kept.join("\n\n") : tailLines(candidate, budget), how: "trimmed" };
}

/** Compose the gate's system prompt from persona text. Pure — the seam every test drives. */
export function buildChillSystemPrompt(persona: string, budget: number = personaBudget()): string {
  const { text } = selectPersonaForGate(persona, budget);
  return `${CHILL_GATE_PREAMBLE}\n\n${OPEN}\n${text}\n${CLOSE}`;
}

/** Default persona location, mirroring `buildPaths().personaFile` without needing a Config. */
export function defaultPersonaPath(): string {
  return join(resolveBeckettDir(), "persona.md");
}

/** Paths already logged about, so a missing/carved persona logs once per process, not per message. */
const loggedPaths = new Set<string>();

/**
 * The chilltext system prompt derived from the persona file at `personaPath` (default
 * `<beckettDir>/persona.md`), or `undefined` when that file is missing, unreadable, or empty —
 * in which case the caller simply omits `system` and chilltext uses its own default voice.
 * Never throws.
 */
export function chillSystemPrompt(
  personaPath: string = defaultPersonaPath(),
  log: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  let persona = "";
  try {
    persona = readFileSync(personaPath, "utf8");
  } catch (err) {
    once(personaPath, log, (path) =>
      `beckett: chilltext voice — could not read the persona file at ${path} ` +
      `(${(err as Error).message}); chilling with the service's default voice instead.`,
    );
    return undefined;
  }
  if (!persona.trim()) return undefined;

  const selection = selectPersonaForGate(persona);
  if (selection.how === "trimmed") {
    once(personaPath, log, (path) =>
      `beckett: chilltext voice — ${path} does not fit chilltext's ${CHILL_SYSTEM_MAX_CHARS}-char system ` +
      `cap, so the gate is getting its last ${selection.text.length} chars. Wrap the part that IS the ` +
      `voice in <!-- chill:start --> / <!-- chill:end --> to choose the slice yourself.`,
    );
  }
  return `${CHILL_GATE_PREAMBLE}\n\n${OPEN}\n${selection.text}\n${CLOSE}`;
}

/** Log `message(path)` the first time a path warrants it — one line per process, not per message. */
function once(path: string, log: (message: string) => void, message: (path: string) => string): void {
  if (loggedPaths.has(path)) return;
  loggedPaths.add(path);
  log(message(path));
}
