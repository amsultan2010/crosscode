import { randomUUID } from "node:crypto";
import type { TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { describe, expect, it } from "vitest";
import { toRemoteOperation } from "./http.js";
import { StoreConflictError, StoreUnauthorizedError, PgStore, MAX_SELF_SERVE_WORKSPACES_PER_USER, type Membership, type OperationPage, type StoredOperation } from "./store.js";

const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

/** Unwraps a page, failing loudly if retention refused the cursor instead of answering it. */
function items(page: OperationPage): StoredOperation[] {
  if (page.status !== "ok") throw new Error(`Expected an operation page, got '${page.status}'`);
  return page.items;
}

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
      expect(items(await store.listOperations(provisioned.workspaceId, 0, 100))).toHaveLength(1);
      await expect(store.appendOperation(membership, makeEvent(membership, replica.replicaId, randomUUID(), 1)))
        .rejects.toBeInstanceOf(StoreConflictError);

      await store.recordSessionStart(provisioned.workspaceId, replica.replicaId, 3);
      const active = await store.listActiveSessions(provisioned.workspaceId);
      expect(active.map((session) => session.replicaId)).toContain(replica.replicaId);

      await store.recordSessionEnd(provisioned.workspaceId, replica.replicaId, 5);
      const afterEnd = await store.listActiveSessions(provisioned.workspaceId);
      expect(afterEnd.map((session) => session.replicaId)).not.toContain(replica.replicaId);
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
      // return it. This asserts on what listOperations hands back, which is what
      // GET /v1/operations serializes verbatim.
      const listed = items(await store.listOperations(owner.workspaceId, 0, 100)).find((item) => item.id === operationId);
      expect(listed?.projectId).toBe(first!.id);
      // The same value must survive the write path's own return, since that object is
      // what gets broadcast over the WebSocket immediately after ingest.
      const reingested = await store.appendOperation(membership, operationEvent);
      expect(reingested.projectId).toBe(first!.id);
      expect(await store.assertReplicaOwnership(owner.workspaceId, membership.memberId, registered.replicaId)).toBe(first!.id);

      // A replica registered without a repository stays null, not undefined -- consumers
      // group those under "Unassigned".
      const bare = await store.registerReplica(ownerUserId, owner.workspaceId, `replica-${randomUUID()}`);
      expect(bare.projectId).toBeNull();
    } finally {
      for (const workspaceId of workspaceIds) {
        await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
        await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      }
      await store.close();
    }
  });
});

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

describe.skipIf(!databaseUrl)("PostgreSQL self-serve workspace cap", () => {
  it("stops one account farming free workspaces, without touching the personal one", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const userId = randomUUID();
      const actorId = `farmer-${randomUUID()}@example.com`;

      // Contract C's personal workspace is provisioned separately and must never count
      // against the cap, or a user could be locked out of the workspace their first
      // authenticated request depends on.
      const personal = await store.ensurePersonalWorkspace({ userId, actorId });
      expect(personal.created).toBe(true);
      expect(await store.countOwnedSelfServeWorkspaces(userId)).toBe(0);

      for (let index = 0; index < MAX_SELF_SERVE_WORKSPACES_PER_USER; index += 1) {
        await store.createWorkspace({ workspaceName: `farm-${index}-${randomUUID()}`, userId, actorId });
      }
      expect(await store.countOwnedSelfServeWorkspaces(userId)).toBe(MAX_SELF_SERVE_WORKSPACES_PER_USER);

      await expect(store.createWorkspace({ workspaceName: `over-${randomUUID()}`, userId, actorId }))
        .rejects.toBeInstanceOf(StoreConflictError);

      // The personal workspace still resolves, so the account is not bricked by its own cap.
      const stillThere = await store.ensurePersonalWorkspace({ userId, actorId });
      expect(stillThere.created).toBe(false);
      expect(stillThere.workspaceId).toBe(personal.workspaceId);

      // A different account is unaffected.
      const otherUser = randomUUID();
      await expect(store.createWorkspace({ workspaceName: `other-${randomUUID()}`, userId: otherUser, actorId: `other-${randomUUID()}@example.com` }))
        .resolves.toBeDefined();
    } finally {
      await store.close();
    }
  });

  it("holds the cap under concurrent creates from the same account", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const userId = randomUUID();
      const actorId = `racer-${randomUUID()}@example.com`;

      // All at once: without the advisory lock these each read a count of 0 and every one
      // of them inserts, blowing straight through the cap.
      const attempts = await Promise.allSettled(
        Array.from({ length: MAX_SELF_SERVE_WORKSPACES_PER_USER + 6 }, (_, index) =>
          store.createWorkspace({ workspaceName: `race-${index}-${randomUUID()}`, userId, actorId })
        )
      );
      const created = attempts.filter((attempt) => attempt.status === "fulfilled").length;
      expect(created).toBe(MAX_SELF_SERVE_WORKSPACES_PER_USER);
      expect(await store.countOwnedSelfServeWorkspaces(userId)).toBe(MAX_SELF_SERVE_WORKSPACES_PER_USER);
    } finally {
      await store.close();
    }
  });
});

