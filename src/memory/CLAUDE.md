# Memory subsystem conventions (`src/memory/`)

The markdown knowledge graph at `config.memory_dir` (`~/.beckett/memory`). Read this before
changing anything here or building a feature on top of memory.

## The model in one breath

One markdown file per node; YAML frontmatter (`name`, `description`, `metadata.type`, …);
`[[wikilinks]]` are graph edges; everything else (index, backlinks, moss retrieval index,
SQLite-free) is **derived from the files**. Memories are dated observations, never eternal
claims — old ones get demoted or superseded, never judged wrong by age alone.

## Typed, dated edges (`[[type:name @date]]`, issue #60)

A wikilink can carry an optional relation type and an optional observation date, so an edge says
*how* and *when* two memories relate, not just *that* they do:

| Form | Meaning |
|---|---|
| `[[name]]` | bare — untyped, undated (unchanged; every existing link keeps working) |
| `[[name\|alias]]` | display alias (unchanged) |
| `[[supersedes:name]]` | typed edge |
| `[[supersedes:name @2026-07-14]]` | typed **and** dated |
| `[[name @2026-07-14]]` | untyped, dated |

The type is a **closed vocabulary of exactly five** — `supersedes`, `caused-by`, `about`,
`contradicts`, `part-of` — plus untyped (`RELATION_TYPES` in `index.ts`). This is deliberately
not an extensible registry: a prefix that isn't one of the five isn't a type, and since a kebab
name can't contain `:`, such a token is simply not a link (no edge, no phantom). Parse groups
land on `MemoryEdge.rel` / `.date`; recall's one-hop expansion turns them into a directional
reason (`new-plan supersedes old-plan (observed 2026-07-14)`), a typed edge outranks an
incidental prose mention (`edgeWeight`), and generated `## Backlinks` annotate the field
(`[[from]] (supersedes, 2026-07-14)`). Merge/rename (`renameWikilinkTarget`) preserves the type,
alias, and date. Zero migration: bare links parse and resolve exactly as before.

## Invariants — do not break these

- **Files are canonical.** Never persist graph state anywhere the markdown tree can't rebuild.
  `.moss/` is a disposable cache; deleting it must always be safe. `MEMORY.md` and every
  `## Backlinks` section are GENERATED — regenerate them, never treat them as authored input.
- **All writes go through `remember()` / `maintain()`** on a `MemoryStore`. They serialize
  behind the write mutex, write atomically (tmp + rename), regenerate derived state, and
  git-commit. Never write node files directly from feature code.
- **Visibility is enforced in code, fail-closed, only in `recallOver` / `canView`.** Moss and
  the lexical scorer rank everything, scoped nodes included — they must never become the
  access-control layer. Any new read path that surfaces node content MUST gate through
  `canView` with a real `Audience`; no audience means public-only. `MEMORY.md` lists public
  nodes only.
- **Nothing is ever deleted.** Retirement = move to `archive/` with `archived` /
  `archived_reason` stamped, or merge with full content appended under a `## Merged from`
  heading. Age alone never archives; only ttl expiry, supersede, or a ≥0.9-similarity merge do.
- **A node's `name` is its global id** — kebab-case (`/^[a-z0-9-]+$/`), unique across the whole
  tree; folders are cosmetic. A `[[link]]` to a name with no file is a valid phantom node.
- **`name`, non-empty `description`, and `metadata.type` are required** — `remember()` rejects
  a create without them (a file missing any is unparseable and would be silently skipped).
- **The frontmatter is a YAML *subset*** parsed by the in-file parser in `index.ts`: flat maps,
  one-level nesting, flow/block sequences of scalars, `>`/`|` block scalars. No anchors, no
  sequences of maps, no multi-line flow. If you add a metadata shape, confirm it round-trips
  through `parseYaml` ↔ `serializeMeta` (all-digit strings are auto-quoted so Discord
  snowflakes survive; keep it that way).
- **Pure cores stay pure.** `recallOver`, `planMaintenance`, and everything in `search.ts` /
  `freshness.ts` take a built graph and/or `now` — no filesystem, no `Date.now()` hidden deep.
  Keep new logic testable the same way.

## How to extend

