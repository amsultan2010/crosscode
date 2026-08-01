import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import type { PgStore } from "../../service/src/index.js";

/**
 * Test-only fabrication of a Supabase-shaped access token and a provisioned workspace
 * member, for Postgres integration tests that need a valid identity but have no real
 * Supabase Auth project to sign against. The service only verifies the JWT's signature,
 * issuer, audience, and subject (see apps/service/src/auth.ts) -- it never calls out to
 * Supabase itself -- so a locally-signed token with the same shared secret is sufficient.
 */
export const TEST_SUPABASE_URL = "https://test.supabase.co";
export const TEST_JWT_SECRET = "daemon-integration-test-secret-with-at-least-32-bytes";

export type TestPrincipal = {
  workspaceId: string;
  actorId: string;
  replicaId: string;
  role: "owner" | "member" | "viewer";
};

export async function fabricateSupabaseAccessToken(
  userId: string,
  jwtSecret: string = TEST_JWT_SECRET,
  supabaseUrl: string = TEST_SUPABASE_URL,
  ttlSeconds = 3_600
): Promise<{ accessToken: string; expiresAt: string }> {
  const issuer = `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + ttlSeconds;
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(expiresAtSeconds)
    .sign(new TextEncoder().encode(jwtSecret));
  return { accessToken, expiresAt: new Date(expiresAtSeconds * 1_000).toISOString() };
}

/**
 * Provisions (or joins) a workspace member directly through the store -- standing in for
 * an admin using the Supabase service_role key in production -- registers a replica for
 * them, and signs a matching access token. Pass workspaceId to join an existing workspace
 * as a non-owner member; omit it to create a new workspace with this member as owner.
 */
export async function provisionTestPrincipal(
  store: PgStore,
  input: { workspaceId?: string; workspaceName?: string; actorId: string; role?: "member" | "viewer"; replicaName?: string }
): Promise<{ principal: TestPrincipal; accessToken: string; expiresAt: string }> {
  const userId = randomUUID();
  let workspaceId = input.workspaceId;
  let role: TestPrincipal["role"] = "owner";
  if (workspaceId) {
    role = input.role ?? "member";
    await store.addMember({ workspaceId, userId, actorId: input.actorId, role });
  } else {
    const admin = await store.provisionAdmin({ workspaceName: input.workspaceName ?? `test-workspace-${randomUUID()}`, userId, actorId: input.actorId });
    workspaceId = admin.workspaceId;
  }
  const replica = await store.registerReplica(userId, workspaceId, input.replicaName ?? `${input.actorId}-replica`);
  const { accessToken, expiresAt } = await fabricateSupabaseAccessToken(userId);
  return { principal: { workspaceId, actorId: input.actorId, replicaId: replica.replicaId, role }, accessToken, expiresAt };
}
