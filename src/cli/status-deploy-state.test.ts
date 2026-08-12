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
  const stop = serveBus(join(dir, "control.sock"), () => ({ ok: true, data: FAKE_STATUS }));
  writeFileSync(join(dir, "uptime.jsonl"), `\n${JSON.stringify({ kind: "boot", at: FAKE_STATUS.bootedAt })}\n`);
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
      bootedAt: FAKE_STATUS.bootedAt,
      uptimeSecs: 90,
      ledgerBootedAt: FAKE_STATUS.bootedAt,
      ledgerCorroborates: true,
    });
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
