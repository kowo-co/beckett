import { expect, test } from "bun:test";
import { redactSecrets } from "./redact.ts";

test("a labelled secret in prose is redacted (the original browser-summary shape)", () => {
  const redacted = redactSecrets("Created it. Password: Sup3rSecret! token=abc123");
  expect(redacted).toContain("[redacted]");
  expect(redacted).not.toContain("Sup3rSecret");
});

test("a shell env-var assignment leaks no value even with no human-written label", () => {
  const cases = [
    "export GITHUB_TOKEN=ghp_liveSecretValue1234567890",
    'DB_PASSWORD="hunter2-actually-secret"',
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIsecretkeyEXAMPLE",
  ];
  for (const line of cases) {
    const redacted = redactSecrets(line);
    expect(redacted).toContain("[redacted]");
  }
  expect(redactSecrets(cases[0]!)).not.toContain("liveSecretValue1234567890");
  expect(redactSecrets(cases[1]!)).not.toContain("hunter2-actually-secret");
  expect(redactSecrets(cases[2]!)).not.toContain("wJalrXUtnFEMIsecretkeyEXAMPLE");
});

test("a bare provider token or bearer header is redacted by its shape alone", () => {
  expect(redactSecrets("curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'")).not.toContain(
    "eyJhbGciOiJIUzI1NiJ9",
  );
  expect(redactSecrets("token pasted: ghp_1234567890abcdefghij")).not.toContain("ghp_1234567890abcdefghij");
  expect(redactSecrets("sk-ant-api03-thisIsNotARealKeyButShapedLikeOne1234")).not.toContain(
    "thisIsNotARealKeyButShapedLikeOne1234",
  );
});

test("a harmless line with no credential shape passes through byte-for-byte", () => {
  const line = "Bash  bun test src/discord/redact.test.ts";
  expect(redactSecrets(line)).toBe(line);
});

test("a leaked secret in terminal output never survives to the redacted string", () => {
  const leak = "export STRIPE_SECRET_KEY=sk_live_51ThisWouldBeARealSecretIfItWereOne";
  const redacted = redactSecrets(leak);
  expect(redacted).not.toContain("sk_live_51ThisWouldBeARealSecretIfItWereOne");
});
