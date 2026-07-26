import type { AddressInfo } from "node:net";
import type { TransactionCreatedEvent } from "@crosscode/protocol";
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
