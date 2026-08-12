#!/usr/bin/env bash
# Alternating live-lane bench: 5 runs per version, same box, same session.
# Usage: bench-results/run-bench.sh <tag-a> <tag-b> <chromium-args>
# <chromium-args> is passed through as BROWSER_BENCH_CHROMIUM_ARGS (comma separated).
set -uo pipefail
cd "$(dirname "$0")/.."

A="$1"
B="$2"
ARGS="${3-}"
OUT_A="bench-results/bench-${A}.jsonl"
OUT_B="bench-results/bench-${B}.jsonl"
: >"$OUT_A"
: >"$OUT_B"

install_version() {
  local version="$1"
  sed -i "s/\"betterwright\": \"[^\"]*\"/\"betterwright\": \"${version}\"/" package.json
  bun install >/dev/null 2>&1
  node -p "require('./node_modules/betterwright/package.json').version"
}

for i in 1 2 3 4 5; do
  for V in "$A" "$B"; do
    if [ "$V" = "$A" ]; then OUT="$OUT_A"; else OUT="$OUT_B"; fi
    got="$(install_version "$V")"
    echo "run $i  betterwright $got  args=[${ARGS}]" >&2
    if [ -n "$ARGS" ]; then
      report="$(BROWSER_BENCH_CHROMIUM_ARGS="$ARGS" timeout 300 bun run browser:bench 2>/tmp/bench-err.txt)"
    else
      report="$(timeout 300 bun run browser:bench 2>/tmp/bench-err.txt)"
    fi
    if [ -n "$report" ]; then
      echo "$report" | tr -d '\n' | sed 's/  */ /g' >>"$OUT"
      echo >>"$OUT"
    else
      printf '{"run":%d,"version":"%s","failed":true,"stderr":%s}\n' \
        "$i" "$got" "$(tail -c 900 /tmp/bench-err.txt | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')" >>"$OUT"
      echo "  FAILED" >&2
    fi
    sleep 2
  done
done
echo "done" >&2
