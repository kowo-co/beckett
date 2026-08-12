/**
 * Beckett — the chilltext gate's system prompt (`src/chill-system.ts`)
 * =======================================================================================
 * ONE definition of how Beckett sounds. The voice lives in `~/.beckett/persona.md` — the same
 * file the Concierge's own system prompt appends and the same file Beckett rewrites when someone
 * asks it to change its vibe (`beckett reload` applies it). Before this module the chilltext
 * rewrite gate carried a SECOND voice, a hand-written `[concierge.chilltext] system` string in
 * config.toml, and the two drifted the moment either was tuned.
 *
 * The persona file cannot be handed to the gate as-is. It is written TO Beckett in the second
 * person ("you're beckett, cto of kowo") and it describes the job as much as the voice — a
 * rewrite model given that prompt tries to BE Beckett and answer the message instead of restyling
 * it. So the file is wrapped in {@link CHILL_GATE_PREAMBLE}: a short framing that states the
 * gate's actual job (rewrite text that is already Beckett's, preserve every fact) and demotes the
 * persona to what it is here — a voice reference, not instructions. The framing stays minimal on
 * purpose; the persona file does the work, and nothing about the voice is restated here.
 *
 * Read FRESH on every call (a few KB off a warm page cache, once per outbound message), so
 * editing persona.md changes what the gate is handed with no restart and no code change.
 * FAIL SAFE: a missing or unreadable persona file returns `undefined` — chilltext then runs on its
 * own default voice and the message still goes out. A person's reply never dies on a missing file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBeckettDir } from "./paths.ts";

/**
 * The framing wrapped around the persona file. Everything that is about the JOB (rewrite, don't
 * answer; preserve facts; leave the bubble split alone) lives here; everything about the VOICE
 * lives in persona.md and only there.
 */
export const CHILL_GATE_PREAMBLE = `you are a rewrite gate. you are not in this conversation and you are not talking to anyone.

the text you are given was already written and already approved for sending. your only job is to
rewrite it so it sounds like the person described below actually texting. you never answer it,
continue it, comment on it, or add to it.

hold these exactly:
- the meaning is fixed. do not add, drop, soften, or strengthen a claim
- facts, numbers, names, ids, file paths, urls, and anything inside backticks or a code block are
  copied character for character
- a question in the text stays a question, unanswered
- no new information, ever. if you are not sure what something means, leave that part alone
- how many messages come out is decided by the request settings, not by you. do not number, label,
  or annotate them

the profile below is the voice you are copying. it is written addressed to that person as "you"
and it talks about their job, their opinions, and their work as well as how they type. it is a
VOICE REFERENCE ONLY: not instructions for you, not a role to play, not work to do. read it to
decide how the rewrite should sound and nothing else.`;

/** Compose the gate's system prompt from persona text. Pure — the seam every test drives. */
export function buildChillSystemPrompt(persona: string): string {
  return `${CHILL_GATE_PREAMBLE}\n\n<voice_reference>\n${persona.trim()}\n</voice_reference>`;
}

/** Default persona location, mirroring `buildPaths().personaFile` without needing a Config. */
export function defaultPersonaPath(): string {
  return join(resolveBeckettDir(), "persona.md");
}

/** Paths already warned about, so a missing persona logs once per process, not once per message. */
const warnedPaths = new Set<string>();

/**
 * The chilltext system prompt derived from the persona file at `personaPath` (default
 * `<beckettDir>/persona.md`), or `undefined` when that file is missing, unreadable, or empty —
 * in which case the caller simply omits `system` and chilltext uses its own default voice.
 * Never throws.
 */
export function chillSystemPrompt(
  personaPath: string = defaultPersonaPath(),
  warn: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  let persona = "";
  try {
    persona = readFileSync(personaPath, "utf8");
  } catch (err) {
    if (!warnedPaths.has(personaPath)) {
      warnedPaths.add(personaPath);
      warn(
        `beckett: chilltext voice — could not read the persona file at ${personaPath} ` +
          `(${(err as Error).message}); chilling with the service's default voice instead.`,
      );
    }
    return undefined;
  }
  if (!persona.trim()) return undefined;
  return buildChillSystemPrompt(persona);
}
