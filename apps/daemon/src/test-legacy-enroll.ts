/**
 * TODO(Task 2): transitional bootstrap for reconnect/live-*.integration.test.ts.
 * apps/service still speaks the legacy /v1/enroll protocol in this worktree (Task 2's
 * Supabase-JWT + POST /v1/replicas rewrite hasn't landed yet), so these Postgres-backed
 * integration tests borrow the old enrollment endpoint just to obtain a valid access
 * token for CoordinationServiceClient's new session-based constructor. Replace this with
 * real Supabase test users + self-service registration once Task 2 lands.
 */
export async function legacyEnroll(url: string, token: string): Promise<{
  accessToken: string;
  expiresAt: string;
  principal: { workspaceId: string; actorId: string; replicaId: string; role: string };
}> {
  const response = await fetch(new URL("/v1/enroll", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  const envelope = await response.json() as { ok: boolean; data?: unknown; error?: string };
  if (!envelope.ok) throw new Error(`legacy enroll failed: ${envelope.error ?? "unknown error"}`);
  return envelope.data as { accessToken: string; expiresAt: string; principal: { workspaceId: string; actorId: string; replicaId: string; role: string } };
}
