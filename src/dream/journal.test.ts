/** Dream journal storage: stable dated paths, create-only writes, read-back. */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dreamEntryPath, listDreamEntries, readDreamEntry, writeDreamEntry, DREAM_TRUNCATED_LINE } from "./journal.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-dream-journal-"));
  dirs.push(dir);
  return dir;
}

test("entry paths are date-locked — traversal and non-dates never reach the filesystem", () => {
  const dir = sandbox();
  expect(dreamEntryPath(dir, "2026-07-26")).toBe(join(dir, "2026-07-26.md"));
  for (const bad of ["../persona", "2026-07-26.md", "2026-7-6", "notes", "2026-07-26/../../x", ""]) {
    expect(() => dreamEntryPath(dir, bad)).toThrow(/invalid date/);
  }
});

test("one write per night: an existing entry refuses without force, replaces whole with it", () => {
  const dir = sandbox();
  writeDreamEntry(dir, "2026-07-26", "first\n");
  expect(() => writeDreamEntry(dir, "2026-07-26", "second\n")).toThrow(/already exists/);
  expect(readDreamEntry(dir, "2026-07-26")).toBe("first\n");
  writeDreamEntry(dir, "2026-07-26", "second\n", { force: true });
  expect(readDreamEntry(dir, "2026-07-26")).toBe("second\n");
  // Atomic: no .tmp remnants.
  expect(readdirSync(dir)).toEqual(["2026-07-26.md"]);
});

test("ls reads back newest-first with the truncated flag; foreign files are ignored", () => {
  const dir = sandbox();
  writeDreamEntry(dir, "2026-07-24", "# dream\n<!-- dream-meta\ntruncated: false\n-->\nok\n");
  writeDreamEntry(dir, "2026-07-25", `# dream\n<!-- dream-meta\n${DREAM_TRUNCATED_LINE}\n-->\npartial\n`);
  const entries = listDreamEntries(dir);
  expect(entries.map((e) => e.date)).toEqual(["2026-07-25", "2026-07-24"]);
  expect(entries[0]!.truncated).toBe(true);
  expect(entries[1]!.truncated).toBe(false);
  expect(readDreamEntry(dir, "2026-07-23")).toBeNull();
});