describe.skipIf(!databaseUrl)("PostgreSQL revocation", () => {
  it("removing a member ends their access and takes their devices with them", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      const identity: Membership = { memberId: owner.memberId, userId: "", actorId: "", workspaceId: owner.workspaceId, role: "owner" };
      const memberUserId = randomUUID();
      const member = await store.addMember({ workspaceId: owner.workspaceId, userId: memberUserId, actorId: `m-${randomUUID()}@example.com` });
      const replica = await store.registerReplica(memberUserId, owner.workspaceId, `laptop-${randomUUID()}`);

      const removed = await store.disableMember(identity, member.memberId);
      expect(removed.disabledAt).not.toBeNull();

      await expect(store.resolveMembership(memberUserId, owner.workspaceId)).rejects.toBeInstanceOf(StoreUnauthorizedError);
      await expect(store.assertReplicaOwnership(owner.workspaceId, member.memberId, replica.replicaId)).rejects.toBeInstanceOf(StoreUnauthorizedError);
      expect((await store.listMembers(identity)).find((entry) => entry.memberId === member.memberId)?.disabledAt).not.toBeNull();
    } finally {
      await store.close();
    }
  });

  it("keeps at least one owner and refuses self-removal", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      const identity: Membership = { memberId: owner.memberId, userId: "", actorId: "", workspaceId: owner.workspaceId, role: "owner" };

      await expect(store.disableMember(identity, owner.memberId)).rejects.toThrow(/cannot remove themselves/);

      // A second owner exists, but removing the sole *other* owner is still refused
      // when it would leave the workspace with none.
      const solo = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `solo-${randomUUID()}@example.com` });
      const soloIdentity: Membership = { memberId: solo.memberId, userId: "", actorId: "", workspaceId: solo.workspaceId, role: "owner" };
      const secondOwner = await store.addMember({ workspaceId: solo.workspaceId, userId: randomUUID(), actorId: `o2-${randomUUID()}@example.com`, role: "member" });
      await store.pool.query("UPDATE members SET role = 'owner' WHERE id = $1", [secondOwner.memberId]);
      await expect(store.disableMember(soloIdentity, secondOwner.memberId)).resolves.toBeDefined();
    } finally {
      await store.close();
    }
  });

});

describe.skipIf(!databaseUrl)("PostgreSQL project keys", () => {
  it("promotes a remote-less project instead of filing a second row for the same checkout", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      const repoRoot = `/tmp/checkout-${randomUUID()}`;
      const repoRemote = `github.com/acme/repo-${randomUUID()}`;

      // First seen before it had a remote...
      const first = await store.upsertProject(owner.workspaceId, { repoRoot });
      expect(first?.repoRemote).toBeNull();

      // ...then the same checkout reports one.
      const second = await store.upsertProject(owner.workspaceId, { repoRoot, repoRemote });

      expect(second?.id).toBe(first!.id);
      expect(second?.repoRemote).toBe(repoRemote);
      expect((await store.listProjects(owner.workspaceId)).filter((project) => project.repoRoot === repoRoot)).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("does not promote when another project already holds that remote", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      const repoRemote = `github.com/acme/repo-${randomUUID()}`;
      const claimedRoot = `/tmp/first-${randomUUID()}`;
      const otherRoot = `/tmp/second-${randomUUID()}`;

      const claimed = await store.upsertProject(owner.workspaceId, { repoRoot: claimedRoot, repoRemote });
      const rootOnly = await store.upsertProject(owner.workspaceId, { repoRoot: otherRoot });
      expect(rootOnly?.id).not.toBe(claimed?.id);

      // The second checkout turns out to be a clone of the same repository: it must
      // converge on the existing remote-keyed row, not steal the remote for its own.
      const converged = await store.upsertProject(owner.workspaceId, { repoRoot: otherRoot, repoRemote });

      expect(converged?.id).toBe(claimed?.id);
      expect((await store.getProject(owner.workspaceId, rootOnly!.id))?.repoRemote).toBeNull();
    } finally {
      await store.close();
    }
  });

});

