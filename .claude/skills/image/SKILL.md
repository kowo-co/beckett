---
name: image
description: Use whenever you need to GENERATE or EDIT a raster image — a mockup graphic, logo, sprite, icon, illustration, banner, product shot, or any "make me a picture of…" request. Always use `beckett image`; never scaffold an image project or call codex/python/SVG yourself.
---

# image

You can make images. There is **one** way to do it: the `beckett image` command. It wraps the
Codex `image_gen` tool (authed and enabled for you) into a single deterministic call that saves
a real file to an exact path and hands you back that path.

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
Codex's default dir to your `--out`; nothing to act on.) `path`'s extension always matches the
file's real bytes: if a provider hands back a different format than `--out` named (e.g. a `.png`
request that comes back JPEG), the wrapper renames the file to the correct extension and returns
*that* path — always use the returned `path`, not the `--out` you passed in.

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
- **"reference image not found"** — the `--ref` path is wrong; check it.
- It can take ~30–60s (it's one Codex turn). That's normal; the typing indicator covers it.
