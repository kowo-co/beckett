# Nightly self-repair

A background pass that runs once every 24h around 00:00 PT, reads Beckett's own error
output, clusters recurring failures, and files a capped number of runs against Beckett's
own source. It never changes production by itself.

The memory / dream half of the original ask is a separate piece of work. This module
does not touch `src/dream/**` or `src/memory/**`.

## What it reads, and why

| Surface | Path | Why |
|---|---|---|
| Ticket journals | `~/.beckett/journal/*.log` | Worker firehose. Failures, `⚠` lines, hook denials. |
| Dispatch ledger | `~/.beckett/events/dispatch.jsonl` | Durable `failed` / `bounced` rows with the classified error. |
| Uptime ledger | `~/.beckett/uptime.jsonl` | `unclean_restart` — the daemon crashed and came back. |
| Logs dir | `~/.beckett/logs/**` | Structured logger JSON at `error` / `warn`, when present. |
| systemd | `journalctl --user -u beckett.service` | stderr the user unit captured. Best-effort; missing unit → nothing. |

Missing or corrupt files are empty, not fatal.

## Clustering

Many instances of one bug collapse to one finding. Signature = SHA-256 of
(normalized message + recoverable `src/…:line`). Normalization strips ids,
timestamps, absolute paths, and raw numbers so retries of the same crash match.

A finding with no evidence is never emitted. Recurrence default: seen at least
twice, across at least two distinct minute-buckets. Configurable:
`[self_repair] min_count` / `min_occasions`.

## Filing

Qualifying clusters become `beckett task deploy` runs (`repo` unset = Beckett's
own source). The brief carries the signature marker, counts, timestamps, site,
and the exact error sample.

Walls the pass itself cannot violate:

- it never edits the running tree
- it never merges, never pushes to main, never force-pushes
- it never restarts or redeploys the daemon
- file cap default **2** (`[self_repair] file_cap`)
- a persisted ledger at `~/.beckett/self-repair/filed.json` plus open-run
  inspection means a signature already filed is not filed again

A fix reaches production the way every other change does: PR, CI, review, land.

## Idle gate

None. The pass fires at 00:00 PT whether the fleet or concierge is busy. Filing a
run is a queue insert; it does not block a worker, the concierge, the browser, or
a deploy. `--dry` is never gated on busy state either. Free time still defers;
this pass does not.

## Reporting

One short lowercase line to `[self_repair] channel_id`, falling back to
`[free_time] channel_id` (the same channel the free-time pass reports to).
Nothing found still posts `nightly self-repair: nothing recurring` so the
channel is consistent. Never a log dump, stack, or journal excerpt.

## CLI

```
beckett self-repair run [--dry]
beckett self-repair ls
beckett self-repair show [id]   # omit id → last pass
```

`--dry` prints the clusters derived from this box and files nothing, writes
nothing, posts nothing.

## Config

`[self_repair]` in `config.toml`. Off-switch: `enabled = false`. Schedule seed
for the builtin `nightly-self-repair` routine: `window_start` / `window_end` /
`tz` (default 00:00–00:30 America/Los_Angeles). After seed, `beckett routine`
owns timing.
