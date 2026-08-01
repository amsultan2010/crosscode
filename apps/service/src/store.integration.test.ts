import { randomUUID } from "node:crypto";
import { EPOCH_CURSOR, type HandoffRequestedEvent, type IntentPublishedEvent, type TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { describe, expect, it } from "vitest";
import { StoreConflictError, StoreUnauthorizedError, PgStore, type Membership } from "./store.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL service store", () => {
  it("provisions a member, registers a replica, and sequences exact event retries idempotently", async () => {
    const store = new PgStore(databaseUrl!);
    const userId = randomUUID();
    let workspaceId: string | undefined;
    try {
      await store.migrate();
      await expect(store.assertRuntimePrivileges()).rejects.toThrow("least-privilege runtime role");
      const provisioned = await store.provisionAdmin({
        workspaceName: `test-${randomUUID()}`,
        userId,
        actorId: `owner-${randomUUID()}@example.com`
      });
      workspaceId = provisioned.workspaceId;

      const membership = await store.resolveMembership(userId, workspaceId);
      expect(membership.role).toBe("owner");
      await expect(store.resolveMembership(randomUUID(), workspaceId)).rejects.toBeInstanceOf(StoreUnauthorizedError);

      const replicaName = `replica-${randomUUID()}`;
      const replica = await store.registerReplica(userId, workspaceId, replicaName);
      await expect(store.registerReplica(userId, workspaceId, replicaName)).rejects.toBeInstanceOf(StoreConflictError);
      await expect(store.assertReplicaOwnership(workspaceId, randomUUID(), replica.replicaId)).rejects.toBeInstanceOf(StoreUnauthorizedError);
      await expect(store.assertReplicaOwnership(workspaceId, membership.memberId, replica.replicaId)).resolves.toBeUndefined();

      const event = makeEvent(membership, replica.replicaId, randomUUID(), 1);
      const first = await store.appendOperation(membership, event);
      const retry = await store.appendOperation(membership, event);
      expect(retry.serverSequence).toBe(first.serverSequence);
      expect((await store.listOperations(provisioned.workspaceId, 0, 100)).items).toHaveLength(1);
      await expect(store.appendOperation(membership, makeEvent(membership, replica.replicaId, randomUUID(), 1)))
        .rejects.toBeInstanceOf(StoreConflictError);

      const handoffId = randomUUID();
      const handoffEvent = makeHandoffEvent(membership, replica.replicaId, handoffId);
      const upsertedHandoff = await store.upsertHandoff(membership, handoffEvent);
      expect(upsertedHandoff.handoff.id).toBe(handoffId);
      const handoffPage = await store.listHandoffs(provisioned.workspaceId, EPOCH_CURSOR, 100);
      expect(handoffPage.items.map((item) => item.handoff.id)).toContain(handoffId);

      const intentId = randomUUID();
      const intentEvent = makeIntentEvent(membership, replica.replicaId, intentId);
      const upsertedIntent = await store.upsertIntent(membership, intentEvent);
      expect(upsertedIntent.intent.id).toBe(intentId);
      const intentPage = await store.listIntents(provisioned.workspaceId, EPOCH_CURSOR, 100);
      expect(intentPage.items.map((item) => item.intent.id)).toContain(intentId);

      await store.recordSessionStart(provisioned.workspaceId, replica.replicaId, 3);
      const active = await store.listActiveSessions(provisioned.workspaceId);
      expect(active.map((session) => session.replicaId)).toContain(replica.replicaId);
      const presenceWhileOnline = await store.listPresence(provisioned.workspaceId);
      expect(presenceWhileOnline).toContainEqual(
        expect.objectContaining({ replicaId: replica.replicaId, status: "online", cursor: 3 })
      );

      await store.recordSessionEnd(provisioned.workspaceId, replica.replicaId, 5);
      const afterEnd = await store.listActiveSessions(provisioned.workspaceId);
      expect(afterEnd.map((session) => session.replicaId)).not.toContain(replica.replicaId);

      // A durable summary (last-known cursor, replica identity, disconnect time) must remain
      // queryable through a freshly constructed store, standing in for a service restart: the
      // data lives in the sessions table, not in any in-process gateway state.
      const restarted = new PgStore(databaseUrl!);
      try {
        const presenceAfterRestart = await restarted.listPresence(provisioned.workspaceId);
        expect(presenceAfterRestart).toContainEqual(
          expect.objectContaining({ replicaId: replica.replicaId, status: "offline", cursor: 5 })
        );
      } finally {
        await restarted.close();
      }
    } finally {
      if (workspaceId) {
        await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
        await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      }
      await store.close();
    }
  });
});

function makeHandoffEvent(membership: Membership, replicaId: string, id: string): HandoffRequestedEvent {
  return {
    id,
    schemaVersion: 1,
    workspaceId: membership.workspaceId,
    replicaId,
    actorId: membership.actorId,
    type: "handoff.requested",
    clientSequence: 1,
    createdAt: new Date().toISOString(),
    payload: { id, operationId: "operation-1", requestedBy: membership.actorId, status: "pending", createdAt: new Date().toISOString() }
  };
}

function makeIntentEvent(membership: Membership, replicaId: string, id: string): IntentPublishedEvent {
  return {
    id,
    schemaVersion: 1,
    workspaceId: membership.workspaceId,
    replicaId,
    actorId: membership.actorId,
    type: "intent.published",
    clientSequence: 1,
    createdAt: new Date().toISOString(),
    payload: { id, actorId: membership.actorId, text: "Rename foo to bar", createdAt: new Date().toISOString() }
  };
}

function makeEvent(membership: Membership, replicaId: string, id: string, clientSequence: number): TransactionCreatedEvent {
  return {
    id,
    schemaVersion: 1,
    workspaceId: membership.workspaceId,
    replicaId,
    actorId: membership.actorId,
    type: "transaction.created",
    clientSequence,
    createdAt: new Date().toISOString(),
    payload: {
      id,
      base: { files: [] },
      changes: [{ path: "test.txt", kind: "add", afterContent: "test", afterHash: contentHash("test") }],
      provenance: { source: "filesystem", confidence: "known" },
      safety: { risk: "low", requiresApproval: false }
    }
  };
}
