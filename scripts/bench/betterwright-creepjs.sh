#!/usr/bin/env bash
# creepJS capture per version and per backend.
#
# `betterwright run` drives the version's OWN persistent browser, unsandboxed, so its
# backend selection is not the sandboxed lane's: on this GPU-equipped host `auto` finds
# /dev/dri and picks the native fork, whereas inside bwrap `auto` reads GPU-less and picks
# CloakBrowser. Both are captured for 1.8.2 so the lane's *actual* default fingerprint
# surface (Cloak) and its forced-native surface are each on the record.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
out="$root/bench-results/creepjs"
snippet="$out/fp-1.8.2.js"

capture() {
  local label="$1" version="$2" backend="$3"
  "$root/scripts/bench/betterwright-pin.sh" "$version" >/dev/null
  echo "[creepjs] $label (betterwright $version, BETTERWRIGHT_BACKEND=${backend:-unset})" >&2
  ./node_modules/.bin/betterwright close >/dev/null 2>&1
  if [ -n "$backend" ]; then
    BETTERWRIGHT_BACKEND="$backend" timeout 180 ./node_modules/.bin/betterwright run "$snippet" --close \
      >"$out/capture-$label.json" 2>"$out/capture-$label.err"
  else
    env -u BETTERWRIGHT_BACKEND timeout 180 ./node_modules/.bin/betterwright run "$snippet" --close \
      >"$out/capture-$label.json" 2>"$out/capture-$label.err"
  fi
  echo "[creepjs] $label exit $? ($(wc -c <"$out/capture-$label.json") bytes)" >&2
}

capture "1.8.2-fork"  1.8.2 chromium-fork
capture "1.8.2-cloak" 1.8.2 cloak
capture "1.8.2-auto"  1.8.2 ""
capture "1.7.2"       1.7.2 ""
