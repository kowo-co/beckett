/**
 * Beckett — the inbound-mail intake endpoint (`src/mail/intake.ts`)
 * =======================================================================================
 * The one door inbound email comes through. A Cloudflare Email Worker (`workers/mail-intake/`)
 * receives mail for addresses on this instance's domain, signs the raw message, and POSTs it
 * here; this module authenticates that POST, decides whether to keep the message, stores it, and
 * hands a bounded summary to the notifier. It is modeled on {@link ../secret/intake.ts}: a
 * loopback `Bun.serve` whose handler is factored out so the whole pipeline is testable without
 * ever opening a socket.
 *
 * This is the most exposed surface in the daemon, so the ordering of its checks is deliberate and
 * each one is cheap before the one after it:
 *
 *   1. **Method + path.** Anything but `POST /intake` is a 404. No GET surface exists to probe.
 *   2. **Size.** `maxRequestBodySize` refuses an oversized body at the socket, and the handler
 *      re-checks {@link MAX_RAW_BYTES} after parsing so a small envelope claiming a huge `raw`
 *      is still rejected.
 *   3. **Signature.** HMAC-SHA256 over the exact request bytes, compared with `timingSafeEqual`.
 *      An unsigned or wrongly-signed POST never reaches the parser, so the MIME parser is not an
 *      unauthenticated attack surface.
 *   4. **Freshness.** The signed timestamp must be within {@link REPLAY_WINDOW_MS}, so a captured
 *      body cannot be replayed later.
 *   5. **Rate.** Per-sender and global sliding windows, so one sender cannot generate unbounded
 *      turns and the box cannot be flooded by many senders either.
 *   6. **Dedupe.** A byte-identical redelivery computes the same record id and is accepted
 *      silently without a second notification — an MTA retry must never become two turns.
 *   7. **Classify.** {@link classifyMail} quarantines obvious junk. A quarantined message is
 *      still STORED (evidence, and a silent drop is indistinguishable from a bug) but never
 *      notifies.
 *
 * Two things this module deliberately never does. It never fetches anything — there is no outbound
 * request anywhere in this file, so a tracking pixel or a link in a message cannot be resolved by
 * receiving it. And it never acts on content: the only thing it does with a parsed body is store
 * it and pass a bounded snippet to the notifier, which quotes it as untrusted data.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { parseMime, parseAddress } from "./mime.ts";
import {
  buildMailRecord,
  mailRecordExists,
  writeMailRecord,
  type MailRecord,
} from "./store.ts";
import { mailNotificationFields } from "./render.ts";
import type { Logger } from "../types.ts";

/** The shared secret the Email Worker signs with. No secret, no listener — intake stays off. */
export const MAIL_INTAKE_SECRET_ENV = "BECKETT_MAIL_INTAKE_SECRET";
/** Loopback port the intake listener binds. The Cloudflare tunnel fronts it. */
const MAIL_INTAKE_PORT_ENV = "BECKETT_MAIL_INTAKE_PORT";
const DEFAULT_MAIL_INTAKE_PORT = 8788;
/** The address on this instance's domain that mail is delivered to. */
const MAIL_INTAKE_ADDRESS_ENV = "BECKETT_MAIL_INTAKE_ADDRESS";
const DEFAULT_MAIL_INTAKE_ADDRESS = "beckett@0xbeckett.me";

type IntakeEnv = Record<string, string | undefined>;

/** The address mail arrives at. Overridable so a fork is not pinned to this install's domain. */
export function resolveIntakeAddress(env: IntakeEnv = process.env): string {
  return env[MAIL_INTAKE_ADDRESS_ENV]?.trim() || DEFAULT_MAIL_INTAKE_ADDRESS;
}

/** The loopback port, validated. An unusable value falls back rather than crashing the daemon. */
export function resolveIntakePort(env: IntakeEnv = process.env): number {
  const raw = Number(env[MAIL_INTAKE_PORT_ENV]?.trim());
  return Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : DEFAULT_MAIL_INTAKE_PORT;
}

/** Hard cap on a single message, matching the Worker's own cap. 1 MB of email is already a lot. */
export const MAX_RAW_BYTES = 1_000_000;
/**
 * Cap on the whole POST body. Generous on purpose: the Worker JSON-escapes the raw message, and a
 * message dense in quotes, backslashes or control characters can inflate several times over on the
 * wire. Sizing this at 64 KB of slack would have let Bun refuse a LEGITIMATE 1 MB message at the
 * socket, before the handler could even see it. The real per-message limit is MAX_RAW_BYTES, which
 * is enforced on the decoded value.
 */
