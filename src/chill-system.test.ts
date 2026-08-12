/**
 * The chilltext gate's system prompt (`src/chill-system.ts`) — the persona file IS the voice, the
 * framing is what keeps the gate from answering the message, and a missing persona degrades to
 * "chilltext's own default voice" instead of taking the send path down with it.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILL_GATE_PREAMBLE, buildChillSystemPrompt, chillSystemPrompt, defaultPersonaPath } from "./chill-system.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-chill-system-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the persona file's content becomes the system prompt", () => {
  const path = join(tmp(), "persona.md");
  writeFileSync(path, "# persona: beckett\n\nall lowercase. no exclamation marks. no emoji\n");
  const prompt = chillSystemPrompt(path);
  expect(prompt).toContain("all lowercase. no exclamation marks. no emoji");
  expect(prompt).toContain("# persona: beckett"); // the WHOLE file, not a carved-out slice
});

test("the persona is framed as a voice reference, not as instructions to follow", () => {
  const path = join(tmp(), "persona.md");
  writeFileSync(path, "you're beckett, cto of kowo. ship code, review prs");
  const prompt = chillSystemPrompt(path)!;
  // The framing comes FIRST, so "you're beckett, cto of kowo" is read as the voice being copied
  // rather than a job to take on — the whole reason this is not a naive cat of the file.
  expect(prompt.startsWith(CHILL_GATE_PREAMBLE)).toBe(true);
  expect(prompt).toContain("you are a rewrite gate");
  expect(prompt).toContain("VOICE REFERENCE ONLY");
  expect(prompt.indexOf("cto of kowo")).toBeGreaterThan(prompt.indexOf(CHILL_GATE_PREAMBLE));
});

test("the framing states the preserve-everything contract the gate exists to keep", () => {
  const preamble = CHILL_GATE_PREAMBLE.toLowerCase();
  expect(preamble).toContain("the meaning is fixed");
  expect(preamble).toContain("urls");
  expect(preamble).toContain("code block");
  // Message splitting stays chilltext's call (max_bubbles / single), never the prompt's.
  expect(preamble).toContain("how many messages come out is decided by the request settings");
});

test("the framing itself defines no voice — persona.md is the only source of that", () => {
  // If a voice rule ever leaks into the preamble it becomes the second source of truth this
  // module exists to delete. These are the persona's rules; none of them belong here.
  for (const voiceRule of ["lowercase", "emoji", "em-dash", "em dash", "slang", "swear"]) {
    expect(CHILL_GATE_PREAMBLE.toLowerCase()).not.toContain(voiceRule);
  }
});

test("a missing persona file returns undefined, logs once, and never throws", () => {
  const missing = join(tmp(), "not-there.md");
  const warnings: string[] = [];
  expect(chillSystemPrompt(missing, (m) => warnings.push(m))).toBeUndefined();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain(missing);
  // Once per path per process: a missing file must not print a line per outbound message.
  expect(chillSystemPrompt(missing, (m) => warnings.push(m))).toBeUndefined();
  expect(warnings.length).toBe(1);
});

test("an unreadable persona (a directory) returns undefined rather than throwing", () => {
  const dir = tmp();
  expect(chillSystemPrompt(dir, () => {})).toBeUndefined();
});

test("an empty persona file is 'no voice', not an empty prompt", () => {
  const path = join(tmp(), "persona.md");
  writeFileSync(path, "   \n\n");
  expect(chillSystemPrompt(path)).toBeUndefined();
});

test("buildChillSystemPrompt trims the persona and delimits it", () => {
  const prompt = buildChillSystemPrompt("\n\nvoice here\n\n");
  expect(prompt).toBe(`${CHILL_GATE_PREAMBLE}\n\n<voice_reference>\nvoice here\n</voice_reference>`);
});

test("the default persona path is the one the daemon's paths resolve to", () => {
  expect(defaultPersonaPath().endsWith("/persona.md")).toBe(true);
});
