/**
 * Coverage for config loading & validation (`src/config.ts`) — the refuse-to-start contract.
 * Issue #31: `harness.claude.extra_flags` must not be able to smuggle a duplicate of a
 * driver-owned flag past the exact-token dedup in `ClaudeDriver.buildArgs`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfigToml,
  dropRetiredChilltextSystem,
  dropRetiredSections,
  loadConfig,
  validateConfig,
} from "./config.ts";
import { browserHostSettings } from "./browser/runtime.ts";

/**
 * Run `fn` with process.env.CEREBRAS_API_KEY pinned (undefined = absent). The proactivity
 * fragment's triage_provider default reads the key at parse time, so tests touching defaults
 * must control it (same save/restore pattern as concierge/triage.test.ts).
 */
function withCerebrasKey<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.CEREBRAS_API_KEY;
  if (value === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = saved;
  }
}

/** Load a config from a literal TOML body in an isolated temp beckett dir. */
function loadToml(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "beckett-config-test-"));
  try {
    const configFile = join(dir, "config.toml");
    writeFileSync(configFile, body, "utf8");
    return loadConfig({ env: { BECKETT_DIR: dir }, configFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("extra_flags naming a driver-owned flag is a loud refuse-to-start", () => {
  expect(() =>
    loadToml(`[harness.claude]\nextra_flags = ["--model", "opus"]\n`),
  ).toThrow(/extra_flags may not override driver-owned flags: --model/);
});

test("benign extra_flags load fine", () => {
  const config = loadToml(`[harness.claude]\nextra_flags = ["--include-hook-events"]\n`);
  expect(config.harness.claude.extra_flags).toEqual(["--include-hook-events"]);
});

test("display.timezone defaults to America/Los_Angeles and an invalid value still boots", () => {
  expect(validateConfig({}).display.timezone).toBe("America/Los_Angeles");
  const invalid = loadToml(`[display]\ntimezone = "Not/AZone"\n`);
  expect(invalid.display.timezone).toBe("Not/AZone");
});

test("per-harness default efforts land where they should", () => {
  const config = loadToml(
    `[harness.codex]\ndefault_effort = "low"\n\n[harness.pi]\nthinking = "medium"\n`,
  );
  expect(config.harness.codex.default_effort).toBe("low");
  expect(config.harness.pi.thinking).toBe("medium");
  expect(config.harness.claude.default_effort).toBe("high"); // untouched default
});

test("an unknown top-level section is a loud config error (the schema is strict)", () => {
  expect(() => loadToml(`[nonsense]\nwidgets = 3\n`)).toThrow(/Unrecognized key|refusing to start/);
});

// The one deliberate hole in that strictness: sections that USED to be schema keys. A prod
// config.toml written before the v7 run engine still carries `[tracker]`/`[progress]`, and the
// daemon refusing to start on a file the deploy never touches is a Discord outage, not a safety
// feature. They are stripped with a deprecation line instead — and ONLY they are; the assertion
// above proves an actually-unknown section is still fatal.
describe("retired sections", () => {
  test("[tracker] / [progress] / [plane] are stripped instead of blocking the boot", () => {
    const config = loadToml(
      `[tracker]\nenabled = true\ndefault_board = "ops"\n\n[progress]\ncards_as_code = false\n\n[plane]\nbase_url = "x"\n\n[concurrency]\nmax_workers = 4\n`,
    );
    // Stripped, not merged into anything, and the rest of the file still applies.
    expect(config).not.toHaveProperty("tracker");
    expect(config).not.toHaveProperty("progress");
    expect(config).not.toHaveProperty("plane");
    expect(config.concurrency.max_workers).toBe(4);
  });

  test("a config.toml still carrying [dream] loads with a deprecation warning instead of failing strict validation", () => {
    const config = loadToml(
      `[dream]\noutput_token_budget = 1000\nmodel = "opus"\n\n[concurrency]\nmax_workers = 4\n`,
    );
    expect(config).not.toHaveProperty("dream");
    expect(config.concurrency.max_workers).toBe(4);
  });

  test("stripping is announced once per retired section, and silent when there are none", () => {
    const seen: string[] = [];
    const warn = (message: string) => void seen.push(message);
    expect(dropRetiredSections({ tracker: { enabled: true }, runs: {} }, warn)).toEqual({ runs: {} });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/\[tracker\]/);

    seen.length = 0;
    const clean = { runs: { max_live: 3 } };
    expect(dropRetiredSections(clean, warn)).toBe(clean); // untouched object, not a clone
    expect(seen).toHaveLength(0);
  });

  // The chilltext voice string got the same treatment when the gate's prompt moved to persona.md:
  // prod's config.toml carries `system = "..."` and the slice is strict, so the choice was "strip
  // it loudly" or "the daemon stops booting on a file the deploy never touches".
  test("[concierge.chilltext] system is stripped, and the rest of the slice still applies", () => {
    const config = loadToml(
      `[concierge.chilltext]\nenabled = true\nsystem = "be a pirate"\nmax_bubbles = 2\n`,
    );
    expect(config.concierge.chilltext).not.toHaveProperty("system");
    expect(config.concierge.chilltext.system_override).toBe(""); // the empty-by-default escape hatch
    expect(config.concierge.chilltext.enabled).toBe(true);
    expect(config.concierge.chilltext.max_bubbles).toBe(2);
  });

  test("the retired chilltext voice is announced once, and untouched configs are left alone", () => {
    const seen: string[] = [];
    const warn = (message: string) => void seen.push(message);
    const stripped = dropRetiredChilltextSystem(
      { concierge: { chilltext: { enabled: true, system: "be a pirate" } } },
      warn,
    );
    expect(stripped).toEqual({ concierge: { chilltext: { enabled: true } } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/persona\.md/);

    seen.length = 0;
    const clean = { concierge: { chilltext: { enabled: true } } };
    expect(dropRetiredChilltextSystem(clean, warn)).toBe(clean); // untouched object, not a clone
    expect(seen).toHaveLength(0);
  });
});

test("github activity relay is off until an instance configures its own repository and dev feed", () => {
  expect(validateConfig({}).github.activity).toMatchObject({
    enabled: false,
    repo: "",
    branch: "main",
    poll_secs: 60,
    channel_id: "",
  });
});

test("enabled GitHub activity relay requires an explicit repository and channel", () => {
  expect(() => validateConfig({ github: { activity: { enabled: true } } })).toThrow(
    /set github\.activity\.repo/,
  );
  expect(() => validateConfig({ github: { activity: { enabled: true, repo: "octocat/demo" } } })).toThrow(
    /set github\.activity\.channel_id/,
  );
});

test("proactivity defaults ship disabled and off", () => {
  const config = withCerebrasKey(undefined, () => validateConfig({}));
  expect(config.proactivity).toMatchObject({
    enabled: false,
    default_mode: "off",
    triage_provider: "claude",
    triage_model: "claude-haiku-4-5",
    triage_threshold: 0.55,
    burst_quiet_secs: 8,
    engaged_quiet_secs: 4,
    channel_cooldown_secs: 60,
    max_interjections_per_hour: 0,
    engaged_window_secs: 180,
    offer_ttl_secs: 600,
    transcript_window: 15,
    channels: {},
  });
});

test("proactivity classifier model defaults follow the selected provider", () => {
  expect(validateConfig({ proactivity: { triage_provider: "cerebras" } }).proactivity.triage_model).toBe(
    "gemma-4-31b",
  );
  expect(
    validateConfig({ proactivity: { triage_provider: "cerebras", triage_model: "claude-haiku-4-5" } })
      .proactivity.triage_model,
  ).toBe("gemma-4-31b");
  expect(
    validateConfig({ proactivity: { triage_provider: "cerebras", triage_model: "custom-cerebras-model" } })
      .proactivity.triage_model,
  ).toBe("custom-cerebras-model");
});

test("triage provider defaults to cerebras when CEREBRAS_API_KEY is present (issue #152)", () => {
  const config = withCerebrasKey("csk-test", () => validateConfig({}));
  expect(config.proactivity.triage_provider).toBe("cerebras");
  expect(config.proactivity.triage_model).toBe("gemma-4-31b");
});

test("a blank CEREBRAS_API_KEY does not flip the triage default", () => {
  const config = withCerebrasKey("   ", () => validateConfig({}));
  expect(config.proactivity.triage_provider).toBe("claude");
  expect(config.proactivity.triage_model).toBe("claude-haiku-4-5");
});

test("an explicit triage_provider in config.toml beats the CEREBRAS_API_KEY default", () => {
  const config = withCerebrasKey("csk-test", () =>
    validateConfig({ proactivity: { triage_provider: "claude" } }),
  );
  expect(config.proactivity.triage_provider).toBe("claude");
  expect(config.proactivity.triage_model).toBe("claude-haiku-4-5");
});

test("shared_context defaults ship enabled with the OPS-80 bounds", () => {
  const config = validateConfig({});
  expect(config.shared_context).toMatchObject({
    enabled: true,
    max_entries_per_channel: 200,
    max_age_hours: 72,
    inject_budget_tokens: 3000,
    roster_max: 12,
  });
});

test("computer-use defaults to one stable full-Chromium profile and bounded tool output", () => {
  expect(validateConfig({}).quick).toMatchObject({
    browser_profile_dir: "browser/profile",
    browser_headless: true,
    browser_viewport_width: 1440,
    browser_viewport_height: 900,
    browser_eval_timeout_ms: 60_000,
    browser_max_output_chars: 24_000,
    browser_question_wait_secs: 3_600,
    browser_attach_roots: [],
  });
  expect(validateConfig({ quick: { browser_attach_roots: ["/tmp/../approved-media"] } }).quick.browser_attach_roots).toEqual(["/approved-media"]);
  expect(() => validateConfig({ quick: { browser_attach_roots: ["relative-media"] } })).toThrow("absolute directory path");
  expect(() => validateConfig({ quick: { browser_max_output_chars: 4_095 } })).toThrow();
  expect(() => validateConfig({ quick: { browser_max_output_chars: 1_000_001 } })).toThrow();
});

test("computer-use rejects profiles that expose Beckett state or traverse a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-browser-profile-test-"));
  try {
    for (const profile of [".", "..", dir]) {
      expect(() => browserHostSettings(validateConfig({
        paths: { beckett_dir: dir },
        quick: { browser_profile_dir: profile },
      }))).toThrow("dedicated directory");
    }
    symlinkSync(tmpdir(), join(dir, "browser"));
    expect(() => browserHostSettings(validateConfig({
      paths: { beckett_dir: dir },
      quick: { browser_profile_dir: "browser/profile" },
    }))).toThrow("must not contain symlinks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proactivity runtime override merges over TOML", () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-config-test-"));
  try {
    const configFile = join(dir, "config.toml");
    writeFileSync(
      configFile,
      `[proactivity]\nenabled = true\ndefault_mode = "suggest"\n\n[proactivity.channels]\n"chan-a" = "suggest"\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "proactivity.json"),
      JSON.stringify({ enabled: false, channels: { "chan-b": "auto" } }),
      "utf8",
    );
    const config = loadConfig({ env: { BECKETT_DIR: dir }, configFile });
    expect(config.proactivity.enabled).toBe(false);
    expect(config.proactivity.default_mode).toBe("suggest");
    expect(config.proactivity.channels).toEqual({ "chan-a": "suggest", "chan-b": "auto" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("default-config example drift (issue #34)", () => {
  // The committed example pins the KEYLESS defaults (the triage provider default is
  // env-sensitive since #152, and a host key must not make this suite flap).
  test("deploy/config.toml.example matches the live schema's defaults", () => {
    const committed = readFileSync(join(import.meta.dir, "..", "deploy", "config.toml.example"), "utf8");
    expect(committed).toBe(withCerebrasKey(undefined, () => defaultConfigToml()));
  });

  test("the generated example round-trips through the strict validator", () => {
    const parsed = Bun.TOML.parse(withCerebrasKey(undefined, () => defaultConfigToml()));
    expect(() => validateConfig(parsed)).not.toThrow();
  });
});
