/**
 * Beckett — chilltext client (`src/chilltext.ts`)
 * =======================================================================================
 * A shared client for chilltext (v7 architecture doc): a friend's homelab rewrite API
 * (`https://chilltext.ssh.codes` by default — Gemma on an RTX 4060 behind a raspberry pi +
 * tailscale) that restyles a normal assistant reply into 1–4 lowercase, no-emoji, no-em-dash
 * "text message" bubbles. It exists for the Concierge (`src/concierge/chill-gate.ts`) but is
 * written provider-agnostic so a future caller (an agent, a routine) can reuse it.
 *
 * The one law this module exists to enforce: **fail open**. Any error, timeout, malformed
 * response, or out-of-contract bubble degrades to `null` — every caller's contract is "null
 * means send the original text untouched." This module never throws.
 *
 * The voice it asks for is NOT defined here: the `system` field is derived from the persona file
 * (`src/chill-system.ts`), the same `~/.beckett/persona.md` the Concierge's own prompt appends,
 * so there is exactly one place where Beckett's voice is written down.
 */

import type { Config } from "./types.ts";
import { chillSystemPrompt } from "./chill-system.ts";

/** The `[concierge.chilltext]` config slice — the single source of truth is types.ts. */
export type ChilltextConfig = Config["concierge"]["chilltext"];

/** A chilled message may not exceed this length (chilltext's own bubble contract). */
const MAX_MESSAGE_CHARS = 2000;
/** `input`/`agentOutput` are truncated to this length before they leave the box. */
const MAX_FIELD_CHARS = 6000;
/** A bypass candidate this short is treated as a bare ack ("ok", "on it") — not worth chilling. */
const SHORT_ACK_CHARS = 8;

/** A trimmed string that is nothing but one URL (chilltext would only mangle it). */
const BARE_URL_RE = /^https?:\/\/\S+$/i;

export interface ChillTransformInput {
  /** The user's triggering message, when one is known (recommended by the contract, not required). */
  input?: string;
  /** The normal assistant reply to rewrite. Required — this is what gets chilled. */
  agentOutput: string;
  /**
   * Per-call system prompt for a caller whose rewrite is not "Beckett talking in a channel" (the
   * social lane's X-post pass). Omitted ⇒ {@link resolveSystemPrompt}'s persona-derived default.
   */
  system?: string;
  /**
   * Persona file the default voice is read from. Omitted ⇒ `<beckettDir>/persona.md`. Callers that
   * hold a Config pass its resolved `paths.personaFile`; tests point it at a scratch file.
   */
  personaPath?: string;
  /** Force one bubble instead of `cfg.max_bubbles` (the early-ack seam wants exactly one message). */
  single?: boolean;
}

export interface ChillTransformResult {
  /** 1–4 pre-sized bubbles, meant to be posted one after another — never rejoined. */
  messages: string[];
  /**
   * The `system` text this call actually sent, when it sent one. Echoed back (not just used to
   * build the POST) so a caller — `chill-gate.ts`'s prompt-scaffolding guard — can check a
   * returned bubble for a near-copy of the exact prompt THIS call sent, without re-resolving it
   * (a second resolution would re-read the persona file off disk and could, in principle, catch
   * that file mid-edit and disagree with what was actually sent). Omitted, not `undefined`, when
   * no `system` was sent, so a plain `{ messages }` result still round-trips through `toEqual`.
   */
  system?: string;
}

/**
 * The `system` field for one call, in precedence order:
 *
 *   1. `input.system` — a per-call prompt for a caller doing a different job (the social lane).
 *   2. `cfg.system_override` — the operator escape hatch. Empty by default and meant to stay that
 *      way; a non-empty value REPLACES the persona voice for every message, which is exactly the
 *      second-source-of-truth this module stopped having.
 *   3. the persona file — the normal path, and the only one that defines Beckett's voice.
 *
 * `undefined` (no persona file, or an explicit empty per-call prompt) means the field is omitted
 * and chilltext rewrites with its own default voice — degraded, never dropped.
 */
function resolveSystemPrompt(cfg: ChilltextConfig, input: ChillTransformInput): string | undefined {
  if (input.system !== undefined) return input.system || undefined;
  if (cfg.system_override) return cfg.system_override;
  return chillSystemPrompt(input.personaPath);
}

/**
 * POST `${cfg.url}/chill` and return the chilled bubbles, or `null` on ANY failure: non-2xx,
 * timeout, network error, malformed JSON, an empty `messages` array, or any bubble that (after
 * trim) is empty or exceeds chilltext's 2000-char message cap. Callers fall back to the original
 * text on `null` — this function never throws, so a caller never needs a try/catch of its own.
 */
export async function chillTransform(
  cfg: ChilltextConfig,
  input: ChillTransformInput,
  fetchFn: typeof fetch = fetch,
): Promise<ChillTransformResult | null> {
  try {
    const body: Record<string, unknown> = {
      agentOutput: input.agentOutput.slice(0, MAX_FIELD_CHARS),
      max_bubbles: cfg.max_bubbles,
    };
    if (input.input !== undefined) body.input = input.input.slice(0, MAX_FIELD_CHARS);
    const system = resolveSystemPrompt(cfg, input);
    if (system) body.system = system;
    if (input.single) body.single = true;

    const res = await fetchFn(`${cfg.url}/chill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeout_ms),
    });
    if (!res.ok) return null;

    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return null;
    const rawMessages = (data as { messages?: unknown }).messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null;

    const messages: string[] = [];
    for (const raw of rawMessages) {
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > MAX_MESSAGE_CHARS) return null;
      messages.push(trimmed);
    }
    return system ? { messages, system } : { messages };
  } catch {
    // Timeout (AbortSignal), network error, JSON parse failure — all the same fail-open outcome.
    return null;
  }
}

/**
 * True when `text` should skip chilltext entirely and post untouched: the capability is off, the
 * text carries a code fence (formatting chilltext would flatten), it's over the 6000-char field
 * cap chilltext accepts, or it's short enough to already read as a text message (a bare ack under
 * 8 chars, or a string that is nothing but a URL).
 */
export function shouldBypassChill(text: string, cfg: ChilltextConfig | undefined): boolean {
  if (!cfg?.enabled) return true;
  if (text.includes("```")) return true;
  if (text.length > MAX_FIELD_CHARS) return true;
  const trimmed = text.trim();
  if (trimmed.length < SHORT_ACK_CHARS) return true;
  if (BARE_URL_RE.test(trimmed)) return true;
  return false;
}
