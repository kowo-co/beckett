# Voice calibration

Beckett already learns from being told no. It learns nothing from being told it sounded wrong.
`src/memory/calibration.ts` turns a veto or a hit into a dated, reasoned, per-channel row and
renders that room's ten most recent into the session prompt; `playbooks/calibration.md` is the
doctrine behind it, and its central claim is that being wrong the same way twice is a defect. Voice
is wrong the same way every day and there is no row anywhere. The only feedback path that exists is
a human opening `~/.beckett/persona.md` and rewriting it by hand.

This doc designs the missing half: what counts as voice feedback, where it is written, how it
reaches the model, and the four things it must never be allowed to do. It sits beside
[initiative.md](initiative.md) and inherits its posture — a mechanism that changes who Beckett is
gets the conservative treatment — and it is bounded by [token-efficiency.md](token-efficiency.md)'s
cache discipline, which is the reason the answer to "where does it reach the model" is not the
obvious one.

## The gap, precisely

| What exists | What it does | What it can't |
|---|---|---|
| `src/memory/calibration.ts` (161 LOC) | `veto`/`hit` records — channel, class slug, reason, source, date; a hard-scoped ≤10-line block composed into the appended system prompt per session launch | Says nothing about tone. `about` is a *class of decision*, and the bar it moves is whether to act |
| `playbooks/calibration.md` | Write down the why, not the no; the bar is per-room; record the hits too; twice is a defect | Read when someone "declines, vetoes, or accepts something you proposed" — a proposal, never a sentence |
| `voice_check` (`src/concierge/output.ts`) | One line, written *before* the message, naming how it honors the persona | Ends with the turn. Nothing reads it, nothing stores it, nothing counts a miss |
| `persona.md` + `beckett reload` | The single voice authority, loaded last into both seats' prompts, live-reloadable | Only changes when a human types into it. There is no ledger feeding it and no record that it should have changed |