const MAX_BODY_BYTES = MAX_RAW_BYTES * 4;
/** How far out of date a signed timestamp may be before it reads as a replay. */
export const REPLAY_WINDOW_MS = 5 * 60_000;
/** Sliding rate-limit window. */
const RATE_WINDOW_MS = 60 * 60_000;
/** Messages accepted per sender per {@link RATE_WINDOW_MS}. */
const RATE_PER_SENDER = 20;
/** Messages accepted overall per {@link RATE_WINDOW_MS}. */
const RATE_GLOBAL = 300;

/** The signed request body the Email Worker POSTs. Nothing else is accepted. */
export interface MailIntakePayload {
  v: number;
  ts: number;
  envelopeFrom: string;
  envelopeTo: string;
  headers: Record<string, string>;
  raw: string;
}

/**
 * Read the POST body into the payload shape, returning null for anything malformed. Like every
 * other parse boundary in Beckett, unknown keys are dropped rather than carried forward.
 */
export function parseIntakePayload(raw: unknown): MailIntakePayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return null;
  if (typeof r.raw !== "string") return null;
  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === "object" && !Array.isArray(r.headers)) {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
  }
  return {
    v: 1,
    ts: r.ts,
    envelopeFrom: typeof r.envelopeFrom === "string" ? r.envelopeFrom : "",
    envelopeTo: typeof r.envelopeTo === "string" ? r.envelopeTo : "",
    headers,
    raw: r.raw,
  };
}

/**
 * Constant-time signature check over the EXACT request bytes. Comparing the hex digests as
 * buffers of equal length keeps the comparison timing-independent; a malformed or wrong-length
 * signature is rejected before `timingSafeEqual` is reached, since that call throws on a length
 * mismatch rather than returning false.
 */
