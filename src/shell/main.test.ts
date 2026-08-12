/**
 * Regression pins for the issue #248 review's two blocking findings on `src/shell/main.ts`'s
 * daemon status provider. Booting the real daemon (Discord gateway, concierge session, etc.) is
 * impractical inside the fast test lane, so these tests work at two levels:
 *
 *   1. A structural check on the boot() source itself — the exact shape the review prescribed
 *      (thread `recordBoot`'s own timestamp through; capture the commit once at boot) is what's
 *      actually there, not a superficial rename. This is the same style already used by
 *      `concierge/doctrine.test.ts` to pin prompt-corpus invariants.
 *   2. A live exercise of `recordBoot` (the ../uptime.ts module main.ts calls) proving the value
 *      it hands back is a single, self-consistent instant fit to be reused verbatim as both the
 *      ledger's boot line and the status provider's `bootedAt` — never two independent
 *      `Date.now()` samples that merely tend to agree.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUptime, recordBoot, uptimeLedgerPath } from "../uptime.ts";

const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

function statusProviderBody(): string {
  const start = source.indexOf("concierge.setStatusProvider(async () => ({");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }));", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

test("finding 1: the status provider's bootedAt is recordBoot's own event, not a second Date.now() sample", () => {
  // The boot() function must capture ONE instant from recordBoot's return value...
  expect(source).toMatch(/const bootEvents = recordBoot\(lifecycleLedgerPath\);/);
  expect(source).toMatch(/const bootedAtIso = bootEvents\[bootEvents\.length - 1\]!\.at;/);
  // ...and the provider must serve exactly that captured value, verbatim — no `new Date(...)`
  // construction of its own, which is what a reintroduced second clock read would look like.
  const body = statusProviderBody();
  expect(body).toContain("bootedAt: bootedAtIso");
  expect(body).not.toContain("new Date(");
  expect(body).not.toMatch(/const bootedAt = Date\.now\(\)/);
});

test("finding 2: the status provider's commit is captured once at boot, not re-read from disk per call", () => {
  // Exactly one git read for the running commit in the whole file — at boot, before the provider
  // closure is even constructed.
  expect(source.match(/currentGitCommit\(/g)?.length).toBe(1);
  expect(source).toMatch(/const commitAtBoot = \(await currentGitCommit\(/);
  const body = statusProviderBody();
  expect(body).toContain("commit: commitAtBoot");
  expect(body).not.toContain("currentGitCommit(");
});

test("recordBoot's returned event is a single source of truth fit for both the ledger and a status reply", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-main-boot-"));
  try {
    const ledgerPath = uptimeLedgerPath(dir);

    // This mirrors exactly what boot() now does: capture the boot event's `at` once...
    const bootEvents = recordBoot(ledgerPath);
    const bootedAtIso = bootEvents[bootEvents.length - 1]!.at;

    // ...and it is — by construction, not by a hand-written matching literal — the same value a
    // fresh read of the durable ledger reports back. A daemon that threads `bootedAtIso` into its
    // status reply and a CLI that reads the ledger via `readUptime` therefore corroborate exactly,
    // with no clock-drift window between them.
    const ledger = readUptime(ledgerPath);
    expect(ledger.bootedAt).toBe(bootedAtIso);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
