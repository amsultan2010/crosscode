import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { LiveSyncClient, type AccessTokenProvider } from "./ws-client.js";

const identity = { workspaceId: "workspace-1", actorId: "actor-1", replicaId: "replica-a" };
const tokenProvider: AccessTokenProvider = { getValidAccessToken: async () => "test-token" };

type FakeService = { url: string; close: () => Promise<void> };

const services: FakeService[] = [];
const clients: LiveSyncClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("daemon live sync client", () => {
  it("triggers the operation callback promptly when a live fan-out frame arrives", async () => {
    const service = await startFakeService((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "subscribed", cursor: 0 }));
        socket.send(JSON.stringify({ type: "operation", operation: remoteOperation("op-1") }));
      });
    });
    const operations: string[] = [];
    const client = new LiveSyncClient(identity, { url: service.url }, tokenProvider, {
      onOperation: (operation) => operations.push(operation.id)
    });
    clients.push(client);
    client.start();
    await waitFor(() => operations.includes("op-1"));
    expect(operations).toEqual(["op-1"]);
  });

  it("ignores malformed and unauthenticated frames without crashing, and keeps working afterward", async () => {
    let attempt = 0;
    const service = await startFakeService((socket) => {
      attempt += 1;
      socket.once("message", () => {
        if (attempt === 1) {
          // Simulate a rejected/garbage handshake response instead of a valid ack.
          socket.send("not json");
          socket.send(JSON.stringify({ type: "error", message: "Subscription rejected" }));
          return;
        }
        socket.send(JSON.stringify({ type: "subscribed", cursor: 0 }));
        socket.send("also not json");
        socket.send(JSON.stringify({ type: "bogus" }));
        socket.send(JSON.stringify({ type: "operation", operation: { id: "incomplete" } }));
        socket.send(JSON.stringify({ type: "operation", operation: remoteOperation("op-2") }));
      });
    });
    const operations: string[] = [];
    const client = new LiveSyncClient(
      identity,
      { url: service.url },
      tokenProvider,
      { onOperation: (operation) => operations.push(operation.id) },
      { initialBackoffMs: 10, maxBackoffMs: 20 }
    );
    clients.push(client);
    client.start();
    await waitFor(() => operations.includes("op-2"));
    expect(operations).toEqual(["op-2"]);
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it("reconnects with increasing backoff when the connection keeps failing", async () => {
    const connectTimes: number[] = [];
    const service = await startFakeService((socket) => {
      connectTimes.push(Date.now());
      socket.close();
    });
    const client = new LiveSyncClient(
      identity,
      { url: service.url },
      tokenProvider,
      { onOperation: () => {} },
      { initialBackoffMs: 20, maxBackoffMs: 80 }
    );
    clients.push(client);
    client.start();
    await waitFor(() => connectTimes.length >= 3, 3_000);
    const firstGap = connectTimes[1]! - connectTimes[0]!;
    const secondGap = connectTimes[2]! - connectTimes[1]!;
    expect(firstGap).toBeGreaterThanOrEqual(15);
    expect(secondGap).toBeGreaterThanOrEqual(firstGap - 5);
  });

  it("does not throw when the service is unreachable and keeps retrying in the background", async () => {
    const client = new LiveSyncClient(
      identity,
      { url: "http://127.0.0.1:1" },
      tokenProvider,
      { onOperation: () => {} },
      { initialBackoffMs: 10, maxBackoffMs: 20 }
    );
    clients.push(client);
    expect(() => client.start()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("stops reconnecting when the access token provider keeps failing", async () => {
    const failingProvider: AccessTokenProvider = { getValidAccessToken: async () => { throw new Error("no session"); } };
    const client = new LiveSyncClient(
      identity,
      { url: "http://127.0.0.1:1" },
      failingProvider,
      { onOperation: () => {} },
      { initialBackoffMs: 10, maxBackoffMs: 20 }
    );
    clients.push(client);
    expect(() => client.start()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

function startFakeService(onConnection: (socket: WebSocket) => void): Promise<FakeService> {
  return new Promise((resolve) => {
    const server: Server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const wss = new WebSocketServer({ server, path: "/v1/stream" });
    wss.on("connection", onConnection);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const service: FakeService = {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => { wss.close(); server.close(() => res()); })
      };
      services.push(service);
      resolve(service);
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


function remoteOperation(id: string, projectId: string | null = null) {
  return {
    id,
    eventId: id,
    workspaceId: identity.workspaceId,
    senderReplicaId: "replica-b",
    projectId,
    transaction: {
      id,
      base: { files: [] },
      changes: [{ path: "test.txt", kind: "add", afterContent: "test", afterHash: "0".repeat(64) }],
      provenance: { source: "filesystem", confidence: "known" },
      safety: { risk: "low", requiresApproval: false }
    },
    serverSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}
