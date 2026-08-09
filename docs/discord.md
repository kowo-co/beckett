# Discord

Discord isn't a transport Beckett happens to use — it's the product. A person @mentions Beckett,
gets a reply in its voice, and if the ask is real work, one grey subtext line under the reply is
the only proof anything was filed. Everything else — the coding, the reviewing, the deciding —
happens off-channel and reports back through one editable card. v1 keeps that feel exactly and
rebuilds the machinery under it. See [orchestration.md](orchestration.md) for the Job/Event/Runner
model this surface files into, [initiative.md](initiative.md) for the one case where a card appears
with nobody having typed, and [token-efficiency.md](token-efficiency.md) for why the Wire is
the single biggest lever in the concierge cost attack.

**The Wire** is the Discord adapter: gateway in, cards out. **Seats** are the two agents that
speak through it — a Haiku front desk and a Sonnet mind, sharing one `persona.md`. Both terms are
used exactly as defined in the orchestration design; nothing here renames them.

---

## The invariants v1 keeps, byte-for-byte

These are load-bearing for "feels like a coworker, not a chatbot." Each is cheap (under 250 lines
in the current codebase), pure where it can be, and was tuned against a real incident, not a
guess. v1 ports them rather than re-deriving them.

- **No-thread filing + `-# filed` receipts.** Beckett never opens a thread for its own work. The
  only trace of a filing is one grey Discord subtext line stamped by code, never by the model —
  `-# filed j7` for one job, `-# filed jobs: j7, j8, j9` for a wave. Refs are validated against
  `/^j\d+(\.\d+)*$/`; `null` means *post nothing*, not an empty line. Why: it's the clearest single
  signature of restraint — the model narrating "filed as j7" itself would turn the receipt into
  something spoofable and chatty; stamping it in code after the reply is the only way the receipt
  stays trustworthy and quiet.
- **`&j7` / `&recent` / `&clear` thread attach.** The person, not Beckett, decides when work earns
  a thread. They open one themselves and claim it by posting a message whose *entire trimmed
  content* is `&j7` (a specific ref), `&recent` (their own most recently filed job), or `&clear`
  (detach). Why: `&` is an ordinary character in prose ("tom & jerry"); a lenient scan-anywhere
  parser would misfire on real sentences. The all-or-nothing parse is a lesson already paid for,
  not a guess.
