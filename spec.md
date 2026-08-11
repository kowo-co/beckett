# 0xbeckett.me redesign: spatial 3D landing
> run: run-20260811-0xbeckett-me-redesign-spatial-3d-landing · branch: beckett/run-0xbeckett-me-redesign-spatial-3d-landing · created: 2026-08-11T05:34:02.440Z

## Goal
ro (user 1151230208783945818, the owner) asked, verbatim: "give some love to your site 0xbeckett.me to be more forward future thinking with like a really cool spatial UI and 3D elements, very clean and minimal and like very creative leaning into the 0x while straying away from the neons and the cyberpunk aesthetics"

Redesign Beckett's own public landing site. This is Beckett's own source repo — the site lives in `web/public/` (`index.html` is the landing page, 488 lines; `page.css`, `logo.svg`, `beckett.svg`, plus `pricing.html`, `caas.html`, `federation.html`, `v6.html` as secondary pages). Read `.claude/skills/site/SKILL.md` first — it explains the layout and the deploy path.

SCOPE: `index.html` is the job. Carry the new visual language onto the secondary pages only far enough that they don't look like a different website (shared header/footer, type, color tokens) — do NOT redesign their content or layout. Do not touch `web/src/index.js`, `web/wrangler.jsonc`, or anything outside `web/`.

WHAT RO ACTUALLY ASKED FOR, unpacked:
- 'forward future thinking' + 'spatial UI' + '3D elements' — real depth and dimensionality. three.js is ALREADY vendored at `web/public/vendor/three.module.min.js` and `three.core.min.js`, and there's an existing `world.js` doing a cube world. Use three.js. Think: a genuinely spatial hero — geometry that reads as an object in space, parallax/depth on scroll, layered planes, considered lighting and shadow. Not a flat page with a canvas glued on top.
- 'very clean and minimal' — this is the governing constraint and it beats the 3D when they conflict. Enormous whitespace, very few elements, tight typography, restrained palette. If a section doesn't earn its place, cut it. Restraint reads as expensive.
- 'lean into the 0x' — the `0x` in 0xbeckett is the hook. Hex prefix, addresses, machine notation. Do something creative and confident with it (wordmark, the 3D form itself, a motif in the layout or the mono type). Make it the one point of personality. Don't be cute or literal about it — no "web3" or crypto framing, that is NOT what 0x means here.
- 'straying away from the neons and the cyberpunk aesthetics' — HARD constraint. No neon glow, no electric cyan-on-black, no scanlines, no glitch effects, no grid-horizon, no Blade Runner. If it looks like a synthwave album cover you have failed the brief.

CURRENT STATE for reference: today the site is a light pastel cyan/lavender page with Pixelify Sans as the display face and a cube-world canvas. It is fine but dated-feeling and ro wants it moved forward. You are free to replace the palette and display typeface entirely — but pick a real point of view and hold it across the whole page, not a mix of old and new. Keep the actual copy's meaning (Beckett is Coworker as a Service, open source, runs a fleet of agents from Discord, ships reviewed diffs; fork it, name yours, host it anywhere) — you may rewrite the wording tighter, but don't invent claims or product features that aren't already on the page, and keep the existing links working.

STACK CONSTRAINT: keep it a static, no-build, hand-written page — plain HTML/CSS/JS served straight from `web/public/`, three.js from the vendored local files. Do NOT introduce React, Tailwind, a bundler, npm deps, or a build step for this site; it is deployed as raw static assets to a Cloudflare Worker. So the 'source before you hand-roll' rule in the ui-designer skill does NOT apply here — there is no component registry to pull from. Everything ELSE in `.claude/skills/ui-designer/SKILL.md` DOES apply and you must read it before writing any markup: whitespace, one accent, hierarchy from weight and color not size soup, CSS-variable tokens rather than raw hex scattered through the file, one radius, one icon treatment, 4/8px spacing rhythm, fast purposeful motion (150-250ms, transform/opacity only), AA contrast, visible focus rings, semantic HTML, 44px touch targets. Self-check against that skill's rubric before you call it done.

DONE MEANS, concretely:
- `web/public/index.html` renders a redesigned landing page with a genuine three.js spatial element in the hero, clean and minimal, built on CSS custom-property tokens with no raw hex scattered through components.
- No horizontal scroll or overflow at 375px width; the 3D element degrades gracefully on mobile (lower geometry/DPR or a static fallback — your call, but it must not tank a phone).
- `prefers-reduced-motion: reduce` kills the non-essential motion including the 3D animation loop.
- The page works with JS disabled or if three.js fails to load: content is still readable, layout doesn't collapse.
- Lighthouse-ish sanity: no render-blocking disasters, the three.js module loads deferred, first paint doesn't wait on the canvas.
- Secondary pages still load and share the new header/footer and tokens.
- Screenshot the result and attach it. Visual work is judged by eye — a reviewer reading a diff cannot see a layout defect, so YOU are the gate. Open the page, look at it, at desktop and at 375px, and fix what looks wrong before finishing.
- Do NOT run `beckett site deploy` — landing and deploying is handled after review. Just leave the branch ready.

