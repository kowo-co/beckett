/**
 * Beckett — the inbound mail store (`src/mail/store.ts`)
 * =======================================================================================
 * Durable, on-box records for mail that arrives at an address on this instance's own domain.
 * Modeled directly on the proposal queue ({@link ../proposal/store.ts}): a directory of JSON
 * FILES, one per message, read back through an explicit field list. It is deliberately inert.
 *
 * The containment is structural, not prompted — inbound email is the most hostile input this
 * daemon accepts, so the storage layer is built to make a malicious message boring:
 *
 *   - **A message is a record, never an instruction.** Nothing in this module can execute,
 *     dispatch, reply, or fetch. The only path it has to the filesystem is {@link mailPath},
 *     which resolves inside `<beckettDir>/mail` and refuses any id that isn't
 *     `mail-<32 hex>`. There is no "apply", "run", or "reply" verb here to call, so
 *     no sequence of calls against this module can reach one.
 *   - **Records are parsed, not trusted.** {@link asMailRecord} rebuilds a record from a fixed
 *     field list; every other key in the JSON on disk is dropped on the floor. A message that
 *     arranges for `{"status":"read","command":"rm -rf /"}` to be written is read back as an
 *     ordinary record with no extra powers, because those words are never looked up.
 *   - **Every string is bounded on the way in.** A sender does not get to choose how many bytes
 *     of my context they occupy: {@link MAIL_SUBJECT_MAX}, {@link MAIL_BODY_MAX} and friends clip
 *     at write time, so an enormous body cannot be used to push a system frame out of the window.
 *   - **Attachments are metadata, never bytes.** Filenames are sanitized to a leaf name; the
 *     content is never stored, so nothing here can later be executed or served.
 *   - **Nothing is deleted.** Quarantined spam keeps its record and its reasons — what was
 *     dropped is signal, and a silent drop is indistinguishable from a delivery bug.
 *
 * The rendering half ({@link ./render.ts}) is what decides how a record reaches a model, and it
 * is the ONLY place that fences. Keeping the two apart means the fence is one small file to audit.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * The id shape, and the traversal guard. A message id is a digest of the message itself and
 * NOTHING ELSE, so it is stable under redelivery: the same message re-posted by a retrying MTA
 * computes the same id and is recognized as a duplicate.
 *
 * The arrival date used to be part of it, which was a real bug — a retry that crossed UTC midnight
 * produced a different id, so it stored a second record and fired a second notification, exactly
 * the thing the dedupe exists to prevent. Ordering comes from `receivedAt`, which is what
 * {@link listMailRecords} sorts on anyway.
 *
 * `mailPath` rejects anything else, so an id read off a record — or out of a CLI argument, or out
 * of an email header — can never address a file outside the mail directory.
 */
export const MAIL_ID_RE = /^mail-[0-9a-f]{32}$/;

/** Where a record can be in its life. `quarantined` never notifies; it is kept for inspection. */
export const MAIL_STATUSES = ["new", "read", "quarantined"] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

// ── bounds ─────────────────────────────────────────────────────────────────────────────
// A sender chooses the bytes; I choose how many of them I am willing to hold. These are applied
// at write time so an oversized field can never reach the store, let alone a rendered frame.

/** Header-ish single-line fields (subject, from, one address). */
const MAIL_LINE_MAX = 998;
/** The subject specifically — bounded tighter because it is shown in every listing row. */
export const MAIL_SUBJECT_MAX = 512;
/** Each body (text and html-derived) as stored. */
export const MAIL_BODY_MAX = 256_000;
/** Recipients/cc kept per message. */
export const MAIL_ADDRESSES_MAX = 50;
/** Attachment metadata entries kept per message. */
const MAIL_ATTACHMENTS_MAX = 50;
/** Arbitrary headers retained per message. */
const MAIL_HEADERS_MAX = 100;
/** Quarantine reasons retained per message. */
const MAIL_REASONS_MAX = 20;

/** Attachment METADATA. The bytes are never stored, so nothing here can be executed or served. */
export interface MailAttachment {
  filename: string;
  contentType: string;
  size: number;
}

