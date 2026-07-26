import { describe, expect, it } from "vitest";
import { issueAccessToken, verifyAccessToken, type AccessClaims } from "./auth.js";
import { hashCanonicalPayload, hashCredential, verifyCredential } from "./crypto.js";
import { assertSafeServiceBinding } from "./http.js";
import { safePoolConfig } from "./store.js";

const claims: AccessClaims = {
  memberId: "member-1",
  actorId: "actor-1",
  workspaceId: "workspace-1",
  replicaId: "replica-1",
  role: "member",
  tokenVersion: 1
};

describe("service security primitives", () => {
  it("issues and verifies only HS256 access tokens with the configured secret", async () => {
    const signingCredential = "a-secure-test-secret-with-at-least-32-bytes";
    const alternateCredential = "another-secure-secret-with-at-least-32-bytes";
    const token = await issueAccessToken(claims, signingCredential);
    await expect(verifyAccessToken(token, signingCredential)).resolves.toEqual(claims);
    await expect(verifyAccessToken(token, alternateCredential)).rejects.toThrow();
  });

  it("hashes replica credentials and compares canonical payloads", async () => {
    const hash = await hashCredential("replica-secret");
    await expect(verifyCredential("replica-secret", hash)).resolves.toBe(true);
    await expect(verifyCredential("wrong-secret", hash)).resolves.toBe(false);
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
