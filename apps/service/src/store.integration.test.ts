import { randomUUID } from "node:crypto";
import type { TransactionCreatedEvent } from "@crosscode/protocol";
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
    } finally {
      if (workspaceId) {
        await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
        await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      }
      await store.close();
    }
  });
});

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
