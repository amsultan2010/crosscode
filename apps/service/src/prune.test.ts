import { randomUUID } from "node:crypto";
import type { TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { describe, expect, it } from "vitest";
import { PgStore, type Membership } from "./store.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

type TestWorkspace = { workspaceId: string; membership: Membership; replicaId: string };

async function freshWorkspace(store: PgStore): Promise<TestWorkspace> {
  await store.migrate();
  const userId = randomUUID();
  const { workspaceId } = await store.provisionAdmin({
    workspaceName: `test-${randomUUID()}`, userId, actorId: `owner-${randomUUID()}@example.com`
  });
  const membership = await store.resolveMembership(userId, workspaceId);
  const replica = await store.registerReplica(userId, workspaceId, `replica-${randomUUID()}`);
  return { workspaceId, membership, replicaId: replica.replicaId };
}

function makeEvent(workspace: TestWorkspace, id: string, clientSequence: number): TransactionCreatedEvent {
  return {
    id,
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    replicaId: workspace.replicaId,
    actorId: workspace.membership.actorId,
    type: "transaction.created",
    clientSequence,
    createdAt: new Date().toISOString(),
    payload: {
      id,
      base: { files: [] },
      changes: [{ path: `src/${id}.ts`, kind: "add", afterContent: "content", afterHash: contentHash("content") }],
      provenance: { source: "filesystem", confidence: "known" },
      safety: { risk: "low", requiresApproval: false }
    }
  };
}

async function cleanup(store: PgStore, workspaceIds: readonly string[]): Promise<void> {
  for (const workspaceId of workspaceIds) {
    await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
    await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  }
}

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

  // The two halves of retention: it has to actually delete, and it has to leave behind
  // enough state that a replica reading the history can tell "deleted" from "nothing new".
  it("deletes operations outside the plan's window, per plan, and records the watermark", async () => {
    const store = new PgStore(databaseUrl!);
    const free = await freshWorkspace(store);
    const paid = await freshWorkspace(store);
    try {
      await store.pool.query("UPDATE workspaces SET plan = 'unlimited' WHERE id = $1", [paid.workspaceId]);
      for (const workspace of [free, paid]) {
        for (let clientSequence = 1; clientSequence <= 3; clientSequence += 1) {
          await store.appendOperation(workspace.membership, makeEvent(workspace, randomUUID(), clientSequence));
        }
        // The first two operations are 40 days old: outside free's 7-day window, inside
        // unlimited's 365-day one.
        await store.pool.query(
          "UPDATE operations SET created_at = now() - interval '40 days' WHERE workspace_id = $1 AND server_sequence <= 2",
          [workspace.workspaceId]
        );
      }

      const swept = await store.pruneOperationsByRetention();
      const freeResult = swept.find((result) => result.workspaceId === free.workspaceId)!;
      const paidResult = swept.find((result) => result.workspaceId === paid.workspaceId)!;

      expect(freeResult).toMatchObject({ plan: "free", retentionDays: 7, deleted: 2, prunedThrough: 2 });
      // Same rows, same age, different plan: retention is the plan's window, not a constant.
      expect(paidResult).toMatchObject({ plan: "unlimited", retentionDays: 365, deleted: 0, prunedThrough: 0 });

      const remaining = await store.pool.query<{ server_sequence: string }>(
        "SELECT server_sequence FROM operations WHERE workspace_id = $1 ORDER BY server_sequence",
        [free.workspaceId]
      );
      expect(remaining.rows.map((row) => Number(row.server_sequence))).toEqual([3]);
      // operation_files is the per-path index into an operation, so it must not outlive it.
      const orphanedFiles = await store.pool.query<{ count: string }>(
        "SELECT count(*) FROM operation_files WHERE workspace_id = $1", [free.workspaceId]
      );
      expect(Number(orphanedFiles.rows[0]!.count)).toBe(1);
      const watermark = await store.pool.query<{ operations_pruned_through: string }>(
        "SELECT operations_pruned_through FROM workspaces WHERE id = $1", [free.workspaceId]
      );
      expect(Number(watermark.rows[0]!.operations_pruned_through)).toBe(2);

      // A cursor at or above the watermark is still served completely -- pruning takes a
      // prefix, so nothing above it is missing.
      const servable = await store.listOperations(free.workspaceId, 2, 100);
      expect(servable.status === "ok" && servable.items.map((item) => item.serverSequence)).toEqual([3]);

      // Sweeping again is a no-op, and never walks the watermark backwards.
      const second = await store.pruneOperationsByRetention();
      expect(second.find((result) => result.workspaceId === free.workspaceId)).toMatchObject({ deleted: 0, prunedThrough: 2 });
    } finally {
      await cleanup(store, [free.workspaceId, paid.workspaceId]);
      await store.close();
    }
  });

  // Where retention meets the billing lifecycle. Retention shipped sweeping against the
  // workspace's *current* plan, which meant a downgrade retroactively deleted history the
  // workspace had already been promised -- the one thing BUILD_INSTRUCTIONS.md Phase 10 says
  // a downgrade must never do. Each row now carries the window it was written under.
  it("keeps history a downgrade already promised, and still deletes it once its own window passes", async () => {
    const store = new PgStore(databaseUrl!);
    const workspace = await freshWorkspace(store);
    try {
      await store.pool.query("UPDATE workspaces SET plan = 'pro' WHERE id = $1", [workspace.workspaceId]);
      for (let clientSequence = 1; clientSequence <= 2; clientSequence += 1) {
        await store.appendOperation(workspace.membership, makeEvent(workspace, randomUUID(), clientSequence));
      }
      // They downgrade to essential, whose window is 30 days.
      await store.pool.query("UPDATE workspaces SET plan = 'essential' WHERE id = $1", [workspace.workspaceId]);
      await store.appendOperation(workspace.membership, makeEvent(workspace, randomUUID(), 3));

      const stamped = await store.pool.query<{ retention_days: number }>(
        "SELECT retention_days FROM operations WHERE workspace_id = $1 ORDER BY server_sequence",
        [workspace.workspaceId]
      );
      expect(stamped.rows.map((row) => row.retention_days)).toEqual([90, 90, 30]);

      // Everything is now 40 days old: past essential's 30-day window, well inside the
      // 90-day one the first two were written under.
      await store.pool.query(
        "UPDATE operations SET created_at = now() - interval '40 days' WHERE workspace_id = $1",
        [workspace.workspaceId]
      );

      const swept = await store.pruneOperationsByRetention();

      // Sweeping on the current plan would have deleted all three. Nothing goes: the first
      // two are still inside their own window, and the third sits above them, so deleting it
      // would break the prefix the watermark promises readers.
      expect(swept.find((result) => result.workspaceId === workspace.workspaceId))
        .toMatchObject({ plan: "essential", deleted: 0, prunedThrough: 0 });
      const kept = await store.pool.query<{ count: string }>(
        "SELECT count(*) FROM operations WHERE workspace_id = $1", [workspace.workspaceId]
      );
      expect(Number(kept.rows[0]!.count)).toBe(3);

      // Not a leak, just a deferral: once the older rows pass their own 90 days, the whole
      // expired prefix goes.
      await store.pool.query(
        "UPDATE operations SET created_at = now() - interval '100 days' WHERE workspace_id = $1",
        [workspace.workspaceId]
      );
      const later = await store.pruneOperationsByRetention();
      expect(later.find((result) => result.workspaceId === workspace.workspaceId))
        .toMatchObject({ deleted: 3, prunedThrough: 3 });
    } finally {
      await cleanup(store, [workspace.workspaceId]);
      await store.close();
    }
  });

  // The regression this exists for: a replica reconnects by asking for everything after its
  // last-known server_sequence, so an empty answer means "you are caught up". Once retention
  // deletes rows below that cursor, a plain age-based DELETE makes those two situations
  // produce byte-identical responses -- the replica silently loses every proposal in the
  // deleted range and never errors. The watermark is what keeps them distinguishable.
  it("answers a cursor that fell off the retention window with a resync, not a truncated list", async () => {
    const store = new PgStore(databaseUrl!);
    const workspace = await freshWorkspace(store);
    try {
      for (let clientSequence = 1; clientSequence <= 3; clientSequence += 1) {
        await store.appendOperation(workspace.membership, makeEvent(workspace, randomUUID(), clientSequence));
      }
      // A replica that got as far as sequence 1 and then went offline for a month.
      const replicaCursor = 1;
      await store.pool.query(
        "UPDATE operations SET created_at = now() - interval '40 days' WHERE workspace_id = $1", [workspace.workspaceId]
      );
      const swept = await store.pruneOperationsByRetention();
      expect(swept.find((result) => result.workspaceId === workspace.workspaceId)).toMatchObject({ deleted: 3, prunedThrough: 3 });

      // What the naive implementation would have served this replica: an empty list, which
      // is exactly what it also receives when it is genuinely up to date.
      const naive = await store.pool.query(
        "SELECT id FROM operations WHERE workspace_id = $1 AND server_sequence > $2",
        [workspace.workspaceId, replicaCursor]
      );
      expect(naive.rows).toHaveLength(0);

      // What it is served instead.
      const page = await store.listOperations(workspace.workspaceId, replicaCursor, 100);
      expect(page).toEqual({ status: "cursor-too-old", resyncFrom: 3, retentionDays: 7 });
      // Including the case where the cursor is 0 -- a brand-new replica reading a history
      // whose beginning is gone is the same problem.
      expect(await store.listOperations(workspace.workspaceId, 0, 100)).toMatchObject({ status: "cursor-too-old" });
      // And the resync cursor it is handed is one the service can actually answer.
      expect(await store.listOperations(workspace.workspaceId, 3, 100)).toEqual({
        status: "ok", items: [], nextCursor: 3, hasMore: false
      });
    } finally {
      await cleanup(store, [workspace.workspaceId]);
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
