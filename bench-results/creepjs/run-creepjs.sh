#!/usr/bin/env bash
# creepJS capture for one betterwright version, reusing the parked run's snippets.
# Usage: bench-results/creepjs/run-creepjs.sh <version>
# Installs <version>, then drives its own persistent browser at the creepJS page.
set -uo pipefail
cd "$(dirname "$0")/../.."

V="$1"
sed -i "s/\"betterwright\": \"[^\"]*\"/\"betterwright\": \"${V}\"/" package.json
bun install >/dev/null 2>&1
echo "installed betterwright $(node -p "require('./node_modules/betterwright/package.json').version")" >&2

bun x betterwright doctor >"bench-results/creepjs/doctor-${V}.txt" 2>&1
grep -E "In use:|BetterChromium:|CloakBrowser:" "bench-results/creepjs/doctor-${V}.txt" >&2

# fp.js: navigate, wait ~22s for the client fingerprint to settle, scrape identity +
# the rendered body text (which carries the headless heuristic and lies badges).
timeout 180 bun x betterwright run bench-results/creepjs/fp.js --close \
  >"bench-results/creepjs/fp-${V}.json" 2>"bench-results/creepjs/err-${V}.log"
echo "fp exit=$? bytes=$(wc -c <"bench-results/creepjs/fp-${V}.json")" >&2

# scrape2.js: the header block's trust/lies/headless nodes and every percentage on the page.
timeout 180 bun x betterwright run bench-results/creepjs/scrape2.js --close \
  >"bench-results/creepjs/trust-${V}.json" 2>>"bench-results/creepjs/err-${V}.log"
echo "trust exit=$? bytes=$(wc -c <"bench-results/creepjs/trust-${V}.json")" >&2