The asymmetry that makes this hard: a decision veto arrives as an event with an obvious shape — a
"no", a "not now" — and the doctrine's job is only to make Beckett *record* it. A voice miss usually
arrives as nothing at all, and when it does arrive it is one clause in passing ("bit stiff", "stop
with the em-dashes") whose half-life is the current session. So the capture problem is real and the
temptation to solve it by having the model notice its own misses is strong. That temptation is
§1's whole subject.

## 1. Signal capture: a human's words, or nothing

**A voice record is written only from an explicit human correction, recognized by the mind, in the
turn it arrives.** Three candidate sources; one survives v0.

| Source | Position | Why |
|---|---|---|
| Explicit human correction in channel | **Accepted** — the only writer | The model is *transcribing* a judgment, not producing one. Its failure mode is mis-transcribing something a person just said, in front of that person, who can contradict it |
| Reaction emoji convention | **Deferred**, with a named path back | Cheap and honest, and carries no reason |
| The model's own `voice_check` misses | **Refused as a record**, permanently | A model grading itself is the initiative doc's refused predicate, in miniature |

**On `voice_check`.** It is a good mechanism in the place it already occupies: a pre-write rail on
the message about to be sent, costing one short line, forcing the persona to be consulted *before*
the text is written rather than admired afterward. What it must never become is the input to a
ledger. [initiative.md](initiative.md) refuses model-authored predicates on the grounds that *a
model that writes the refusal criteria is not a gate*; a model that writes its own voice-miss
records is the same closed loop with a worse failure direction. The context that produced a stiff
message is the context that assesses the stiffness, so the assessment agrees with the message far
more often than it should — and on the occasions it disagrees, it disagrees toward whatever the
model was already reaching for. A ledger written by the thing it is meant to correct is not a
ledger; it is a drift accelerator with an audit trail. `voice_check` stays a rail and stays
ephemeral.

**On reactions.** A dedicated emoji ("that landed wrong") is the cheapest capture surface Beckett
has, and it is refused for v0 on the calibration playbook's own rule: *write down the why, not the
no*. An emoji is a no with no why — the "Ro declined the replay feature" record the playbook names
as teaching nothing. It is also a namespace collision: 👍 already flips a human gate
([discord.md](discord.md)), and a reaction vocabulary that means "approve" on one message and
"critique" on another is a UI that has to be remembered. The path back is not the emoji becoming
the record: **a reaction becomes a prompt to ask.** One short "what was off about it?", and the
answer is the record. Deferred, not rejected.

**On who counts as a human.** v0 writes corrections from the **owner only**. A member of a shared
channel telling Beckett to sound different in that channel is real signal, and it is also the
cheapest possible lever for a stranger to reshape the persona. Widening is a per-channel config
edit, empty-means-narrowest, the same posture `owned_repos` takes.

**Who writes, and when.** The **mind** seat, in the turn, via one CLI verb — the same shape as
`beckett calibration veto`. Not the front desk: haiku is forbidden decisions and this is a durable
write about identity. And never a batch pass over transcripts after the fact — a scan invents
corrections nobody made, at an hour when the person who could say "no, that's not what I meant" is
asleep. Written when it happens, or it isn't written.

## 2. Storage: a sibling row, not a new store and not a persona edit

**A voice note is a `type: voice` memory node — the calibration record's sibling on the same
markdown graph, through the same `MemoryStore.remember` write path, with the same
invalid-files-are-simply-absent tolerance.**

| Field | Why it's required |
|---|---|
| `channel` | The bar is per-room, for the same reason the decision bar is. A channel-less voice note is malformed by definition (§4) |
| `about` | A slug naming the **class**, not the incident: `em-dashes`, `length`, `formality`, `hedging`, `greeting`. The per-channel join key |
| `direction` | `less` \| `more`. A voice note has a sign; a decision record does not, which is the one field that isn't a copy |
| `reason` | The person's words where possible. This is the field the distiller later quotes into a proposal, so a paraphrase is a lossy first step |
| `source` | Channel + message id, so the correction is re-readable in context |
| `observed`, `by` | Date and provenance, exactly as calibration carries them |

What it is not:

- **Not an ordinary memory node.** A free-form memory is reachable by the ordinary recall path,
  which means voice feedback would surface in unbounded contexts and be reasoned about as a fact.
  A voice note has exactly one legitimate consumer (§3); a distinct `type` is what keeps it there.
- **Not a new table in `beckett.db`, and not a Job/Event concept.** It never schedules, spends, or
  completes. Splitting substrates would buy a second aging rule and a second visibility model —
  the sidecar failure this whole design set exists to delete. In v1 it stays exactly where it is.
- **Not a persona.md amendment.** That is §3's answer, and the reason it isn't the storage answer
  is that persona.md is a *rendered position*, not a ledger: it has no room for a date, a reason, a
  source, or a superseded predecessor, and a file that grows a bullet per correction is 4,000
  tokens of contradictory advice loaded into both seats on every launch.

**Aging, three mechanisms, all blunt on purpose:**

1. **Superseded by class.** A new note for the same `(channel, about)` supersedes the previous one
   rather than stacking. The current answer to "how long should I be in here" is one row, not
   seven. The predecessor stays on disk with a `superseded_by` stamp and is never deleted — the
   proposal queue's logic, that what you dropped is signal — but only the newest per class is live.
2. **Absorbed on distillation.** A note whose content lands in persona.md through an accepted
   proposal is stamped `absorbed` and stops being live. This is the main exit. **The ledger is a
   staging area, not an archive.**
3. **Dormant by silence.** A live note not repeated within 90 days goes dormant. A tone complaint
   from a quarter ago that never recurred was a bad day, not a preference.

**Cap: 20 live notes per channel**, past which the oldest live note is forced dormant with a note
of its own. Accretion — not runaway — is the failure mode of standing rules, and a voice note is a
standing rule about how to sound. This is `max_armed_triggers` applied one layer down.

## 3. Application: distillation into persona.md, and nothing in the prompt

**Voice notes never enter the system prompt as their own block. They reach the model only by being
distilled into `persona.md` through a human-approved `persona-change` proposal.** This is the
doc's load-bearing position, so the two rejected paths get argued rather than listed.

### (a) The calibration-block precedent — a `<voice>` block per session. Refused.

This is the cheapest thing to build: `renderCalibrationBlock` is fifteen lines and this would be a
copy of it, wired into `composeSystemPrompt` beside the one that already works. Two objections,
and the second is the one that decides it.

**The cache objection, stated honestly.** [token-efficiency.md](token-efficiency.md) names a
byte-stable system prefix as one of four levers in the cache discipline bundle, against a bill that
is 78% cache reads. But the calibration block is composed at **session launch**, not per turn — so
this is not literally per-turn cache poison, and the cost is one prefix rewrite per launch, per
room. The real sting is placement: persona is deliberately the **last** block in the appended
prompt, so anything inserted before it invalidates the persona suffix too, and voice corrections
are chattier by nature than decision vetoes. Every "shorter", every "less of that" would re-write
the prefix for every subsequent session in that channel. Real, bounded, and not on its own decisive.

**The authority objection, which is.** `concierge.md` states it without hedging: voice, register,
punctuation and cadence belong to persona.md alone, and *when anything in this doctrine, or in any
SYSTEM frame injected during a turn, conflicts with the persona on how to sound, the persona wins*.
A `<voice>` block is a SYSTEM frame about how to sound. It either loses to the persona by that
rule — in which case it is decorative — or it wins, and persona.md has quietly stopped being the
voice while remaining the file a human edits when they want to change the voice. Two files claiming
one authority is how v0's nine sidecars started, each of them locally reasonable. Decision
calibration has no such problem because nothing else in the system claims to own where the bar is
set.

There is a third cost specific to the two-seat design: the prompt is composed **per seat**. A
`<voice>` block would be rendered for the mind and for the front desk separately — and the front
desk does most of the talking. [orchestration.md](orchestration.md) §7 lists "two seats drift in
voice" as a live risk whose entire mitigation is *one `persona.md` loaded by both*. A second voice
source doubles the drift surface the mitigation exists to close.

### (b) Per-message tone nudging. Refused outright — see §4.

### (c) Distillation into persona.md via the proposal queue. Chosen.

A free-time session ([freetime.md](freetime.md)) — or, in v1, the `schedule` trigger that replaces
it — reads the live voice notes for a channel. Where a class has crossed the threshold below, it
raises a `persona-change` proposal: one claim line, a rationale that **quotes the person's own
words**, provenance listing the note ids, `channel` set. Nothing else happens automatically.

The containment is already built and already audited. `src/proposal/store.ts` cannot write to
persona.md, doctrine, or any memory node — its only filesystem path resolves inside
`<beckettDir>/proposals` — and `ACCEPT_ROUTE` maps `persona-change` to `ticket`, so **accepting a
persona proposal does not apply an edit either**: it files ordinary work that takes the ordinary
road through the ordinary review gate. A rejection requires a reason and writes a calibration
record, so a rejected voice proposal makes the *next* one in that room weigh differently — the
decision ledger and the voice ledger closing the loop on each other, which is the shape that
justifies keeping them siblings. Landed edit → `beckett reload` → every session re-reads persona.md
at its next turn boundary. The notes that fed the accepted proposal are stamped `absorbed`.

**Threshold: two, never one.** Two live notes in the same `(channel, about)` class, or one class
the owner has repeated. This is the calibration doctrine's own rule read forward rather than
backward: once is a bad message, twice is proof the first correction never landed anywhere durable
— which is precisely when a change to a standing file is warranted.

**Why this composes.** It reuses three mechanisms whole and adds no fourth: the memory graph
(storage, visibility, aging), the proposal queue (the `persona-change` kind, its 14-day TTL, its
inert-by-construction accept path), and free time's read-anything/write-one-place shape. It keeps
the system prompt byte-stable by default — the only voice-driven prefix change is an accepted
persona diff, on the block that is already last, at roughly a weekly cadence rather than a
per-correction one. And it lands the change in the file a human already opens when they want to
change the voice, which means the mechanism is legible without reading this document.

**Its honest costs.** Two, both accepted:

- **Latency.** A correction takes up to a week and a human's yes to bind. For a standing rule
  that is correct and deliberate; for the person who just said "too stiff" it is unsatisfying, and
  §5's `beckett voice --channel` and the in-turn acknowledgement are what carry the interval. The
  bet table below names the on-demand escape hatch if a week proves too slow.
- **The distiller is a model writing about voice.** It is — and the line it stays on is the one
  the proposal queue was built to hold: it proposes a diff a human reads and accepts, it never
  writes the record and never applies the edit. A model summarizing three human corrections into
  one sentence for human approval is a different act from a model deciding it sounded wrong.

## 4. What this must never do

| Never | Why | Mechanism, not a rule |
|---|---|---|
| Auto-rewrite `persona.md` | It is one of the three files in [initiative.md](initiative.md)'s default `deny_paths` — the files that decide who Beckett is and what it may do — and free time is forbidden tier-3 writes for the accretion reason | The distiller's only output is a proposal record; the proposal path has no apply verb to call. A containment test asserts no import path from the voice module reaches `personaFilePath` |
| Nudge tone per message | A rail injected before each reply overshoots, the person corrects the overshoot, the ledger records the opposite class, and the voice oscillates instead of converging. Voice is a slow variable; its feedback loop must be slower than its input, not faster | No voice content is composed into any prompt, per turn or per launch. There is nothing to inject |
| Bleed across channels | A room that likes formal Beckett must not un-tune the DM voice. This is the motivating case *and* the failure case | `channel` is required on every note and a note without one is malformed; the distiller only ever proposes a channel-scoped persona section; a global change requires the owner saying it globally |
| Accrete persona sections | A file that gains a bullet per correction becomes contradictory advice loaded into both seats every launch | A proposal for `length` in a room **supersedes** that room's previous `length` line; append is the exception, and a proposal that only appends states why |
| Write silently | *Why do you sound like that in here* has to be answerable the way *why didn't you fire* is | Every note is written in the turn, in view of the person who gave it; `beckett voice --channel <id>` prints live, dormant, and absorbed rows with their reasons and sources |
| Let a stranger reshape the persona | The cheapest social-engineering lever in the product | Owner-only in v0; widening is a per-channel config edit, empty-means-narrowest |

## 5. The v0 increment

| Piece | Shape | ~LOC |
|---|---|---:|
| `src/memory/voice.ts` | Sibling of `calibration.ts`: `VoiceNote`, `listVoiceNotes`, `createVoiceNote` (supersedes its class), `sweepDormant`, `markAbsorbed`. No render function — deliberately, that is the design | 180 |
| `src/cli/voice-cli.ts` | `beckett voice [--channel <id>] [--all] [--json]`; `beckett voice note --channel <id> --about <slug> --direction less\|more --reason "<their words>" --source <link> [--by <id>]`; `beckett voice absorb <name>` | 110 |
| Doctrine touch | One playbook trigger line in `concierge.md` — *when someone tells you how you sound* → a short `playbooks/voice-notes.md` carrying the class-not-incident rule, the their-words rule, and the owner-only rule | 45 (md) |
| Distiller | One section in the free-time prompt plus a `persona_proposals[]` array in `writeback.json`, parsed fail-closed into `createProposal({ kind: "persona-change" })`. Threshold and channel scoping live in the runner, outside the session | 90 |
| Prompt / persona touchpoints | **None in `composeSystemPrompt`.** Zero new prompt bytes. That is the point, not an omission | 0 |
| Tests | `voice.test.ts` mirroring `calibration.test.ts`, plus one containment test in the `proposal/containment.test.ts` style asserting no path from a voice note to a persona write | 150 |

**~575 LOC, one new file pair, zero new stores, zero system-prompt bytes.** (The verb name outruns
the dormant Discord voice transport, which is unwired, documented as deferred in
[architecture.md](architecture.md), and owns no CLI verb; if it ever lands it takes `beckett call`.)

Explicitly **not** in v0: reaction capture, non-owner corrections, any automatic persona edit, any
voice signal on the front-desk seat, any cross-channel aggregation.

**The gate, three observed conversations rather than a demo:**

1. **A correction becomes exactly one row, in one room.** "too stiff in here" produces one note with
   the person's reason in it, and the next session launched in a *different* channel composes a
   byte-identical system prompt to the one it composed before — verified against the composed
   string, not the transcript.
2. **Twice produces exactly one proposal.** Two notes of the same class produce one
   `persona-change` proposal naming the note ids and quoting the words, once, and a third note of
   the same class before the decision does not produce a second proposal.
3. **The human gate is total.** Accepting changes persona.md through an ordinary ticket and the
   ordinary review gate; rejecting writes the calibration record the reject path already writes;
   and with the proposal open and undecided, persona.md is byte-identical to what it was.

## v1 alignment

Nothing here adds a ninth concept to [orchestration.md](orchestration.md) §0.

- **Voice notes stay memory-graph nodes.** They are not Jobs and not Events: they never schedule,
  spend, or reach `done`. The store delta is zero.
- **The distiller becomes what free time becomes** — one `schedule` trigger filing one ordinary Job
  with a `free-time`-shaped cast, on the ordinary ledger, inside the ordinary scope guard. It is
  the "path back" [initiative.md](initiative.md) already left open for generative overnight work,
  used exactly once.
- **The proposal ask becomes a `runner='human'` gate.** Zero tokens while parked, restart-inert,
  flipped by a prose yes or a 👍 on the anchor. It is initiative-originated, so it expires — and
  its `gate_ttl_h` is set to match the proposal record's own 14-day TTL rather than the 48h
  default, so the card and the record die on the same clock. Two expiry clocks on one question is
  the sidecar failure in miniature; and the distiller re-raising a class that is still live next
  week is a better freshness signal than a card parked forever.
- **One persona, both seats, still true after this doc.** The mitigation for seat drift is that
  there is exactly one voice file. Every mechanism here writes toward that file and none of them
  writes around it.

## The bets

| Bet | If it's wrong |
|---|---|
| **Only explicit human corrections are trustworthy enough to persist** | Add the reaction-triggered ask: an emoji fires one short "what was off about it?" and the *answer* is the record. The emoji never becomes the record, and `voice_check` never does |
| **Voice reaches the model only through persona.md** | A `<voice>` block appended **after** persona so it invalidates nothing but itself, capped at 3 lines per channel, with an explicit precedence line added to `concierge.md`. Justified by a measured prefix-hit-rate and a drift observation, never by convenience |
| **A week of latency is acceptable for a standing tone change** | `beckett voice distill --channel <id>`, run on demand by an owner after a bad day. Same proposal, same gate, same threshold — a new trigger, not a new path |
| **Per-channel, never global** | A `global` pseudo-channel that only a DM correction from the owner can write, distilled into the persona's top section. Off by default, because the DM is exactly where the owner's preferences look most like everybody's |
| **Supersede-per-class keeps the ledger honest** | Keep per-class history with a repeat count, and read the count for the threshold instead of counting live rows |
| **Two notes is the right threshold** | It is one config value against a ledger the distiller already reads; changing it changes no code |

## Rejected alternatives

- **A `<voice>` prompt block.** A second file claiming the authority `concierge.md` gives
  persona.md alone — decorative if the precedence rule holds, corrosive if it doesn't, and doubled
  across two seats either way.
- **`voice_check` as a persisted record.** The model grading itself, which is
  [initiative.md](initiative.md)'s refused predicate wearing a different hat. It stays a pre-write
  rail, where it is genuinely useful and costs one line.
- **Reaction-as-record.** A no with no why — the exact record shape `playbooks/calibration.md`
  rejects. Deferred as a *trigger to ask*, which is a different mechanism.
- **A tone classifier scoring every outbound message.** A standing bill for a usually-empty result
  — the cost shape [token-efficiency.md](token-efficiency.md) exists to refuse — and it grades with
  the same context that wrote.
- **A separate voice store or SQLite table.** Two aging rules, two visibility models, a tenth
  sidecar for a record that is the calibration row's sibling in every field but one.
- **Automatic persona.md edits, even gated on a high confidence score.** persona.md is in
  `deny_paths` by default for precisely this, and a confidence score is a model deciding when it
  may edit who it is.
- **Batch correction-mining over transcripts.** It invents corrections nobody made, at an hour when
  nobody is present to contradict it.
- **Per-message tone rails.** Oscillation dressed as responsiveness: the loop converges only if it
  is slower than the signal it is reading.
