# Site v7 content pass: CaaS positioning
> run: run-20260811-site-v7-content-pass-caas-positioning · branch: beckett/run-site-v7-content-pass-caas-positioning

## Goal

ro (user 1151230208783945818, repo owner) asked, verbatim:

"but i do think we should make the information more modern for v7. pull tids and bits from v7 docs
and like some marketing without overpromising (drop federation), drop pricing, drop the v6 page, get
rid of all eyebrow header and catepillar captions. as well as that outdated blackhole ticket sim.
instead show the links for the github app install, the kowo-co github org, the discord invite can
stay. market it like CaaS (Coworker as a Service). and make it very cool looking. almost like
factory's site maybe but not an exact copy. but i like the 0x."

Content + positioning pass on `web/public`. Builds ON TOP of the c29f02d spatial-`0x` redesign —
the three.js hero sculpture stays. Ceiling: `web/` only.

## Note on the inherited criteria list

The acceptance list attached to this run is the checklist from the *previous* run (#223, the
spatial redesign) and is already satisfied by c29f02d. Two of its boxes are directly contradicted
by ro's new ask and are superseded here:

- old #12 "page.css reskinned so pricing/caas/federation/v6 share chrome" — those three pages are
  deleted this run by explicit instruction.
- old #14 "committed on the branch (no deploy)" — this brief explicitly says run
  `beckett site deploy` and confirm the live page.

The checklist below is what this run is graded on.

## Checklist

- [x] 1. `pricing.html`, `pricing-data.json`, `v6.html`, `federation.html` deleted, plus the orphaned
      `web/scripts/pricing-stats.mjs` generator; `grep -ri "pricing\|federation\|v6\.html" web/`
      returns nothing meaningful
- [x] 2. Every eyebrow kicker gone site-wide (`.idx` hex kickers, the `.tag` release pill, the `01/02/03`
      step numbers) and every caterpillar caption gone (`.hero-note`, the running `.strip` band)
- [x] 3. The black-hole ticket sim removed from `index.html` — markup, the `.term*` CSS, and the
      typewriter JS with its OPS-23 line data
- [x] 4. Zero references to the dead `0xbeckett` GitHub org; every GitHub link points at `kowo-co`
- [x] 5. GitHub App install (`/apps/beckett/installations/new`), the `kowo-co` org, the repo and the
      Discord invite are all surfaced in nav, body and footer
- [x] 6. Home page leads with and holds CaaS (Coworker as a Service) positioning end to end
- [x] 7. `caas.html` rewritten as the second page, on the same skin, no dead links
- [x] 8. Every factual claim traces to `docs/` or the code; no federation, no pricing, no tickets, no
      "signed commits" (commits land as `beckett[bot]` via a GitHub App token, not GPG)
- [x] 9. Look: dark, spare, high-contrast, big type, lots of air, restrained motion — factory's
      register, not its layout. One accent, one radius, tokens only, no raw hex in components
- [x] 10. The three.js `0x` sculpture still renders, still themes off CSS tokens, still degrades with
      no JS / no WebGL / no module
- [x] 11. Zero horizontal overflow at 375px on every remaining page; `prefers-reduced-motion: reduce`
      kills the RAF loop; AA contrast verified numerically; ≥44px touch targets; one `h1` per page
- [x] 12. Verified by looking at the RENDERED pages at 1440 / 820 / 375, not just the diff
- [x] 13. `beckett site deploy` run, and `https://0xbeckett.me` confirmed serving the new content
