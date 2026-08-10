/**
 * "No directed message is ever silently unanswered" — the two decisions the concierge's
 * multi-message path used to make in silence, pinned as pure functions:
 *   1. coalescedBurstNote    — a queued turn superseded by its own author is FOLDED IN, not dropped
 *   2. orphanedInjectionIds  — a mid-flow message whose turn never absorbed it is re-run, not lost
 *
 * Both failures looked identical from the room: a person sent two messages, one got an answer, the
 * other got nothing at all and no notice that it had gone.
 */

import { expect, test } from "bun:test";
import { coalescedBurstNote, orphanedInjectionIds, type InjectedMessageRecord } from "./index.ts";

// ── 1. coalescing a superseded queued turn into the one that replaced it ──────────────────

test("a burst frames both messages as one thought, oldest first", () => {
  const note = coalescedBurstNote(["deploy the thing", "actually to staging first"]);

  expect(note).toContain("quick succession");
  expect(note).toContain("ONE thought");
  // Order is the substance: the model has to read the correction as following the original.
  expect(note.indexOf("deploy the thing")).toBeLessThan(note.indexOf("actually to staging first"));
  expect(note).toContain("1. deploy the thing");
  expect(note).toContain("2. actually to staging first");
});

test("a three-message burst carries every message, none dropped", () => {
  const note = coalescedBurstNote(["one", "two", "three"]);
  expect(note).toContain("1. one");
  expect(note).toContain("2. two");
  expect(note).toContain("3. three");
});

test("nothing superseded → no note at all, so an ordinary turn's prompt is unchanged", () => {
  expect(coalescedBurstNote(["just the one message"])).toBe("");
  expect(coalescedBurstNote([])).toBe("");
});

test("blank and whitespace-only texts drop out rather than numbering an empty line", () => {
  // An attachment-only message has no text to carry; it must not become "1. " in the preamble.
  expect(coalescedBurstNote(["   ", "the real question"])).toBe("");
  const note = coalescedBurstNote(["  first  ", "", "second"]);
  expect(note).toContain("1. first");
  expect(note).toContain("2. second");
  expect(note).not.toContain("3.");
});

// ── 2. which injected messages a result leaves unanswered ────────────────────────────────

const injected = (messageId: string, absorbed = false): InjectedMessageRecord => ({ messageId, absorbed });

test("a result WITH a pending turn orphans nothing — that turn's reply covers the injections", () => {
  expect(orphanedInjectionIds([injected("m-2"), injected("m-3")], true)).toEqual([]);
});

test("a result with NO pending turn requeues every unabsorbed injection, in arrival order", () => {
  // The orphan case: the injection raced the live turn's own result, so claude answered it as a
  // turn of its own — a result nobody is waiting on, discarded, taking the message with it.
  expect(orphanedInjectionIds([injected("m-2"), injected("m-3")], false)).toEqual(["m-2", "m-3"]);
});

test("already-absorbed records are never requeued — that would answer the same message twice", () => {
  const records = [injected("m-2", true), injected("m-3"), injected("m-4", true)];
  expect(orphanedInjectionIds(records, false)).toEqual(["m-3"]);
});

test("nothing injected, or nothing left unabsorbed, requeues nothing", () => {
  expect(orphanedInjectionIds([], false)).toEqual([]);
  expect(orphanedInjectionIds([injected("m-2", true)], false)).toEqual([]);
});

test("a message injected twice is requeued once (one message, one answer)", () => {
  expect(orphanedInjectionIds([injected("m-2"), injected("m-2")], false)).toEqual(["m-2"]);
});
