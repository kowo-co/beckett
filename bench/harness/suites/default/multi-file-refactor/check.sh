#!/usr/bin/env bash
set -euo pipefail
bun test
! git grep -q "checkAge" -- "*.ts"
for f in lib/user.ts lib/order.ts index.ts; do
  git grep -q "checkEligibility" -- "$f"
done
