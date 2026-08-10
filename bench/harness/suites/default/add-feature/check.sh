#!/usr/bin/env bash
set -euo pipefail
bun test
[ -z "$(git diff HEAD --name-only -- slug.test.ts)" ]
