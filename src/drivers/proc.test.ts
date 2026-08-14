/**
 * Tests for the shared driver process helpers (`src/drivers/proc.ts`): the generous, configurable
 * backstop wall-clock cap and the process-group launch/kill wrapping (OPS-50).
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../types.ts";
import {
  DEFAULT_HARD_CAP_S,
  HARD_CAP_FLOOR_S,
  hardCapSeconds,
  wrapProcessGroup,
  killGroup,
  killProcessTree,
} from "./proc.ts";

const cfgWith = (worker_hard_cap_s?: number): Config =>
  ({ supervise: worker_hard_cap_s === undefined ? {} : { worker_hard_cap_s } }) as unknown as Config;

describe("hardCapSeconds", () => {
  test("returns the configured value when generous (>= 30min)", () => {
    expect(hardCapSeconds(cfgWith(3600))).toBe(3600);
    expect(hardCapSeconds(cfgWith(1800))).toBe(1800);
    expect(hardCapSeconds(cfgWith(5400))).toBe(5400);
    expect(hardCapSeconds(cfgWith(28800))).toBe(28800);
  });

  // Raised 3600 → 14400 on 2026-08-14: the 1h default was killing healthy multi-file runs mid-edit
  // (~4000 lines across 31 files, still going at 3601s), which makes it a work limit, not a
  // backstop. `worker_stall_s` is what catches a worker that has actually gone quiet.
  test("defaults to 14400s (4h) when unset", () => {
    expect(DEFAULT_HARD_CAP_S).toBe(14400);
    expect(hardCapSeconds(cfgWith(undefined))).toBe(14400);
    expect(hardCapSeconds({} as unknown as Config)).toBe(14400);
  });

  test("floors a too-tight value so it can never be the old 600s guillotine", () => {
    expect(HARD_CAP_FLOOR_S).toBe(1800);
    expect(hardCapSeconds(cfgWith(600))).toBe(DEFAULT_HARD_CAP_S);
    expect(hardCapSeconds(cfgWith(60))).toBe(DEFAULT_HARD_CAP_S);
    expect(hardCapSeconds(cfgWith(HARD_CAP_FLOOR_S - 1))).toBe(DEFAULT_HARD_CAP_S);
    // The floor itself is honoured, not bumped — it is a floor, not a minimum-plus-one.
    expect(hardCapSeconds(cfgWith(HARD_CAP_FLOOR_S))).toBe(HARD_CAP_FLOOR_S);
  });

  // The override is the whole point of a configurable backstop — an install that genuinely needs a
  // longer (or a deliberately tighter, floor-respecting) cap must still get exactly what it asked for.
  test("an explicit override still wins over the raised default, in both directions", () => {
    expect(hardCapSeconds(cfgWith(1800))).toBe(1800);
    expect(hardCapSeconds(cfgWith(43200))).toBe(43200);
  });
});

describe("wrapProcessGroup", () => {
  test.if(Bun.which("setsid") !== null)("wraps the command so the child leads its own process group", () => {
    const { cmd, groupKill } = wrapProcessGroup("claude", ["-p", "--verbose"]);
    // setsid is present on the target (Linux); the harness runs under it as a group leader.
    expect(groupKill).toBe(true);
    expect(cmd.at(-3)).toBe("claude");
    expect(cmd.slice(-2)).toEqual(["-p", "--verbose"]);
    expect(cmd[0]).toContain("setsid");
  });

  test.if(Bun.which("setsid") === null)("falls back to single-pid kill when setsid is unavailable", () => {
    const { cmd, groupKill } = wrapProcessGroup("claude", ["-p", "--verbose"]);
    expect(groupKill).toBe(false);
    expect(cmd).toEqual(["claude", "-p", "--verbose"]);
  });
});

describe("killGroup", () => {
  test("is a no-op for a non-group-leader child (never signals a shared group)", () => {
    // groupKill=false must NOT call process.kill(-pid) — that would hit the daemon's own group.
    expect(() => killGroup(999999, false)).not.toThrow();
  });

  test("swallows ESRCH for an already-gone group", () => {
    // A pid that owns no live group → process.kill throws ESRCH, which killGroup absorbs.
    expect(() => killGroup(2147480000, true)).not.toThrow();
  });

  test("ignores invalid pids (never signals pid 0/1 or negatives)", () => {
    expect(() => killGroup(0, true)).not.toThrow();
    expect(() => killGroup(1, true)).not.toThrow();
    expect(() => killGroup(-5, true)).not.toThrow();
  });
});

/**
 * Cancellation regression: a worker leader can cooperate with SIGTERM while a tool/MCP child ignores
 * it. The old early return after the leader exited left that child orphaned. This starts that exact
 * process group and proves cancellation's process-tree reap kills the TERM-resistant orphan too.
 * Gated on `setsid` (Linux target); on an image without it the group-kill path is unreachable.
 */
describe("killProcessTree cancellation (live process group)", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitDead = async (pid: number, ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  };

  test.if(Bun.which("setsid") !== null)(
    "cancel reaps a TERM-resistant forked descendant — no orphan survives",
    async () => {
      // The leader exits cleanly on cancellation, but its child explicitly ignores SIGTERM. This is
      // the critical orphan shape: killing only / waiting only for the leader would report success
      // while the child kept running in the ticket workspace.
      const { cmd, groupKill } = wrapProcessGroup("bash", [
        "-c",
        "trap 'exit 0' TERM; (trap '' TERM; exec sleep 300) & echo CHILD=$!; wait",
      ]);
      expect(groupKill).toBe(true);

      const child = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
      // Read stdout until the descendant announces its pid (or bail after a bounded window).
      const reader = child.stdout.getReader();
      const dec = new TextDecoder();
      let out = "";
      const deadline = Date.now() + 3000;
      while (!out.includes("CHILD=") && Date.now() < deadline) {
        const race = (await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 100)),
        ])) as { value: Uint8Array | undefined; done: boolean };
        if (race.value) out += dec.decode(race.value);
        if (race.done) break;
      }
      const harnessPid = child.pid;
      const descendantPid = Number((out.match(/CHILD=(\d+)/) ?? [])[1]);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(descendantPid).toBeGreaterThan(1);
      // Both are live before the reap, and the descendant shares the leader's process group.
      expect(alive(harnessPid)).toBe(true);
      expect(alive(descendantPid)).toBe(true);

      try {
        await killProcessTree(
          { pid: harnessPid, kill: (s) => child.kill(s as never), exited: child.exited },
          { groupKill, graceMs: 500 },
        );
        // SIGKILL delivery to the group is asynchronous — poll briefly for both to die.
        await waitDead(harnessPid, 2000);
        await waitDead(descendantPid, 2000);

        expect(alive(harnessPid)).toBe(false);
        // The crux of OPS-50: the descendant is gone too, NOT reparented to init still running.
        expect(alive(descendantPid)).toBe(false);
      } finally {
        // Belt-and-braces so a failed assertion never leaks a 5-minute sleep into the test host.
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* already reaped */
        }
      }
    },
  );
});
