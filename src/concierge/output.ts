/**
 * The only model terminal values that may cross into Discord delivery.
 *
 * Claude's structured-output schema produces this object separately from any assistant text
 * blocks. Those blocks may contain scratch work and are deliberately never interpreted as a
 * Discord message.
 */
export type DiscordTurnOutput =
  | { decision: "send"; message: string }
  | { decision: "pass"; message: null };

/**
 * Schema passed to `claude --json-schema` for every persistent concierge turn.
 *
 * The API requires a top-level `type: "object"` on a tool input schema — a bare `oneOf` is
 * rejected with a 400 on EVERY turn, which the fail-closed parser below turns into permanent
 * silence. The send/pass cross-field invariants (send ⇒ non-empty string, pass ⇒ null) are
 * enforced by {@link parseDiscordTurnOutput} instead.
 */
export const DISCORD_TURN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["send", "pass"] },
    voice_check: {
      type: "string",
      description:
        "One short line stating how the message you are about to write honors the persona voice " +
        "rules. Empty string when decision is \"pass\".",
    },
    message: { type: ["string", "null"] },
  },
  required: ["decision", "voice_check", "message"],
  additionalProperties: false,
} as const;

/** Strictly validate the CLI's `structured_output`; malformed output fails closed. */
export function parseDiscordTurnOutput(value: unknown): DiscordTurnOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  const keys = Object.keys(output);
  if (
    keys.length !== 3 ||
    !keys.includes("decision") ||
    !keys.includes("voice_check") ||
    !keys.includes("message")
  )
    return null;
  if (typeof output.voice_check !== "string") return null;
  if (output.decision === "send" && typeof output.message === "string" && output.message.trim()) {
    return { decision: "send", message: output.message.trim() };
  }
  if (output.decision === "pass" && output.message === null) return { decision: "pass", message: null };
  return null;
}

/**
 * Compatibility for old injected test doubles only. Real ConciergeSession instances always return
 * `DiscordTurnOutput`; untyped fakes predate that contract. Keeping this at the pool boundary
 * prevents it from ever seeing Claude assistant text in production.
 */
export function coerceDiscordTurnOutput(value: unknown): DiscordTurnOutput {
  const structured = parseDiscordTurnOutput(value);
  if (structured) return structured;
  if (typeof value !== "string") return { decision: "pass", message: null };
  const message = value.trim();
  return message ? { decision: "send", message } : { decision: "pass", message: null };
}
