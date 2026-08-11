import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "./claude.ts";
import type { Config, WorkerEvent } from "../types.ts";

const config = {
  harness: {
    claude: {
      bin: "claude",
      default_model: "claude-sonnet-4-5",
      default_effort: "medium",
      permission_mode: "bypassPermissions",
      extra_flags: [],
    },
  },
} as unknown as Config;

const quietLog = (() => {
  const q = { info() {}, warn() {}, debug() {}, error() {}, child() { return q; } };
  return q as never;
})();

type PrivateDriver = {
  spec: unknown;
  buildArgs(mode: { kind: "spawn" | "resume"; sessionId: string }): string[];
};

/** A driver with a minimal but complete SpawnSpec stashed on `spec` — buildArgs reads it directly. */
function driverWithSpec(cfg: Config, specExtra: Record<string, unknown> = {}): PrivateDriver {
  const driver = new ClaudeDriver(cfg, quietLog) as unknown as PrivateDriver;
  driver.spec = {
    prompt: "do the thing",
    systemAppend: "",
    workspace: "/tmp/beckett-claude-test-ws",
    scope: { ownedGlobs: [], readGlobs: null, description: "x" },
    envelope: { effort: "high", turnCap: 10, wallClockS: 100, network: false },
    model: "",
    doneSchemaPath: "",
    ...specExtra,
  };
  return driver;
}

const SPAWN_MODE = { kind: "spawn" as const, sessionId: "11111111-1111-1111-1111-111111111111" };

test("result handling closes stdin so a finished claude process can exit", () => {
  const events: WorkerEvent[] = [];
  let ended = 0;
  let closed = 0;
  const driver = new ClaudeDriver(config, quietLog) as unknown as {
    child: unknown;
    handleResult(obj: Record<string, unknown>): void;
    onEvent(cb: (e: WorkerEvent) => void): () => void;
  };
  driver.onEvent((e) => events.push(e));
  driver.child = {
    stdin: {
      end() {
        ended += 1;
      },
      close() {
        closed += 1;
      },
    },
  };

  driver.handleResult({ subtype: "success", structured_output: { status: "complete" } });

  expect(ended).toBe(1);
  expect(closed).toBe(1);
  expect(events.find((e) => e.kind === "finished")).toMatchObject({
    kind: "finished",
    status: "success",
    subtype: "success",
    structuredOutput: { status: "complete" },
  });
});

// ── W2A: cross-session addressing (--name) + ultracode effort ──────────────────────────

test("buildArgs omits --name when spec.sessionName is unset (no --help probe needed)", () => {
  const driver = driverWithSpec(config);
  const args = driver.buildArgs(SPAWN_MODE);
  expect(args).not.toContain("--name");
});

test("buildArgs emits --name <sessionName> when the binary advertises --name support", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-claude-name-yes-"));
  try {
    const bin = join(dir, "claude-new");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  --help) echo 'usage: claude [--name <name>] [--model <model>] ...' ;;",
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(bin, 0o755);
    const cfg = {
      harness: { claude: { ...config.harness.claude, bin } },
    } as unknown as Config;
    const driver = driverWithSpec(cfg, { sessionName: "beckett-run-oauth-middleware" });
    const args = driver.buildArgs(SPAWN_MODE);
    const i = args.indexOf("--name");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("beckett-run-oauth-middleware");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildArgs omits --name (never fails spawn) when the binary's --help doesn't advertise it", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-claude-name-no-"));
  try {
    const bin = join(dir, "claude-old");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  --help) echo 'usage: claude [--model <model>] [--effort <effort>] ...' ;;",
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(bin, 0o755);
    const cfg = {
      harness: { claude: { ...config.harness.claude, bin } },
    } as unknown as Config;
    let warned = 0;
    const warnLog = (() => {
      const q = {
        info() {},
        warn() {
          warned += 1;
        },
        debug() {},
        error() {},
        child() {
          return q;
        },
      };
      return q as never;
    })();
    const driver = new ClaudeDriver(cfg, warnLog) as unknown as PrivateDriver;
    driver.spec = {
      prompt: "do the thing",
      systemAppend: "",
      workspace: "/tmp/beckett-claude-test-ws",
      scope: { ownedGlobs: [], readGlobs: null, description: "x" },
      envelope: { effort: "high", turnCap: 10, wallClockS: 100, network: false },
      model: "",
      doneSchemaPath: "",
      sessionName: "beckett-run-oauth-middleware",
    };
    const args = driver.buildArgs(SPAWN_MODE);
    expect(args).not.toContain("--name");
    expect(warned).toBe(1);
    // A second buildArgs call (e.g. a resume) hits the cache — no re-probe, no second warn.
    driver.buildArgs({ kind: "resume", sessionId: SPAWN_MODE.sessionId });
    expect(warned).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildArgs accepts ultracode effort", () => {
  const driver = driverWithSpec(config, {
    envelope: { effort: "ultracode", turnCap: 150, wallClockS: 5400, network: false },
  });
  const args = driver.buildArgs(SPAWN_MODE);
  const i = args.indexOf("--effort");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(args[i + 1]).toBe("ultracode");
});
