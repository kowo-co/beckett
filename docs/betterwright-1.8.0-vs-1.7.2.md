# BetterWright 1.8.0 vs 1.7.2 — perf, reliability, creepJS

> Measurement task, not an upgrade. The question was: does BetterWright 1.8.0 beat the pinned
> 1.7.2 on Beckett's live browser lane, and does it hold up on the creepJS fingerprint page? The
> answer decides one line in `package.json`. All numbers below are measured on this box
> (4-core Linux x64, kernel 7.1.4, Node 26.4.0, Bun 1.3.14) on 2026-08-12, alternating and
> repeated; nothing here is a vendor claim carried over unchecked.

> **Superseded in part.** Everything below the "1.8.2" heading is a later, independent
> measurement pass against BetterWright **1.8.2** (2026-08-12), taken after the sandbox fork
> bind landed. The 1.8.0 material is kept intact as the historical record of why 1.8.0 could
> not run at all. The pin decision that stands today is the one in
> [Decision — 1.8.2](#decision--182), not the 1.8.0 one.

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

---

# BetterWright 1.8.2 vs 1.7.2

> Second measurement pass, 2026-08-12, on the same box (Intel i7-4790, 4 cores / 8 threads,
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

## Two changes were needed in `src/browser/isolated.ts` to take the measurement at all

Neither relaxes a bwrap flag and neither touches `browser_chromium_args`.

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
configurations, before the fix). The layout is now selected from the pinned package's own
major.minor by `chromiumForkPlatformLayout`.

*This bug is live on `main` today.* It is inert while the pin is 1.7.2 — the wrong-name probe
simply finds nothing — but it means the fork bind that #256 shipped has never actually bound
anything, and it would have made any future 1.8.x adoption fall back to CloakBrowser silently.

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

### Also worth landing regardless of the pin

The `linux-x64/chrome` vs `linux-x64/betterchromium` layout bug described above is a live defect in
`main` from #256, independent of which version is pinned: as merged, the fork bind never binds
anything on 1.8.x, and hardcoding the new name breaks 1.7.2 outright. The version-aware fix and its
tests are included here so the next attempt at this upgrade does not silently measure CloakBrowser
and call it BetterChromium — which is precisely the trap this pass was set up to avoid.
