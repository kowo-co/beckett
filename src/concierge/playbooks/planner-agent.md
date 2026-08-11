## The planner agent — a draft to deploy, never a decision to forward

`beckett agent invoke planner "<the ask>"` spends a read-only Opus seat on turning a fuzzy request
into a prompt you can actually deploy. It reads the real repo before it answers and comes back
with a sharp brief — the files, the order, what done looks like, risks flagged. **It builds
nothing and deploys nothing**: no write tools, no authority. You deploy.

**Reach for it when the shape of the work is the question.** The ask is fuzzy, spans code you
haven't read, or names an outcome instead of a change — "make X faster", "why is Y flaky", "what
would it take to move off Z". Same call when you're about to guess at what *done* means in a repo
you don't know: an acceptance line about a symbol that doesn't exist is unbuildable, and the
worker eats the rework cycle for your guess.

**Skip it when you can already write the prompt.** A crisp ask you could brief right now is pure
latency through the planner. So is anything conversational, and anything where you already know
the file and the fix. It is not a research agent, not a code reviewer, and it does not touch the
browser — those go to `quick`, to a review cast, and to the browser skill. It's Opus on high doing
real repo reads, so it is not free; that cost is the whole reason this paragraph exists.

**Hand it everything the Discord turn gave you** — it can't see the conversation, only your string:

```
beckett agent invoke planner "Dashboard search is slow; owner wants it under 300ms. Repo slug:
atlas (~/Projects/atlas). Constraint: don't touch the ingest pipeline. Done looks like: typing in
the box feels instant on a 10k-row account." --timeout 300
```

The raw request in the person's own words, the repo slug, every constraint they stated (a hold, a
deadline, "don't touch Z"), and what *done* would look like if you know. Paste what's already in
flight (`beckett task list`) in too when a duplicate is plausible — it will say so in a `NOTE:`
line instead of speccing the same thing twice.

**What comes back is a draft brief, and you check it before you trust it**: the done-conditions
are actually checkable (a name, a path, an observable behavior — never "works well"), a ceiling is
present so a worker can't gold-plate an unbounded ask, the repo slug really exists, and any cast
it proposes is a seat on the roster in `how-to-deploy-work.md`. **Where the planner disagrees with
that playbook, the playbook wins** — including the model and the effort. It's told to raise
correctness-critical work in a `NOTE:` line rather than cast Fable itself, and a Fable cast still
needs the human confirm exactly as if you'd chosen it. `NOTE:` lines are addressed to you alone: a
risk, a routing call it isn't allowed to make, something it couldn't verify. Anything stamped
`UNVERIFIED:` is a claim it ran out of clock on — check it or cut it.

**Then you make it real.** Fold its brief into ONE `beckett task deploy --prompt "…"` — keeping
the person's own words at the top of the prompt, not just the planner's restatement — with
`--repo`, `--channel`, and `--ultracode` if the shape it came back with really does span
subsystems. Edit on the way through: trim a condition, drop a step, tighten a scope. **You deploy.
The planner never does.** Its output is a draft you're accountable for, not a decision you
forward, and once deployed it reads as your brief, because it is.

**What to distrust:**

- **It has no memory between invokes.** Every call starts cold. The agent schema carries a
  `persistent` flag and nothing honors it yet — a follow-up invoke has no idea what the last one
  said, so re-state the context every time instead of writing "like before".
- **It can't make routing calls it isn't allowed to make.** Whether something belongs in Beckett's
  own source stays with you: it flags that in a `NOTE:` line, and the judgment in
  `how-to-deploy-work.md` is yours.
- **It read the repo at invoke time.** On a fast-moving branch that snapshot ages in minutes —
  verify the paths and symbols it cites still exist before you write them into a prompt.
