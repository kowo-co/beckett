/**
 * chilltext client (`src/chilltext.ts`) — the contract POST, the fail-open matrix, and the
 * client-side bypass rules. No network: every test injects a fake `fetchFn`.
 */

import { describe, expect, test } from "bun:test";
import { chillTransform, shouldBypassChill, type ChilltextConfig } from "./chilltext.ts";

function cfg(overrides: Partial<ChilltextConfig> = {}): ChilltextConfig {
  return {
    enabled: true,
    url: "https://chilltext.example",
    timeout_ms: 8_000,
    max_bubbles: 3,
    bubble_delay_ms: 2_500,
    system: "",
    skip_code_blocks: true,
    ...overrides,
  };
}

function okFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}

describe("chillTransform — the contract POST", () => {
  test("posts to `${url}/chill` with the documented body and returns the trimmed bubbles", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ messages: [" hey ", "cool"], n_bubbles: 2, ms: 12 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await chillTransform(cfg(), { input: "what's up", agentOutput: "Hello there!" }, fetchFn);

    expect(result).toEqual({ messages: ["hey", "cool"] });
    expect(capturedUrl).toBe("https://chilltext.example/chill");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toEqual({ input: "what's up", agentOutput: "Hello there!", max_bubbles: 3 });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("system omitted when cfg.system is empty and no per-call override", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await chillTransform(cfg({ system: "" }), { agentOutput: "hi" }, fetchFn);
    expect(body.system).toBeUndefined();
  });

  test("system falls back to cfg.system when no per-call override is given", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await chillTransform(cfg({ system: "be snarky and brief" }), { agentOutput: "hi" }, fetchFn);
    expect(body.system).toBe("be snarky and brief");
  });

  test("a per-call system overrides cfg.system", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await chillTransform(cfg({ system: "be snarky" }), { agentOutput: "hi", system: "be formal" }, fetchFn);
    expect(body.system).toBe("be formal");
  });

  test("single: true rides the body when the caller forces one bubble", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await chillTransform(cfg(), { agentOutput: "hi", single: true }, fetchFn);
    expect(body.single).toBe(true);
  });

  test("input/agentOutput are truncated to 6000 chars before they leave the box", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const long = "x".repeat(7_000);
    await chillTransform(cfg(), { input: long, agentOutput: long }, fetchFn);
    expect((body.input as string).length).toBe(6_000);
    expect((body.agentOutput as string).length).toBe(6_000);
  });
});

describe("chillTransform — fail-open matrix (every case returns null, never throws)", () => {
  test("non-2xx status", async () => {
    const result = await chillTransform(cfg(), { agentOutput: "hi" }, okFetch({ error: "boom" }, 500));
    expect(result).toBeNull();
  });

  test("timeout / abort", async () => {
    // Simulate the AbortSignal chillTransform always passes actually firing — never resolves the
    // fetch itself, exactly like a real hung connection past `AbortSignal.timeout(cfg.timeout_ms)`.
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const result = await chillTransform(cfg({ timeout_ms: 1 }), { agentOutput: "hi" }, fetchFn);
    expect(result).toBeNull();
  });

  test("network error (fetch rejects)", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await chillTransform(cfg(), { agentOutput: "hi" }, fetchFn);
    expect(result).toBeNull();
  });

  test("bad JSON", async () => {
    const fetchFn = (async () => new Response("not json{{{", { status: 200 })) as unknown as typeof fetch;
    const result = await chillTransform(cfg(), { agentOutput: "hi" }, fetchFn);
    expect(result).toBeNull();
  });

  test("empty messages array", async () => {
    const result = await chillTransform(cfg(), { agentOutput: "hi" }, okFetch({ messages: [] }));
    expect(result).toBeNull();
  });

  test("missing messages field", async () => {
    const result = await chillTransform(cfg(), { agentOutput: "hi" }, okFetch({ output: "hi" }));
    expect(result).toBeNull();
  });

  test("a non-string entry in messages", async () => {
    const result = await chillTransform(cfg(), { agentOutput: "hi" }, okFetch({ messages: ["ok", 42] }));
    expect(result).toBeNull();
  });

  test("a message over 2000 chars after trim", async () => {
    const result = await chillTransform(
      cfg(),
      { agentOutput: "hi" },
      okFetch({ messages: ["ok", "x".repeat(2_001)] }),
    );
    expect(result).toBeNull();
  });

  test("a message that trims to empty", async () => {
    const result = await chillTransform(cfg(), { agentOutput: "hi" }, okFetch({ messages: ["   "] }));
    expect(result).toBeNull();
  });

  test("a message exactly at the 2000-char cap is accepted", async () => {
    const exact = "x".repeat(2_000);
    const result = await chillTransform(cfg(), { agentOutput: "hi" }, okFetch({ messages: [exact] }));
    expect(result).toEqual({ messages: [exact] });
  });
});

describe("shouldBypassChill", () => {
  test("bypasses when the capability is disabled", () => {
    expect(shouldBypassChill("a normal reply here", cfg({ enabled: false }))).toBe(true);
  });

  test("bypasses when cfg is undefined (hand-built test configs without a chilltext slice)", () => {
    expect(shouldBypassChill("a normal reply here", undefined)).toBe(true);
  });

  test("bypasses text carrying a code fence", () => {
    expect(shouldBypassChill("here's the fix:\n```ts\nconst x = 1;\n```", cfg())).toBe(true);
  });

  test("bypasses text over 6000 chars", () => {
    expect(shouldBypassChill("x".repeat(6_001), cfg())).toBe(true);
  });

  test("bypasses a short ack under 8 chars", () => {
    expect(shouldBypassChill("ok", cfg())).toBe(true);
    expect(shouldBypassChill("on it!", cfg())).toBe(true);
  });

  test("bypasses text that is only a URL", () => {
    expect(shouldBypassChill("https://example.com/some/long/path", cfg())).toBe(true);
    expect(shouldBypassChill("  https://example.com  ", cfg())).toBe(true);
  });

  test("does NOT bypass an ordinary eligible reply", () => {
    expect(shouldBypassChill("Sure, I can look into that for you and report back shortly.", cfg())).toBe(false);
  });

  test("does NOT bypass a URL that has surrounding prose", () => {
    expect(shouldBypassChill("here's the link: https://example.com", cfg())).toBe(false);
  });
});
