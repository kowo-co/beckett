#!/usr/bin/env bash
# `bun run test:browser` five times against one pinned betterwright, recording the
# real pass/fail counts rather than a green/red impression. Usage:
#   scripts/bench/betterwright-test-browser.sh <version> [runs]
set -uo pipefail
version="${1:?usage: betterwright-test-browser.sh <version> [runs]}"
runs="${2:-5}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

"$root/scripts/bench/betterwright-pin.sh" "$version" >/dev/null
out="$root/bench-results/test-browser-$version.txt"
: >"$out"
for run in $(seq 1 "$runs"); do
  echo "=== run $run ===" >>"$out"
  timeout 900 bun run test:browser >>"$out" 2>&1
  echo "--- exit $? ---" >>"$out"
done
grep -E "^ *[0-9]+ (pass|fail)|^--- exit|^Ran " "$out"
