# The nightly dream pass

ro's ask, verbatim: "a quick dreamer agent that reviews all the sessions of the day and adds
relevant comments to memory? like short term to long term commitals? that dont interfere with the
day to day operations of beckett? like it just works in the background but still prints to
<#1520658476974735490>." Earlier in the same conversation he said he was "hesitant to make it
remember everything but maybe theres a middle ground" — this pass is that middle ground. Beckett already writes a
memory when it decides, in-turn, that a fact is durable; the gap is what gets lost once a
session's context is cycled out. The dream pass catches the durable stuff after the fact, once a
day, without a human or a live session having to notice it in the moment.

## What it reads: the logs, plural

Three durable records on this box, each with its own provenance prefix, none privileged over the
others:

| Source | Where | Provenance id |
|---|---|---|
| The day's conversations | `src/concierge/channel-context.ts`, `~/.beckett/channels/*.jsonl` | `channel:<channelId>:<messageId>` |
| Per-ticket worker journals | `~/.beckett/journal/<ticket>.log` (issue #31) | `journal:<ticket>:<line>` |
| The dispatch event ledger | `~/.beckett/events/dispatch.jsonl` (`src/dispatch/events.ts`) | `dispatch:<runId>:<n>` |

Everything inside `[dream] window_hours` (default 24) before the pass fires is in scope. For
conversations the window is further gated on **guild**: DMs are never read, in code, the same
fail-closed gate the channel store's own `search()` uses — a channel with no recorded meta, or
with a null `guildId`, is skipped before its window is even loaded. The other two sources have no
DM analogue; a worker journal and the dispatch ledger are records of Beckett's own machine.

Provenance is preserved **per source**: a memory derived from a worker journal cites a journal
line, never a conversation. `journal:` ids are file line numbers (stable for an append-only log —
`sed -n '<n>p'` finds the literal line); `dispatch:` ids count within a run, not within the shared
file. Every source is capped (newest kept, per source and across sources) with honest notes in the
assembly about what was elided.

## What it writes

Once a day one tool-less `claude -p` call (haiku by default — this is extraction and judgment over
already-written text, not architecture) reads the assembled logs and returns JSON: a private
`summary` for the journal, up to `[dream] memories_per_night_max` (default 3) **new** memories, and
up to `[dream] prunes_per_night_max` (default 3) **maintenance** ops.

Every candidate is checked in code before anything is written:

- **Both caps are enforced by position**, not truncation — entries past the max are dropped and
  counted, never silently folded into fewer nodes.
- **Provenance must be real.** An id that doesn't appear in tonight's assembly is a refusal, not a
  correction — the structural guarantee that an inference can only ever cite a line that was
  genuinely on the table. This applies to maintenance ops too, flags included: a suspicion with no
  evidence is refused.
- **Four write paths, each narrow** (`src/memory/index.ts`):
  - `rememberDream` — create-only, name locked to `dream-YYYY-MM-DD-<slug>`, forced
    `metadata.type: "dream"` and `inference: true`. Unchanged, and it stays that way; see
    `src/memory/dreams.test.ts` for the containment tests this pass must never weaken.
  - `updateDream` — rewrites an EXISTING node that is both dream-named and `type: dream`.
    Anything else is a hard refusal.
  - `retireDream` — archives such a node out of the graph (`archive/` with `archived_reason`
    stamped). The store's "nothing is ever deleted" invariant holds; this is the dream namespace's
    delete.
  - `flagStaleNode` — writes a NEW dream node ABOUT a non-dream node, carrying `flag_target`,
    `flag_reason`, and provenance. The target's file does not change by a byte: a flag is a claim
    for a human (or `memory maintain`) to adjudicate, never an edit to somebody's observed fact.
    Flagging another dream node is refused — that's what update/retire are for.

What survives the pass: a dated journal entry under `~/.beckett/dreams/YYYY-MM-DD.md` (always
written on a real run, even on failure), the memory changes themselves, a row on the spend ledger,
and **one** short line posted to `[dream] channel_id`. That line is composed in code from the
accepted plan's own descriptions — never from the model's raw reply — and is lowercased, stripped
of trailing punctuation, and capped as a WHOLE line (180 chars), so three accepted memories read as
one line and not as a digest. It reports adds, updates and flags as a split ("kept 2 notes,
updated 1, flagged 1 as stale"), because one blended number hides three different things.

## How it rides the initiative doctrine

Same shape as [free time](freetime.md): a plain `nightly-dream` builtin routine with a `dream`
action on the existing self lane — no new timer, no new scheduler, no new store.

- **A fixed time, not a fuzz window.** The pass fires at `[dream] fire_at` in `[dream] timezone`
  (00:00 America/Los_Angeles by default). Under the hood that is the degenerate case of the one
  schedule shape every routine has — a one-minute window, which `rollFireTime` can only ever
  resolve to its start — so `beckett routine ls` still prints one honest instant and the scheduler
  keeps exactly one code path. `23:59` is refused by the config schema: the window needs the
  trailing minute to end inside the same day. Both values are config-authoritative on EVERY load
  (`RoutineStore.reconcileDreamSchedule`), so editing config retimes an existing install without a
  hand-edit of `routines.json`.
- **No busy gate, anywhere.** There used to be one — `src/dream/gate.ts`, plus a pre-claim veto in
  the routines extension. ro ruled the skip out: the pass runs at its time whether or not the fleet
  is building or someone is mid-conversation. What keeps it cheap is size, not scheduling. (Free
  time still defers on a busy machine; that gate is untouched.)
- **The budget fails closed.** `[dream] output_token_budget` is checked before the pass ever
  assembles a prompt: a pass that cannot fit does not launch. The one model call is wall-clock
  capped (`hard_timeout_s`) and killed, never waited on.
- **A human off switch, twice.** `[dream] enabled=false` refuses the fire before anything spawns,
  and `beckett routine disable nightly-dream` removes it from the schedule entirely.
- **Killable, and honest about dying.** A mid-run failure still writes a journal entry saying so —
  never a half-written memory (each write is its own atomic operation).

## The CLI

```
beckett dream run [--dry] [--force] [--routine <id>] [--requester <id>]
beckett dream ls [--json]
beckett dream show <YYYY-MM-DD>
```

`--dry` runs the review and the one model call and prints exactly what the pass would commit and
maintain — the assembled prompt, each planned memory's name/description/note/provenance, each
planned maintenance op, and both dropped lists. It writes no journal entry, calls no memory write
path, and posts nothing.

**`--dry` DOES append one spend row.** It makes the same real model call a real pass makes, so it
costs the same money, and a ledger that hid that would answer "what did dreaming cost" wrongly.
The row carries `stage: "dream"`, the pass's real `tokensOut`, and outcome `done` (or `failed`).
A quiet night — no logs in the window — short-circuits before the model call and therefore bills
nothing at all, dry or not. `--force` replaces an existing night's entry (hand re-runs only; the
automatic fire never forces).

## What it must never get

Same table as free time, for the same reasons (see [initiative.md](initiative.md)):

| Never | Why |
|---|---|
| Tools during the reflection call | The model reads one assembled document and returns text — no shell, no filesystem, no web. Containment is the write path (this process's code), not a tool denylist on the child |
| Arming its own triggers, growing its own budget, deciding its own caps | Every wall — the window, the ceiling, both per-night caps, the fire time — lives in `[dream]` config or in code, both outside the pass's own reach |
| A write path into somebody else's memory | It may create/update/retire inside the `dream` namespace and FLAG outside it. It may never edit or delete a node it did not write |
| Raw session content in its Discord line | The report is composed in code from the accepted plan's own (already short, already accepted) descriptions — the model's free-form reply never reaches Discord directly |

## Config

```toml
[dream]
enabled = true
model = "claude-haiku-4-5"
hard_timeout_s = 600
output_token_budget = 20000
window_hours = 24
memories_per_night_max = 3
prunes_per_night_max = 3
fire_at = "00:00"
timezone = "America/Los_Angeles"
channel_id = "1520658476974735490"
```

## Follow-ups, deliberately not built here

- A daily "channels touched" digest — the pass already knows `sessionsReviewed` /
  `sourcesReviewed`; nothing today surfaces them beyond the journal entry's meta header.
- Adjudicating the stale flags. A flag is a claim sitting in the graph for a human or a later
  `memory maintain` pass; nothing automatically acts on one, on purpose.
