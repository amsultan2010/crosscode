import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { HandoffRequestedEvent, IntentPublishedEvent, TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServiceServer, type BillingOptions } from "./http.js";
import { BillingLimitError, MAX_SELF_SERVE_WORKSPACES_PER_USER, type BillingProvider } from "./billing.js";
import type { Membership, PgStore, StoredOperation, WorkspaceBillingRecord } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";
const WORKSPACE_HEADER = "x-crosscode-workspace-id";

const membership: Membership = {
  memberId: "member-1",
  userId: "user-1",
  actorId: "actor-1",
  workspaceId: "workspace-1",
  role: "member"
};

const servers: ReturnType<typeof createServiceServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("service HTTP boundary", () => {
  it("registers a replica, ingests idempotently, and reads a cursor", async () => {
    const operation = storedOperation(makeEvent());
    const store = {
      resolveMembership: async () => membership,
      registerReplica: async () => ({ replicaId: "replica-1", createdAt: "2026-01-01T00:00:00.000Z", projectId: null }),
      assertReplicaOwnership: async () => {},
      appendOperation: async () => operation,
      listOperations: async () => ({ status: "ok", items: [operation], nextCursor: 1, hasMore: false })
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const registration = await post(base, "/v1/replicas", { name: "laptop" }, accessToken, membership.workspaceId);
    expect(registration.status).toBe(201);
    const registrationBody = await registration.json() as any;
    expect(registrationBody.data).toMatchObject({ replicaId: "replica-1" });

    const receipt = await post(base, "/v1/events", { event: makeEvent() }, accessToken, membership.workspaceId);
    expect(await receipt.json()).toEqual({
      ok: true,
      data: { eventId: "operation-1", operationId: "operation-1", serverSequence: 1 }
    });
    const secretEvent = makeEvent();
    secretEvent.id = "secret-operation";
    secretEvent.payload = { ...secretEvent.payload, id: secretEvent.id, changes: [{ path: ".env", kind: "add", afterContent: "TOKEN=value", afterHash: contentHash("TOKEN=value") }] };
    expect((await post(base, "/v1/events", { event: secretEvent }, accessToken, membership.workspaceId)).status).toBe(400);
    const forgedEvent = makeEvent();
    forgedEvent.id = "forged-operation";
    forgedEvent.payload = { ...forgedEvent.payload, id: forgedEvent.id, changes: [{ path: "safe.txt", kind: "add", afterContent: "actual", afterHash: "forged" }] };
    expect((await post(base, "/v1/events", { event: forgedEvent }, accessToken, membership.workspaceId)).status).toBe(400);

    const cursor = await fetch(`${base}/v1/operations?afterSequence=0`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });
    expect((await cursor.json()) as any).toMatchObject({
      ok: true,
      data: { nextCursor: 1, operations: [{ id: "operation-1", serverSequence: 1 }] }
    });
  });

  it("ingests handoffs and intents idempotently and reads them back by cursor", async () => {
    const handoffEvent: HandoffRequestedEvent = {
      id: "handoff-1",
      schemaVersion: 1,
      workspaceId: membership.workspaceId,
      replicaId: "replica-1",
      actorId: membership.actorId,
      type: "handoff.requested",
      clientSequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        id: "handoff-1",
        operationId: "operation-1",
        requestedBy: membership.actorId,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    };
    const intentEvent: IntentPublishedEvent = {
      id: "intent-1",
      schemaVersion: 1,
      workspaceId: membership.workspaceId,
      replicaId: "replica-1",
      actorId: membership.actorId,
      type: "intent.published",
      clientSequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { id: "intent-1", actorId: membership.actorId, text: "Rename foo to bar", createdAt: "2026-01-01T00:00:00.000Z" }
    };
    const remoteHandoff = { eventId: handoffEvent.id, workspaceId: membership.workspaceId, senderReplicaId: "replica-1", handoff: handoffEvent.payload, updatedAt: "2026-01-01T00:00:01.000Z" };
    const remoteIntent = { eventId: intentEvent.id, workspaceId: membership.workspaceId, senderReplicaId: "replica-1", intent: intentEvent.payload, updatedAt: "2026-01-01T00:00:01.000Z" };
    const store = {
      resolveMembership: async () => membership,
      assertReplicaOwnership: async () => {},
      upsertHandoff: async () => remoteHandoff,
      listHandoffs: async () => ({ items: [remoteHandoff], nextCursor: remoteHandoff.updatedAt }),
      upsertIntent: async () => remoteIntent,
      listIntents: async () => ({ items: [remoteIntent], nextCursor: remoteIntent.updatedAt }),
      listPresence: async () => [{ replicaId: "replica-1", actorId: membership.actorId, status: "online", lastSeenAt: "2026-01-01T00:00:00.000Z", cursor: 0, projectId: null }]
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const handoffReceipt = await post(base, "/v1/handoffs", { event: handoffEvent }, accessToken, membership.workspaceId);
    expect(await handoffReceipt.json()).toEqual({ ok: true, data: { eventId: "handoff-1", handoffId: "handoff-1", updatedAt: remoteHandoff.updatedAt } });

    const handoffList = await fetch(`${base}/v1/handoffs?after=1970-01-01T00:00:00.000Z`, { headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId } });
    expect((await handoffList.json()) as any).toMatchObject({ ok: true, data: { handoffs: [{ handoff: { id: "handoff-1" } }] } });

    const intentReceipt = await post(base, "/v1/intents", { event: intentEvent }, accessToken, membership.workspaceId);
    expect(await intentReceipt.json()).toEqual({ ok: true, data: { eventId: "intent-1", intentId: "intent-1", updatedAt: remoteIntent.updatedAt } });

    const intentList = await fetch(`${base}/v1/intents?after=1970-01-01T00:00:00.000Z`, { headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId } });
    expect((await intentList.json()) as any).toMatchObject({ ok: true, data: { intents: [{ intent: { id: "intent-1" } }] } });

    const presence = await fetch(`${base}/v1/presence`, { headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId } });
    expect((await presence.json()) as any).toMatchObject({
      ok: true,
      data: { sessions: [{ replicaId: "replica-1", status: "online", cursor: 0 }] }
    });
  });

  it("enforces JSON bodies, body caps, authentication, the workspace header, and principal binding", async () => {
    const store = {
      resolveMembership: async () => membership,
      appendOperation: async () => storedOperation(makeEvent())
    } as unknown as PgStore;
    const base = await listen(store, 128);
    const accessToken = await signToken(membership.userId);

    expect((await fetch(`${base}/v1/operations`)).status).toBe(401);
    expect((await fetch(`${base}/v1/operations`, {
      headers: { authorization: `Bearer ${accessToken}` }
    })).status).toBe(400);
    expect((await fetch(`${base}/v1/replicas`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId },
      body: "{}"
    })).status).toBe(415);
    expect((await post(base, "/v1/replicas", { name: "laptop", extra: true }, accessToken, membership.workspaceId)).status).toBe(400);
    expect((await post(base, "/v1/replicas", { name: "x".repeat(200) }, accessToken, membership.workspaceId)).status).toBe(413);
  });

  it("upserts, lists, and reads back projects, and 404s outside the caller's workspace", async () => {
    const project = {
      id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      workspaceId: membership.workspaceId,
      name: "repo",
      repoRemote: "github.com/owner/repo",
      repoRoot: "/Users/dev/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-02T00:00:00.000Z"
    };
    const upserts: Array<{ repoRoot?: string | null; repoRemote?: string | null }> = [];
    const store = {
      resolveMembership: async () => membership,
      upsertProject: async (_workspaceId: string, input: { repoRoot?: string | null; repoRemote?: string | null }) => {
        upserts.push(input);
        return project;
      },
      listProjects: async () => [project],
      // The store is already workspace-scoped, so "belongs to another workspace" is
      // indistinguishable from "does not exist" -- both come back as null.
      getProject: async (workspaceId: string, id: string) =>
        workspaceId === membership.workspaceId && id === project.id ? project : null
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);
    const headers = { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId };

    const created = await post(base, "/v1/projects", { repoRoot: "/Users/dev/repo", repoRemote: "git@github.com:owner/repo.git" }, accessToken, membership.workspaceId);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ ok: true, data: project });
    // Idempotent at the HTTP layer too: the same body upserts rather than creating.
    const again = await post(base, "/v1/projects", { repoRoot: "/Users/dev/repo", repoRemote: "git@github.com:owner/repo.git" }, accessToken, membership.workspaceId);
    expect(await again.json()).toEqual({ ok: true, data: project });
    expect(upserts).toHaveLength(2);

    expect((await post(base, "/v1/projects", {}, accessToken, membership.workspaceId)).status).toBe(400);
    expect((await post(base, "/v1/projects", { repoRoot: "/Users/dev/repo", extra: true }, accessToken, membership.workspaceId)).status).toBe(400);
    expect((await post(base, "/v1/projects", { repoRoot: "/Users/dev/repo" })).status).toBe(401);

    const listed = await fetch(`${base}/v1/projects`, { headers });
    expect(await listed.json()).toEqual({ ok: true, data: { projects: [project] } });

    const read = await fetch(`${base}/v1/projects/${project.id}`, { headers });
    expect(await read.json()).toEqual({ ok: true, data: project });

    // Another workspace's project id, and a malformed id, are both plain 404s.
    expect((await fetch(`${base}/v1/projects/9f2504e0-4f89-11d3-9a0c-0305e82c3399`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/v1/projects/not-a-uuid`, { headers })).status).toBe(404);
  });

  // Regression: writing project_id is useless if no read path returns it. These assert on
  // the JSON a consumer actually receives, not on the database column.
  it("returns projectId on GET /v1/operations and GET /v1/presence, populated and null", async () => {
    const projectId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const attributed = storedOperation(makeEvent(), projectId);
    const unattributed = storedOperation({ ...makeEvent(), id: "operation-2", payload: { ...makeEvent().payload, id: "operation-2" } });
    unattributed.serverSequence = 2;
    const store = {
      resolveMembership: async () => membership,
      listOperations: async () => ({ status: "ok", items: [attributed, unattributed], nextCursor: 2, hasMore: false }),
      listPresence: async () => [
        { replicaId: "replica-1", actorId: membership.actorId, status: "online", lastSeenAt: "2026-01-01T00:00:00.000Z", cursor: 0, projectId },
        { replicaId: "replica-2", actorId: membership.actorId, status: "offline", lastSeenAt: null, cursor: null, projectId: null }
      ]
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);
    const headers = { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId };

    const operations = await (await fetch(`${base}/v1/operations?afterSequence=0`, { headers })).json() as any;
    expect(operations.data.operations.map((operation: any) => [operation.id, operation.projectId])).toEqual([
      ["operation-1", projectId],
      ["operation-2", null]
    ]);
    // The daemon parses this response with a .strict() schema, so the field must be
    // present rather than merely undefined.
    expect(Object.keys(operations.data.operations[0])).toContain("projectId");

    const presence = await (await fetch(`${base}/v1/presence`, { headers })).json() as any;
    expect(presence.data.sessions.map((session: any) => [session.replicaId, session.projectId])).toEqual([
      ["replica-1", projectId],
      ["replica-2", null]
    ]);
    expect(Object.keys(presence.data.sessions[1])).toContain("projectId");
  });

  // A cursor pointing below the retention watermark has exactly one honest answer, and it
  // is not a page: serving the surviving rows (or an empty list, once everything the
  // replica had not seen is deleted) is indistinguishable from "you are caught up", which
  // is how a replica silently loses proposals forever.
  it("answers a cursor below the retention watermark with a resync order, never a short page", async () => {
    const store = {
      resolveMembership: async () => membership,
      listOperations: async () => ({ status: "cursor-too-old", resyncFrom: 42, retentionDays: 7 })
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);
    const headers = { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId };

    const current = await fetch(`${base}/v1/operations?afterSequence=3&protocolVersion=2`, { headers });
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      ok: true,
      data: { status: "cursor-too-old", protocolVersion: 2, resyncFrom: 42, retentionDays: 7 }
    });

    // A daemon built before this status sends no protocolVersion. It must not receive a
    // 200 at all: it would parse the body with cursorResponseSchema and, whatever that
    // does, "the request succeeded" is the one conclusion it must never reach. A 410 lands
    // in the sync-error path it already has.
    const legacy = await fetch(`${base}/v1/operations?afterSequence=3`, { headers });
    expect(legacy.status).toBe(410);
    const legacyBody = await legacy.json() as { ok: boolean; error: string };
    expect(legacyBody.ok).toBe(false);
    expect(legacyBody.error).toContain("upgrade the daemon");

    expect((await fetch(`${base}/v1/operations?afterSequence=3&protocolVersion=nope`, { headers })).status).toBe(400);
  });

  it("registers a replica with its repository so the replica is attributed to a project", async () => {
    const seen: Array<unknown[]> = [];
    const store = {
      resolveMembership: async () => membership,
      registerReplica: async (...args: unknown[]) => {
        seen.push(args);
        return { replicaId: "replica-1", createdAt: "2026-01-01T00:00:00.000Z", projectId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const registered = await post(
      base, "/v1/replicas",
      { name: "laptop", repoRoot: "/Users/dev/repo", repoRemote: "git@github.com:owner/repo.git" },
      accessToken, membership.workspaceId
    );
    expect(registered.status).toBe(201);
    expect(await registered.json()).toEqual({
      ok: true,
      data: { replicaId: "replica-1", createdAt: "2026-01-01T00:00:00.000Z", projectId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }
    });
    expect(seen[0]?.[3]).toEqual({ repoRoot: "/Users/dev/repo", repoRemote: "git@github.com:owner/repo.git" });
  });

  it("self-serve creates a workspace for a token that has no membership yet", async () => {
    const store = {
      createWorkspace: async (input: { workspaceName: string; userId: string; actorId: string }) => {
        expect(input).toEqual({ workspaceName: "acme", userId: "user-2", actorId: "member@example.com" });
        return { workspaceId: "workspace-2", memberId: "member-2" };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-2");

    // No WORKSPACE_HEADER: a brand-new user has no workspace to scope one to yet.
    const created = await post(base, "/v1/workspaces", { name: "acme" }, accessToken);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true, data: { workspaceId: "workspace-2", memberId: "member-2" } });

    expect((await post(base, "/v1/workspaces", { name: "acme" })).status).toBe(401);
  });

  it("lets a workspace owner create, list, and revoke invites, and rejects a non-owner", async () => {
    const owner: Membership = { ...membership, role: "owner" };
    const invite = {
      id: "invite-1", workspaceId: owner.workspaceId, code: "ABCDEFGHJK", role: "member" as const,
      createdBy: owner.memberId, expiresAt: "2026-01-08T00:00:00.000Z", redeemedAt: null, redeemedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const store = {
      resolveMembership: async () => owner,
      createInvite: async () => invite,
      listInvites: async () => [invite],
      revokeInvite: async () => {}
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(owner.userId);

    const created = await post(base, "/v1/invites", {}, accessToken, owner.workspaceId);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true, data: invite });

    const listed = await fetch(`${base}/v1/invites`, { headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: owner.workspaceId } });
    expect((await listed.json()) as any).toEqual({ ok: true, data: { invites: [invite] } });

    const revoked = await fetch(`${base}/v1/invites/${invite.id}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: owner.workspaceId } });
    expect(revoked.status).toBe(200);

    const memberStore = { resolveMembership: async () => membership } as unknown as PgStore;
    const memberBase = await listen(memberStore);
    const memberToken = await signToken(membership.userId);
    expect((await post(memberBase, "/v1/invites", {}, memberToken, membership.workspaceId)).status).toBe(403);
    expect((await fetch(`${memberBase}/v1/invites`, { headers: { authorization: `Bearer ${memberToken}`, [WORKSPACE_HEADER]: membership.workspaceId } })).status).toBe(403);
    expect((await fetch(`${memberBase}/v1/invites/invite-1`, { method: "DELETE", headers: { authorization: `Bearer ${memberToken}`, [WORKSPACE_HEADER]: membership.workspaceId } })).status).toBe(403);
  });

  it("redeems a valid invite without requiring an existing membership", async () => {
    const store = {
      redeemInvite: async (input: { code: string; userId: string; actorId: string }) => {
        expect(input).toEqual({ code: "ABCDEFGHJK", userId: "user-3", actorId: "member@example.com" });
        return { workspaceId: "workspace-1", memberId: "member-3", role: "member" as const };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-3");

    const redeemed = await fetch(`${base}/v1/invites/ABCDEFGHJK/redeem`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ ok: true, data: { workspaceId: "workspace-1", memberId: "member-3", role: "member" } });
  });

  it("rejects redeeming an invalid, expired, or already-redeemed invite code", async () => {
    const { StoreConflictError, StoreUnauthorizedError } = await import("./store.js");
    const store = {
      redeemInvite: async (input: { code: string }) => {
        if (input.code === "MISSING") throw new StoreUnauthorizedError("Invite code is not valid");
        if (input.code === "EXPIRED") throw new StoreConflictError("Invite has expired");
        if (input.code === "REDEEMED") throw new StoreConflictError("Invite has already been redeemed");
        throw new Error("unexpected code");
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-4");

    const redeem = (code: string, token?: string) => fetch(`${base}/v1/invites/${code}/redeem`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    expect((await redeem("MISSING", accessToken)).status).toBe(401);
    expect((await redeem("EXPIRED", accessToken)).status).toBe(409);
    expect((await redeem("REDEEMED", accessToken)).status).toBe(409);
    expect((await redeem("ANY")).status).toBe(401);
  });

  it("reads the workspace autonomy tier for any member but only lets the owner set it", async () => {
    let storedTier: 0 | 1 | 2 = 0;
    const ownerMembership: Membership = { ...membership, role: "owner" };
    const store = {
      resolveMembership: async (_userId: string, workspaceId: string) => (workspaceId === "owner-workspace" ? ownerMembership : membership),
      getWorkspaceAutonomyTier: async () => storedTier,
      setWorkspaceAutonomyTier: async (identity: Membership, tier: 0 | 1 | 2) => {
        if (identity.role !== "owner") throw new Error("unreachable: http.ts should have already rejected non-owners");
        storedTier = tier;
        return storedTier;
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const initial = await fetch(`${base}/v1/workspace/autonomy`, { headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId } });
    expect(await initial.json()).toEqual({ ok: true, data: { tier: 0 } });

    const rejected = await put(base, "/v1/workspace/autonomy", { tier: 2 }, accessToken, membership.workspaceId);
    expect(rejected.status).toBe(403);
    expect(storedTier).toBe(0);

    const accepted = await put(base, "/v1/workspace/autonomy", { tier: 2 }, accessToken, "owner-workspace");
    expect(await accepted.json()).toEqual({ ok: true, data: { tier: 2 } });
    expect(storedTier).toBe(2);

    expect((await put(base, "/v1/workspace/autonomy", { tier: 3 }, accessToken, "owner-workspace")).status).toBe(400);
  });

  it("lists every workspace a user belongs to, for the CLI's workspace switching", async () => {
    const store = {
      ensurePersonalWorkspace: async () => ({ workspaceId: "workspace-a", memberId: "m1", created: false }),
      listMembershipsForUser: async (userId: string) => {
        expect(userId).toBe("user-5");
        return [
          { memberId: "m1", userId, actorId: "a@example.com", role: "owner" as const, workspaceId: "workspace-a", workspaceName: "Acme" },
          { memberId: "m2", userId, actorId: "a@example.com", role: "member" as const, workspaceId: "workspace-b", workspaceName: "Beta" }
        ];
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-5");

    const response = await fetch(`${base}/v1/memberships`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        memberships: [
          { workspaceId: "workspace-a", workspaceName: "Acme", role: "owner" },
          { workspaceId: "workspace-b", workspaceName: "Beta", role: "member" }
        ]
      }
    });
  });

  it("mints and polls a pairing code, and claims it unauthenticated, attributing the replica to its project", async () => {
    const { StoreGoneError } = await import("./store.js");
    const pairingId = "3f1d5f1e-1e2b-4a7c-9f3d-2b6c7d8e9f01";
    const store = {
      resolveMembership: async () => membership,
      createPairingCode: async () => ({ pairingId, code: "K4T9-2WQZ", expiresAt: "2026-08-01T12:15:00.000Z" }),
      getPairingCodeStatus: async (_identity: Membership, id: string) => id === pairingId
        ? { status: "pending" as const, claimedAt: null, replicaId: null, actorId: null, devicePublicKey: null }
        : undefined,
      claimPairingCode: async (input: { code: string }) => {
        if (input.code !== "K4T9-2WQZ") throw new StoreGoneError("Pairing code is no longer available");
        return { workspaceId: membership.workspaceId, replicaId: "replica-9", token: "ccw_opaque-token", pairingId };
      },
      // Contract A's projectId is populated by attributing the freshly registered replica
      // to the repository it reported, so assert the handler forwards that report through
      // rather than dropping it.
      attachReplicaToProject: async (workspaceId: string, replicaId: string, repo: { repoRoot?: string | null }) => {
        expect(workspaceId).toBe(membership.workspaceId);
        expect(replicaId).toBe("replica-9");
        expect(repo.repoRoot).toBe("/repo");
        return "project-7";
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const minted = await post(base, "/v1/pairing-codes", {}, accessToken, membership.workspaceId);
    expect(minted.status).toBe(201);
    expect(await minted.json()).toEqual({ ok: true, data: { code: "K4T9-2WQZ", expiresAt: "2026-08-01T12:15:00.000Z", pairingId } });

    const polled = await fetch(`${base}/v1/pairing-codes/${pairingId}`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });
    expect(await polled.json()).toEqual({ ok: true, data: { status: "pending", claimedAt: null, replicaId: null, actorId: null, devicePublicKey: null } });

    const missing = await fetch(`${base}/v1/pairing-codes/1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });
    expect(missing.status).toBe(404);
    const malformed = await fetch(`${base}/v1/pairing-codes/not-a-uuid`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });
    expect(malformed.status).toBe(400);

    // No authorization header at all: the code itself is the credential.
    const claimed = await post(base, "/v1/pairing-codes/claim", {
      code: "K4T9-2WQZ", actorId: "user@host", replicaName: "laptop", repoRoot: "/repo", repoRemote: null
    });
    expect(await claimed.json()).toEqual({
      ok: true,
      data: { workspaceId: membership.workspaceId, replicaId: "replica-9", token: "ccw_opaque-token", projectId: "project-7", pairingId }
    });

    const gone = await post(base, "/v1/pairing-codes/claim", {
      code: "AAAA-BBBB", actorId: "user@host", replicaName: "laptop", repoRoot: "/repo", repoRemote: null
    });
    expect(gone.status).toBe(410);
    expect((await post(base, "/v1/pairing-codes/claim", { code: "lowercase", actorId: "a", replicaName: "b", repoRoot: "/r", repoRemote: null })).status).toBe(400);
  });

  it("accepts a ccw_ workspace token on the daemon surface and refuses it on the user surface", async () => {
    const { StoreUnauthorizedError } = await import("./store.js");
    const store = {
      resolveWorkspaceToken: async (token: string) => {
        if (token !== "ccw_valid-token") throw new StoreUnauthorizedError("Workspace token is invalid or revoked");
        return { ...membership, replicaId: "replica-9" };
      },
      listPresence: async () => [],
      createPairingCode: async () => { throw new Error("unreachable: a workspace token must never mint a pairing code"); },
      listMembershipsForUser: async () => { throw new Error("unreachable: a workspace token must never list memberships"); },
      listInvites: async () => { throw new Error("unreachable: a workspace token must never list invites"); },
      createWorkspace: async () => { throw new Error("unreachable: a workspace token must never create a workspace"); }
    } as unknown as PgStore;
    const base = await listen(store);
    const token = "ccw_valid-token";

    // Accepted on the daemon read surface, and without the workspace header: the token
    // already names its workspace.
    const presence = await fetch(`${base}/v1/presence`, { headers: { authorization: `Bearer ${token}` } });
    expect(await presence.json()).toEqual({ ok: true, data: { sessions: [] } });

    const withHeader = await fetch(`${base}/v1/presence`, {
      headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: "workspace-2" }
    });
    expect(withHeader.status).toBe(403);

    for (const path of ["/v1/memberships", "/v1/invites"]) {
      expect((await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: membership.workspaceId } })).status).toBe(403);
    }
    expect((await post(base, "/v1/workspaces", { name: "acme" }, token)).status).toBe(403);
    expect((await post(base, "/v1/pairing-codes", {}, token, membership.workspaceId)).status).toBe(403);
    expect((await post(base, "/v1/invites", {}, token, membership.workspaceId)).status).toBe(403);
    expect((await fetch(`${base}/v1/invites/invite-1`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: membership.workspaceId } })).status).toBe(403);
    expect((await fetch(`${base}/v1/invites/CODE/redeem`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await fetch(`${base}/v1/presence`, { headers: { authorization: "Bearer ccw_revoked" } })).status).toBe(401);
  });

  it("auto-provisions a personal workspace before listing memberships", async () => {
    const provisioned: string[] = [];
    const store = {
      ensurePersonalWorkspace: async (input: { userId: string; actorId: string }) => {
        provisioned.push(input.actorId);
        return { workspaceId: "workspace-personal", memberId: "member-personal", created: true };
      },
      listMembershipsForUser: async (userId: string) => [
        { memberId: "member-personal", userId, actorId: "member@example.com", role: "owner" as const, workspaceId: "workspace-personal", workspaceName: "member@example.com's workspace" }
      ]
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("user-6");

    const response = await fetch(`${base}/v1/memberships`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await response.json()).toEqual({
      ok: true,
      data: { memberships: [{ workspaceId: "workspace-personal", workspaceName: "member@example.com's workspace", role: "owner" }] }
    });
    expect(provisioned).toEqual(["member@example.com"]);
  });

  it("reports workspace billing status, converting an unlimited (Infinity) cap to null over JSON", async () => {
    const store = {
      resolveMembership: async () => membership,
      getWorkspaceBilling: async () => billingRecord({ plan: "unlimited", billingPlan: "unlimited", billingInterval: "year" }),
      countActiveMembers: async () => 2,
      pool: { query: async () => ({ rows: [] }) }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const response = await fetch(`${base}/v1/workspace/billing`, { headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId } });
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        workspaceId: membership.workspaceId,
        plan: "unlimited",
        seatCap: null,
        currentMemberCount: 2,
        semanticReviewCallsPerMonth: null,
        semanticReviewCallsUsedThisMonth: 0,
        autonomyTiers: ["always-ask", "auto-if-clean", "auto-always"],
        historyRetentionDays: 365,
        billingPlan: "unlimited",
        billingInterval: "year",
        billingStatus: "active",
        billingSeats: 1,
        gracePeriodEndsAt: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        billingOwnerActorId: "actor-1",
        // $7.50/month billed annually is $75.00 — ten months for twelve.
        priceCents: 7_500
      }
    });
  });
});

// CROSSCODE_ALLOWED_ORIGINS is unset by default and should stay that way: the service's
// clients are daemons and the CLI, never a browser, and the website talks only to Supabase
// and to a loopback port. These cover the opt-in case -- an operator who does put a browser
// app in front of the service -- because without the headers such an origin cannot make a
// single authenticated call. The origin below is a stand-in for that, not a live deployment.
describe("browser CORS", () => {
  const browserOrigin = "https://browser-client.example";
  const store = { resolveMembership: async () => membership } as unknown as PgStore;

  it("answers preflight for an allowed origin with the headers a browser client sends", async () => {
    const base = await listen(store, undefined, [browserOrigin]);

    const response = await fetch(`${base}/v1/memberships`, {
      method: "OPTIONS",
      headers: { origin: browserOrigin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigin);
    const allowedHeaders = response.headers.get("access-control-allow-headers")!.toLowerCase();
    // A browser client cannot authenticate or name its workspace without both of these.
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain(WORKSPACE_HEADER);
    expect(response.headers.get("vary")!.toLowerCase()).toContain("origin");
  });

  it("echoes the allowed origin on a real authenticated response", async () => {
    const listStore = {
      resolveMembership: async () => membership,
      ensurePersonalWorkspace: async () => {},
      listMembershipsForUser: async () => [{ workspaceId: membership.workspaceId, workspaceName: "Ada", role: "owner" }]
    } as unknown as PgStore;
    const base = await listen(listStore, undefined, [browserOrigin]);
    const accessToken = await signToken(membership.userId);

    const response = await fetch(`${base}/v1/memberships`, {
      headers: { origin: browserOrigin, authorization: `Bearer ${accessToken}` }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigin);
  });

  it("refuses an origin that is not on the allowlist", async () => {
    const base = await listen(store, undefined, [browserOrigin]);

    const preflight = await fetch(`${base}/v1/memberships`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" }
    });

    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("stays closed to browsers when no allowlist is configured", async () => {
    const base = await listen(store);

    const response = await fetch(`${base}/healthz`, { headers: { origin: browserOrigin } });

    // Still serves the daemon and CLI, which are not subject to CORS -- it just never
    // hands a browser permission it was not explicitly given.
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers GET /health with no credentials and no database call", async () => {
    // Every property read on this store returns a function that throws when called, so a
    // route that reaches for the database fails the test instead of passing against a mock
    // that happily returns rows. The probe has to survive an unreachable database to be
    // worth anything as a check on the deployed function itself.
    const hostileStore = new Proxy({}, {
      get: (_target, property) => () => {
        throw new Error(`/health called the store: ${String(property)}`);
      }
    }) as unknown as PgStore;
    const base = await listen(hostileStore);

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { status: "ok", service: "crosscode-service" } });
  });
});

async function signToken(userId: string): Promise<string> {
  return signTestSupabaseToken(supabaseUrl, { sub: userId });
}

/** A healthy, active subscription record; overridden field by field per test. */
function billingRecord(overrides: Partial<WorkspaceBillingRecord>): WorkspaceBillingRecord {
  return {
    workspaceId: membership.workspaceId,
    plan: "free",
    billingPlan: null,
    billingInterval: null,
    billingStatus: "active",
    billingSeats: 1,
    gracePeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    billingOwnerMemberId: null,
    billingOwnerActorId: "actor-1",
    ...overrides
  };
}

function fakeProvider(overrides: Partial<BillingProvider> = {}): BillingProvider {
  return {
    createCustomer: async (workspaceId: string) => ({ customerId: "cus_fake", workspaceId }),
    createCheckoutSession: async (workspaceId: string, plan: string) => ({ url: `https://checkout.example/${workspaceId}/${plan}` }),
    changeSubscription: async () => {},
    setSeatQuantity: async () => {},
    cancelSubscription: async () => {},
    getSubscriptionState: async (subscriptionId: string) => ({
      subscriptionId, customerId: "cus_fake", status: "active" as const, plan: "pro" as const,
      interval: "year" as const, seats: 1, cancelAtPeriodEnd: false, currentPeriodEnd: null
    }),
    createPortalSession: async (customerId: string) => ({ url: `https://portal.example/${customerId}` }),
    ...overrides
  } as BillingProvider;
}

/** The header Stripe would send for this body: `t=<unix>,v1=<hex hmac of "t.body">`. */
function stripeSignature(body: string, secret: string, timestamp = Math.floor(Date.now() / 1_000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

function postSigned(base: string, body: string, secret: string) {
  return fetch(`${base}/v1/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": stripeSignature(body, secret) },
    body
  });
}

async function listen(
  store: PgStore, bodyLimitBytes?: number, allowedOrigins?: readonly string[],
  extra: { trustProxy?: boolean; onError?: (error: unknown) => void; billing?: BillingOptions } = {}
): Promise<string> {
  const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl, bodyLimitBytes, allowedOrigins, ...extra });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(base: string, path: string, body: unknown, accessToken?: string, workspaceId?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : {})
    },
    body: JSON.stringify(body)
  });
}

function put(base: string, path: string, body: unknown, accessToken?: string, workspaceId?: string) {
  return fetch(`${base}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(workspaceId ? { [WORKSPACE_HEADER]: workspaceId } : {})
    },
    body: JSON.stringify(body)
  });
}

function makeEvent(): TransactionCreatedEvent {
  return {
    id: "operation-1",
    schemaVersion: 1,
    workspaceId: membership.workspaceId,
    replicaId: "replica-1",
    actorId: membership.actorId,
    type: "transaction.created",
    clientSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      id: "operation-1",
      base: { files: [] },
      changes: [{ path: "test.txt", kind: "add", afterContent: "test", afterHash: contentHash("test") }],
      provenance: { source: "filesystem", confidence: "known" },
      safety: { risk: "low", requiresApproval: false }
    }
  };
}

function storedOperation(event: TransactionCreatedEvent, projectId: string | null = null): StoredOperation {
  return {
    id: event.id,
    eventId: event.id,
    workspaceId: event.workspaceId,
    senderReplicaId: event.replicaId,
    projectId,
    transaction: event.payload,
    serverSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    event: { ...event, serverSequence: 1 }
  };
}

describe("end-to-end encrypted ingest", () => {
  const sealedEvent = () => ({
    id: "operation-1",
    schemaVersion: 1 as const,
    workspaceId: membership.workspaceId,
    replicaId: "replica-1",
    actorId: membership.actorId,
    type: "transaction.sealed" as const,
    clientSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      id: "operation-1",
      sealed: { version: 1 as const, algorithm: "AES-256-GCM" as const, epoch: 0, keyId: "0123456789abcdef", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "Zm9vYmFyYmF6" },
      changes: [{ pathToken: "a".repeat(64), kind: "modify" as const }, { pathToken: "b".repeat(64), kind: "add" as const }]
    }
  });

  it("accepts a sealed operation without inspecting anything, and still enforces the structural rules", async () => {
    let appended: unknown;
    const store = {
      resolveMembership: async () => membership,
      assertReplicaOwnership: async () => {},
      appendOperation: async (_identity: Membership, event: unknown) => {
        appended = event;
        return { ...storedOperation(makeEvent()), transaction: sealedEvent().payload, event: sealedEvent() };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const accepted = await post(base, "/v1/events", { event: sealedEvent() }, accessToken, membership.workspaceId);
    expect(accepted.status).toBe(200);
    expect(appended).toMatchObject({ type: "transaction.sealed" });

    // The content checks the plaintext path runs (`afterHash === contentHash(...)`,
    // `redactPath`) have nothing to run against here and must not be faked into passing
    // -- but the checks that do not need plaintext still apply.
    const duplicated = sealedEvent();
    duplicated.payload.changes = [{ pathToken: "a".repeat(64), kind: "modify" }, { pathToken: "a".repeat(64), kind: "add" }];
    expect((await post(base, "/v1/events", { event: duplicated }, accessToken, membership.workspaceId)).status).toBe(400);

    const impersonating = sealedEvent();
    impersonating.actorId = "someone-else";
    expect((await post(base, "/v1/events", { event: impersonating }, accessToken, membership.workspaceId)).status).toBe(403);

    const malformed = sealedEvent();
    (malformed.payload.sealed as { keyId: string }).keyId = "not-a-key-id";
    expect((await post(base, "/v1/events", { event: malformed }, accessToken, membership.workspaceId)).status).toBe(400);
  });

  it("refuses plaintext once the workspace has latched, and says why", async () => {
    const { StoreConflictError } = await import("./store.js");
    const store = {
      resolveMembership: async () => membership,
      assertReplicaOwnership: async () => {},
      appendOperation: async (_identity: Membership, event: { type: string }) => {
        if (event.type !== "transaction.sealed") throw new StoreConflictError("This workspace is end-to-end encrypted; plaintext operations are refused");
        return { ...storedOperation(makeEvent()), transaction: sealedEvent().payload, event: sealedEvent() };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const downgraded = await post(base, "/v1/events", { event: makeEvent() }, accessToken, membership.workspaceId);
    expect(downgraded.status).toBe(409);
    expect((await downgraded.json() as any).error).toContain("end-to-end encrypted");
    expect((await post(base, "/v1/events", { event: sealedEvent() }, accessToken, membership.workspaceId)).status).toBe(200);
  });

  it("scopes the key routes to an owned replica and closes them to viewers", async () => {
    const replicaId = "3f1d5f1e-1e2b-4a7c-9f3d-2b6c7d8e9f01";
    const grants: unknown[] = [];
    const store = {
      resolveMembership: async () => membership,
      assertReplicaOwnership: async (_workspaceId: string, _memberId: string, requested: string) => {
        if (requested !== replicaId) throw new (await import("./store.js")).StoreUnauthorizedError("Replica is not registered to this member");
        return null;
      },
      getWorkspaceKeyState: async () => ({ encrypted: true, keyHolders: 2, grants: [] }),
      listWorkspaceKeyRecipients: async () => ([{ replicaId, replicaName: "laptop", actorId: "actor-1", publicKey: "A".repeat(43), epochs: [0] }]),
      insertWorkspaceKeyGrants: async (_identity: Membership, _sender: string, incoming: unknown[]) => {
        grants.push(...incoming);
        return { stored: incoming.length };
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);
    const headers = { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId };

    const state = await fetch(`${base}/v1/workspace-keys/state?replicaId=${replicaId}`, { headers });
    expect(await state.json()).toEqual({ ok: true, data: { encrypted: true, keyHolders: 2, grants: [] } });

    // A device may only read grants addressed to a replica it owns, and only a UUID at all.
    expect((await fetch(`${base}/v1/workspace-keys/state?replicaId=1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f`, { headers })).status).toBe(401);
    expect((await fetch(`${base}/v1/workspace-keys/state?replicaId=nope`, { headers })).status).toBe(400);

    const issued = await post(base, `/v1/workspace-keys/grants?replicaId=${replicaId}`, {
      grants: [{
        epoch: 0, keyId: "0123456789abcdef", recipientReplicaId: replicaId, recipientPublicKey: "A".repeat(43),
        wrapped: { version: 1, algorithm: "X25519-HKDF-SHA256-AES-256-GCM", senderPublicKey: "B".repeat(43), nonce: "AAAAAAAAAAAAAAAA", ciphertext: "Zm9vYmFy" }
      }]
    }, accessToken, membership.workspaceId);
    expect(await issued.json()).toEqual({ ok: true, data: { stored: 1 } });
    expect(grants).toHaveLength(1);

    const viewerStore = { ...store, resolveMembership: async () => ({ ...membership, role: "viewer" as const }) } as unknown as PgStore;
    const viewerBase = await listen(viewerStore);
    expect((await fetch(`${viewerBase}/v1/workspace-keys/recipients`, { headers })).status).toBe(403);
  });
});

describe("per-identity rate limiting", () => {
  // Every daemon in an office or a CI fleet leaves through one NAT egress address. Keying
  // the real quota on that address makes them throttle each other, which reads to the user
  // as Crosscode being broken rather than as a limit.
  it("does not throttle many distinct identities sharing one address", async () => {
    const store = {
      resolveMembership: async (userId: string, workspaceId: string) => ({
        memberId: `member-${userId}`, userId, actorId: userId, workspaceId, role: "member" as const
      }),
      listPresence: async () => []
    } as unknown as PgStore;
    const base = await listen(store);

    // Ten separate accounts, one shared source address, well past the old 300/min per-IP
    // bucket they would all have shared.
    for (let user = 0; user < 10; user += 1) {
      const accessToken = await signToken(`user-${user}`);
      for (let call = 0; call < 40; call += 1) {
        const response = await fetch(`${base}/v1/presence`, {
          headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
        });
        expect(response.status).toBe(200);
      }
    }
  });

  it("throttles a single identity once it exhausts its own budget", async () => {
    const store = {
      resolveMembership: async (userId: string, workspaceId: string) => ({
        memberId: `member-${userId}`, userId, actorId: userId, workspaceId, role: "member" as const
      }),
      listPresence: async () => []
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("noisy-user");
    const call = () => fetch(`${base}/v1/presence`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });

    let throttled = false;
    for (let attempt = 0; attempt < 700 && !throttled; attempt += 1) {
      throttled = (await call()).status === 429;
    }
    expect(throttled).toBe(true);

    // ...and a different account from the same address is untouched by that exhaustion.
    const otherToken = await signToken("quiet-user");
    const other = await fetch(`${base}/v1/presence`, {
      headers: { authorization: `Bearer ${otherToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });
    expect(other.status).toBe(200);
  });
});

describe("rate limiting behind a proxy", () => {
  // Every request from a load balancer shares one socket address, so without
  // trustProxy the whole deployment shares one bucket and runs into the 10/min
  // pairing-claim limit at once -- self-DoS, and the per-IP brute-force defense gone.
  const claimBody = { code: "ABCD-EFGH", actorId: "a", replicaName: "laptop", repoRoot: "/repo", repoRemote: null };

  it("keys on the last x-forwarded-for hop when a proxy is trusted", async () => {
    const store = {
      claimPairingCode: async () => ({ workspaceId: "workspace-1", replicaId: "replica-1", token: "ccw_token", pairingId: "3f1d5f1e-1e2b-4a7c-9f3d-2b6c7d8e9f01" }),
      attachReplicaToProject: async () => null
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { trustProxy: true });

    // A proxy appends the address it received the connection from, so the rightmost
    // entry is the real client and everything to its left is whatever the client itself
    // claimed. Here "10.0.0.1" is a spoofed prefix the client sent.
    const send = (clientIp: string) => fetch(`${base}/v1/pairing-codes/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.1, ${clientIp}` },
      body: JSON.stringify(claimBody)
    });

    // One client exhausts its own 10/min budget...
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await send("203.0.113.7")).status).toBe(200);
    expect((await send("203.0.113.7")).status).toBe(429);
    // ...and a different client behind the same proxy is unaffected, which is the whole
    // point: on the socket address they would have shared one bucket.
    expect((await send("203.0.113.8")).status).toBe(200);
  });

  it("cannot be evaded by a client prepending its own x-forwarded-for entries", async () => {
    const store = {
      claimPairingCode: async () => ({ workspaceId: "workspace-1", replicaId: "replica-1", token: "ccw_token", pairingId: "3f1d5f1e-1e2b-4a7c-9f3d-2b6c7d8e9f01" }),
      attachReplicaToProject: async () => null
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { trustProxy: true });

    // The same client rotating the spoofable left-hand entries every time.
    const send = (spoofed: string) => fetch(`${base}/v1/pairing-codes/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${spoofed}, 203.0.113.9` },
      body: JSON.stringify(claimBody)
    });

    for (let attempt = 0; attempt < 10; attempt += 1) expect((await send(`192.0.2.${attempt}`)).status).toBe(200);
    expect((await send("192.0.2.200")).status).toBe(429);
  });

  it("ignores x-forwarded-for when no proxy is trusted, so a client cannot rotate its own key", async () => {
    const store = {
      claimPairingCode: async () => ({ workspaceId: "workspace-1", replicaId: "replica-1", token: "ccw_token", pairingId: "3f1d5f1e-1e2b-4a7c-9f3d-2b6c7d8e9f01" }),
      attachReplicaToProject: async () => null
    } as unknown as PgStore;
    const base = await listen(store);

    const send = (clientIp: string) => fetch(`${base}/v1/pairing-codes/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": clientIp },
      body: JSON.stringify(claimBody)
    });

    for (let attempt = 0; attempt < 10; attempt += 1) expect((await send(`198.51.100.${attempt}`)).status).toBe(200);
    expect((await send("198.51.100.250")).status).toBe(429);
  });
});

describe("unexpected failures", () => {
  it("reports a 500 rather than swallowing it, while keeping the detail out of the response", async () => {
    const reported: unknown[] = [];
    const store = {
      resolveMembership: async () => membership,
      listPresence: async () => { throw new Error("connection terminated unexpectedly"); }
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { onError: (error) => reported.push(error) });
    const accessToken = await signToken(membership.userId);

    const response = await fetch(`${base}/v1/presence`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "Internal server error" });
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe("connection terminated unexpectedly");
  });

  it("does not report deliberate refusals as failures", async () => {
    const reported: unknown[] = [];
    const store = { resolveMembership: async () => membership } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { onError: (error) => reported.push(error) });
    const accessToken = await signToken(membership.userId);

    const response = await fetch(`${base}/v1/nope`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId }
    });

    expect(response.status).toBe(404);
    expect(reported).toHaveLength(0);
  });
});

describe("device and member revocation", () => {
  const owner: Membership = { ...membership, role: "owner" };

  it("lists and revokes a paired device's workspace token", async () => {
    const summary = {
      id: "11111111-1111-4111-8111-111111111111", workspaceId: owner.workspaceId, replicaId: "22222222-2222-4222-8222-222222222222",
      replicaName: "laptop", actorId: "actor-1", lastUsedAt: null, revokedAt: null, createdAt: "2026-01-01T00:00:00.000Z"
    };
    const store = {
      resolveMembership: async () => owner,
      listWorkspaceTokens: async () => [summary],
      revokeWorkspaceToken: async () => ({ ...summary, revokedAt: "2026-01-02T00:00:00.000Z" })
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(owner.userId);

    const list = await fetch(`${base}/v1/workspace-tokens`, {
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: owner.workspaceId }
    });
    expect((await list.json() as any).data.tokens).toHaveLength(1);

    const revoked = await fetch(`${base}/v1/workspace-tokens/${summary.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: owner.workspaceId }
    });
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as any).data.revokedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("refuses to let a workspace token revoke devices or remove members", async () => {
    const store = {
      resolveWorkspaceToken: async () => ({ ...owner, replicaId: "replica-1" })
    } as unknown as PgStore;
    const base = await listen(store);

    // A leaked terminal-side credential must not be able to retire its peers or itself
    // out of an audit trail: team management stays behind a real Supabase session.
    const list = await fetch(`${base}/v1/workspace-tokens`, { headers: { authorization: "Bearer ccw_leaked-token" } });
    expect(list.status).toBe(403);
    const remove = await fetch(`${base}/v1/members/33333333-3333-4333-8333-333333333333`, {
      method: "DELETE", headers: { authorization: "Bearer ccw_leaked-token" }
    });
    expect(remove.status).toBe(403);
  });

  it("refuses a non-owner and a malformed id", async () => {
    const store = { resolveMembership: async () => membership } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);
    const headers = { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId };

    expect((await fetch(`${base}/v1/workspace-tokens`, { headers })).status).toBe(403);

    const ownerStore = { resolveMembership: async () => owner } as unknown as PgStore;
    const ownerBase = await listen(ownerStore);
    const ownerToken = await signToken(owner.userId);
    const malformed = await fetch(`${ownerBase}/v1/members/not-a-uuid`, {
      method: "DELETE", headers: { authorization: `Bearer ${ownerToken}`, [WORKSPACE_HEADER]: owner.workspaceId }
    });
    expect(malformed.status).toBe(400);
  });
});

describe("plan limits", () => {
  it("answers 402, not 403, when only the plan is refusing", async () => {
    const store = {
      resolveMembership: async () => ({ ...membership, role: "owner" as const }),
      setWorkspaceAutonomyTier: async () => { throw new BillingLimitError("Plan 'free' does not unlock autonomy tier 'auto-always'"); }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken(membership.userId);

    const response = await fetch(`${base}/v1/workspace/autonomy`, {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membership.workspaceId, "content-type": "application/json" },
      body: JSON.stringify({ tier: 2 })
    });

    expect(response.status).toBe(402);
    // The message names the plan and the tier, so a client can say what to upgrade to.
    expect((await response.json() as any).error).toContain("auto-always");
  });

  // The workspace cap is enforced inside createWorkspace's transaction; what the boundary
  // owes a client is the same 402 the other billing limits answer, so a script farming
  // free workspaces can tell "you have run out" from "you may not" (403) or a bad request.
  it("answers 402 when the self-serve workspace cap refuses a create", async () => {
    const store = {
      createWorkspace: async () => {
        throw new BillingLimitError(`You already own ${MAX_SELF_SERVE_WORKSPACES_PER_USER} workspaces, which is the per-account limit`);
      }
    } as unknown as PgStore;
    const base = await listen(store);
    const accessToken = await signToken("farmer");

    const response = await post(base, "/v1/workspaces", { name: "farm-11" }, accessToken);
    expect(response.status).toBe(402);
    expect((await response.json() as any).error).toContain("per-account limit");
  });
});

describe("billing checkout, change, and cancel", () => {
  const owner: Membership = { ...membership, role: "owner", actorId: "owner@example.com" };

  it("creates a customer, links it, and hands back a hosted checkout URL", async () => {
    const linked: Array<[string, string, string]> = [];
    const store = {
      resolveMembership: async () => owner,
      getWorkspaceBilling: async () => billingRecord({}),
      countActiveMembers: async () => 3,
      linkStripeCustomer: async (workspaceId: string, customerId: string, memberId: string) => {
        linked.push([workspaceId, customerId, memberId]);
      }
    } as unknown as PgStore;
    const provider = fakeProvider();
    const base = await listen(store, undefined, undefined, { billing: { provider, webhookSecret: "whsec_test" } });

    const response = await post(base, "/v1/workspace/billing/checkout", { plan: "pro" }, await signToken(owner.userId), owner.workspaceId);

    expect(response.status).toBe(200);
    const body = (await response.json() as any).data;
    // Annual is what you get when you do not ask, and $5.00/month annually is $50.00.
    expect(body).toMatchObject({ mode: "checkout", plan: "pro", interval: "year", seats: 1, priceCents: 5_000, monthlyEquivalentCents: 500 });
    expect(body.url).toContain("pro");
    // The customer is attached before the redirect, so an abandoned checkout still leaves
    // the workspace with one customer rather than a fresh one on every attempt.
    expect(linked).toEqual([[owner.workspaceId, "cus_fake", owner.memberId]]);
  });

  it("bills team per active member and honors a larger up-front seat count", async () => {
    const store = {
      resolveMembership: async () => owner,
      getWorkspaceBilling: async () => billingRecord({}),
      countActiveMembers: async () => 4,
      linkStripeCustomer: async () => {}
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { billing: { provider: fakeProvider(), webhookSecret: "whsec_test" } });
    const accessToken = await signToken(owner.userId);

    const derived = await post(base, "/v1/workspace/billing/checkout", { plan: "team" }, accessToken, owner.workspaceId);
    expect((await derived.json() as any).data).toMatchObject({ seats: 4, priceCents: 4 * 5_000 });

    const bought = await post(base, "/v1/workspace/billing/checkout", { plan: "team", seats: 10 }, accessToken, owner.workspaceId);
    expect((await bought.json() as any).data).toMatchObject({ seats: 10, priceCents: 10 * 5_000 });

    // The quantity is a Stripe line-item quantity, so on a flat-priced plan it has to stay
    // 1 no matter what the client asks for -- otherwise `--seats 10` on Pro would quietly
    // buy ten Pro subscriptions.
    const flat = await post(base, "/v1/workspace/billing/checkout", { plan: "pro", seats: 10 }, accessToken, owner.workspaceId);
    expect((await flat.json() as any).data).toMatchObject({ seats: 1, priceCents: 5_000 });
  });

  it("moves an existing subscription in place, prorated, instead of selling a second one", async () => {
    const changes: unknown[] = [];
    const applied: unknown[] = [];
    const provider = fakeProvider({ changeSubscription: async (input: unknown) => { changes.push(input); } });
    const store = {
      resolveMembership: async () => owner,
      getWorkspaceBilling: async () => billingRecord({ plan: "pro", billingPlan: "pro", stripeSubscriptionId: "sub_1" }),
      countActiveMembers: async () => 1,
      applySubscriptionState: async (input: unknown) => {
        applied.push(input);
        return billingRecord({ plan: "essential", billingPlan: "essential" });
      }
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { billing: { provider, webhookSecret: "whsec_test" } });

    // A downgrade takes the same path as an upgrade: there is one subscription, and it moves.
    const response = await post(base, "/v1/workspace/billing/checkout", { plan: "essential", interval: "month" }, await signToken(owner.userId), owner.workspaceId);

    expect((await response.json() as any).data).toMatchObject({ mode: "updated", url: null, plan: "essential", interval: "month", priceCents: 250 });
    expect(changes).toEqual([{ subscriptionId: "sub_1", plan: "essential", interval: "month", seats: 1 }]);
    // Written straight away from the same authoritative re-read the webhook will do, so the
    // caller is not told "done" before the plan has actually moved.
    expect(applied).toHaveLength(1);
  });

  it("cancels at period end and says so, without touching workspace data", async () => {
    const cancelled: string[] = [];
    const provider = fakeProvider({ cancelSubscription: async (id: string) => { cancelled.push(id); } });
    const store = {
      resolveMembership: async () => owner,
      getWorkspaceBilling: async () => billingRecord({ plan: "pro", billingPlan: "pro", stripeSubscriptionId: "sub_1" }),
      applySubscriptionState: async () => billingRecord({
        plan: "pro", billingPlan: "pro", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-09-01T00:00:00.000Z"
      })
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { billing: { provider, webhookSecret: "whsec_test" } });

    const response = await post(base, "/v1/workspace/billing/cancel", {}, await signToken(owner.userId), owner.workspaceId);

    expect(cancelled).toEqual(["sub_1"]);
    // Still on pro: cancelling never takes the plan away mid-period.
    expect((await response.json() as any).data).toEqual({
      plan: "pro", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-09-01T00:00:00.000Z"
    });
  });

  it("refuses student self-serve, non-owners, workspace tokens, and unconfigured deployments", async () => {
    const store = {
      resolveMembership: async (userId: string) => (userId === "user-1" ? owner : membership),
      resolveWorkspaceToken: async () => ({ ...owner, replicaId: "replica-1" }),
      getWorkspaceBilling: async () => billingRecord({}),
      countActiveMembers: async () => 1,
      linkStripeCustomer: async () => {}
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { billing: { provider: fakeProvider(), webhookSecret: "whsec_test" } });
    const ownerToken = await signToken(owner.userId);

    // Student is Pro's limits at Essential's price; selling it self-serve is just a discount.
    const student = await post(base, "/v1/workspace/billing/checkout", { plan: "student" }, ownerToken, owner.workspaceId);
    expect(student.status).toBe(403);
    expect((await student.json() as any).error).toContain("verification");

    const member = await post(base, "/v1/workspace/billing/checkout", { plan: "pro" }, await signToken("user-2"), membership.workspaceId);
    expect(member.status).toBe(403);

    // A terminal-side credential must never be able to spend money.
    const token = await fetch(`${base}/v1/workspace/billing/checkout`, {
      method: "POST", headers: { authorization: "Bearer ccw_leaked-token", "content-type": "application/json" }, body: JSON.stringify({ plan: "pro" })
    });
    expect(token.status).toBe(403);

    // No provider configured: 503, not a fabricated URL.
    const unconfigured = await listen(store);
    expect((await post(unconfigured, "/v1/workspace/billing/checkout", { plan: "pro" }, ownerToken, owner.workspaceId)).status).toBe(503);
  });
});

describe("stripe webhook", () => {
  const secret = "whsec_test_secret";

  it("verifies the signature, reconciles from authoritative state, and ignores redeliveries", async () => {
    const claimed: string[] = [];
    const completed: Array<[string, string | null]> = [];
    const applied: any[] = [];
    let alreadyProcessed = false;
    const store = {
      claimBillingEvent: async (id: string) => {
        claimed.push(id);
        return !alreadyProcessed;
      },
      completeBillingEvent: async (id: string, workspaceId: string | null) => {
        completed.push([id, workspaceId]);
        alreadyProcessed = true;
      },
      findWorkspaceForBilling: async () => "11111111-1111-4111-8111-111111111111",
      applySubscriptionState: async (input: unknown) => {
        applied.push(input);
        return billingRecord({ plan: "pro", billingPlan: "pro" });
      }
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { billing: { provider: fakeProvider(), webhookSecret: secret } });
    const body = JSON.stringify({
      id: "evt_1", type: "customer.subscription.updated",
      data: { object: { id: "sub_1", object: "subscription", customer: "cus_1" } }
    });

    const first = await postSigned(base, body, secret);
    expect(first.status).toBe(200);
    expect((await first.json() as any).data).toEqual({ received: true, duplicate: false, applied: true });
    expect(applied).toHaveLength(1);
    expect(completed).toEqual([["evt_1", "11111111-1111-4111-8111-111111111111"]]);

    // Stripe redelivers freely; the second delivery must change nothing.
    const second = await postSigned(base, body, secret);
    expect((await second.json() as any).data).toEqual({ received: true, duplicate: true });
    expect(applied).toHaveLength(1);
    expect(claimed).toEqual(["evt_1", "evt_1"]);
  });

  it("refuses a forged signature, a tampered body, and a stale timestamp before any write", async () => {
    let claims = 0;
    const store = { claimBillingEvent: async () => { claims += 1; return true; } } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { billing: { provider: fakeProvider(), webhookSecret: secret } });
    const body = JSON.stringify({ id: "evt_2", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });

    expect((await postSigned(base, body, "whsec_wrong")).status).toBe(400);
    // Signed correctly, then edited in flight.
    const tampered = await fetch(`${base}/v1/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(body, secret) },
      body: body.replace("sub_1", "sub_2")
    });
    expect(tampered.status).toBe(400);
    // A genuine capture, replayed after the tolerance window.
    const stale = await fetch(`${base}/v1/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(body, secret, Math.floor(Date.now() / 1_000) - 3_600) },
      body
    });
    expect(stale.status).toBe(400);
    const unsigned = await fetch(`${base}/v1/webhooks/stripe`, {
      method: "POST", headers: { "content-type": "application/json" }, body
    });
    expect(unsigned.status).toBe(400);

    // Nothing reached the database on any of the four.
    expect(claims).toBe(0);
  });

  it("does not exist at all when no signing secret is configured", async () => {
    const store = { claimBillingEvent: async () => true } as unknown as PgStore;
    const withoutSecret = await listen(store, undefined, undefined, { billing: { provider: fakeProvider() } });
    const withoutBilling = await listen(store);
    const body = JSON.stringify({ id: "evt_3", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });

    // An unauthenticated route the service cannot verify anything about should not be
    // reachable, so its absence is a 404 rather than a weaker check.
    expect((await postSigned(withoutSecret, body, secret)).status).toBe(404);
    expect((await postSigned(withoutBilling, body, secret)).status).toBe(404);
  });

  it("acknowledges events it has no opinion about, so Stripe stops retrying them", async () => {
    const applied: unknown[] = [];
    const store = {
      claimBillingEvent: async () => true,
      completeBillingEvent: async () => {},
      findWorkspaceForBilling: async () => null,
      applySubscriptionState: async (input: unknown) => { applied.push(input); return billingRecord({}); }
    } as unknown as PgStore;
    const base = await listen(store, undefined, undefined, { billing: { provider: fakeProvider(), webhookSecret: secret } });
    const body = JSON.stringify({ id: "evt_4", type: "radar.early_fraud_warning.created", data: { object: { id: "issfr_1" } } });

    const response = await postSigned(base, body, secret);
    expect(response.status).toBe(200);
    expect((await response.json() as any).data).toEqual({ received: true, duplicate: false, applied: false });
    expect(applied).toEqual([]);
  });
});
