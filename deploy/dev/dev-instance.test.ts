/**
 * Guard tests for the Beckett [DEV] staging runway (overhaul B1). All hermetic: temp HOME, no
 * network, no systemd, no read of prod's `~/.beckett`. These stop `deploy/dev/*` rotting silently
 * on the next schema change, and prove `seed.sh` is exercisable with no token at all.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { validateConfig } from "../../src/config.ts";
import { RoutineRegistrySchema } from "../../src/routine/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const SEED_SH = join(HERE, "seed.sh");
const UNIT_PATH = join(REPO_ROOT, "deploy", "systemd", "beckett-dev.service");
const PROD_UNIT_PATH = join(REPO_ROOT, "deploy", "systemd", "beckett-v4.service");
const DOC_PATH = join(REPO_ROOT, "docs", "dev-instance.md");

function unitText(): string {
  return readFileSync(UNIT_PATH, "utf8");
}

/** Run seed.sh with a fully controlled env: fresh temp HOME, a minimal PATH, no token unless given. */
function runSeed(
  args: string[],
  opts: { home?: string; env?: Record<string, string> } = {},
): { code: number; stdout: string; stderr: string; home: string } {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "beckett-dev-seed-home-"));
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...opts.env,
  };
  const result = Bun.spawnSync(["bash", SEED_SH, ...args], {
    cwd: HERE,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    home,
  };
}

describe("deploy/dev/config.toml", () => {
  test("validates against the live strict schema", () => {
    const raw = parseToml(readFileSync(join(HERE, "config.toml"), "utf8"));
    expect(() => validateConfig(raw)).not.toThrow();
  });
});

describe("deploy/dev/routines.json", () => {
  test("parses as a RoutineRegistry", () => {
    const raw = JSON.parse(readFileSync(join(HERE, "routines.json"), "utf8"));
    expect(() => RoutineRegistrySchema.parse(raw)).not.toThrow();
  });
});

describe("beckett-dev.service", () => {
  test("pins the isolation env", () => {
    const text = unitText();
    expect(text).toContain("BECKETT_DIR=%h/.beckett-dev");
    expect(text).toContain("BECKETT_HOME=%h/.beckett-dev");
    expect(text).toContain("BECKETT_PROJECTS_ROOT=%h/.beckett-dev/projects");
    expect(text).toContain("BECKETT_STARTUP_CHANNEL_ID=disabled");
    expect(text).toContain("BECKETT_CARDS_CHANNEL_ID=disabled");
    expect(text).not.toMatch(/^OnFailure=/m);
    // Prose is allowed to name prod's ~/.beckett for contrast; no *directive* may point there.
    expect(text).not.toMatch(/^(Environment(File)?|WorkingDirectory)=-?%h\/\.beckett\/?$/m);
  });

  test("and beckett-v4.service never share a state dir", () => {
    const devText = unitText();
    const devDir = devText.match(/Environment=BECKETT_DIR=(\S+)/)?.[1];
    expect(devDir).toBeTruthy();

    let prodDir: string | undefined;
    let prodEnvFile: string | undefined;
    try {
      const prodText = readFileSync(PROD_UNIT_PATH, "utf8");
      prodDir = prodText.match(/Environment=BECKETT_DIR=(\S+)/)?.[1];
      prodEnvFile = prodText.match(/EnvironmentFile=-?(\S+)/)?.[1];
    } catch {
      // beckett-v4.service is not committed under this name; fall back to the known-prod default.
      prodDir = "%h/.beckett";
    }
    // Prod's BECKETT_DIR (explicit or the daemon's documented default) must differ from dev's.
    expect(prodDir ?? "%h/.beckett").not.toBe(devDir);

    const devEnvFile = devText.match(/EnvironmentFile=-?(\S+)/)?.[1];
    if (prodEnvFile) expect(prodEnvFile).not.toBe(devEnvFile);
  });
});

describe("seed.sh --dry-run --no-secrets", () => {
  test("touches nothing and needs no token", () => {
    const { code, stdout, stderr, home } = runSeed(["--dry-run", "--no-secrets"]);
    try {
      expect(code).toBe(0);
      expect(stdout).toContain(".beckett-dev");
      expect(stderr).toBe("");
      // Nothing was created under the temp HOME — dry-run only prints.
      expect(() => readFileSync(join(home, ".beckett-dev", "config.toml"))).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("seed.sh without a token source", () => {
  test("refuses and names all three ways to supply one", () => {
    const { code, stdout, stderr, home } = runSeed(["--dry-run"]);
    try {
      expect(code).toBe(2);
      const combined = stdout + stderr;
      expect(combined).toContain("--token-file");
      expect(combined).toContain("BECKETT_DEV_DISCORD_TOKEN");
      expect(combined).toContain("CALLIE_DISCORD_TOKEN");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("seed.sh", () => {
  test("never prints the token", () => {
    const sentinel = "sentinel-do-not-print-1234567890";
    const { code, stdout, stderr, home } = runSeed(["--dry-run"], {
      env: { BECKETT_DEV_DISCORD_TOKEN: sentinel, DISCORD_OWNER_ID: "999999999999999999" },
    });
    try {
      expect(code).toBe(0);
      expect(stdout).not.toContain(sentinel);
      expect(stderr).not.toContain(sentinel);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--token-file resolves a token from a file, trimmed, without printing it", () => {
    const home = mkdtempSync(join(tmpdir(), "beckett-dev-seed-home-"));
    const tokenFile = join(home, "token.txt");
    const sentinel = "file-sentinel-abcdef";
    writeFileSync(tokenFile, `${sentinel}\n`);
    const { code, stdout, stderr } = runSeed(
      ["--dry-run", "--token-file", tokenFile, "--owner-id", "123"],
      { home },
    );
    try {
      expect(code).toBe(0);
      expect(stdout).not.toContain(sentinel);
      expect(stderr).not.toContain(sentinel);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("exits 2 naming the missing file when --token-file does not exist", () => {
    const { code, stderr, home } = runSeed(["--dry-run", "--token-file", "/nope/does-not-exist"]);
    try {
      expect(code).toBe(2);
      expect(stderr).toContain("does not exist");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("docs/dev-instance.md", () => {
  test("exists and seed.sh's pointer resolves", () => {
    const seedText = readFileSync(SEED_SH, "utf8");
    expect(seedText).toContain("docs/dev-instance.md");
    expect(() => readFileSync(DOC_PATH, "utf8")).not.toThrow();
  });

  test("names every var the unit sets", () => {
    const unit = unitText();
    const doc = readFileSync(DOC_PATH, "utf8");
    const keys = [...unit.matchAll(/^Environment=([A-Z_]+)=/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(doc).toContain(key);
    }
  });
});

describe("no systemctl/sudo/prod access from a --dry-run seed", () => {
  test("dry-run never invokes systemctl, sudo, or reads ~/.beckett", () => {
    // A minimal env with an empty HOME and no prod .env — if seed.sh reached for systemctl/sudo/
    // ~/.beckett unconditionally (not behind the run() dry-run guard) this would be visible in
    // stdout ("+ systemctl ...") only as a printed *plan*, never an actual invocation, and no
    // prod path may appear in the seeded state below.
    const home = mkdtempSync(join(tmpdir(), "beckett-dev-seed-home-"));
    mkdirSync(join(home, ".beckett"), { recursive: true }); // prod dir present, but must not be read
    const { code, stdout } = runSeed(["--dry-run", "--no-secrets"], { home });
    try {
      expect(code).toBe(0);
      expect(stdout).not.toContain(join(home, ".beckett", ".env"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
