#!/usr/bin/env bash
# Swap the pinned betterwright version in package.json and reinstall, so the
# lane benchmark can alternate between versions inside one run. Bench tooling
# only: it edits the pin in place, so whatever version you leave it on is the
# pin you commit. Always re-check with `grep betterwright package.json` after.
set -euo pipefail
version="${1:?usage: betterwright-pin.sh <version>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
python3 - "$version" <<'PY'
import re, sys
version = sys.argv[1]
text = open("package.json").read()
patched = re.sub(r'("betterwright":\s*")[^"]+(")', lambda m: m.group(1) + version + m.group(2), text)
if f'"betterwright": "{version}"' not in patched:
    raise SystemExit("failed to rewrite the betterwright pin")
open("package.json", "w").write(patched)
PY
bun install --silent >/dev/null 2>&1
node -e 'process.stdout.write(require("./node_modules/betterwright/package.json").version + "\n")'
