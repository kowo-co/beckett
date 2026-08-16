/**
 * Beckett — the browser write door (`src/browser/secret-sink.ts`)
 * =================================================================
 * A model-authored `betterwright_browser` script can already READ a keychain entry as `secrets.*`
 * (see {@link ../browser/agent.ts!evalSecrets}). This module is the missing WRITE side: it lets a
 * script hand a value it just minted (an OAuth token, a freshly-set password) back to the daemon
 * so it lands in jingle — without the value ever crossing the model's transcript.
 *
 * The primitive is `secrets.save(field, value)`, a function injected into the script preamble
 * exactly like the read-only `secrets.<field>` values. An MCP tool argument would put the value in
 * the transcript; a function captured inside the sandboxed script body never does. The carrier back
 * to the daemon is the script's own return value, wrapped in a host-authored envelope
 * (`__beckettEnvelope`) that the daemon unwraps and strips before anything reaches the model.
 *
 * Pure module, no I/O — deliberately unit-testable without a browser or a jingle process.
 */

/** One value a script asked the host to persist. Never logged, never returned to the model. */
export interface SecretSaveRequest {
  field: string;
  value: string;
}

/** What the daemon reports back to the model about one save. Carries NO value. */
export interface SecretSaveReceipt {
  field: string;
  entry: string;
  ok: boolean;
  error?: string;
}

/** Hard cap on how many `secrets.save` calls one script may make. */
export const MAX_SAVES_PER_EVAL = 4;
/** Hard cap on the length of one saved value. */
export const MAX_SECRET_VALUE_CHARS = 8_192;
/** A jingle field name: lowercase-ish token, starting alphanumeric, up to 64 chars. */
export const SECRET_FIELD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Wrap one model-authored script so it exposes `secrets` (its read-only values plus `save`) and
 * returns a host envelope instead of a bare result. `code` keeps its own `return`/top-level-await
 * semantics because it becomes the body of an async IIFE nested inside the wrapper.
 *
 * The in-script guards on `save` (field shape, non-empty, length, per-eval cap) are ergonomics
 * only — a fast, readable error inside the model's own tool result. The daemon-side
 * `BrowserAgent.saveSecret` re-validates everything before it ever touches jingle; nothing here is
 * trusted as a security boundary.
 */
export function wrapEvalWithSecretSink(code: string, values: Record<string, string>): string {
  const json = JSON.stringify(values);
  return `const secrets = Object.freeze({
  ...${json},
  save: (field, value) => {
    if (typeof field !== "string" || !${SECRET_FIELD_RE.toString()}.test(field)) {
      throw new Error("secrets.save needs a field name like \\"hf_token\\"");
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("secrets.save needs a non-empty string value");
    }
    if (value.length > ${MAX_SECRET_VALUE_CHARS}) {
      throw new Error("secrets.save value is too long");
    }
    if (__beckettSaves.length >= ${MAX_SAVES_PER_EVAL}) {
      throw new Error("secrets.save is limited to ${MAX_SAVES_PER_EVAL} saves per script");
    }
    __beckettSaves.push({ field, value });
    return { saved: field, chars: value.length };
  },
});
const __beckettSaves = [];
const __beckettResult = await (async () => {
${code}
})();
return { __beckettEnvelope: 1, result: __beckettResult, saves: __beckettSaves };`;
}

/**
 * Validate one candidate save request. Returns null (dropped, never thrown) when the field name or
 * value shape is invalid — a malformed request from a wrapped script must never fail the whole
 * eval.
 */
function validateSave(candidate: unknown): SecretSaveRequest | null {
  if (!candidate || typeof candidate !== "object") return null;
  const field = (candidate as { field?: unknown }).field;
  const value = (candidate as { value?: unknown }).value;
  if (typeof field !== "string" || !SECRET_FIELD_RE.test(field)) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_VALUE_CHARS) return null;
  return { field, value };
}

/**
 * Parse the host envelope back out of an eval's raw return value. A non-envelope value (an older
 * script, or a wrap that never ran) passes through untouched with `saves: []`. Every save request
 * is re-validated and the list is capped at {@link MAX_SAVES_PER_EVAL} — the in-script guards are
 * ergonomics, not trust.
 */
export function readSecretEnvelope(value: unknown): { result: unknown; saves: SecretSaveRequest[] } {
  if (
    value &&
    typeof value === "object" &&
    (value as { __beckettEnvelope?: unknown }).__beckettEnvelope === 1
  ) {
    const envelope = value as { result: unknown; saves?: unknown };
    const rawSaves = Array.isArray(envelope.saves) ? envelope.saves : [];
    const saves: SecretSaveRequest[] = [];
    for (const candidate of rawSaves) {
      if (saves.length >= MAX_SAVES_PER_EVAL) break;
      const validated = validateSave(candidate);
      if (validated) saves.push(validated);
    }
    return { result: envelope.result, saves };
  }
  return { result: value, saves: [] };
}
