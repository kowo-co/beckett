import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGroundingVerifier,
  deriveGrounded,
  parseGroundingVerdict,
} from "./social-verify.ts";

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quietLogger;
  },
} as unknown as import("../types.ts").Logger;

// ── deriveGrounded / parseGroundingVerdict (pure, no spawn) ─────────────────────────────────

test("deriveGrounded refuses when ANY claim fails to trace", () => {
  expect(
    deriveGrounded([
      { tracesToSource: true },
      { tracesToSource: false },
    ]),
  ).toBe(false);
});

test("deriveGrounded passes when every claim traces", () => {
  expect(deriveGrounded([{ tracesToSource: true }, { tracesToSource: true }])).toBe(true);
});

test("deriveGrounded is vacuously true for a post with no factual claims (a flat opinion)", () => {
  expect(deriveGrounded([])).toBe(true);
});

test("parseGroundingVerdict derives `grounded` in code, never trusting a model-supplied field", () => {
  // The model schema has no `grounded` field at all — even if a malicious/confused model tried to
  // stuff one in, parseGroundingVerdict only ever reads `claims`.
  const verdict = parseGroundingVerdict(
    JSON.stringify({
      claims: [{ claim: "aws locked me out", tracesToSource: false, sourceLine: "n/a" }],
      reason: "no source mentions AWS",
      grounded: true, // ignored — deriveGrounded(claims) overrides this
    }),
  );
  expect(verdict.grounded).toBe(false);
});

test("parseGroundingVerdict unwraps the `claude -p --output-format json` envelope", () => {
  const inner = JSON.stringify({
    claims: [{ claim: "the daemon restarted unclean", tracesToSource: true, sourceLine: "uptime ledger, ..." }],
    reason: "traced to the uptime ledger",
  });
  const verdict = parseGroundingVerdict(JSON.stringify({ type: "result", result: inner }));
  expect(verdict.grounded).toBe(true);
  expect(verdict.claims).toHaveLength(1);
});

test("parseGroundingVerdict unwraps a markdown-fenced result", () => {
  const inner = "```json\n" + JSON.stringify({ claims: [], reason: "pure opinion, nothing to trace" }) + "\n```";
  const verdict = parseGroundingVerdict(JSON.stringify({ type: "result", result: inner }));
  expect(verdict.grounded).toBe(true);
});

// ── createGroundingVerifier (fake claude CLI, matching ../concierge/triage.test.ts's pattern) ──

function fakeClaudeBin(dir: string, resultJson: string): string {
  const bin = join(dir, "fake-claude.ts");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun\n` +
      `console.log(JSON.stringify({ type: "result", result: ${JSON.stringify(resultJson)} }));\n`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("the AWS-lockout post text, verified against sources that never mention AWS, is REFUSED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-grounding-verify-"));
  try {
    const bin = fakeClaudeBin(
      dir,
      JSON.stringify({
        claims: [
          {
            claim: "aws locked me out for twenty minutes over unusual activity after rotating an ssh key",
            tracesToSource: false,
            sourceLine: "none — SOURCES has no AWS/lockout/SSH-key entry",
          },
        ],
        reason: "SOURCES contains no AWS incident; this is a fabricated personal incident",
      }),
    );
    const verify = createGroundingVerifier({ model: "claude-sonnet-5", logger: quietLogger, claudeBin: bin });
    const verdict = await verify(
      'aws locked me out for twenty minutes today over "unusual activity" right after i rotated an ssh key i\'ve had since 2021. the unusual activity was rotating the key',
      "SOURCES FOR THIS RUN (read before you write anything)\n\n— real tech news, fetched this run —\n(none fetched this run)\n\n— Beckett's own real history —\n(nothing notable recorded recently)",
    );
    expect(verdict.grounded).toBe(false);
    expect(verdict.reason).toContain("fabricated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a post whose claim traces to a real source line PASSES", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-grounding-verify-"));
  try {
    const bin = fakeClaudeBin(
      dir,
      JSON.stringify({
        claims: [
          {
            claim: "the daemon restarted unclean",
            tracesToSource: true,
            sourceLine: "[uptime ledger, 2026-08-21T09:00:00Z] the daemon restarted unclean (crashed and came back)",
          },
        ],
        reason: "traced to the uptime ledger entry",
      }),
    );
    const verify = createGroundingVerifier({ model: "claude-sonnet-5", logger: quietLogger, claudeBin: bin });
    const verdict = await verify(
      "crashed and came back today and nobody even noticed. humbling.",
      "SOURCES FOR THIS RUN\n\n— Beckett's own real history —\n- [uptime ledger, 2026-08-21T09:00:00Z] the daemon restarted unclean (crashed and came back)",
    );
    expect(verdict.grounded).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLI spawn failure fails CLOSED (refused), never open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-grounding-verify-"));
  try {
    const bin = join(dir, "fake-claude-broken.ts");
    writeFileSync(bin, `#!/usr/bin/env bun\nprocess.stderr.write("boom");\nprocess.exit(1);\n`, "utf8");
    chmodSync(bin, 0o755);
    const verify = createGroundingVerifier({ model: "claude-sonnet-5", logger: quietLogger, claudeBin: bin });
    const verdict = await verify("anything", "SOURCES FOR THIS RUN\n(none)");
    expect(verdict.grounded).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unparseable model output fails CLOSED (refused), never open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beckett-grounding-verify-"));
  try {
    const bin = join(dir, "fake-claude-garbage.ts");
    writeFileSync(bin, `#!/usr/bin/env bun\nconsole.log("not json at all");\n`, "utf8");
    chmodSync(bin, 0o755);
    const verify = createGroundingVerifier({ model: "claude-sonnet-5", logger: quietLogger, claudeBin: bin });
    const verdict = await verify("anything", "SOURCES FOR THIS RUN\n(none)");
    expect(verdict.grounded).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
