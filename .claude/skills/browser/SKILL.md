---
name: browser
description: Use for ANY browser / computer-use work — a live-site lookup, a signup, a login-and-do-something. Long tasks go to the dedicated BACKGROUND browser agent via `beckett browser` (watch it, steer it mid-run, stop it); a genuinely one-shot read can run inline via `beckett browser exec` while the browser is idle. Credentials inject from the jingle keychain without ever touching a transcript.
---

# browser — the browser lane

Two ways in, one persistent BetterWright browser:

- **Background agent** (`beckett browser "<task>"`) — default for anything with more than one
  step, anything needing credentials, and anything that might take a while. Dispatches a
  dedicated stateful agent and returns instantly.
- **Inline one-off** (`beckett browser exec "<js>"`) — ONE BetterWright script in your own
  turn, for a quick read of a live page when a session is free. No agent, no credentials.

## Dispatching the background agent

```
beckett browser "check https://example.com/status — is the API listed as degraded?"
beckett browser "log in to x.com and post the draft thread" --creds x.com \
  --context "Jason wants the thread up before 9am ET; casual tone; first post today"
beckett browser status        # live + recent runs (state, task, parked question)
```

- Returns **immediately** with a run id — ack the person, say it's in motion, end the turn.
- Write the task like a ticket one-liner: URL, goal, any email/name to use, what "done" looks
  like — everything the agent needs is IN the task text.
- `--context "<background>"` carries conversation color the agent should know but not treat as
  instructions (who asked, preferences, constraints, what was already tried).
- The run is locked to the channel that dispatched it.
- A dispatch always succeeds: it starts at once in its own browser session while concurrent
  capacity remains; past the concurrent-session cap it queues (the return carries its position)
  and starts automatically when a lane frees — surviving a daemon restart. Reply now that
  theirs is lined up; never re-dispatch the same task. A queued run can still be `watch`ed
  (state `queued`), `steer`ed (the note folds into its start), or `stop`ped before it runs.

## Observing and steering a live run

```
beckett browser watch <run-id>                 # state + activity journal + fresh page screenshot
beckett browser watch <run-id> --no-screenshot --tail 40
beckett browser steer <run-id> "use the annual plan, not monthly — the person just corrected it"
beckett browser stop  <run-id> --reason "person cancelled the request"
```

- **watch** returns the journal (every browser evaluation, active URL, questions, steers) and,
  while live, a screenshot path — Read it, or attach with `beckett discord reply --file <path>`.
- **steer** delivers guidance into the agent's next tool result; on a parked question, steering
  resumes it with your note (it re-asks if still blocked). Same-channel only.
- **stop** kills the run cleanly (state `cancelled`), releases its session, and still reports
  an outcome turn.

## Credentials — `--creds <jingle-entry>`

Pass the jingle keychain entry name. The daemon reads it and exposes a read-only `secrets`
object *inside the browser scripts* (`secrets.email`, `secrets.password`, `secrets.totp` minted
fresh per script), injected below every transcript and scrubbed from everything that flows
back — never paste a credential into task text or chat.

No entry yet? `beckett secret request --fields username,password --dest keychain --entry
<name> …` (see the `jingle` skill), then dispatch.

Credentials are background-lane only: `exec` gets no `secrets` object.

## Inline one-offs — `beckett browser exec`

```
beckett browser exec "await page.goto('https://example.com/status'); return snapshot()"
```

Ordinary BetterWright JavaScript with top-level `await`. Globals: `page`, `pages`, `openPage`,
`usePage`, `closePage`, `snapshot`, `screenshot`, `human`, `dialogs`, `overlays.dismiss`,
`captcha`. Inspect before acting — `snapshot({interactive:true})` first, `snapshot({diff:true})`
after actions — and act on `[ref=eN]` via `page.locator('aria-ref=eN')`; refs go stale on
re-render. Return plain data; screenshot paths come back in the result — Read one, or attach
with `--file`.

It runs in its own session beside background runs and refuses only when its own session is
busy or all concurrent browser lanes are full (watch/steer the occupying run instead). One
script, then the session releases — chaining several `exec` calls or needing a login is a
background dispatch. No credentials, no destructive actions — reads and trivial reversible
clicks only.

## While it runs: pause / surface / resume

When only a human can unblock it (a 2FA code, a credential no `secrets` field covers, a genuine
choice), the agent parks the session and posts **one** question in the origin channel with a
page screenshot. The person answers by **replying directly to that message** — the reply is
consumed and deleted (secrets never linger in chat), and the same session resumes where it
stalled. You do nothing to broker this; don't re-dispatch while a run is waiting. Guidance
rather than an answer to the question goes via `beckett browser steer`.

## The outcome

Completion, failure, cancellation, or timeout arrives back as a `browser-agent outcome` update
turn — including after a daemon restart (a durable ledger re-reports anything stranded). Relay
it in your voice with `beckett discord reply --channel <id>`; when the turn names a proof
screenshot, attach it with `--file <path>`. If it failed or timed out, say so plainly.

## When NOT to use

- Anything that isn't actually a browser task — quick lane or a ticket as usual.
- Owner-gated or destructive actions (payments, deletions) the request didn't authorize —
  bring those to the owner first.
