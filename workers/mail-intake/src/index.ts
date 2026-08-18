/**
 * Beckett — inbound mail bridge (`workers/mail-intake/src/index.ts`)
 * =======================================================================================
 * Cloudflare Email Routing delivers mail addressed to anything @0xbeckett.me to this
 * Worker. Beckett itself lives on a home box behind a Cloudflare tunnel — it has no public
 * SMTP surface — so this Worker's entire job is to take the message Cloudflare handed it,
 * wrap it in a signed JSON envelope, and POST it once to Beckett's intake endpoint over
 * HTTPS. Nothing more.
 *
 * This is a DUMB SIGNED PIPE, on purpose. It never follows a link in the message, never
 * fetches anything the message references, and never parses or acts on the body — all of
 * that judgment belongs to Beckett's own intake handler, which can be reasoned about,
 * tested, and changed without touching Cloudflare Worker config. The Worker's only two
 * jobs are: don't let an oversized message run this isolate out of memory, and prove to
 * the intake endpoint (via HMAC) that the message really came from here, so anyone who
 * finds the intake URL can't forge inbound mail.
 *
 * Failure is loud, not silent, and the DISTINCTION matters. An oversized message can never
 * succeed, so it gets `message.setReject(...)` — a permanent rejection. Everything else (the POST
 * failing, a non-2xx from the intake endpoint, a broken stream) is transient, so the handler
 * THROWS instead: an uncaught error is a soft failure that earns a retry, whereas `setReject`
 * would hard-bounce mail that a restarting daemon would have accepted a minute later.
 */

/** Hard cap on the raw MIME message this Worker will buffer, in bytes (1 MB). */
const MAX_RAW_BYTES = 1_000_000;

/**
 * Minimal local shape of the Cloudflare Email Workers `EmailMessage`. This repo does not
 * depend on `@cloudflare/workers-types`, so only the surface this file actually touches is
 * declared here — see https://developers.cloudflare.com/email-routing/email-workers/.
 */
interface EmailMessage {
  /** Envelope sender (MAIL FROM), not necessarily the `From:` header. */
  readonly from: string;
  /** Envelope recipient (RCPT TO) — the @0xbeckett.me address that was mailed. */
  readonly to: string;
  /** Parsed headers of the message, as a standard `Headers` object. */
  readonly headers: Headers;
  /** The raw, unparsed MIME message as a byte stream. */
  readonly raw: ReadableStream<Uint8Array>;
  /** Size in bytes of `raw`, reported up front by the runtime before it's read. */
  readonly rawSize: number;
  /** Reject the message — the sending MTA sees a bounce/retry, not silent success. */
  setReject(reason: string): void;
}

/** Minimal local shape of the Workers `ExecutionContext`. */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface Env {
  /** Beckett's intake endpoint. A plain var — see `wrangler.jsonc`. */
  BECKETT_INTAKE_URL: string;
  /**
   * HMAC-SHA256 signing key shared with Beckett's intake endpoint. A Worker *secret*
   * (`wrangler secret put BECKETT_MAIL_INTAKE_SECRET`) — never hardcoded, never committed.
   */
  BECKETT_MAIL_INTAKE_SECRET: string;
}

/** Exact wire shape POSTed to `BECKETT_INTAKE_URL`. Keep in sync with the README. */
interface IntakeBody {
  v: 1;
  ts: number;
  envelopeFrom: string;
  envelopeTo: string;
  headers: Record<string, string>;
  raw: string;
}

/**
 * Read `stream` up to `capBytes`. Returns the bytes read if the stream ended at or under
 * the cap, or `null` if it would exceed the cap — in which case reading stops immediately
 * (the reader is canceled) instead of draining the rest of an oversized message into
 * memory.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  capBytes: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > capBytes) {
      // Over the cap — stop pulling immediately, don't drain the rest of the stream.
      await reader.cancel("beckett-mail-intake: message exceeds size cap");
      return null;
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/** Every header on the message, lowercased. Duplicate names are joined with `", "`. */
function collectHeaders(headers: Headers): Record<string, string> {
  // Null-prototype: `"constructor" in {}` is TRUE, so a plain object literal would take the join
  // branch for a sender-chosen header named `Constructor` and splice Object.prototype's own
  // property into the value that then gets signed and POSTed. The map is attacker-keyed.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawKey, value] of headers) {
    const key = rawKey.toLowerCase();
    out[key] = key in out ? `${out[key]}, ${value}` : value;
  }
  return out;
}

/** Hex-encoded HMAC-SHA256 of `body`, keyed by `secret`. WebCrypto only — no dependency. */
async function signHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export default {
  async email(message: EmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      // Fast path: the runtime already knows the size before we read anything.
      if (message.rawSize > MAX_RAW_BYTES) {
        message.setReject("Message too large");
        return;
      }

      const rawBytes = await readCapped(message.raw, MAX_RAW_BYTES);
      if (rawBytes === null) {
        message.setReject("Message too large");
        return;
      }
      // Known limitation: the envelope is JSON, so the raw message travels as text. A body that
      // is raw 8-bit in a legacy charset (rather than base64/quoted-printable, which Beckett's
      // parser decodes itself) loses those bytes to U+FFFD here. Modern mail is unaffected;
      // carrying the raw message base64-encoded would be the fix if it ever bites.
      const raw = new TextDecoder("utf-8").decode(rawBytes);

      const body: IntakeBody = {
        v: 1,
        ts: Date.now(),
        envelopeFrom: message.from,
        envelopeTo: message.to,
        headers: collectHeaders(message.headers),
        raw,
      };
      const bodyJson = JSON.stringify(body);
      const signature = await signHex(env.BECKETT_MAIL_INTAKE_SECRET, bodyJson);

      // Await the POST before deciding reject/accept. `ctx.waitUntil` is deliberately
      // unused here: handing this off to the background would let the handler return
      // (and the sending MTA treat the mail as accepted) before we know delivery actually
      // succeeded, which defeats the whole point of rejecting on failure below.
      const response = await fetch(env.BECKETT_INTAKE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Beckett-Signature": signature,
          "X-Beckett-Timestamp": String(body.ts),
        },
        body: bodyJson,
      });

      if (!response.ok) {
        // THROW, do not setReject. `setReject` is a PERMANENT rejection: the sender gets a hard
        // bounce and never tries again. A Beckett that is restarting, or a tunnel that is briefly
        // down, is transient — hard-bouncing real mail for it would lose the message for good.
        // An uncaught error in an email handler is a soft failure, which is what earns the retry.
        throw new Error(`intake returned ${response.status}`);
      }
    } catch (err) {
      // Rethrow rather than reject, for the same reason: network failure, a WebCrypto failure or a
      // broken stream are all conditions that may well succeed on the next attempt.
      throw err instanceof Error ? err : new Error(String(err));
    }
  },
};
