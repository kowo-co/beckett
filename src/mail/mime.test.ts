import { describe, it, expect } from "bun:test";
import { parseMime, parseAddress } from "./mime.ts";

describe("mime/parseAddress", () => {
  it("extracts the addr-spec from a display-name form", () => {
    expect(parseAddress("Ada Lovelace <ada@example.com>")).toBe("ada@example.com");
  });

  it("returns a bare address unchanged", () => {
    expect(parseAddress("ada@example.com")).toBe("ada@example.com");
  });

  it("returns empty string when there is no address at all", () => {
    expect(parseAddress("garbage")).toBe("");
  });

  it("returns empty string for an empty value", () => {
    expect(parseAddress("")).toBe("");
  });
});

describe("mime/parseMime — header/body split", () => {
  it("splits on the first blank line with LF endings", () => {
    const raw = "Subject: Hi\nFrom: a@example.com\n\nHello there.";
    const parsed = parseMime(raw);
    expect(parsed.subject).toBe("Hi");
    expect(parsed.text).toBe("Hello there.");
  });

  it("splits on the first blank line with CRLF endings", () => {
    const raw = "Subject: Hi\r\nFrom: a@example.com\r\n\r\nHello there.";
    const parsed = parseMime(raw);
    expect(parsed.subject).toBe("Hi");
    expect(parsed.text).toBe("Hello there.");
  });
});

describe("mime/parseMime — header unfolding", () => {
  it("joins a header continued on an indented line into the previous header's value", () => {
    const raw = "Subject: This is\n a folded\n\tsubject line\nFrom: a@example.com\n\nBody.";
    const parsed = parseMime(raw);
    expect(parsed.headers.subject).toBe("This is a folded subject line");
    expect(parsed.subject).toBe("This is a folded subject line");
  });

  it("joins repeated header lines with ', ' instead of dropping earlier ones", () => {
    const raw = "Subject: Hi\nX-Custom: one\nX-Custom: two\nFrom: a@example.com\n\nBody.";
    const parsed = parseMime(raw);
    expect(parsed.headers["x-custom"]).toBe("one, two");
  });
});

describe("mime/parseMime — RFC 2047 encoded words", () => {
  it("decodes a base64 encoded word in Subject", () => {
    const raw = "Subject: =?UTF-8?B?SGVsbG8sIFdvcmxkIQ==?=\nFrom: a@example.com\n\nBody.";
    expect(parseMime(raw).subject).toBe("Hello, World!");
  });

  it("decodes a quoted-printable encoded word with underscore-as-space in From", () => {
    const raw = 'From: =?UTF-8?Q?Caf=C3=A9_Owner?= <cafe@example.com>\nSubject: Hi\n\nBody.';
    expect(parseMime(raw).from).toBe("Café Owner <cafe@example.com>");
  });

  it("decodes multiple adjacent encoded words in one header, dropping the folding whitespace between them", () => {
    const raw = "Subject: =?UTF-8?Q?Hello=2C_?= =?UTF-8?Q?World!?=\nFrom: a@example.com\n\nBody.";
    expect(parseMime(raw).subject).toBe("Hello, World!");
  });

  it("falls back to the raw token for an unknown charset instead of throwing", () => {
    const raw = "Subject: =?bogus-charset-xyz?B?SGVsbG8=?=\nFrom: a@example.com\n\nBody.";
    expect(() => parseMime(raw)).not.toThrow();
    expect(parseMime(raw).subject).toBe("=?bogus-charset-xyz?B?SGVsbG8=?=");
  });
});

