/**
 * Coverage for the observed-bot gateway primitive — the WEAKER, read-only exemption to the
 * bot-ignore guard (see federation.test.ts for the peer primitive it deliberately parallels but
 * never shares state with). Pure, so no live gateway / discord.js is involved.
 */

import { test, expect } from "bun:test";
import { isObservedBot } from "./observed.ts";

const OWN = "100000000000000001";
const BOOPER = "1537651257328672778";
const STRANGER = "300000000000000003";

test("an unlisted bot is not observed (default behavior: ignored)", () => {
  expect(isObservedBot(STRANGER, OWN, new Set([BOOPER]))).toBe(false);
});

test("a listed bot is observed", () => {
  expect(isObservedBot(BOOPER, OWN, new Set([BOOPER]))).toBe(true);
});

test("we are never our own observed bot, even if our id is mistakenly listed", () => {
  expect(isObservedBot(OWN, OWN, new Set([OWN, BOOPER]))).toBe(false);
});

test("empty allowlist means nothing is observed (inert default)", () => {
  expect(isObservedBot(BOOPER, OWN, new Set())).toBe(false);
});

test("pre-ready (own id unknown) still matches a listed observed bot", () => {
  expect(isObservedBot(BOOPER, undefined, new Set([BOOPER]))).toBe(true);
});
