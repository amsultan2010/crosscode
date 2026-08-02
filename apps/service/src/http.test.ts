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
      registerReplica: async () => ({ replicaId: "replica-1", createdAt: "2026-01-01T00:00:00.000Z" }),
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
      listPresence: async () => [{ replicaId: "replica-1", actorId: membership.actorId, status: "online", lastSeenAt: "2026-01-01T00:00:00.000Z", cursor: 0 }]
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

function storedOperation(event: TransactionCreatedEvent): StoredOperation {
  return {
    id: event.id,
    eventId: event.id,
    workspaceId: event.workspaceId,
    senderReplicaId: event.replicaId,
    transaction: event.payload,
    serverSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    event: { ...event, serverSequence: 1 }
  };
}
