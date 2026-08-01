import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgStore } from "./store.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL retention pruning", () => {
  it("prunes only audit_events and ended sessions past the retention window", async () => {
    const store = new PgStore(databaseUrl!);
    let workspaceId: string | undefined;
    try {
      await store.migrate();
      const userId = randomUUID();
      const provisioned = await store.provisionAdmin({
        workspaceName: `test-${randomUUID()}`,
        userId,
        actorId: `actor-${randomUUID()}@example.com`
      });
      workspaceId = provisioned.workspaceId;
      const replica = await store.registerReplica(userId, workspaceId, `replica-${randomUUID()}`);
      const replicaId = replica.replicaId;

      const oldAuditId = randomUUID();
      const recentAuditId = randomUUID();
      await store.pool.query(
        `INSERT INTO audit_events (id, workspace_id, action, details, created_at)
         VALUES ($1, $2, 'test.old', '{}'::jsonb, now() - interval '40 days')`,
        [oldAuditId, workspaceId]
      );
      await store.pool.query(
        `INSERT INTO audit_events (id, workspace_id, action, details, created_at)
         VALUES ($1, $2, 'test.recent', '{}'::jsonb, now() - interval '1 day')`,
        [recentAuditId, workspaceId]
      );

      const oldEndedSessionId = randomUUID();
      const recentEndedSessionId = randomUUID();
      const openOldSessionId = randomUUID();
      await store.pool.query(
        `INSERT INTO sessions (id, workspace_id, replica_id, started_at, ended_at)
         VALUES ($1, $2, $3, now() - interval '40 days', now() - interval '35 days')`,
        [oldEndedSessionId, workspaceId, replicaId]
      );
      await store.pool.query(
        `INSERT INTO sessions (id, workspace_id, replica_id, started_at, ended_at)
         VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '1 day')`,
        [recentEndedSessionId, workspaceId, replicaId]
      );
      await store.pool.query(
        `INSERT INTO sessions (id, workspace_id, replica_id, started_at, ended_at)
         VALUES ($1, $2, $3, now() - interval '40 days', NULL)`,
        [openOldSessionId, workspaceId, replicaId]
      );

      const auditDeleted = await store.pruneAuditEvents(30);
      const sessionsDeleted = await store.pruneEndedSessions(30);
      expect(auditDeleted).toBeGreaterThanOrEqual(1);
      expect(sessionsDeleted).toBe(1);

      const remainingAudit = await store.pool.query<{ id: string }>(
        "SELECT id FROM audit_events WHERE workspace_id = $1", [workspaceId]
      );
      const remainingAuditIds = remainingAudit.rows.map((row) => row.id);
      expect(remainingAuditIds).not.toContain(oldAuditId);
      expect(remainingAuditIds).toContain(recentAuditId);

      const remainingSessions = await store.pool.query<{ id: string }>(
        "SELECT id FROM sessions WHERE workspace_id = $1", [workspaceId]
      );
      const remainingSessionIds = remainingSessions.rows.map((row) => row.id);
      expect(remainingSessionIds).not.toContain(oldEndedSessionId);
      expect(remainingSessionIds).toContain(recentEndedSessionId);
      expect(remainingSessionIds).toContain(openOldSessionId);
    } finally {
      if (workspaceId) {
        await store.pool.query("DELETE FROM sessions WHERE workspace_id = $1", [workspaceId]);
        await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
        await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      }
      await store.close();
    }
  });

  it("rejects non-positive or non-integer olderThanDays", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await expect(store.pruneAuditEvents(0)).rejects.toThrow();
      await expect(store.pruneAuditEvents(-5)).rejects.toThrow();
      await expect(store.pruneAuditEvents(1.5)).rejects.toThrow();
      await expect(store.pruneEndedSessions(0)).rejects.toThrow();
      await expect(store.pruneEndedSessions(-5)).rejects.toThrow();
      await expect(store.pruneEndedSessions(1.5)).rejects.toThrow();
    } finally {
      await store.close();
    }
  });
});
