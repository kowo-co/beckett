/** Tests for `--ping` target resolution + mention rendering (issue #10). */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertIdentity } from "./identity.ts";
import { resolvePingTargets, renderMentions, enforceMentions } from "./mentions.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "beckett-mentions-"));
  file = join(dir, "identities.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const RO = "1151230208783945818";
const ALICE = "222222222222222222";

test("resolvePingTargets: raw snowflake passes through unchanged", () => {
  expect(resolvePingTargets([RO], file)).toEqual([RO]);
});

test("resolvePingTargets: an already-wrapped <@id> blob is unwrapped, not double-wrapped", () => {
  expect(resolvePingTargets([`<@${RO}>`], file)).toEqual([RO]);
  expect(resolvePingTargets([`<@!${RO}>`], file)).toEqual([RO]);
});

test("resolvePingTargets: a known name resolves via the identity map, case-insensitive", () => {
  upsertIdentity(file, RO, { known_name: "ro" });
  expect(resolvePingTargets(["ro"], file)).toEqual([RO]);
  expect(resolvePingTargets(["RO"], file)).toEqual([RO]);
  expect(resolvePingTargets(["Ro"], file)).toEqual([RO]);
});

test("resolvePingTargets: preferred_address and display_name are also matched", () => {
  upsertIdentity(file, ALICE, { display_name: "alice#0", preferred_address: "Ali" });
  expect(resolvePingTargets(["Ali"], file)).toEqual([ALICE]);
  expect(resolvePingTargets(["alice#0"], file)).toEqual([ALICE]);
});

test("resolvePingTargets: an unknown target fails clearly, naming it and every known name", () => {
  upsertIdentity(file, RO, { known_name: "ro" });
  upsertIdentity(file, ALICE, { known_name: "alice" });
  expect(() => resolvePingTargets(["nobody"], file)).toThrow(/unknown --ping target: nobody/);
  expect(() => resolvePingTargets(["nobody"], file)).toThrow(/alice/);
  expect(() => resolvePingTargets(["nobody"], file)).toThrow(/ro/);
});

test("resolvePingTargets: an unknown target with no identities on file still fails, without a name list", () => {
  expect(() => resolvePingTargets(["nobody"], file)).toThrow(/no names are known yet/);
});

test("resolvePingTargets: several unresolved targets are all named in one error", () => {
  expect(() => resolvePingTargets(["nobody", "nomatch"], file)).toThrow(/nobody, nomatch/);
});

test("resolvePingTargets: duplicate targets (by id, blob, or name) dedupe, order preserved", () => {
  upsertIdentity(file, RO, { known_name: "ro" });
  expect(resolvePingTargets([RO, `<@${RO}>`, "ro", ALICE], file)).toEqual([RO, ALICE]);
});

test("resolvePingTargets: multiple distinct pings resolve in order", () => {
  upsertIdentity(file, RO, { known_name: "ro" });
  expect(resolvePingTargets(["ro", ALICE], file)).toEqual([RO, ALICE]);
});

test("resolvePingTargets: one bad target among good ones still fails the whole call", () => {
  upsertIdentity(file, RO, { known_name: "ro" });
  expect(() => resolvePingTargets(["ro", "nobody"], file)).toThrow(/nobody/);
});

test("renderMentions: prepends a single mention line, then a newline, then the body", () => {
  expect(renderMentions("hello", [RO])).toBe(`<@${RO}>\nhello`);
});

test("renderMentions: multiple ids join space-separated on one line", () => {
  expect(renderMentions("hello", [RO, ALICE])).toBe(`<@${RO}> <@${ALICE}>\nhello`);
});

test("renderMentions: dedupes, order-preserving", () => {
  expect(renderMentions("hello", [RO, ALICE, RO])).toBe(`<@${RO}> <@${ALICE}>\nhello`);
});

test("renderMentions: a mention already present verbatim in the body is not added again", () => {
  expect(renderMentions(`hey <@${RO}> check this out`, [RO])).toBe(`hey <@${RO}> check this out`);
});

test("renderMentions: only the missing mentions among several are added", () => {
  const body = `hey <@${RO}> check this out`;
  expect(renderMentions(body, [RO, ALICE])).toBe(`<@${ALICE}>\nhey <@${RO}> check this out`);
});

test("renderMentions: no ids leaves the body untouched", () => {
  expect(renderMentions("hello", [])).toBe("hello");
});

// enforceMentions — structural repair of ping ids after the lossy chilltext rewrite.

test("enforceMentions: no ping ids leaves every bubble byte-for-byte untouched", () => {
  const bubbles = ["yeah all good", `some prose with @${RO} in it`];
  expect(enforceMentions(bubbles, [])).toEqual(bubbles);
});

test("enforceMentions: a bare @id (brackets stripped) is repaired to a valid <@id>", () => {
  expect(enforceMentions([`hey @${RO} take a look`], [RO])).toEqual([`<@${RO}>\nhey take a look`]);
});

test("enforceMentions: a spaced < @id > is repaired", () => {
  expect(enforceMentions([`hey < @${RO} > look`], [RO])).toEqual([`<@${RO}>\nhey look`]);
});

test("enforceMentions: a backticked `<@id>` is repaired", () => {
  expect(enforceMentions([`hey \`<@${RO}>\` look`], [RO])).toEqual([`<@${RO}>\nhey look`]);
});

test("enforceMentions: a <@!id> variant normalizes to <@id>", () => {
  expect(enforceMentions([`<@!${RO}> hey`], [RO])).toEqual([`<@${RO}>\nhey`]);
});

test("enforceMentions: a dropped mention is re-added onto the first bubble", () => {
  expect(enforceMentions(["hey take a look"], [RO])).toEqual([`<@${RO}>\nhey take a look`]);
});

test("enforceMentions: a still-valid <@id> is kept, moved to the front, exactly once", () => {
  expect(enforceMentions([`<@${RO}>\nhey`], [RO])).toEqual([`<@${RO}>\nhey`]);
});

test("enforceMentions: the id must be exact — <@123> is not touched by a ping for 1234", () => {
  const other = `<@${RO}9>`; // a different, longer snowflake that shares a prefix
  expect(enforceMentions([`hi ${other} there`], [RO])).toEqual([`<@${RO}>\nhi ${other} there`]);
});

test("enforceMentions: multi-bubble — the mention lands once, on the FIRST bubble", () => {
  const out = enforceMentions(["first bubble", `second @${RO} bubble`], [RO]);
  expect(out).toEqual([`<@${RO}>\nfirst bubble`, "second bubble"]);
  expect(out.join("\n").split(`<@${RO}>`).length - 1).toBe(1);
});

test("enforceMentions: a mention duplicated into every bubble collapses to one on the first", () => {
  const out = enforceMentions([`<@${RO}> a`, `<@${RO}> b`, `@${RO} c`], [RO]);
  expect(out).toEqual([`<@${RO}>\na`, "b", "c"]);
});

test("enforceMentions: several ping ids all land, deduped and order-preserving, on the first bubble", () => {
  const out = enforceMentions([`hey @${RO} and @${ALICE}`], [RO, ALICE, RO]);
  expect(out).toEqual([`<@${RO}> <@${ALICE}>\nhey and`]);
});

test("enforceMentions: a bubble that was only the mention does not post as an empty bubble", () => {
  expect(enforceMentions([`<@${RO}>`, "the actual message"], [RO])).toEqual([
    `<@${RO}>\nthe actual message`,
  ]);
});

test("enforceMentions: when every bubble was only the mention, a single mention bubble remains", () => {
  expect(enforceMentions([`@${RO}`], [RO])).toEqual([`<@${RO}>`]);
});
