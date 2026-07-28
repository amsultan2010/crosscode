import { randomUUID } from "node:crypto";
import { EPOCH_CURSOR, type HandoffRequestedEvent, type IntentPublishedEvent, type TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { describe, expect, it } from "vitest";
import { StoreConflictError, PgStore } from "./store.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL service store", () => {
  it("enrolls once and sequences exact event retries idempotently", async () => {
    const store = new PgStore(databaseUrl!);
    let workspaceId: string | undefined;
    try {
      await store.migrate();
      await expect(store.assertRuntimePrivileges()).rejects.toThrow("least-privilege runtime role");
      const provisioned = await store.provisionAdmin({
        workspaceName: `test-${randomUUID()}`,
        actorId: `actor-${randomUUID()}`
      });
      workspaceId = provisioned.workspaceId;
      const enrolled = await store.enroll({ enrollmentToken: provisioned.enrollmentToken });
      await expect(store.enroll({ enrollmentToken: provisioned.enrollmentToken })).rejects.toThrow();
      const event = makeEvent(enrolled.claims, randomUUID(), 1);
      const first = await store.appendOperation(enrolled.claims, event);
      const retry = await store.appendOperation(enrolled.claims, event);
      expect(retry.serverSequence).toBe(first.serverSequence);
      expect((await store.listOperations(provisioned.workspaceId, 0, 100)).items).toHaveLength(1);
      await expect(store.appendOperation(enrolled.claims, makeEvent(enrolled.claims, randomUUID(), 1)))
        .rejects.toBeInstanceOf(StoreConflictError);

      const handoffId = randomUUID();
      const handoffEvent = makeHandoffEvent(enrolled.claims, handoffId);
      const upsertedHandoff = await store.upsertHandoff(enrolled.claims, handoffEvent);
      expect(upsertedHandoff.handoff.id).toBe(handoffId);
      const handoffPage = await store.listHandoffs(provisioned.workspaceId, EPOCH_CURSOR, 100);
      expect(handoffPage.items.map((item) => item.handoff.id)).toContain(handoffId);

      const intentId = randomUUID();
      const intentEvent = makeIntentEvent(enrolled.claims, intentId);
      const upsertedIntent = await store.upsertIntent(enrolled.claims, intentEvent);
      expect(upsertedIntent.intent.id).toBe(intentId);
      const intentPage = await store.listIntents(provisioned.workspaceId, EPOCH_CURSOR, 100);
      expect(intentPage.items.map((item) => item.intent.id)).toContain(intentId);

      await store.recordSessionStart(provisioned.workspaceId, enrolled.claims.replicaId);
      const active = await store.listActiveSessions(provisioned.workspaceId);
      expect(active.map((session) => session.replicaId)).toContain(enrolled.claims.replicaId);
      await store.recordSessionEnd(provisioned.workspaceId, enrolled.claims.replicaId);
      const afterEnd = await store.listActiveSessions(provisioned.workspaceId);
      expect(afterEnd.map((session) => session.replicaId)).not.toContain(enrolled.claims.replicaId);
    } finally {
      if (workspaceId) {
        await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
        await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      }
      await store.close();
    }
  });
});

function makeHandoffEvent(
  claims: { workspaceId: string; replicaId: string; actorId: string },
  id: string
): HandoffRequestedEvent {
  return {
    id,
    schemaVersion: 1,
    workspaceId: claims.workspaceId,
    replicaId: claims.replicaId,
    actorId: claims.actorId,
    type: "handoff.requested",
    clientSequence: 1,
    createdAt: new Date().toISOString(),
    payload: { id, operationId: "operation-1", requestedBy: claims.actorId, status: "pending", createdAt: new Date().toISOString() }
  };
}

function makeIntentEvent(
  claims: { workspaceId: string; replicaId: string; actorId: string },
  id: string
): IntentPublishedEvent {
  return {
    id,
    schemaVersion: 1,
    workspaceId: claims.workspaceId,
    replicaId: claims.replicaId,
    actorId: claims.actorId,
    type: "intent.published",
    clientSequence: 1,
    createdAt: new Date().toISOString(),
    payload: { id, actorId: claims.actorId, text: "Rename foo to bar", createdAt: new Date().toISOString() }
  };
}

function makeEvent(
  claims: { workspaceId: string; replicaId: string; actorId: string },
  id: string,
  clientSequence: number
): TransactionCreatedEvent {
  return {
    id,
    schemaVersion: 1,
    workspaceId: claims.workspaceId,
    replicaId: claims.replicaId,
    actorId: claims.actorId,
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
