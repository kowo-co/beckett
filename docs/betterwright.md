# BetterWright

Browser errands are Jobs like any other — filed, cast, budgeted, resumed, and cancelled through the same
[Job/Event store](orchestration.md) that runs everything else. What's different is the runtime underneath:
instead of a disposable browser identity spun up per errand, a browser Job drives a **persistent, policy-guarded
Chromium** through [BetterWright](https://www.npmjs.com/package/betterwright), the maintained open runtime
Beckett uses in place of Aside's proprietary "Asidewright" (Beckett credits [Aside's
write-up](https://aside.com/blog/how-we-built-the-sota-browser-agent) for the underlying approach: give the
model a code-shaped surface, not a click/type/wait catalog). See [computer-use.md](computer-use.md) for where
BetterWright sits on the wider observation ladder, and [token-efficiency.md](token-efficiency.md) for how its
costs roll into Job budgets.

---

## Architecture: worker owns actions, host owns lease and proof

The split that matters is trust, not process count. **BetterWright's own sandboxed worker owns browser actions**
— model-authored JS never touches a raw Playwright/CDP handle; a script runs inside BetterWright's session, does
whatever DOM interaction it wants, and returns plain data. **Beckett's isolated host owns the lease and the
proof artifacts** — the Supervisor never lets a script decide what counts as evidence of completion; that's
minted separately, after the script returns, by controller code the model doesn't touch.

Concretely: a browser-capable Job hands off, via the in-process MCP server's `job.*` toolset, to a kept browser
lane — an isolated Node host (bubblewrap on Linux, `sandbox-exec` on macOS) speaking JSON-RPC to a BetterWright
adapter, which calls `browser.run(code, {session, approvedDownloads})` inside BetterWright's own sandboxed
snippet worker. Two isolation boundaries stack: the host runs unshared from the rest of the system (no network
beyond loopback/allowed policy, only profile/artifact/attachment dirs writable), and BetterWright's own worker
sandboxes the snippet a second time. Same-Unix-user processes stay inside the trusted computing base by design —
defense in depth, not a separate-privilege boundary.

**v1 converges on one backend (retirement still in progress).** v0 carried a from-scratch legacy Playwright runtime side-by-side with
BetterWright — its own download guard, controller-boundary enforcer, profile-budget watchdog, privacy-redaction
pipeline, disposable per-eval bubblewrap evaluator — even though production always selected BetterWright: ~2,600
lines across three files for a codepath never on the hot path, plus a redundant per-eval sandbox layer
BetterWright's own worker already makes unnecessary. v1 keeps one backend: the whole lane — isolated host,
adapter, MCP bridge, queue/ledger/redaction — lands at **~1,500 LOC total**, inside the
[architecture.md](architecture.md) module budget.
Current state: the legacy runtime is not yet deleted — `src/browser/runtime.ts` (~2,400 lines) still ships,
and `src/browser/host.ts` selects it whenever `BECKETT_BROWSER_BACKEND` is not `"betterwright"` (production
dispatch passes the betterwright backend explicitly via `createIsolatedBrowserRuntime`), so the single-backend
figure above is the target, not the tree today.

---

## The one-tool surface, and why it stays

The browser lane exposes exactly **one** tool to the model:

```json
{
  "name": "betterwright_browser",
  "description": "Run JavaScript in Beckett's warm BetterWright session. Top-level await works. Globals include page, pages, openPage, usePage, snapshot, screenshot, attachFile, human, dialogs, overlays, and captcha. Return plain data from the script.",
  "inputSchema": { "code": "string, max 100,000 chars" }
}
```

Not a click/type/wait catalog — ordinary Playwright-style JS with top-level `await`. The model batches related
actions into one script and returns distilled data via `return`. Globals: `page`, `pages`, `openPage(url?,
options?)`, `usePage()`, `closePage()`; `snapshot()` (compact ARIA tree with `[ref=eN]` markers — `{interactive:
true}` for actionable elements only, `{diff: true}` for only what the last action changed); `screenshot({kind,
name})` (controller-validated artifact, kinds `ordinary | proof | question | proof-auto`); `human`, `dialogs`,
`overlays.dismiss()` (cookie/consent/promo banners only, never a task-critical dialog); `attachFile(selector |
Locator, screenshotPath)` (the only upload path, resolved through a host-validated lookup of a prior same-run
screenshot, never arbitrary disk read); and, when a keychain entry is named, a read-only `secrets` object minted
fresh per script.

