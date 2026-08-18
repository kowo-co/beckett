/**
 * Beckett — inbound MIME parsing (`src/mail/mime.ts`)
 * =======================================================================================
 * AgentMail hands back partially-decoded messages, but the raw RFC 5322 bytes are still the
 * ground truth for anything that has to reason precisely about what a sender actually sent —
 * address-spec extraction for allowlisting, an attachment inventory, a policy layer deciding
 * what to trust. This module is a dependency-free RFC 5322 / MIME parser over that raw text.
 * No npm package: inbound mail is untrusted input, and every dependency here is one more
 * thing a hostile message gets to exploit. Only `node:` builtins and the global `Buffer`.
 *
 * The guarantee this module exists to provide: **`parseMime` never throws.** Inbound mail is
 * about the least-trusted input this codebase touches — bytes an attacker fully controls,
 * shaped by a spec (RFC 5322 / 2045 / 2047) that is routinely violated by broken senders in
 * the wild, parsed before any policy layer gets a chance to reject it. A missing boundary, a
 * header with no colon, a truncated base64 blob, an unterminated part, or a maliciously deep
 * multipart nest must all degrade to a best-effort {@link ParsedMime}, never an exception that
 * takes down mail intake. Two structural bounds enforce the "never hang" half of that promise:
 * total parsed parts are capped ({@link MAX_PARTS}) and multipart recursion is capped
 * ({@link MAX_DEPTH}), so a message that nests multipart/mixed inside itself a thousand times
 * deep cannot blow the call stack or turn intake into a denial-of-service vector.
 *
 * Attachments are METADATA ONLY by construction: {@link walkPart} decodes a part's bytes into
 * a `Buffer` only long enough to measure `size`, then copies out `{filename, contentType,
 * size}` and lets the buffer go. The decoded bytes never reach the returned `ParsedMime` —
 * there is no field in {@link MimeAttachment} to put them in, so a caller holding the parsed
 * result structurally cannot leak attachment bytes it never had.
 */

export interface MimeAttachment {
  filename: string;
  contentType: string;
  /** Size in bytes of the DECODED attachment. */
  size: number;
}

export interface ParsedMime {
  /** Lowercased header name → last value seen. Multi-value headers are joined with ", ". */
  headers: Record<string, string>;
  /** Raw From header value, e.g. `Ada <ada@example.com>`; "" when absent. */
  from: string;
  /** Every address in To, parsed out of the header. */
  to: string[];
  cc: string[];
  subject: string;
  /** RFC822 Date header parsed to an ISO string, or "" when absent/unparseable. */
  date: string;
  /** Message-ID header with angle brackets stripped, or "" when absent. */
  messageId: string;
  /** Decoded text/plain body, "" when there is none. */
  text: string;
  /** Decoded text/html body, "" when there is none. */
  html: string;
  /** Attachment METADATA ONLY — never the bytes. */
  attachments: MimeAttachment[];
}

/** Hard cap on total parts walked across the whole message. See the module doc comment. */
/**
 * Hard cap on a single unfolded header value.
 *
 * This is a DoS bound, not a formatting preference. {@link EMAIL_RE} (like most address
 * patterns) backtracks quadratically when its local-part class matches a long run with no
 * usable "@" after it, so an attacker-chosen header is a real weapon: a 100 KB `From:` of
 * `a.a.a...` measured at ~17 SECONDS of blocked event loop, and the intake size cap allows a
 * megabyte. Bounding the value is what makes that O(n^2) harmless - at 2000 chars the worst
 * case is ~1 ms. RFC 5322 limits a line to 998 octets, so this is already generous for real
 * mail; an over-long address list simply loses its tail, which the 50-recipient store cap
 * would have dropped anyway.
 */
const MAX_HEADER_VALUE = 2000;

const MAX_PARTS = 100;

/** Hard cap on multipart recursion depth. See the module doc comment. */
const MAX_DEPTH = 10;

// ── header block: split, unfold, parse ────────────────────────────────────────────────