/** The parsed record. Every field here is read explicitly; anything else on disk is ignored. */
export interface MailRecord {
  id: string;
  /** ISO stamp this box accepted the message — my clock, never the sender's. */
  receivedAt: string;
  /** Raw `From` header value as sent, e.g. `Ada <ada@example.com>`. Display text: untrusted. */
  from: string;
  /** The bare addr-spec parsed out of `from`, lowercased. Still untrusted — trivially forged. */
  fromAddress: string;
  /** SMTP envelope sender, which the receiving MTA saw. Harder to forge than `from`. */
  envelopeFrom: string;
  /** The address on my domain this was delivered to. */
  envelopeTo: string;
  to: string[];
  cc: string[];
  subject: string;
  /** The sender's `Message-ID`, angle brackets stripped. Advisory only — never used as my id. */
  messageId: string;
  /** The sender's `Date` header as ISO, or "". Advisory: a sender can claim any time. */
  date: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
  headers: Record<string, string>;
  status: MailStatus;
  /** Why this was quarantined. Empty for a delivered message. */
  spamReasons: string[];
  /** Size of the raw message this record was parsed from. */
  sizeBytes: number;
}

/** What {@link buildMailRecord} needs. Everything else on the record is derived or defaulted. */
export interface CreateMailInput {
  from: string;
  fromAddress: string;
  envelopeFrom: string;
  envelopeTo: string;
  to: string[];
  cc: string[];
  subject: string;
  messageId: string;
  date: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
  headers: Record<string, string>;
  sizeBytes: number;
  status?: MailStatus;
  spamReasons?: string[];
  /** Explicit arrival stamp; defaults to now. */
  now?: Date;
  /**
   * The bytes the id digest is taken over. Defaults to a digest of the record's own identifying
   * fields. Callers pass the RAW message so redelivery of a byte-identical message is idempotent.
   */
  digestSource?: string;
}

// ── bounding helpers ───────────────────────────────────────────────────────────────────

/**
 * Every C0 control except tab, line feed and carriage return, plus DEL. These are display
 * attacks, not content: an ESC lets a sender repaint a terminal, and a NUL can truncate a
 * string in anything downstream that still thinks in C.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Line terminators that are NOT C0 controls, so the strip above leaves them alone, and that
 * JavaScript's \s does not fully cover either (it matches \u2028/\u2029 but NOT \u0085, NEL).
 * They matter because a header value is rendered ABOVE the untrusted-body fence: a subject
 * carrying a NEL used to emit a forged line at column 0 in the header block, which is Beckett's
 * own output. Verified against the real renderer; store.test.ts and render.test.ts pin it.
 */
const EXOTIC_LINE_BREAKS = /[\u0085\u2028\u2029]/g;

