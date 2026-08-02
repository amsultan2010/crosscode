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
      // assertReplicaOwnership returns the replica's project id; this replica has none.
      await expect(store.assertReplicaOwnership(workspaceId, membership.memberId, replica.replicaId)).resolves.toBeNull();

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

  it("upserts projects idempotently, falls back to the repo root, and isolates them per workspace", async () => {
    const store = new PgStore(databaseUrl!);
    const workspaceIds: string[] = [];
    try {
      await store.migrate();
      const ownerUserId = randomUUID();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: ownerUserId, actorId: `owner-${randomUUID()}@example.com` });
      const other = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      workspaceIds.push(owner.workspaceId, other.workspaceId);

      // Idempotency: the same repository reported twice -- in two different spellings, from
      // two different checkouts -- must collapse onto one row.
      const remote = `git@github.com:acme/${randomUUID()}.git`;
      const first = await store.upsertProject(owner.workspaceId, { repoRemote: remote, repoRoot: "/Users/a/repo" });
      const second = await store.upsertProject(owner.workspaceId, { repoRemote: remote, repoRoot: "/Users/a/repo" });
      const third = await store.upsertProject(owner.workspaceId, {
        repoRemote: remote.replace("git@github.com:", "https://user:token@GitHub.com/"), repoRoot: "/Users/b/repo"
      });
      expect(second!.id).toBe(first!.id);
      expect(third!.id).toBe(first!.id);
      expect(third!.repoRemote).toBe(first!.repoRemote);
      // The advisory repo_root tracks the most recent reporter.
      expect(third!.repoRoot).toBe("/Users/b/repo");
      expect((await store.listProjects(owner.workspaceId)).filter((p) => p.id === first!.id)).toHaveLength(1);

      // Fallback keying: a checkout with no remote is keyed by its absolute repo root, and
      // two different rootless checkouts must not collide on NULL.
      const rootA = `/Users/dev/${randomUUID()}`;
      const rootB = `/Users/dev/${randomUUID()}`;
      const local = await store.upsertProject(owner.workspaceId, { repoRoot: `${rootA}/` });
      const localAgain = await store.upsertProject(owner.workspaceId, { repoRoot: rootA });
      const otherLocal = await store.upsertProject(owner.workspaceId, { repoRoot: rootB });
      expect(localAgain!.id).toBe(local!.id);
      expect(local!.repoRemote).toBeNull();
      expect(local!.repoRoot).toBe(rootA);
      expect(otherLocal!.id).not.toBe(local!.id);

      // Nothing usable to key on yields no project rather than an unaddressable row.
      expect(await store.upsertProject(owner.workspaceId, {})).toBeNull();
      expect(await store.upsertProject(owner.workspaceId, { repoRoot: "relative/path", repoRemote: "  " })).toBeNull();

      // Cross-workspace isolation: the same remote in another workspace is a separate
      // project, and neither workspace can read the other's by id.
      const twin = await store.upsertProject(other.workspaceId, { repoRemote: remote, repoRoot: "/Users/a/repo" });
      expect(twin!.id).not.toBe(first!.id);
      expect(await store.getProject(owner.workspaceId, first!.id)).toMatchObject({ id: first!.id });
      expect(await store.getProject(other.workspaceId, first!.id)).toBeNull();
      expect(await store.getProject(owner.workspaceId, twin!.id)).toBeNull();
      expect((await store.listProjects(other.workspaceId)).map((p) => p.id)).not.toContain(first!.id);

      // Registering a replica with a repository attributes both the replica and every
      // operation it later sends to the matching project.
      const registered = await store.registerReplica(
        ownerUserId, owner.workspaceId, `replica-${randomUUID()}`, { repoRemote: remote, repoRoot: "/Users/a/repo" }
      );
      expect(registered.projectId).toBe(first!.id);
      const membership = await store.resolveMembership(ownerUserId, owner.workspaceId);
      const operationId = randomUUID();
      const operationEvent = makeEvent(membership, registered.replicaId, operationId, 1);
      await store.appendOperation(membership, operationEvent);
      const attributed = await store.pool.query<{ project_id: string | null }>(
        "SELECT project_id FROM operations WHERE workspace_id = $1 AND id = $2", [owner.workspaceId, operationId]
      );
      expect(attributed.rows[0]?.project_id).toBe(first!.id);

      // The column being right is not enough -- the read paths a consumer uses have to
      // return it. This asserts on what listOperations/listPresence hand back, which is
      // what GET /v1/operations and GET /v1/presence serialize verbatim.
      const listed = (await store.listOperations(owner.workspaceId, 0, 100)).items.find((item) => item.id === operationId);
      expect(listed?.projectId).toBe(first!.id);
      // The same value must survive the write path's own return, since that object is
      // what gets broadcast over the WebSocket immediately after ingest.
      const reingested = await store.appendOperation(membership, operationEvent);
      expect(reingested.projectId).toBe(first!.id);
      expect(await store.assertReplicaOwnership(owner.workspaceId, membership.memberId, registered.replicaId)).toBe(first!.id);

      await store.recordSessionStart(owner.workspaceId, registered.replicaId, 0);
      const presence = await store.listPresence(owner.workspaceId);
      expect(presence.find((session) => session.replicaId === registered.replicaId)?.projectId).toBe(first!.id);
      // A replica registered without a repository stays null, not undefined -- consumers
      // group those under "Unassigned".
      const bare = await store.registerReplica(ownerUserId, owner.workspaceId, `replica-${randomUUID()}`);
      const bareSession = (await store.listPresence(owner.workspaceId)).find((session) => session.replicaId === bare.replicaId);
      expect(bareSession).toBeDefined();
      expect(bareSession!.projectId).toBeNull();

      // attachReplicaToProject is the seam the pairing claim handler calls: it registers a
      // replica without repository information, then attributes it in one call afterwards.
      const paired = await store.registerReplica(ownerUserId, owner.workspaceId, `replica-${randomUUID()}`);
      expect(paired.projectId).toBeNull();
      expect(await store.attachReplicaToProject(owner.workspaceId, paired.replicaId, { repoRemote: remote })).toBe(first!.id);
      expect(await store.attachReplicaToProject(owner.workspaceId, paired.replicaId, {})).toBeNull();
      const linked = await store.pool.query<{ project_id: string | null }>(
        "SELECT project_id FROM replicas WHERE id = $1", [paired.replicaId]
      );
      expect(linked.rows[0]?.project_id).toBe(first!.id);
    } finally {
      for (const workspaceId of workspaceIds) {
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