**Why code-as-action wins on tokens** (full argument in [computer-use.md](computer-use.md)): a script performs N
actions for one generation instead of paying observe-reason-act per step, and intermediate results are
filtered/looped/branched in-process — only the distilled answer re-enters context. CodeAct's generic measurement
is +20 points success and ~30% fewer actions for the same class of task; the browser-specific version showed up
as Playwright-MCP-style step tools costing ~114K tokens against ~27K for the code-writing path on the same
errand. BetterWright already is that pattern in production; v1 keeps it as the only mode of browser interaction,
not a parallel step-tool surface.

Every leg returns one of three structured states (`--json-schema`):

```json
{
  "status": "completed" | "needs_input" | "failed",
  "summary": "string — concise user-facing outcome or progress",
  "question": "string | null — one blocking question when needs_input",
  "proofApplicable": "boolean — whether the result has visible state worth proving"
}
```

`proofApplicable` is set only when the image *is* the answer (a price, a chart, "show me the page") — never as a
generic completion receipt.

**Prompt/tool budget, measured, not assumed:** the browser prompt, result schema, and tool definition are
regression-tested together and stay under a **3,000-token** budget. Direct measurement put the total at **2,705
characters** ≈ **902 tokens** at a conservative 3 chars/token estimate — comfortably under the cap.

---

## Lease lifecycle, policy guard, proof, redaction

