import { expect, test } from "bun:test";
import { parseDiscordTurnOutput } from "./output.ts";

test("only a complete structured delivery object can become Discord text", () => {
  expect(
    parseDiscordTurnOutput({ decision: "send", voice_check: "matches persona", message: "the tests pass" }),
  ).toEqual({
    decision: "send",
    message: "the tests pass",
  });
  expect(parseDiscordTurnOutput({ decision: "pass", voice_check: "", message: null })).toEqual({
    decision: "pass",
    message: null,
  });

  // Assistant scratch text and old sentinel-shaped blobs are not a delivery protocol.
  expect(parseDiscordTurnOutput("I should stay quiet.\nPASS")).toBeNull();
  expect(parseDiscordTurnOutput({ decision: "pass", voice_check: "", message: "PASS" })).toBeNull();
  expect(parseDiscordTurnOutput({ decision: "send", voice_check: "matches persona", message: "" })).toBeNull();
});

test("voice_check is required and must be a string, but never rides the parsed result", () => {
  // Missing voice_check (old 2-key shape) is rejected fail-closed, not silently upgraded.
  expect(parseDiscordTurnOutput({ decision: "send", message: "hello" })).toBeNull();
  // Wrong type for voice_check is rejected even when decision/message are otherwise valid.
  expect(parseDiscordTurnOutput({ decision: "send", voice_check: 1, message: "hello" })).toBeNull();
  expect(parseDiscordTurnOutput({ decision: "send", voice_check: null, message: "hello" })).toBeNull();

  // voice_check is discarded from the returned object; only decision/message survive.
  const parsed = parseDiscordTurnOutput({
    decision: "send",
    voice_check: "short, no padding, matches persona",
    message: "done",
  });
  expect(parsed).toEqual({ decision: "send", message: "done" });
  expect(parsed && Object.keys(parsed)).toEqual(["decision", "message"]);
});

test("a fourth key is rejected even when decision/voice_check/message are all valid", () => {
  expect(
    parseDiscordTurnOutput({
      decision: "send",
      voice_check: "matches persona",
      message: "hello",
      extra: "nope",
    }),
  ).toBeNull();
});