/** Collapse to one line and clip. Control characters are stripped: they are display attacks. */
function oneLine(value: string, max: number): string {
  return value
    .replace(CONTROL_CHARS, "")
    .replace(EXOTIC_LINE_BREAKS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Clip a body but keep its shape. Line endings are normalized to `\n` and the C0 controls that
 * are not tab/newline are stripped (a bare `\r` rewinds a terminal line, an ESC repaints it -
 * both are rendering attacks, not content). Everything else is preserved verbatim, because
 * mangling a body would make it useless as evidence.
 */
function boundedBody(value: string, max: number): string {
  const clean = value
    .replace(/\r\n?/g, "\n")
    // Normalized to a newline rather than stripped: these ARE line breaks, and the body is the
    // one place their break should survive - the fence gutters each resulting line.
    .replace(EXOTIC_LINE_BREAKS, "\n")
    .replace(CONTROL_CHARS, "");
  return clean.length > max ? `${clean.slice(0, max)}\n[... truncated by Beckett at ${max} characters]` : clean;
}

/** A sanitized leaf filename. A sender does not get to suggest a path, only a name. */
function safeFilename(value: string): string {
  const leaf = value.split(/[\\/]/).pop() ?? "";
  return oneLine(leaf, 200).replace(/^\.+/, "") || "(unnamed)";
}

function boundedAddresses(values: string[]): string[] {
  return values.slice(0, MAIL_ADDRESSES_MAX).map((v) => oneLine(v, MAIL_LINE_MAX)).filter(Boolean);
}

/** An ISO stamp, or "" — a sender's `Date` is advisory and must never become `Invalid Date`. */
function isoOrEmpty(value: string): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

// ── build ──────────────────────────────────────────────────────────────────────────────

/**
 * Mint a record from parsed input, bounding every field on the way in. The id is `mail-<digest>`
 * — deliberately free of any clock, so a byte-identical redelivery lands on the same filename no
 * matter when it arrives, rather than creating a duplicate record and a duplicate notification.
 */
export function buildMailRecord(input: CreateMailInput): MailRecord {
  const now = input.now ?? new Date();
  const digest = createHash("sha256")
    .update(input.digestSource ?? `${input.envelopeFrom}\n${input.messageId}\n${input.subject}\n${input.text}`)
    .digest("hex")
    .slice(0, 32);
  return {
    id: `mail-${digest}`,
    receivedAt: now.toISOString(),
    from: oneLine(input.from, MAIL_LINE_MAX),
    fromAddress: oneLine(input.fromAddress, MAIL_LINE_MAX).toLowerCase(),
    envelopeFrom: oneLine(input.envelopeFrom, MAIL_LINE_MAX).toLowerCase(),
    envelopeTo: oneLine(input.envelopeTo, MAIL_LINE_MAX).toLowerCase(),
    to: boundedAddresses(input.to),
    cc: boundedAddresses(input.cc),
    subject: oneLine(input.subject, MAIL_SUBJECT_MAX),
    messageId: oneLine(input.messageId, MAIL_LINE_MAX),
    date: isoOrEmpty(input.date),
    text: boundedBody(input.text, MAIL_BODY_MAX),
    html: boundedBody(input.html, MAIL_BODY_MAX),
    attachments: input.attachments.slice(0, MAIL_ATTACHMENTS_MAX).map((a) => ({
      filename: safeFilename(a.filename),
      contentType: oneLine(a.contentType, 200),
      size: Number.isFinite(a.size) && a.size >= 0 ? Math.floor(a.size) : 0,
    })),
    headers: Object.fromEntries(
      Object.entries(input.headers)
        .slice(0, MAIL_HEADERS_MAX)
        .map(([k, v]) => [oneLine(k, 200).toLowerCase(), oneLine(String(v), MAIL_LINE_MAX)])
        .filter(([k]) => Boolean(k)),
    ),
    status: input.status ?? "new",
    spamReasons: (input.spamReasons ?? []).slice(0, MAIL_REASONS_MAX).map((r) => oneLine(r, 200)).filter(Boolean),
    sizeBytes: Number.isFinite(input.sizeBytes) && input.sizeBytes >= 0 ? Math.floor(input.sizeBytes) : 0,
  };
}

// ── paths ──────────────────────────────────────────────────────────────────────────────

/**
 * Where records live. Declared here as a `default…(beckettDir)` helper rather than as a field on
 * {@link ../types.ts}'s `Paths`, matching `defaultMailStateFile` next door: new state locations in
 * this repo are resolved by the owning module and joined at the wiring site.
 */
export function defaultMailDir(beckettDir: string): string {
  return join(beckettDir, "mail");
}

/** The canonical record path for an id. Throws for anything that isn't a well-formed id. */
export function mailPath(mailDir: string, id: string): string {
  if (!MAIL_ID_RE.test(id)) {
    throw new Error(`mail: invalid id '${id}' (must be mail-<32 hex>)`);
  }
  return join(mailDir, `${id}.json`);
}

// ── read ───────────────────────────────────────────────────────────────────────────────

/** One record by id, or null when there is no readable record under that name. */
export function readMailRecord(mailDir: string, id: string): MailRecord | null {
  let path: string;
  try {
    path = mailPath(mailDir, id);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    return asMailRecord(id, JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export interface ListMailOptions {
  /** Include quarantined records too. Default: false — spam stays out of the default view. */
  includeQuarantined?: boolean;
  /** Only unread (`new`) records. */
  unreadOnly?: boolean;
  /** Cap the number returned, newest first. */
  limit?: number;
}

/**
 * Every readable record, newest first. Malformed files are deliberately absent, exactly like a
 * malformed proposal: the store degrades to the records it can actually parse rather than
 * throwing, because one hostile message must never break `mail ls` for every other message.
 */
export function listMailRecords(mailDir: string, opts: ListMailOptions = {}): MailRecord[] {
  if (!existsSync(mailDir)) return [];
  const found: MailRecord[] = [];
  let entries: string[];
  try {
    entries = readdirSync(mailDir);
  } catch {
    return [];
  }
  for (const file of entries) {
    const m = file.match(/^(mail-[0-9a-f]{32})\.json$/);
    if (!m) continue;
    const record = readMailRecord(mailDir, m[1]!);
    if (!record) continue;
    if (!opts.includeQuarantined && record.status === "quarantined") continue;
    if (opts.unreadOnly && record.status !== "new") continue;
    found.push(record);
  }
  found.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id.localeCompare(a.id));
  return opts.limit === undefined ? found : found.slice(0, Math.max(0, opts.limit));
}

/** How many unread messages are waiting. Cheap enough for a status line. */
export function unreadMailCount(mailDir: string): number {
  return listMailRecords(mailDir, { unreadOnly: true }).length;
}

// ── write ──────────────────────────────────────────────────────────────────────────────

/**
 * Persist a record atomically (tmp + rename, the repo's durable-state idiom), returning its path.
 * The tmp name carries the pid so two writers cannot collide on it. Mode 0600: mail is private.
 */
export function writeMailRecord(mailDir: string, record: MailRecord): string {
  const path = mailPath(mailDir, record.id);
  mkdirSync(mailDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** True when a record already exists for this id — the redelivery check the intake path makes. */
export function mailRecordExists(mailDir: string, id: string): boolean {
  try {
    return existsSync(mailPath(mailDir, id));
  } catch {
    return false;
  }
}

/**
 * Mark one message read. Returns the updated record, or null when there is no such record.
 * Deliberately the ONLY mutation this store exposes: nothing else about a delivered message can
 * be edited after the fact, so a stored message is evidence rather than mutable state. Marking a
 * quarantined record read is refused — clearing spam has to be a deliberate, separate act, not a
 * side effect of skimming a list.
 */
export function markMailRead(mailDir: string, id: string): MailRecord | null {
  const record = readMailRecord(mailDir, id);
  if (!record) return null;
  if (record.status === "quarantined") return record;
  if (record.status === "read") return record;
  const updated: MailRecord = { ...record, status: "read" };
  writeMailRecord(mailDir, updated);
  return updated;
}

// ── parse ──────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild a record from untrusted JSON. Every field is read explicitly and re-bounded; unknown
 * keys are dropped. The filename is the id — a record claiming a different one is malformed and
 * never followed, so a planted file cannot impersonate another message's id.
 */
function asMailRecord(id: string, raw: unknown): MailRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id !== id || !MAIL_ID_RE.test(id)) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const status = MAIL_STATUSES.includes(r.status as MailStatus) ? (r.status as MailStatus) : "new";
  const receivedAt = isoOrEmpty(str(r.receivedAt));
  if (!receivedAt) return null;
  const attachments = Array.isArray(r.attachments)
    ? r.attachments
        .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object" && !Array.isArray(a))
        .map((a) => ({
          filename: safeFilename(str(a.filename)),
          contentType: oneLine(str(a.contentType), 200),
          size: typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? Math.floor(a.size) : 0,
        }))
        .slice(0, MAIL_ATTACHMENTS_MAX)
    : [];
  const headers =
    r.headers && typeof r.headers === "object" && !Array.isArray(r.headers)
      ? Object.fromEntries(
          Object.entries(r.headers as Record<string, unknown>)
            .slice(0, MAIL_HEADERS_MAX)
            .map(([k, v]) => [oneLine(k, 200).toLowerCase(), oneLine(str(v), MAIL_LINE_MAX)])
            .filter(([k]) => Boolean(k)),
        )
      : {};
  return {
    id,
    receivedAt,
    from: oneLine(str(r.from), MAIL_LINE_MAX),
    fromAddress: oneLine(str(r.fromAddress), MAIL_LINE_MAX).toLowerCase(),
    envelopeFrom: oneLine(str(r.envelopeFrom), MAIL_LINE_MAX).toLowerCase(),
    envelopeTo: oneLine(str(r.envelopeTo), MAIL_LINE_MAX).toLowerCase(),
    to: boundedAddresses(list(r.to)),
    cc: boundedAddresses(list(r.cc)),
    subject: oneLine(str(r.subject), MAIL_SUBJECT_MAX),
    messageId: oneLine(str(r.messageId), MAIL_LINE_MAX),
    date: isoOrEmpty(str(r.date)),
    text: boundedBody(str(r.text), MAIL_BODY_MAX),
    html: boundedBody(str(r.html), MAIL_BODY_MAX),
    attachments,
    headers,
    status,
    spamReasons: list(r.spamReasons).slice(0, MAIL_REASONS_MAX).map((x) => oneLine(x, 200)).filter(Boolean),
    sizeBytes: typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) && r.sizeBytes >= 0 ? Math.floor(r.sizeBytes) : 0,
  };
}