export function verifyIntakeSignature(bodyText: string, signature: string, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(bodyText, "utf8").digest("hex");
  const a = Buffer.from(signature.trim().toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A sliding-window counter, per key plus a global bucket. Held in memory on purpose: a restart
 * clearing the window is acceptable (it costs at most one extra window of mail), whereas a
 * durable counter would mean a disk write per delivery attempt, which is itself a flood target.
 */
export class MailRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perSender = RATE_PER_SENDER,
    private readonly global = RATE_GLOBAL,
    private readonly windowMs = RATE_WINDOW_MS,
  ) {}

  private prune(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    // Drop the bucket entirely once it empties. Writing back an empty array would leak one Map
    // entry per distinct envelope sender, forever, on a long-lived daemon.
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  /** Record a hit, creating the bucket if {@link prune} just reclaimed it. */
  private record(key: string, now: number): void {
    const bucket = this.hits.get(key);
    if (bucket) bucket.push(now);
    else this.hits.set(key, [now]);
  }

  /** True when this sender may deliver now. Records the hit when it returns true. */
  allow(sender: string, now: number = Date.now()): boolean {
    const key = `s:${sender.toLowerCase()}`;
    if (this.prune("*", now).length >= this.global) return false;
    if (this.prune(key, now).length >= this.perSender) return false;
    this.record(key, now);
    this.record("*", now);
    return true;
  }
}

/** The verdict on a message: keep it and notify, or keep it quarantined and stay quiet. */
export interface MailClassification {
  quarantine: boolean;
  reasons: string[];
}

/**
 * Decide whether a message is obvious junk, using only signals the RECEIVING infrastructure
 * added (`Authentication-Results`, `X-Spam-*`) or structural facts about the envelope.
 *
 * Deliberately NOT a content classifier. Judging a body by what it says would mean reading
 * attacker-authored prose to make a decision, which is the exact behavior the rest of this
 * feature exists to prevent — and it would give false confidence besides. The fence in
 * {@link ./render.ts}, not this function, is what makes a hostile body safe.
 */
export function classifyMail(headers: Record<string, string>, envelopeFrom: string): MailClassification {
  const reasons: string[] = [];
  const get = (name: string): string => (headers[name] ?? "").toLowerCase();
  /**
   * Both header collectors JOIN a repeated header with ", ", so an anchored test against the whole
   * value silently stops matching the moment a sender adds a second copy of the header — a free
   * quarantine bypass. Test each comma-separated token instead.
   */
  const anyToken = (name: string, re: RegExp): boolean =>
    get(name).split(",").some((token) => re.test(token.trim()));

  // A null envelope sender is a bounce or auto-reply, never a correspondent to answer.
  if (!envelopeFrom.trim() || envelopeFrom.trim() === "<>") reasons.push("null envelope sender (bounce or auto-reply)");

  const auth = get("authentication-results");
  if (auth) {
    const dmarcFail = /dmarc=(fail|softfail)/.test(auth);
    const spfFail = /spf=(fail|softfail)/.test(auth);
    const dkimFail = /dkim=(fail|none)/.test(auth);
    if (dmarcFail) reasons.push("DMARC failed at the receiving MTA");
    else if (spfFail && dkimFail) reasons.push("both SPF and DKIM failed at the receiving MTA");
  }

  if (anyToken("x-spam-flag", /^(yes|true)$/)) reasons.push("upstream marked X-Spam-Flag");
  const precedence = get("precedence");
  if (anyToken("precedence", /^(bulk|junk|list)$/)) reasons.push(`bulk mail (Precedence: ${precedence})`);
  if (anyToken("x-spam-status", /^yes\b/)) reasons.push("upstream marked X-Spam-Status: Yes");

  return { quarantine: reasons.length > 0, reasons };
}

/** What happened to one delivery, for the caller's log and the HTTP status. */
export type MailIntakeOutcome =
  | {
      kind: "stored";
      record: MailRecord;
      /**
       * The notification turn, already started and already error-handled. The HTTP handler
       * deliberately does NOT await it — see the note in {@link acceptMail}. Exposed so tests can
       * await the turn they are asserting on rather than racing it.
       */
      notified: Promise<void>;
    }
  | { kind: "quarantined"; record: MailRecord }
  | { kind: "duplicate"; id: string }
  | { kind: "rejected"; reason: string; status: number };

export interface MailIntakeDeps {
  /** Directory the records live in (`<beckettDir>/mail`). */
  mailDir: string;
  /** Shared secret the Worker signs with. Intake refuses to run without one. */
  secret: string;
  /** Called for an accepted, non-quarantined message. The ONLY outward effect of a delivery. */
  onAccepted?: (fields: { from: string; subject: string; snippet: string; messageId: string }) => Promise<void>;
  logger?: Logger;
  limiter?: MailRateLimiter;
  now?: () => number;
}

/**
 * The whole pipeline for one already-authenticated payload: rate limit, parse, classify, store,
 * notify. Split out from the HTTP handler so tests drive real messages through the real logic
 * without a socket, and so the ordering of the checks is readable in one screen.
 */
export async function acceptMail(payload: MailIntakePayload, deps: MailIntakeDeps): Promise<MailIntakeOutcome> {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter;

  if (payload.raw.length > MAX_RAW_BYTES) {
    return { kind: "rejected", reason: "message too large", status: 413 };
  }

  const envelopeFrom = payload.envelopeFrom.trim();
  if (limiter && !limiter.allow(envelopeFrom || "(null)", now())) {
    return { kind: "rejected", reason: "rate limited", status: 429 };
  }

  // The parser is total: it returns a best-effort result for hostile input rather than throwing.
  // The try/catch is belt-and-braces so a parser bug can never take the listener down.
  let parsed;
  try {
    parsed = parseMime(payload.raw);
  } catch (err) {
    deps.logger?.warn("mail intake: unparseable message", { error: (err as Error).message });
    return { kind: "rejected", reason: "unparseable message", status: 422 };
  }

  const headers = { ...parsed.headers, ...payload.headers };
  const classification = classifyMail(headers, envelopeFrom);

  const record = buildMailRecord({
    from: parsed.from,
    fromAddress: parseAddress(parsed.from) || envelopeFrom,
    envelopeFrom,
    envelopeTo: payload.envelopeTo,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    messageId: parsed.messageId,
    date: parsed.date,
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments,
    headers,
    sizeBytes: Buffer.byteLength(payload.raw, "utf8"),
    status: classification.quarantine ? "quarantined" : "new",
    spamReasons: classification.reasons,
    now: new Date(now()),
    // Digest the raw message so a retrying MTA lands on the same id instead of a second record.
    digestSource: payload.raw,
  });

  if (mailRecordExists(deps.mailDir, record.id)) {
    return { kind: "duplicate", id: record.id };
  }

  writeMailRecord(deps.mailDir, record);

  if (classification.quarantine) {
    deps.logger?.info("mail intake: quarantined", { id: record.id, reasons: classification.reasons });
    return { kind: "quarantined", record };
  }

  // The single outward effect of receiving mail: a queued, fenced SYSTEM turn. Nothing else is
  // triggered by an arriving message — in particular there is no send path reachable from here.
  //
  // Started but deliberately NOT awaited. `notifyIncomingEmail` runs a real model turn
  // (`Concierge.askUpdate` -> `pool.ask`), which queues behind whatever else the SYSTEM scope is
  // doing and routinely takes minutes. Awaiting it here would hold the Worker's POST open that
  // long, and the Cloudflare edge in front of this endpoint gives up around 100 seconds — the
  // Worker would then see a non-2xx and `setReject` a message that was already stored AND already
  // notified, bouncing mail that actually arrived. The record is durable before this line, so
  // responding first loses nothing.
  let notified: Promise<void> = Promise.resolve();
  if (deps.onAccepted) {
    notified = deps.onAccepted(mailNotificationFields(record)).catch((err: unknown) => {
      // The message is already durable; a notifier failure must not make the MTA retry and
      // duplicate it. Log and accept. Caught here so the un-awaited promise never rejects.
      deps.logger?.warn("mail intake: notification failed", { id: record.id, error: (err as Error).message });
    });
  }
  return { kind: "stored", record, notified };
}

/**
 * The HTTP handler, factored out of the server exactly as `createSecretHandler` is, so the
 * authentication and rejection paths are unit-testable against plain `Request` objects.
 */
export function createMailIntakeHandler(deps: MailIntakeDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/intake") {
      return new Response("not found\n", { status: 404 });
    }

    const bodyText = await req.text();
    if (bodyText.length > MAX_BODY_BYTES) {
      return new Response("payload too large\n", { status: 413 });
    }

    const signature = req.headers.get("x-beckett-signature") ?? "";
    if (!verifyIntakeSignature(bodyText, signature, deps.secret)) {
      deps.logger?.warn("mail intake: rejected an unsigned or mis-signed POST");
      return new Response("unauthorized\n", { status: 401 });
    }

    let payload: MailIntakePayload | null;
    try {
      payload = parseIntakePayload(JSON.parse(bodyText) as unknown);
    } catch {
      payload = null;
    }
    if (!payload) return new Response("bad payload\n", { status: 400 });

    // The timestamp is inside the signed body, so this check cannot be bypassed by editing a
    // header: changing `ts` invalidates the signature that was already verified above.
    if (Math.abs(now() - payload.ts) > REPLAY_WINDOW_MS) {
      deps.logger?.warn("mail intake: rejected a stale or future-dated payload");
      return new Response("stale payload\n", { status: 401 });
    }

    const outcome = await acceptMail(payload, deps);
    switch (outcome.kind) {
      case "rejected":
        return new Response(`${outcome.reason}\n`, { status: outcome.status });
      case "duplicate":
        return Response.json({ ok: true, outcome: "duplicate", id: outcome.id });
      case "quarantined":
        return Response.json({ ok: true, outcome: "quarantined", id: outcome.record.id });
      case "stored":
        return Response.json({ ok: true, outcome: "stored", id: outcome.record.id });
    }
  };
}

/**
 * Bind the intake listener on loopback. It is never exposed directly: the Cloudflare tunnel
 * fronts it, exactly as it fronts every other Beckett service, so the only thing that can reach
 * this port without going through Cloudflare is something already on this box.
 */
export function serveMailIntake(opts: MailIntakeDeps & { port: number; hostname?: string }): {
  stop: () => void;
  url: string;
  port: number;
} {
  if (!opts.secret) throw new Error("mail intake: refusing to listen without BECKETT_MAIL_INTAKE_SECRET");
  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port,
    // Refuse an oversized body at the socket, before a handler chunk is ever allocated.
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: createMailIntakeHandler(opts),
  });
  // `server.port` is optional in Bun's types (a unix-socket server has none); this one always
  // binds TCP, so fall back to the requested port rather than widening the return type.
  const port = server.port ?? opts.port;
  return { stop: () => server.stop(true), url: `http://${server.hostname}:${port}`, port };
}
