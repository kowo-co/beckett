#!/usr/bin/env python3
"""Summarize bench-results/matrix.jsonl into backend-labelled medians.

Every row is labelled with the browser binaries the sampler actually observed in the
host's process tree, because a 1.8.2 number produced by CloakBrowser is not comparable
to one produced by the native BetterChromium fork. Rows that failed to launch are not
dropped: launches N/5 is one of the measured numbers.
"""
import json
import statistics
import sys
from collections import OrderedDict

PATH = sys.argv[1] if len(sys.argv) > 1 else "bench-results/matrix.jsonl"

BACKEND_LABELS = (
    ("/.betterwright/chromium/", "BetterChromium (native fork)"),
    ("/.cloakbrowser/", "CloakBrowser"),
    ("/.betterwright/obscura/", "Obscura"),
)


def backend_label(binaries):
    seen = []
    for path in binaries:
        for needle, label in BACKEND_LABELS:
            if needle in path and label not in seen:
                seen.append(label)
    return " + ".join(seen) if seen else "unknown"


def span(values, unit="", digits=1):
    if not values:
        return "—"
    median = statistics.median(values)
    return (
        f"{median:.{digits}f}{unit} [{min(values):.{digits}f}, {max(values):.{digits}f}]"
    )


rows = [json.loads(line) for line in open(PATH) if line.strip()]
by_config = OrderedDict()
for row in rows:
    by_config.setdefault(row["config"], []).append(row)

for config, runs in by_config.items():
    ok = [r for r in runs if r.get("ok")]
    backends = sorted({backend_label(r.get("browserBinaries", [])) for r in ok})
    warnings = sorted({w for r in ok for w in r.get("warnings", [])})
    identities = sorted({(r.get("identity") or {}).get("ua", "?") for r in ok})
    print(f"## {config}")
    print(f"   launches       : {len(ok)}/{len(runs)}")
    print(f"   backend seen   : {', '.join(backends) if backends else '—'}")
    print(f"   cold acquire   : {span([r['coldAcquireMs'] for r in ok], ' ms')}")
    print(f"   warm p50       : {span([r['warmEvalMs']['p50'] for r in ok], ' ms')}")
    print(f"   warm p95       : {span([r['warmEvalMs']['p95'] for r in ok], ' ms')}")
    print(f"   warm min       : {span([r['warmEvalMs']['min'] for r in ok], ' ms')}")
    print(f"   peak RSS       : {span([r['peakRssMb'] for r in ok], ' MiB')}")
    print(f"   CPU-seconds    : {span([r['cpuSeconds'] for r in ok], ' s', 2)}")
    for ua in identities:
        print(f"   UA             : {ua}")
    for warning in warnings:
        print(f"   warning        : {warning}")
    for run in runs:
        if not run.get("ok"):
            tail = (run.get("stderr") or "").strip().splitlines()
            print(f"   FAILED round {run['round']}: {tail[-1] if tail else run.get('exitCode')}")
    print()