describe("mime/parseMime — Content-Transfer-Encoding", () => {
  it("decodes base64 bodies", () => {
    const raw = "Content-Type: text/plain\nContent-Transfer-Encoding: base64\n\nSGVsbG8sIFdvcmxkIQ==";
    expect(parseMime(raw).text).toBe("Hello, World!");
  });

  it("decodes quoted-printable hex escapes", () => {
    const raw = "Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nCaf=C3=A9";
    expect(parseMime(raw).text).toBe("Café");
  });

  it("collapses a quoted-printable soft line break without inserting a newline or space", () => {
    const raw = "Content-Type: text/plain\nContent-Transfer-Encoding: quoted-printable\n\nFirst=\nSecond";
    expect(parseMime(raw).text).toBe("FirstSecond");
  });

  it("passes 7bit bodies through verbatim", () => {
    const raw = "Content-Type: text/plain\nContent-Transfer-Encoding: 7bit\n\nplain text";
    expect(parseMime(raw).text).toBe("plain text");
  });

  it("passes bodies through verbatim when Content-Transfer-Encoding is absent", () => {
    const raw = "Content-Type: text/plain\n\nplain text, no encoding header at all";
    expect(parseMime(raw).text).toBe("plain text, no encoding header at all");
  });
});

describe("mime/parseMime — multipart", () => {
  const boundary = "BOUNDARY123";
  const raw = [
    "Subject: Report",
    "From: a@example.com",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain",
    "",
    "Plain body.",
    `--${boundary}`,
    "Content-Type: text/html",
    "",
    "<p>HTML body.</p>",
    `--${boundary}`,
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Type: text/plain",
    "Content-Transfer-Encoding: base64",
    "",
    "aGVsbG8gYXR0YWNobWVudA==",
    `--${boundary}--`,
    "",
  ].join("\n");

  it("picks the first text/plain and first text/html parts", () => {
    const parsed = parseMime(raw);
    expect(parsed.text).toBe("Plain body.");
    expect(parsed.html).toBe("<p>HTML body.</p>");
  });

  it("records an attachment as metadata only, with the decoded byte size", () => {
    const parsed = parseMime(raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toEqual({
      filename: "notes.txt",
      contentType: "text/plain",
      size: Buffer.byteLength("hello attachment"),
    });
    // Metadata only: no field anywhere on the record could carry the decoded bytes.
    expect(Object.keys(parsed.attachments[0]!).sort()).toEqual(["contentType", "filename", "size"]);
  });

  it("recurses into a nested multipart/alternative inside multipart/mixed", () => {
    const altBoundary = "ALT456";
    const outer = "OUTER789";
    const nested = [
      "Subject: Nested",
      "From: a@example.com",
      `Content-Type: multipart/mixed; boundary="${outer}"`,
      "",
      `--${outer}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      `--${altBoundary}`,
      "Content-Type: text/plain",
      "",
      "Alt plain.",
      `--${altBoundary}`,
      "Content-Type: text/html",
      "",
      "<p>Alt html.</p>",
      `--${altBoundary}--`,
      `--${outer}`,
      'Content-Disposition: attachment; filename="doc.txt"',
      "Content-Type: text/plain",
      "",
      "raw attachment text",
      `--${outer}--`,
      "",
    ].join("\n");
    const parsed = parseMime(nested);
    expect(parsed.text).toBe("Alt plain.");
    expect(parsed.html).toBe("<p>Alt html.</p>");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe("doc.txt");
  });

  it("bounds recursion depth so a maliciously deep multipart nest cannot hang or crash", () => {
    const NEST_LEVELS = 15;
    const marker = "DEEP_MARKER_TEXT";
    let inner = ["Content-Type: text/plain", "", marker].join("\n");
    for (let i = 0; i < NEST_LEVELS; i++) {
      const b = `LEVEL${i}`;
      inner = [`Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, inner, `--${b}--`, ""].join("\n");
    }
    const full = `Subject: Deep\nFrom: a@example.com\n${inner}`;
    let parsed: ReturnType<typeof parseMime> | undefined;
    expect(() => {
      parsed = parseMime(full);
    }).not.toThrow();
    // Recursion is capped well short of 15 levels, so the innermost text/plain is never reached.
    expect(parsed!.text).toBe("");
  });

  it("bounds the total number of parsed parts", () => {
    const b = "MANYPARTS";
    const pieces = [`Content-Type: multipart/mixed; boundary="${b}"`, ""];
    const PART_COUNT = 150;
    for (let i = 0; i < PART_COUNT; i++) {
      pieces.push(`--${b}`, `Content-Disposition: attachment; filename="f${i}.txt"`, "Content-Type: text/plain", "", `part ${i}`);
    }
    pieces.push(`--${b}--`, "");
    const raw2 = `Subject: Many\nFrom: a@example.com\n${pieces.join("\n")}`;
    const parsed = parseMime(raw2);
    expect(parsed.attachments.length).toBeLessThan(PART_COUNT);
    expect(parsed.attachments.length).toBeLessThanOrEqual(100);
  });
});