/**
 * Split a raw message (or a raw multipart part) into its header block and body on the first
 * blank line, per RFC 5322 §2.1. Hostile/malformed input has no such line, so this never
 * assumes one exists: with no blank-line separator, a leading `Name:`-shaped first line reads
 * as a headers-only fragment (empty body) and anything else reads as a headers-less fragment
 * (the whole thing is body) — the two shapes requirement 8 calls out ("a header with no colon"
 * is a different case, handled in {@link unfoldHeaderLines}; this is about the blank line
 * itself being entirely absent). Either way, this function always returns, never throws.
 */
function splitHeadersAndBody(text: string): { headerText: string; bodyText: string } {
  const idx = text.indexOf("\n\n");
  if (idx === -1) {
    if (/^[^\s:][^:\n]*:/.test(text)) return { headerText: text, bodyText: "" };
    return { headerText: "", bodyText: text };
  }
  return { headerText: text.slice(0, idx), bodyText: text.slice(idx + 2) };
}

/**
 * Unfold a header block into `[name, value]` pairs: a continuation line (starting with space
 * or tab) joins onto the previous header with a single space, exactly as RFC 5322 §2.2.3
 * requires. A line with no colon at all is not a valid header — rather than guess at intent
 * (or throw), it is silently dropped and parsing continues with whatever headers do parse.
 */
function unfoldHeaderLines(headerText: string): Array<[string, string]> {
  if (!headerText) return [];
  const folded: string[] = [];
  for (const line of headerText.split("\n")) {
    if (line === "") continue;
    if ((line[0] === " " || line[0] === "\t") && folded.length > 0) {
      folded[folded.length - 1] += ` ${line.trim()}`;
    } else {
      folded.push(line);
    }
  }
  const pairs: Array<[string, string]> = [];
  for (const line of folded) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    if (!name) continue;
    pairs.push([name, line.slice(colon + 1).trim().slice(0, MAX_HEADER_VALUE)]);
  }
  return pairs;
}

/**
 * Build the lowercased header map. A header name repeated across several lines (extra
 * `Received:` stamps are the common real-world case) is joined with ", " rather than letting
 * the last one silently clobber the rest — the map never drops a value a sender actually sent.
 */
function parseHeaderBlock(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of unfoldHeaderLines(headerText)) {
    const key = name.toLowerCase();
    // Re-clip after joining: several repeated headers would otherwise re-grow past the cap.
    headers[key] = (key in headers ? `${headers[key]}, ${value}` : value).slice(0, MAX_HEADER_VALUE);
  }
  return headers;
}

// ── RFC 2047 encoded words ────────────────────────────────────────────────────────────

/** Matches one `=?charset?B|Q?text?=` word, plus any whitespace directly before the NEXT one. */
const ENCODED_WORD_RE = /(=\?[^?\s]+\?[bBqQ]\?[^?]*\?=)(?:[ \t]+(?==\?[^?\s]+\?[bBqQ]\?[^?]*\?=))?/g;

/**
 * Decode one `=?charset?enc?text?=` token. Base64 (`B`) and quoted-printable (`Q`, where `_`
 * is a literal space per RFC 2047 §4.2) both reduce to a byte buffer, which is then decoded
 * with the declared charset. `TextDecoder` throws on a charset it doesn't recognize — caught
 * here so an unknown/misspelled charset falls back to the raw token verbatim (requirement 3)
 * instead of taking the whole header decode down with it.
 */
function decodeOneEncodedWord(word: string): string {
  const m = /^=\?([^?]+)\?([bBqQ])\?([^?]*)\?=$/.exec(word);
  if (!m) return word;
  const [, charset, enc, text] = m as unknown as [string, string, string, string];
  try {
    const buf =
      enc.toLowerCase() === "b"
        ? Buffer.from(text.replace(/\s+/g, ""), "base64")
        : decodeQuotedPrintableToBuffer(text.replace(/_/g, " "));
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(buf);
  } catch {
    return word;
  }
}

