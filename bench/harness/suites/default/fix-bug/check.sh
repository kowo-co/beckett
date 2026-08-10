#!/usr/bin/env bash
set -euo pipefail
bun test
[ -z "$(git diff HEAD --name-only -- stats.test.ts)" ]
