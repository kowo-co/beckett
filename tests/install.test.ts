import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnvInventory } from "../src/ops/doctor.ts";

const REPO = resolve(import.meta.dir, "..");
const INSTALLER = join(REPO, "install.sh");
const UNIT_INSTALLER = join(REPO, "deploy/install.sh");
const ENV_EXAMPLE = join(REPO, ".env.example");
const VALID_DISCORD_ID = ["123456789", "012345678"].join("");
const tempDirs: string[] = [];
const TEST_AS_BECKETT = [
  'PATH="$TEST_BIN_DIR:/usr/sbin:/usr/bin:/sbin:/bin"',
  "as_beckett() {",
  '  if [ "$1" = "${BECKETT_HOME}/.bun/bin/bun" ]; then',
  "    shift",
  '    "$TEST_BUN" "$@"',
  "  else",
  '    "$@"',
  "  fi",
  "}",
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function run(
  argv: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function installerTestEnv(binDir: string): Record<string, string> {
  return { TEST_BIN_DIR: binDir, TEST_BUN: process.execPath };
}

function fakeInstall(binDir: string): void {
  writeExecutable(
    join(binDir, "install"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'mode=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -m) mode="$2"; shift 2 ;;',
      '    -o|-g) shift 2 ;;',
      "    *) break ;;",
      "  esac",
      "done",
      'src="$1"',
      'dest="$2"',
      'mkdir -p "$(dirname "$dest")"',
      'cp "$src" "$dest"',
      '[ -z "$mode" ] || chmod "$mode" "$dest"',
      "",
    ].join("\n"),
  );
  writeExecutable(join(binDir, "chown"), "#!/bin/sh\nexit 0\n");
}

function fakeSystemctl(binDir: string): void {
  writeExecutable(
    join(binDir, "systemctl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"",
      'if [[ "$*" == *" disable --now "* ]]; then',
      '  unit="${!#}"',
      '  rm -f "$HOME/.config/systemd/user/$unit"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
}

describe("public installer input and file contracts", () => {
  test("--help is available without mutating the host", async () => {
    const result = await run(["bash", INSTALLER, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Install Beckett on Ubuntu or Debian");
    expect(result.stdout).toContain("Secrets are never accepted as command-line flags");
  });

  test("pins privileged command lookup to the trusted system PATH", async () => {
    const dir = tempDir("beckett-install-path-");
    const binDir = join(dir, "bin");
    const marker = join(dir, "hijacked");
    writeExecutable(join(binDir, "uname"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);

    const result = await run(
      ["/bin/bash", "-c", 'source "$1"; printf "%s\\n" "$PATH"; uname -m >/dev/null', "bash", INSTALLER],
      { env: { PATH: binDir } },
    );
    expect(result).toEqual({
      code: 0,
      stdout: "/usr/sbin:/usr/bin:/sbin:/bin\n",
      stderr: "",
    });
    expect(await Bun.file(marker).exists()).toBeFalse();
  });

  test("repo/ref validation rejects shell syntax and traversal", async () => {
    const marker = join(tempDir("beckett-install-injection-"), "ran");
    const script = [
      'source "$1"',
      'valid_repo_url "https://github.com/owner/repo.git"',
      'valid_ref "feature/easy-install"',
      '! valid_repo_url "https://example.com/owner/repo.git"',
      '! valid_repo_url "https://github.com/owner/repo.git;touch"',
      '! valid_ref "main;touch-$2"',
      '! valid_ref "../main"',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, marker]);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await Bun.file(marker).exists()).toBeFalse();
  });

  test("host release gates match supported Ubuntu and Debian floors", async () => {
    const script = [
      'source "$1"',
      'supported_release ubuntu 22.04',
      'supported_release ubuntu 24.04',
      'supported_release ubuntu 26.04',
      'supported_release debian 12',
      'supported_release debian 13',
      '! supported_release ubuntu 20.04',
      '! supported_release ubuntu 25.04',
      '! supported_release debian 11',
      '! supported_release debian 14',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER]);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("browser provisioning installs Linux deps before Chromium and keeps the live smoke opt-in", () => {
    const installer = readFileSync(INSTALLER, "utf8");
    const start = installer.indexOf("install_app_dependencies() {");
    const end = installer.indexOf("\n}\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = installer.slice(start, end);
    expect(installer).toContain("bubblewrap");
    const dependencyInstall = block.indexOf("install --frozen-lockfile");
    const systemDeps = block.indexOf("install-deps chromium");
    const chromium = block.indexOf("install --no-shell chromium");
    const smoke = block.indexOf("BECKETT_INSTALL_BROWSER_SMOKE");
    const typecheck = block.indexOf("run typecheck");
    for (const marker of [dependencyInstall, systemDeps, chromium, smoke, typecheck]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(systemDeps).toBeGreaterThan(dependencyInstall);
    expect(chromium).toBeGreaterThan(systemDeps);
    expect(smoke).toBeGreaterThan(chromium);
    expect(typecheck).toBeGreaterThan(smoke);
  });

  test("generated config is strict, private, and instance-specific", async () => {
    const dir = tempDir("beckett-install-config-");
    const binDir = join(dir, "bin");
    const config = join(dir, "config.toml");
    mkdirSync(binDir);
    fakeInstall(binDir);
    const script = [
      'source "$1"',
      ...TEST_AS_BECKETT,
      'write_initial_config "$2" "octocat" "true" "false"',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, config], {
      env: installerTestEnv(binDir),
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const body = readFileSync(config, "utf8");
    expect(body).toContain('home = "/home/beckett"');
    expect(body).toContain('github_user = "octocat"');
    expect(body).toContain("[harness.pi]\nenabled = true");
    expect(body).toContain("[harness.codex]\nenabled = false");
    expect(body).toContain("[github.activity]\nenabled = false");
    expect(body).not.toContain("0xbeckett");
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  test("secret upserts are atomic, quiet, and idempotent", async () => {
    const dir = tempDir("beckett-install-env-");
    const binDir = join(dir, "bin");
    const envFile = join(dir, ".env");
    const secret = "sentinel-secret-never-log";
    mkdirSync(binDir);
    fakeInstall(binDir);
    writeFileSync(envFile, "KEEP_ME=yes\nDISCORD_TOKEN=\n", { mode: 0o644 });
    const script = [
      'source "$1"',
      ...TEST_AS_BECKETT,
      'upsert_env "$2" DISCORD_TOKEN "$3"',
      'upsert_env "$2" DISCORD_TOKEN "$3"',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, envFile, secret], {
      env: installerTestEnv(binDir),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(readFileSync(envFile, "utf8")).toBe("KEEP_ME=yes\nDISCORD_TOKEN=" + secret + "\n");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  test("generated identity can seed the portable project-publishing org", async () => {
    const dir = tempDir("beckett-install-identity-");
    const binDir = join(dir, "bin");
    const config = join(dir, "config.toml");
    const envFile = join(dir, ".env");
    mkdirSync(binDir);
    fakeInstall(binDir);
    writeFileSync(
      config,
      '[identity]\ngithub_user = "octocat"\n',
      "utf8",
    );
    writeFileSync(envFile, "BECKETT_GH_ORG=\n", "utf8");
    const script = [
      'source "$1"',
      ...TEST_AS_BECKETT,
      'sync_github_org "$2" "$3"',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, envFile, config], {
      env: installerTestEnv(binDir),
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(envFile, "utf8")).toBe("BECKETT_GH_ORG=octocat\n");
  });

  test("explicit rerun inputs update installer-owned fields without dropping custom config", async () => {
    const dir = tempDir("beckett-install-rerun-");
    const binDir = join(dir, "bin");
    const config = join(dir, "config.toml");
    mkdirSync(binDir);
    fakeInstall(binDir);
    writeFileSync(
      config,
      [
        "# Created by Beckett installer v1.",
        "[identity]",
        'github_user = "CHANGE_ME"',
        "[custom]",
        'keep = "yes"',
        "",
      ].join("\n"),
      "utf8",
    );
    const script = [
      'source "$1"',
      ...TEST_AS_BECKETT,
      'INPUT_GITHUB_USER="octocat"',
      'INPUT_ENABLE_PI="false"',
      'update_existing_config "$2"',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, config], {
      env: installerTestEnv(binDir),
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const body = readFileSync(config, "utf8");
    expect(body).toContain('github_user = "octocat"');
    expect(body).toContain("[harness.pi]\nenabled = false");
    expect(body).toContain("[github.activity]\nenabled = false");
    expect(body).toContain('[custom]\nkeep = "yes"');
  });

  test("valid indented and commented TOML keeps every existing rerun value", async () => {
    const dir = tempDir("beckett-install-commented-toml-");
    const binDir = join(dir, "bin");
    const config = join(dir, "config.toml");
    mkdirSync(binDir);
    fakeInstall(binDir);
    writeFileSync(
      config,
      [
        "# Created by Beckett installer v1.",
        "  [identity] # account identity",
        '    github_user = "existing-user" # keep this account',
        "  [tracker] # ticket queue",
        '    default_board = "ops" # keep this board',
        "  [harness.pi] # optional worker",
        "    enabled = false # intentionally disabled",
        "  [harness.codex] # optional worker",
        "    enabled = true # intentionally enabled",
        "  [custom] # unrelated settings",
        '    keep = "yes" # do not drop custom config',
        "",
      ].join("\n"),
      "utf8",
    );
    const script = [
      'source "$1"',
      ...TEST_AS_BECKETT,
      "NON_INTERACTIVE=1",
      'update_existing_config "$2"',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, config], {
      env: installerTestEnv(binDir),
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });

    const parsed = Bun.TOML.parse(readFileSync(config, "utf8")) as Record<string, any>;
    expect(parsed.identity.github_user).toBe("existing-user");
    expect(parsed.tracker.default_board).toBe("ops");
    expect(parsed.harness.pi.enabled).toBeFalse();
    expect(parsed.harness.codex.enabled).toBeTrue();
    expect(parsed.custom.keep).toBe("yes");
  });

  test("explicit GitHub identity reruns rotate only an installer-derived org", async () => {
    const dir = tempDir("beckett-install-org-rotate-");
    const binDir = join(dir, "bin");
    const config = join(dir, "config.toml");
    const envFile = join(dir, ".env");
    mkdirSync(binDir);
    fakeInstall(binDir);
    writeFileSync(
      config,
      [
        "# Created by Beckett installer v1.",
        "[identity]",
        'github_user = "old-user"',
        "[harness.pi]",
        "enabled = true",
        "[harness.codex]",
        "enabled = false",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(envFile, "BECKETT_GH_ORG=old-user\n", "utf8");
    const script = [
      'source "$1"',
      ...TEST_AS_BECKETT,
      'previous_github_user="$(toml_string_value "$3" identity github_user)"',
      'INPUT_GITHUB_USER="new-user"',
      'update_existing_config "$3"',
      'sync_github_org "$2" "$3" "$previous_github_user"',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, envFile, config], {
      env: installerTestEnv(binDir),
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(envFile, "utf8")).toBe("BECKETT_GH_ORG=new-user\n");
    expect((Bun.TOML.parse(readFileSync(config, "utf8")) as Record<string, any>).identity.github_user).toBe("new-user");
  });

  test("explicit GitHub identity reruns preserve a user-chosen org override", async () => {
    const dir = tempDir("beckett-install-org-custom-");
    const binDir = join(dir, "bin");
    const config = join(dir, "config.toml");
    const envFile = join(dir, ".env");
    mkdirSync(binDir);
    fakeInstall(binDir);
    writeFileSync(
      config,
      [
        "# Created by Beckett installer v1.",
        "[identity]",
        'github_user = "old-user"',
        "[harness.pi]",
        "enabled = true",
        "[harness.codex]",
        "enabled = false",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(envFile, "BECKETT_GH_ORG=custom-org\n", "utf8");
    const script = [
      'source "$1"',
      ...TEST_AS_BECKETT,
      'previous_github_user="$(toml_string_value "$3" identity github_user)"',
      'INPUT_GITHUB_USER="new-user"',
      'update_existing_config "$3"',
      'sync_github_org "$2" "$3" "$previous_github_user"',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, envFile, config], {
      env: installerTestEnv(binDir),
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(envFile, "utf8")).toBe("BECKETT_GH_ORG=custom-org\n");
  });

  test("user-owned config symlinks are refused before any write", async () => {
    const dir = tempDir("beckett-install-symlink-");
    const target = join(dir, "target");
    const link = join(dir, "config.toml");
    writeFileSync(target, "do not touch\n", "utf8");
    symlinkSync(target, link);
    const script = ['source "$1"', 'as_beckett() { "$@"; }', 'assert_safe_user_file "$2"'].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER, link]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refusing symlink");
    expect(readFileSync(target, "utf8")).toBe("do not touch\n");
  });

  test("service-user commands cross an explicit empty-environment boundary", async () => {
    const result = await run(["bash", "-c", 'source "$1"; declare -f as_beckett; declare -f as_beckett_in_repo', "bash", INSTALLER]);
    expect(result.code).toBe(0);
    expect(result.stdout.match(/env -i/g)?.length).toBeGreaterThanOrEqual(2);
    expect(result.stdout.match(/\/usr\/sbin\/runuser/g)?.length).toBe(2);
  });

  test("every key the installer seeds into a fresh .env is documented in .env.example (#72)", () => {
    // A clean-machine install writes an .env template whose keys `beckett doctor` cross-checks
    // against the committed .env.example inventory; an undocumented key there is a live warn on a
    // brand-new box. Extract the exact keys from install.sh's fresh-env printf and assert each is
    // in the inventory, so adding a seeded key without documenting it fails here instead of on a
    // stranger's first `beckett doctor`.
    const installer = readFileSync(INSTALLER, "utf8");
    const template = installer.match(/printf '# Created by the Beckett installer\.[^']*'/);
    expect(template).not.toBeNull();
    const seeded = [...template![0].matchAll(/\\n([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]!);
    expect(seeded.length).toBeGreaterThan(0);

    const inventory = parseEnvInventory(readFileSync(ENV_EXAMPLE, "utf8"));
    const documented = new Set([...inventory.required, ...inventory.optional]);
    const undocumented = seeded.filter((key) => !documented.has(key));
    expect(undocumented).toEqual([]);
  });

  test("readiness accepts EITHER the GitHub App or a legacy PAT (#114)", async () => {
    // The 0xbeckett PAT is dead; the identity is now a GitHub App. A box configured with app
    // credentials and NO PAT must read as ready, and a box with neither must name both paths.
    // BECKETT_STATE/BECKETT_HOME are readonly in the installer, so `env_value` is the seam.
    const probe = async (envBody: string) => {
      const script = [
        'source "$1"',
        'env_value() { printf "%s\\n" "$TEST_ENV" | sed -n "s/^$2=//p" | head -1; }',
        "config_bool() { printf 'false\\n'; }",
        "readiness_problems",
      ].join("\n");
      const r = await run(["bash", "-c", script, "bash", INSTALLER], { env: { TEST_ENV: envBody } });
      expect(r.code).toBe(0);
      return r.stdout;
    };

    const base = `DISCORD_TOKEN=x\nDISCORD_OWNER_ID=${VALID_DISCORD_ID}\n`;
    expect(await probe(`${base}GITHUB_APP_ID=1\nGITHUB_APP_PRIVATE_KEY_PATH=/k.pem\n`)).not.toContain("GitHub");
    expect(await probe(`${base}GITHUB_PAT=ghp_x\n`)).not.toContain("GitHub");
    const neither = await probe(base);
    expect(neither).toContain("missing GitHub credentials");
    expect(neither).toContain("GITHUB_APP_ID");
    expect(neither).toContain("GITHUB_PAT");
  });

  test("tracker preflight exercises the configured default board", async () => {
    const dir = tempDir("beckett-install-tracker-preflight-");
    const calls = join(dir, "calls");
    const script = [
      'source "$1"',
      'as_beckett_in_repo() { printf "ops\\n"; }',
      'as_beckett() { local IFS=" "; printf "%s\\n" "$*" >> "$PREFLIGHT_CALLS"; }',
      'preflight_tracker',
    ].join("\n");
    const result = await run(["bash", "-c", script, "bash", INSTALLER], {
      env: { PREFLIGHT_CALLS: calls },
    });
    expect(result.code).toBe(0);
    const log = readFileSync(calls, "utf8");
    expect(log).toContain("ticket list --board ops");
  });
});

describe("systemd unit installer staging", () => {
  test("--no-start links units and never enables the daemon", async () => {
    const home = tempDir("beckett-unit-stage-");
    const binDir = join(home, "bin");
    const calls = join(home, "systemctl.log");
    mkdirSync(binDir);
    fakeSystemctl(binDir);

    for (let pass = 0; pass < 2; pass += 1) {
      const result = await run(["bash", UNIT_INSTALLER, "--no-start"], {
        env: {
          HOME: home,
          PATH: binDir + ":" + process.env.PATH,
          SYSTEMCTL_LOG: calls,
        },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("disabled, and stopped");
    }

    const log = readFileSync(calls, "utf8");
    expect(log).toContain("--user daemon-reload");
    expect(log).toContain("--user disable --now beckett-v4.service");
    expect(log).toContain("--user disable --now beckett-heartbeat.timer");
    expect(log).not.toContain("--user enable beckett-v4.service");
    expect(await Bun.file(join(home, ".config/systemd/user/beckett-v4.service")).exists()).toBeTrue();
    expect(await Bun.file(join(home, ".config/systemd/user/beckett-heartbeat.timer")).exists()).toBeTrue();
  });

  test("start keeps an incomplete fresh install healthy-pending-configuration", async () => {
    const home = tempDir("beckett-unit-incomplete-");
    const binDir = join(home, "bin");
    const calls = join(home, "systemctl.log");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    mkdirSync(binDir);
    fakeSystemctl(binDir);
    writeExecutable(
      join(home, ".local/bin/beckett"),
      '#!/bin/sh\nprintf \'{\\n  "state": "healthy-pending-configuration"\\n}\\n\'\n',
    );

    const result = await run(["bash", UNIT_INSTALLER], {
      env: {
        HOME: home,
        PATH: binDir + ":" + process.env.PATH,
        SYSTEMCTL_LOG: calls,
        BECKETT_START_TIMEOUT_SECS: "2",
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("healthy-pending-configuration");
    const log = readFileSync(calls, "utf8");
    expect(log).toContain("--user enable beckett-v4.service");
    expect(log).toContain("--user restart beckett-v4.service");
    expect(log).not.toContain("--user enable --now beckett-heartbeat.timer");
  });

  test("complete credentials enable only after a real CLI readiness check", async () => {
    const home = tempDir("beckett-unit-ready-");
    const binDir = join(home, "bin");
    const calls = join(home, "systemctl.log");
    mkdirSync(join(home, ".beckett"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    mkdirSync(binDir);
    fakeSystemctl(binDir);
    writeFileSync(
      join(home, ".beckett/.env"),
      [
        "DISCORD_TOKEN=discord",
        `DISCORD_OWNER_ID=${VALID_DISCORD_ID}`,
        "GITHUB_PAT=github",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(join(home, ".claude/.credentials.json"), "{}\n", { mode: 0o600 });
    writeExecutable(join(home, ".local/bin/beckett"), "#!/bin/sh\nprintf '{}\\n'\n");

    const result = await run(["bash", UNIT_INSTALLER], {
      env: {
        HOME: home,
        PATH: binDir + ":" + process.env.PATH,
        SYSTEMCTL_LOG: calls,
        BECKETT_START_TIMEOUT_SECS: "2",
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("installed and ready");
    const log = readFileSync(calls, "utf8");
    expect(log).toContain("--user enable beckett-v4.service");
    expect(log).toContain("--user reset-failed beckett-v4.service");
    expect(log).toContain("--user restart beckett-v4.service");
    expect(log).toContain("--user enable --now beckett-heartbeat.timer");
    expect(log).toContain("--user is-active --quiet beckett-v4.service");
  });

  test("failed readiness disables both the daemon and heartbeat", async () => {
    const home = tempDir("beckett-unit-not-ready-");
    const binDir = join(home, "bin");
    const calls = join(home, "systemctl.log");
    mkdirSync(join(home, ".beckett"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    mkdirSync(binDir);
    fakeSystemctl(binDir);
    writeFileSync(
      join(home, ".beckett/.env"),
      `DISCORD_TOKEN=x\nDISCORD_OWNER_ID=${VALID_DISCORD_ID}\nGITHUB_PAT=x\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(home, ".claude/.credentials.json"), "{}\n", { mode: 0o600 });
    writeExecutable(join(home, ".local/bin/beckett"), "#!/bin/sh\nexit 1\n");

    const result = await run(["bash", UNIT_INSTALLER], {
      env: {
        HOME: home,
        PATH: binDir + ":" + process.env.PATH,
        SYSTEMCTL_LOG: calls,
        BECKETT_START_TIMEOUT_SECS: "1",
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not become ready");
    const log = readFileSync(calls, "utf8");
    expect(log).toContain("--user disable --now beckett-v4.service");
    expect(log).toContain("--user disable --now beckett-heartbeat.timer");
  });

  test("service units resolve Bun from the declared daemon PATH", () => {
    for (const name of ["beckett-v4.service", "beckett-dev.service"]) {
      const unit = readFileSync(join(REPO, "deploy/systemd", name), "utf8");
      expect(unit).toContain("ExecStart=/usr/bin/env bun");
      expect(unit).toContain(".bun/bin");
      expect(unit).not.toContain("ExecStart=/usr/local/bin/bun");
    }
  });
});
