/**
 * The inbound mail store's containment guarantees (src/mail/store.ts): the id shape and
 * traversal guard that keep a forged id from ever addressing a file outside
 * `<beckettDir>/mail`, the parsed-not-trusted read boundary that drops any key on disk that
 * isn't in the fixed field list, the bounds that clip an oversized or control-character-laden
 * field at write time, and the narrow mutation surface (mark-read only, and refused on a
 * quarantined record). None of this is prompted — it is structural — so a regression here is a
 * hole a malicious message could climb straight through: a path traversal, a smuggled
 * `"command"` key riding along on a record, an unbounded body pushing real context out of a
 * window, or a quarantine flag a later `mark-read` call quietly clears.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAIL_ADDRESSES_MAX,
  MAIL_BODY_MAX,
  MAIL_ID_RE,
  MAIL_SUBJECT_MAX,
  type CreateMailInput,
  buildMailRecord,
  defaultMailDir,
  listMailRecords,
  mailPath,
  markMailRead,
  readMailRecord,
  unreadMailCount,
  writeMailRecord,
} from "./store.ts";

const temps: string[] = [];
function mailDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-mail-store-"));
  temps.push(dir);
  return dir;
}
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const NOW = new Date("2026-01-01T00:00:00.000Z");

function input(overrides: Partial<CreateMailInput> = {}): CreateMailInput {
  return {
    from: "Ada <ada@example.com>",
    fromAddress: "ada@example.com",
    envelopeFrom: "ada@example.com",
    envelopeTo: "beckett@0xbeckett.me",
    to: ["beckett@0xbeckett.me"],
    cc: [],
    subject: "hello",
    messageId: "<abc@example.com>",
    date: "",
    text: "hello world",
    html: "",
    attachments: [],
    headers: {},
    sizeBytes: 42,
    now: NOW,
    ...overrides,
  };
}

// ── build ──────────────────────────────────────────────────────────────────────────────

test("buildMailRecord mints an id stable under redelivery and distinct otherwise", () => {
  const a = buildMailRecord(input({ digestSource: "same-bytes" }));
  const b = buildMailRecord(input({ digestSource: "same-bytes", subject: "a wholly different subject" }));
  const c = buildMailRecord(input({ digestSource: "different-bytes" }));
  expect(a.id).toMatch(MAIL_ID_RE);
  expect(b.id).toBe(a.id);
  expect(c.id).not.toBe(a.id);
});

test("a written record reads back equal to what was built", () => {
  const dir = mailDir();
  const record = buildMailRecord(input());
  writeMailRecord(dir, record);
  expect(readMailRecord(dir, record.id)).toEqual(record);
});

// ── paths and the traversal guard ─────────────────────────────────────────────────────

test("mailPath refuses a traversal id and an id with the wrong shape", () => {
  const dir = mailDir();
  expect(() => mailPath(dir, "../../etc/passwd")).toThrow();
  expect(() => mailPath(dir, "mail-nothex")).toThrow();
});

test("readMailRecord returns null rather than throw for a malformed id", () => {
  const dir = mailDir();
  expect(readMailRecord(dir, "../../etc/passwd")).toBeNull();
});

// ── parsed, not trusted ────────────────────────────────────────────────────────────────

test("a record is parsed from a fixed field list — planted extra keys never survive the read", () => {
  const dir = mailDir();
  const id = "mail-abcdef0123456789abcdef0123456789";
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      receivedAt: NOW.toISOString(),
      from: "Ada <ada@example.com>",
      fromAddress: "ada@example.com",
      envelopeFrom: "ada@example.com",
      envelopeTo: "beckett@0xbeckett.me",
      to: ["beckett@0xbeckett.me"],
      cc: [],
      subject: "hi",
      messageId: "<abc@example.com>",
      date: "",
      text: "hello",
      html: "",
      attachments: [],
      headers: {},
      status: "new",
      spamReasons: [],
      sizeBytes: 5,
      command: "rm -rf /",
      apply: true,
    }),
  );
  const record = readMailRecord(dir, id);
  expect(record).not.toBeNull();
  expect(Object.keys(record!).sort()).toEqual([
    "attachments",
    "cc",
    "date",
    "envelopeFrom",
    "envelopeTo",
    "from",
    "fromAddress",
    "headers",
    "html",
    "id",
    "messageId",
    "receivedAt",
    "sizeBytes",
    "spamReasons",
    "status",
    "subject",
    "text",
    "to",
  ]);
});

test("a record whose stored id disagrees with its filename is never followed", () => {
  const dir = mailDir();
  const filenameId = "mail-11111111111111111111111111111111";
  const bodyId = "mail-22222222222222222222222222222222";
  const record = buildMailRecord(input());
  writeFileSync(join(dir, `${filenameId}.json`), JSON.stringify({ ...record, id: bodyId }));
  expect(readMailRecord(dir, filenameId)).toBeNull();
});

// ── bounds ─────────────────────────────────────────────────────────────────────────────

test("an oversized subject, body and recipient list are all clipped at write time", () => {
  const longSubject = "S".repeat(MAIL_SUBJECT_MAX + 200);
  const longBody = "B".repeat(MAIL_BODY_MAX + 200);
  const manyRecipients = Array.from({ length: MAIL_ADDRESSES_MAX + 20 }, (_, i) => `r${i}@example.com`);
  const record = buildMailRecord(input({ subject: longSubject, text: longBody, to: manyRecipients }));
  expect(record.subject.length).toBe(MAIL_SUBJECT_MAX);
  expect(record.text.slice(0, MAIL_BODY_MAX)).toBe("B".repeat(MAIL_BODY_MAX));
  expect(record.text).toContain(`truncated by Beckett at ${MAIL_BODY_MAX} characters`);
  expect(record.to.length).toBe(MAIL_ADDRESSES_MAX);
});

test("control characters are stripped from a subject", () => {
  const record = buildMailRecord(input({ subject: "clean\x1btext\x00here" }));
  expect(record.subject).not.toContain("\x1b");
  expect(record.subject).not.toContain("\x00");
  expect(record.subject).toBe("cleantexthere");
});

test("a subject with a newline collapses to a single line", () => {
  const record = buildMailRecord(input({ subject: "first line\nsecond line" }));
  expect(record.subject).not.toContain("\n");
  expect(record.subject.split("\n")).toHaveLength(1);
  expect(record.subject).toBe("first line second line");
});

test("an attachment filename is reduced to a leaf name with no path in it", () => {
  const record = buildMailRecord(
    input({ attachments: [{ filename: "../../evil.sh", contentType: "text/plain", size: 10 }] }),
  );
  expect(record.attachments[0]!.filename).toBe("evil.sh");
  expect(record.attachments[0]!.filename).not.toContain("/");
});

// ── listing ────────────────────────────────────────────────────────────────────────────

test("listMailRecords lists newest first, honors limit, and filters by quarantine and unread", () => {
  const dir = mailDir();
  const oldRead = buildMailRecord(
    input({ now: new Date("2026-01-01T00:00:00.000Z"), digestSource: "old", status: "read" }),
  );
  const newUnread = buildMailRecord(
    input({ now: new Date("2026-01-02T00:00:00.000Z"), digestSource: "new-one", status: "new" }),
  );
  const quarantined = buildMailRecord(
    input({ now: new Date("2026-01-03T00:00:00.000Z"), digestSource: "spam", status: "quarantined" }),
  );
  writeMailRecord(dir, oldRead);
  writeMailRecord(dir, newUnread);
  writeMailRecord(dir, quarantined);

  expect(listMailRecords(dir).map((r) => r.id)).toEqual([newUnread.id, oldRead.id]);
  expect(listMailRecords(dir, { includeQuarantined: true }).map((r) => r.id)).toEqual([
    quarantined.id,
    newUnread.id,
    oldRead.id,
  ]);
  expect(listMailRecords(dir, { limit: 1 }).map((r) => r.id)).toEqual([newUnread.id]);
  expect(listMailRecords(dir, { unreadOnly: true }).map((r) => r.id)).toEqual([newUnread.id]);
});

test("listMailRecords skips an unparseable file instead of throwing", () => {
  const dir = mailDir();
  const good = buildMailRecord(input());
  writeMailRecord(dir, good);
  writeFileSync(join(dir, "mail-0123456789abcdef0123456789abcdef.json"), "not json at all");
  expect(() => listMailRecords(dir)).not.toThrow();
  expect(listMailRecords(dir).map((r) => r.id)).toEqual([good.id]);
});

// ── mutation ───────────────────────────────────────────────────────────────────────────

test("markMailRead flips new to read, persists it, and is idempotent", () => {
  const dir = mailDir();
  const record = buildMailRecord(input({ status: "new" }));
  writeMailRecord(dir, record);
  const updated = markMailRead(dir, record.id);
  expect(updated?.status).toBe("read");
  expect(readMailRecord(dir, record.id)?.status).toBe("read");
  expect(markMailRead(dir, record.id)?.status).toBe("read");
});

test("markMailRead returns null for an unknown id", () => {
  const dir = mailDir();
  expect(markMailRead(dir, "mail-00000000000000000000000000000000")).toBeNull();
});

test("markMailRead refuses to change a quarantined record", () => {
  const dir = mailDir();
  const record = buildMailRecord(input({ status: "quarantined", spamReasons: ["blocklisted sender"] }));
  writeMailRecord(dir, record);
  const result = markMailRead(dir, record.id);
  expect(result?.status).toBe("quarantined");
  expect(readMailRecord(dir, record.id)?.status).toBe("quarantined");
});

test("unreadMailCount counts only new records", () => {
  const dir = mailDir();
  writeMailRecord(dir, buildMailRecord(input({ digestSource: "a", status: "new" })));
  writeMailRecord(dir, buildMailRecord(input({ digestSource: "b", status: "read" })));
  writeMailRecord(dir, buildMailRecord(input({ digestSource: "c", status: "quarantined" })));
  expect(unreadMailCount(dir)).toBe(1);
});

// ── paths ──────────────────────────────────────────────────────────────────────────────

test("defaultMailDir resolves to <beckettDir>/mail", () => {
  expect(defaultMailDir("/tmp/some-beckett-dir")).toBe(join("/tmp/some-beckett-dir", "mail"));
  expect(defaultMailDir("/tmp/some-beckett-dir")).toEndWith("/mail");
});
