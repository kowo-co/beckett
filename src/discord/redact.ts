/**
 * Beckett — generic outbound secret redaction (`src/discord/redact.ts`)
 * =======================================================================================
 * One deterministic text pass that strips credential-shaped values before they cross into a
 * Discord message. It started as a browser-agent-only helper (`redactBrowserSecrets`, now
 * re-exported from `../concierge/index.ts` for its existing callers/tests) for prose a page or a
 * model writes — LABEL-based: "Password: xyz", "generated api key is xyz", `{"token":"xyz"}`.
 *
 * The live-progress terminal window (`../progress/terminal-window.ts`) reuses this on a second
 * kind of text: raw shell/tool-journal lines, which speak in VALUE SHAPES rather than prose
 * labels — `export GITHUB_TOKEN=ghp_…`, `Authorization: Bearer eyJ…`. Neither pass needs to know
 * what the real secret IS; both only recognize the shapes credentials take, so a false positive
 * (redacting a harmless `PRIMARY_KEY=1`) is an acceptable cost against the alternative of a
 * leaked one.
 */

/** Human-written labels a secret is introduced by ("password:", "generated api key is", …). */
const LABEL = "password|passcode|one[- ]time code|otp|recovery code|backup code|api key|access token|secret|token|credentials?|login details";

/**
 * The original browser-summary redactor (unchanged): prose-shaped secrets introduced by a
 * human-readable label, plus URL-embedded credentials and `key=value` query params.
 */
function redactLabelledSecrets(text: string): string {
  const withoutUrlCredentials = text
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:password|passcode|otp|token|secret|api[_-]?key)=)[^&#\s]*/gi, "$1[redacted]");
  const jsonValues = withoutUrlCredentials.replace(
    new RegExp(`(["'](?:${LABEL})["']\\s*:\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`, "gi"),
    "$1\"[redacted]\"",
  );
  const lines = jsonValues.split("\n");
  const labelOnly = new RegExp(`^(?:generated\\s+)?(?:${LABEL})\\b\\s*(?:(?:is|was)|[:=])?\\s*$`, "i");
  const labelledValue = new RegExp(`\\b((?:${LABEL}))\\b(\\s*(?:(?:is|was)|[:=])\\s*).*$`, "i");
  const generatedValue = new RegExp(`\\b(generated\\s+(?:${LABEL}))\\b(\\s+).*$`, "i");
  const createdCredentials = /\b(credentials?\s+created)\b(\s*:\s*).*$/i;
  let redactNextValue = false;
  return lines.map((line) => {
    if (redactNextValue) {
      if (!line.trim()) return line;
      redactNextValue = false;
      return `${line.match(/^\s*/)?.[0] ?? ""}[redacted]`;
    }
    const normalizedLabel = line
      .trim()
      .replace(/^(?:(?:[-+*]|\d+[.)])\s+|[>#]+\s*)+/, "")
      .replace(/^[*_~`]+|[*_~`]+$/g, "")
      .trim();
    if (labelOnly.test(normalizedLabel)) {
      redactNextValue = true;
      return `${line.trimEnd()} [redacted]`;
    }
    const explicit = line.replace(
      labelledValue,
      (_match, credentialLabel: string, separator: string) => `${credentialLabel}${separator}[redacted]`,
    );
    if (explicit !== line) return explicit;
    const generated = line.replace(
      generatedValue,
      (_match, credentialLabel: string, separator: string) => `${credentialLabel}${separator}[redacted]`,
    );
    if (generated !== line) return generated;
    return line.replace(
      createdCredentials,
      (_match, credentialLabel: string, separator: string) => `${credentialLabel}${separator}[redacted]`,
    );
  }).join("\n");
}

/** `export FOO_API_KEY=…`, `GITHUB_TOKEN="…"` — an env-var NAME that names its own secrecy. */
const ENV_ASSIGNMENT_RE =
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)(=)("[^"]*"|'[^']*'|\S+)/g;

/** `Authorization: Bearer …` / bare `Bearer …` — the HTTP auth-header shape. */
const BEARER_RE = /\b((?:Authorization:\s*)?Bearer)\s+[A-Za-z0-9._-]{8,}/gi;

/** Recognizable provider-token prefixes and JWT's three-dot shape — high-confidence regardless of context. */
const TOKEN_PREFIX_RE =
  /\b(?:sk-[A-Za-z0-9_-]{10,}|gh[oprsu]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;

/** The value-shape pass: catches what a terminal line says WITHOUT a human-written label. */
function redactValueShapes(text: string): string {
  return text
    .replace(ENV_ASSIGNMENT_RE, (_match, name: string) => `${name}=[redacted]`)
    .replace(BEARER_RE, (_match, prefix: string) => `${prefix} [redacted]`)
    .replace(TOKEN_PREFIX_RE, "[redacted]");
}

/**
 * Redact credential-shaped content from arbitrary text before it reaches Discord — both the
 * label-based pass (prose) and the value-shape pass (shell/journal text). Order matters only in
 * that value-shapes runs second, over text the label pass already touched, so it can still catch
 * a raw token sitting right next to an already-redacted labelled one.
 */
export function redactSecrets(text: string): string {
  return redactValueShapes(redactLabelledSecrets(text));
}