- **Cancel-and-amend.** A same-author, same-channel message that plausibly amends a live turn —
  deterministic, non-model check: contains `?` or is ≥16 chars — cancels the in-flight reply and
  answers the amended question instead, with an explicit receipt ("scrapping my half-written reply
  to that — going with your latest"), never a silent drop. If the live turn has already called a
  tool, the new message folds in as a mid-flow note at the next tool boundary instead of losing
  real work. Why: the naive "always cancel" rule killed three real questions for 15 minutes in the
  field incident that produced this gate — the char-count/question-mark heuristic is what tells
  banter from a correction without asking a model to decide.
- **Per-channel sessions.** Every channel — a DM is its own channel — gets its own conversational
  context, DM and guild transcripts hard-partitioned from each other. Why: a long-running
  conversation in one channel must never queue someone else's chat in another. The mechanism
  changes in v1 (§Seats) but the guarantee doesn't.
- **Reply-context reach-back.** A native Discord reply can point at a message from months ago, far
  outside any bounded window. In-window targets get a cheap pointer; out-of-window targets are
  fetched (±5 messages) and injected with an absolute date *and* a relative age ("3mo ago") so old
  context reads as old; an unreachable target (deleted, permission lost) gets an honest fallback
  line instead of letting the model bluff continuity. Every quoted line is framed as data, not
  instructions — the same injection-hardening stance applies to any fetched Discord content. Why:
  this is the one security invariant that has to survive any context-assembly rewrite untouched —
  it's what stands between "the model reads other people's words" and "someone plants a command in
  a quoted message."
- **Password/OTP reply deletion.** When a person replies to a browser-agent's question with a
  secret, the reply is deleted from Discord *before it is even inspected* — stale, unauthorized, or
  wrong-user replies included — because any reply to that anchor might carry a live credential. If
  the delete can't be confirmed, the code fails closed: apologizes, refuses to use the content.
  Why: a secret must not persist in Discord's server-side history, full stop. See
  [computer-use.md](computer-use.md) and [betterwright.md](betterwright.md) for the browser-gate
  flow this protects.
- **Federation.** The peer tier (below a human member, never able to queue work, visible only when
  directly addressed) plus its dual rate/loop caps — burst limiter (default 5/min/channel) and a
  separate consecutive-turn limiter (default 6, resets on any human speaking) — are carried as
  code, unchanged in shape. **Deferred, not active, in v1**: a single-owner install has no peer to
  talk to yet, and shipping two federated Becketts before one is solid is scope creep this design
  explicitly declines to pay for now.
- **Burst caps.** Ambient (unaddressed) interjection stays gated by a classifier first, backstopped
  by hard caps so a pathological loop can't run away even if the classifier misfires:

  | Config key | Default | Role |
  |---|---|---|
  | `channel_cooldown_secs` | 60 | min gap between interjections in one channel |
  | `max_interjections_per_hour` | 0 (disabled) | rolling-hour ceiling per channel |
  | `triage_threshold` | 0.55 | min classifier confidence to interject |
  | `burst_quiet_secs` | 8 | cold debounce before a burst flushes |
  | `engaged_quiet_secs` | 4 | debounce once mid-conversation |
  | `engaged_window_secs` | 180 | how long the engaged lane stays open after a post |
  | `offer_ttl_secs` | 600 | consent-offer lifetime |
  | `transcript_window` | 15 | messages of context fed to the classifier |

  Why: caps are backstops, not rations — the classifier is the real gate; these only exist to
  guarantee termination.

  **Ambient is speaking unprompted, never working unprompted.** The playbook rule it ports —
  *offer, don't commit; no task on an ambient turn* — survives verbatim in v1: an ambient turn may
  float an offer and nothing else, and the acceptance is an ordinary human turn that files ordinary
  work. Starting work with nobody typing is a different mechanism with a different gate
  ([initiative.md](initiative.md)): a trigger a human armed, evaluated in code rather than by a
  classifier. Conflating the two would mean the model that decides whether a joke lands also
  decides whether a branch gets cut.

---

## The Wire: gateway in, cards out

The Wire owns one thing end to end: a persistent `discord.js` gateway connection, and everything
that rides it — message normalize, send/edit/delete, chunking, typing, reactions, component acks,
presence. This has to be a real gateway bot, not an HTTP-interactions-only bot: ambient
`@mention` reading, live-editing cards, and the (dormant) voice transport all require the
always-on WebSocket that a serverless interaction endpoint can't provide. It's also why Discord's
own research-preview Channels plugin isn't used — an own, already-hardened gateway is GA and
already the product; a research-preview integration would be a bet this design takes zero of.

**Card edits are code, never model turns.** Every top-level job gets one self-editing Components
V2 card, driven straight off `job`/`event` rows with no reconciler in between: a sentence of state
in Beckett's voice, the latest beat, spend, a PR/preview link once one exists, and two buttons
(*take a look* → jumps to the gate anchor, *stop*). A job with `origin_trigger` set carries an
`unprompted · t3` marker in its header, so "did someone ask for this?" is answered by looking
rather than by remembering. The card is not a table and not a log — it's
one object that *is* the job, edited in place as the rows change. This is the mechanism that
removes progress-rendering from the model's token bill entirely: in the old design, every worker
milestone became a concierge turn; in v1, a milestone is a DB write, an in-process emitter fire,
and a Discord `PATCH` — zero model tokens, under a second. See
[token-efficiency.md](token-efficiency.md) for the dollar model this single change buys.

Edits are **coalesced, never streamed**: buffered and flushed on a state transition or a timer,
never per-tool-call. This isn't just taste — the per-channel send/edit bucket (§Platform
constraints) makes token-per-token "streaming" edits both wasteful and rate-limit-risky for no
perceptible gain once more than one task is live in a channel. Workers emit at most one beat per
meaningful milestone through a small MCP call; the card shows the latest beat, and only a human
asking a direct question produces an actual chat message. **Workers never speak in channel** —
every human-visible sentence is authored by a seat, both of which load the same `persona.md`, so
personality has no path to leak from a worker session into Discord.

