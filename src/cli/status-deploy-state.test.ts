/**
 * `beckett status deploy-state` — the daemon-truth surface (issue #248).
 *
 * The incident this closes: a detached `deploy/deploy-prod.sh` losing its shell was read as
 * "the deploy is dead" TWICE, even after the daemon had already rebooted onto the new version.
 * These tests pin the one behavior that fixes that: the answer comes from the daemon's own
 * control-bus reply (mocked here with `serveBus`, exactly like `control-bus.test.ts`), corroborated
 * — never overridden — by the `uptime.jsonl` boot ledger, and "not reachable" renders as a
 * distinct, clearly-labeled outcome that explicitly disclaims being evidence of a failed deploy.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBus } from "../shell/control-bus.ts";
import { recordBoot, uptimeLedgerPath } from "../uptime.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FAKE_STATUS = {
  version: "7.0.5",
  commit: "abc1234",
  pid: 4242,
  bootedAt: "2026-08-12T20:51:45.000Z",
  uptimeSecs: 90,
};

/**
 * Writes the ledger's boot line through the REAL `recordBoot` code path (the one `src/shell/
 * main.ts` calls at boot) and returns the exact `at` it produced, instead of hand-writing a JSONL
 * line string-equal to a separately-chosen mocked bus payload. A prior version of this file did
 * the latter, which let `ledgerCorroborates` pass in CI while the real daemon (two independent
 * `Date.now()` reads) could never agree — see issue #248's review finding 1. Callers feed this
 * `at` back into their mocked bus `bootedAt`, mirroring how main.ts's status provider now threads
 * the SAME captured instant through rather than sampling a second clock.
 */
function realBootLedgerLine(dir: string): string {
  const events = recordBoot(uptimeLedgerPath(dir));
  return events[events.length - 1]!.at;
}

async function statusCli(args: string[], dir: string): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "beckett.ts"), "status", "deploy-state", ...args],
    {
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env, BECKETT_DIR: dir, BECKETT_HOME: dir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, stdout, stderr };
}

test("deploy-state answers from the daemon's own reply, corroborated by a matching ledger boot line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-deploy-state-"));
  dirs.push(dir);
  // The ledger's boot line comes from the real `recordBoot` path; the mocked bus reply then
  // reuses that SAME instant, exactly as main.ts's status provider now does at daemon boot — not
  // a hand-written literal chosen to match. This is what actually pins finding 1's fix: if the
  // daemon ever went back to sampling a second `Date.now()` for its own `bootedAt`, the two
  // values here would have to be independently kept in sync to still pass, same as production.
  const bootedAt = realBootLedgerLine(dir);
  const status = { ...FAKE_STATUS, bootedAt };
  const stop = serveBus(join(dir, "control.sock"), () => ({ ok: true, data: status }));
  try {
    const { exit, stdout } = await statusCli([], dir);
    expect(exit).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toMatchObject({
      ok: true,
      reachable: true,
      version: "7.0.5",
      commit: "abc1234",
      pid: 4242,
      bootedAt,
      uptimeSecs: 90,
      ledgerBootedAt: bootedAt,
      ledgerCorroborates: true,
    });
  } finally {
    stop();
  }
});

test("deploy-state: a daemon that reverts to a second, independent boot-time clock read no longer corroborates", async () => {
  // Pins the regression directly: if the daemon's reply carries a bootedAt even 1ms off from
  // what recordBoot actually wrote — the exact shape of the pre-fix two-clock bug — the CLI must
  // report the mismatch, never paper over it with a tolerance window.
  const dir = mkdtempSync(join(tmpdir(), "beckett-deploy-state-"));
  dirs.push(dir);
  const ledgerBootedAt = realBootLedgerLine(dir);
  const driftedBootedAt = new Date(Date.parse(ledgerBootedAt) + 1).toISOString();
  const status = { ...FAKE_STATUS, bootedAt: driftedBootedAt };
  const stop = serveBus(join(dir, "control.sock"), () => ({ ok: true, data: status }));
  try {
    const { exit, stdout } = await statusCli([], dir);
    expect(exit).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.ledgerCorroborates).toBe(false);
    expect(data.bootedAt).toBe(driftedBootedAt);
    expect(data.ledgerBootedAt).toBe(ledgerBootedAt);
  } finally {
    stop();
  }
});

test("deploy-state --pretty: UP-since renders in plain words, and a ledger mismatch WARNS rather than overriding the daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-deploy-state-"));
  dirs.push(dir);
  const stop = serveBus(join(dir, "control.sock"), () => ({ ok: true, data: FAKE_STATUS }));
  // A stale/disagreeing ledger line must not win over the live daemon's own reply.
  writeFileSync(join(dir, "uptime.jsonl"), `\n${JSON.stringify({ kind: "boot", at: "2026-08-11T00:00:00.000Z" })}\n`);
  try {
    const { exit, stdout } = await statusCli(["--pretty"], dir);
    expect(exit).toBe(0);
    expect(stdout).toContain("beckett v7.0.5 @ abc1234");
    expect(stdout).toContain(`UP since ${FAKE_STATUS.bootedAt}`);
    expect(stdout).toContain("WARNING");
    expect(stdout).toContain("does not match");
  } finally {
    stop();
  }
});

test("deploy-state with a live daemon but no ledger history yet still answers cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-deploy-state-"));
  dirs.push(dir);
  const stop = serveBus(join(dir, "control.sock"), () => ({ ok: true, data: FAKE_STATUS }));
  // Deliberately no uptime.jsonl written — a fresh install / relocated state dir.
  try {
    const { exit, stdout } = await statusCli([], dir);
    expect(exit).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.reachable).toBe(true);
    expect(data.ledgerBootedAt).toBeNull();
    expect(data.ledgerCorroborates).toBe(false);
  } finally {
    stop();
  }
});

test("deploy-state with no daemon on the socket answers 'not reachable', never 'deploy failed'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-deploy-state-"));
  dirs.push(dir);
  // No serveBus started — the socket simply doesn't exist.
  const { exit, stdout, stderr } = await statusCli([], dir);
  expect(exit).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("daemon not reachable");
  expect(stderr).toContain("NOT evidence a deploy failed");
  expect(stderr).toContain("deploy script detaches on purpose");
});
