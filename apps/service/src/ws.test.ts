import type { AddressInfo } from "node:net";
import type { TransactionCreatedEvent, WsFanOutMessage, WsSubscribeAck } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createServiceServer } from "./http.js";
import { StoreUnauthorizedError, type Membership, type PgStore, type StoredOperation } from "./store.js";
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
      assertReplicaOwnership: async () => null,
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
      assertReplicaOwnership: async () => null,
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
      assertReplicaOwnership: async () => null,
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
      presence: { replicaId: replicaB, actorId: membershipB.actorId, status: "online", lastSeenAt: expect.any(String), projectId: null }
    });

    const offlineMessage = nextMessage(socketA);
    socketB.close();
    expect(await offlineMessage).toEqual({
      type: "presence",
      presence: { replicaId: replicaB, actorId: membershipB.actorId, status: "offline", lastSeenAt: expect.any(String), projectId: null }
    });
  });

  it("fans out a live operation to other replicas while excluding the sender", async () => {
    const event = makeEvent();
    const operation = storedOperation(event);
    const store = {
      resolveMembership: async (userId: string) => membershipByUserId(userId),
      assertReplicaOwnership: async () => null,
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

  // Regression: project attribution has to survive the wire, not just reach the database.
  // The consumer here is a real WebSocket client reading the fan-out frame it receives.
  it("carries projectId through the live operation and presence fan-out", async () => {
    const projectId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const event = makeEvent();
    const store = {
      resolveMembership: async (userId: string) => membershipByUserId(userId),
      assertReplicaOwnership: async () => projectId,
      getCursor: async () => 0,
      appendOperation: async () => storedOperation(event, projectId),
      recordSessionStart: async () => {},
      recordSessionEnd: async () => {}
    } as unknown as PgStore;
    const base = await listen(store);
    const tokenA = await signToken(membershipA.userId);
    const tokenB = await signToken(membershipB.userId);
    const { socket: socketA } = await connect(base, membershipA, replicaA, tokenA);

    // Presence: B coming online is attributed to its project for A.
    const onlineMessage = nextMessage(socketA);
    const { socket: socketB } = await connect(base, membershipB, replicaB, tokenB);
    expect(await onlineMessage).toEqual({
      type: "presence",
      presence: { replicaId: replicaB, actorId: membershipB.actorId, status: "online", lastSeenAt: expect.any(String), projectId }
    });

    // Operation: the edit A publishes reaches B tagged with the project.
    const receiverMessage = nextMessage(socketB);
    const httpBase = base.replace("ws://", "http://");
    const response = await fetch(`${httpBase}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}`, [WORKSPACE_HEADER]: membershipA.workspaceId },
      body: JSON.stringify({ event })
    });
    expect(response.status).toBe(200);
    const fanOut = await receiverMessage as WsFanOutMessage;
    expect(fanOut.type).toBe("operation");
    expect(fanOut).toEqual({ type: "operation", operation: expect.objectContaining({ id: event.id, projectId }) });

    // Offline is attributed too, from the id captured at handshake.
    const offlineMessage = nextMessage(socketA);
    socketB.close();
    expect(await offlineMessage).toEqual({
      type: "presence",
      presence: { replicaId: replicaB, actorId: membershipB.actorId, status: "offline", lastSeenAt: expect.any(String), projectId }
    });
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

describe("session bookkeeping failures", () => {
  it("survives a store failure while closing a socket instead of crashing the process", async () => {
    const store = {
      resolveMembership: async (userId: string) => membershipByUserId(userId),
      assertReplicaOwnership: async () => null,
      getCursor: async () => 1,
      recordSessionStart: async () => {},
      // The socket is already gone by the time this runs, so there is nobody to report
      // to -- but an unhandled rejection here used to take the whole service down.
      recordSessionEnd: async () => { throw new Error("connection terminated unexpectedly"); }
    } as unknown as PgStore;
    const base = await listen(store);
    const token = await signToken(membershipA.userId);
    const { socket } = await connect(base, membershipA, replicaA, token);

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
