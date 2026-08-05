import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** The GitHub account behind a Supabase identity. Absent when the user signed in some other way. */
export type GitHubIdentity = {
  /** GitHub's numeric account id, as a string. Stable across username changes. */
  id: string;
  login: string;
};

export type SupabaseAccessClaims = {
  userId: string;
  email: string | undefined;
  github: GitHubIdentity | undefined;
  expiresAt: string;
};

/**
 * Supabase projects sign access tokens with an asymmetric key (ES256 by default for
 * new projects) discoverable via their JWKS endpoint, not a static shared secret.
 * createRemoteJWKSet caches fetched keys and handles rotation on its own, so build
 * one per project URL and reuse it across requests rather than per-verification.
 */
export function createSupabaseJwks(supabaseUrl: string): JWTVerifyGetKey {
  const normalized = supabaseUrl.replace(/\/$/, "");
  return createRemoteJWKSet(new URL(`${normalized}/auth/v1/.well-known/jwks.json`));
}

export async function verifySupabaseAccessToken(
  token: string,
  jwks: JWTVerifyGetKey,
  supabaseUrl: string
): Promise<SupabaseAccessClaims> {
  const issuer = `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: "authenticated"
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Access token subject is invalid");
  }
  if (typeof payload.exp !== "number") throw new Error("Access token is missing an expiration");
  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    github: gitHubIdentity(payload as Record<string, unknown>),
    expiresAt: new Date(payload.exp * 1_000).toISOString()
  };
}

/**
 * The GitHub account out of a *verified* token's claims.
 *
 * Supabase copies the provider's profile into `user_metadata` at sign-in and records which
 * provider issued the identity in `app_metadata`. Both are inside the signed payload, so
 * reading them costs no round-trip -- but only after jwtVerify has run, because
 * `user_metadata` is otherwise user-writable through the Supabase client.
 *
 * Returns undefined unless GitHub is actually the provider, so a token from some other
 * sign-in method can never present itself as a GitHub account.
 */
function gitHubIdentity(payload: Record<string, unknown>): GitHubIdentity | undefined {
  const appMetadata = asRecord(payload.app_metadata);
  const providers = [
    typeof appMetadata?.provider === "string" ? appMetadata.provider : undefined,
    ...(Array.isArray(appMetadata?.providers) ? appMetadata.providers : [])
  ];
  if (!providers.includes("github")) return undefined;
  const metadata = asRecord(payload.user_metadata);
  if (!metadata) return undefined;
  const id = metadata.provider_id ?? metadata.sub;
  const login = metadata.user_name ?? metadata.preferred_username;
  if ((typeof id !== "string" && typeof id !== "number") || typeof login !== "string" || login.length === 0) return undefined;
  return { id: String(id), login };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

/**
 * Answers "can this person see `owner/repo` on GitHub?", which is the one question invite
 * redemption turns on: a Crosscode room carries a repository's working tree, so anybody
 * who cannot already read the repository must not be able to join it with a leaked code.
 *
 * Asked of GitHub with the *invitee's* own OAuth token, because that is the only thing
 * that can answer it -- the service holds no installation credential, and a check made
 * with anyone else's token would answer for the wrong person. GitHub returns 404 rather
 * than 403 for a private repository a token cannot see, so "not found" is a denial here
 * and not an error.
 */
export type RepoAccessChecker = (githubToken: string, repo: string) => Promise<boolean>;

export const checkGitHubRepoAccess: RepoAccessChecker = async (githubToken, repo) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "crosscode-service"
    }
  });
  if (response.status === 200) return true;
  if (response.status === 401 || response.status === 403 || response.status === 404) return false;
  throw new Error(`GitHub repository access check failed with status ${response.status}`);
};
