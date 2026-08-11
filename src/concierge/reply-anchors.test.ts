/**
 * Issue #235 — the split heuristic, pinned at the unit boundary.
 *
 * The prod case: a coalesced burst of ro's complaint and SSH's link question produced ONE reply
 * anchored to SSH's message, so ro's answer arrived pinned under SSH's question. These tests pin
 * both halves of the fix — the split it must make, and the much longer list of situations where it
 * must refuse to split and deliver exactly as it always did.
 */

import { describe, expect, test } from "bun:test";
import { openingAddressee, splitByAddressee, type BurstAnchor } from "./reply-anchors.ts";

const RO: BurstAnchor = { messageId: "m-ro", userId: "u-ro", name: "ro", ts: 100 };
const RO_NEWER: BurstAnchor = { messageId: "m-ro-2", userId: "u-ro", name: "ro", ts: 300 };
const SSH: BurstAnchor = { messageId: "m-ssh", userId: "u-ssh", name: "sshdev", ts: 200 };
const JASON: BurstAnchor = { messageId: "m-j", userId: "u-j", name: "Jason W", ts: 250 };

describe("splitByAddressee", () => {
  test("two authors, two addressed paragraphs → two deliveries under the right messages", () => {
    const segments = splitByAddressee(
      "ro: yeah, that queue backlog is mine — I'll clear it tonight.\n\n" +
        "sshdev: the link 404s for me too; looks like the doc moved.",
      [RO, SSH],
    );
    expect(segments).toEqual([
      { text: "ro: yeah, that queue backlog is mine — I'll clear it tonight.", anchor: RO },
      { text: "sshdev: the link 404s for me too; looks like the doc moved.", anchor: SSH },
    ]);
  });

  test("a `<@id>` opener anchors by id, not by whatever name it renders as", () => {
    const segments = splitByAddressee("<@u-ro> on it.\n\n<@u-ssh> that link is dead.", [RO, SSH]);
    expect(segments?.map((s) => s.anchor.messageId)).toEqual(["m-ro", "m-ssh"]);
  });

  test("an unaddressed paragraph rides with the segment before it", () => {
    const segments = splitByAddressee(
      "ro: mine, clearing it tonight.\n\nShould be quiet again by morning.\n\n@sshdev the link 404s.",
      [RO, SSH],
    );
    expect(segments).toHaveLength(2);
    expect(segments![0]!.text).toBe(
      "ro: mine, clearing it tonight.\n\nShould be quiet again by morning.",
    );
    expect(segments![1]!.anchor).toEqual(SSH);
  });

  test("each segment anchors to that author's MOST RECENT message in the burst", () => {
    const segments = splitByAddressee("ro, on it.\n\nsshdev, that link 404s.", [RO, SSH, RO_NEWER]);
    expect(segments![0]!.anchor).toEqual(RO_NEWER);
  });

  test("a multi-word display name is matched whole", () => {
    const segments = splitByAddressee("Jason W: shipped.\n\nro, yours is next.", [JASON, RO]);
    expect(segments?.map((s) => s.anchor.userId)).toEqual(["u-j", "u-ro"]);
  });

  // ── the conservative half: every one of these must deliver as ONE message ─────────────────

  test("a single-author burst never splits, however the answer is written", () => {
    expect(splitByAddressee("ro, one thing.\n\nro, another thing.", [RO, RO_NEWER])).toBeNull();
  });

  test("leading text addressed to nobody is ambiguous, not a first segment", () => {
    expect(
      splitByAddressee("Both of these are the same bug.\n\nro: yours first.\n\nsshdev: then yours.", [RO, SSH]),
    ).toBeNull();
  });

  test("a re-addressed author is ambiguous ordering, not three deliveries", () => {
    expect(
      splitByAddressee("ro: on it.\n\nsshdev: link's dead.\n\nro: also your log is in #ops.", [RO, SSH]),
    ).toBeNull();
  });

  test("one paragraph is one answer even when the burst spans people", () => {
    expect(splitByAddressee("ro, sshdev: same root cause, fix is going out now.", [RO, SSH])).toBeNull();
  });

  test("a name in the subject position is third person, not an address", () => {
    expect(splitByAddressee("ro pushed the fix already.\n\nsshdev, your link is dead.", [RO, SSH])).toBeNull();
  });

  test("a `<@id>` for someone outside the burst is nobody, so the text rides along", () => {
    const segments = splitByAddressee("ro: on it.\n\n<@u-stranger> welcome aboard.", [RO, SSH]);
    expect(segments).toBeNull();
  });

  test("empty text and empty bursts split nothing", () => {
    expect(splitByAddressee("   ", [RO, SSH])).toBeNull();
    expect(splitByAddressee("ro: hi\n\nsshdev: hi", [])).toBeNull();
  });

  test("more addressees than a considered answer would have falls back to one delivery", () => {
    const many: BurstAnchor[] = [1, 2, 3, 4, 5].map((n) => ({
      messageId: `m${n}`,
      userId: `u${n}`,
      name: `p${n}`,
      ts: n,
    }));
    const text = many.map((a) => `${a.name}: noted.`).join("\n\n");
    expect(splitByAddressee(text, many)).toBeNull();
  });
});

describe("openingAddressee", () => {
  const authors = new Map([
    ["u-ro", RO],
    ["u-ssh", SSH],
  ]);

  test("accepts @name, name-comma, name-colon and an em dash", () => {
    for (const opener of ["@ro yes", "ro, yes", "ro: yes", "ro — yes", "@RO yes", "Ro, yes"]) {
      expect(openingAddressee(opener, authors)).toEqual(RO);
    }
  });

  test("rejects a bare name followed by a space and a longer name that merely starts the same", () => {
    expect(openingAddressee("ro pushed it", authors)).toBeUndefined();
    expect(openingAddressee("@rocket is down", authors)).toBeUndefined();
    expect(openingAddressee("rolling it back now", authors)).toBeUndefined();
  });
});
