# beckett-mail-intake

The inbound email bridge. Cloudflare Email Routing delivers mail addressed to anything
`@0xbeckett.me` to this Worker; the Worker forwards it, signed, to Beckett's intake endpoint
over HTTPS. Beckett runs on a home box behind a Cloudflare tunnel with no public SMTP
surface, so this is the only way inbound mail reaches it.

This Worker is a **dumb signed pipe**. It never follows a link in the message, never fetches
anything the message references, and never parses or acts on the body — it just reads the
raw MIME (capped at 1 MB), signs it, and POSTs it once. All judgment about what the mail
means lives in Beckett's own intake handler on the other end.

## Request contract

One `POST` per inbound message, to `env.BECKETT_INTAKE_URL`:

- `content-type: application/json`
- `X-Beckett-Signature`: hex-encoded HMAC-SHA256 of the exact request body, keyed by
  `BECKETT_MAIL_INTAKE_SECRET`
- `X-Beckett-Timestamp`: the same `ts` (ms epoch) that's inside the body, so a receiver can
  reject stale/replayed requests

Body (exact shape, HMAC-signed as written — the `ts` field is what makes the signature cover
the timestamp too):

```json
{
  "v": 1,
  "ts": 1755450000000,
  "envelopeFrom": "someone@example.com",
  "envelopeTo": "you@0xbeckett.me",
  "headers": { "subject": "...", "from": "...", "...": "..." },
  "raw": "<the full raw MIME message, as UTF-8 text>"
}
```

`headers` contains every header on the message, lowercased; `raw` is the untouched raw MIME.

Failure handling distinguishes permanent from transient, and the difference matters:

- **Over 1 MB** → `message.setReject("Message too large")`, and it never POSTs. A permanent
  rejection is correct: that message can never fit, so retrying it is pointless.
- **POST failed, threw, or came back non-2xx** → the handler **throws**. An uncaught error in an
  email handler is a *soft* failure, so the sending MTA retries. `setReject` here would be wrong:
  it hard-bounces the mail, losing a message that a restarting daemon would have accepted a minute
  later.

## Deploy

```
cd workers/mail-intake && wrangler deploy
```

This repo deploys Workers with `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` already in
the environment, so no `wrangler login` is needed.

## Secret

```
wrangler secret put BECKETT_MAIL_INTAKE_SECRET
```

`BECKETT_INTAKE_URL` is a plain var, already set in `wrangler.jsonc`.
`BECKETT_MAIL_INTAKE_SECRET` must be set with the command above — it is never committed and
has no default.

## Manual admin step (not self-serviceable today)

Deploying this Worker does **not** make mail flow to it. Someone with dashboard access (or a
better-scoped token) still has to:

1. Enable Cloudflare Email Routing on the `0xbeckett.me` zone.
2. Add a routing rule that sends the chosen address (e.g. catch-all, or a specific address)
   to this Worker (`beckett-mail-intake`).

This can't be done with the API token currently injected for `beckett dns` / `beckett
deploy`: it returns `Authentication error (code 10000)` on `/zones/{zone}/email/routing*`,
i.e. it lacks the `Zone:Email Routing` permission. Until that permission is added to the
token (or someone does this by hand), it has to happen in the Cloudflare dashboard.

**Warning:** enabling Email Routing on this zone REPLACES its current MX records. Today
`0xbeckett.me` MX points at Namecheap's email forwarding (`eforward1..5.registrar-servers.com`),
so turning on Email Routing stops that existing forwarding — whoever does this step should
confirm nothing still depends on the Namecheap forwarding first.
