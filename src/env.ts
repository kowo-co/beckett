/**
 * Beckett — child environment builder (`src/env.ts`)
 * =======================================================================================
 * ONE place that decides what a spawned harness child may see (issue #19 — this rule was
 * hand-copied six times across the tree, each copy stripping only two exact keys).
 *
 * Subscription auth ONLY (Spec 00 §4): Beckett drives `claude`/`codex`/`pi` through their
 * `~/.claude` / `~/.codex` / `~/.pi` logins, never an API key. Stripping by PREFIX closes the
 * holes the exact-key copies left open: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
 * `OPENAI_ORG_ID`, … would all silently redirect a child onto API billing or a foreign
 * endpoint. Harmless, needed vars that share a prefix go on the explicit allowlist.
 */

/**
 * Env-var prefixes a harness child must never inherit (API auth / endpoint overrides).
 *
 * `CURSOR_` is here for a different reason than the others. It is not about forcing subscription
 * auth — the cursor seat legitimately runs on an API key — it is about BLAST RADIUS: a claude,
 * codex, or pi worker has no business holding a credential for a harness it does not run, and
 * `childEnv` is a denylist (everything passes unless blocked), so without this line every worker
 * on the box would inherit it. `CursorDriver.buildChildEnv` re-injects `CURSOR_API_KEY` for the
 * one process that actually needs it (`./drivers/cursor.ts`).
 */
const FORBIDDEN_ENV_PREFIXES = ["ANTHROPIC_", "OPENAI_", "CLAUDE_CODE_", "CURSOR_"] as const;

/** Prefix-matched vars that are explicitly safe to pass through (none known today). */
const ALLOWED_ENV_KEYS = new Set<string>([]);

/** True when a child env must not inherit `key` (subscription-auth-only rule). */
export function isForbiddenEnvKey(key: string): boolean {
  if (ALLOWED_ENV_KEYS.has(key)) return false;
  return FORBIDDEN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Build a harness child's environment from the daemon's, with API-auth/endpoint overrides
 * stripped. `extra` lets a driver layer its own vars (e.g. pi's PATH prefix) on top.
 */
export function childEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!isForbiddenEnvKey(k)) env[k] = v;
  }
  return { ...env, ...extra };
}