describe("mime/parseMime — non-multipart bodies", () => {
  it("puts a non-multipart text/plain body in text", () => {
    const raw = "Content-Type: text/plain\nSubject: Hi\n\nJust plain text.";
    const parsed = parseMime(raw);
    expect(parsed.text).toBe("Just plain text.");
    expect(parsed.html).toBe("");
  });

  it("puts a non-multipart text/html body in html", () => {
    const raw = "Content-Type: text/html\nSubject: Hi\n\n<p>Just html.</p>";
    const parsed = parseMime(raw);
    expect(parsed.html).toBe("<p>Just html.</p>");
    expect(parsed.text).toBe("");
  });
});

describe("mime/parseMime — To/Cc/Date/Message-ID", () => {
  it("parses every address out of To and Cc, including a quoted display-name comma", () => {
    const raw =
      'From: a@example.com\nTo: "Doe, Ada" <ada@example.com>, bob@example.com\nCc: carol@example.com\nSubject: Hi\n\nBody.';
    const parsed = parseMime(raw);
    expect(parsed.to).toEqual(["ada@example.com", "bob@example.com"]);
    expect(parsed.cc).toEqual(["carol@example.com"]);
  });

  it("parses an RFC822 Date header to an ISO string", () => {
    const raw = "Date: Mon, 17 Aug 2026 09:00:00 -0700\nFrom: a@example.com\n\nBody.";
    const parsed = parseMime(raw);
    expect(parsed.date).toBe(new Date("Mon, 17 Aug 2026 09:00:00 -0700").toISOString());
  });

  it("returns an empty date for an absent or unparseable Date header", () => {
    expect(parseMime("From: a@example.com\n\nBody.").date).toBe("");
    expect(parseMime("Date: not a date\nFrom: a@example.com\n\nBody.").date).toBe("");
  });

  it("strips angle brackets from Message-ID", () => {
    const raw = "Message-ID: <abc123@example.com>\nFrom: a@example.com\n\nBody.";
    expect(parseMime(raw).messageId).toBe("abc123@example.com");
  });

  it("returns an empty Message-ID when absent", () => {
    expect(parseMime("From: a@example.com\n\nBody.").messageId).toBe("");
  });
});

describe("mime/parseMime — robustness against hostile/malformed input", () => {
  it("never throws and returns best-effort defaults for a missing multipart boundary", () => {
    const raw = "Content-Type: multipart/mixed\n\nsome body with no boundary parameter at all";
    expect(() => parseMime(raw)).not.toThrow();
    const parsed = parseMime(raw);
    expect(parsed.text).toBe("");
    expect(parsed.html).toBe("");
    expect(parsed.attachments).toEqual([]);
  });

  it("never throws and still recovers the last part of an unterminated multipart message", () => {
    const b = "UNTERMINATED";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      "Content-Type: text/plain",
      "",
      "First part.",
      `--${b}`,
      "Content-Type: text/plain",
      "",
      "Second part, never closed.",
    ].join("\n");
    expect(() => parseMime(raw)).not.toThrow();
    // No closing boundary: best effort is to still find the first text/plain part.
    expect(parseMime(raw).text).toBe("First part.");
  });

  it("never throws on a bogus base64 blob", () => {
    const raw = "Content-Type: text/plain\nContent-Transfer-Encoding: base64\n\n!!!not-base64-at-all!!!";
    expect(() => parseMime(raw)).not.toThrow();
    expect(typeof parseMime(raw).text).toBe("string");
  });

  it("never throws on a header line with no colon, and still parses the surrounding headers", () => {
    const raw = "Subject: Hi\nThisLineHasNoColon\nFrom: a@example.com\n\nBody.";
    expect(() => parseMime(raw)).not.toThrow();
    const parsed = parseMime(raw);
    expect(parsed.subject).toBe("Hi");
    expect(parsed.from).toBe("a@example.com");
  });

  it("never throws on an empty string and returns an all-default ParsedMime", () => {
    expect(() => parseMime("")).not.toThrow();
    const parsed = parseMime("");
    expect(parsed).toEqual({
      headers: {},
      from: "",
      to: [],
      cc: [],
      subject: "",
      date: "",
      messageId: "",
      text: "",
      html: "",
      attachments: [],
    });
  });

  it("never throws on a body with no headers at all", () => {
    const raw = "just some plain text\nwith multiple lines\nand no header block at all";
    expect(() => parseMime(raw)).not.toThrow();
    const parsed = parseMime(raw);
    expect(parsed.headers).toEqual({});
    expect(parsed.text).toBe(raw);
  });
});

