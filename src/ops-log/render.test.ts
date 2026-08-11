import { describe, expect, test } from "bun:test";
import type { LogRecord } from "../log.ts";
import { fmtDuration, fmtTokens, KNOWN_EVENT_MESSAGES, renderEventLine, renderFallback, shortId } from "./render.ts";

function rec(msg: string, fields: Record<string, unknown> = {}, level: LogRecord["level"] = "info"): LogRecord {
  return { level, ts: "2026-08-11T00:00:00.000Z", component: "test.component", msg, ...fields };
}

describe("known-event table coverage", () => {
  test("covers the spec's target range of highest-signal events (15-25)", () => {
    expect(KNOWN_EVENT_MESSAGES.length).toBeGreaterThanOrEqual(15);
    expect(KNOWN_EVENT_MESSAGES.length).toBeLessThanOrEqual(25);
  });

  test("every known event renders WITHOUT falling back to the compact k=v line", () => {
    for (const msg of KNOWN_EVENT_MESSAGES) {
      const line = renderEventLine(rec(msg, { run: "run-1", stage: "implement" }));
      expect(line).not.toContain(": " + msg + " ("); // the fallback's exact shape
      expect(line.length).toBeGreaterThan(0);
    }
  });
});

describe("exact known-event renderings", () => {
  test("session re-ground start/complete", () => {
    expect(
      renderEventLine(rec("concierge re-grounding on a fresh session", { contextTokens: 905_000, reason: "watermark" })),
    ).toBe("⚙ session re-ground starting (905k ctx) reason=watermark");
    expect(
      renderEventLine(
        rec("concierge re-grounding complete", { reason: "watermark", from: "40158bf8-aaaa-bbbb-cccc-000000000000", to: "eafd5910-aaaa-bbbb-cccc-000000000000" }),
      ),
    ).toBe("⚙ session re-ground 40158bf8→eafd5910");
  });

  test("turn start / done / failed", () => {
    expect(renderEventLine(rec("turn start", { channelName: "general", author: "sshdev" }))).toBe(
      "▶ turn start #general from @sshdev",
    );
    expect(renderEventLine(rec("turn done", { elapsedMs: 42_000, decision: "send" }))).toBe("✔ turn done 42s → sent");
    expect(renderEventLine(rec("turn failed", { elapsedMs: 12_000, err: "boom" }, "error"))).toBe(
      "✖ turn failed 12s: boom",
    );
  });

  test("turn start falls back to the raw channel/user id when no display name is known", () => {
    expect(renderEventLine(rec("turn start", { channelId: "111", userId: "222" }))).toBe("▶ turn start 111 from @222");
  });

  test("run lifecycle", () => {
    expect(renderEventLine(rec("run done", { run: "run-20260811-abc-slug" }))).toBe("▲ run done run-20260811-abc-slug");
    expect(renderEventLine(rec("run parked for a human", { run: "run-1", reason: "budget exceeded" }))).toBe(
      "⚠ run parked run-1: budget exceeded",
    );
  });

  test("discord gateway", () => {
    expect(renderEventLine(rec("discord shard reconnecting", {}, "warn"))).toBe("⇅ discord shard reconnecting");
    expect(renderEventLine(rec("discord shard disconnected", { code: 1006 }, "warn"))).toBe(
      "⇅ discord shard disconnected (code 1006)",
    );
  });

  test("browser lease acquired/released", () => {
    expect(renderEventLine(rec("browser lease acquired", { runId: "run-9", channelId: "chan-1" }))).toBe(
      "▶ browser lease acquired run-9",
    );
    expect(renderEventLine(rec("browser lease released", { runId: "run-9" }))).toBe("✔ browser lease released run-9");
  });

  test("publish outbox", () => {
    expect(
      renderEventLine(rec("queued GitHub publish for retry", { attempt: 2, item: "#12" }, "warn")),
    ).toBe("⚠ publish attempt 2 queued for retry: #12");
    expect(
      renderEventLine(rec("queued GitHub publish still failing", { error: "rate limited" }, "warn")),
    ).toBe("⚠ publish attempt failed: rate limited");
  });

  test("deploy/restart", () => {
    expect(renderEventLine(rec("booting beckett v4", { version: "7.0.0-rc.2" }))).toBe("⚙ booting beckett 7.0.0-rc.2");
    expect(renderEventLine(rec("beckett online", { liveRuns: 1 }))).toBe("✔ beckett online (1 live run)");
    expect(renderEventLine(rec("beckett online", { liveRuns: 3 }))).toBe("✔ beckett online (3 live runs)");
    expect(renderEventLine(rec("shutting down beckett", { signal: "SIGTERM" }))).toBe("⏻ shutting down (SIGTERM)");
  });
});

describe("unknown-event fallback", () => {
  test("renders a compact component: msg (k=v k=v) line — never a raw JSON dump", () => {
    const line = renderEventLine(rec("something nobody wrote a renderer for", { foo: "bar", n: 3 }, "warn"));
    expect(line).toBe("⚠ test.component: something nobody wrote a renderer for (foo=bar n=3)");
    expect(line).not.toContain("{"); // no raw JSON dump of the record
  });

  test("with no extra fields, omits the empty parens", () => {
    expect(renderFallback(rec("bare event"))).toBe("• test.component: bare event");
  });

  test("a non-primitive field value is compacted, not dumped whole", () => {
    const line = renderFallback(rec("weird event", { nested: { a: 1, b: 2 } }));
    expect(line).toContain("nested=");
    expect(line.length).toBeLessThan(200);
  });

  test("caps overlong lines instead of growing unbounded", () => {
    const huge = "x".repeat(1000);
    const line = renderFallback(rec("huge event", { blob: huge }));
    expect(line.length).toBeLessThanOrEqual(400);
  });
});

describe("format helpers", () => {
  test("fmtDuration", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(42_000)).toBe("42s");
    expect(fmtDuration(59_000)).toBe("59s");
    expect(fmtDuration(60_000)).toBe("1m");
    expect(fmtDuration(125_000)).toBe("2m5s");
  });

  test("fmtTokens", () => {
    expect(fmtTokens(500)).toBe("500");
    expect(fmtTokens(905_000)).toBe("905k");
    expect(fmtTokens(1_000)).toBe("1k");
  });

  test("shortId", () => {
    expect(shortId("40158bf8-aaaa-bbbb-cccc-000000000000")).toBe("40158bf8");
    expect(shortId(undefined)).toBe("?");
    expect(shortId("")).toBe("?");
  });
});
