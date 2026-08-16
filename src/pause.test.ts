import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearPause, pauseFilePath, pauseRefusal, pauseTurnNote, readPause, writePause } from "./pause.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-pause-"));
  dirs.push(dir);
  return dir;
}

test("pauseFilePath joins beckettDir and pause.json", () => {
  expect(pauseFilePath("/home/beckett/.beckett")).toBe("/home/beckett/.beckett/pause.json");
});

test("an absent pause file reads as not paused", () => {
  const dir = tmp();
  expect(readPause(join(dir, "pause.json"))).toBeNull();
});

test("write then read round-trips reason and by", () => {
  const file = join(tmp(), "pause.json");
  const written = writePause(file, { pausedAt: "2026-08-15T00:00:00.000Z", reason: "hands off tonight", by: "jason" });
  expect(written).toEqual({ pausedAt: "2026-08-15T00:00:00.000Z", reason: "hands off tonight", by: "jason" });
  expect(readPause(file)).toEqual(written);
});

test("re-pausing keeps the original pausedAt and replaces the reason", () => {
  const file = join(tmp(), "pause.json");
  writePause(file, { pausedAt: "2026-08-15T00:00:00.000Z", reason: "first reason", by: "jason" });
  const second = writePause(file, { pausedAt: "2026-08-15T05:00:00.000Z", reason: "second reason", by: "someone-else" });
  expect(second.pausedAt).toBe("2026-08-15T00:00:00.000Z");
  expect(second.reason).toBe("second reason");
  expect(second.by).toBe("someone-else");
  expect(readPause(file)).toEqual(second);
});

test("a corrupt pause file still reads as PAUSED, with a null reason", () => {
  const file = join(tmp(), "pause.json");
  writeFileSync(file, "{{{");
  const state = readPause(file);
  expect(state).not.toBeNull();
  expect(state?.reason).toBeNull();
  expect(typeof state?.pausedAt).toBe("string");
});

test("clearPause returns false when nothing was held", () => {
  const file = join(tmp(), "pause.json");
  expect(clearPause(file)).toBe(false);
});

test("clearPause removes an actual hold and returns true", () => {
  const file = join(tmp(), "pause.json");
  writePause(file, { pausedAt: "2026-08-15T00:00:00.000Z", reason: null, by: null });
  expect(clearPause(file)).toBe(true);
  expect(readPause(file)).toBeNull();
});

test("pauseRefusal names the action, the reason, and beckett resume", () => {
  const msg = pauseRefusal({ pausedAt: "2026-08-15T00:00:00.000Z", reason: "hands off tonight", by: "jason" }, "deploy a run");
  expect(msg.startsWith("paused:")).toBe(true);
  expect(msg).toContain("deploy a run");
  expect(msg).toContain("hands off tonight");
  expect(msg).toContain("beckett resume");
});

test("pauseRefusal reads 'none given' when there is no reason", () => {
  const msg = pauseRefusal({ pausedAt: "2026-08-15T00:00:00.000Z", reason: null, by: null }, "dispatch a quick agent");
  expect(msg).toContain("reason: none given");
});

test("pauseTurnNote names the hold and the resume path", () => {
  const note = pauseTurnNote({ pausedAt: "2026-08-15T00:00:00.000Z", reason: "hands off tonight", by: "jason" });
  expect(note).toContain("YOU ARE PAUSED (chat only)");
  expect(note).toContain("hands off tonight");
  expect(note).toContain("beckett resume");
});
