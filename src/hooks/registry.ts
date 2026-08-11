/**
 * Beckett — Hook Registry (`src/hooks/registry.ts`)
 * =======================================================================================
 * Single source of truth for the claude hook settings written to each worker's
 * `<workspace>/.claude/settings.json`. Previously the scope-guard settings were built
 * by a hardcoded helper in scope-guard.ts and called directly from manager.ts; now every
 * hook (scope-guard + any future additions) flows through {@link renderClaudeSettings}.
 *
 * With only the scope-guard registered (the current baseline), output is byte-for-byte
 * identical to the old `scopeGuardSettings()` JSON. Adding hooks later is a one-liner.
 */

/** A single hook entry: one event, one optional tool matcher, one shell command. */
export interface HookSpec {
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit";
  /** Tool name pattern (passed as `matcher` to claude). Omit to match all tools. */
  matcher?: string;
  command: string;
}

/** The claude settings shape written to `<workspace>/.claude/settings.json`. */
export interface ClaudeHookSettings {
  hooks: Record<string, { matcher?: string; hooks: { type: "command"; command: string }[] }[]>;
  /** Top-level keys merged in from `extraSettings` (e.g. `crossSessionInbound`). */
  [key: string]: unknown;
}

/**
 * Render a list of {@link HookSpec}s into the claude settings object. Specs sharing the
 * same event + matcher are collapsed into one entry (claude de-dupes by matcher, but being
 * explicit avoids surprises). Order within an event is preserved.
 *
 * `extraSettings` (optional) is merged in at the TOP LEVEL alongside `hooks` — e.g.
 * `{"crossSessionInbound": "accept"}` so an unattended `-p` worker/session can take cross-session
 * messages (Claude Code ≥2.1.224) instead of holding or dropping them. It must not carry a
 * `hooks` key of its own — the rendered hook table always wins, so a `hooks` key in
 * `extraSettings` is dropped rather than silently clobbering the real one.
 */
export function renderClaudeSettings(
  specs: HookSpec[],
  extraSettings?: Record<string, unknown>,
): ClaudeHookSettings {
  const byEvent = new Map<string, { matcher?: string; hooks: { type: "command"; command: string }[] }[]>();

  for (const spec of specs) {
    if (!byEvent.has(spec.event)) byEvent.set(spec.event, []);
    const entries = byEvent.get(spec.event)!;

    // Try to find an existing entry with the same matcher to coalesce into.
    const existing = entries.find((e) => e.matcher === spec.matcher);
    if (existing) {
      existing.hooks.push({ type: "command", command: spec.command });
    } else {
      const entry: { matcher?: string; hooks: { type: "command"; command: string }[] } = {
        hooks: [{ type: "command", command: spec.command }],
      };
      if (spec.matcher !== undefined) entry.matcher = spec.matcher;
      entries.push(entry);
    }
  }

  // extraSettings first so the real `hooks` key (added last) always wins over a same-named key.
  const { hooks: _ignoredHooksKey, ...safeExtra } = extraSettings ?? {};
  return { ...safeExtra, hooks: Object.fromEntries(byEvent) };
}
