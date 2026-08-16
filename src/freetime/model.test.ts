import { expect, test } from "bun:test";
import type { Logger } from "../types.ts";
import { localDate, parseModelResult } from "./model.ts";

const quiet = (() => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  return log as unknown as Logger;
})();

test("parseModelResult reads output_tokens from the harness frame", () => {
  const withUsage = parseModelResult(JSON.stringify({ result: "hello", usage: { output_tokens: 42 } }));
  expect(withUsage).toEqual({ text: "hello", outputTokens: 42 });
});

test("parseModelResult estimates from length when usage is absent", () => {
  const withoutUsage = parseModelResult(JSON.stringify({ result: "hello there" }), quiet);
  expect(withoutUsage.text).toBe("hello there");
  expect(withoutUsage.outputTokens).toBeGreaterThan(0);
});

test("localDate renders the tz-local YYYY-MM-DD", () => {
  const now = new Date("2026-07-26T11:30:00.000Z"); // 04:30 America/Los_Angeles
  expect(localDate(now, "America/Los_Angeles")).toBe("2026-07-26");
  expect(localDate(now, "UTC")).toBe("2026-07-26");
});
