---
name: ui-designer
description: Use whenever you spec, cast, or build frontend/UI work — a page, component, dashboard, marketing site, app screen, or "make it look good." Encodes the house aesthetic and a Tailwind-first, source-before-hand-roll workflow (21st.dev → shadcn/ui → build). Invoke it before writing a frontend brief and hand it to any worker implementing UI work.
---

# ui-designer

This is the house style. Load it every time UI is on the table — when you brief frontend work,
when you write the prompt, and (as a worker) before you touch a single component.
The point is that Beckett's UI has a *consistent, opinionated look* instead of being reinvented,
blandly, one build at a time. Taste is a default here, not a coin flip.

Anything visual is an Opus seat (see the frontend row in [[concierge]] — `claude-opus-5` @
`high`). This skill is what that seat implements *against*.

## The one rule: source before you hand-roll

**Do not build a button, dialog, dropdown, toast, table, or command palette from scratch.**
Someone already built it better. The default first move on any component is to pull a base:

1. **Check [21st.dev](https://21st.dev) first.** It's a community registry of shadcn/Tailwind
   React components you copy-paste. Search the pattern ("pricing table", "bento grid", "auth
   card", "animated navbar"). Grab the closest match as a starting skeleton.
2. **Fall back to shadcn/ui.** For the canonical primitives (button, dialog, input, select,
   dropdown, tabs, sheet, command, sonner toasts) use the registry: `npx shadcn@latest add
   <component>`. These are unstyled-by-default Radix primitives — accessible out of the box,
   yours to theme.
3. **Then restyle to the house tokens.** Never ship a component stock. Retheme it to *our* color
   tokens, spacing, radius, and motion (below). Stock shadcn looks like stock shadcn; that's the
   tell of a UI nobody cared about.
4. **Hand-roll only when nothing fits** — a genuinely bespoke layout, a custom viz, a one-off
   interaction. Even then, steal the structure (Radix primitives for behavior, our tokens for
   looks). Reinventing a focus-trap or a combobox from zero is how you ship a11y bugs.

Hand-rolling is the exception you justify, not the default you reach for.

## The house aesthetic — a real POV

**Confident minimalism with one point of personality.** Think Linear / Vercel / Stripe: calm
neutral canvas, generous whitespace, tight typography, sharp contrast, and exactly *one* accent
doing the talking. Restraint reads as expensive; decoration reads as cheap. When in doubt, remove.

Non-negotiables:
- **Whitespace is the design.** Crowded is the #1 amateur tell. Give things room; let sections
  breathe. Padding is not wasted space.
- **One accent, used sparingly.** A single brand color for primary actions and focus. Everything
  else is neutral. A rainbow UI has no hierarchy.
- **Depth from contrast and subtle borders, not heavy shadows.** Flat surfaces separated by a
  hairline border (`border-border`) and a half-step background shift beat drop-shadow soup.
- **Sharp, consistent geometry.** One radius token everywhere (`rounded-lg` / `rounded-xl` as the
  house default — pick one per project and hold it). Mismatched corner radii look broken.
- **Dark mode is not an afterthought.** Build with tokens so it works from day one.

If a screen looks like a Bootstrap admin template from 2016, you've failed the aesthetic.

## The stack — Tailwind-first, always

- **React + Tailwind CSS.** Utility classes in the markup; no bespoke CSS files, no CSS-in-JS
  runtime. Tailwind's scale *is* the spacing/type/color system — use it, don't fight it.
- **shadcn/ui** as the component substrate (Radix behavior + Tailwind styling, copied into the
  repo so it's ours to edit). **21st.dev** for richer/marketing patterns on top.
- **lucide-react** for icons. One icon set, consistent stroke weight. Never mix icon libraries.
- **Framer Motion** for orchestrated/gesture motion; plain `transition-*` utilities for simple
  hover/focus. Don't pull Framer for a color fade.
- **Geist** or **Inter** for sans; a real mono (Geist Mono / JetBrains Mono) for code/numbers.
- **`cn()`** (clsx + tailwind-merge) for conditional classes — the shadcn convention.

Don't introduce a second UI kit (no MUI/Chakra/AntD alongside this). One system.

## Layout & spacing — a 4px grid

- **4px base unit.** Only use Tailwind's scale steps: `1 2 3 4 6 8 12 16 24` (= 4–96px). Never
  hand-type arbitrary values like `p-[13px]`; snap to the grid.
- **8px rhythm for real spacing.** Gaps between elements: `gap-2`/`gap-4`; between sections:
  `py-12`/`py-16`/`py-24`. Keep vertical rhythm consistent down a page.
- **Contain content.** Center a `max-w-6xl` (~1152px) or `max-w-7xl` for apps, `max-w-2xl`/`3xl`
  for reading/forms. Full-bleed text is unreadable. Generous gutters (`px-4 sm:px-6 lg:px-8`).
- **Flexbox and CSS Grid only.** No absolute positioning for layout (fine for badges/overlays).
  `flex` for one axis, `grid` for two. `gap-*` over margins for spacing between siblings.
- **Mobile-first.** Base styles are the phone; layer `sm:`/`md:`/`lg:` up. Design the small
  screen first, then let it expand — never the reverse.

## Typography — hierarchy by weight, not size soup

- **One typeface family** (plus a mono for code/data). Two at most.
- **Scale:** `text-sm` (14, secondary/meta) · `text-base` (16, body — the floor for reading) ·
  `text-lg`/`xl` (lead) · `text-2xl`–`text-4xl` (headings) · `text-5xl`+ (hero only).
- **Two, maybe three sizes per screen.** Establish hierarchy with **weight** (`font-medium` /
  `font-semibold`) and **color** (`text-foreground` vs `text-muted-foreground`), not five sizes.
- **Tighten headings:** `tracking-tight` and `leading-tight`/`leading-none` on large text; roomy
  `leading-relaxed` (~1.6) on body. Big type with default tracking looks loose and cheap.
- **Measure:** cap body line length around 65–75ch (`max-w-prose`). Walls of full-width text lose
  the reader.
- **Numbers:** `tabular-nums` for anything in a table or that ticks/updates, so digits don't jitter.

## Color & theming — tokens, not hex

Use the **shadcn CSS-variable token system**. Style against semantic tokens, never raw palette:

- `bg-background` / `text-foreground` — the base canvas and ink.
- `bg-card` / `bg-muted` — raised and recessed surfaces.
- `text-muted-foreground` — secondary text (labels, captions, meta).
- `border-border` / `ring-ring` — hairlines and focus rings.
- `bg-primary text-primary-foreground` — the one accent, for primary actions.
- `destructive` for danger. Semantic states (success/warning) as named tokens, not inline greens.

Rules:
- **Neutral base + one accent.** Ground on a neutral ramp (**zinc** is the house default; slate/
  stone are fine — pick one). Reserve saturated color for the accent and semantic states.
- **~60/30/10:** ~60% background/neutral, ~30% surfaces/secondary, ~10% accent. If accent is
  everywhere, it's nowhere.
- **Define both themes via `:root` and `.dark`** token blocks. If you write a raw hex in a
  component, you've broken theming — go add a token.
- **Contrast is a constraint, not a nicety** — body text ≥ 4.5:1, large text/UI ≥ 3:1.

## Motion & interaction — purposeful and fast

- **Fast and subtle.** `150–250ms`, `ease-out` for enters, `ease-in` for exits. Anything slower
  than ~300ms feels laggy. No bouncy 600ms springs on a menu.
- **Every interactive element has states:** rest, `hover:`, `focus-visible:`, `active:`, and
  `disabled:`. A button with no hover/press feedback feels broken even when it works.
- **Animate transform and opacity**, not `width`/`top`/`height` (those thrash layout). Slide/fade/
  scale, not reflow.
- **Motion earns its place:** reveal state, guide the eye, soften a transition. Decorative
  animation that says nothing is noise — cut it.
- **`prefers-reduced-motion: reduce` → kill non-essential motion.** Framer's `useReducedMotion` or
  a `motion-reduce:` variant. This is a baseline, not optional.

## Accessibility — the floor you never go below

- **Semantic HTML.** Real `<button>` for actions, `<a>` for navigation, one `<h1>`, ordered
  headings. Never a clickable `<div>`.
- **Visible focus, always.** `focus-visible:ring-2 ring-ring`. Never `outline-none` without a
  replacement ring — you're stranding keyboard users.
- **Keyboard-complete.** Everything reachable and operable by Tab/Enter/Esc/arrows. (Radix/shadcn
  gives you this free — another reason to source, not hand-roll.)
- **Labels & alt.** Every input has a `<label>` (or `aria-label`); every meaningful image has
  `alt`; icon-only buttons get an accessible name.
- **Hit targets ≥ 44×44px** on touch. Don't ship 20px tap zones.
- **Contrast AA** (see color). Don't encode meaning by color alone — pair with icon/text.

## What good looks like — the rubric (self-check before you call it done)

Read your own UI against this. If you can't check a box, fix it, don't ship it.

- [ ] **Sourced, not hand-rolled** — primitives came from shadcn/21st.dev and were *rethemed*; no
      reinvented dialogs/comboboxes; no stock-shadcn tell.
- [ ] **Breathes** — generous whitespace, contained width, consistent 4/8px rhythm; nothing crowded.
- [ ] **Clear hierarchy** — eye lands on the primary action first; ≤3 type sizes; weight+color do
      the work; one accent.
- [ ] **Token-pure** — no raw hex; styled on semantic tokens; **dark mode works** without patching.
- [ ] **Alive** — hover/focus/active/disabled on every control; transitions fast and purposeful;
      reduced-motion respected.
- [ ] **Accessible** — semantic tags, visible focus, keyboard-complete, labels/alt, AA contrast,
      44px targets.
- [ ] **Responsive** — designed mobile-first; no horizontal scroll or overflow at 375px; scales up
      cleanly.
- [ ] **Consistent** — one radius, one icon set, one type family, aligned spacing. No stray
      one-offs.
- [ ] **Intentional** — looks like someone with taste made a decision, not a framework default.

## How to apply it — implementing UI work

1. **Open with this skill.** Re-read the aesthetic and rubric before you write code so the
   defaults are loaded.
2. **Decompose into components**, then for each: **21st.dev → shadcn/ui → hand-roll** (the one
   rule). Add primitives via `npx shadcn@latest add …`.
3. **Set the tokens first.** Establish the color tokens (`:root` + `.dark`), radius, and font in
   the theme layer *before* building screens — so everything inherits the house look, not the
   default.
4. **Build mobile-first**, layout with flex/grid on the 4px grid, type on the scale, color on
   tokens.
5. **Wire states and motion** — hover/focus/active/disabled and fast, purposeful transitions;
   honor reduced-motion.
6. **Run the rubric on yourself.** No cold reviewer can catch taste — it reads a diff, it never
   sees the page — so *you* are the gate that matters. Walk every box; fix misses.
7. **Show it.** Deploy the running result to a subdomain ([[deploy]]) or attach a screenshot so a
   human can judge by eye — the only real test of visual work. Need a raster asset (logo, hero,
   illustration)? Generate it ([[image]]), don't fake it with CSS.

## Plugging into a frontend prompt

When you (concierge) brief frontend work, name this skill in the prompt so the worker loads the
same taste you did. A frontend prompt should read like:

> **Invoke the `ui-designer` skill.** Build the pricing page. **Check 21st.dev for a pricing-table
> base and shadcn/ui for the primitives (button, card, toggle) before hand-rolling anything;
> retheme to our tokens.** House aesthetic: confident minimalism, one accent, generous whitespace,
> dark-mode-from-tokens. Tailwind + shadcn only. **Self-check against the ui-designer rubric before
> done** (sourced/breathes/hierarchy/token-pure/alive/accessible/responsive). Cast:
> `{"implement":{"harness":"claude","model":"claude-opus-5","effort":"medium"}}`.

That one paragraph turns "make a pricing page" into a brief with a design POV baked in — which is
the whole point of having a house style. See the frontend seat and cast table in [[concierge]].
