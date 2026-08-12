/**
 * The chilltext gate's system prompt (`src/chill-system.ts`) — the persona file IS the voice, the
 * framing is what keeps the gate from answering the message, the carve is what keeps the prompt
 * under chilltext's 2000-char `system` cap (past it the POST is a 413 and nothing gets chilled at
 * all), and a missing persona degrades instead of taking the send path down with it.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHILL_GATE_PREAMBLE,
  CHILL_SYSTEM_MAX_CHARS,
  buildChillSystemPrompt,
  chillSystemPrompt,
  defaultPersonaPath,
  personaBudget,
  selectPersonaForGate,
} from "./chill-system.ts";
import { DEFAULT_PERSONA } from "./concierge/index.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-chill-system-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A persona of `n` `##` sections, each ~`chars` long, so budget behavior is exact. */
function persona(n: number, chars: number): string {
  return Array.from({ length: n }, (_, i) => `## section ${i}\n\n${"x".repeat(chars)}`).join("\n\n");
}

test("the persona file's content becomes the system prompt", () => {
  const path = join(tmp(), "persona.md");
  writeFileSync(path, "# persona: beckett\n\nall lowercase. no exclamation marks. no emoji\n");
  const prompt = chillSystemPrompt(path);
  expect(prompt).toContain("all lowercase. no exclamation marks. no emoji");
  expect(prompt).toContain("# persona: beckett"); // it fits, so the WHOLE file goes in
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
  expect(preamble).toContain("meaning is fixed");
  expect(preamble).toContain("url");
  expect(preamble).toContain("code block");
  // Message splitting stays chilltext's call (max_bubbles / single), never the prompt's.
  expect(preamble).toContain("how many messages come out is set by the request");
});

test("the framing itself defines no voice — persona.md is the only source of that", () => {
  // If a voice rule ever leaks into the preamble it becomes the second source of truth this
  // module exists to delete. These are the persona's rules; none of them belong here.
  for (const voiceRule of ["lowercase", "emoji", "em-dash", "em dash", "slang", "swear"]) {
    expect(CHILL_GATE_PREAMBLE.toLowerCase()).not.toContain(voiceRule);
  }
});

test("a persona that fits goes in whole — a carve is only ever forced by the cap", () => {
  const whole = persona(3, 100);
  expect(selectPersonaForGate(whole)).toEqual({ text: whole, how: "whole" });
});

test("an oversize persona is carved from its END, in whole sections, under budget", () => {
  const budget = 500;
  const selection = selectPersonaForGate(persona(6, 200), budget);
  expect(selection.how).toBe("trimmed");
  expect(selection.text.length).toBeLessThanOrEqual(budget);
  // The tail survives; the top of the file (identity/job material) is what gets dropped.
  expect(selection.text).toContain("## section 5");
  expect(selection.text).toContain("## section 4");
  expect(selection.text).not.toContain("## section 0");
  // Whole sections only — never a sentence cut in half.
  expect(selection.text.startsWith("## section 4")).toBe(true);
});

test("chill:start / chill:end markers in the file choose the slice, beating the size rule", () => {
  const marked = `# persona: beckett\n\n## who this is\n\ncto of kowo, ships code\n\n<!-- chill:start -->\n## how beckett types\n\nall lowercase, no trailing period\n<!-- chill:end -->\n\n## sample lines\n\n> yeah that's broken\n`;
  const selection = selectPersonaForGate(marked);
  expect(selection.how).toBe("marked");
  expect(selection.text).toContain("all lowercase, no trailing period");
  expect(selection.text).not.toContain("cto of kowo"); // the marked region, and only it
  expect(selection.text).not.toContain("yeah that's broken");
});

test("several marked regions are concatenated in file order", () => {
  const marked = `<!-- chill:start -->\nfirst bit\n<!-- chill:end -->\n\nnot this\n\n<!-- chill:start -->\nsecond bit\n<!-- chill:end -->`;
  const { text, how } = selectPersonaForGate(marked);
  expect(how).toBe("marked");
  expect(text).toBe("first bit\n\nsecond bit");
});

test("a marked region bigger than the budget is still carved to fit (never a 413)", () => {
  const marked = `<!-- chill:start -->\n${persona(6, 200)}\n<!-- chill:end -->`;
  const selection = selectPersonaForGate(marked, 500);
  expect(selection.how).toBe("trimmed");
  expect(selection.text.length).toBeLessThanOrEqual(500);
});

test("one giant section with no boundaries degrades to its trailing lines, not a mid-word cut", () => {
  const giant = ["## voice", "", "line one", "line two", "line three", "line four"].join("\n");
  const selection = selectPersonaForGate(giant, 25);
  expect(selection.how).toBe("trimmed");
  expect(selection.text.length).toBeLessThanOrEqual(25);
  expect(selection.text).toBe("line three\nline four");
});

test("the composed prompt always fits chilltext's system cap", () => {
  const prompt = buildChillSystemPrompt(persona(40, 500)); // ~20k of persona
  expect(prompt.length).toBeLessThanOrEqual(CHILL_SYSTEM_MAX_CHARS);
  expect(personaBudget()).toBeGreaterThan(0);
});

test("the seeded default persona fits, via its markers, with room to spare", () => {
  // A fresh install must not need a hand-edit to get its own voice through the gate.
  const selection = selectPersonaForGate(DEFAULT_PERSONA);
  expect(selection.how).toBe("marked");
  expect(selection.text).toContain("NO emojis");
  expect(buildChillSystemPrompt(DEFAULT_PERSONA).length).toBeLessThanOrEqual(CHILL_SYSTEM_MAX_CHARS);
});

test("a missing persona file returns undefined, logs once, and never throws", () => {
  const missing = join(tmp(), "not-there.md");
  const logged: string[] = [];
  expect(chillSystemPrompt(missing, (m) => logged.push(m))).toBeUndefined();
  expect(logged.length).toBe(1);
  expect(logged[0]).toContain(missing);
  // Once per path per process: a missing file must not print a line per outbound message.
  expect(chillSystemPrompt(missing, (m) => logged.push(m))).toBeUndefined();
  expect(logged.length).toBe(1);
});

test("an unreadable persona (a directory) returns undefined rather than throwing", () => {
  expect(chillSystemPrompt(tmp(), () => {})).toBeUndefined();
});

test("an empty persona file is 'no voice', not an empty prompt", () => {
  const path = join(tmp(), "persona.md");
  writeFileSync(path, "   \n\n");
  expect(chillSystemPrompt(path)).toBeUndefined();
});

test("a carve is announced once, naming the markers that would replace the guess", () => {
  const path = join(tmp(), "persona.md");
  writeFileSync(path, persona(40, 500));
  const logged: string[] = [];
  const prompt = chillSystemPrompt(path, (m) => logged.push(m))!;
  expect(prompt.length).toBeLessThanOrEqual(CHILL_SYSTEM_MAX_CHARS);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain("chill:start");
  chillSystemPrompt(path, (m) => logged.push(m));
  expect(logged).toHaveLength(1);
});

test("the default persona path is the one the daemon's paths resolve to", () => {
  expect(defaultPersonaPath().endsWith("/persona.md")).toBe(true);
});
