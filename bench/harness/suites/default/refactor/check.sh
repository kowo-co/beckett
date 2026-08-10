#!/usr/bin/env bash
set -euo pipefail
bun test
! git grep -q "procData" -- "*.ts"
git grep -q "processOrders" -- "*.ts"
