import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.ts";
import type { Logger } from "../types.ts";
import { createIsolatedBrowserRuntime } from "./isolated.ts";
import { browserHostSettings } from "./runtime.ts";

/**
 * Lane-fidelity coverage for #250.
 *
 * Every other browser test forces `sandbox: "none"` for speed and determinism
 * (runtime.test.ts, isolated.test.ts's own `buildBrowserHostLaunch` suite, agent.test.ts),
 * so a green `bun run test:browser` proves nothing about the bubblewrap-sandboxed lane
 * production actually launches through — exactly the gap that let the betterwright 1.8.0
 * bench run find 5/5 unsandboxed passes next to 0/5 sandboxed launches. This file is the
 * one browser test that does not force process isolation: it drives a real
 * BetterWright/CloakBrowser session through `createIsolatedBrowserRuntime`'s default
 * `sandbox: "auto"`, the exact `buildBrowserHostLaunch` bwrap path isolated.ts uses in
 * production (same as `scripts/ops/browser-smoke.ts`). A missing bind or an env var
 * `--clearenv` strips fails here instead of only showing up live.
 *
 * Run standalone with `bun run test:browser:sandboxed`. CI gates it behind the same
 * browser-lane path filter as `test:browser` and provisions bwrap + the managed
 * CloakBrowser cache before it runs (see .github/workflows/ci.yml). Skips loudly, rather
 * than failing, when bwrap itself is unavailable on the machine running it — the whole
 * point of this file is coverage of the sandbox, not a requirement that every dev machine
 * have one.
 */

const hasBwrap = Boolean(Bun.which("bwrap"));
if (!hasBwrap) {
  console.warn(
    "[isolated.sandboxed.test] SKIPPING: bwrap not found in PATH. " +
      "The sandboxed browser lane cannot be exercised on this machine — " +
      "install bubblewrap (and util-linux for prlimit) to run it.",
  );
}

const CONTROL_TOKEN = "test-control-token-0123456789abcdef0123456789abcdef";

describe.skipIf(!hasBwrap)("betterwright launches through the real bubblewrap sandbox", () => {
  test("acquires a lease and evaluates a real page through bwrap, not process isolation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beckett-browser-sandboxed-test-"));
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          "<!doctype html><title>sandboxed lane fixture</title><main id=\"content\">ok</main>",
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    // Captures the same isolation label isolated.ts logs on a real launch
    // ("bubblewrap" | "sandbox-exec" | "process"), so this test fails loud if a
    // regression ever makes the "auto" default silently fall back to process isolation
    // instead of actually exercising bwrap.
    const observedIsolation: string[] = [];
    const logger: Logger = {
      debug() {},
      info(_msg, fields) {
        const isolation = fields?.isolation;
        if (typeof isolation === "string") observedIsolation.push(isolation);
      },
      warn() {},
      error() {},
      child() {
        return logger;
      },
    };
    const runId = "isolated-sandboxed-test";
    const config = validateConfig({
      paths: { beckett_dir: dir },
      quick: { browser_profile_dir: "browser/profile", browser_eval_timeout_ms: 30_000 },
    });
    const runtime = createIsolatedBrowserRuntime({
      settings: browserHostSettings(config),
      logger,
      backend: "betterwright",
      // sandbox intentionally omitted: default "auto" is what production uses on Linux
      // when bwrap is present, and forcing it here would defeat the point of this file.
    });
    try {
      await runtime.acquire({
        runId,
        channelId: null,
        artifactsDir: join(dir, "browser-agent", runId, "artifacts"),
        controlToken: CONTROL_TOKEN,
      });
      const result = await runtime.evaluate(
        runId,
        `await page.goto(${JSON.stringify(baseUrl)}); return await page.locator('#content').innerText();`,
        CONTROL_TOKEN,
      );
      expect(result.value).toBe("ok");
      expect(observedIsolation).toContain("bubblewrap");
    } finally {
      await runtime.release(runId, false).catch(() => undefined);
      await runtime.stop().catch(() => undefined);
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
