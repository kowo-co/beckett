---
name: quick
description: Use for errands BETWEEN "answer inline" and "deploy a run" — a web lookup on a live site, a small one-off script, a repo you need summarized. Dispatches a short-lived specialist agent via `beckett quick` and hands you its report; no run, no worker, no worktree.
---

# quick — the errand lane

Some asks are too heavy to answer from your own head but far too light for a run: checking a
price on a live site, writing a 40-line conversion script, telling someone what's in a GitHub
repo. Deploying a run for these wastes a worker and a worktree and makes a 2-minute answer take
ten. Doing them yourself blocks the chat lane and bloats your context with browsing or a whole
codebase. Instead, dispatch a quick agent and relay its report.

## The agents

| agent | give it | it returns |
|---|---|---|
| `quick-code` | a small coding errand ("script that converts this CSV to JSON", "why does this snippet throw") | the answer + absolute paths of any files it made (in a scratch dir) |
| `repo-explorer` | a repo + a question ("what does owner/name do, how do I run it") | a ~250-word brief answering the question, with file paths |

`beckett quick list` prints this menu. **Browser / computer-use work is NOT in this lane** — it
runs in the dedicated background browser agent (`beckett browser "<task>"`, see the `browser`
skill), which can pause for a human answer mid-run and resume; quick agents cannot.

## How to dispatch

```
beckett quick quick-code "write a script that dedupes the attached wordlist; input at /path/x.txt" --channel <id>
beckett quick repo-explorer "clone anthropics/claude-code and tell me how its hook system works" --channel <id>
```

- **Always pass `--channel <id>`** (from the turn stamp). If the run outlives the sync
  window, the result routes back to that channel through you — without it, a slow result
  has nowhere to go.
- Write the task like a good brief in one paragraph: everything the agent needs is IN the task
  text (URLs, paths, the actual question, any email/name it should use). The agent knows
  nothing about the conversation and can't ask follow-ups.
- The command blocks up to ~4 minutes, so **ack first** (`beckett discord reply`) like any
  work request. Two outcomes:
  - **A report** — relay it in your voice with a second `beckett discord reply` (after a
    CLI ack, plain turn text won't auto-post).
  - **"still working (run … detached)"** — your ack already covers it; end the turn. The
    report arrives later as a `quick-agent result` update turn; relay it then with
    `beckett discord reply --channel <id>`.

## When NOT to use this lane

- **Real work** — anything you'd want reviewed, anything multi-file, anything building on a
  project repo (`~/Projects/*`) → `beckett task deploy` as usual. Quick agents are forbidden
  from project repos by their own doctrine.
- **Things you already know or can read in one file** — just answer inline; a quick agent
  is still a whole model spin-up.
- **Anything owner-gated or destructive** — approvals, account deletions, payments. Bring
  those to the owner instead of dispatching an agent at them.
- **Anything touching a live website or browser** — that's the background browser agent
  (`beckett browser`), never this lane.
- The lane holds a few concurrent runs; if it answers "quick lane is full", either wait or
  deploy it properly — don't spam retries.

Treat an agent's report like a worker's output: trustworthy about what it did, but you own
the relay — paraphrase, keep names/links exact, and say plainly when a run failed or timed
out.
