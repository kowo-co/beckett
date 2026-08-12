# BetterWright 1.8.0 vs 1.7.2 — perf, reliability, creepJS

> Measurement task, not an upgrade. The question was: does BetterWright 1.8.0 beat the pinned
> 1.7.2 on Beckett's live browser lane, and does it hold up on the creepJS fingerprint page? The
> answer decides one line in `package.json`. All numbers below are measured on this box
> (4-core Linux x64, kernel 7.1.4, Node 26.4.0, Bun 1.3.14) on 2026-08-12, alternating and
> repeated; nothing here is a vendor claim carried over unchecked.

## TL;DR

**Hold the pin at 1.7.2.** 1.8.0 does not run on Beckett's production browser lane at all: it
removed Obscura and made a native **BetterChromium 151** fork the required backend, and that fork
is never bound into the lane's bubblewrap sandbox. The live-lane launch fails **5/5** with
`BetterChromium is required but not installed`. A version that cannot get a single green launch on
the sandboxed lane cannot win on reliability, so per the pin policy the pin stays at 1.7.2 — the
deciding number is **0/5 live-lane launches**, before any perf or creepJS comparison is even
reachable.

Fixing it would mean editing `src/browser/isolated.ts` to bind the fork directory and forward
`BETTERWRIGHT_CHROMIUM_ROOT` through `--clearenv`. The ticket explicitly forbids refactoring
`src/browser/**` to make a version work, and names this exact situation as "the finding." So this
report *is* the deliverable; the pin is unchanged.

| Metric group | 1.7.2 (live lane) | 1.8.0 (live lane) |
|---|---|---|
| Cold lease acquire (median of 5) | **997 ms** | — (launch fails) |
| Warm nav+interaction, p50 (median of 5) | **181 ms** | — (launch fails) |
| Peak process-tree RSS (median of 5) | **1100 MiB** | — (launch fails) |
| Active CPU-seconds (median of 5) | **4.2 s** | — (launch fails) |
| Live-lane launch reliability | **5/5 pass** | **0/5 pass** |
| `test:browser` (unsandboxed unit/integration) | 5/5 × 89 pass | 5/5 × 89 pass |
| creepJS engine | Obscura DOM runtime / CloakBrowser | BetterChromium 151 (real Chromium) |

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

## Method

- **Perf**: `bun run browser:bench` (`scripts/bench/browser-lane.ts`), unchanged. It drives the
  real isolated (bubblewrap) host through `createIsolatedBrowserRuntime({ backend: "betterwright" })`
  against a local loopback fixture, and samples the whole host+browser process tree at 100 ms for
  peak RSS and CPU. Cold = spawn host + launch + `acquire()`; warm = a fixed
  navigate→wait→click→read→screenshot loop, 6 iterations/run. 5 runs per version, alternating,
  `sleep 2` between. Raw JSONL in `bench-results/`: `bench-1.7.2.jsonl` holds the 5 successful
  report objects the harness prints on stdout; `bench-1.8.0.jsonl` holds one structured record per
  attempt for 1.8.0, since the harness only reaches the `stdout.write` on a successful `acquire()`
  and throws before it on failure — the 5 records there are the machine-readable counterpart to the
  stderr quoted below, captured from re-running the same harness against a live BetterChromium 151
  install (`betterwright setup` re-verified, same checksum) on this box.
- **Reliability**: two independent signals. (1) The live-lane bench above, which actually launches
  a browser — 5 attempts/version. (2) `bun run test:browser` (89 tests across
  `runtime/isolated/agent`), 5 runs/version. Note `runtime.test.ts` runs with `sandbox: "none"`
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
  actually reads off the page. Snippets and raw JSON in `bench-results/creepjs/`.

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

Machine-readable form of the same 5/5: `bench-results/bench-1.8.0.jsonl` (one JSON object per
attempt — timestamp, exit code, error text, error location), re-captured for this revision with
`betterwright setup` re-verifying the BetterChromium 151.0.7922.108 install and the harness giving
the identical error at the identical `isolated.ts:640:29` call site on every one of 5 fresh runs.

