# beckett

Bun + TypeScript daemon. Repo test command: `bun run test` (fast lane, ~25s — skips the three
browser e2e files). Typecheck: `bun x tsc --noEmit`. When you touch `src/browser/**`, also run
`bun run test:browser` (real Chromium, ~2min). `bun run test:all` is the full suite; note that a
bare `bun test` bypasses the script and always runs everything.

## Model selection for spawned agents

Scope-to-intelligence matching is the FIRST decision of any multi-agent plan: state each
subtask's difficulty, then pick the cheapest model that clears it.

- `claude-haiku-4-5` — mechanical sweeps, renames, formatting, data extraction, running suites.
- `claude-sonnet-5` — THE DEFAULT builder: well-specified features, tests, refactors, docs. When
  a task is nailed down enough that wandering is impossible, sonnet does it.
- `claude-opus-5` — architecture, gnarly debugging, cross-cutting integration, writing specs for
  other agents. Opus wanders on vague prompts — give it ONE task, nailed down.
- Fable / strongest tier — review and adjudication, never bulk building.

One agent = one task. Never hand an agent a concept; hand it a deliverable with a gate.

Workflows (ultracode): default stage model is sonnet; route only the hardest verify/judge
stages up. Don't spawn opus/fable fleets when sonnet clears the bar. Respect
`workflowSizeGuideline`.

Cite: an agent that costs 10x should be clearing a bar sonnet demonstrably can't.
