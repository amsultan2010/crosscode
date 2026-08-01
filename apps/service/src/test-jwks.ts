import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";

/**
 * Test-only stand-in for a real Supabase project's JWKS: generates one ES256 keypair
 * per test process (Supabase's default signing algorithm for new projects) and exposes
 * both a local JWTVerifyGetKey (for verifySupabaseAccessToken, in place of fetching a
 * real project's remote JWKS endpoint) and a signer that mimics what Supabase Auth
 * actually issues.
 */
let cached: { privateKey: CryptoKey; jwks: JWTVerifyGetKey } | undefined;

async function keys(): Promise<{ privateKey: CryptoKey; jwks: JWTVerifyGetKey }> {
  if (!cached) {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.alg = "ES256";
    jwk.use = "sig";
    jwk.kid = "test-key";
    cached = { privateKey: privateKey as CryptoKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
  }
  return cached;
}

export async function testSupabaseJwks(): Promise<JWTVerifyGetKey> {
  return (await keys()).jwks;
}

export async function signTestSupabaseToken(
  supabaseUrl: string,
  overrides: { sub?: string; email?: string; aud?: string; iss?: string; ttl?: string } = {}
): Promise<string> {
  const { privateKey } = await keys();
  return new SignJWT({
    email: overrides.email ?? "member@example.com",
    role: "authenticated"
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "test-key" })
    .setSubject(overrides.sub ?? "user-1")
    .setIssuer(overrides.iss ?? `${supabaseUrl.replace(/\/$/, "")}/auth/v1`)
    .setAudience(overrides.aud ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(overrides.ttl ?? "15m")
    .sign(privateKey);
}
