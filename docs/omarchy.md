# Beckett on Omarchy

Beckett v1 moves off a headless Ubuntu VPS onto the owner's actual desktop: a dedicated `beckett`
Unix account on an [Omarchy](https://omarchy.org) (Arch Linux + Hyprland) machine. This is not a
change of package manager — it's a change of home. Beckett stops being a tenant on rented compute
and becomes a second citizen of the box the owner already sits in front of. This doc covers what
Omarchy is, why its own conventions make that citizenship cheap, and where the account boundary
actually gets drawn.

Everything here that isn't read directly from Omarchy's source is labeled **[inference]**. That
label matters most in [§3](#3-becketts-own-desktop-headless-hyprland), where the entire
"Beckett has its own compositor" design is a hypothesis to pilot, not a shipped pattern — see the
crash-bug caveats there before treating it as load-bearing.

## 1. What Omarchy is

Omarchy is DHH's opinionated Arch Linux + Hyprland distribution — an "omakase" build that installs
from an ISO, defaults to full-disk LUKS encryption, and boots straight into a configured Hyprland
desktop with no distro-building required. It's MIT-licensed, developed in the open at
`github.com/basecamp/omarchy`, currently at stable `v3.8.4`. It is the Wayland/Arch sibling of
DHH's earlier Ubuntu-based Omakub.

Two things about Omarchy make it a good host for a coworker account rather than an awkward one:
it ships with coding agents already wired in as first-class citizens (§1.4), and its config model
is disciplined enough that a second account can adopt the same conventions without inventing new
ones.

### 1.1 The directory layout — the one rule everything else hangs off

```
~/.local/share/omarchy/     # Omarchy's own git checkout. READ-ONLY — overwritten by every
                             # `omarchy update`. Never edit.
├── bin/                    # ~280 omarchy-* scripts, symlinked onto PATH
├── config/                 # default config templates, copied into ~/.config on install/refresh
├── default/                # system-level defaults (autostart list, systemd units, pacman.conf)
├── themes/                 # 19 stock themes
├── migrations/             # 330+ numbered migration scripts, one per update cycle
└── install/                # the installer itself

~/.config/                  # USER-editable layer — this is what actually changes
~/.config/omarchy/
├── current/theme/          # symlink-swapped active theme (atomic: build "next-theme", then mv)
├── themes/<custom-name>/   # user-authored themes layered on stock ones
└── hooks/                  # theme-set, font-set, post-update automation hooks
```

`omarchy refresh <component>` resets `~/.config/<component>` back to shipped defaults (timestamped
backup, copy from `~/.local/share/omarchy/config/`, restart) — the sanctioned "undo my mess" path.
The rule that matters for anything Beckett touches on this box: never edit
`~/.local/share/omarchy/`, always work in `~/.config/`. Omarchy enforces this hard enough to ship
it as a skill file for coding agents (§1.4) rather than trusting people to remember it.

### 1.2 Hyprland config, walker, waybar, mako, uwsm

`~/.config/hypr/hyprland.conf` is a source-chain, not a monolith: it sources Omarchy's read-only
defaults, then the user's own `~/.config/hypr/{monitors,input,bindings,looknfeel,autostart}.conf`,
then a glob of runtime toggle files. Hyprland auto-reloads on save; `hyprctl reload` forces it,
`hyprctl configerrors` validates.

Three services round out the stable-branch (`v3.8.4`) desktop, each with a gotcha worth knowing
before scripting against it: **Walker** (app launcher, `~/.config/walker/config.toml`,
prefix-routed — `/` providers, `.` files, `:` symbols, `=` calc, `@` websearch, `$` clipboard —
backed by a separate search daemon called **elephant**; `omarchy restart walker` after edits);
**Waybar** (status bar, `~/.config/waybar/config.jsonc` + `style.css`, **does not auto-reload** —
every change needs an explicit `omarchy restart waybar`); **Mako** (notifications; no single
`mako.ini` — a shared `default/mako/core.ini` is `include=`'d by a per-theme template that injects
the active theme's colors; `omarchy-restart-mako`).

Omarchy runs Hyprland under **uwsm** (Universal Wayland Session Manager), not bare. The SDDM
session entry runs `uwsm start -g -1 -e -D Hyprland hyprland.desktop`, wrapping the whole graphical
session in proper systemd scoping — its own slice/scope, clean start/stop, environment import.
Every long-running app in the default autostart chain (`default/hypr/autostart.conf`) launches via
`uwsm-app -- <cmd>` rather than bare, so it too gets scoped into the session's cgroup instead of
orphaning off the compositor process. Session-wide env vars live in `~/.config/uwsm/env`; changes
there need a session restart, unlike `hyprland.conf`'s hot reload.

### 1.3 The `omarchy` CLI and the update model

A single dispatcher binary, `bin/omarchy`, scans every `omarchy-*` script on `PATH` for metadata
comments and builds a routed `omarchy <group> <action>` command tree — `omarchy theme set "Tokyo
Night"` dispatches to `omarchy-theme-set`. `omarchy commands --json` gives a machine-readable
listing, genuinely useful for an agent that needs to discover what it can do on the box without
guessing.

`omarchy update` runs three steps in a logged PTY: a pre-update snapshot
(`omarchy-snapshot create`), then `omarchy-update-git`, which fast-forwards
`~/.local/share/omarchy` against upstream and runs every pending script in `migrations/` — **330+
numbered, idempotent shell scripts** as of this writing, one per source change, each mutating live
user config to match whatever `~/.local/share/omarchy/config/` looks like today. This is the
mechanism that keeps a `~/.config` hand-edited years ago from bit-rotting against upstream, and
it's why Beckett's own config on this box should stay in the user-editable layer rather than
patching Omarchy's defaults directly — a migration could silently undo a patch made in the wrong
place. The actual package update (`omarchy-update-perform`) runs `pacman -Syu` / `yay -Syu` against
Arch's stock repos plus a fourth, Omarchy-owned one (`pkgs.omarchy.org`); `omarchy channel set
stable|rc|edge` picks the active release channel.

**Forward-looking, unverified in the wild**: the repo's default branch as of this research is an
unreleased `quattro` (`4.0.0.alpha`) rewrite that replaces waybar/mako/walker wholesale with a
custom QML/Quickshell shell and moves config to a package-backed model. Nothing on a real Omarchy
box runs this today (stable is `v3.8.4`), but Beckett tooling that hardcodes
`~/.config/waybar/config.jsonc`-style paths should treat that surface as provisional.

### 1.4 Omarchy already treats coding agents as first-class citizens

This is the most directly useful finding for the redesign, and it's read straight from shipped
source, not inferred: Omarchy's package list and install scripts assume the owner runs AI coding
agents on the box.

- `claude-code` is a plain entry in `install/omarchy-base.packages` — **Claude Code ships as a
  system package on every fresh Omarchy install**, next to `github-cli`, `docker`, `mise`, `neovim`.
- `install/packaging/npx.sh` lazily installs Codex, Gemini CLI, Copilot CLI, opencode, Playwright,
  and **Pi** (`@earendil-works/pi-coding-agent` — the same package Beckett's own installer pins) as
  self-installing stub wrappers on first invocation.
- `install/config/omarchy-ai-skill.sh` symlinks a bundled skill (`default/omarchy-skill/SKILL.md`)
  into every major agent's skill directory on first install — `~/.claude/skills/omarchy`,
  `~/.codex/skills/omarchy`, `~/.pi/agent/skills/omarchy`, `~/.agents/skills/omarchy`. It's the
  platform's own condensed answer to "how do I safely change this desktop": never edit
  `~/.local/share/omarchy/`, always use `~/.config/`, prefer `omarchy <group> <action>` over
  touching files by hand.
- Most notably: `bin/omarchy-sudo-passwordless` is a **built-in, first-party mechanism for giving
  an AI agent temporary root**, written explicitly with that use case in mind — directly reusable
  for Beckett's account rather than inventing a bespoke time-boxed sudo mechanism (§4.2).

The platform's opinion, in short: this machine expects coding agents to live on it. Beckett's
design leans into that rather than working around it.

## 2. The dedicated-account design

Omarchy is explicitly **single-user by design**, not by oversight. A GitHub Discussion
(`basecamp/omarchy#532`, "Support Multiple Users") has the maintainers confirming it directly:
full-disk LUKS encryption is tied to one login identity on purpose, and there is no built-in
multi-user or multi-seat feature. A second account is technically possible but gets zero tooling
help — the requester's ask for an official `omarchy-enable-multiuser` script was never built. Three
concrete single-user assumptions ship in a fresh install: one LUKS passphrase doubles as the login
and root password; SDDM autologins exactly one `User=` into exactly one `Session=omarchy`; and
`~/.config/omarchy` state has no accounting for a second identity sharing the box.

None of that blocks a second **Unix account** from existing and running background services — it
only means Omarchy gives it zero help getting a graphical session of its own. Everything below this
point in §2 and all of §3 is **[inference]**, assembled from general Arch/systemd/Wayland behavior,
not Omarchy documentation — the multi-user story simply isn't written down anywhere upstream.

### 2.1 Creating the account, and lingering as the actual backbone

`useradd --create-home --shell /bin/bash beckett`, groups added per actual need (§4.1), password
locked or left unset since the account never needs a TTY/SDDM login. Omarchy doesn't gate user
creation in any way — this is identical to what Beckett's current Ubuntu `install.sh` already does
(`ensure_beckett_user()`), unchanged on Arch. See [migration.md](migration.md) for the full
install-script diff.

`loginctl enable-linger beckett` is what lets `systemctl --user` units for the `beckett` account
run **without any login session ever existing** — no SDDM entry, no TTY, no held-open `ssh`
connection. This is exactly the mechanism Beckett's Ubuntu installer already relies on
(`loginctl enable-linger "${BECKETT_USER}"`, `systemctl start "user@${uid}.service"`), and it works
identically on Arch since `systemd/User` behavior isn't distro-specific. Once linger is enabled,
`/run/user/<uid>` and a per-user D-Bus session bus both exist persistently, and
`systemctl --user enable --now <unit>` behaves the same as it does today.

Omarchy's own background services (battery monitor, SwayOSD server, fcitx5) are ordinary
`~/.config/systemd/user/*.service` units following the shape `After=graphical-session.target` /
`ExecStart=%h/.local/share/omarchy/bin/…` / `WantedBy=graphical-session.target` — the same
primitive Beckett already uses (`beckett-v4.service`, `beckett-rpc.service` in `deploy/systemd/`).
No unit-format change is needed for the Arch port; the one thing worth reconsidering is that
`After=graphical-session.target` dependency, since that target only fires for a real logged-in
graphical session — which beckett's account, by design, may never have if it skips §3 entirely.

### 2.2 What does not work: no multi-seat story

logind's real multi-seat model (`loginctl attach`, distinct `seat0`/`seat1`, per-seat GPU and
input/output hardware) is the wrong tool here — each real seat needs its own GPU, and a single-GPU
desktop can't split into two independently-driven physical seats via logind. "Beckett gets a second
monitor as a second real seat" isn't available on typical hardware, and Omarchy adds no tooling on
top of stock logind that would change this.

The right framing for "beckett drives its own desktop" isn't a second seat at all — it's a second
Wayland **compositor instance** that never asks logind for seat/DRM-master ownership in the first
place (§3). That's a fundamentally lighter ask than multi-seat and never touches the owner's live
`seat0` session.

Should the goal ever expand to an actual graphical login for beckett — the owner physically
switching VTs to see beckett's desktop — that's the `ly`/second-SDDM-session path the GitHub
discussion describes as DIY and unsupported, and it re-adds the multi-seat GPU-contention question
above. **Recommendation for v1: skip this entirely.** It answers a requirement ("watch beckett's
screen live, in person") Beckett doesn't currently have — it already ships remote
proof-screenshot/artifact patterns for showing work (see [computer-use.md](computer-use.md)) — and
the headless route in §3 gets the "native, own desktop" benefit without any seat/SDDM complexity.

## 3. Beckett's own desktop: headless Hyprland

**[inference], throughout.** None of this is Omarchy- or Hyprland-documented for this exact use
case; it's assembled from wlroots/DRM/Hyprland general-purpose facts, cross-checked against
Hyprland's own GitHub issue tracker for the rough edges. Treat it as a design hypothesis to pilot
against the owner's real hardware, not a proven recipe to ship straight into v1.

### 3.1 The mechanism, and the caveat that governs it

wlroots (Hyprland's compositor backend library) supports a `headless` backend, selected via
`WLR_BACKENDS=headless` (plus `WLR_LIBINPUT_NO_DEVICES=1` to skip physical input entirely). A
compositor started this way never opens a DRM/KMS device for modesetting and never asks logind for
seat/DRM-master ownership — it has no "screen" to own. Virtual outputs are declared in config (the
same `monitor = …` stanza Omarchy already uses in `monitors.conf`, pointed at a `HEADLESS-1` name)
or created at runtime with `hyprctl output create headless HEADLESS-1`.

Concretely: a `systemctl --user` unit (same primitive as §2.1) running `WLR_BACKENDS=headless
Hyprland` under beckett's own UID gives beckett a real, running Hyprland compositor — its own
Wayland socket, its own `HYPRLAND_INSTANCE_SIGNATURE`, its own window tree — entirely independent
of, and invisible to, the owner's live `seat0` Hyprland session. No SDDM entry, no seat, no VT, and
zero changes to the owner's session config.

**Caveat worth stating plainly**: this is not bulletproof. Multiple open Hyprland GitHub issues
(#1917 "Crashing in headless mode," #3050 "need headless monitors," discussion #12690 "Headless
(virtual) output renders as black screen in 0.52.2") show headless mode has had real,
version-dependent rough edges, including on Nvidia. **Pilot this against the owner's actual
GPU/driver stack before committing v1's architecture to it** — the recommendation is pilot first,
not assume-and-build.

### 3.2 GPU access via the render group, not a seat fight

The reason §3.1 needs no seat/GPU-arbitration answer at all: Linux's DRM subsystem exposes two
device node classes per GPU — `/dev/dri/cardN` (the "primary" node, seat-gated, requires DRM master
for modesetting) and `/dev/dri/renderD1xx` (the "render" node, **not** seat-gated). Render nodes
exist so GPU-accelerated compute/render clients don't need a privileged display-server handshake —
plain Unix file permissions, gated by the `render` group, are sufficient. A headless Hyprland
instance under beckett's UID, with beckett added to `render`, should composite with real GPU
acceleration at the same time as the owner's live session on the same card — neither is fighting
over `cardN`/modesetting, only sharing the GPU's compute/render engine, the same way any two
unrelated GPU-accelerated processes on a desktop already do. Omarchy's own installer does *not* add
the owner's account to `render` (the owner gets GPU access through their real seat instead) —
adding beckett to it is a deliberate, beckett-specific choice, not a platform default. See §4.3 for
the fairness caveat this doesn't solve.

### 3.3 Driving it: hyprctl IPC, grim/slurp

Every Hyprland instance exposes two Unix sockets under
`$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/`: `.socket.sock` for synchronous
request/response (what `hyprctl` itself talks) and `.socket2.sock`, a push event stream (window
opened/closed, workspace changed, …). Because beckett's headless instance has its own
`$XDG_RUNTIME_DIR` (`/run/user/<beckett-uid>`), this socket is naturally private to beckett's UID
via normal Unix socket permissions — the owner's `hyprctl` has no visibility into it and vice
versa, with zero extra isolation work required. This gives Beckett a genuine, scriptable IPC
surface into its own window manager — move/resize/focus windows, query state, drive workspace
layout.

Capturing pixels is exactly the tool chain Omarchy ships and uses itself, read directly from
`bin/omarchy-capture-screenshot`: **grim** (a `wlr-screencopy` protocol client that works against
any wlroots compositor's output, headless or not) driven by geometry pulled from `hyprctl monitors
-j` / `hyprctl clients -j`, optionally cropped via **slurp**. None of this cares whether the output
is a real monitor or a headless virtual one — the protocol is the same. Point `grim` at beckett's
own `$XDG_RUNTIME_DIR`/`$WAYLAND_DISPLAY`/`$HYPRLAND_INSTANCE_SIGNATURE` instead of the owner's,
and Omarchy's own screenshot script becomes a near-drop-in template for "beckett takes a screenshot
of its own desktop" — see [computer-use.md](computer-use.md) for how that slots into Beckett's
existing proof-screenshot and browser-automation paths, which today are Playwright/CDP-only.

If a human ever wants to actually watch beckett's screen live, **wayvnc** — a VNC server built for
wlroots compositors — can attach to the same headless session and serve RFB on a loopback or LAN
port, independent of the owner's session. A known community pattern, not an Omarchy built-in; it
would be Beckett's own opt-in systemd unit, loopback-only or behind an SSH tunnel.

**Unverified, not recommended for v1**: whether `uwsm start` (§1.2) is meant to run standalone,
outside a display-manager `Exec=` line, for a seatless headless instance is not documented or
demonstrated anywhere upstream — every reference found assumes a login-manager-issued session.
Running bare `Hyprland` directly under the `systemd --user` unit (skipping uwsm) is the safer
starting point for a pilot, since it sidesteps an integration point nobody has documented working
headless.

**Rejected alternative**: wlroots also supports `WLR_BACKENDS=wayland`, nesting the compositor as
an ordinary Wayland client inside another running compositor (the way Xephyr nests X11). Real
capability, wrong fit — it requires attaching to the owner's own `WAYLAND_DISPLAY`/session, the
opposite of the isolation goal here.

## 4. Security and isolation between the accounts

Mix of documented Omarchy/Arch control knobs and **[inference]** about how to use them for this
specific two-account design.

### 4.1 Filesystem, and groups as the real shared-resource control surface

Standard Unix account separation: `/home/beckett` owned `0700` by `beckett`, no group-readable
overlap with the owner's `$HOME`. This is exactly what Beckett's Ubuntu installer already enforces
(`ensure_beckett_user`'s ownership/mode checks, the `.beckett` state dir at `0700`) and needs zero
change on Arch.

Beyond the filesystem, Omarchy's install scripts show exactly which groups gate which shared
hardware, and each is a deliberate per-account decision, not a default:

| Group | Grants | Omarchy's own usage | For `beckett` |
|---|---|---|---|
| `render` | GPU compute/render via `/dev/dri/renderD*`, no seat needed | not added (owner uses their real seat) | **add** — enables §3's headless compositor |
| `video` | broader `/dev/dri/card*` framebuffer-adjacent access | not added | avoid unless a need appears; `render` should suffice |
| `input` | raw `/dev/input/*` — dictation, controllers | owner added, for dictation + controllers | **skip** — no physical input needs |
| `docker` | effectively root-equivalent daemon access | owner added | **skip** unless beckett deliberately shares the daemon — prefer rootless container tooling |
| `wheel` | sudo eligibility | owner is wheel by install-time design | don't add statically — see §4.2 |

### 4.2 Sudo: reuse `omarchy-sudo-passwordless`, don't reinvent it

`bin/omarchy-sudo-passwordless` (§1.4) is directly reusable rather than a new mechanism: it grants
`NOPASSWD: ALL` via a `/etc/sudoers.d/99-omarchy-nopasswd-<user>` drop-in, arms a `systemd-run
--on-active=<N>m` timer that deletes the drop-in automatically, and prints this warning before
doing it:

```
This is useful for AI agents that need to run sudo commands,
but it significantly weakens the security of your system.
```

For `beckett`, this maps cleanly onto Beckett's existing pattern of narrowly-scoped, explicit
privilege escalation — its Ubuntu installer already avoids blanket sudo (`install.sh`: "Do not give
this account unrestricted passwordless sudo on a public/shared host"). On Arch, the same script,
invoked as `beckett`, gives a clean N-minute root window for whatever a piece of work genuinely needs root
for (a `pacman -S` install, say), auto-closing itself — strictly better than either blanket
passwordless sudo or a bespoke reimplementation. This is the one piece of the design where Omarchy
hands Beckett the exact primitive it needs, built by someone who had the identical problem first.

### 4.3 Polkit, shared directories, and GPU fairness

Polkit governs privileged desktop-adjacent actions (mounting, network changes, power) via rules in
`/usr/share/polkit-1/rules.d` (package-owned) vs. `/etc/polkit-1/rules.d` (host-local overrides).
Omarchy autostarts `polkit-gnome-authentication-agent-1` per-session so the owner gets an
interactive prompt when something needs elevated privilege through polkit. **[inference]**: if
beckett's headless compositor never launches anything that routes through polkit — no
NetworkManager GUI actions, no disk-mount dialogs, plausible for a coding-agent workload — it never
needs its own polkit agent instance. If it ever does, that agent has to start inside beckett's own
session; it can't piggyback on the owner's, since polkit authorization is tied to the requesting
user's session.

**[inference/recommendation]**: resist bind-mounting or group-sharing the owner's `$HOME` with
`beckett` for convenience. If beckett needs to hand the owner a file, route it through an explicit
narrow channel — a Discord attachment or a permissioned drop directory — the same way Beckett
already treats deliverables, rather than filesystem-level sharing that silently widens over time.

**[inference]**: the render group (§3.2) solves GPU access, not fairness — there's no default
cgroup-level GPU time/memory quota the way there is for CPU (`CPUQuota=`) or memory (`MemoryMax=`)
in a systemd unit. A runaway beckett workload doing heavy screenshot/video capture in a loop could
visibly degrade the owner's live desktop responsiveness. Since beckett's compositor runs under an
ordinary `systemd --user` unit, the mitigation is the same one Beckett leans on for CPU/process
bounds elsewhere (`prlimit`, per the browser sandbox in `deploy/host-setup.md`): apply
`CPUQuota=`/`MemoryMax=`/`IOWeight=` on beckett's own units as a blast-radius cap, even though none
of it throttles GPU engine time directly.

### 4.4 LUKS is single-owner — app-level secret protection still carries the load

Because Omarchy's full-disk LUKS passphrase is, by design, the same credential as the primary
user's login/root password (§2, confirmed via the GitHub discussion), disk encryption protects the
machine at rest, before boot — it says nothing about isolation between accounts once the disk is
unlocked and both are live. `beckett` gets no separate at-rest secret from the OS. This changes
nothing about what Beckett already does for its own credentials (`~/.beckett/.env`,
`~/.claude/.credentials.json` at mode `0600`, age-encrypted off-box backups per
`deploy/host-setup.md`) — that app-level protection is exactly as necessary on Omarchy as it is on
Ubuntu today, since OS-level encryption was never doing that job.

## 5. The Arch install path vs. the Ubuntu installer

Most of Beckett's current `install.sh` is already OS-agnostic bash gated behind an `ubuntu|debian`
check — the genuinely Ubuntu-specific surface is smaller than the file's length suggests. This
section covers what's Omarchy-specific about the port; full step-by-step cutover mechanics live in
[migration.md](migration.md).

**Already OS-agnostic, no change needed**: `ensure_beckett_user()` (useradd, linger, `systemctl
start user@<uid>`), `install_node()` (verified-SHA256 tarball from nodejs.org, no package manager),
`install_user_toolchain()` (Bun, Claude Code, Codex, and Pi are all vendor curl-scripts or npm, none
apt-specific), the git/systemd-unit logic (`clone_or_update_repo`, `install_units`, etc.), and the
bubblewrap browser sandbox in `verify_browser_sandbox()` (`bwrap` is a same-named pacman package).
Arch likely doesn't ship the AppArmor unprivileged-userns restriction Ubuntu 24.04 adds by default,
so the `kernel.apparmor_restrict_unprivileged_userns=0` sysctl workaround in
`deploy/host-setup.md` is probably unnecessary — but verify per-kernel, don't assume.

**What needs a real swap**: `require_supported_host()`'s `/etc/os-release` gate needs an Arch
branch — `ID=arch`, no versioned releases to whitelist since Arch is rolling. The apt→pacman
package mapping is largely 1:1:

| apt | pacman | Note |
|---|---|---|
| `build-essential` | `base-devel` | package group |
| `fd-find` | `fd` | Arch's package is already named `fd` — install.sh's `fdfind → fd` symlink shim becomes unnecessary |
| `python3` | `python` | no `3` suffix on Arch |
| `python3-venv` | *(included in `python`)* | not split out |
| `xz-utils` | `xz` | |
| everything else (`curl`, `git`, `jq`, `ripgrep`, `sudo`, `unzip`, `gnupg`, `util-linux`, `bubblewrap`, `ca-certificates`) | same name | |

`curl`, `git`, `jq`, `ripgrep`, `unzip`, `gnupg`, `chromium`, and `github-cli` are **already
installed by a stock Omarchy install** (`install/omarchy-base.packages`), so on a real Omarchy box
this step likely only needs to add `bubblewrap`, `base-devel`, `fd`, and confirm
`python`/`xz`/`util-linux` — not the full apt-equivalent list. `install_github_cli()`'s
apt-keyring-and-repo dance collapses to `pacman -S --needed github-cli`, and since Omarchy already
ships `github-cli` by default, this step is frequently a no-op on this specific target.

**The one real, unresolved gap**: `install_app_dependencies()` runs `bun x playwright install-deps
chromium` to install the shared libraries (nss, gtk3, at-spi2-core, pango, mesa, alsa-lib, …)
Playwright's bundled Chromium build links against. `playwright install-deps` only knows how to
drive `apt` — on Arch it either no-ops or fails outright (matches the open upstream request,
`microsoft/playwright#23949`). This has to be solved by hand: either a curated, version-tracked
pacman package list standing in for what `install-deps` would have installed, or the AUR
`playwright` package as an alternative to the npm-installed CLI. **Mitigating factor, not a fix**:
Omarchy already installs the full desktop `chromium` pacman package by default, pulling in largely
the same runtime dependency set Playwright's separately-downloaded build also needs — so the
practical risk of missing `.so` files is probably lower on an actual Omarchy machine than on a bare
Arch box, but not guaranteed (different Chromium build, different linked versions). This should be
verified with an actual `ldd`/smoke-launch check in the installer, exactly as `install.sh` already
gates its Ubuntu path behind an opt-in `bun run browser:smoke` today. See
[migration.md](migration.md) for how this gap is sequenced into the cutover.

## See also

- [migration.md](migration.md) — the full Ubuntu-to-Omarchy cutover plan this doc's §5 feeds into.
- [computer-use.md](computer-use.md) — how beckett's headless compositor and `grim`/`slurp`
  capture path (§3.3) fit into Beckett's existing browser-automation and proof-screenshot story.
- [architecture.md](architecture.md) — where the dedicated account and its systemd units sit in
  the overall system.
