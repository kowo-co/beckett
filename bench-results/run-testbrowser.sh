#!/usr/bin/env bash
# `bun run test:browser` reliability: 5 runs per version, alternating.
# Usage: bench-results/run-testbrowser.sh <version-a> <version-b>
set -uo pipefail
cd "$(dirname "$0")/.."

for i in 1 2 3 4 5; do
  for V in "$1" "$2"; do
    sed -i "s/\"betterwright\": \"[^\"]*\"/\"betterwright\": \"${V}\"/" package.json
    bun install >/dev/null 2>&1
    # .txt, not .log: these runs are the reliability evidence the comparison doc cites,
    # and the repo's .gitignore drops *.log, which would leave that citation dangling.
    LOG="bench-results/testbrowser-${V}.txt"
    [ "$i" = 1 ] && : >"$LOG"
    started=$(date +%s)
    echo "===== run $i  betterwright ${V} =====" >>"$LOG"
    # The test:browser script's own command, invoked directly: `timeout` only signals its
    # immediate child, so going through `bun run` leaves a hung `bun test` grandchild alive.
    timeout -k 10 600 bun test ./src/browser/runtime.test.ts ./src/browser/isolated.test.ts \
      ./src/browser/agent.test.ts >>"$LOG" 2>&1
    status=$?
    echo "----- run $i exit=${status} elapsed=$(( $(date +%s) - started ))s -----" >>"$LOG"
    echo "run $i  ${V}  exit=${status}" >&2
  done
done
echo "testbrowser done" >&2
