import type { AddressInfo } from "node:net";
import type { HandoffRequestedEvent, IntentPublishedEvent, TransactionCreatedEvent } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { afterEach, describe, expect, it } from "vitest";
import type { AccessClaims } from "./auth.js";
import { createServiceServer } from "./http.js";
import type { PgStore, StoredOperation } from "./store.js";

const jwtSecret = "service-http-test-secret-with-at-least-32-bytes";
const claims: AccessClaims = {
  memberId: "member-1",
  actorId: "actor-1",
  workspaceId: "workspace-1",
  replicaId: "replica-1",
  role: "member",
  tokenVersion: 1
};
const servers: ReturnType<typeof createServiceServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("service HTTP boundary", () => {
  it("enrolls, exchanges tokens, ingests idempotently, and reads a cursor", async () => {
    const operation = storedOperation(makeEvent());
    const store = {
      enroll: async () => ({ claims, replicaSecret: "replica-secret" }),
      authenticateReplica: async () => claims,
      reauthorize: async () => claims,
      appendOperation: async () => operation,
      listOperations: async () => ({ items: [operation], nextCursor: 1, hasMore: false })
    } as unknown as PgStore;
    const base = await listen(store);
    const enrollmentCredential = "one-time-token";

    const enrollment = await post(base, "/v1/enroll", { token: enrollmentCredential });
    expect(enrollment.status).toBe(201);
    const enrollmentBody = await enrollment.json() as any;
    expect(enrollmentBody.data).toMatchObject({
      principal: { workspaceId: claims.workspaceId, replicaId: claims.replicaId },
      replicaSecret: "replica-secret"
    });

    const exchange = await post(base, "/v1/token", {
      workspaceId: claims.workspaceId,
      actorId: claims.actorId,
      replicaId: claims.replicaId,
      replicaSecret: "replica-secret"
    });
    const accessToken = ((await exchange.json()) as any).data.accessToken;
    const receipt = await post(base, "/v1/events", { event: makeEvent() }, accessToken);
    expect(await receipt.json()).toEqual({
      ok: true,
      data: { eventId: "operation-1", operationId: "operation-1", serverSequence: 1 }
    });
    const secretEvent = makeEvent();
    secretEvent.id = "secret-operation";
    secretEvent.payload = { ...secretEvent.payload, id: secretEvent.id, changes: [{ path: ".env", kind: "add", afterContent: "TOKEN=value", afterHash: contentHash("TOKEN=value") }] };
    expect((await post(base, "/v1/events", { event: secretEvent }, accessToken)).status).toBe(400);
    const forgedEvent = makeEvent();
    forgedEvent.id = "forged-operation";
    forgedEvent.payload = { ...forgedEvent.payload, id: forgedEvent.id, changes: [{ path: "safe.txt", kind: "add", afterContent: "actual", afterHash: "forged" }] };
    expect((await post(base, "/v1/events", { event: forgedEvent }, accessToken)).status).toBe(400);

    const cursor = await fetch(`${base}/v1/operations?afterSequence=0`, {
      headers: { authorization: `Bearer ${accessToken}` }
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
      workspaceId: claims.workspaceId,
      replicaId: claims.replicaId,
      actorId: claims.actorId,
      type: "handoff.requested",
      clientSequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        id: "handoff-1",
        operationId: "operation-1",
        requestedBy: claims.actorId,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    };
    const intentEvent: IntentPublishedEvent = {
      id: "intent-1",
      schemaVersion: 1,
      workspaceId: claims.workspaceId,
      replicaId: claims.replicaId,
      actorId: claims.actorId,
      type: "intent.published",
      clientSequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { id: "intent-1", actorId: claims.actorId, text: "Rename foo to bar", createdAt: "2026-01-01T00:00:00.000Z" }
    };
    const remoteHandoff = { eventId: handoffEvent.id, workspaceId: claims.workspaceId, senderReplicaId: claims.replicaId, handoff: handoffEvent.payload, updatedAt: "2026-01-01T00:00:01.000Z" };
    const remoteIntent = { eventId: intentEvent.id, workspaceId: claims.workspaceId, senderReplicaId: claims.replicaId, intent: intentEvent.payload, updatedAt: "2026-01-01T00:00:01.000Z" };
    const store = {
      enroll: async () => ({ claims, replicaSecret: "replica-secret" }),
      authenticateReplica: async () => claims,
      reauthorize: async () => claims,
      upsertHandoff: async () => remoteHandoff,
      listHandoffs: async () => ({ items: [remoteHandoff], nextCursor: remoteHandoff.updatedAt }),
      upsertIntent: async () => remoteIntent,
      listIntents: async () => ({ items: [remoteIntent], nextCursor: remoteIntent.updatedAt }),
      listPresence: async () => [{ replicaId: claims.replicaId, actorId: claims.actorId, status: "online", lastSeenAt: "2026-01-01T00:00:00.000Z", cursor: 0 }]
    } as unknown as PgStore;
    const base = await listen(store);
    const exchange = await post(base, "/v1/token", {
      workspaceId: claims.workspaceId, actorId: claims.actorId, replicaId: claims.replicaId, replicaSecret: "replica-secret"
    });
    const accessToken = ((await exchange.json()) as any).data.accessToken;

    const handoffReceipt = await post(base, "/v1/handoffs", { event: handoffEvent }, accessToken);
    expect(await handoffReceipt.json()).toEqual({ ok: true, data: { eventId: "handoff-1", handoffId: "handoff-1", updatedAt: remoteHandoff.updatedAt } });

    const handoffList = await fetch(`${base}/v1/handoffs?after=1970-01-01T00:00:00.000Z`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect((await handoffList.json()) as any).toMatchObject({ ok: true, data: { handoffs: [{ handoff: { id: "handoff-1" } }] } });

    const intentReceipt = await post(base, "/v1/intents", { event: intentEvent }, accessToken);
    expect(await intentReceipt.json()).toEqual({ ok: true, data: { eventId: "intent-1", intentId: "intent-1", updatedAt: remoteIntent.updatedAt } });

    const intentList = await fetch(`${base}/v1/intents?after=1970-01-01T00:00:00.000Z`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect((await intentList.json()) as any).toMatchObject({ ok: true, data: { intents: [{ intent: { id: "intent-1" } }] } });

    const presence = await fetch(`${base}/v1/presence`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect((await presence.json()) as any).toMatchObject({
      ok: true,
      data: { sessions: [{ replicaId: claims.replicaId, status: "online", cursor: 0 }] }
    });
  });

  it("enforces JSON bodies, body caps, authentication, and principal binding", async () => {
    const store = {
      reauthorize: async () => claims,
      appendOperation: async () => storedOperation(makeEvent())
    } as unknown as PgStore;
    const base = await listen(store, 128);
    expect((await fetch(`${base}/v1/operations`)).status).toBe(401);
    expect((await fetch(`${base}/v1/enroll`, { method: "POST", body: "{}" })).status).toBe(415);
    expect((await post(base, "/v1/enroll", { token: "x", extra: true })).status).toBe(400);
    expect((await post(base, "/v1/enroll", { token: "x".repeat(200) })).status).toBe(413);
  });
});

async function listen(store: PgStore, bodyLimitBytes?: number): Promise<string> {
  const server = createServiceServer({ store, jwtSecret, bodyLimitBytes });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(base: string, path: string, body: unknown, accessToken?: string) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function makeEvent(): TransactionCreatedEvent {
  return {
    id: "operation-1",
    schemaVersion: 1,
    workspaceId: claims.workspaceId,
    replicaId: claims.replicaId,
    actorId: claims.actorId,
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
