type GitHubIdentityConfig = { identity?: { github_user?: string } };
type GitHubEnv = Record<string, string | undefined>;

export interface GitHubTarget {
  /** Login Beckett's work is attributed to (`beckett[bot]`). Organizations are not valid here. */
  account: string;
  /** Account or organization that owns Beckett-managed project repositories. */
  owner: string;
}

/** Resolve the credential identity and project owner without letting their fallbacks diverge. */
export function resolveGitHubTarget(
  config: GitHubIdentityConfig,
  env: GitHubEnv = process.env,
): GitHubTarget {
  const configuredAccount = config.identity?.github_user?.trim();
  const account = env.GITHUB_ACCOUNT?.trim() || configuredAccount;
  if (!account) {
    throw new Error(
      "GitHub account is not configured — set GITHUB_ACCOUNT or identity.github_user in config.toml",
    );
  }
  const owner = env.BECKETT_GH_ORG?.trim() || account;
  return { account, owner };
}

/** Resolve the login Beckett authenticates/attributes as. */
export function resolveGitHubAccount(
  config: GitHubIdentityConfig,
  env: GitHubEnv = process.env,
): string {
  return resolveGitHubTarget(config, env).account;
}

/** Resolve the GitHub account/org that owns Beckett-managed project repositories. */
export function resolveGitHubOwner(
  config: GitHubIdentityConfig,
  env: GitHubEnv = process.env,
): string {
  return resolveGitHubTarget(config, env).owner;
}

/** The one project slug that targets Beckett's OWN source repo — kept in sync with `src/cli/core.ts`. */
export function selfProjectSlug(env: GitHubEnv = process.env): string {
  return (env.BECKETT_SELF_PROJECT?.trim() || "beckett").toLowerCase();
}

/**
 * Owner of Beckett's OWN source repo. It was transferred from `0xbeckett` to `kowo-co` (#114); the
 * GitHub REST API 301s the old path without following it, so every `gh` call must target the new
 * owner. Overridable via `BECKETT_SELF_PROJECT_OWNER` for a differently-hosted self-repo.
 */
export function resolveSelfProjectOwner(env: GitHubEnv = process.env): string {
  return env.BECKETT_SELF_PROJECT_OWNER?.trim() || "kowo-co";
}

/**
 * Resolve the GitHub owner for a SPECIFIC project slug. Beckett's self-project moved to `kowo-co`
 * (#114) while every other managed repo still lives under the default owner, so the beckett slug
 * gets a per-project override and all others fall through to {@link resolveGitHubOwner}.
 */
export function resolveProjectOwner(
  slug: string,
  config: GitHubIdentityConfig,
  env: GitHubEnv = process.env,
): string {
  if (slug.trim().toLowerCase() === selfProjectSlug(env)) return resolveSelfProjectOwner(env);
  return resolveGitHubOwner(config, env);
}
