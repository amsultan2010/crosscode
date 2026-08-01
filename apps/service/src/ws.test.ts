import type { AddressInfo } from "node:net";
import type { HandoffRequestedEvent, IntentPublishedEvent, TransactionCreatedEvent, WsFanOutMessage, WsSubscribeAck } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createServiceServer } from "./http.js";
import type { Membership, PgStore, StoredOperation } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";
const WORKSPACE_HEADER = "x-crosscode-workspace-id";

const membershipA: Membership = {
  memberId: "member-1", userId: "user-a", actorId: "actor-1", workspaceId: "workspace-1", role: "member"
};
const membershipB: Membership = {
  memberId: "member-2", userId: "user-b", actorId: "actor-2", workspaceId: "workspace-1", role: "member"
};
const replicaA = "replica-a";
const replicaB = "replica-b";

const servers: ReturnType<typeof createServiceServer>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function membershipByUserId(userId: string): Membership {
  if (userId === membershipA.userId) return membershipA;
  if (userId === membershipB.userId) return membershipB;
  throw new Error("Unknown user");
}

describe("service WebSocket fan-out", () => {
  it("completes the subscribe handshake and returns the current cursor", async () => {
    const store = {
      resolveMembership: async (userId: string) => membershipByUserId(userId),
      assertReplicaOwnership: async () => {},
      getCursor: async () => 7,
      recordSessionStart: async () => {},
      recordSessionEnd: async () => {}
    } as unknown as PgStore;
    const base = await listen(store);
    const token = await signToken(membershipA.userId);
    const { socket, first } = await connect(base, membershipA, replicaA, token);
    expect(first).toEqual({ type: "subscribed", cursor: 7 });
    socket.close();
  });

  it("rejects a subscribe handshake with an invalid access token", async () => {
    const store = {
      resolveMembership: async (userId: string) => membershipByUserId(userId),
      assertReplicaOwnership: async () => {},
      getCursor: async () => 0,
      recordSessionStart: async () => {},
      recordSessionEnd: async () => {}
    } as unknown as PgStore;
    const base = await listen(store);
    const socket = openSocket(base);
    const closeCode = await new Promise<number>((resolve) => {
      socket.once("open", () => socket.send(JSON.stringify({
        type: "subscribe", workspaceId: membershipA.workspaceId, replicaId: replicaA, accessToken: "not-a-real-token"
      })));
      socket.once("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1008);
  });

  it("broadcasts presence online and offline to other connected replicas", async () => {
    const store = {
      resolveMembership: async (userId: string) => membershipByUserId(userId),
      assertReplicaOwnership: async () => {},
      getCursor: async () => 0,
      recordSessionStart: async () => {},
      recordSessionEnd: async () => {}
    } as unknown as PgStore;
    const base = await listen(store);
    const tokenA = await signToken(membershipA.userId);
    const tokenB = await signToken(membershipB.userId);
    const { socket: socketA } = await connect(base, membershipA, replicaA, tokenA);

    const onlineMessage = nextMessage(socketA);
    const { socket: socketB } = await connect(base, membershipB, replicaB, tokenB);
    expect(await onlineMessage).toEqual({
      type: "presence",
      presence: { replicaId: replicaB, actorId: membershipB.actorId, status: "online", lastSeenAt: expect.any(String) }
    });

    const offlineMessage = nextMessage(socketA);
    socketB.close();
    expect(await offlineMessage).toEqual({
      type: "presence",
      presence: { replicaId: replicaB, actorId: membershipB.actorId, status: "offline", lastSeenAt: expect.any(String) }
    });
  });

  it("fans out a live operation to other replicas while excluding the sender", async () => {
    const event = makeEvent();
    const operation = storedOperation(event);
    const store = {
      resolveMembership: async (userId: string) => membershipByUserId(userId),
      assertReplicaOwnership: async () => {},
      getCursor: async () => 0,
      appendOperation: async () => operation,
      recordSessionStart: async () => {},
      recordSessionEnd: async () => {}
    } as unknown as PgStore;
    const base = await listen(store);
    const tokenA = await signToken(membershipA.userId);
    const tokenB = await signToken(membershipB.userId);
    const { socket: socketA } = await connect(base, membershipA, replicaA, tokenA);
    const { socket: socketB } = await connect(base, membershipB, replicaB, tokenB);
    await nextMessage(socketA); // presence.online for replica-b, ignored here

    const senderMessage = nextMessage(socketA);
    const receiverMessage = nextMessage(socketB);
    let senderSawMessage = false;
    senderMessage.then(() => { senderSawMessage = true; });

    const httpBase = base.replace("ws://", "http://");
    const accessToken = await signToken(membershipA.userId);
    const response = await fetch(`${httpBase}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membershipA.workspaceId },
      body: JSON.stringify({ event })
    });
    expect(response.status).toBe(200);

    const fanOut = await receiverMessage as WsFanOutMessage;
    expect(fanOut).toEqual({ type: "operation", operation: expect.objectContaining({ id: operation.id }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(senderSawMessage).toBe(false);
  });

  it("fans out a live handoff and intent to other replicas while excluding the sender", async () => {
    const handoffEvent = makeHandoffEvent();
    const remoteHandoff = { eventId: handoffEvent.id, workspaceId: membershipA.workspaceId, senderReplicaId: replicaA, handoff: handoffEvent.payload, updatedAt: "2026-01-01T00:00:01.000Z" };
    const intentEvent = makeIntentEvent();
    const remoteIntent = { eventId: intentEvent.id, workspaceId: membershipA.workspaceId, senderReplicaId: replicaA, intent: intentEvent.payload, updatedAt: "2026-01-01T00:00:01.000Z" };
    const store = {
      resolveMembership: async (userId: string) => membershipByUserId(userId),
      assertReplicaOwnership: async () => {},
      getCursor: async () => 0,
      recordSessionStart: async () => {},
      recordSessionEnd: async () => {},
      upsertHandoff: async () => remoteHandoff,
      upsertIntent: async () => remoteIntent
    } as unknown as PgStore;
    const base = await listen(store);
    const tokenA = await signToken(membershipA.userId);
    const tokenB = await signToken(membershipB.userId);
    const { socket: socketA } = await connect(base, membershipA, replicaA, tokenA);
    const { socket: socketB } = await connect(base, membershipB, replicaB, tokenB);
    await nextMessage(socketA); // presence.online for replica-b, ignored here

    const httpBase = base.replace("ws://", "http://");
    const accessToken = await signToken(membershipA.userId);

    const handoffReceiverMessage = nextMessage(socketB);
    const handoffResponse = await fetch(`${httpBase}/v1/handoffs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membershipA.workspaceId },
      body: JSON.stringify({ event: handoffEvent })
    });
    expect(handoffResponse.status).toBe(200);
    expect(await handoffReceiverMessage).toEqual({ type: "handoff", handoff: expect.objectContaining({ handoff: expect.objectContaining({ id: handoffEvent.id }) }) });

    const intentReceiverMessage = nextMessage(socketB);
    const intentResponse = await fetch(`${httpBase}/v1/intents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, [WORKSPACE_HEADER]: membershipA.workspaceId },
      body: JSON.stringify({ event: intentEvent })
    });
    expect(intentResponse.status).toBe(200);
    expect(await intentReceiverMessage).toEqual({ type: "intent", intent: expect.objectContaining({ intent: expect.objectContaining({ id: intentEvent.id }) }) });
  });
});

async function signToken(userId: string): Promise<string> {
  return signTestSupabaseToken(supabaseUrl, { sub: userId });
}

async function listen(store: PgStore): Promise<string> {
  const server = createServiceServer({ store, jwks: await testSupabaseJwks(), supabaseUrl });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function openSocket(base: string): WebSocket {
  const socket = new WebSocket(`${base}/v1/stream`);
  sockets.push(socket);
  return socket;
}

async function connect(base: string, membership: Membership, replicaId: string, accessToken: string): Promise<{ socket: WebSocket; first: WsSubscribeAck }> {
  const socket = openSocket(base);
  const first = await new Promise<WsSubscribeAck>((resolve, reject) => {
    socket.once("open", () => socket.send(JSON.stringify({
      type: "subscribe", workspaceId: membership.workspaceId, replicaId, accessToken
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
    workspaceId: membershipA.workspaceId,
    replicaId: replicaA,
    actorId: membershipA.actorId,
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

function makeHandoffEvent(): HandoffRequestedEvent {
  return {
    id: "handoff-1",
    schemaVersion: 1,
    workspaceId: membershipA.workspaceId,
    replicaId: replicaA,
    actorId: membershipA.actorId,
    type: "handoff.requested",
    clientSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { id: "handoff-1", operationId: "operation-1", requestedBy: membershipA.actorId, status: "pending", createdAt: "2026-01-01T00:00:00.000Z" }
  };
}

function makeIntentEvent(): IntentPublishedEvent {
  return {
    id: "intent-1",
    schemaVersion: 1,
    workspaceId: membershipA.workspaceId,
    replicaId: replicaA,
    actorId: membershipA.actorId,
    type: "intent.published",
    clientSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { id: "intent-1", actorId: membershipA.actorId, text: "Rename foo to bar", createdAt: "2026-01-01T00:00:00.000Z" }
  };
}