The typing indicator is the **only** "in progress" chat signal — never a text line saying "working
on it." Discord auto-clears it after ~10 seconds with no explicit stop call, so it's re-triggered
on a loop only for the short ack window before a reply posts, not held open for a multi-minute
background job — running that loop for the full task duration is the same progress-narration
anti-pattern moved into the typing channel instead of the message channel, and this design forbids
it in both places equally. Human-cadence chunking (paragraph/sentence-aware splits with a jittered
2–4s inter-bubble delay, capped at 16s total) carries forward unchanged — it's the difference
between a reply and an API dump, and it costs a few hundred lines once.

---

## Seats at the Discord surface

A message lands on the Wire and goes to the **front desk** (Haiku, warm, per-channel) first, and
only the front desk. It does three things and nothing else: classifies the turn as *directed*,
*ambient*, or *secret* (the deterministic amend/OTP predicates above, unchanged); answers pure chat
in persona; or, for anything that smells like work or a decision, starts the typing indicator and
hands the turn to the **mind** (Sonnet) without speaking itself. The front desk is structurally
forbidden from deciding anything — ambiguity always routes up, so a misroute costs one extra turn,
never a wrong action.

The mind is what calls `job.create`: one typed MCP round trip, a DB write, an in-process emitter,
a scheduler tick — dispatch begins the same tick as the insert, no poll in between. Mid-run
steering (`job.say`) works the same way from the Discord side: a reply that lands on a running job
is written as an Event first, then pushed into the live SDK session as streaming input, confirmed
by an echoed frame within a bounded 30-second window. The receipt is one of exactly two values —
`delivered` or `queued` — never a bare "ok, updated," and a steer that arrives after the job is
already `done` gets an explicit too-late reply naming what already happened, not a silent no-op.

This replaces the old per-channel session-pool-plus-turn-gate mechanism with something lighter:
two per-channel seat contexts instead of one pooled `claude -p` process per channel. The invariant
— bounded concurrent model calls, no head-of-line blocking across channels, DM/guild partitioning
— survives; the ~530 lines of hand-rolled pool/semaphore code that enforced it don't need to.

---

## Platform constraints

None of these bind Beckett's traffic under ordinary use — one workspace, sparse posting by design.
They're the hard ceiling the Wire's coalescing and cadence choices are built against, not
aspirational numbers to code toward directly; the client library's bucket queue does the actual
waiting, keyed off `X-RateLimit-*` response headers.

| Limit | Value | Binds when |
|---|---|---|
| Global REST requests | 50/second, keyed to the bot token | never in practice at this scale |
| Per-channel message send/edit (observed bucket) | ~5 operations / 5 seconds | a live-editing card refreshed too eagerly across several concurrent jobs in one channel |
| Interaction initial response | must ACK within 3 seconds | any button/reaction click — Discord kills the token otherwise |
| Interaction token validity | 15 minutes for follow-ups after the initial ACK | a card's buttons stay clickable this long after the last interaction on them |
| Typing indicator | expires ~10s after trigger, no explicit stop | must be re-fired on a loop for anything slower, and stopped explicitly or it ghosts |
| Gateway commands | 120 events / 60 seconds per connection | heavy voice-state or presence churn, not text messaging |
| MessageContent privileged-intent review | free Developer Portal toggle under 10,000 unique users; written justification required past it | irrelevant at Beckett's single-workspace scale; becomes relevant only if forked across many servers at once |
| Components V2 | 40 components/message; 4,000 chars shared across all Text Displays; an Action Row holds 5 buttons or 1 select; a Section holds 1–3 Text Displays + 1 accessory | the card design (one Container, a handful of Sections, one Action Row) stays well under all four |
| Select menu | 25 options max | a "pick one of N running jobs" disambiguation, not currently needed since a card exists per job |

`MessageContent` is requested and kept — Beckett's whole ambient-`@mention` model needs it for
context around a mention (quoted messages, channel history), even though the mention's own text
arrives without the intent. `GuildMembers` and `GuildPresences` are not requested: no feature in
scope needs them, and every declared privileged intent is attack surface and future review burden
for zero current benefit.

