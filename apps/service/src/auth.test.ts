import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifySupabaseAccessToken } from "./auth.js";
import { hashCanonicalPayload } from "./crypto.js";
import { assertSafeServiceBinding } from "./http.js";
import { safePoolConfig } from "./store.js";

const jwtSecret = "a-secure-test-secret-with-at-least-32-bytes";
const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function signSupabaseToken(overrides: {
  sub?: string; email?: string; aud?: string; iss?: string; secret?: string;
} = {}): Promise<string> {
  return new SignJWT({
    email: overrides.email ?? "member@example.com",
    role: "authenticated"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(overrides.sub ?? "user-1")
    .setIssuer(overrides.iss ?? `${supabaseUrl}/auth/v1`)
    .setAudience(overrides.aud ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key(overrides.secret ?? jwtSecret));
}

describe("service security primitives", () => {
  it("verifies only HS256 Supabase-issued access tokens for the configured project", async () => {
    const token = await signSupabaseToken({ sub: "user-1", email: "member@example.com" });
    const claims = await verifySupabaseAccessToken(token, jwtSecret, supabaseUrl);
    expect(claims.userId).toBe("user-1");
    expect(claims.email).toBe("member@example.com");

    const alternateSecret = "another-secure-secret-with-at-least-32-bytes";
    await expect(verifySupabaseAccessToken(token, alternateSecret, supabaseUrl)).rejects.toThrow();

    const wrongIssuer = await signSupabaseToken({ iss: "https://impostor.supabase.co/auth/v1" });
    await expect(verifySupabaseAccessToken(wrongIssuer, jwtSecret, supabaseUrl)).rejects.toThrow();

    const wrongAudience = await signSupabaseToken({ aud: "anon" });
    await expect(verifySupabaseAccessToken(wrongAudience, jwtSecret, supabaseUrl)).rejects.toThrow();
  });

  it("hashes canonical payloads for content-addressed comparisons", () => {
    expect(hashCanonicalPayload({ b: 2, a: 1 })).toBe(hashCanonicalPayload({ a: 1, b: 2 }));
  });

  it("requires TLS for non-loopback bindings", () => {
    expect(() => assertSafeServiceBinding("127.0.0.1", false)).not.toThrow();
    expect(() => assertSafeServiceBinding("::1", false)).not.toThrow();
    expect(() => assertSafeServiceBinding("0.0.0.0", false)).toThrow(/TLS/);
    expect(() => assertSafeServiceBinding("0.0.0.0", true)).not.toThrow();
    expect(() => safePoolConfig("postgresql://user:pass@db.example.com/app")).toThrow(/verify-full/);
    expect(() => safePoolConfig("postgresql://user:pass@127.0.0.1/app?host=db.example.com&sslmode=verify-full&sslmode=disable")).toThrow();
    expect(safePoolConfig("postgresql://user:pass@db.example.com/app?sslmode=verify-full")).toMatchObject({ ssl: { rejectUnauthorized: true } });
  });
});
