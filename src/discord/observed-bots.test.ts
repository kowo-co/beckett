/**
 * Coverage for the living observed-bots file (`observed-bots.txt`) — load/add/remove, mirroring
 * peers.test.ts's behavior: idempotent, snowflake-validated, corruption-tolerant, atomic. This
 * is a genuinely separate list from peers.txt — see observed.ts for why.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadObservedBots, addObservedBot, removeObservedBot, isValidObservedBotId } from "./observed-bots.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "beckett-observed-bots-")), "observed-bots.txt");
}

const A = "123456789012345678";
const B = "234567890123456789";

test("missing file loads as an empty set (nothing extra observed)", () => {
  expect(loadObservedBots(join(tmpdir(), "does-not-exist-xyz", "observed-bots.txt")).size).toBe(0);
});

test("add writes the id and it loads back", () => {
  const f = tmpFile();
  const r = addObservedBot(f, A);
  expect(r.status).toBe("added");
  expect(loadObservedBots(f).has(A)).toBe(true);
});

test("add is idempotent", () => {
  const f = tmpFile();
  addObservedBot(f, A);
  const r = addObservedBot(f, A);
  expect(r.status).toBe("already");
  expect(r.ok).toBe(true);
  expect([...loadObservedBots(f)]).toEqual([A]);
});

test("add rejects a non-snowflake id without writing", () => {
  const f = tmpFile();
  const r = addObservedBot(f, "not-an-id");
  expect(r.ok).toBe(false);
  expect(r.status).toBe("invalid");
  expect(loadObservedBots(f).size).toBe(0);
});

test("remove deletes the id; removing an absent id is a no-op", () => {
  const f = tmpFile();
  addObservedBot(f, A);
  addObservedBot(f, B);
  expect(removeObservedBot(f, A).status).toBe("removed");
  expect(loadObservedBots(f).has(A)).toBe(false);
  expect(loadObservedBots(f).has(B)).toBe(true);
  expect(removeObservedBot(f, A).status).toBe("absent");
});

test("blank lines, comments, and malformed ids are ignored on load", () => {
  const f = tmpFile();
  writeFileSync(f, `# a comment\n\n${A}\ngarbage\n  ${B}  \n`, "utf8");
  expect([...loadObservedBots(f)].sort()).toEqual([A, B].sort());
});

test("the written file round-trips through load unchanged", () => {
  const f = tmpFile();
  addObservedBot(f, A);
  addObservedBot(f, B);
  const reloaded = loadObservedBots(f);
  expect(reloaded.size).toBe(2);
  expect(readFileSync(f, "utf8")).toContain(A);
});

test("isValidObservedBotId shape check", () => {
  expect(isValidObservedBotId(A)).toBe(true);
  expect(isValidObservedBotId("123")).toBe(false);
  expect(isValidObservedBotId("<@123456789012345678>")).toBe(false);
});