/**
 * Decode every RFC 2047 encoded word in a header value (Subject/From are the common carriers).
 * Whitespace strictly between two adjacent encoded words is folding artifact, not a real space,
 * so it is consumed by the regex rather than surviving into the decoded string; whitespace next
 * to plain text is left alone.
 */
function decodeEncodedWords(value: string): string {
  if (!value) return "";
  return value.replace(ENCODED_WORD_RE, (_whole, word: string) => decodeOneEncodedWord(word));
}

// ── quoted-printable / transfer-encoding ──────────────────────────────────────────────

/**
 * Decode a quoted-printable byte stream (RFC 2045 §6.7). A soft line break — a `=` immediately
 * before a line terminator — is a literal continuation marker and is deleted outright, never
 * turned into a byte; every other `=XX` is a hex-escaped byte. A trailing `=` with fewer than
 * two hex digits after it (truncated/hostile input) falls through to the literal-character
 * branch instead of throwing, so garbage input still decodes to *something*.
 */
function decodeQuotedPrintableToBuffer(input: string): Buffer {
  const collapsed = input.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < collapsed.length; i++) {
    const hex = collapsed.slice(i + 1, i + 3);
    if (collapsed[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(collapsed.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Apply a part's Content-Transfer-Encoding (RFC 2045 §6) to get its raw decoded bytes.
 * `base64` first strips anything that isn't a base64 character — `Buffer.from` is already
 * lenient about invalid base64, but stripping means a bogus blob decodes deterministically
 * instead of depending on the runtime's exact leniency. `7bit`/`8bit`/`binary`/absent all mean
 * "no transformation" per the RFC, so they, and any encoding token this parser doesn't
 * recognize, pass the body through verbatim rather than guessing.
 */
function decodePartBody(body: string, encoding: string): Buffer {
  const enc = encoding.trim().toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") return decodeQuotedPrintableToBuffer(body);
  return Buffer.from(body, "utf8");
}

/**
 * Turn decoded bytes into text using a part's declared charset, falling back to UTF-8 and then
 * to `Buffer#toString` if the charset is unrecognized — the same "never throw, degrade
 * gracefully" posture as the rest of this module, just for body text instead of header text.
 */
function bufferToText(buf: Buffer, charset: string | undefined): string {
  const cs = (charset || "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

// ── Content-Type / Content-Disposition parameter parsing ─────────────────────────────

/** Split on `;` outside of double quotes, so a quoted parameter value may contain `;` safely. */
function splitHeaderParams(value: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ";" && !inQuotes) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * Parse a `type/subtype; param=value; param2="quoted value"`-shaped header (Content-Type or
 * Content-Disposition both use this grammar) into its bare main value and a param map. Param
 * names are lowercased (they are tokens, e.g. `boundary`/`filename`/`charset`); param VALUES
 * are left exactly as written, since a boundary or filename is case-sensitive.
 */
function parseHeaderParams(value: string): { value: string; params: Record<string, string> } {
  if (!value) return { value: "", params: {} };
  const parts = splitHeaderParams(value);
  const main = (parts.shift() ?? "").trim();
  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    // RFC 2231 continuation params (`filename*0`, `filename*1`, ...) collapse onto the base
    // name — a crude but safe approximation; the parser never needs the split-encoding case.
    const name = part.slice(0, eq).trim().toLowerCase().replace(/\*\d*$/, "");
    let val = part.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (name) params[name] = val;
  }
  return { value: main, params };
}

// ── multipart boundary splitting ──────────────────────────────────────────────────────

/**
 * Split a multipart body into its raw parts on a boundary (RFC 2046 §5.1.1). Text before the
 * first boundary line (the preamble) and after the closing `--boundary--` (the epilogue) is
 * discarded — neither is a MIME part. An UNTERMINATED multipart (no closing delimiter line, a
 * hostile or truncated message) still yields whatever trailing part it was mid-collection when
 * the input ran out, rather than silently dropping it — that's the `if (current)` flush after
 * the loop.
 */
function splitMultipart(body: string, boundary: string): string[] {
  if (!boundary) return [];
  const open = `--${boundary}`;
  const close = `${open}--`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed === close) {
      if (current !== null) parts.push(current.join("\n"));
      current = null;
      break;
    }
    if (trimmed === open) {
      if (current !== null) parts.push(current.join("\n"));
      current = [];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) parts.push(current.join("\n"));
  return parts;
}

// ── part tree walk ─────────────────────────────────────────────────────────────────────

interface PartWalkState {
  text: string | null;
  html: string | null;
  attachments: MimeAttachment[];
  partsSeen: number;
}

/**
 * Walk one MIME part (which, at `depth === 0`, is the whole message — a non-multipart message
 * is just a one-part tree, which is why {@link parseMime} does not need a separate code path
 * for it). Recurses into `multipart/*` children and records leaves: the first `text/plain` and
 * first `text/html` bodies win their slot, everything flagged as an attachment (a `Content-
 * Disposition: attachment`, or any part carrying a filename) becomes metadata-only in
 * `attachments`, and anything else (an inline part with neither) is dropped rather than
 * invented into a category it didn't ask for.
 *
 * The two bounds that make this safe over hostile input: `state.partsSeen` stops the walk once
 * {@link MAX_PARTS} parts have been touched anywhere in the tree, and `depth >= MAX_DEPTH`
 * stops recursion into a `multipart/*` container without touching its children — both checks
 * fire before any recursive call, so neither the part count nor the call stack can be driven
 * unbounded by a message that nests or repeats parts maliciously.
 */
function walkPart(headerText: string, bodyText: string, depth: number, state: PartWalkState): void {
  if (state.partsSeen >= MAX_PARTS) return;
  state.partsSeen++;

  const headers = parseHeaderBlock(headerText);
  const { value: rawType, params: ctParams } = parseHeaderParams(headers["content-type"] ?? "");
  const type = (rawType || "text/plain").toLowerCase();
  const disposition = parseHeaderParams(headers["content-disposition"] ?? "");
  const encoding = headers["content-transfer-encoding"] ?? "";
  const filename = decodeEncodedWords(disposition.params.filename ?? ctParams.name ?? "");
  const isAttachment = disposition.value.trim().toLowerCase() === "attachment" || filename.length > 0;

  if (type.startsWith("multipart/")) {
    if (depth >= MAX_DEPTH) return;
    const boundary = ctParams.boundary;
    if (!boundary) return;
    for (const rawPart of splitMultipart(bodyText, boundary)) {
      if (state.partsSeen >= MAX_PARTS) break;
      const split = splitHeadersAndBody(rawPart);
      walkPart(split.headerText, split.bodyText, depth + 1, state);
    }
    return;
  }

  const decoded = decodePartBody(bodyText, encoding);

  if (isAttachment) {
    state.attachments.push({ filename, contentType: type || "application/octet-stream", size: decoded.length });
    return;
  }
  if (type === "text/plain" && state.text === null) {
    state.text = bufferToText(decoded, ctParams.charset);
  } else if (type === "text/html" && state.html === null) {
    state.html = bufferToText(decoded, ctParams.charset);
  }
}

// ── addresses ──────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Extract the bare addr-spec from a single From/To-shaped value: prefer the contents of an
 * angle-bracket pair (`Ada <ada@example.com>`) when present, since a display name can itself
 * contain something that looks like an address; otherwise scan the whole value. Returns "" for
 * anything that doesn't contain a plausible address, rather than throwing on garbage.
 */
/**
 * Index of the first `<` that is NOT inside a quoted display name, or -1.
 *
 * RFC 5322 lets a display name be a quoted string containing anything, angle brackets included.
 * A naive "first `<...>` wins" scan therefore reads the WRONG address out of
 * `"Admin <admin@0xbeckett.me>" <attacker@evil.example>` — and `fromAddress` is what `mail ls`
 * prints in its FROM column and `mail read` labels `From-Address`, so a sender could choose the
 * address Beckett displays as authoritative, including one on Beckett's own domain. Verified
 * against the real function before this existed.
 */
function firstUnquotedAngle(value: string): number {
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\") {
      i++; // an escaped character inside a quoted string is never a delimiter
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "<" && !quoted) return i;
  }
  return -1;
}

export function parseAddress(value: string): string {
  if (!value) return "";
  // Clip before the regex runs. parseAddress is exported and reachable with a value that did
  // not come through {@link MAX_HEADER_VALUE}, and EMAIL_RE backtracks quadratically on a long
  // run with no usable "@" - see the note on MAX_HEADER_VALUE.
  const bounded = value.slice(0, MAX_HEADER_VALUE);
  const open = firstUnquotedAngle(bounded);
  const close = open === -1 ? -1 : bounded.indexOf(">", open + 1);
  // Prefer the real angle-addr; fall back to scanning the whole value when there isn't one.
  const scope = open !== -1 && close !== -1 ? bounded.slice(open + 1, close) : bounded;
  const match = EMAIL_RE.exec(scope);
  return match ? match[0] : "";
}

/**
 * Split a comma-separated address-list header into its individual entries before extracting
 * each address. The split respects quoted display names and angle-bracket groups so a comma
 * inside `"Doe, Ada" <ada@example.com>` or inside a quoted string doesn't fracture one address
 * into two — same defensive posture as {@link splitHeaderParams}.
 */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuotes = false;
  let angleDepth = 0;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes) {
      if (ch === "<") angleDepth++;
      if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    }
    if (ch === "," && !inQuotes && angleDepth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function parseAddressList(value: string): string[] {
  if (!value) return [];
  return splitAddressList(value)
    .map((part) => parseAddress(part))
    .filter((addr) => addr.length > 0);
}

// ── misc header fields ─────────────────────────────────────────────────────────────────

/** Message-ID with its angle brackets stripped; "" for an absent or already-bare value. */
function stripAngleBrackets(value: string): string {
  const trimmed = value.trim();
  const m = /^<(.+)>$/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

/**
 * Parse an RFC 5322 Date header to an ISO string. `Date.parse` already understands the RFC
 * 2822 date grammar this header uses, so this is a thin, defensive wrapper: anything it can't
 * make sense of (absent, garbled, a sender that sent free text) returns "" instead of the
 * `Invalid Date` string a naive `new Date(...).toISOString()` would throw on.
 */
function parseDateHeader(value: string): string {
  if (!value.trim()) return "";
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

// ── entry point ────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw RFC 5322 / MIME message into a structured, best-effort {@link ParsedMime}. Every
 * field has a safe default (`""`, `[]`, `{}`) so a malformed or partial message never produces
 * `undefined`/`null` surprises downstream — callers can treat every field as always-present.
 *
 * Line endings are normalized to `\n` up front (CRLF and bare CR both collapse to LF), which is
 * what lets every other function in this module — header unfolding, the blank-line split,
 * quoted-printable soft breaks, multipart boundary matching — work against one line-ending
 * convention instead of juggling both throughout.
 *
 * This function is the load-bearing promise of the module: see the file header for why it must
 * never throw, no matter how hostile `raw` is.
 */
export function parseMime(raw: string): ParsedMime {
  const normalized = (typeof raw === "string" ? raw : "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const { headerText, bodyText } = splitHeadersAndBody(normalized);
  const headers = parseHeaderBlock(headerText);

  const state: PartWalkState = { text: null, html: null, attachments: [], partsSeen: 0 };
  walkPart(headerText, bodyText, 0, state);

  return {
    headers,
    from: decodeEncodedWords(headers.from ?? ""),
    to: parseAddressList(headers.to ?? ""),
    cc: parseAddressList(headers.cc ?? ""),
    subject: decodeEncodedWords(headers.subject ?? ""),
    date: parseDateHeader(headers.date ?? ""),
    messageId: stripAngleBrackets(headers["message-id"] ?? ""),
    text: state.text ?? "",
    html: state.html ?? "",
    attachments: state.attachments,
  };
}
