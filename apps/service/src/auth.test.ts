import { describe, expect, it } from "vitest";
import { verifySupabaseAccessToken } from "./auth.js";
import { hashCanonicalPayload } from "./crypto.js";
import { assertSafeServiceBinding } from "./http.js";
import { safePoolConfig } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";

describe("service security primitives", () => {
  it("verifies only ES256 Supabase-issued access tokens for the configured project's JWKS", async () => {
    const jwks = await testSupabaseJwks();
    const token = await signTestSupabaseToken(supabaseUrl, { sub: "user-1", email: "member@example.com" });
    const claims = await verifySupabaseAccessToken(token, jwks, supabaseUrl);
    expect(claims.userId).toBe("user-1");
    expect(claims.email).toBe("member@example.com");

    const wrongIssuer = await signTestSupabaseToken(supabaseUrl, { iss: "https://impostor.supabase.co/auth/v1" });
    await expect(verifySupabaseAccessToken(wrongIssuer, jwks, supabaseUrl)).rejects.toThrow();

    const wrongAudience = await signTestSupabaseToken(supabaseUrl, { aud: "anon" });
    await expect(verifySupabaseAccessToken(wrongAudience, jwks, supabaseUrl)).rejects.toThrow();
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
