import type { AddressInfo } from "node:net";
import type { HandoffRequestedEvent, IntentPublishedEvent, TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { afterEach, describe, expect, it } from "vitest";
import { createServiceServer } from "./http.js";
import type { Membership, PgStore, StoredOperation } from "./store.js";
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
      listOperations: async () => ({ items: [operation], nextCursor: 1, hasMore: false })
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
      listOperations: async () => ({ items: [attributed, unattributed], nextCursor: 2, hasMore: false }),
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

  it("lists every workspace a user belongs to, for the dashboard's team switcher", async () => {
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

  it("mints and polls a pairing code, and claims it unauthenticated with a null projectId", async () => {
    const { StoreGoneError } = await import("./store.js");
    const pairingId = "3f1d5f1e-1e2b-4a7c-9f3d-2b6c7d8e9f01";
    const store = {
      resolveMembership: async () => membership,
      createPairingCode: async () => ({ pairingId, code: "K4T9-2WQZ", expiresAt: "2026-08-01T12:15:00.000Z" }),
      getPairingCodeStatus: async (_identity: Membership, id: string) => id === pairingId
        ? { status: "pending" as const, claimedAt: null, replicaId: null, actorId: null }
        : undefined,
      claimPairingCode: async (input: { code: string }) => {
        if (input.code !== "K4T9-2WQZ") throw new StoreGoneError("Pairing code is no longer available");
        return { workspaceId: membership.workspaceId, replicaId: "replica-9", token: "ccw_opaque-token" };
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
    expect(await polled.json()).toEqual({ ok: true, data: { status: "pending", claimedAt: null, replicaId: null, actorId: null } });

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
      data: { workspaceId: membership.workspaceId, replicaId: "replica-9", token: "ccw_opaque-token", projectId: null }
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
      pool: {
        query: async (sql: string) => {
          if (sql.includes("FROM workspaces")) return { rows: [{ plan: "unlimited" }] };
          if (sql.includes("FROM members")) return { rows: [{ count: "2" }] };
          return { rows: [] };
        }
      }
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
        autonomyTiers: ["always-ask", "auto-if-clean", "auto-always"]
      }
    });
  });
});

async function signToken(userId: string): Promise<string> {
  return signTestSupabaseToken(supabaseUrl, { sub: userId });
}

async function listen(store: PgStore, bodyLimitBytes?: number): Promise<string> {
  const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl, bodyLimitBytes });
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
