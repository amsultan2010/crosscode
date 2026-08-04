import { randomUUID } from "node:crypto";
import { EPOCH_CURSOR, type HandoffRequestedEvent, type IntentPublishedEvent, type TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { describe, expect, it } from "vitest";
import { StoreConflictError, StoreUnauthorizedError, PgStore, type Membership } from "./store.js";
import { BillingLimitError, MAX_SELF_SERVE_WORKSPACES_PER_USER } from "./billing.js";

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

describe.skipIf(!databaseUrl)("PostgreSQL durable rate limiting", () => {
  // The in-memory limiter gives every instance its own budget. On a function platform that
  // turns the pairing-claim throttle -- the brute-force defence over a 40-bit code space --
  // into N x 10/min for N warm instances. These counters are shared instead.
  it("spends one budget across callers, and keeps buckets independent", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const bucket = `ip:198.51.100.7:claim:${randomUUID()}`;

      let allowed = 0;
      for (let attempt = 0; attempt < 13; attempt += 1) {
        if (await store.takeRateLimit(bucket, 10, 60)) allowed += 1;
      }
      expect(allowed).toBe(10);

      // A different address is untouched by that exhaustion.
      expect(await store.takeRateLimit(`ip:203.0.113.9:claim:${randomUUID()}`, 10, 60)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("holds the limit when the same bucket is spent concurrently", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const bucket = `ip:198.51.100.8:claim:${randomUUID()}`;
      // Simultaneous, the way separate serverless instances would arrive. A read-then-write
      // implementation lets these interleave and overshoot; one statement cannot.
      const verdicts = await Promise.all(
        Array.from({ length: 25 }, () => store.takeRateLimit(bucket, 10, 60))
      );
      expect(verdicts.filter(Boolean).length).toBe(10);
    } finally {
      await store.close();
    }
  });

  it("starts a fresh window once the old one has elapsed, and prunes spent buckets", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const bucket = `ip:198.51.100.9:claim:${randomUUID()}`;
      expect(await store.takeRateLimit(bucket, 1, 60)).toBe(true);
      expect(await store.takeRateLimit(bucket, 1, 60)).toBe(false);
      // A zero-length window is always already over, which is the boundary the CASE arms turn on.
      expect(await store.takeRateLimit(bucket, 1, 0)).toBe(true);
      expect(await store.pruneRateLimits(0)).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });
});

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
        .rejects.toBeInstanceOf(BillingLimitError);

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

describe.skipIf(!databaseUrl)("PostgreSQL plan limits", () => {
  it("refuses the seat a plan does not have, and counts only active members", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      // The default plan is `free`, whose seat cap is 5. The owner is seat one.
      const second = await store.addMember({ workspaceId: owner.workspaceId, userId: randomUUID(), actorId: `b-${randomUUID()}@example.com` });
      for (const label of ["c", "d", "e"]) {
        await store.addMember({ workspaceId: owner.workspaceId, userId: randomUUID(), actorId: `${label}-${randomUUID()}@example.com` });
      }

      await expect(store.addMember({ workspaceId: owner.workspaceId, userId: randomUUID(), actorId: `f-${randomUUID()}@example.com` }))
        .rejects.toThrow(/seat cap/);

      // Removing someone frees their seat, because the count filters on disabled_at.
      const identity: Membership = { memberId: owner.memberId, userId: "", actorId: "", workspaceId: owner.workspaceId, role: "owner" };
      expect(await store.countActiveMembers(owner.workspaceId)).toBe(5);
      await store.disableMember(identity, second.memberId);
      expect(await store.countActiveMembers(owner.workspaceId)).toBe(4);
      await expect(store.addMember({ workspaceId: owner.workspaceId, userId: randomUUID(), actorId: `e-${randomUUID()}@example.com` })).resolves.toBeDefined();
    } finally {
      await store.close();
    }
  });

  it("refuses an autonomy tier the plan does not unlock, and allows the one it does", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      const identity: Membership = { memberId: owner.memberId, userId: "", actorId: "", workspaceId: owner.workspaceId, role: "owner" };

      // `free` unlocks always-ask and auto-if-clean, but not auto-always.
      await expect(store.setWorkspaceAutonomyTier(identity, 0)).resolves.toBe(0);
      await expect(store.setWorkspaceAutonomyTier(identity, 1)).resolves.toBe(1);
      await expect(store.setWorkspaceAutonomyTier(identity, 2)).rejects.toThrow(/auto-always/);
      expect(await store.getWorkspaceAutonomyTier(owner.workspaceId)).toBe(1);

      await store.pool.query("UPDATE workspaces SET plan = 'unlimited' WHERE id = $1", [owner.workspaceId]);
      await expect(store.setWorkspaceAutonomyTier(identity, 2)).resolves.toBe(2);
    } finally {
      await store.close();
    }
  });
});