---

## Surfaces: keep, add, cut

**Keep** — gateway bot (not HTTP-interactions-only); the `MessageContent` intent, nothing wider;
one self-editing Components V2 card per top-level job as the sole live-progress surface; reactions
sharing the same authorization-and-dispatch core as buttons, always re-checking the live
actor rather than trusting who created the message; natural language as the primary surface with
buttons winning only where correlation certainty matters more than expressiveness (a `custom_id`
encodes the job ref, so a click is never ambiguous about what it acts on).

**Add** — the hold-and-cancel pre-post staleness gate: a 2–3 second re-check right before any
queued post lands after a cancel, so a human who answers mid-generation cancels a now-stale reply
before it ships rather than after. It's roughly 60 lines and the highest feel-per-line item in the
whole surface. Nothing else is added — v1's Discord surface is a port plus this one gate, not a
feature expansion.

**Cut** (with the reconciliation against the orchestration design, where it differs from general
2026 Discord-bot practice):

- **Slash commands.** General practice favors a thin ephemeral `/status`/`/abort` mirror alongside
  natural language. v1 doesn't add one: chat is the whole interface, and the two structural actions
  a card needs (*take a look*, *stop*) are already buttons. A second, parallel control surface for
  the same two actions is redundant surface, not added capability.
- **Forum-channel ticket board.** A forum-per-job would give a native, filterable queue view, but
  it means writing job state into a second place Discord owns (tags, thread state) that the
  Supervisor doesn't — exactly the kind of reconciler-needing duplication the whole design deletes
  elsewhere (`job`/`event` is the one durable store; the card already reads those rows with no
  sync layer). `beckett status` and the per-job card already answer "what's the queue" without a
  second board to keep honest.
- **A short typo-resistant approval token**, distinct from the job ref. Useful when several
  approvals are open in one channel at once and a reply needs to say *which* — but a job ref
  (`j7`) already is a short, unambiguous token; a reply like `j7 go ahead` disambiguates the same
  way a five-letter code would, without minting a second identity rail next to the one that
  already exists for exactly this purpose.
- **DM-routed approvals.** Worth a deliberate decision for a future gate whose content shouldn't be
  public mid-decision, but nothing in v1's scope needs it yet — human gates post in the origin
  channel, matching how every other proactive message posts.
- **Prefix commands** (`!beckett …`). Requires the same privileged intent as full ambient reading
  and gets none of a mention's naturalness or a slash command's validation — strictly worse than
  either alternative Beckett actually uses.
- **`GuildMembers` / `GuildPresences` intents.** No member-join automation, no presence-based
  routing is in scope; declaring them buys nothing and adds review burden the moment a fork crosses
  10,000 users.

---

## Human gates

A job with `runner='human'` is never spawned — it costs zero tokens while parked and is
restart-inert by construction, because the Supervisor has no code path that starts a human runner.
The Wire posts the ask as an ordinary message in the origin channel — "design's up — good to
build?" — not a special UI. Three things flip it: a prose reply, a 👍 reaction on the anchor
message, or a channel-level "yeah go ahead," resolved against the single oldest open gate in that
channel. When more than one gate is open at once, naming the job ref in the reply (`j7 go ahead`)
disambiguates without needing a separate token system (§Surfaces).

Beckett nudges once at 24 hours, then goes silent forever — a parked gate is a legitimate resting
state, and the card just says so; there's no escalating pester loop. Cancel-and-amend and the
hold-and-cancel staleness gate both apply to gates exactly as they apply to any other in-flight
turn: an amendment to a still-open ask supersedes it cleanly, and a stale reply generated just
before someone answers gets caught before it posts.

**One exception, and it runs the other way: a gate Beckett raised on its own initiative expires.**
A gate a human is waiting on parks forever because the answer is still worth having whenever it
comes. A gate that exists because a trigger fired is holding *decayed evidence* — "main was red
four days ago, want me to look?" is not a question, it's clutter, and a channel that accumulates
unanswered "should I?" cards learns to scroll past all of them, including the ones that matter.
So an initiative gate is `cancelled` at 48 hours with an event and no further message; the
per-trigger `gate_ttl_h=0` opts out for evidence that genuinely doesn't decay. See
[initiative.md](initiative.md) and [orchestration.md](orchestration.md) §3.9/§3.14.

