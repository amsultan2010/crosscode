import type { AddressInfo } from "node:net";
import type { TransactionCreatedEvent, WsFanOutMessage, WsSubscribeAck } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { issueAccessToken, type AccessClaims } from "./auth.js";
import { createServiceServer } from "./http.js";
import type { PgStore, StoredOperation } from "./store.js";

const jwtSecret = "service-ws-test-secret-with-at-least-32-bytes-long";
const claimsA: AccessClaims = {
  memberId: "member-1", actorId: "actor-1", workspaceId: "workspace-1",
  replicaId: "replica-a", role: "member", tokenVersion: 1
};
const claimsB: AccessClaims = {
  memberId: "member-2", actorId: "actor-2", workspaceId: "workspace-1",
  replicaId: "replica-b", role: "member", tokenVersion: 1
};

const servers: ReturnType<typeof createServiceServer>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("service WebSocket fan-out", () => {
  it("completes the subscribe handshake and returns the current cursor", async () => {
    const store = {
      reauthorize: async (claims: AccessClaims) => claims,
      getCursor: async () => 7
    } as unknown as PgStore;
    const base = await listen(store);
    const token = await issueAccessToken(claimsA, jwtSecret);
    const { socket, first } = await connect(base, claimsA, token);
    expect(first).toEqual({ type: "subscribed", cursor: 7 });
    socket.close();
  });

  it("rejects a subscribe handshake with an invalid access token", async () => {
    const store = { reauthorize: async (claims: AccessClaims) => claims, getCursor: async () => 0 } as unknown as PgStore;
    const base = await listen(store);
    const socket = openSocket(base);
    const closeCode = await new Promise<number>((resolve) => {
      socket.once("open", () => socket.send(JSON.stringify({
        type: "subscribe", workspaceId: claimsA.workspaceId, replicaId: claimsA.replicaId, accessToken: "not-a-real-token"
      })));
      socket.once("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1008);
  });

  it("broadcasts presence online and offline to other connected replicas", async () => {
    const store = { reauthorize: async (claims: AccessClaims) => claims, getCursor: async () => 0 } as unknown as PgStore;
    const base = await listen(store);
    const tokenA = await issueAccessToken(claimsA, jwtSecret);
    const tokenB = await issueAccessToken(claimsB, jwtSecret);
    const { socket: socketA } = await connect(base, claimsA, tokenA);

    const onlineMessage = nextMessage(socketA);
    const { socket: socketB } = await connect(base, claimsB, tokenB);
    expect(await onlineMessage).toEqual({
      type: "presence",
      presence: { replicaId: claimsB.replicaId, actorId: claimsB.actorId, status: "online", lastSeenAt: expect.any(String) }
    });

    const offlineMessage = nextMessage(socketA);
    socketB.close();
    expect(await offlineMessage).toEqual({
      type: "presence",
      presence: { replicaId: claimsB.replicaId, actorId: claimsB.actorId, status: "offline", lastSeenAt: expect.any(String) }
    });
  });

  it("fans out a live operation to other replicas while excluding the sender", async () => {
    const event = makeEvent();
    const operation = storedOperation(event);
    const store = {
      reauthorize: async (claims: AccessClaims) => claims,
      getCursor: async () => 0,
      appendOperation: async () => operation
    } as unknown as PgStore;
    const base = await listen(store);
    const tokenA = await issueAccessToken(claimsA, jwtSecret);
    const tokenB = await issueAccessToken(claimsB, jwtSecret);
    const { socket: socketA } = await connect(base, claimsA, tokenA);
    const { socket: socketB } = await connect(base, claimsB, tokenB);
    await nextMessage(socketA); // presence.online for replica-b, ignored here

    const senderMessage = nextMessage(socketA);
    const receiverMessage = nextMessage(socketB);
    let senderSawMessage = false;
    senderMessage.then(() => { senderSawMessage = true; });

    const httpBase = base.replace("ws://", "http://");
    const accessToken = await issueAccessToken(claimsA, jwtSecret);
    const response = await fetch(`${httpBase}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ event })
    });
    expect(response.status).toBe(200);

    const fanOut = await receiverMessage as WsFanOutMessage;
    expect(fanOut).toEqual({ type: "operation", operation: expect.objectContaining({ id: operation.id }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(senderSawMessage).toBe(false);
  });
});

async function listen(store: PgStore): Promise<string> {
  const server = createServiceServer({ store, jwtSecret });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function openSocket(base: string): WebSocket {
  const socket = new WebSocket(`${base}/v1/stream`);
  sockets.push(socket);
  return socket;
}

async function connect(base: string, claims: AccessClaims, accessToken: string): Promise<{ socket: WebSocket; first: WsSubscribeAck }> {
  const socket = openSocket(base);
  const first = await new Promise<WsSubscribeAck>((resolve, reject) => {
    socket.once("open", () => socket.send(JSON.stringify({
      type: "subscribe", workspaceId: claims.workspaceId, replicaId: claims.replicaId, accessToken
    })));
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
  return { socket, first };
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

function makeEvent(): TransactionCreatedEvent {
  return {
    id: "operation-1",
    schemaVersion: 1,
    workspaceId: claimsA.workspaceId,
    replicaId: claimsA.replicaId,
    actorId: claimsA.actorId,
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