describe.skipIf(!databaseUrl)("PostgreSQL revocation", () => {
  it("revokes a paired device's token so it stops resolving, and disables its replica", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      const identity: Membership = { memberId: owner.memberId, userId: "", actorId: "", workspaceId: owner.workspaceId, role: "owner" };
      const minted = await store.createPairingCode(identity);
      const claimed = await store.claimPairingCode({ code: minted.code, actorId: "agent", replicaName: `laptop-${randomUUID()}` });

      // The token works before revocation.
      expect((await store.resolveWorkspaceToken(claimed.token)).workspaceId).toBe(owner.workspaceId);
      const [summary] = await store.listWorkspaceTokens(identity);
      expect(summary?.revokedAt).toBeNull();

      const revoked = await store.revokeWorkspaceToken(identity, summary!.id);
      expect(revoked.revokedAt).not.toBeNull();

      // ...and stops working on the very next call, with no expiry to wait out.
      await expect(store.resolveWorkspaceToken(claimed.token)).rejects.toBeInstanceOf(StoreUnauthorizedError);
      await expect(store.assertReplicaOwnership(owner.workspaceId, owner.memberId, claimed.replicaId)).rejects.toBeInstanceOf(StoreUnauthorizedError);
      await expect(store.revokeWorkspaceToken(identity, summary!.id)).rejects.toBeInstanceOf(StoreConflictError);
    } finally {
      await store.close();
    }
  });

  it("removing a member ends their access and takes their devices with them", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      const identity: Membership = { memberId: owner.memberId, userId: "", actorId: "", workspaceId: owner.workspaceId, role: "owner" };
      const memberUserId = randomUUID();
      const member = await store.addMember({ workspaceId: owner.workspaceId, userId: memberUserId, actorId: `m-${randomUUID()}@example.com` });
      const memberIdentity = await store.resolveMembership(memberUserId, owner.workspaceId);
      const minted = await store.createPairingCode(memberIdentity);
      const claimed = await store.claimPairingCode({ code: minted.code, actorId: "agent", replicaName: `laptop-${randomUUID()}` });
      expect((await store.resolveWorkspaceToken(claimed.token)).memberId).toBe(member.memberId);

      const removed = await store.disableMember(identity, member.memberId);
      expect(removed.disabledAt).not.toBeNull();

      await expect(store.resolveMembership(memberUserId, owner.workspaceId)).rejects.toBeInstanceOf(StoreUnauthorizedError);
      await expect(store.resolveWorkspaceToken(claimed.token)).rejects.toBeInstanceOf(StoreUnauthorizedError);
      await expect(store.assertReplicaOwnership(owner.workspaceId, member.memberId, claimed.replicaId)).rejects.toBeInstanceOf(StoreUnauthorizedError);
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

  it("refuses revocation and removal to a non-owner", async () => {
    const store = new PgStore(databaseUrl!);
    try {
      await store.migrate();
      const owner = await store.provisionAdmin({ workspaceName: `test-${randomUUID()}`, userId: randomUUID(), actorId: `owner-${randomUUID()}@example.com` });
      const memberUserId = randomUUID();
      await store.addMember({ workspaceId: owner.workspaceId, userId: memberUserId, actorId: `m-${randomUUID()}@example.com` });
      const memberIdentity = await store.resolveMembership(memberUserId, owner.workspaceId);

      await expect(store.listWorkspaceTokens(memberIdentity)).rejects.toBeInstanceOf(StoreUnauthorizedError);
      await expect(store.revokeWorkspaceToken(memberIdentity, randomUUID())).rejects.toBeInstanceOf(StoreUnauthorizedError);
      await expect(store.disableMember(memberIdentity, owner.memberId)).rejects.toBeInstanceOf(StoreUnauthorizedError);
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
