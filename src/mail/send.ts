/**
 * Beckett — the outbox (`src/mail/send.ts`)
 * =======================================================================================
 * Sending mail as an address on this instance's own domain. Deliberately the smallest possible
 * module: build a request, post it, return the provider's id.
 *
 * **Send is never automatic.** There is exactly one caller of {@link sendMail} — the `mail send`
 * CLI verb — and nothing on the intake path can reach it. `src/mail/intake.ts` imports nothing
 * from this file, and a test pins that (an arriving message must never be able to cause an
 * outgoing one, which is what turns an open inbox into an open relay for a prompt injection).
 *
 * **Provider: Resend** (https://resend.com). Chosen over Postmark/SES/Mailgun for three reasons
 * that matter here: its send API is a single JSON POST, so this file needs no SDK and the repo
 * takes no new dependency; its free tier covers this instance's volume without a card on file;
 * and it verifies a domain with ordinary SPF/DKIM/DMARC records, which the existing `beckett dns`
 * tooling can write. Swapping providers means changing {@link RESEND_ENDPOINT} and the request
 * body in {@link sendMail}, and nothing else.
 *
 * The key is read from the environment exactly as every other credential in this repo is
 * (`process.env`, populated from `~/.beckett/.env` at boot). It is never written to disk, never
 * logged, and {@link ../mail/index.ts}'s `safeMailError` scrubs it from any error that escapes.
 */

/** The env var the send path reads. Named in the failure message when it is absent. */
export const MAIL_SEND_SECRET_NAME = "RESEND_API_KEY";
/** The env var that overrides the default From address. */
const MAIL_FROM_ENV = "BECKETT_MAIL_FROM";
/** The address mail is sent as when {@link MAIL_FROM_ENV} is unset. */
export const DEFAULT_MAIL_FROM = "beckett@0xbeckett.me";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

type SendEnv = Record<string, string | undefined>;

/**
 * The provider key, or a throw that names the exact secret that is missing. The brief requires
 * the failure to be unambiguous: someone reading it should know precisely what to add and where,
 * without having to open the source.
 */
export function resolveSendKey(env: SendEnv = process.env): string {
  const key = env[MAIL_SEND_SECRET_NAME]?.trim();
  if (!key) {
    throw new Error(
      `${MAIL_SEND_SECRET_NAME} is not set — outbound mail needs it in ~/.beckett/.env. ` +
        `It is the only credential the send path reads; intake and the mail CLI's read verbs work without it.`,
    );
  }
  return key;
}

/** The address mail goes out as. Overridable so a fork is not pinned to this install's domain. */
export function resolveFromAddress(env: SendEnv = process.env): string {
  return env[MAIL_FROM_ENV]?.trim() || DEFAULT_MAIL_FROM;
}

export interface SendMailInput {
  to: string;
  subject: string;
  body: string;
  /** Overrides {@link resolveFromAddress} for one send. */
  from?: string;
  replyTo?: string;
}

export interface SendMailResult {
  id: string;
  from: string;
  to: string;
  subject: string;
}

/** Minimal seam so tests exercise the request shape and error handling without a network call. */
export type SendFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Post one message to the provider. Validation is done here rather than in the CLI so the
 * `mail.send` capability and the CLI verb cannot drift on what counts as a valid send.
 */
export async function sendMail(
  input: SendMailInput,
  opts: { apiKey: string; fetchImpl?: SendFetch } = { apiKey: "" },
): Promise<SendMailResult> {
  const to = input.to.trim();
  const subject = input.subject.trim();
  const body = input.body;
  if (!to) throw new Error("mail send requires --to <address>");
  if (!to.includes("@")) throw new Error(`mail send: '${to}' is not an email address`);
  if (!subject) throw new Error("mail send requires --subject <text>");
  if (!body.trim()) throw new Error("mail send requires --body <text> or --body-stdin");

  const from = (input.from ?? resolveFromAddress()).trim();
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await doFetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: body,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    // Surface the provider's own message — it is what says "domain not verified" — but keep it
    // on one line so a CLI failure stays greppable.
    throw new Error(`mail send failed (${response.status}): ${text.replace(/\s+/g, " ").trim().slice(0, 500)}`);
  }
  let id = "";
  try {
    const parsed = JSON.parse(text) as { id?: unknown };
    if (typeof parsed.id === "string") id = parsed.id;
  } catch {
    // A 2xx with an unparseable body still means the provider accepted it; report without an id.
  }
  return { id, from, to, subject };
}
