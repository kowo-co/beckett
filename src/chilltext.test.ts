/**
 * chilltext client (`src/chilltext.ts`) — the contract POST, the fail-open matrix, and the
 * client-side bypass rules. No network: every test injects a fake `fetchFn`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chillTransform, shouldBypassChill, type ChilltextConfig } from "./chilltext.ts";
import { CHILL_GATE_PREAMBLE } from "./chill-system.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "beckett-chilltext-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Every test here pins `personaPath` at a scratch file (usually a missing one): the default is the
 * REAL `~/.beckett/persona.md`, so a test that left it alone would assert against whatever voice
 * the box it runs on happens to have.
 */
function noPersona(): string {
  return join(tmp(), "absent-persona.md");
}

function cfg(overrides: Partial<ChilltextConfig> = {}): ChilltextConfig {
  return {
    enabled: true,
    url: "https://chilltext.example",
    timeout_ms: 8_000,
    max_bubbles: 3,
    bubble_delay_ms: 2_500,
    system_override: "",
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

    const result = await chillTransform(
      cfg(),
      { input: "what's up", agentOutput: "Hello there!", personaPath: noPersona() },
      fetchFn,
    );

    expect(result).toEqual({ messages: ["hey", "cool"] });
    expect(capturedUrl).toBe("https://chilltext.example/chill");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body).toEqual({ input: "what's up", agentOutput: "Hello there!", max_bubbles: 3 });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("the persona file becomes the system prompt, wrapped in the rewrite-gate framing", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const persona = join(tmp(), "persona.md");
    writeFileSync(persona, "# persona: beckett\n\nall lowercase. no period at the end of a message");

    await chillTransform(cfg(), { agentOutput: "hi there", personaPath: persona }, fetchFn);

    const system = String(body.system);
    expect(system).toContain("no period at the end of a message"); // the persona reached the wire
    expect(system).toContain(CHILL_GATE_PREAMBLE); // …behind the framing, not as a bare cat
    expect(system.indexOf(CHILL_GATE_PREAMBLE)).toBeLessThan(system.indexOf("all lowercase"));
  });

  test("editing the persona file changes the very next call's system prompt (no restart)", async () => {
    const sent: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent.push(String(JSON.parse(String(init?.body)).system));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const persona = join(tmp(), "persona.md");

    writeFileSync(persona, "talk like a pirate, arr");
    await chillTransform(cfg(), { agentOutput: "hi there", personaPath: persona }, fetchFn);
    writeFileSync(persona, "talk like a lighthouse keeper");
    await chillTransform(cfg(), { agentOutput: "hi there", personaPath: persona }, fetchFn);

    expect(sent[0]).toContain("talk like a pirate, arr");
    expect(sent[1]).toContain("talk like a lighthouse keeper");
    expect(sent[1]).not.toContain("pirate");
  });

  test("system omitted when the persona file is missing and nothing overrides it", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await chillTransform(cfg(), { agentOutput: "hi", personaPath: noPersona() }, fetchFn);
    expect(body.system).toBeUndefined();
  });

  test("cfg.system_override replaces the persona-derived prompt (the escape hatch)", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const persona = join(tmp(), "persona.md");
    writeFileSync(persona, "talk like a pirate, arr");
    await chillTransform(
      cfg({ system_override: "be snarky and brief" }),
      { agentOutput: "hi", personaPath: persona },
      fetchFn,
    );
    expect(body.system).toBe("be snarky and brief");
  });

  test("a per-call system (the social lane) outranks both the override and the persona", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const persona = join(tmp(), "persona.md");
    writeFileSync(persona, "talk like a pirate, arr");
    await chillTransform(
      cfg({ system_override: "be snarky" }),
      { agentOutput: "hi", system: "be formal", personaPath: persona },
      fetchFn,
    );
    expect(body.system).toBe("be formal");
  });

  test("single: true rides the body when the caller forces one bubble", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await chillTransform(cfg(), { agentOutput: "hi", single: true, personaPath: noPersona() }, fetchFn);
    expect(body.single).toBe(true);
  });

  test("input/agentOutput are truncated to 6000 chars before they leave the box", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: ["ok"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const long = "x".repeat(7_000);
    await chillTransform(cfg(), { input: long, agentOutput: long, personaPath: noPersona() }, fetchFn);
    expect((body.input as string).length).toBe(6_000);
    expect((body.agentOutput as string).length).toBe(6_000);
  });
});

describe("chillTransform — sampleLines (persona-leak guard feed)", () => {
  test("the persona file's sample lines are echoed back on the result", async () => {
    const fetchFn = okFetch({ messages: ["ok"] });
    const persona = join(tmp(), "persona.md");
    writeFileSync(persona, "## sample lines\n\ngood:\n> yeah that's broken. i know why. gimme 10\n");

    const result = await chillTransform(cfg(), { agentOutput: "hi", personaPath: persona }, fetchFn);
    expect(result?.sampleLines).toEqual(["yeah that's broken. i know why. gimme 10"]);
  });

  test("omitted, not [], when the persona has no sample-lines section", async () => {
    const fetchFn = okFetch({ messages: ["hey", "cool"] });
    const persona = join(tmp(), "persona.md");
    writeFileSync(persona, "# persona: beckett\n\nno sample lines here");

    const result = await chillTransform(cfg(), { agentOutput: "hi", personaPath: persona }, fetchFn);
    expect(result?.sampleLines).toBeUndefined();
  });

  test("omitted, not [], when the persona is missing entirely — a plain result still round-trips", async () => {
    const result = await chillTransform(cfg(), { agentOutput: "hi", personaPath: noPersona() }, okFetch({ messages: ["hey", "cool"] }));
    expect(result).toEqual({ messages: ["hey", "cool"] });
  });

  test("sampleLines is read even when cfg.system_override replaces the system prompt entirely", async () => {
    const persona = join(tmp(), "persona.md");
    writeFileSync(persona, "## sample lines\n\ngood:\n> yeah that's broken. i know why. gimme 10\n");
    const result = await chillTransform(
      cfg({ system_override: "be snarky and brief" }),
      { agentOutput: "hi", personaPath: persona },
      okFetch({ messages: ["ok"] }),
    );
    expect(result?.system).toBe("be snarky and brief");
    expect(result?.sampleLines).toEqual(["yeah that's broken. i know why. gimme 10"]);
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
    const result = await chillTransform(
      cfg(),
      { agentOutput: "hi", personaPath: noPersona() },
      okFetch({ messages: [exact] }),
    );
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
