# BetterWright 1.8.0 / 1.8.1 / 1.8.2 vs 1.7.2 — perf, reliability, creepJS

> Measurement task, not an upgrade. The question was: does BetterWright 1.8.0 beat the pinned
> 1.7.2 on Beckett's live browser lane, and does it hold up on the creepJS fingerprint page? The
> answer decides one line in `package.json`. All numbers below are measured on this box
> (4-core Linux x64, kernel 7.1.4, Node 26.4.0, Bun 1.3.14) on 2026-08-12, alternating and
> repeated; nothing here is a vendor claim carried over unchecked.
>
> **Second pass (same day).** The first pass ended on a structural blocker — 1.8.0's mandatory
> native fork was never bound into the sandbox, so the lane could not launch it at all. That has
> since been fixed as its own change (`chromiumForkLaunch()` in `src/browser/isolated.ts`, issue
> #250, landed in #256). With the bind in place the comparison was re-run against **1.8.1**, the
> current release. It now launches, so for the first time there are real 1.8.x numbers on the
> sandboxed lane. The verdict did not change, but the *reason* did, and two findings came out that
> matter more than the pin decision — see [The two findings](#the-two-findings).

> **Superseded in part.** Everything below the "1.8.2" heading is a third, independent measurement
> pass against BetterWright **1.8.2** (2026-08-12), taken after the sandbox fork bind landed. The
> 1.8.0 and 1.8.1 material is kept intact as the historical record of why neither could run the
> lane as shipped. The pin decision that stands today is the one in
> [Decision — 1.8.2](#decision--182), not the earlier ones.

## TL;DR

**Hold the pin at 1.7.2**, now on measured numbers rather than an unmeasurable lane. With the
sandbox bind landed, **1.8.1 launches** on the live lane — but only when Beckett's default
`--disable-software-rasterizer` is removed from the arg list. On the **stock config it still fails
5/5**, for an entirely new reason (finding A), and where it does run, **cold acquire regresses
+59%** (1029.7 ms → 1636.9 ms). Those two numbers decide it.

The sandbox bind lands regardless. It is correct on its own merits — the lane could not reach the
fork at all before — and it is what makes a future upgrade a one-line pin change instead of a
sandbox refactor.

| Metric group | 1.7.2 (live lane) | 1.8.0 (live lane) | 1.8.1 (live lane) |
|---|---|---|---|
| Cold lease acquire (median of 5) | **1029.7 ms** | — (launch fails) | 1636.9 ms (**+59%**) |
| Warm nav+interaction, p50 (median of 5) | 178.4 ms | — (launch fails) | **170.5 ms** (−4%) |
| Warm nav+interaction, p95 (median of 5) | 3443.6 ms | — (launch fails) | **220.2 ms** (−94%) |
| Peak process-tree RSS (median of 5) | 1097.0 MiB | — (launch fails) | **1075.6 MiB** (−2%) |
| Active CPU-seconds (median of 5) | 4.2 s | — (launch fails) | **3.5 s** (−17%) |
| Live-lane launches, **stock config** | **5/5 pass** | **0/5 pass** | **0/5 pass** (finding A) |
| Live-lane launches, shared arg list | **5/5 pass** | not run (pre-bind) | **5/5 pass** |
| `test:browser` (unsandboxed unit/integration) | **5/5 × 101 pass, 0 fail** | 5/5 × 89 pass | **5/5 × 101 pass, 0 fail** |
| creepJS fingerprint completes | **no** (stalls, 5/5) | yes (~0.73 s) | **yes (~0.88 s)** |
| Backend selected *inside the sandbox* | Obscura / CloakBrowser | — (never launched) | **CloakBrowser**, not the fork (finding B) |

Two caveats that the table cannot carry, both load-bearing:

1. The perf columns compare the **shared arg list** (`--disable-gpu` only), because that is the
   only configuration *both* versions can run. 1.7.2's own stock-config numbers are within noise
   of its shared-list numbers (cold 1011.9 vs 1029.7 ms), so dropping the switch does not flatter
   1.8.1 — but the stock column is the one production actually uses, and there 1.8.1 is 0/5.
2. **1.8.1 does not run BetterChromium inside the sandbox.** Its own backend-routing function
   selects CloakBrowser there, because bwrap's device tree has no `/dev/dri` (finding B, verified
   by executing that function). So the 1.8.1 perf column is not "native BetterChromium 151 vs
   Obscura" — it is 1.8.1's host/orchestration layer driving CloakBrowser, the same compat engine
   1.7.2's heavy pages land on. The headline reason to want 1.8.x on this lane is unreachable as
   designed.

## The two findings

These came out of the 1.8.1 pass and outrank the pin decision: the pin is one line that can be
changed back, while both of these are structural and will still be true at 1.8.2.

### Finding A — 1.8.1 newly reserves a switch its own docs recommend

1.8.1 still fails the stock config **5/5**, but no longer for 1.8.0's reason. The fork is bound
now; instead the launch is rejected before a browser starts:

```
--disable-software-rasterizer is reserved by BetterWright and cannot be overridden —
the managed browser must retain its WebGL software fallback
```

`--disable-software-rasterizer` is in Beckett's default `quick.browser_chromium_args`
(`src/capability/builtins.ts:566`, default `["--disable-gpu", "--disable-software-rasterizer"]`).
1.8.1 added it to a frozen `RESERVED` map in `dist/src/chromium-args.js:57`, and
`normalizeChromiumArgs()` throws a `TypeError` on any reserved switch rather than dropping it.

Feeding Beckett's exact default to each version's own validator isolates the change to 1.8.1
(`bench-results/reserved-check.mjs`, run against the install cache so it does not depend on which
version happens to be installed):

```
$ node bench-results/reserved-check.mjs
1.7.2: ACCEPTED -> ["--disable-gpu","--disable-software-rasterizer"]
1.8.0: ACCEPTED -> ["--disable-gpu","--disable-software-rasterizer"]
1.8.1: REJECTED -> --disable-software-rasterizer is reserved by BetterWright and cannot be
        overridden — the managed browser must retain its WebGL software fallback.
```

That also pins down *why* the stock config is 0/5 while the shared list is 5/5: the two differ by
exactly this one switch, and the rejection happens during config validation, before a browser is
launched.

The sharp part is that **this is a reversal, not a new rule.** In both 1.7.2 and 1.8.0 the exact
same switch appears in `dist/src/client.js:242` — inside a doc comment *recommending* it as the
example `chromiumArgs` value:

> `has no opinion on — ["--disable-gpu", "--disable-software-rasterizer"]`

So Beckett's default is not an unusual choice that happened to collide; it is verbatim the value
BetterWright's own API docs suggested, and 1.8.1 made it a hard error. Their stated reason
(upstream issue #109: disabling the software fallback recreates a blocked-GPU state) is coherent
for a host with no GPU — but see finding B for why that reasoning misfires here.

Per the ticket this is **documented, not worked around**: Beckett's default
`browser_chromium_args` is unchanged. An operator who wants to try 1.8.1 today must override
`quick.browser_chromium_args` to `["--disable-gpu"]`, which is exactly the shared arg list the
perf table uses.

### Finding B — the GPU-less-host routing cannot reach our sandboxed lane

1.8.1 routes GPU-less Linux hosts to CloakBrowser instead of the native fork. The check is
`chromiumForkNeedsSoftwareGpu()` in `dist/src/cloak.js:102` — it reads `/dev/dri`, keeps entries
matching `renderD\d+`/`card\d+`, and returns "needs software GPU" if it can open none of them.
Critically, a `readdirSync` that *throws* (no `/dev/dri` at all) is caught and returns `true`.

Beckett's bwrap sandbox mounts a minimal device tree — `--dev /dev` (`src/browser/isolated.ts:426`),
which gives the standard null/zero/random set and **no `/dev/dri`**. So inside the lane the
`readdirSync` throws and the host always looks GPU-less.

This box is not GPU-less. On the host:

```
$ ls /dev/dri
by-path  card1  renderD128        # renderD128 is crw-rw-rw-, world-accessible
```

But under the lane's own bwrap flags, `/dev` holds exactly the 14 standard nodes and no `dri`:

```
$ bwrap --ro-bind /usr /usr … --dev /dev --unshare-all sh -c 'ls /dev/dri; ls /dev'
ls: cannot access '/dev/dri': No such file or directory
core  fd  full  null  ptmx  pts  random  shm  stderr  stdin  stdout  tty  urandom  zero
```

Running **betterwright's own routing function** against both conditions confirms the consequence
directly, rather than inferring it:

```
$ node -e 'import("betterwright/dist/src/cloak.js").then(m => …)'
host (real /dev/dri)   -> chromiumForkNeedsSoftwareGpu() = false
sandbox (no /dev/dri)  -> chromiumForkNeedsSoftwareGpu() = true
```

The result: **inside the sandbox, 1.8.1 selects CloakBrowser rather than the native BetterChromium
fork, on a GPU-equipped machine.** The fork is bound, resolvable, and passes `betterwright doctor`
on the host (`In use: chromium-fork`); the routing check simply never sees the GPU through the
sandbox boundary.

(The `backend` field in `bench-results/*.jsonl` reads `betterwright/CloakBrowser (isolated host)`
for *both* versions, but that is a hardcoded label in `scripts/bench/browser-lane.ts` — it is not
evidence of which backend ran, and is not used as such here.)

The two findings interlock badly. 1.8.1 refuses `--disable-software-rasterizer` *in order to*
protect a WebGL software fallback (finding A), then routes the lane away from the native fork
because the sandbox looks GPU-less (finding B) — so the lane pays the cost of the new restriction
without ever reaching the backend the restriction exists to protect. And in the one measurement of
the fork's actual fingerprint surface we have, WebGL is reported **blocked / gpu: unsupported**
anyway (see [creepJS](#creepjs)).

Closing this properly is an upstream conversation, not a local patch. Binding `/dev/dri` into the
sandbox would satisfy the check, but that is a real widening of the isolation boundary — it hands
the browser a host render device — and is explicitly out of scope here; no bwrap flag was relaxed
for this work. The alternative is asking upstream for an override (an env var or option to assert
hardware rendering) so a sandboxed host can state what its device tree cannot show.

## What actually changed in 1.8.0

From the authoritative `CHANGELOG.md` of the 1.8.0 package (not the marketing page):

- **Obscura is removed. Native BetterChromium 151 is the required/default backend** on supported
  hosts. CloakBrowser stays as an *explicit* compatibility opt-out and is "never selected as a
  silent fallback." This is the change that matters here: 1.7.x's headless path was Obscura, a
  lightweight resident DOM runtime; 1.8.0 mandates a full Chromium fork that `betterwright setup`
  downloads into `~/.betterwright/chromium/` (SHA-256 pinned).
- Renamed the fork to **BetterChromium**, pinned to Chromium 151.
- **Soft two-renderer ceiling** (was 3): drops Chromium 151's spare process.
- **Proof screenshots encode at CSS-pixel scale** while the page keeps a DPR-2 identity — a
  default proof falls from 3600×2164 to 1800×1082 encoded pixels.
- Centralized macOS identity across launch flags, contexts, rendering surfaces, and WebGPU.
- Native frozen/active idle-page lifecycle; `browser_evidence` checklists (issue #106).

The vendor's own seven-run numbers, quoted for context (Apple M4 Max, *not* this box, and *not*
Beckett's sandboxed lane): vs 1.7.2, cold/warm startup −22.4%/−21.2%, nav+proof −91.3%, but
**cold/warm peak RSS +1.9%/+1.5% higher** and idle RSS "higher than 1.7.2's Obscura-backed idle
state, the native browser remains resident." So even the vendor concedes 1.8.0 trades higher
memory for lower latency. On this box we could not reproduce the latency win because the lane
cannot launch 1.8.0 at all (below).

### …and what 1.8.1 added on top

1.8.1 is a small release over 1.8.0, and only two of its changes touch this lane — but both are
the findings above:

- **A frozen `RESERVED` switch map** (`dist/src/chromium-args.js`), which
  `normalizeChromiumArgs()` enforces by throwing. `--disable-software-rasterizer` is new to that
  map in 1.8.1; it is absent from 1.8.0. This is finding A.
- **`chromiumForkNeedsSoftwareGpu()`** (`dist/src/cloak.js`), a bounded `/dev/dri` probe that
  routes GPU-less Linux hosts to CloakBrowser so WebGL keeps working. Their changelog frames it as
  the fix for a blocked-GPU regression (issue #109). This is finding B.

Note that 1.8.1's fingerprint surface is **byte-identical to 1.8.0's** on this box: both produce
creepJS FP ID `66403abcb93f8b5e…`. So 1.8.1 is not a stealth change; it is a compatibility and
routing change, and both of its lane-visible edits happen to land on Beckett's configuration.

## Method

- **Perf**: `bun run browser:bench` (`scripts/bench/browser-lane.ts`), unchanged. It drives the
  real isolated (bubblewrap) host through `createIsolatedBrowserRuntime({ backend: "betterwright" })`
  against a local loopback fixture, and samples the whole host+browser process tree at 100 ms for
  peak RSS and CPU. Cold = spawn host + launch + `acquire()`; warm = a fixed
  navigate→wait→click→read→screenshot loop, 6 iterations/run. 5 runs per version, alternating,
  `sleep 2` between. Raw JSONL in `bench-results/`; driver `bench-results/run-bench.sh`.
- **Two arg lists, because one version rejects the default.** The bench was run twice per version:
  once on the **stock config** (`--disable-gpu --disable-software-rasterizer`, Beckett's shipped
  default) and once on the **shared arg list** (`--disable-gpu` only), the largest configuration
  both versions accept. Finding A forces this: 1.8.1 throws on the stock list before launching, so
  a stock-only comparison would have no 1.8.1 perf column at all, and a shared-only comparison
  would hide a 0/5 production failure. Both are reported. The `-stock`/`-shared` suffixes in
  `bench-results/*.jsonl` mark which is which.
- ⚠️ **All three runner scripts rewrite the `betterwright` pin in `package.json`** as they
  alternate versions, and they leave it wherever the last iteration landed — which is *not*
  1.7.2. Anyone re-running these must restore the pin and `bun install` afterwards, and check
  `grep betterwright package.json` before committing. Shipping an accidental 1.8.1 pin would
  silently hand production the 0/5 stock config of finding A.
- **Reliability**: two independent signals. (1) The live-lane bench above, which actually launches
  a browser — 5 attempts/version. (2) `bun run test:browser` across `runtime/isolated/agent`,
  5 runs/version, driver `bench-results/run-testbrowser.sh`. This was **89 tests** during the
  1.8.0 pass and is **101** now: the sandbox-bind change added 12 tests to `isolated.test.ts`.
  Note `runtime.test.ts` runs with `sandbox: "none"`
  (line 37): it launches unsandboxed, resolves BetterChromium from the real `~/.betterwright`, and
  therefore does **not** exercise the bwrap fork-binding the live lane needs. It is a real signal
  for the client/policy/adapter code, but it is *not* a live-lane launch test — which is why it is
  green on 1.8.0 while the lane is not.
- **creepJS**: `betterwright run <snippet> --close` drives each version's own persistent browser to
  `https://abrahamjuliot.github.io/creepjs/`, waits ~20 s for the client fingerprint to settle
  (BetterWright caps a single snippet at 30 s), and scrapes the self-computed detection signals.
  This is the version's actual stack against a public open-source fingerprint page — a normal
  stealth-regression check. The aggregate "trust score %" comes from a slow creepjs backend fetch
  that does not return inside the 30 s snippet cap, so the comparison uses the self-computed
  signals (headless heuristic, WebGL/GPU, WebRTC, engine identity, lies), which are what a detector
  actually reads off the page. Snippets and raw JSON in `bench-results/creepjs/`; driver
  `bench-results/creepjs/run-creepjs.sh <version>`, which pins, installs, runs `doctor`, then
  captures `fp-<version>.json` (identity + rendered body) and `trust-<version>.json` (header
  nodes). Both versions were captured; **the fingerprint surface is measured, not estimated.**
  One limit stated plainly: this runs each version's *unsandboxed* `betterwright run` browser, so
  it measures the version's own stack, not the bwrap lane. Per finding B the sandboxed lane is on
  CloakBrowser for both versions, so the 1.8.1 column below describes a backend the lane does not
  currently reach.

## Installing 1.8.0 — what happened

Bumped the pin to `1.8.0`, `bun install` (clean), then `betterwright setup`:

```
Downloading BetterChromium 151.0.7922.108...
Checksum OK (2a6808f9706d…)
Installed /home/beckett/.betterwright/chromium/linux-x64/betterchromium
BetterChromium installed as the required browser backend.
```

`betterwright doctor` then reports green: `BetterChromium 151.0.7922.108 … In use: chromium-fork`.
So unsandboxed, 1.8.0 is healthy. The failure is specific to the sandboxed lane (next section).

## Reliability

### Live-lane launch — the decisive signal

`bun run browser:bench` on **1.7.2**: 5/5 launches succeed, every run produces the full report
(numbers below). On **1.8.0**: 5/5 launches fail, deterministically and fast, with:

```
error: BetterChromium is required but not installed. Run `betterwright setup`, or explicitly
select CloakBrowser with `betterwright setup --cloak-only` and BETTERWRIGHT_CHROMIUM_ROOT=off.
      at receiveResponse (src/browser/isolated.ts:640:29)
```

Root cause, confirmed by reading `src/browser/isolated.ts`: the bwrap host binds the Obscura root
(`obscura.mountRoot`, ~line 356) and the CloakBrowser cache (`cloakCacheDir`, ~line 352) read-only
into the sandbox, and forwards their env vars via `--setenv`. It **never** binds
`~/.betterwright/chromium/` and never sets `BETTERWRIGHT_CHROMIUM_ROOT`. The sandbox runs
`--clearenv` with `HOME=/tmp/home`, so 1.8.0 looks for the fork under `/tmp/home/.betterwright/
chromium/`, finds nothing, and — by design — refuses to silently fall back to CloakBrowser. The
lane was built around Obscura+CloakBrowser; 1.8.0's mandatory native fork has no seam in it. This
is not a flake: it is 5/5 identical, and it is structural.

#### After the bind — 1.8.1 re-measured

That root cause is now fixed. `chromiumForkLaunch()` binds the fork root read-only
(`--ro-bind`) and re-sets `BETTERWRIGHT_CHROMIUM_ROOT` past `--clearenv` with `--setenv`,
mirroring the Obscura mount exactly; no bwrap flag was relaxed and nothing beyond that one
directory is exposed. Re-running the lane on **1.8.1** with the bind in place:

| Config | 1.7.2 | 1.8.1 |
|---|---|---|
| **Stock** (`--disable-gpu --disable-software-rasterizer`) | **5/5 pass** | **0/5 fail** — finding A |
| **Shared** (`--disable-gpu`) | **5/5 pass** | **5/5 pass** |

So the bind did its job: 1.8.1 gets a launch where 1.8.0 got none. It still fails the stock config
5/5, deterministically, but the error moved from "backend missing" to the reserved-switch
`TypeError` of finding A — a different wall, one layer further in.

### `test:browser` unit/integration suite (5 runs each)

10 runs total, alternating 1.7.2 / 1.8.1, `bench-results/run-testbrowser.sh`. Raw output in
`bench-results/testbrowser-1.7.2.txt` and `-1.8.1.txt`.

| Run | 1.7.2 | elapsed | 1.8.1 | elapsed |
|---|---|---:|---|---:|
| 1 | 101 pass / 0 fail | 111.8 s | 101 pass / 0 fail | 102.5 s |
| 2 | 101 pass / 0 fail | 111.1 s | 101 pass / 0 fail | 104.0 s |
| 3 | 101 pass / 0 fail | 111.3 s | 101 pass / 0 fail | 113.9 s |
| 4 | 101 pass / 0 fail | 111.8 s | 101 pass / 0 fail | 100.5 s |
| 5 | 101 pass / 0 fail | 110.8 s | 101 pass / 0 fail | 110.3 s |
| **Total** | **5/5 green** (505 test executions) | median 111.3 s | **5/5 green** (505 test executions) | median 104.0 s |

Zero failures and zero flakes on either version, across 10 runs. Suite wall-clock is ~6% faster on
1.8.1 at the median, but the spread overlaps (1.8.1 ranges 100.5–113.9 s against 1.7.2's tight
110.8–111.8 s), so that is not a result worth leaning on.

Both versions pass this suite cleanly; it does not launch through bwrap (see Method), so its green
status on 1.8.0 and 1.8.1 alike is consistent with — not a contradiction of — the live-lane
stock-config failure. This is precisely why the live-lane bench, not this suite, is the reliability
signal that decides the pin.

## Performance

5 runs per version per config, live isolated lane, medians with [min, max] spread. The headline
comparison is the **shared arg list**, the only configuration both versions run.

### 1.7.2 vs 1.8.1 — shared arg list (`--disable-gpu`)

| Metric | 1.7.2 median | 1.8.1 median | Δ | 1.7.2 spread | 1.8.1 spread |
|---|---:|---:|---:|---|---|
| Cold lease acquire | **1029.7 ms** | 1636.9 ms | **+59%** | [1003.1, 1147.7] | [1624.5, 1666.5] |
| Warm eval p50 | 178.4 ms | **170.5 ms** | −4% | [165.7, 195.9] | [158.8, 183.3] |
| Warm eval p95 | 3443.6 ms | **220.2 ms** | −94% | [3432.2, 3457.2] | [193.2, 228.3] |
| Warm eval min | 140.0 ms | 155.7 ms | +11% | [133.9, 174.4] | [137.4, 171.9] |
| Peak process-tree RSS | 1097.0 MiB | **1075.6 MiB** | −2% | [1087.7, 1232.7] | [1068.1, 1086.2] |
| Active CPU-seconds | 4.2 s | **3.5 s** | −17% | [4.1, 4.3] | [3.5, 3.6] |

**Cold acquire is the number that decides the pin.** +59% (1029.7 → 1636.9 ms) is not noise: the
two distributions do not overlap at all — 1.7.2's slowest run (1147.7 ms) is still 477 ms faster
than 1.8.1's fastest (1624.5 ms). Every lease Beckett hands out pays that once.

1.7.2's own stock-config numbers (cold 1011.9 ms [1008.9, 1057.5], p50 175.0 ms, RSS 1098.2 MiB,
CPU 4.1 s) sit within noise of its shared-list numbers, so removing
`--disable-software-rasterizer` to accommodate 1.8.1 did not distort the baseline.

### The p95 asterisk

1.8.1's warm p95 is genuinely, reproducibly better — 3443.6 → 220.2 ms, with tight non-overlapping
spreads across 5 runs each. But read what it is before crediting it to the new backend:

- **It is not the native fork winning.** Per finding B, 1.8.1 routes to CloakBrowser inside the
  sandbox, so this is not BetterChromium 151 beating Obscura — it is 1.8.1's orchestration and
  proof-encoding layer over a compat engine.
- **The 3.4 s is one iteration, not the steady state.** 1.7.2's warm loop is bimodal: the first
  iteration pays ~3.4 s to launch the Chromium pixel renderer for the
  `screenshot({kind:'question'})` proof, then every subsequent iteration is ~150–180 ms. The p50
  column is the steady state, and there the two versions are within 4% of each other.
- **The likely mechanism is 1.8.0's proof-encoding change**, which the changelog describes as
  dropping a default proof from 3600×2164 to 1800×1082 encoded pixels — a 4× reduction in pixels
  to encode. That is attribution from the changelog, not something this bench isolated; the bench
  measures elapsed time, not proof dimensions. If it is the cause, the win is partly *bought* with
  a half-resolution proof PNG rather than being free.

So the honest reading is: 1.8.1 removes a one-off first-proof stall, at the cost of +59% on every
cold acquire. For Beckett's lane — many short leases, each paying cold acquire once — that trade
is the wrong way round.

### The ~40 MiB peak-RSS question, settled

The open claim from 1.7.0 was a "~40 MiB peak RSS," never confirmed on the live lane. **It is not
the live-lane number for either version.** On the live lane, peak process-tree RSS is **~1100 MiB**
(1.7.2, measured, 5/5). That figure is dominated by the Chromium pixel renderer that the proof
screenshot launches — the lane renders proof PNGs through real Chromium regardless of Obscura doing
the DOM work. The 40-ish MiB figures in BetterWright's own changelog (`77.3 MiB`, `45.9 MiB`,
`51.1 MiB` at various points) are all from its **browser-free** micro-benchmarks (transcript
serialization, snapshot-diff), explicitly "no-I/O" harnesses — not a browser launch. So: the
40 MiB claim is *confirmed as a browser-free micro-bench number* and *killed as a live-lane
number*. Anyone quoting ~40 MiB as the lane's memory footprint is off by ~27×. 1.8.0, per its own
changelog, would be *higher* still on the lane (resident native browser), so it does not rescue the
memory story either.

## creepJS

Driven through each version's own `betterwright run` browser against
`https://abrahamjuliot.github.io/creepjs/`.

### 1.8.0 — BetterChromium 151 (real Chromium)

| Signal | Value |
|---|---|
| User-Agent | `…Macintosh; Intel Mac OS X 10_15_7… Chrome/151.0.0.0 Safari/537.36` |
| `navigator.webdriver` | `false` |
| platform / vendor | `MacIntel` / `Google Inc.` |
| cores / RAM | 12 / 16 GB |
| Headless heuristic | `chromium: true` · **44% "like headless"** · 0% headless · 0% stealth |
| WebGL | images/pixels/params/exts **blocked**; **gpu: unsupported/blocked** |
| WebRTC | host/stun/foundation **blocked** |
| Lies detected | **0** (no Lies pheno rendered) |
| Canvas | present, ~16% rgba noise (anti-fingerprinting) |

Reads as a coherent macOS Catalina / Chrome 151 identity with `webdriver` off and zero creepJS
"lies." The soft spot is **WebGL/GPU fully blocked** while the UA claims a Mac: a real Mac Chrome
exposes an Apple GPU string, so "macOS + no GPU" is an internal inconsistency, and creepJS's
"44% like headless" heuristic partly reflects it. Still, 0 hard lies and 0% definitive-headless.

### 1.7.2 — CloakBrowser (compat backend, promoted for the full page)

A heavy JS page like creepJS promotes 1.7.2 off the Obscura DOM runtime onto CloakBrowser
(Chromium 146, UA Chrome 145). Direct `navigator`/WebGL probes return, but **creepJS's own
asynchronous fingerprint never finalizes** inside the window — across four attempts (22 s, 25 s ×2,
and a two-call ~45 s persistent-session run) the page stayed at `FP ID: Computing…`, Fuzzy all
zeros. So 1.7.2 has no creepJS trust-score/lies verdict to report; only the raw identity primitives.

| Signal | Value (rotates per session) |
|---|---|
| User-Agent | `…Windows NT 10.0; Win64; x64… Chrome/145.0.0.0 Safari/537.36` |
| `navigator.webdriver` | `false` |
| platform / vendor | `Win32` / `Google Inc.` |
| cores / RAM | **rotates**: 4 then 16 across runs / 4 GB |
| WebGL | **present, fabricated**: `Google Inc. (Intel)`, `ANGLE (Intel UHD Graphics 630/770 Direct3D11)` |
| creepJS FP completion | **never finished** (`Computing…`) within ≤45 s |

The identity is a fabricated **Windows/Direct3D** profile served from a Linux host, and it
**rotates** between launches (GPU UHD 630 vs 770, cores 4 vs 16) — CloakBrowser's deliberate
per-session identity rotation. It exposes a full WebGL surface, which reads as more "normal" than a
blocked one, but "Windows + Direct3D11 on a real Linux box" is itself fabricated, and the rotation
means two visits never match.

### Deltas (1.8.0 vs 1.7.2)

| Check | 1.7.2 (CloakBrowser) | 1.8.0 (BetterChromium 151) | Who's better |
|---|---|---|---|
| Claimed OS identity | Windows 10 / Chrome 145 | macOS Catalina / Chrome 151 | tie (both plausible) |
| Identity stability | **rotates** per session | **stable** macOS profile | 1.8.0 (consistent) |
| `navigator.webdriver` | false | false | tie |
| WebGL / GPU | exposed (fabricated D3D11) | **blocked / unsupported** | mixed — see below |
| creepJS FP completes | **no** (stalls) | yes (~0.7 s) | **1.8.0** |
| creepJS lies detected | n/a (never rendered) | **0** | 1.8.0 (measurable, clean) |
| Headless heuristic | partial render, ~"0% like headless" (not final) | 44% like headless, 0% headless | inconclusive |

**Named check where 1.8.0 is arguably worse: WebGL/GPU.** 1.8.0 blocks WebGL entirely (`gpu:
unsupported`) while presenting a macOS UA. A real Mac Chrome exposes an Apple GPU string, so
"macOS + no GPU" is an internal inconsistency a fingerprinter can flag, and it is what feeds
1.8.0's "44% like headless." 1.7.2 does expose a GPU — but a *fabricated Windows* one on a Linux
host, which is inconsistent in a different way and rotates per visit. Neither is clean; it is a
trade between "blocked surface" (1.8.0) and "fabricated rotating surface" (1.7.2).

**Where 1.8.0 clearly wins:** it actually completes the creepJS fingerprint (< 1 s) with **0 lies**
detected, whereas 1.7.2's stack could not finish the page at all in the time a snippet allows —
which, for real detection pages that gate on a rendered result, is the more consequential
difference. This is a genuine 1.8.0 improvement on the detection surface — but it is moot for the
pin, because 1.8.0 cannot run on Beckett's sandboxed lane in the first place.

### 1.8.1 — captured, and identical to 1.8.0

Both versions were re-captured in this pass via `bench-results/creepjs/run-creepjs.sh`. **The
fingerprint surface is measured, not estimated.** 1.8.1's result is not merely similar to 1.8.0's —
it is the same fingerprint:

| Signal | 1.8.0 | 1.8.1 |
|---|---|---|
| creepJS **FP ID** | `66403abcb93f8b5e…` | `66403abcb93f8b5e…` (**identical**) |
| FP settle time | 730.0 ms | 877.4 ms |
| User-Agent | macOS 10_15_7 / Chrome 151.0.0.0 | same |
| `navigator.webdriver` | false | false |
| platform / cores / RAM | MacIntel / 12 / 16 GB | same |
| Headless heuristic | `chromium: true` · **44% like headless** · 0% headless · 0% stealth | same |
| WebGL | images/pixels/params/exts blocked; **gpu: blocked** | same |
| WebRTC | host/stun blocked, foundation unsupported | same |
| Lies detected | **0** (no Lies pheno rendered) | **0** (no Lies pheno rendered) |
| Canvas | ~16% rgba noise | ~16% rgba noise |

An identical FP ID across two releases is the strongest form of "no stealth regression": creepJS's
own hash over the whole surface did not move. It also confirms the framing above — 1.8.1 is a
compatibility/routing release, not a fingerprinting one.

### 1.7.2 — re-confirmed, still does not finish

The 1.7.2 capture was repeated in this pass and reproduced the stall exactly: `FP ID: Computing…`,
`Fuzzy` all zeros, every section label rendered with empty values, `0% like headless / 0% headless
/ 0% stealth` (placeholders, not verdicts). That is now **5 attempts across two sessions, 5/5
non-completion** — 22 s, 25 s ×2, a ~45 s two-call persistent run, and this pass's 24.7 s run.

The identity rotation also reproduced, on a third distinct GPU string:

| Capture | WebGL renderer | cores |
|---|---|---|
| earlier runs | `ANGLE (Intel UHD Graphics 630 … D3D11)` | 4 |
| earlier runs | `ANGLE (Intel UHD Graphics 770 … D3D11)` | 16 |
| **this pass** | `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 … D3D11)` | 16 |

Three different fabricated Windows GPUs across captures, on the same Linux box. So the 1.8.x
"stable identity vs rotating identity" delta holds, and 1.7.2's inability to finish the page is a
real, repeatable weakness — it is simply not one that outweighs 0/5 stock-config launches.

## Decision

**Hold at 1.7.2** — and `package.json` is pinned to `1.7.2`, verified after the benches (which
rewrite the pin as they alternate versions).

Pin policy: move only if the new version wins or ties on **both** perf and reliability and does not
regress creepJS. Against 1.8.1, with the sandbox bind in place and the lane genuinely measurable
for the first time:

| Gate | Result | Verdict |
|---|---|---|
| Reliability — stock config | 5/5 vs **0/5** | **fails** (finding A) |
| Reliability — shared arg list | 5/5 vs 5/5 | ties |
| Perf — cold acquire | 1029.7 vs **1636.9 ms (+59%)** | **fails** |
| Perf — warm p50 / RSS / CPU | −4% / −2% / −17% | wins (small) |
| Perf — warm p95 | −94% | wins (one-off first proof; see asterisk) |
| creepJS | FP ID identical to 1.8.0; 0 lies | no regression |

Two independent failing gates — a 0/5 production-config launch rate and a +59% cold acquire — with
the wins concentrated in a one-off first-proof stall and a few percent of steady-state. The pin
stays.

**What is different from the 1.8.0 verdict:** that one was forced — the lane could not launch
1.8.0 at all, so no comparison existed. This one is chosen on numbers. That is a better place to
be, and it is what the sandbox bind bought.

### The bind lands regardless

The sandbox bind is not contingent on the pin. It is correct on its own merits — before it, any
launch needing the native fork failed closed inside bwrap, because `HOME` is remapped to
`/tmp/home` (so implicit discovery finds nothing) and `--clearenv` strips
`BETTERWRIGHT_CHROMIUM_ROOT` even when it is configured. And it turns a future upgrade into a
one-line pin change instead of a sandbox refactor.

The mount is gated on the binary name the *installed* betterwright expects, which is load-bearing
rather than cosmetic: **1.7.2 also reads `BETTERWRIGHT_CHROMIUM_ROOT`**, and resolves it strictly
against the pre-rename `linux-x64/chrome`. Setting it unconditionally from a 1.8-only install made
every 1.7.2 lane launch die with `Chromium binary not found` where it used to fall back. This box
is exactly that case — `betterwright setup` left the 1.8 binary in place — so the gate is
observable, not theoretical (`bench-results/bind-check.ts`):

```
$ bun bench-results/bind-check.ts
installed betterwright : 1.7.2
host fork dir holds    : …, betterchromium          # the 1.8 name; no bare `chrome`
default (installed ver): {"env":{},"mountRoot":null}                    # sets nothing, mounts nothing
forced 1.8.1           : {"env":{"BETTERWRIGHT_CHROMIUM_ROOT":"…"},"mountRoot":"…"}
kill switch "off"      : {"env":{"BETTERWRIGHT_CHROMIUM_ROOT":"off"},"mountRoot":null}
```

So on the pinned lane the bind is inert and the launch command is byte-identical to before it
existed — asserted directly by test as a command-array equality, not just by absence of the env
var.

### What would have to change to revisit

1. **Finding A** — upstream un-reserves `--disable-software-rasterizer`, or offers a way to opt out
   of the software-fallback guarantee. Beckett's default `browser_chromium_args` is deliberately
   *not* being changed to route around this.
2. **Finding B** — upstream offers an override for `chromiumForkNeedsSoftwareGpu()` so a sandboxed
   host can assert hardware rendering its device tree cannot show. Without it, the native fork is
   unreachable from this lane no matter what the pin says, and the whole reason to want 1.8.x here
   evaporates.
3. **Cold acquire** — the +59% regression closes.

Until at least 1 and 2 land, upgrading would buy a slower cold path and the same CloakBrowser
backend the lane already runs.

---

# BetterWright 1.8.2 vs 1.7.2

> Third measurement pass, 2026-08-12, on the same box (Intel i7-4790, 4 cores / 8 threads,
> 31 GiB RAM, Intel HD integrated graphics via `i915`, kernel 7.1.4-arch1-1, Node 26.4.0,
> Bun 1.3.14). 5 rounds, versions alternating within each round, six configurations per round,
> 30/30 runs recorded. Raw JSONL in `bench-results/matrix.jsonl`; regenerate the summary with
> `python3 scripts/bench/betterwright-matrix-report.py`.

## TL;DR — 1.8.2

**Hold the pin at 1.7.2** — but this is a *policy* hold under a tie, not a claim that 1.8.2 is
slower. It is not: on the number that reflects a real unit of work, **1.8.2 is 58.6% faster**.

The pin policy for this line of work is: move only if the candidate **wins outright on both
performance and reliability** without regressing the fingerprint surface. Measured:

- **Reliability is a tie, not a win.** Live-lane launches: **5/5 for 1.7.2, 5/5 for 1.8.2** in
  every configuration (30/30 overall). `bun run test:browser`: **99/99 pass × 5 runs on each
  version**, zero failures. There is no reliability win available here — 1.7.2 is already at
  ceiling — and the policy asks for one.
- **Performance has one real regression.** Cold lease acquire goes **970.3 ms → 1551.8 ms
  (+59.9%)**, and the [min,max] ranges do not overlap. That is the deciding number for the hold.
- Stated as loudly: on **total lease cost** (acquire + all six warm iterations, the whole unit of
  work) 1.8.2 wins decisively — **6232.0 ms → 2580.8 ms, −58.6%**, ranges also disjoint. 1.7.2
  spends ~4.5 s of its warm loop on two slow first iterations that 1.8.2 never pays.
- **The fingerprint surface does not regress**; on the measurable checks it improves.

So the hold rests on the literal policy (a tie on reliability plus a named performance
regression), reinforced by one judgement: **1.8.2 is the third BetterWright release of
2026-08-12**, each patching the previous one's regressions (1.8.0 → 1.8.1 → 1.8.2). Pinning
production to a same-day third patch is not a conservative move, and nothing here is urgent.
[What would flip this](#what-would-flip-the-pin) is spelled out below.

| Metric (stock config) | 1.7.2 · Obscura+Cloak | 1.8.2 · auto → **CloakBrowser** | 1.8.2 · forced **BetterChromium** |
|---|---:|---:|---:|
| Live-lane launches | **5/5** | **5/5** | **5/5** |
| Total lease cost | 6232.0 ms | **2580.8 ms** (−58.6%) | 2879.3 ms (−53.8%) |
| Cold lease acquire | **970.3 ms** | 1551.8 ms (+59.9%) | 1676.7 ms (+72.8%) |
| Warm p50 | 182.9 ms | **170.0 ms** (−7.1%) | 176.5 ms (−3.5%) |
| Warm p95 | 3431.0 ms | **210.5 ms** (−93.9%) | 248.5 ms (−92.8%) |
| Peak process-tree RSS | 1109.7 MiB | **1079.9 MiB** (−2.7%) | 1769.7 MiB (+59.5%) |
| Active CPU-seconds | 4.10 s | **3.39 s** (−17.3%) | 7.83 s (+91.0%) |
| `test:browser` ×5 | 99/99 every run | 99/99 every run | (same binary, same suite) |

## Which backend actually ran — and how that was established

This is the part a 1.8.2 benchmark gets wrong by default. Upstream picks its backend at launch by
reading `/dev/dri`: on a Linux host with no accessible render device it routes to managed
CloakBrowser so WebGL keeps working (`chromiumForkNeedsSoftwareGpu` in `dist/src/cloak.js`).
bubblewrap's minimal `--dev` exposes no render node, so **inside Beckett's sandbox the lane always
reads as GPU-less** — on a box that has a working `i915` render node one namespace away. A 1.8.2
number taken without checking is therefore a CloakBrowser number wearing a BetterChromium label.

Every row below is labelled from two independent witnesses, recorded per run:

1. **The kernel's own record of what was executed.** The bench sampler already walks the host's
   `/proc` descendant tree for RSS and CPU; it now also resolves each PID's executable link and
   reports the distinct browser binaries it saw. `…/.betterwright/chromium/linux-x64/betterchromium`
   is the native fork; `…/.cloakbrowser/chromium-146.0.7680.177.5/chrome` is CloakBrowser;
   `…/.betterwright/obscura/linux-x64/obscura` is 1.7.2's resident DOM runtime. This cannot be
   spoofed by a mislabelled report — it is what the kernel actually executed.
2. **BetterWright's own routing warning.** 1.8.2 added result warnings for every non-default
   backend decision, and Beckett's adapter already surfaces `warnings` on an evaluate result. The
   default lane returns, on all 10 auto runs, verbatim:

   > Browser backend: CloakBrowser compatibility mode because no accessible Linux render device
   > was found. In a container or OS sandbox, set `BETTERWRIGHT_BACKEND=chromium-fork` to override
   > this mount-based probe.

   and the forced lane returns, on all 10 forced runs:

   > Browser backend: BetterChromium, forced by `BETTERWRIGHT_BACKEND=chromium-fork` even though
   > no accessible Linux render device was found; verify WebGL in this sandbox.

The two witnesses agree on all 30 runs. A third, weaker check corroborates: the in-page identity
probe reports `Chrome/146` + `Linux x86_64` on every CloakBrowser run and `Chrome/151` + `MacIntel`
on every BetterChromium run.

**So: the default 1.8.2 sandboxed lane is CloakBrowser 146 — not the native fork.** Finding B is
confirmed unfixed at source (the probe is byte-identical between 1.8.1 and 1.8.2) and confirmed
empirically in the lane.

## Verifying the two carried-over findings

Both were checked against the published 1.8.2 tarball and then in the running lane, rather than
taken on faith.

**Finding A — the rejected flag — is fixed.** In 1.8.1, `--disable-software-rasterizer` sits inside
the `RESERVED` table in `dist/src/chromium-args.js` (line 57, inside the object spanning lines
33–58), and a reserved switch throws before launch. Beckett's shipped `browser_chromium_args`
default is `["--disable-gpu", "--disable-software-rasterizer"]`, so stock config could not launch
1.8.1 at all. In 1.8.2 the same switch has moved to the new `DROP_WITH_WARNING` table, which drops
it and reports it. Empirically: **10/10 stock-config 1.8.2 runs launched**, each carrying the
warning

> Ignored Chromium switch `--disable-software-rasterizer`: the managed browser must retain its
> WebGL software fallback.

Beckett's default `browser_chromium_args` was **not** changed to obtain this result.

**Finding B — the `/dev/dri` probe — is not fixed, and the new override works.**
`chromiumForkNeedsSoftwareGpu` is identical in 1.8.1 and 1.8.2 (verified by diffing the function
out of both tarballs). What 1.8.2 adds is `BETTERWRIGHT_BACKEND=auto|chromium-fork|cloak`
(`configuredBrowserBackend` / `selectManagedBrowserBackend` in `dist/src/chromium-fork.js`), which
is absent from 1.8.1 entirely — no occurrence of the name exists anywhere in the 1.8.1 dist.
Forcing it does route the sandboxed lane onto the native fork, 5/5 in both arg configurations.

**The changelog framing checks out.** 1.8.2 is described as "a compatibility patch for the two
regressions reported in [#111]", and the 1.8.1 notes reference "the issue's 44% report" — the
`like headless` figure from Beckett's own 1.8.0 creepJS capture in the first half of this document.
The 1.8.2 notes also state plainly that "the speed and memory table in #111 was collected after
1.8.1 had silently selected CloakBrowser" and that 1.8.2 "makes no new speed or RSS claim." That
matches what is measured here.

## Two changes to `src/browser/isolated.ts` were needed to take the measurement at all

Neither relaxes a bwrap flag and neither touches `browser_chromium_args`. Only the second is new
code on this branch; the first was found here, fixed in parallel, and landed separately as #258
before this pass was merged.

**1. The merged fork bind (#256) was probing the wrong filename — a silent no-op.** It mirrored
upstream's artifact layout as `linux-x64/chrome`, but 1.8.0 renamed the fork to BetterChromium and
renamed its binary with it: 1.8.0, 1.8.1 and 1.8.2 all use `linux-x64/betterchromium` (and
`mac-arm64/BetterChromium.app/…`, `win-x64/betterchromium.exe`). The installed artifact on this box
is `~/.betterwright/chromium/linux-x64/betterchromium`, so the existence check never matched, the
env var was never set, the directory was never bound — and the forced native backend could not have
been measured. **The name is version-dependent**, which is why one constant cannot serve both pins:
1.7.2 genuinely does use `linux-x64/chrome`, and an explicit `BETTERWRIGHT_CHROMIUM_ROOT` is
*strict* upstream, so simply hardcoding the 1.8 name broke 1.7.2 with
`BetterWright Chromium binary not found: …/linux-x64/chrome` on every launch (observed, 2/2
configurations, before the fix).

The version-aware layout is now on `main` as `chromiumForkLayoutFor()` (#258), selected from the
pinned package's own major.minor; the 1.8.2 runs below were taken against the equivalent fix on
this branch, which #258 supersedes. While the pin is 1.7.2 the bind stays inert either way — the
1.7.x probe finds no `linux-x64/chrome` on this box — so nothing in the numbers below depends on
which of the two spellings of the fix was in the tree.

**2. `BETTERWRIGHT_BACKEND` had no way through `--clearenv`.** The override is the entire point of
finding B, and the sandbox clears the environment. It is now forwarded with `--setenv`, gated the
same way the existing lease controls are: only when the operator actually set it, and only for the
betterwright backend, so a default launch's command line is unchanged and `auto` still governs.

## Method (deltas from the 1.8.0 pass)

Same harness (`bun run browser:bench` → `scripts/bench/browser-lane.ts`), same local loopback
fixture, same 100 ms process-tree sampling, same 6 warm iterations per run. Added for this pass:

- `scripts/bench/betterwright-matrix.sh` — 5 rounds; each round installs 1.7.2, measures it twice,
  installs 1.8.2, measures it four times. Alternating within the round, so machine drift lands on
  both versions rather than pooling on whichever ran last. Failures are recorded as failure
  objects, not dropped.
- Six configurations = {1.7.2, 1.8.2} × {stock, shared} × {auto, forced-native for 1.8.2}, where
  **stock** is Beckett's shipped `browser_chromium_args` untouched, and **shared** is
  `["--disable-gpu"]` — the list both versions accept with no compatibility drop, so the arg lists
  are identical on both sides. `BROWSER_BENCH_CHROMIUM_ARGS` supplies the shared list to the bench
  only; the shipped default is never edited.
- Per-iteration warm samples and the per-lease total are recorded, because the warm loop is bimodal
  on 1.7.2 and a percentile alone hides what a lease really costs.

## Performance — full matrix

Medians of 5 with [min, max]. Every row is labelled with the backend the process tree actually ran.

### Stock config (Beckett's shipped `browser_chromium_args`)

| Metric | 1.7.2 · **Obscura + CloakBrowser** | 1.8.2 auto · **CloakBrowser** | 1.8.2 forced · **BetterChromium** |
|---|---|---|---|
| Launches | **5/5** | **5/5** | **5/5** |
| Cold lease acquire | 970.3 ms [961.0, 979.4] | 1551.8 ms [1537.3, 1556.2] | 1676.7 ms [1667.2, 1714.3] |
| Warm p50 | 182.9 ms [179.0, 191.1] | 170.0 ms [162.0, 183.7] | 176.5 ms [167.6, 215.0] |
| Warm p95 | 3431.0 ms [3419.6, 3451.9] | 210.5 ms [187.7, 239.9] | 248.5 ms [239.9, 260.8] |
| Warm min | 171.5 ms [131.1, 183.7] | 147.1 ms [124.2, 166.1] | 165.2 ms [164.1, 181.7] |
| Warm loop total | 5265.1 ms [5168.7, 5332.0] | 1024.6 ms [975.5, 1118.4] | 1206.2 ms [1131.5, 1318.5] |
| **Total lease cost** | 6232.0 ms [6129.7, 6311.4] | **2580.8 ms [2512.8, 2662.6]** | 2879.3 ms [2808.2, 2997.5] |
| Peak process-tree RSS | 1109.7 MiB [1090.7, 1186.3] | 1079.9 MiB [1078.6, 1083.1] | 1769.7 MiB [1721.8, 1797.9] |
| Active CPU-seconds | 4.10 s [3.97, 4.25] | 3.39 s [3.32, 3.47] | 7.83 s [6.77, 8.43] |

### Shared arg list (`["--disable-gpu"]`, identical on both sides)

| Metric | 1.7.2 · **Obscura + CloakBrowser** | 1.8.2 auto · **CloakBrowser** | 1.8.2 forced · **BetterChromium** |
|---|---|---|---|
| Launches | **5/5** | **5/5** | **5/5** |
| Cold lease acquire | 969.7 ms [955.0, 978.3] | 1570.9 ms [1554.5, 1663.5] | 1685.1 ms [1646.0, 1770.9] |
| Warm p50 | 186.8 ms [164.6, 200.1] | 174.5 ms [166.1, 184.9] | 186.6 ms [184.0, 196.7] |
| Warm p95 | 3420.0 ms [3415.3, 3452.7] | 220.1 ms [198.2, 275.4] | 245.8 ms [231.9, 277.4] |
| Warm loop total | 5246.7 ms [5132.7, 5347.9] | 1083.2 ms [1066.6, 1159.7] | 1229.8 ms [1142.2, 1270.0] |
| **Total lease cost** | 6217.9 ms [6102.4, 6326.1] | **2649.9 ms [2621.0, 2787.8]** | 2943.5 ms [2788.2, 3000.7] |
| Peak process-tree RSS | 1099.0 MiB [1097.2, 1167.0] | 1078.7 MiB [1076.8, 1087.2] | 1769.6 MiB [1753.9, 1776.5] |
| Active CPU-seconds | 4.03 s [3.97, 4.23] | 3.51 s [3.41, 3.62] | 8.04 s [6.65, 8.20] |

**Stock and shared barely differ, and for 1.7.2 that is expected**: every 1.7.2 run returns
"chromiumArgs apply only to the on-demand pixel renderer; Obscura ignored them for resident
execution" — Beckett's Chromium args never reached 1.7.2's DOM runtime in the first place. On 1.8.2
the only difference between the two lists is the dropped-flag warning; the numbers overlap.

### Where 1.7.2's 3.4-second warm p95 goes

The per-iteration series makes the bimodality concrete. One representative run of each:

```
[1061.2, 3422.0, 181.0, 189.7, 162.1, 152.8]   ← 1.7.2: two slow iterations, then steady state
[ 187.7,  151.9, 172.1, 164.4, 165.7, 133.7]   ← 1.8.2 auto: no spike at all
[ 259.0,  189.0, 184.6, 166.9, 164.4, 167.6]   ← 1.8.2 forced native: no spike at all
```

1.7.2 pays roughly 4.5 s once per lease to stand up the separate CloakBrowser pixel renderer that
produces the proof screenshot, because Obscura does the DOM work and cannot render pixels. 1.8.2
has no such split — one browser does both — so that cost disappears entirely. **This, not the
acquire step, is where the 58.6% comes from**, and it is why the isolated cold-acquire regression
does not translate into a slower lane: no caller ever pays `acquire()` without then doing work.

Steady-state per-iteration cost is effectively a tie (182.9 vs 170.0 ms medians, overlapping
ranges). Nothing here suggests 1.8.2 is faster at ordinary DOM interaction; it is faster at
*finishing a lease*.

### The forced-native lane is the expensive one

Forcing `BETTERWRIGHT_BACKEND=chromium-fork` gets the native fork into the sandbox — and costs
**+59.5% peak RSS (1109.7 → 1769.7 MiB)** and **+91.0% CPU (4.10 → 7.83 s)** against 1.7.2, while
still being ~54% faster than 1.7.2 on total lease cost. On this 4-core box with the lane's default
3-lease cap, 1.77 GiB per lease is a materially different memory profile. If 1.8.2 were ever
adopted, the default (auto → CloakBrowser) routing is the cheaper lane, not the forced one — which
is an odd place to end up, since the native fork is upstream's headline backend.

## Reliability — 1.8.2

Two independent signals, as in the first pass.

| Signal | 1.7.2 | 1.8.2 |
|---|---|---|
| Live-lane launches, stock config | **5/5** | **5/5** auto · **5/5** forced native |
| Live-lane launches, shared args | **5/5** | **5/5** auto · **5/5** forced native |
| `bun run test:browser` (99 tests) | **99/99 pass, 5 runs of 5** | **99/99 pass, 5 runs of 5** |

Raw output: `bench-results/test-browser-1.7.2.txt`, `bench-results/test-browser-1.8.2.txt` (each
holds all five runs and their exit codes). Run durations were 100–112 s each; every run exited 0.

The suite is 99 tests now, not the 89 of the first pass — the repo has gained tests since, including
two added here for the layout and the backend passthrough. As noted in the first pass,
`runtime.test.ts` runs with `sandbox: "none"`, so `test:browser` is a real signal for the
client/policy/adapter code but is *not* a live-lane launch test; the 30/30 lane launches above are.

Reliability is therefore a **clean tie at ceiling**. That is a genuine result, not a shrug: 1.8.2 no
longer fails to launch the way 1.8.0 (0/5) and 1.8.1 (0/5 on stock config) did. Finding A is fixed.

## creepJS — 1.8.2

Captured with `betterwright run <snippet> --close` against
`https://abrahamjuliot.github.io/creepjs/`, ~21 s of settle time, reading the page's
**self-computed** detection signals. As established in the first pass, the aggregate "trust score %"
comes from a creepjs backend fetch that does not return inside betterwright's 30 s snippet cap, so
it is not quoted here for any version. Snippet: `bench-results/creepjs/fp-1.8.2.js`; raw captures:
`bench-results/creepjs/capture-*.json`.

**One honest limitation.** `betterwright run` drives the version's own persistent browser
*unsandboxed*, so its `auto` routing sees the real `/dev/dri` and picks the native fork — the
opposite of what the sandboxed lane picks. So 1.8.2 was captured **twice**, once per backend, by
forcing the selector: the `cloak` capture is the engine the production lane would actually run, and
the `chromium-fork` capture is the engine the forced lane runs. Neither capture was taken *inside*
bubblewrap (the lane's bench fixture is loopback-only); they are the same backends driven from
outside it. `auto` was also captured and is byte-identical to the forced-native capture, which
confirms the selector rather than adding a third data point.

| Signal | 1.7.2 (Obscura → **CloakBrowser 145**) | 1.8.2 auto-in-lane (**CloakBrowser 146**) | 1.8.2 forced (**BetterChromium 151**) |
|---|---|---|---|
| User-Agent | `…Windows NT 10.0; Win64; x64… Chrome/145.0.0.0` | `…X11; Linux x86_64… Chrome/146.0.0.0` | `…Macintosh; Intel Mac OS X 10_15_7… Chrome/151.0.0.0` |
| platform / device | `Win32` | `Linux x86_64`, cores 8, ram 8 | `MacIntel`, Mac macOS Catalina, cores 12, ram 16 |
| `navigator.webdriver` | `false` | `false` | `false` |
| Headless heuristic | *page never rendered it* | chromium: true · **44% like headless** · 0% headless · 0% stealth | chromium: true · **44% like headless** · 0% headless · 0% stealth |
| WebGL | present, **fabricated** `ANGLE (NVIDIA … RTX 3060 Direct3D11)`, rotates | present, **78 params / 59 exts**, `ANGLE (NVIDIA … RTX 4070 Laptop GPU, OpenGL 4.5.0)` | images/pixels/params/exts **all blocked**, `gpu: blocked` |
| WebRTC | — (page stalled) | host **blocked**, stun **blocked**, foundation/ip unsupported | host **blocked**, stun **blocked**, foundation/ip unsupported |
| creepJS FP completes | **no** — `FP ID: Computing…` | **yes, 1470.6 ms** | **yes, 571.7 ms** |
| Lies detected | n/a (never rendered) | **0** (no Lies pheno rendered) | **0** (no Lies pheno rendered) |
| Canvas | — | present, no rgba-noise figure reported | present, ~16% rgba noise |

**1.7.2 stalls again, reproducing the first pass.** Two fresh attempts here: a single 21 s call and
a two-call persistent session totalling ~52 s. Both ended at `FP ID: Computing…` with the fuzzy hash
all zeros and every creepJS section unpopulated — so the `0% headless / 0% stealth` the page shows
for 1.7.2 is an artifact of an unrendered page, **not** a clean score, and is not read as one here.
Its identity also **rotated again** between the two attempts: 8 → 12 cores, and the fabricated GPU
went `RTX 3060 Direct3D11` → `RTX 2070 SUPER Direct3D11`. Two visits never match.

**No host-GPU leak in either version.** This box's real GPU is Intel HD integrated graphics on the
`i915` driver. Every CloakBrowser capture reports an NVIDIA part (RTX 4070 Laptop / RTX 3060 /
RTX 2070 SUPER) and 1.8.2's Cloak run reports kernel `Linux 6.11.0` against a real 7.1.4 — all
fabricated, none leaked. The check matters because a fabricated-GPU stealth layer that accidentally
passed the host's real renderer string through would be a serious regression; it does not.

**Verdict on the fingerprint surface: no regression, and an improvement on what can be measured.**
The engine the 1.8.2 lane would actually run (CloakBrowser 146) presents a **coherent Linux
identity** — Linux UA, Linux `userAgentData`, an OpenGL/ANGLE renderer — where 1.7.2 presents a
fabricated **Windows/Direct3D11** profile from a Linux host that rotates per session. It completes
creepJS's fingerprint in 1.47 s with **0 lies**, where 1.7.2's stack cannot finish the page at all
within ≤52 s. The one signal that is genuinely worse in 1.8.2's *forced-native* lane is the same one
flagged for 1.8.0: WebGL fully blocked while claiming macOS, an internal inconsistency that feeds
its 44% `like headless`. That lane is not the default and is not recommended.

Note the `44% like headless` is identical for both 1.8.2 backends and identical to 1.8.0's, so it is
not tracking WebGL availability — CloakBrowser 146 exposes a full WebGL surface and still scores
44%. It is not a differentiator between these options.

## Decision — 1.8.2

**Pin stays at `1.7.2`.** Verified in `package.json` before and after commit.

The policy is: move only if the candidate wins outright on **both** performance and reliability
without regressing the fingerprint surface.

- **Reliability: tie, no win.** 5/5 vs 5/5 live-lane launches in every configuration; 99/99 ×5 on
  `test:browser` for both. The policy asks for a win and there is none to be had.
- **Performance: one named regression.** Cold lease acquire **970.3 → 1551.8 ms (+59.9%)**,
  [min,max] ranges disjoint. That is the deciding number.
- **Fingerprint: no regression** (an improvement on the measurable checks).

Judgement, stated so it can be argued with: **1.8.2 shipped today, as the third BetterWright release
of 2026-08-12** — 1.8.0 broke the lane, 1.8.1 broke stock config, 1.8.2 fixes 1.8.1. Nothing about
Beckett's browser lane is currently hurting, and moving production onto a same-day third patch to
collect a latency win is a trade with no deadline attached. A hold costs nothing here.

**And the counter-case, stated just as plainly, because it is strong:** 1.8.2 finishes a lease in
**less than half the time** (6232.0 → 2580.8 ms, −58.6%, disjoint ranges), uses **17.3% less CPU**
and **2.7% less RSS** on its default lane, launches 5/5, passes 99/99 five times, and improves the
fingerprint surface. The single regression is in a sub-step no caller ever pays alone. This is a
close decision resolved by policy and release recency, not by the numbers — the numbers favour
1.8.2.

### What would flip the pin

Any one of these should be read as sufficient to move to 1.8.x, re-running this matrix to confirm:

1. **A 1.8.x release that is not a same-day patch** — a week of it being current, with no 1.8.3
   fixing it — removes the recency objection entirely and leaves only the acquire regression.
2. **Upstream fixing the `/dev/dri` probe** (e.g. probing capability rather than mount visibility)
   so the sandboxed lane selects the native fork without an env override. Today, adopting 1.8.2
   means production quietly sits on the compatibility backend, with a routing warning on every
   result, because of sandbox geometry rather than choice.
3. **The cold-acquire regression being explained or closed.** +582 ms on every lease is the only
   number 1.8.2 loses on; if it turns out to be a fixable startup cost rather than the price of the
   backend, the hold has nothing left to stand on.

What should **not** be done to chase this: forcing `BETTERWRIGHT_BACKEND=chromium-fork` in
production. It buys the native fork at +59.5% RSS and +91.0% CPU, and it is slower than the default
auto lane on every timing metric measured here.

### Landed regardless of the pin

The `linux-x64/chrome` vs `linux-x64/betterchromium` layout bug described above was a real defect in
#256, independent of which version is pinned: as merged, the fork bind never bound anything on
1.8.x, and hardcoding the new name breaks 1.7.2 outright. It is fixed on `main` in #258, and the
`BETTERWRIGHT_BACKEND` passthrough lands here — so the next attempt at this upgrade cannot silently
measure CloakBrowser and call it BetterChromium, which is precisely the trap this pass was set up to
avoid.