| You want to… | Touch |
|---|---|
| Add a node type | `NodeType` in `src/types.ts`; `TYPE_FOLDER` + `META_ORDER` in `index.ts` (folder + stable frontmatter key order) |
| Add a structural link field (edge with weight, followed on expansion) | `STRUCTURAL_FIELDS` + `HIGH_VALUE_BACKLINK_FIELDS` in `index.ts` |
| Add a metadata field | `META_ORDER` (or `META_TAIL` for provenance-ish fields) so diffs stay one-line; it's automatically searchable via `metaText` unless excluded there |
| Change ranking | Lexical: `search.ts` (`scoreNode`, field weights). Hybrid: `moss.ts` (keyword arm decides *which* nodes match, hybrid arm decides *order*). Both paths must keep seeing the same `searchableText` |
| Change freshness/aging behavior | `freshness.ts` thresholds + `recency()` in `index.ts`; remember the doctrine: nudge ranking, never drop or delete for age |
| Add a maintenance detector | `planMaintenance` in `maintain.ts` (pure, powers `--dry-run`); execution in `MemoryStore.maintain`. Favor flagging over auto-acting; never cross a visibility boundary when merging |
| Read memory from a new surface | `recall()` / `recallAgentic()` with an explicit `Audience` (`SELF_AUDIENCE` for Beckett acting for itself — it excludes dm-scoped facts by construction) |

## The open-loop ledger (`loops.ts`)

`loop`-type nodes are the standing ledger of commitments/recurring-errors/wishlist items. All
transitions go through `MemoryStore.remember` like any other node, so audience/visibility scoping
is identical — `listLoops` gates through `canView`, and every write uses `mergeInto` so unrelated
metadata (crucially `visibility`) is preserved. Lifecycle: `openLoop` (status `open`) → `noteLoop`
(a dated `**Note (YYYY-MM-DD):**` in the body + a `lastTouched` metadata date, status stays
`open`) → `settleLoop` (`done`/`dropped` + a close/drop note). `noteLoop` is the in-between so a
sweep can show progress without claiming completion; `lastTouched` is null for loops opened before
the field existed, and surfaces on `LoopEntry` so callers can prefer untouched loops. A note must
never widen visibility — it only ever passes `lastTouched` in the metadata patch.

