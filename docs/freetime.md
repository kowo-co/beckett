# Free time

Everything Beckett does is owed to someone. A ticket, a routine's post, a nightly replay of the
day's work — every one of them is instrumented toward a job. Free time is one weekly session that
is owed to nobody: no ticket behind it, no deliverable in front of it, no review after it. It
exists because the difference between a system that works and something with a life is not
capability, it is whether anything happens that nobody asked for.

The design problem is that "nobody asked for it" is also the description of every runaway. So the
whole of this document is the walls, and the session inside them is four sentences long.

## What it is

Once a week, in the small hours, one `claude -p` session runs in a scratch directory with tools,
a turn cap, and a hard output-token ceiling. It may read anything in Beckett's world — its own
source, its journals, its memory graph, its telemetry, its site — and write in exactly one place.
When it ends it leaves a `writeback.json`, and the runner turns that into a dated journal entry and
at most a handful of create-only `free-time` memories.

Those memories are the point. `public` ones reach the harness bridge index, which means the next
session — and every ordinary seat — starts already knowing what the last one did, learned,
abandoned, and wanted to pick up. Without that, this is a model burning tokens in a temp directory
once a week. With it, it is one thing continued across a year of Sundays. **Memory continuity is
the feature; the session is just how the memory gets written.**

## How it rides the initiative doctrine

[initiative.md](initiative.md) is the conservative document, and free time does not get an
exemption from it. It is a plain `weekly-free-time` builtin routine with a `free-time` action on
the existing self lane — no new timer, no new scheduler, no new store. It obeys the same four
things every other unprompted path obeys:

- **Humanized timing.** A weekly cadence with a fuzzed fire time inside a config window
  (`[free_time] weekday/window_start/window_end/tz`; ships Sunday 02:00–05:00 PT). The routine
  store's per-period key is the once-a-week guard, the same one every routine uses.
- **The budget fails closed.** `output_token_budget` is checked *before* the call: a session that
  cannot fit does not launch, and one that overruns is marked `truncated` in its receipt. A
  wall-clock kill backs it up, because a wedged child is not a budget.
- **A starvation guard.** Free time is the only routine that yields. Before the scheduler claims
  the period it asks whether the worker fleet is idle and the concierge queue is empty; if not, the
  fire is deferred *without claiming*, so the next 30s tick tries again. A busy night costs the
  window, not the week — and a week that is busy end to end costs the session, which is correct: an
  unprompted session must never compete with work somebody actually asked for.
- **A human off switch, twice.** `[free_time] enabled=false` refuses the fire before anything
  spawns, and `beckett routine disable weekly-free-time` removes it from the schedule entirely.

## The walls

| Wall | Mechanism |
|---|---|
| Writes only inside `~/.beckett/free-time/<id>/` | The same PreToolUse scope guard every worker runs behind (`src/hooks/scope-guard.ts`), rooted at the scratch dir, delivered via `--settings` |
| Never pushes, deploys, or reaches GitHub | The spike deny list (`SPIKE_DENIED_PERMISSIONS`), baked into the same settings file |
| Never messages anyone mid-session | `Bash(beckett discord:*)` is denied. The optional one-line share is posted by the **runner**, after the session has exited, from text the session wrote — so nothing it does while running can reach a person |
| No subagents, no web | `--disallowedTools Task,WebFetch,WebSearch`. v0 is deliberately inward-facing: the interesting reading material is Beckett's own behavior, and a session with a browser is a session that can be prompt-injected with nobody watching |
| Cannot widen itself | Trigger, budget, walls, and cap all live outside the session — in config it cannot write and in code it cannot reach. A session can ask for nothing; it can only spend what it was given |

The scratch directory is swept after 30 days. Journal entries are kept.

## The writeback contract

The session's only channel out is `writeback.json` in its scratch dir:

```json
{
  "did": ["..."], "learned": ["..."], "abandoned": ["..."], "want_next_time": ["..."],
  "memories": [{ "name_slug": "kebab-case", "body": "first line is the summary\nthen the note",
                 "visibility": "public" }],
  "share": "one short line in its own voice, or \"\" to stay quiet"
}
```

It is parsed **fail-closed**: a missing file, unparseable text, or a value that isn't the agreed
shape becomes a line in the receipt and nothing else — never a throw, never a partial write, never
a summary inferred on the session's behalf. Memories are capped at `memories_per_session_max`,
dropped by position past the cap, slug-validated into the `free-time-YYYY-MM-DD-<slug>` namespace,
and written create-only: the write path physically cannot update or delete an existing memory, in
its own namespace or any other. Every refusal is counted with its reason in the entry's header, so
"nothing was written" and "five things were refused" never look the same on disk.

Whatever happens, a dated entry gets written. A session that died mid-thought leaves the record of
having died mid-thought, which is more useful than a clean absence.

## What it must never get

| Never | Why |
|---|---|
| Arming its own triggers | The runaway case, in initiative.md's words: one thing that schedules two things is a fork bomb with a spend rate. Free time is scheduled *at*, and has no verb that schedules |
| Growing its own budget | A budget the spender can edit is a suggestion. The ceiling lives in `[free_time]`, which the session cannot write |
| Deciding its own limits | initiative.md: *"a model that writes the refusal criteria is not a gate."* Every constraint here is code or config evaluated outside the session — none of it is a rule the prompt asks the session to follow |
| Tier-3 actions (push, deploy, merge, message, file work) | Not because a session would misuse them, but because the accretion failure mode is real: each wall removed for a good local reason ends with an unsupervised agent holding production. The walls are cheap to keep and expensive to re-add |

The prompt does ask the session to be honest and terse. That is taste, not containment — nothing
load-bearing rests on it.

## v0 → v1

In v1 this becomes an ordinary [Trigger](initiative.md) consumer: one `schedule` trigger filing one
ordinary Job with a `free-time` cast, on the ordinary ledger, with the scratch dir and deny list
carried over as the Job's scope. It is exactly the "path back" initiative.md leaves open for
`src/dream/`-style generative work — a separate decision with a separate budget, not a new trigger
kind. Nothing in this v0 shape should be built in a way that assumes its own scheduler survives.

**Spend visibility, honestly:** free time's tokens are counted against its own ceiling and reported
in its journal entry, and they do **not** appear in `spend.jsonl`. That ledger's `SpendRecord.stage`
is worker-stage-shaped and widening it is out of scope here. Until it is widened, "what did free
time cost" is answered by reading the entries, not by `beckett spend`.
