import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Change, WsSyncServerMessage } from "@crosscode/protocol";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { StoreUnauthorizedError, type PgStore } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";
import { attachWebSocketGateway, type WebSocketGateway } from "./ws.js";

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";
const projectId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const replicaA = "9a1e8b7c-1111-4222-8333-444455556666";
const replicaB = "9a1e8b7c-2222-4333-8444-555566667777";
const userId = "5c9f2a10-2222-4333-8444-555566667777";

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function change(sequence: number, replicaId: string): Change {
  return {
    sequence,
    projectId,
    branch: "main",
    replicaId,
    createdAt: "2026-01-01T00:00:00.000Z",
    version: { path: `src/${sequence}.ts`, op: "modify", baseHash: null, contentHash: `h${sequence}`, content: "x", encoding: "utf8" }
  };
}

/** A store that answers the handshake and replays a fixed history. */
function storeWith(history: Change[]): PgStore {
  return {
    requireMembership: async () => ({ projectId, userId, role: "member" as const, repo: "acme/app" }),
    touchReplica: async () => ({ branch: "main" }),
    listChanges: async ({ since }: { since: number }) => ({
      status: "ok" as const,
      changes: history.filter((entry) => entry.sequence > since),
      cursor: history.at(-1)?.sequence ?? since
    })
  } as unknown as PgStore;
}

describe("service WebSocket gateway", () => {
  it("replays everything after the subscriber's cursor, then pushes live changes", async () => {
    const { base, gateway } = await listen(storeWith([change(1, replicaB), change(2, replicaB), change(3, replicaB)]));
    const socket = await connect(base, { replicaId: replicaA, since: 1 });

    expect(await nextChange(socket)).toMatchObject({ sequence: 2 });
    expect(await nextChange(socket)).toMatchObject({ sequence: 3 });

    gateway.broadcastChanges(projectId, "main", [change(4, replicaB)], replicaB);
    expect(await nextChange(socket)).toMatchObject({ sequence: 4 });
  });

  it("never echoes a change back to the replica that sent it", async () => {
    const { base, gateway } = await listen(storeWith([]));
    const sender = await connect(base, { replicaId: replicaA, since: 0 });
    const peer = await connect(base, { replicaId: replicaB, since: 0 });

    gateway.broadcastChanges(projectId, "main", [change(1, replicaA)], replicaA);

    expect(await nextChange(peer)).toMatchObject({ sequence: 1, replicaId: replicaA });
    await expect(nextChange(sender, 150)).rejects.toThrow(/timed out/);
  });

  it("keeps a room to one project and branch", async () => {
    const { base, gateway } = await listen(storeWith([]));
    const socket = await connect(base, { replicaId: replicaA, since: 0 });

    gateway.broadcastChanges(projectId, "feature", [change(1, replicaB)], replicaB);
    gateway.broadcastChanges("11111111-2222-4333-8444-555566667777", "main", [change(2, replicaB)], replicaB);
    gateway.broadcastChanges(projectId, "main", [change(3, replicaB)], replicaB);

    // Only the change published into this replica's own room arrives, and it arrives first.
    expect(await nextChange(socket)).toMatchObject({ sequence: 3 });
  });

  it("tells each replica who else is in the room, from memory alone", async () => {
    const { base } = await listen(storeWith([]));
    const first = await connect(base, { replicaId: replicaA, since: 0 });
    const second = await connect(base, { replicaId: replicaB, since: 0 });

    // A subscribes to an empty room, then sees B arrive.
    expect(await nextPresence(first)).toEqual([]);
    expect(await nextPresence(first)).toEqual([expect.objectContaining({ replicaId: replicaB })]);

    second.send(JSON.stringify({
      type: "presence",
      peers: [{ replicaId: replicaB, actor: userId, branch: "main", paths: ["src/billing.ts"] }]
    }));
    // ...and gains the paths B says it is working on when B reports them.
    expect(await nextPresence(first)).toEqual([expect.objectContaining({ paths: ["src/billing.ts"] })]);

    second.close();
    expect(await nextPresence(first)).toEqual([]);
  });

  it("refuses an upgrade without a valid token and a subscribe for somebody else's replica", async () => {
    const { base } = await listen(storeWith([]));
    await expect(open(base, undefined)).rejects.toThrow(/401/);
    await expect(open(base, "not-a-real-token")).rejects.toThrow(/401/);

    const foreign = {
      requireMembership: async () => ({ projectId, userId, role: "member" as const, repo: "acme/app" }),
      touchReplica: async () => { throw new StoreUnauthorizedError("Replica is not registered to this user"); }
    } as unknown as PgStore;
    const other = await listen(foreign);
    const socket = await open(other.base, await signToken());
    socket.send(JSON.stringify({ type: "subscribe", projectId, branch: "main", replicaId: replicaA, since: 0 }));
    expect(await nextMessage(socket)).toEqual({ type: "error", message: "Subscription rejected" });
  });
});