describe("mime/adversarial cost", () => {
  // EMAIL_RE backtracks quadratically when its local-part class matches a long run with no usable
  // "@" after it. Before MAX_HEADER_VALUE bounded the input, a 100 KB From header took ~17 SECONDS
  // of blocked event loop - and the intake size cap allows a megabyte, so one email could wedge
  // the daemon for minutes. These are the regression guard for that.
  it("clips a single header value so a hostile header cannot be unbounded", () => {
    const parsed = parseMime("From: " + "a.".repeat(60_000) + "\r\nSubject: hi\r\n\r\nbody");
    expect(parsed.headers.from!.length).toBeLessThanOrEqual(2000);
    expect(parsed.from.length).toBeLessThanOrEqual(2000);
  });

  it("parses a 100 KB no-at-sign From header in well under a second", () => {
    const raw = "From: " + "a.".repeat(50_000) + "\r\nSubject: hi\r\n\r\nbody";
    const started = performance.now();
    expect(parseAddress(parseMime(raw).from)).toBe("");
    // Generous by orders of magnitude versus the pre-fix 17s, so this cannot flake on a loaded
    // box while still failing loudly if the quadratic path ever comes back.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("clips a repeated header whose joined value would re-grow past the cap", () => {
    const received = Array.from({ length: 50 }, (_, i) => "Received: " + "x".repeat(500) + "-" + i).join("\r\n");
    const parsed = parseMime(received + "\r\nSubject: hi\r\n\r\nbody");
    expect(parsed.headers.received!.length).toBeLessThanOrEqual(2000);
  });
});

describe("mime/parseAddress spoofing", () => {
  // fromAddress is what `mail ls` prints in its FROM column and `mail read` labels
  // "From-Address". RFC 5322 lets a display name be a quoted string containing angle brackets, so
  // a naive first-<...>-wins scan let a sender CHOOSE the address Beckett shows as authoritative —
  // including one on Beckett's own domain.
  it("ignores an angle-addr hidden inside a quoted display name", () => {
    expect(parseAddress('"Trusted <boss@company.com>" <mallory@evil.example>')).toBe("mallory@evil.example");
    expect(parseAddress('"Beckett Admin <admin@0xbeckett.me>" <attacker@evil.example>')).toBe("attacker@evil.example");
  });

  it("still reads an ordinary display-name form, including a quoted comma", () => {
    expect(parseAddress("Ada Lovelace <ada@example.com>")).toBe("ada@example.com");
    expect(parseAddress('"Doe, Ada" <ada@example.com>')).toBe("ada@example.com");
  });

  it("falls back to scanning the whole value when there is no angle-addr", () => {
    expect(parseAddress("ada@example.com")).toBe("ada@example.com");
    expect(parseAddress('"just a name" ada@example.com')).toBe("ada@example.com");
  });

  it("does not treat an escaped quote as closing the display name", () => {
    expect(parseAddress('"say \\" <boss@company.com>" <mallory@evil.example>')).toBe("mallory@evil.example");
  });
});