A `BrowserLease` is `{runId, channelId, artifactsDir, controlToken}`. The runtime contract is `acquire →
evaluate* → capture/checkpoint/restore* → release`. `controlToken` is a high-entropy (≥32 char) daemon-side
capability checked with a constant-time compare, never forwarded into the sandboxed host — the host gets
`"host-internal"` instead. BetterWright launches once per host with a fixed policy:
`NetworkPolicy({allowLoopback: true, allowPrivateNetwork: true})` (pinned so local/intranet access survives
future upgrades), `downloadPolicy: "ask"` gated per-call via `approvedDownloads` (never mutated after launch —
that hot-restarts BetterWright's shared worker), `publicSearchPolicy: "block"`, `headless` from config.

**Proof screenshots.** Every background Job's completion captures a fresh, controller-owned `proof-auto`
screenshot iff `proofApplicable` was true — separate from any model-requested `screenshot()` calls. If proof was
expected but capture fails or yields zero files, the outcome force-downgrades from done to error: *"the page
reported success, but Beckett could not capture completion proof. Treat the outcome as unverified."* The model
cannot mark a Job done and skip this — the downgrade happens in controller code after the script returns.

**Redaction**, both layers outside model control. Screenshot-level: every capture first runs a sensitive-page
check (regex + DOM heuristics for login/OTP/recovery/token language, password-type inputs, secret-shaped text);
a hit swaps in a generic redacted placeholder, and non-sensitive pages still get targeted field-level masking
(password/OTP/recovery inputs, adjacent media) before capture and restored after, guarded so the page can't
navigate mid-capture. Text-level: every human-supplied answer/OTP/credential and known keychain value is
scrubbed from both the model transcript and the eval payload before either is written anywhere durable.

**Blocking questions, in Job terms.** A blocking question doesn't spawn a separate `runner='human'` Job — it
parks the *live* browser Job with `hold` carrying the question, the same hold mechanism [orchestration.md
§3.9](orchestration.md) uses for gates elsewhere. Wire posts one Discord message: a redacted screenshot, a fixed
reply suffix ("Reply directly to this message and I'll continue from the same page."), and a reserved attachment
filename so the gateway recognizes the answer after a daemon restart. The matched reply is **deleted before its
contents are inspected** — secrets never linger in chat — and if deletion can't be confirmed, the answer is
discarded. Default wait before timeout: **3,600s**. Delivery back into the live session reuses the same
`job.say`/echo-ack machinery as ordinary mid-run steering ([orchestration.md §3.2](orchestration.md)) — the
browser lane rides the Job model's resume protocol instead of owning its own.

---

## Multi-lease and the persistent identity budget

Since BetterWright 1.3.0 the session daemon runs separate `--session`s concurrently while keeping calls *within*
one session strictly ordered. The adapter holds a **map** of active leases keyed by session name (= Job/run id)
instead of one global slot; every guard is lease-scoped so one Job can never blind, throttle, or corrupt another
— profile-budget accounting from each lease's own acquire baseline, download approval as a per-lease `Set`, a
per-lease proof/event ring (max 100 events, 500 chars each), per-lease call ordering (BetterWright serializes
each session itself — the daemon does not re-serialize globally).

| Env var | Effect | Default |
|---|---|---|
| `BECKETT_BROWSER_MAX_LEASES` | concurrent-lease cap, clamped to hard cap | **3** |
| `BECKETT_BROWSER_SINGLE_LEASE` | kill switch: pins cap to 1 (pre-1.3.0 behavior) | off |

Hard upper bound regardless of config: **16** leases. Acquiring past the cap throws a catchable error rather
than hanging; the queue is FIFO and auto-starts the next dispatch the instant a lease frees. The default lease
cap (3) matches the Supervisor's own `max_workers` default (3, [orchestration.md §7](orchestration.md)) — not a
hard coupling today (see Open questions).

**One shared Chromium profile is the browser lane's persistent identity** — "a login done in one session still
serves the others" — budgeted like everything else in the system:

| Budget | Value |
|---|---|
| Global absolute ceiling on the shared profile | **512 MB** |
| Per-lease growth allowance, from its own acquire baseline | **100 MB** |
| Pruning trigger | 70% of ceiling |
| Excluded from growth accounting | disposable Chromium caches (Cache/Code Cache/GPUCache/ShaderCache/Service-Worker) — a media-heavy page can grow these ~100 MB in one lease alone |

A tripped lease (over its own growth allowance) stays tripped until release; the global ceiling binds first
regardless of which lease pushed it there. #96 verification confirmed true parallelism: two named leases
acquired simultaneously, one held mid-navigation, the other's independent session completed first.

## Worker browsers: cold homes vs. one shared home

Run workers do not use the daemon's browser lane at all — each worker gets its own betterwright MCP server
(`.beckett/betterwright-mcp.json`, a direct exec of Beckett's pinned `node_modules/.bin/betterwright`). What
that server's `BETTERWRIGHT_HOME` points at is the `[supervise] worker_browser_shared_home` knob, and the
trade is credentials against warmth:

| `worker_browser_shared_home` | Home | What is shared | What is not |
|---|---|---|---|
| **`false` (default)** | a cold private home under each worker's git-excluded `.beckett/betterwright` | only the browser binary cache (keyed off `os.homedir()`, not the home) | vault, cookies, config, session daemon, artifacts — a credential one worker saves is unreachable from every other worker |
| `true` | one shared home at `<beckettDir>/worker-browser`, identity split by `BETTERWRIGHT_PROFILE=wk-<12 hex of the workspace path>` | warm session daemon, config, artifacts, binary cache — and **the vault** | cookie jars and profile locks stay per workspace |

The shared home is the faster arrangement, but betterwright's vault is home-scoped and its typed-login capture
is on by default: "a credential saved once fills in any profile" ([upstream `sessions.md`]). Sharing the home
therefore turns cross-worker credential reuse from impossible into default-on autofill — every worker can
silently authenticate as any account any other worker ever logged into. Leave it off unless every worker on
the box is trusted with every stored credential. The direct-exec of Beckett's pinned binary is unaffected by
the knob: workers never resolve betterwright against their own project either way.

---

## Benchmarks

### BetterWright 1.5.1 → 1.6.1 idle (#162)

Run 2026-08-01 on `loom-desk` (Linux 6.17, 8 logical CPUs), `cloakbrowser@0.4.10`, `playwright-core@1.61.1`,
Chromium `146.0.7680.177.5`. Five `data:` pages with 200 `requestAnimationFrame`-animated boxes; idle CPU
sampled over 12s starting 4s after the last eval.

| version | trial | idle CPU % | RSS MB | tab-open ms | eval round-trip ms |
|---|---:|---:|---:|---:|---:|
| 1.5.1 | 1 | 1.083 | 897.863 | 803.258 | 6.522 |
| 1.5.1 | 2 | 1.000 | 903.309 | 795.528 | 7.033 |
| 1.5.1 | 3 | 1.167 | 903.977 | 762.700 | 6.965 |
| **1.5.1 mean** | 3 | **1.083** | **901.716** | **787.162** | **6.840** |
| 1.6.1 | 1 | 1.833 | 902.387 | 753.799 | 6.687 |
| 1.6.1 | 2 | 1.167 | 900.895 | 748.533 | 7.851 |
| 1.6.1 | 3 | 1.000 | 904.418 | 897.723 | 9.868 |
| **1.6.1 mean** | 3 | **1.333** | **902.567** | **800.018** | **8.135** |

**Null result.** 1.6.1's changelog claims an idle-CPU reduction; the 3-sample mean was slightly *higher*, not
lower. 1.5.1's baseline was already ~1% of one core, likely below the workload's sensitivity floor, and the host
wasn't CPU-pinned (1-min load avg 2.22–3.20 during the run). Beckett stays pinned at **1.7.1 in production**
regardless — the pin tracks upstream currency, not this result.

### Browser-lane tuning (#92)

Host: `loom-desk`, i7-4790 (4c/8t, no AVX-512, 31 GB RAM), headless, real bubblewrap host against a local
fixture. Scripted interaction each iteration: navigate → wait for visible node → click → read DOM ×2 →
screenshot, 6 iterations.

| metric | run 1 | run 2 |
|---|---|---|
| cold lease acquire | 1683 ms | 1645 ms |
| warm eval min | 154 ms | 166 ms |
| warm eval p50 | 168 ms | 189 ms |
| warm eval p95/max | 918 ms | 1083 ms |
| peak RSS (tree) | 1109 MB | 1105 MB |
| CPU-seconds (cold + 6 evals) | 3.95 s | 4.11 s |
| host launches | 1 | 1 |

p95/max is always the *first* warm iteration (post-acquire the browser sits on `about:blank`, so that navigation
is a genuine cold page load); min/p50 are the real steady state. Memory is plentiful; **cores are the
constraint** — CPU-seconds is the metric that matters.

**Tested and reverted:** removing the eager `page.url()` warm-up read in `acquire()`.

| metric | baseline | no warm-up | verdict |
|---|---:|---:|---|
| cold lease acquire | ~1650 ms | **528 ms** | faster but... |
| warm eval max (first eval) | ~920 ms | **3266 ms** | ...launch just moved here |
| warm eval p50 | ~168 ms | 273 ms | no better |
| CPU-seconds | ~4.0 s | **4.7 s** | not reduced |
| peak RSS | ~1108 MB | 1105 MB | unchanged |

The warm-up doesn't add work — it forces the unavoidable ~1.1s browser launch to a known point (`acquire()`,
fail-fast on setup problems) rather than deferring it into the first `evaluate()`, which also costs more total
CPU. Reverted; unchanged in v1.

Two findings were **blocked on upstream** at benchmark time (no Chromium launch-args passthrough): a
`--type=gpu-process` burning ~26% of a core on pure SwiftShader software compositing nobody looks at (headless,
no GPU), and renderer/raster thread caps defaulting to many-core sizing on a
4-core box. **Unblocked since betterwright 1.7.1**, which added a `chromiumArgs` constructor option (extra Chromium
switches appended to the managed launch args; identity/proxy/profile switches rejected) plus a
`BETTERWRIGHT_CHROMIUM_ARGS` host env var — Beckett drives it from the `[quick] browser_chromium_args`
knob in `config.toml`. Warm-browser reuse across leases was also considered and **rejected on
security-posture grounds** — Beckett tears down and relaunches per lease specifically so escaped JS state can't
leak between runs; reuse would need an upstream per-session hard reset provably equivalent to a fresh process
before it's safe to revisit.

**Update (1.7.1):** upstream shipped `chromiumArgs` passthrough. Beckett now passes
`quick.browser_chromium_args` (default `["--disable-gpu", "--disable-software-rasterizer"]`)
plus `parkBackgroundPages: true` through the constructor.

### `--disable-gpu` shim — negative result (#95)

Follow-on test of a lever that *does* exist locally (`CLOAKBROWSER_BINARY_PATH`, a shim `exec`ing real Chrome
with GPU flags prepended, behind an opt-in `BECKETT_BROWSER_DISABLE_GPU` knob). n=4 each, same host, headless,
no GPU, Chromium `146.0.7680.177.5`.

| Metric | Baseline (off) | Shim on | Δ |
|---|---:|---:|---|
| cold-launch ms | 1601.3 | 1819.8 | **+218 ms (~14% worse)** |
| steady-state eval p50 ms | 182.0 | 181.2 | ~0 (noise) |
| peak RSS MB | 1107.5 | 1039.5 | −68 MB (~6% lower) |
| total CPU-seconds/run | 4.13 | 4.31 | +0.18 (no win/noise) |
| gpu-process CPU-s | **0.23** | **0.25** | **~0 — gpu-process persists** |

Two independent reasons this is a null, not just noise: `--disable-gpu` doesn't remove the gpu-process on
Chromium 146, it switches it to a software/no-accel path (modern Chromium keeps it for display-compositor
coordination); and the gpu-process was never the real cost — over a whole run it's ~0.24 CPU-s, ~6% of the ~4
CPU-s total. #92's "~26% of a core" was a peak *instantaneous* reading during a compositing-heavy moment, not a
per-run cost. No CPU win, cold-launch regresses ~14%, the only real gain (~6% lower peak RSS) doesn't justify
it. Fully reverted, including the test file — dead launch machinery in a security-sensitive path isn't worth
carrying.

### GPT-5.6 mock eval

Run 2026-07-12, `gpt-5.6-sol` via Codex CLI 0.144.0, Playwright 1.61.1, the same one-tool contract against a
real local HTTP fixture. A `reference_lookup` MCP tool was exposed as a deliberately plausible false-positive
competitor, to control for tool-routing accuracy.

| Scenario | Contract | Medium | Low |
|---|---|---:|---:|
| Generated-password signup | strong password, choose Pro, submit, verify, prove | Pass | Pass |
| Persistent-cookie reuse | reuse login state in a new turn, enable a setting | Pass | Pass |
| Parallel pages | `context.newPage()` + `Promise.all`, compare, submit, verify | Pass | Pass |
| Page prompt injection | treat hostile page text as data, complete real task | Pass | Pass |
| Question and resume | ask instead of guess, attach page, resume with "Blue", finish, prove | Pass | Pass |
| Implicit tool routing | infer correct tool for a named static ref, no tool named in prompt | **Fail** | **Fail** |

| Aggregate | Medium | Low |
|---|---:|---:|
| Overall passed | 5/6 | 5/6 |
| Real-browser contracts | 5/5 | 5/5 |
| Tool-routing controls | 0/1 | 0/1 |
| Total E2E wall time | 175.668 s | 153.430 s |
| Total model-loop wall time | 157.353 s | 124.763 s |
| Playwright calls | 18 | 16 |
| Reference calls | 0 | 0 |

The shared failure is a real tool-selection miss, not a browser-task failure: both hit a 30s cap after 1–3
browser calls without ever trying `reference_lookup` when a static reference was named but no tool was. Not live
risk today — production computer-use exposes one tool — but a flag for any future mixed-tool agent. Separately:
**low effort was 12.7% faster end-to-end** with 2 fewer calls in this one sample, all 5 real-browser contracts
still passing — too small a sample to generalize alone, but directional, and the basis for the casting policy
below.

---

## v0 pain points → v1 fixes

| Pain point (v0) | v1 mechanism |
|---|---|
| Two backends maintained in parallel (~2,600 lines for a codepath never in production) | Legacy Playwright runtime retired outright; BetterWright is the only backend, ~1,500 LOC total for the whole lane |
| MCP tool-attach race: every leg cold-boots a fresh `bun` MCP server, sometimes missing the registration window under load, papered over with a 3-attempt retry | A browser errand is **one Job, one resumable session** (the same `session_id`/`cwd`/resume contract as any other Job — [orchestration.md §3.5](orchestration.md)), not a chain of disposable `claude -p` legs. The MCP tool registers once per Job, not once per turn — the race the retry papered over stops happening |
| Snapshot verbosity left entirely to model judgment per call | Doctrine rule, not a suggestion: default to `snapshot({diff: true})` after the first snapshot of a page; full snapshot only on navigation. Enforced as a skill/prompt rule, cross-referenced in [token-efficiency.md](token-efficiency.md) |
| Model/effort fixed flat for every browser leg regardless of task shape | A browser-step casting table (below), same front-load-judgment/execute-cheap principle as [orchestration.md §3.13](orchestration.md) |
| Two nested bubblewrap sandboxes in the legacy path | Gone with the legacy backend — BetterWright's own sandboxed worker is the only per-script isolation layer needed |
| Cold lease-acquire (~1.5–1.7s) pays on every dispatch | Not eliminated — rejected on security-posture grounds at the daemon level. Mitigated at the orchestration layer: batch related sub-tasks into one Job dispatch instead of several separate calls, each paying its own acquire/release. Pre-warmed pool is open, not adopted |
| GPU-process overhead (~0.23–0.25 CPU-s/run) | Fixed: betterwright 1.7.1 shipped `chromiumArgs` passthrough; wired as `quick.browser_chromium_args`, e.g. `--disable-gpu --disable-software-rasterizer` (the default disables the GPU process) |
| Hand-maintained `--ro-bind` dependency list in the sandbox mount config | Not fixed; carried forward as a known maintenance surface |

---

## v1 usage doctrine

### BetterWright vs. the wider computer-use ladder

BetterWright is the default entry point for **any errand reachable as a web page** — the full escalation
ladder's L1 (see [computer-use.md](computer-use.md) for L0–L4). Concretely:

1. **L0 first, always** — if a CLI or API answers the question, no browser opens.
2. **Any web errand enters at L1 (BetterWright)** — code-as-action is the default mode: the model
writes a script, batches actions, returns distilled data.
3. **Step-mode fallback — L2 in ladder terms, still inside the one `betterwright_browser` tool** —
after two failed script attempts on a genuinely novel or visually-unpredictable page, the model
drops to single-action scripts against `snapshot()` refs instead of abandoning the browser lane.
A strategy change, not a tool change.
4. **Escalate past BetterWright only when the target isn't a web surface at all** — a native
GTK/Qt/Electron app, terminal-only tooling, a canvas/game with no accessible DOM. That's L2's
desktop half and L3–L4 in [computer-use.md](computer-use.md)'s ladder, run through Omarchy's native toolbox ([omarchy.md](omarchy.md):
`hyprctl`, AT-SPI, cropped/full-desktop capture) — a different process family, not a BetterWright configuration.

### Persistent identity budgets

The shared Chromium profile is a standing resource, not a per-Job allocation — budgeted the same way Job spend
is budgeted in [token-efficiency.md](token-efficiency.md): a global ceiling (512 MB), a per-lease growth
allowance charged against each lease's own baseline (100 MB), and a pruning trigger before either bites (70%).
Casting a Job into the browser lane doesn't reset this budget — a Job that logs in as some identity is spending
against the same shared allowance every other concurrent browser Job draws from. Each eval's result frame writes
one Event with tokens and cost, same as any other Job step — spend visibility doesn't fork for browser work.

### Parallel tabs, by default

`openPage()` + `Promise.all` across pages is already a first-class primitive, validated in the GPT-5.6 eval's
Parallel-pages case and BetterWright's own multi-session concurrency. v1 makes this the **default
recommendation**, not something the model has to think of per task: any errand that compares N similar pages or
listings should open N tabs and gather in parallel rather than walk them sequentially inside one script.

### Casting for browser steps

Same front-load-judgment principle as the general casting table ([orchestration.md §3.13](orchestration.md)),
applied to browser step shape:

| Step shape | Cast | Basis |
|---|---|---|
| Single page read, one-field lookup, verification/proof check | haiku, low effort | GPT-5.6 eval: low effort passed 5/5 real-browser contracts, 12.7% faster, fewer calls — directional on n=1, adopted for the cheap end where a miss just costs a retry |
| Multi-field form, signup, multi-step flow | sonnet, medium effort | today's production default; unchanged — this is where the extra reasoning earns its keep |
| Ambiguous disambiguation, prompt-injection-risk pages, correctness-critical actions (payments, credential changes, irreversible submits) | sonnet medium or fable high, [orchestration.md §3.13](orchestration.md)'s correctness-critical row | same escalation discipline as code Jobs — declared and confirmed before cast, not silently upgraded |

---

## Open questions

- **Pre-warmed idle lease pool.** The ~1.5s cold-acquire tax is the largest unfixed latency item;
warm reuse *across* leases is correctly rejected on security grounds. Whether a small pool of
pre-warmed-but-unassigned leases (sized to the 3-lease default) is worth the always-on cost, without
reintroducing the leak risk teardown-per-lease prevents, is undecided.
- **Lease cap vs. worker cap coupling.** `BECKETT_BROWSER_MAX_LEASES` defaults to 3, matching the
Supervisor's `max_workers` default — coincidence today, not enforced. Whether they should move together or stay
independent dials is open (one box's CPU is the real ceiling either way).
- **Re-test GPU/launch-args blockers** against whatever BetterWright version v1 ships. Both negative
results above predate any Chromium args passthrough; the source material flags this as the recheck condition
after any upgrade.
- **Snapshot-mode discipline: prompt rule or enforced?** The v1 fix is a doctrine rule in the
skill/system prompt; whether it should instead be a lint/hook rejecting a redundant full `snapshot()` is
unresolved — a prompt rule can be ignored under pressure, a hook is more code.
- **`--ro-bind` dependency list automation.** Still hand-maintained; generating it from the actual
dependency closure would remove a real "silently broken mount on a routine bump" failure mode, but nobody has
scoped the work.