async function listen(store: PgStore): Promise<{ base: string; gateway: WebSocketGateway }> {
  const server = createServer();
  const gateway = attachWebSocketGateway(server, { store, jwks: await testSupabaseJwks(), supabaseUrl });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { base: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, gateway };
}

function signToken(): Promise<string> {
  return signTestSupabaseToken(supabaseUrl, { sub: userId });
}

/** Opens the socket, or rejects with the upgrade's refusal. */
async function open(base: string, token: string | undefined): Promise<WebSocket> {
  const socket = new WebSocket(`${base}/v1/stream`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("unexpected-response", (_request, response) => reject(new Error(`upgrade refused with ${response.statusCode}`)));
    socket.once("error", reject);
  });
  return socket;
}

/**
 * Subscribes and waits until the server has registered the connection, which it announces
 * by broadcasting the room's presence. Without that wait a broadcast fired straight after
 * this call could beat the registration and the test would race the gateway.
 */
async function connect(base: string, input: { replicaId: string; since: number }): Promise<WebSocket> {
  const socket = await open(base, await signToken());
  socket.send(JSON.stringify({ type: "subscribe", projectId, branch: "main", replicaId: input.replicaId, since: input.since }));
  await poll(socket, () => inbox(socket).some((message) => message.type === "presence"), 2_000);
  return socket;
}

/**
 * Everything the server has sent this socket, in order. Buffered rather than awaited one
 * listener at a time, because a presence broadcast can land between two changes and
 * dropping it would make the next assertion flaky.
 */
const inboxes = new WeakMap<WebSocket, WsSyncServerMessage[]>();

function inbox(socket: WebSocket): WsSyncServerMessage[] {
  let messages = inboxes.get(socket);
  if (!messages) {
    messages = [];
    inboxes.set(socket, messages);
    socket.on("message", (data) => messages!.push(JSON.parse(data.toString()) as WsSyncServerMessage));
  }
  return messages;
}

function poll(socket: WebSocket, ready: () => boolean, timeoutMs: number): Promise<void> {
  inbox(socket);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for a message"));
      }
    }, 5);
  });
}

async function nextMessage(socket: WebSocket, timeoutMs = 2_000): Promise<WsSyncServerMessage> {
  await poll(socket, () => inbox(socket).length > 0, timeoutMs);
  return inbox(socket).shift()!;
}

async function nextChange(socket: WebSocket, timeoutMs = 2_000): Promise<Change> {
  for (;;) {
    const message = await nextMessage(socket, timeoutMs);
    if (message.type === "change") return message.change;
    if (message.type === "error") throw new Error(message.message);
  }
}

async function nextPresence(socket: WebSocket, timeoutMs = 2_000): Promise<unknown[]> {
  for (;;) {
    const message = await nextMessage(socket, timeoutMs);
    if (message.type === "presence") return message.peers;
  }
}
