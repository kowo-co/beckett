---
name: image
description: Use whenever you need to GENERATE or EDIT a raster image — a mockup graphic, logo, sprite, icon, illustration, banner, product shot, or any "make me a picture of…" request. Always use `beckett image`; never scaffold an image project or call codex/python/SVG yourself.
---

# image

You can make images. There is **one** way to do it: the `beckett image` command. It wraps the
Codex `image_gen` tool (authed and enabled for you) into a single deterministic call that saves
a real file to an exact path and hands you back that path.

## What's actually available on this box

Codex is the *documented* default, but check before assuming it works: if the `codex` binary
isn't on `PATH`, `beckett image` now falls back automatically to **fal** (`FAL_KEY` is what makes
that fallback possible) and says so on stderr — it doesn't hard-fail on a missing default. OpenRouter
is a third option but only works if `OPENROUTER_API_KEY`/`OPENROUTER_KEY` is set in `~/.beckett/.env`;
don't add that key yourself, just be aware `--model openrouter/...` will error cleanly if it's absent.

Per-lane flag support:

| Lane | `--size` | `--ref` | `--transparent` |
|---|---|---|---|
| Codex (default, when `codex` is on PATH) | `1024x1024` / `1536x1024` / `1024x1536` / `auto` | yes (edit mode) | yes |
| fal (`--model fal-ai/...`, or the auto-fallback) | any `WIDTHxHEIGHT`; mapped to the model's own dialect (`image_size` pixels, or `aspect_ratio` like `9:16` for models such as `fal-ai/flux-pro/v1.1-ultra`/`kontext`) — a size that can't be expressed for the chosen model is a loud error, never a silent substitution | yes — uploads the file to fal's storage and routes to a model that accepts it (`fal-ai/flux-pro/kontext` by default if the one you picked doesn't take an image input) | no |
| OpenRouter (`--model openrouter/...`) | `1024x1024` / `1536x1024` / `1024x1536` / `auto` | no | no |

## The one rule

**Never improvise image generation.** Do NOT create a project (you once made `~/projects/imagegen`
instead of just generating), do NOT call `codex` directly, do NOT reach for python/PIL/SVG/HTML/CSS
to fake a raster image. If the user wants a photo, logo, sprite, icon, illustration, banner, or
product image → `beckett image`. (If they want a *vector/UI* asset that should match existing
repo SVGs, edit those directly instead — that's the one case where image gen is the wrong tool.)

## Usage

```
beckett image "<description>" [--out <path>] [--size <s>] [--ref <file[,file]>] [--transparent] [--model <m>]
```

| Flag | Meaning |
|---|---|
| (positional) | The image description. Be concrete: subject, style, colors, composition. |
| `--out <path>` | Where to save. Default: `~/.beckett/images/<ts>-<slug>.png`. |
| `--size <s>` | `1024x1024` (default), `1536x1024` (landscape), `1024x1536` (portrait), or `auto`. |
| `--ref <file[,file]>` | Reference image(s) to **edit / build on** (comma-separated). Turns it into an edit. |
| `--transparent` | Produce a real transparent (alpha) PNG. |
| `--model <m>` | Optional Codex driver model override (rarely needed). |

Returns JSON: `{ path, bytes, size, prompt, edited, relocated }`. **`path` is the absolute file** —
that's what you hand off or deploy. (`relocated:true` just means the wrapper moved the file from
Codex's default dir to your `--out`; nothing to act on.)

## How to write the description

The quality is in the prompt. Give it: the subject, the style ("flat vector", "photoreal",
"pixel-art sprite", "3D render"), palette, background, and any text **verbatim in quotes**. One
clear paragraph beats a vague line. Example:

```
beckett image "flat-design app icon: a friendly robot mascot head, rounded squircle, mint-green
background, soft drop shadow, no text" --size 1024x1024 --transparent --out ~/.beckett/images/beckett-icon.png
```

## The usual flow

1. **Generate** → `beckett image "…" --out <path>`. Grab `path` from the JSON.
2. **Deliver it.** A generated image is an artifact like any other:
   - To show it in Discord, attach the file: `beckett discord reply --channel <id> --file <path> "here's the mockup"`
     (the reply command takes `--file`; see your tool map). Don't just describe it — send it.
   - To put it on the web, `beckett deploy` a page that references it, or host it (see [[deploy]]).
3. **Iterate** by editing: pass the result back with `--ref <path>` and a tweak
   ("same but warmer palette and a darker background").

This is exactly the muscle for the proactive move (see [[proactive]]) — "saw yall debating the
logo, threw a few options together" — and for delivering visual work ([[deliver]]).

## When it errors

- **"codex produced no image"** — the model didn't save a file. Re-run with a more concrete
  description; if it persists, say so plainly rather than faking an image.
- **"codex not found ... falling back to fal"** — not an error, just a stderr note: the default
  renderer wasn't on `PATH` so it used fal instead. The image still generated; nothing to do.
- **"reference image not found"** — the `--ref` path is wrong; check it.
- **"takes an aspect_ratio, not raw pixels"** (fal lane) — the model you picked can't express the
  exact `--size` you asked for. Pick one of the listed ratios, pass `--size auto`, or switch to a
  model with free-form `image_size` like `fal-ai/flux/dev`.
- It can take ~30–60s (it's one generation turn). That's normal; the typing indicator covers it.
