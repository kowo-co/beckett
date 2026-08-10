# bench/harness — measuring beckett's harness changes

A fixed set of small coding tasks, run through the **real production `ClaudeDriver`**, so a
change to the harness (prompt, envelope, driver argv, scope hook, done-schema) can be judged by
what it moved rather than by vibes. Each task is a self-contained fixture repo, a prompt, and a
`check.sh` that objectively grades the result. Every run records solved/not, turns, tool calls,
tokens, USD estimate, and wall clock per task.

## Usage

```
bun bench/harness/run.ts                            # run the default suite
bun bench/harness/run.ts --task fix-bug --task refactor
bun bench/harness/run.ts --suite default            # name under suites/, or a path
bun bench/harness/run.ts --run-id before-change     # name the run yourself
bun bench/harness/run.ts --parallel 2               # concurrent tasks (default 1)
bun bench/harness/run.ts --work-dir /tmp/bench --keep-work   # inspect the workspaces after
bun bench/harness/run.ts --compare before-change after-change
```

Exit code is 0 when every executed task solved, 1 otherwise.

`--run-id` is used verbatim — no collision suffix — so re-running with the same id **appends**
to the existing results file. Without it the run id is the repo's git short sha (plus `-dirty`
when the tree is not clean, plus `-2`, `-3`, … if that file already exists).

## The workflow

1. Baseline: run on clean `main`, note the run id.
2. Apply the harness change (edit `src/`).
3. Run again.
4. `bun bench/harness/run.ts --compare <baseline> <new>` — solved flips and signed deltas for
   turns, tokens, wall clock, and USD.

## Adding a task

Create `suites/<suite>/<task-id>/` containing:

- `task.json` — `{ id, prompt, model, effort, timeout_s }`. `id` must equal the dir name;
  `model: ""` falls through to the configured default; `effort` is `low|medium|high|xhigh`;
  `timeout_s` must be >= 30 (the runner enforces it itself — the config wall-clock backstop
  has a 30-minute floor).
- `fixture/` — the starting repo. The runner copies it, strips `.tmpl` suffixes, `git init`s it
  and makes one commit. **Name fixture test files `*.test.ts.tmpl`**: the repo's own `bun test`
  scans the whole tree, and a fixture suite that fails *by design* (fix-bug) would turn CI red.
- `check.sh` — run with cwd = the finished workspace; exit 0 means solved. It lives beside
  `fixture/`, never inside it, so the worker never gets to read its own grader.

## Notes

- **Sequential by default.** Concurrent claude workers share one subscription's rate limits,
  and beckett's own rule is one gateway connection per token. `--parallel` is opt-in.
- **The suite does not run in CI** — it spends real tokens. Only `format.test.ts` (pure
  rendering logic) runs under the repo's `bun test`.
- Results land in `results/<runId>.jsonl`, one JSON line per task, appended as each task
  finishes so a crashed run keeps what it paid for. That directory is git-ignored.
- Bench workers get no system append, no scope-guard settings, and no MCP config on purpose:
  the measurement target is the bare driver contract. Experiments change production code.