CEILING: this is a visual redesign of one page. Don't refactor the worker, don't add analytics, don't add new sections of product copy, don't build a CMS, don't add an llms.txt (separate ask, not this run).

## Checklist
- [x] 1. Design POV locked: bone-paper canvas, graphite ink, ONE ultramarine accent, no neon/cyberpunk anywhere
- [x] 2. Token layer written first (`:root` custom properties: color, type scale, one radius, spacing, motion) — no raw hex in components
- [x] 3. `hero3d.js`: real three.js spatial hero — an extruded `0x` sculpture (0 = ring shape w/ hole, x = crossed polygon), studio lighting, real cast shadow on a shadow-catcher plane
- [x] 4. Spatial depth beyond the canvas: pointer parallax on the object, scroll-driven camera/parallax, layered planes in the page
- [x] 5. index.html rebuilt: minimal section set, huge whitespace, ≤3 type sizes, hierarchy from weight+color, hex `0x01/0x02/0x03` section indices as the 0x motif
- [x] 6. Copy meaning preserved (CaaS, open source, fleet from Discord, reviewed diffs, fork/name/host); all existing links still work
- [x] 7. Mobile: no horizontal scroll/overflow at 375px; 3D degrades (lower DPR, fewer segments, smaller/off shadow map)
- [x] 8. `prefers-reduced-motion: reduce` kills all non-essential motion AND the RAF loop (single static frame)
- [x] 9. No-JS / three.js-fails path: content readable, layout intact, canvas removed cleanly
- [x] 10. Perf sanity: three.js loads as a deferred module, first paint independent of canvas, RAF paused when hero off-screen
- [x] 11. a11y: semantic HTML, one h1, visible focus rings, AA contrast (verified numerically), ≥44px touch targets
- [x] 12. page.css reskinned to the same tokens so pricing/caas/federation/v6 share header/footer/type — content/layout untouched
- [x] 13. Screenshotted at 1440 / 820 / 375 and in dark mode, looked at with my own eyes, defects fixed
- [x] 14. ui-designer rubric self-check walked box by box; committed on the branch (no deploy)

## Notes
- Palette contrast checked by hand: ink #17171A on paper #F3F2EF = 15.9:1; muted #5A5A61 = 6.1:1; accent #2333C4 = 8.0:1.
- Dropping the old world: cursor voxel, pixel terra ground, night/dusk mode, tether, tip, haze lenses, wordplay swap. `world.js` (65KB cube world) deleted — nothing outside web/public referenced it.
- Type: one family (Inter) + JetBrains Mono for the hex/machine notation. Space Grotesk deliberately rejected — it reads crypto-adjacent next to a `0x`, which is exactly the wrong association here.

## Verified

- **Overflow**: `documentElement.scrollWidth === innerWidth` on index/caas/federation/v6/pricing at 375, 768 and 1440. No element escapes the viewport (the only off-screen node is the skip link, by design).
- **Reduced motion**: with `prefers-reduced-motion: reduce` the page issues **zero** `requestAnimationFrame` calls — the sculpture is composed once and frozen; the console re-enactment prints in full instead of typing; all reveals start visible.
- **No JS**: 2.2k characters of copy render, `h1` visible, layout intact — reveals are gated behind a `.js` class set by an inline script, so nothing can be left hidden by an observer that never runs.
- **three.js blocked** (route aborted): the flat mono `0x` fallback stays, headline and sections render, reveals still work.
- **Contrast** (computed from live styles, both themes): lowest pair 5.59:1 (strip meta on the sunk band); body copy 6.11 light / 7.23 dark; accent-on-paper 8.01; primary button 8.6. All ≥ AA.
- **Touch targets**: every control ≥44px; the v6 badge gets `min-height:44px` under `pointer: coarse` only, so the desktop badge stays small.
- `bun x tsc --noEmit` → exit 0 (no TypeScript changed; static assets only).

Screenshots were taken with a real Chromium + WebGL (the BetterWright obscura browser stubs the WebGL context — `getContext('webgl2')` returns a plain object with no `texImage3D`, so three.js can't initialise there and the page falls back to the flat mark; that is a harness limitation, not a page defect).

## Mobile 3D budget
`lean` mode (viewport < 760px or ≤4 cores): DPR capped at 1.5, antialias off, 512² shadow map with cheap PCF, 1 bevel segment, 4 curve segments, 40-point ring instead of 88. The loop is also paused whenever the canvas is off-screen or the tab is hidden.
