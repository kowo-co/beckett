import { describe, expect, test } from "bun:test";
import {
  MAX_SAVES_PER_EVAL,
  MAX_SECRET_VALUE_CHARS,
  readSecretEnvelope,
  wrapEvalWithSecretSink,
} from "./secret-sink.ts";

describe("readSecretEnvelope", () => {
  test("the wrapped script still returns its own value", () => {
    const { result, saves } = readSecretEnvelope({
      __beckettEnvelope: 1,
      result: "logged in",
      saves: [],
    });
    expect(result).toBe("logged in");
    expect(saves).toEqual([]);
  });

  test("save requests are validated and capped", () => {
    const { saves } = readSecretEnvelope({
      __beckettEnvelope: 1,
      result: null,
      saves: [
        { field: "hf_token", value: "hf_live_x" }, // valid
        { field: "Bad Field!", value: "x".repeat(10) }, // bad field name
        { field: "empty_one", value: "" }, // empty value
        { field: "too_long", value: "x".repeat(MAX_SECRET_VALUE_CHARS + 1) }, // oversized
        { field: "second", value: "ok-value" }, // valid
        { field: "third", value: "ok-value" }, // valid
        { field: "fourth", value: "ok-value" }, // valid
        { field: "fifth", value: "ok-value" }, // 5th valid save — dropped by the cap
      ],
    });
    expect(saves).toEqual([
      { field: "hf_token", value: "hf_live_x" },
      { field: "second", value: "ok-value" },
      { field: "third", value: "ok-value" },
      { field: "fourth", value: "ok-value" },
    ]);
    expect(saves.length).toBe(MAX_SAVES_PER_EVAL);
  });

  test("a non-envelope result passes through untouched", () => {
    const { result, saves } = readSecretEnvelope("plain old return value");
    expect(result).toBe("plain old return value");
    expect(saves).toEqual([]);

    const withObject = readSecretEnvelope({ status: "completed" });
    expect(withObject.result).toEqual({ status: "completed" });
    expect(withObject.saves).toEqual([]);

    const nullish = readSecretEnvelope(null);
    expect(nullish.result).toBeNull();
    expect(nullish.saves).toEqual([]);
  });
});

describe("wrapEvalWithSecretSink", () => {
  test("a script's top-level return and await survive the wrap", () => {
    const code = "const el = await page.locator('#x'); return await el.textContent();";
    const wrapped = wrapEvalWithSecretSink(code, {});
    expect(wrapped).toContain(code);
    // Syntax-check only: wrap the whole envelope body in an async arrow so top-level
    // return/await are legal, without ever executing browser globals like `page`.
    expect(() => new Function(`return (async () => {${wrapped}})`)).not.toThrow();
  });

  test("the preamble never contains a value it was not given", () => {
    const values = { password: "hunter2-secret", totp: "739184" };
    const wrapped = wrapEvalWithSecretSink("return 1;", values);
    expect(wrapped.startsWith("const secrets = Object.freeze({\n  ..." + JSON.stringify(values) + ",\n")).toBe(true);
    expect(wrapped).toContain(JSON.stringify(values));
    expect(wrapped.trim().endsWith(
      "return { __beckettEnvelope: 1, result: __beckettResult, saves: __beckettSaves };",
    )).toBe(true);
    // Nothing beyond the JSON-serialized values object appears — no stray value fragments.
    const withoutJson = wrapped.replace(JSON.stringify(values), "");
    expect(withoutJson).not.toContain("hunter2-secret");
    expect(withoutJson).not.toContain("739184");
  });

  test("wraps only mint the envelope shape — save requests are enforced daemon-side too", () => {
    const wrapped = wrapEvalWithSecretSink("return 1;", { x: "y" });
    expect(wrapped).toContain("__beckettSaves.push({ field, value })");
    expect(wrapped).toContain("__beckettEnvelope: 1");
  });
});
