/**
 * Coverage for the editable-persona seed/read (live voice retune). The persona lives in the
 * runtime dir so it survives redeploys and the Concierge can rewrite it; first use seeds the
 * default. Getting "seed if absent, else read existing" wrong silently resets or ignores the
 * tuned voice, so it's pinned here.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrSeedPersona, DEFAULT_PERSONA } from "./index.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-persona-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("seeds the default persona on first use and writes it to disk", () => {
  const path = join(tmp(), "persona.md");
  expect(existsSync(path)).toBe(false);
  const seeded = readOrSeedPersona(path);
  expect(seeded).toBe(DEFAULT_PERSONA);
  expect(existsSync(path)).toBe(true); // persisted, so the next boot reads the same file
});

test("reads the existing persona verbatim — never clobbers a tuned voice", () => {
  const path = join(tmp(), "persona.md");
  const tuned = "# Beckett\n\ntalk like a pirate, arr";
  writeFileSync(path, tuned);
  expect(readOrSeedPersona(path)).toBe(tuned);
});

test("an unwritable path degrades to empty, never throws", () => {
  // A path whose parent can't be created (a file used as a directory) must not crash the launch.
  const file = join(tmp(), "iam-a-file");
  writeFileSync(file, "x");
  expect(readOrSeedPersona(join(file, "persona.md"))).toBe("");
});

test("the seeded default carries the working guardrails (no emojis / no em-dashes)", () => {
  expect(DEFAULT_PERSONA.toLowerCase()).toContain("no emojis");
  expect(DEFAULT_PERSONA).toContain("beckett reload");
});

test("the seat does not depend on the voice file", () => {
  // The CTO seat's job description lives in doctrine (the-cto-seat.md), which chilltext's carve
  // never touches — not in persona.md, which is exactly what the carve trims first.
  expect(/\bcto\b/i.test(DEFAULT_PERSONA)).toBe(false);
  const playbook = readFileSync(
    join(import.meta.dir, "playbooks", "the-cto-seat.md"),
    "utf8",
  ).toLowerCase();
  expect(playbook).toContain("cto");
});