Root cause, confirmed by reading `src/browser/isolated.ts`: the bwrap host binds the Obscura root
(`obscura.mountRoot`, ~line 356) and the CloakBrowser cache (`cloakCacheDir`, ~line 352) read-only
into the sandbox, and forwards their env vars via `--setenv`. It **never** binds
`~/.betterwright/chromium/` and never sets `BETTERWRIGHT_CHROMIUM_ROOT`. The sandbox runs
`--clearenv` with `HOME=/tmp/home`, so 1.8.0 looks for the fork under `/tmp/home/.betterwright/
chromium/`, finds nothing, and — by design — refuses to silently fall back to CloakBrowser. The
lane was built around Obscura+CloakBrowser; 1.8.0's mandatory native fork has no seam in it. This
is not a flake: it is 5/5 identical, and it is structural.

### `test:browser` unit/integration suite (5 runs each)

| Run | 1.7.2 | 1.8.0 |
|---|---|---|
| 1–5 | 89/89 pass, every run | 89/89 pass, every run |

Both versions pass this suite cleanly; it does not launch through bwrap (see Method), so its green
status on 1.8.0 is consistent with — not a contradiction of — the live-lane failure.

## Performance (1.7.2 baseline; 1.8.0 unmeasurable on the lane)

5 runs, live isolated lane, medians with [min, max] spread:

| Metric | 1.7.2 median | spread [min, max] |
|---|---:|---|
| Cold lease acquire | 996.8 ms | [986.4, 1086.1] |
| Warm eval p50 (per-run) | 180.6 ms | [153.7, 183.8] |
| Warm eval min | 159.2 ms | [145.9, 172.8] |
| Peak process-tree RSS | 1100.4 MiB | [1094.7, 1123.7] |
| Active CPU-seconds | 4.2 s | [3.9, 4.3] |

The warm loop's per-run **p95 is ~3.4 s**, consistently — that is the first warm iteration paying
to launch the Chromium pixel renderer for the `screenshot({kind:'question'})` proof. Every
subsequent iteration is ~150–180 ms. So "warm interaction" is bimodal: first-proof ≈ 3.4 s, then
≈ 180 ms; the median p50 above reflects the steady state.

1.8.0 has no row here because the lane never launches it. The vendor's off-box M4 numbers claim a
large nav+proof win, plausibly from the half-resolution proof encoding and the 3→2 renderer drop —
but that is unverifiable on Beckett's actual lane until the fork is bound into the sandbox.

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
| cores / RAM | **rotates** across the four captures, in order: 4, 6, 4, 16 cores / 4 GB every time |
| WebGL | **present, fabricated**, and also rotates: `ANGLE (Intel UHD Graphics 630 Direct3D11)` (×2), `ANGLE (NVIDIA GeForce GTX 1080 Ti Direct3D11)`, `ANGLE (Intel UHD Graphics 770 Direct3D11)` |
| creepJS FP completion | **never finished** (`Computing…`) within ≤45 s |

The identity is a fabricated **Windows/Direct3D** profile served from a Linux host, and it
**rotates** between launches — cores took 4, 6, 4, then 16 across the four capture attempts, and
the reported GPU rotated through two different Intel UHD parts *and* an NVIDIA GTX 1080 Ti, not
just a two-way swap — CloakBrowser's deliberate per-session identity rotation (raw captures:
`bench-results/creepjs/fp-1.7.2.json`, `fp-1.7.2-warm1.json`, `fp-1.7.2-warm2.json`,
`fp-1.7.2-final.json`). It exposes a full WebGL surface, which reads as more "normal" than a
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

## Decision

**Hold at 1.7.2.** Pin policy: move only if 1.8.0 wins or ties on **both** perf and reliability and
does not regress creepJS. 1.8.0 fails the reliability gate outright — 0/5 live-lane launches — so
perf and creepJS never get a fair comparison on the lane. The version whose suite ends green is
1.7.2 (verified: `bun run test` and `bun run test:browser`).

The real blocker is not BetterWright 1.8.0 being worse; it is that 1.8.0's mandatory native backend
has no binding in Beckett's bwrap browser lane. Adopting 1.8.0 is a `src/browser/isolated.ts`
change (bind `~/.betterwright/chromium/`, forward `BETTERWRIGHT_CHROMIUM_ROOT`), which is out of
scope for this measurement ticket and should be its own reviewed change — at which point the perf
and creepJS comparisons here should be re-run on the sandboxed lane.
