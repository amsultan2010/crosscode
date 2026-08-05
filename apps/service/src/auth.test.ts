import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGitHubRepoAccess, verifySupabaseAccessToken } from "./auth.js";
import { assertSafeServiceBinding } from "./http.js";
import { safePoolConfig } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("reads the GitHub identity out of a verified token, and only for a GitHub sign-in", async () => {
    const jwks = await testSupabaseJwks();
    const github = await signTestSupabaseToken(supabaseUrl, { github: { id: "4242", login: "octocat" } });
    expect((await verifySupabaseAccessToken(github, jwks, supabaseUrl)).github).toEqual({ id: "4242", login: "octocat" });

    // Metadata is user-writable through the Supabase client, so a token issued by another
    // provider must never present itself as a GitHub account however it is populated.
    const elsewhere = await signTestSupabaseToken(supabaseUrl, { provider: "email", github: { id: "1", login: "impostor" } });
    expect((await verifySupabaseAccessToken(elsewhere, jwks, supabaseUrl)).github).toBeUndefined();

    const incomplete = await signTestSupabaseToken(supabaseUrl, { github: null });
    expect((await verifySupabaseAccessToken(incomplete, jwks, supabaseUrl)).github).toBeUndefined();
  });

  it("treats a repository GitHub will not show the caller as no access", async () => {
    const statuses = new Map([["acme/app", 200], ["acme/private", 404], ["acme/forbidden", 403]]);
    vi.stubGlobal("fetch", async (url: string) => {
      const repo = url.replace("https://api.github.com/repos/", "");
      return new Response(null, { status: statuses.get(repo) ?? 500 });
    });
    expect(await checkGitHubRepoAccess("gho_x", "acme/app")).toBe(true);
    // 404 is what GitHub answers for a private repository a token cannot see: a denial.
    expect(await checkGitHubRepoAccess("gho_x", "acme/private")).toBe(false);
    expect(await checkGitHubRepoAccess("gho_x", "acme/forbidden")).toBe(false);
    expect(await checkGitHubRepoAccess("gho_x", "not-a-repo")).toBe(false);
    // An outage is not a denial, and must not quietly become one.
    await expect(checkGitHubRepoAccess("gho_x", "acme/down")).rejects.toThrow(/500/);
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
