/**
 * Beckett — chilltext client (`src/chilltext.ts`)
 * =======================================================================================
 * // W3A owns this module (the concierge chilltext gate + doctrine land in the same wave).
 * This is a THIN same-wave placeholder so W4A's social-media chill pass has something real to
 * call: it honors the documented `/chill` contract (ctx-docs.md — verified live 2026-08-10) and
 * the one rule that matters everywhere it's used — FAIL OPEN. Any network error, timeout,
 * non-2xx, or malformed body resolves `null`, never throws, so a caller's fallback is always
 * "send the original text." Replace wholesale when W3A lands; keep the exported shape
 * (`chillTransform(cfg, {input, agentOutput, system}) → {messages} | null`) so callers don't churn.
 */

export interface ChillTextConfig {
  /** Base URL, e.g. "https://chilltext.ssh.codes" (no trailing slash required). */
  url: string;
  /** Hard timeout for the round trip (ms). Docs report ~1s normal latency; this is a safety net. */
  timeoutMs: number;
}

export interface ChillTextRequest {
  /** The user's actual message, for context. Optional. Max 6000 chars per the API. */
  input?: string;
  /** The text to rewrite. Required. Max 6000 chars. */
  agentOutput: string;
  /** English personality request, e.g. "snarky, extremely online". Max 2000 chars. */
  system?: string;
  temperature?: number;
  top_p?: number;
  /** 1–4, default 4. */
  max_bubbles?: number;
  /** Force exactly one output message. */
  single?: boolean;
}

export interface ChillTextResult {
  messages: string[];
}

export interface ChillTransformDeps {
  /** Injectable for tests — a fake avoids any real network call. */
  fetch?: typeof fetch;
}

/**
 * POST to chilltext's `/chill` endpoint and return the rewritten message bubbles. FAILS OPEN:
 * a missing url, network error, non-2xx response, timeout, or a body that doesn't parse into a
 * non-empty `messages` array all resolve `null` — the caller's job is to fall back to the
 * original text, never to treat `null` as an error worth surfacing.
 */
export async function chillTransform(
  cfg: ChillTextConfig,
  req: ChillTextRequest,
  deps: ChillTransformDeps = {},
): Promise<ChillTextResult | null> {
  if (!cfg.url.trim()) return null;
  const doFetch = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, cfg.timeoutMs));
  try {
    const res = await doFetch(`${cfg.url.replace(/\/+$/, "")}/chill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { messages?: unknown } | null;
    if (!body || !Array.isArray(body.messages)) return null;
    const messages = body.messages.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
    return messages.length > 0 ? { messages } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
