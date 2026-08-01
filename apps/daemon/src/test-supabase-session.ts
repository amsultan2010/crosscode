import { randomUUID } from "node:crypto";
import type { PgStore } from "../../service/src/index.js";
import { signTestSupabaseToken, testSupabaseJwks } from "../../service/src/test-jwks.js";

/**
 * Test-only fabrication of a Supabase-shaped access token and a provisioned workspace
 * member, for Postgres integration tests that need a valid identity but have no real
 * Supabase Auth project to sign against. Delegates to apps/service/src/test-jwks.ts's
 * shared ES256 test keypair, matching what apps/service/src/auth.ts actually verifies
 * (Supabase signs with an asymmetric key, not a shared secret).
 */
export const TEST_SUPABASE_URL = "https://test.supabase.co";
export { testSupabaseJwks };

export type TestPrincipal = {
  workspaceId: string;
  actorId: string;
  replicaId: string;
  role: "owner" | "member" | "viewer";
};

export async function fabricateSupabaseAccessToken(
  userId: string,
  supabaseUrl: string = TEST_SUPABASE_URL,
  ttlSeconds = 3_600
): Promise<{ accessToken: string; expiresAt: string }> {
  const accessToken = await signTestSupabaseToken(supabaseUrl, { sub: userId, ttl: `${ttlSeconds}s` });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
  return { accessToken, expiresAt };
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
