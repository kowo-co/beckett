# Cursor seat — what was verified against the live API, and what wasn't

Probed **2026-08-19 / 2026-08-20** against `api.cursor.com` with the account's own `CURSOR_API_KEY`
(an individual **Cursor Pro, $20/month** key — `apiKeyName: "Beckett access"`). `@cursor/sdk`
**1.0.28**.

The plan this implements (`docs/plans/cursor-implementer-seat.md`) left several questions open
because they could only be answered with a credential. This file records the answers, so nobody has
to re-derive them and nobody mistakes a guess for a measurement.

---

## 1. Auto Balance — **not available on this account.** Running plain Auto.

This is the headline finding, and it contradicts what the seat was asked for.

`GET /v1/models` returns exactly one Auto entry, and it has **no parameters at all**:

```json
{ "id": "default", "displayName": "Auto", "aliases": ["auto"],
  "variants": [ { "params": [], "displayName": "Auto", "isDefault": true } ] }
```

Across all **35** models the account exposes, **no model declares an `optimize_for` parameter**.
Requesting the documented Router id is refused outright:

```
model: { id: "auto-smart", params: [{ id: "optimize_for", value: "balanced" }] }
→ "Cannot use this model: auto-smart. Available models: default, grok-4.6, composer-2.5, …"
```

**The dangerous middle case, and why the code checks rather than assumes.** Asking for
`{ id: "auto", params: [{ id: "optimize_for", value: "balanced" }] }` is **accepted** by
`Agent.create` — because create validates the model *id*, not the params, and an undeclared param is
silently dropped. Sending that and calling it Auto Balance would have been a lie the system told
itself forever. So `src/drivers/cursor-model.ts` asks for Balance and then verifies the catalogue
actually *offers* it (the parameter declared **and** a shipped variant carrying the value); when it
doesn't, it degrades to plain Auto and says so — in the daemon log, on the run trace, and in the
handoff file.

**Auto Cost was not substituted, and structurally cannot be.** `REJECTED_OPTIMIZE_FOR` plus
`assertNotCostOptimized()` refuse any cost-optimized router value before the request is built, and a
test pins it against a catalogue whose *default* variant is Auto Cost.

**This resolves itself with no code change.** The preference is expressed as data, not a comment: the
day Cursor enables Router on an individual plan, the catalogue grows the variant and the seat starts
requesting Balance on the next run.

## 2. Local mode works, and it is the only mode that could work here

Verified with a real run in a scratch git repo: `Agent.create({ local: { cwd } })` reads and writes
the literal filesystem at `cwd`. The seat read `.beckett/spec.md`, rewrote its `## Checklist` with
concrete items, ticked them, wrote `src/greet.ts`, committed it via its shell tool, and returned a
clean done-signal.

The Cloud Agent API was never a candidate: `.beckett/` is git-excluded and never pushed, so a cloud
agent working off a pushed branch would never see the checklist it is contracted to fill in.

## 3. The done-signal comes back parseable — but it is not *constrained*

Claude's `--json-schema` is a hard grammar constraint. Cursor's SDK has no equivalent, so the shim
asks for the shape in prose. Observed on the live run, `RunResult.result` was exactly:

```json
{"done":true,"summary":"Added src/greet.ts …","filesChanged":["src/greet.ts"],"checksRun":null,"blocker":null}
```

Unfenced, no prose around it, first try. That is one sample, not a guarantee — the driver parses
leniently (raw / fenced / trailing object, same as `pi.ts`) and `null` remains a legitimate outcome
that falls back to summary text.

Note for anyone reading the stream: assistant output arrives as **deltas** (10 partial `assistant`
messages for that one JSON object), and local mode emitted **no `system` message at all**. The shim
therefore synthesizes the session handshake itself rather than waiting for one.

## 4. Cost reporting — `getUsage()` is not available on this plan

```
GET /v1/agents/{id}/usage → [feature_unavailable] This feature is not available for your account
```

