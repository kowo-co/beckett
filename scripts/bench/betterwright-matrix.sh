#!/usr/bin/env bash
# Alternating 1.7.2 / 1.8.2 lane benchmark, 5 rounds over six configurations.
#
# Each round installs 1.7.2, measures it, installs 1.8.2, measures it — so drift
# in machine state (thermals, page cache, background load) hits both versions
# evenly rather than pooling on whichever ran last. Every run appends one JSON
# object to bench-results/matrix.jsonl, tagged with its config and round, and a
# failed run is recorded as a failure object rather than dropped: launches N/5 is
# one of the numbers being measured.
#
# Configurations (arg list × BetterWright version × backend selector):
#   stock  = Beckett's shipped browser_chromium_args, unmodified
#   shared = ["--disable-gpu"], the list both versions accept with no drop
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

ROUNDS="${BENCH_ROUNDS:-5}"
OUT="$root/bench-results/matrix.jsonl"
mkdir -p "$(dirname "$OUT")"

STOCK_ARGS=""                       # unset => the shipped default
SHARED_ARGS='["--disable-gpu"]'

run_one() {
  local config="$1" round="$2" args="$3" backend="$4"
  local started stdout status
  started="$(date -Is)"
  echo "[matrix] round $round · $config" >&2
  # An empty selector must be *unset*, not empty: upstream reads any set value,
  # and the bench report labels the run with what the environment actually said.
  if [ -n "$backend" ]; then
    stdout="$(BROWSER_BENCH_CHROMIUM_ARGS="$args" BETTERWRIGHT_BACKEND="$backend" \
      timeout 420 bun scripts/bench/browser-lane.ts 2>"$ERRLOG")"
  else
    stdout="$(BROWSER_BENCH_CHROMIUM_ARGS="$args" env -u BETTERWRIGHT_BACKEND \
      timeout 420 bun scripts/bench/browser-lane.ts 2>"$ERRLOG")"
  fi
  status=$?
  if [ $status -eq 0 ] && [ -n "$stdout" ]; then
    printf '%s' "$stdout" | python3 -c '
import json, sys
report = json.load(sys.stdin)
report["config"] = sys.argv[1]
report["round"] = int(sys.argv[2])
report["startedAt"] = sys.argv[3]
report["ok"] = True
print(json.dumps(report))
' "$config" "$round" "$started" >>"$OUT"
  else
    python3 -c '
import json, sys
print(json.dumps({
    "config": sys.argv[1],
    "round": int(sys.argv[2]),
    "startedAt": sys.argv[3],
    "ok": False,
    "exitCode": int(sys.argv[4]),
    "stderr": open("/tmp/bench-stderr.txt").read()[-4000:],
}))
' "$config" "$round" "$started" "$status" >>"$OUT"
    echo "[matrix] FAILED ($status): $config round $round" >&2
  fi
  sleep 2
}

for round in $(seq 1 "$ROUNDS"); do
  ./scripts/bench/betterwright-pin.sh 1.7.2 >/dev/null
  run_one "1.7.2/stock"                "$round" "$STOCK_ARGS"  ""
  run_one "1.7.2/shared"               "$round" "$SHARED_ARGS" ""

  ./scripts/bench/betterwright-pin.sh 1.8.2 >/dev/null
  run_one "1.8.2/stock/auto"           "$round" "$STOCK_ARGS"  ""
  run_one "1.8.2/stock/chromium-fork"  "$round" "$STOCK_ARGS"  "chromium-fork"
  run_one "1.8.2/shared/auto"          "$round" "$SHARED_ARGS" ""
  run_one "1.8.2/shared/chromium-fork" "$round" "$SHARED_ARGS" "chromium-fork"
done

echo "[matrix] done -> $OUT" >&2
