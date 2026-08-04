import { randomUUID } from "node:crypto";
import type { TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { describe, expect, it } from "vitest";
import { startRetentionSweep } from "./retention.js";
import { PgStore, type RetentionSweepResult } from "./store.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("scheduled retention sweep", () => {
  // Retention that only runs when an admin remembers to run it is retention that does not
  // run. This is the wiring that makes it happen on its own.
  it("prunes on its own as soon as it starts, and stops cleanly", async () => {
    const store = new PgStore(databaseUrl!);
    await store.migrate();
    const userId = randomUUID();
    const { workspaceId } = await store.provisionAdmin({
      workspaceName: `test-${randomUUID()}`, userId, actorId: `owner-${randomUUID()}@example.com`
    });
    const membership = await store.resolveMembership(userId, workspaceId);
    const replica = await store.registerReplica(userId, workspaceId, `replica-${randomUUID()}`);
    const operationId = randomUUID();
    const event: TransactionCreatedEvent = {
      id: operationId,
      schemaVersion: 1,
      workspaceId,
      replicaId: replica.replicaId,
      actorId: membership.actorId,
      type: "transaction.created",
      clientSequence: 1,
      createdAt: new Date().toISOString(),
      payload: {
        id: operationId,
        base: { files: [] },
        changes: [{ path: "src/a.ts", kind: "add", afterContent: "content", afterHash: contentHash("content") }],
        provenance: { source: "filesystem", confidence: "known" },
        safety: { risk: "low", requiresApproval: false }
      }
    };
    await store.appendOperation(membership, event);
    await store.pool.query("UPDATE operations SET created_at = now() - interval '40 days' WHERE workspace_id = $1", [workspaceId]);

    let report: (results: readonly RetentionSweepResult[]) => void = () => {};
    const swept = new Promise<readonly RetentionSweepResult[]>((resolve) => { report = resolve; });
    const errors: unknown[] = [];
    // An hour-long interval: what is under test is that the sweep runs at startup rather
    // than only on its first tick.
    const sweep = startRetentionSweep({ databaseUrl: databaseUrl!, intervalMs: 3_600_000, onSwept: report, onError: (error) => errors.push(error) });
    try {
      const results = await swept;
      expect(errors).toEqual([]);
      expect(results.find((result) => result.workspaceId === workspaceId)).toMatchObject({ plan: "free", deleted: 1, prunedThrough: 1 });
      const remaining = await store.pool.query("SELECT id FROM operations WHERE workspace_id = $1", [workspaceId]);
      expect(remaining.rows).toHaveLength(0);
    } finally {
      await sweep.stop();
      await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
      await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await store.close();
    }
  });
});