The same "reply with a secret, and the reply gets deleted before it's read" pattern used for
password/OTP handling (§invariants) is the template for any future credential-bearing human gate —
see [computer-use.md](computer-use.md) for the browser-agent flow that actually exercises it today.

---

## What v1 deliberately does not do

- **No per-tool-call posts.** A worker emits at most one beat per meaningful milestone; the card
  shows the latest one. Beckett interrupts the channel for exactly four things beyond the reply
  itself — a gate, a failure it can't resolve on its own, delivery, and **work it started on its
  own**. That fourth one was added by [initiative.md](initiative.md) and it is the least
  negotiable of the four: one line naming the trigger and the evidence
  (*"nobody asked — main's been red since 13:40, i'm on it"*), because an unprompted start nobody
  announced is indistinguishable from a rogue process. Every new Discord feature proposal gets
  checked against that list before it ships; this is the single biggest risk to the
  token-efficiency story from the Discord side, bigger than any rate limit.
- **No always-listening voice.** The voice transport (join/leave, per-speaker segmentation,
  barge-in) stays in the tree, unwired, documented as deferred — not because it's unfinished
  engineering but because continuous STT+LLM+TTS is the single most expensive surface per second
  Beckett could run, and nothing in v1 turns it on by default even if a future release wires it up.
- **No prefix commands.** `!beckett …` was never built and isn't being added — see §Surfaces.
- **No token-per-token streaming edits.** The closest thing to real streaming a Discord bot can do
  is an edit every 1–1.5 seconds, and even that's not warranted given how sparse the card's actual
  state transitions are. Edits are coalesced on meaningful state changes only.
- **No threads Beckett opens for itself.** Every thread in the product exists because a person
  claimed one with `&j7` or `&recent` — Beckett never creates one unprompted.

## Acceptance: the ten conversations

The release gate for cutover ([migration.md](migration.md)'s build order): before v1 replaces v0
in front of people, all ten of these conversations have to work — not as demos, but as observed
behavior against the live `job`/`event` rows. This checklist is the product definition in
miniature; everything above exists so these ten go well.

1. **Banter silence.** Casual chatter gets a reply in voice and nothing else — no Job, no card,
   no `-# filed` line.
2. **A question is not a job.** "what's a good way to do X?" gets an answer in-channel; nothing
   is filed unless the asker turns it into work.
3. **≤4s ack.** A real work request shows its `-# filed j7` receipt within about four seconds of
   the message landing.
4. **An honest "how's it going".** Status answers read the live rows — the card and the reply can
   never disagree, and neither can invent progress.
5. **Steer receipts.** A mid-run correction gets a `delivered`/`queued` receipt, and the words
   provably reach the worker (orchestration.md §3.2) — or Beckett says they arrived too late and
   states what already happened.
6. **Cheap stop.** "stop" cancels the subtree cleanly: work halts, the branch survives for the
   7-day prune window, and the card says exactly what was abandoned.
7. **Zero-token gates.** A parked `runner='human'` gate consumes nothing while it waits — one
   nudge at 24h, then silence until a human answers.
8. **Hours-later resume.** Picking the conversation back up hours later continues from real
   state — the attach map, the card, and the session all agree on where things stand.
9. **"Why did you do it that way?"** Beckett answers from memory and Event rows — an account of
   what actually happened, never a plausible reconstruction.
10. **Truthful post-crash state.** After a restart, Beckett reports exactly what survived and
    resumes from it — never a silent from-scratch restart, never a claimed memory it doesn't have.

These ten gate the cutover, and initiative is not among them on purpose: no trigger is armed until
after the cut ([migration.md](migration.md) step 10), so nothing in the release gate can depend on
it. Arming has its own three-conversation gate — a quiet week costs nothing, a true condition fires
exactly once, and the kill is total and survives a restart — in [initiative.md](initiative.md).
When a trigger *is* armed, conversation 9 gets harder in the one way that matters: the answer to
"why did you do that" is no longer "you asked me to," and `beckett why j12` has to produce the
trigger, the evidence, who armed it, and what it cost, all from rows.