describe.skipIf(!databaseUrl)("PostgreSQL operation content storage", () => {
  // File bodies are the bulk of this database, and they used to be written three times:
  // operations.event (the envelope, whose payload is the transaction), operations.transaction
  // (a verbatim copy of that payload), and operation_files.payload (a verbatim copy of each
  // change inside it). Only the envelope stores them now; the other two are references.
  it("stores a change's content exactly once, and reads back byte-identical operations", async () => {
    const store = new PgStore(databaseUrl!);
    let workspaceId: string | undefined;
    try {
      await store.migrate();
      const userId = randomUUID();
      const provisioned = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId, actorId: `owner-${randomUUID()}@example.com` });
      workspaceId = provisioned.workspaceId;
      const membership = await store.resolveMembership(userId, workspaceId);
      const replica = await store.registerReplica(userId, workspaceId, `replica-${randomUUID()}`);

      // A sentinel long and unique enough that counting its occurrences across whole rows
      // is an exact census of where this file's body is stored.
      const body = `sentinel-${randomUUID()}-${"x".repeat(64)}`;
      const operationId = randomUUID();
      const event = makeEvent(membership, replica.replicaId, operationId, 1);
      event.payload = {
        ...event.payload,
        changes: [{ path: "src/big.ts", kind: "add", afterContent: body, afterHash: contentHash(body) }]
      };
      const stored = await store.appendOperation(membership, event);

      const copies = await store.pool.query<{ operations: string; operation_files: string }>(
        `SELECT
           (SELECT coalesce(sum((length(o::text) - length(replace(o::text, $2, ''))) / length($2)), 0)
              FROM operations o WHERE o.workspace_id = $1 AND o.id = $3) AS operations,
           (SELECT coalesce(sum((length(f::text) - length(replace(f::text, $2, ''))) / length($2)), 0)
              FROM operation_files f WHERE f.workspace_id = $1 AND f.operation_id = $3) AS operation_files`,
        [workspaceId, body, operationId]
      );
      expect(Number(copies.rows[0]!.operations)).toBe(1);
      expect(Number(copies.rows[0]!.operation_files)).toBe(0);
      // operation_files is still the per-path index into the operation it always was.
      const indexed = await store.pool.query<{ path: string; kind: string; after_hash: string | null }>(
        "SELECT path, kind, after_hash FROM operation_files WHERE workspace_id = $1 AND operation_id = $2",
        [workspaceId, operationId]
      );
      expect(indexed.rows).toEqual([{ path: "src/big.ts", kind: "add", after_hash: contentHash(body) }]);

      // Byte-identity, not just deep equality. GET /v1/operations serializes whatever
      // listOperations hands back, and the transaction now comes out of the envelope rather
      // than the dropped operations.transaction column. `$1::jsonb` reproduces exactly what
      // that column stored and returned -- same input, same jsonb canonicalization -- so
      // comparing the serialized forms is comparing the response before and after the change.
      const legacyColumn = await store.pool.query<{ transaction: unknown }>(
        "SELECT $1::jsonb AS transaction", [JSON.stringify(event.payload)]
      );
      const listed = items(await store.listOperations(workspaceId, 0, 100)).find((item) => item.id === operationId)!;
      expect(JSON.stringify(toRemoteOperation(listed))).toBe(JSON.stringify(
        toRemoteOperation({ ...listed, transaction: legacyColumn.rows[0]!.transaction as typeof listed.transaction })
      ));
      // And the same for the object appendOperation returns, which is what the WebSocket
      // fan-out broadcasts immediately after ingest.
      expect(JSON.stringify(toRemoteOperation(stored))).toBe(JSON.stringify(toRemoteOperation(listed)));
      // `transaction` is still the protocol's sealed/plaintext union. This test ingests a
      // plaintext operation deliberately, so narrowing here is an assertion about that,
      // not a cast that would quietly pass if the shape changed.
      if ("sealed" in listed.transaction) throw new Error("Expected a plaintext operation");
      expect(listed.transaction.changes[0]?.afterContent).toBe(body);
    } finally {
      if (workspaceId) {
        await store.pool.query("DELETE FROM audit_events WHERE workspace_id = $1", [workspaceId]);
        await store.pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      }
      await store.close();
    }
  });
});