So there is no server-reported dollar figure to reconcile against, which answers the plan's open
question §8.4 in the negative. Token counts *are* reported per turn (`RunResult.usage`), and the
observed run cost 23,525 in / 166 out / 17,280 cache-read for a trivial edit.

`config/model-rates.json` therefore carries a `cursor-auto` row flagged `estimate: true`, priced at
Cursor's published **Auto Cost** flat rate ($1.25 / $6 / $0.25 per Mtok) as the nearest documented
number. **It is an API-equivalent comparison rate, not money billed** — Pro is a flat subscription,
so the true marginal cost is zero until the allowance is spent. The row's `source` field says this
in full.

## 5. Quota exhaustion — **still undocumented, and still unobserved**

This is the one thing that could not be verified, because a quota wall cannot be produced on demand
and this account has not hit one.

What the SDK *does* surface, confirmed by probing: a `status` (401 for a bad key), a `code`, and an
`isRetryable` flag. There is no documented status, code, or header that separates "this month's
allowance is spent" from an ordinary 429 or a 5xx blip.

So `classifyCursorError` is a **conservative rule with an explicit cost asymmetry**, not a
measurement:

| Signal | Verdict |
|---|---|
| HTTP 402 | `quota` |
| 429 with `isRetryable: false` | `quota` |
| message matching usage-limit / out-of-credits / plan-limit language | `quota` |
| 429 otherwise, 5xx, network | `transient` (bounded retry) |
| 401/403, or auth-shaped text | `auth` (never a seat change) |
| "Cannot use this model…", 400/404 | `config` (our bug, never a seat change) |
| the *same* transient error three times | **escalated to `quota`** |

That last row is the fail-safe. Mistaking a real wall for a blip wedges a run against something that
will not move; mistaking a blip for a wall costs one free handoff to a seat that also works (Cursor
does not bill a rejected call). Every trigger writes the raw status/code/message into
`.beckett/cursor-handoff.md`, so **the first real production occurrence is what tightens this rule**
— against evidence rather than more guessing.

Verified live along the way: `[feature_unavailable]` must **not** read as transient (a bare
`/unavailable/` pattern matched it, and would have burned two retries and then escalated a
permanent, harmless answer into a seat change). The pattern is narrowed accordingly.

## 6. Confirmed error shapes

| Request | Response |
|---|---|
| `Agent.create` with a bogus key | `status: 401`, `isRetryable: false`, `"Invalid User API Key"` |
| `Agent.create` with an unknown model | no status, `"Cannot use this model: … Available models: …"` |
| `Agent.create` with `apiKey: ""` | **succeeds** — the SDK silently falls back to `process.env.CURSOR_API_KEY` |

That last one is worth knowing: an empty key is not an error, it is an implicit env read. The shim
passes the key explicitly *and* requires it in the environment.

---

## What is still unproven

- **The quota path has never run against a real Cursor quota wall.** It is covered by tests at three
  layers (the pure exit against a real git repo, the shim end-to-end with a mocked SDK, and the
  supervisor's routing) at both named failure points — before the first token and mid-run between
  checklist items — but simulated exhaustion is not observed exhaustion.
- **Auto's routing pool is named but not published.** Grok 4.6, Grok 4.5 and Composer 2.5 are the
  first-party models; which one Auto picks per request is not documented and cannot be targeted.
- **One live end-to-end run, on a trivial task.** It produced a real diff and a clean done-signal;
  it says nothing about how the seat handles a hard one.
- **No spec-gate parity in the harness itself.** `src/hooks/spec-gate.ts` is a Claude Stop-hook
  protocol Cursor has no equivalent of, so the shim evaluates the *same* pure decision function and
  replies with the block reason as a follow-up turn. Same rule and same 3-strike escape hatch, but
  enforced by the shim rather than by the harness — a wedged agent that ignores the reply is bounded
  by the wall-clock backstop, not by the gate.