**Linking a loop to the work filed against it** (issue #39): a loop's `linkedTasks` metadata is a
plain string array of task refs (`#20`, `#20.1`), stamped by `linkLoopTask` (also reachable as
`beckett loops link <name> --task <ref>`, or inline via `beckett task create --loop <name>`).
`resolveLinkedTasks(taskStore, loop)` resolves each ref's status from the live `TaskStore` at read
time — never cached on the loop node, so a cancelled/done task shows as such immediately, with no
loop write needed. `renderOpenLoopsBlock` (the session-start `<open-loops>` block every session,
including a self-lane sweep turn, gets composed into its system prompt) takes an optional
`TaskStore` and, when given one, appends each loop's resolved `already filed: #ref (status)` list
plus an explicit "check before filing" instruction — this is the fix for the mitigation that
depended on the model remembering to look. The field is optional and absent reads as `[]`, so
loops predating linking need no migration.

## Person files (`people.ts`, issue #59)

`people/<discord-user-id>.md` is the standard home for everything known about a person. The node
NAME is the Discord snowflake, so "who is this id" is one lookup and the join with the turn stamp is
exact — which is why `renderNode` quotes an all-digit `name:` (a bare one round-trips as a Number
and the file silently drops out of the graph). Same shape as `loops.ts` / `calibration.ts`: reads go
straight off `buildGraph()` through `canView`, writes go through `MemoryStore.remember`.

`upsertPerson` forces `visibility: owner` — person files are exactly where contact info and
real-world identity accumulate, so they must never reach the public `MEMORY.md`. It preserves the
existing body and APPENDS a dated note; a person file accretes, it is never overwritten.

The split with `~/.beckett/identities.json` (`src/discord/identity.ts`) is load-bearing: the json is
ONLY the structured id → address map (`display_name`, `known_name`, `preferred_address`,
`is_owner`) that `resolveSpeaker` reads on EVERY turn to build the stamp. Do not put free text
there, and do not make that path parse markdown. `renderPersonBlock` is the per-SPEAKER analogue of
the per-CHANNEL calibration bar; the concierge injects it on a speaker's first turn in a session
(it can't ride the system prompt — a session is scoped to a room, and a room has many speakers).
It renders the address but never `role:owner`: authority is the live code-stamped turn header.

## The dream namespace (`rememberDream`, issue #36)

`dream`-type nodes are INFERENCES from the nightly dream pass (`src/dream/`), never observed
facts. They have their own write path, `MemoryStore.rememberDream`, and its narrowness is the
point — do not widen it, and do not route dream writes through `remember()`:

- **Create-only.** Names are locked to `dream-YYYY-MM-DD-<slug>` (`DREAM_NAME_RE`); any
  existing node or file with the name is a hard refusal. No update, no append, no similarity
  dedup/merge (remember()'s dedup is exactly the laundering vector this path exists to close).
- **Forced markers.** `metadata.type = "dream"`, `inference: true`, and a non-empty
  `provenance` list naming real sources are stamped in code, whatever the caller passes.
- **Touches nothing else.** The backlink-refresh sweep is deliberately skipped: one new node
  file plus the regenerated MEMORY.md, and no existing file changes by a byte.
- **Read surfaces mark it.** `isInferenceNode` (search.ts) drives an explicit inference flag
  in recall text/JSON, index lines, MEMORY.md, and agent-recall candidates — a dream must
  never read back as something that was observed to happen. Keep new read surfaces on that
  helper. Containment tests live in `dreams.test.ts`; they try to violate this and must fail.

Maintenance inside the namespace is a SEPARATE trio of methods, never a widening of
`rememberDream` — the pass prunes as well as adds (`dream-maintenance.test.ts`):

- `updateDream` / `retireDream` — rewrite or archive a node that is BOTH dream-named and
  `type: dream`. Anything else throws. Retire archives (`archive/` + `archived_reason`), so
  "nothing is ever deleted" holds here too.
- `flagStaleNode` — a create-only dream node ABOUT a non-dream node, carrying `flag_target` /
  `flag_reason` / provenance. The target file does not change by a byte; a flag is a claim for a
  human to adjudicate, not an edit. Flagging another dream node is refused.

## The cross-store bridge (`bridge.ts`, issue #160)

Beckett has a SECOND memory store the graph doesn't own: the Claude Code harness auto-memory
(`~/.claude/projects/<project-slug>/memory/` — flat files, hand-maintained `MEMORY.md` injected
into every harness session). The authority split: the **graph** is authoritative for durable
cross-task facts (people/projects/prefs/env/decisions — everything `remember()` writes); the
**harness store** is authoritative for seat-operational lessons the harness seat teaches itself.
A store built with `bridgeDirs` cross-links them:

- **harness → graph**: `buildGraph` folds harness files in as READ-ONLY nodes (marker:
  `metadata.origin_store: "harness"`, check with `isBridgedNode`). They rank in recall, resolve
  cross-store `[[wikilinks]]` (formerly phantom noise), default to `visibility: owner`
  (fail-closed), and lose every name collision to a native node. EVERY write path skips them —
  remember's dedup arms, maintenance archive/merge (cross-store dups demote to flags), backlink
  refresh, merge link-rewrites. The graph must never change a byte under a harness root; the
  byte-guarantee is pinned in `bridge.test.ts`.
- **graph → harness**: every write regenerates `beckett-graph-index.md` (the PUBLIC index, same
  leak rule as `MEMORY.md`) in each harness dir plus a one-line `MEMORY.md` pointer — the only
  two files the graph ever writes there, both derived and idempotent. Best-effort: a bridge
  failure never fails the write.

Dirs come from `resolveBridgeDirs` (env `BECKETT_HARNESS_MEMORY_DIRS`, else the harness project
dir derived from the daemon's cwd); no `bridgeDirs` ⇒ byte-identical unbridged behavior, which
is why tests and embedded stores stay unbridged unless they opt in.

## Gotchas that have bitten before

- The warm daemon caches the parsed graph keyed by an mtime/size stamp taken **before** the
  build — keep it that way (a post-build stamp can cache a mid-build edit invisibly).
- TTL staleness is evaluated at **recall time** (`staleNow` in `recallOver`), not from the
  parse-time `node.stale` flag — the warm graph can outlive an expiry.
- `planMaintenance` sorts nodes by name so plans are deterministic; don't reintroduce
  readdir-order dependence in pairwise scans.
- Duplicate node names resolve newest-mtime-first with a path tiebreak — deterministic, but a
  duplicate name is still a bug to fix in the tree, not a feature.

## Testing

`bun test src/memory/` — pin behavior with the pure cores (`recallOver(query, graph)`,
`planMaintenance(graph, now)`, `scoreNode`) plus a `tempStore()` (tmpdir + `git: false`) for
write paths. Visibility changes need cases in `visibility.test.ts` proving the fail-closed
default holds.
