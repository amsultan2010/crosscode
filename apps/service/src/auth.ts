import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type SupabaseAccessClaims = {
  userId: string;
  email: string | undefined;
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
    expiresAt: new Date(payload.exp * 1_000).toISOString()
  };
}
