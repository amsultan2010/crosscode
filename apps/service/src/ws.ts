import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  wsErrorMessageSchema,
  wsFanOutMessageSchema,
  wsSubscribeAckSchema,
  wsSubscribeRequestSchema,
  type PresenceStatus,
  type RemoteOperation,
  type WsFanOutMessage
} from "@crosscode/protocol";
import { verifyAccessToken } from "./auth.js";
import { StoreUnauthorizedError, type PgStore } from "./store.js";

export type WebSocketGatewayOptions = {
  store: PgStore;
  jwtSecret: string;
};

export type WebSocketGateway = {
  broadcastOperation: (workspaceId: string, operation: RemoteOperation, excludeReplicaId: string) => void;
};

const STREAM_PATH = "/v1/stream";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

type Connection = {
  socket: WebSocket;
  workspaceId: string;
  replicaId: string;
  actorId: string;
  isAlive: boolean;
};

export function attachWebSocketGateway(server: Server, options: WebSocketGatewayOptions): WebSocketGateway {
  const wss = new WebSocketServer({ noServer: true });
  const connectionsByWorkspace = new Map<string, Map<string, Connection>>();

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "/", "http://service.local");
    if (url.pathname !== STREAM_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket: WebSocket) => {
    handleConnection(socket, options, connectionsByWorkspace);
  });

  const heartbeat = setInterval(() => {
    for (const registry of connectionsByWorkspace.values()) {
      for (const connection of registry.values()) {
        if (!connection.isAlive) {
          connection.socket.terminate();
          continue;
        }
        connection.isAlive = false;
        connection.socket.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  server.on("close", () => clearInterval(heartbeat));

  return {
    broadcastOperation(workspaceId, operation, excludeReplicaId) {
      broadcast(connectionsByWorkspace, workspaceId, { type: "operation", operation }, excludeReplicaId);
    }
  };
}

function handleConnection(
  socket: WebSocket,
  options: WebSocketGatewayOptions,
  connectionsByWorkspace: Map<string, Map<string, Connection>>
): void {
  let connection: Connection | undefined;

  const handshakeTimer = setTimeout(() => {
    if (!connection) socket.close(1008, "Subscribe timeout");
  }, HANDSHAKE_TIMEOUT_MS);

  socket.once("message", (data: RawData) => {
    void (async () => {
      clearTimeout(handshakeTimer);
      try {
        const request = wsSubscribeRequestSchema.parse(JSON.parse(data.toString()));
        const claims = await verifyAccessToken(request.accessToken, options.jwtSecret);
        const identity = await options.store.reauthorize(claims);
        if (identity.workspaceId !== request.workspaceId || identity.replicaId !== request.replicaId) {
          throw new StoreUnauthorizedError("Subscription principal does not match authenticated membership");
        }
        connection = register(connectionsByWorkspace, socket, identity.workspaceId, identity.replicaId, identity.actorId);
        const cursor = await options.store.getCursor(identity.workspaceId);
        send(socket, wsSubscribeAckSchema.parse({ type: "subscribed", cursor }));
        broadcastPresence(connectionsByWorkspace, identity.workspaceId, identity.replicaId, identity.actorId, "online");
      } catch {
        send(socket, wsErrorMessageSchema.parse({ type: "error", message: "Subscription rejected" }));
        socket.close(1008, "Subscription rejected");
      }
    })();
  });

  socket.on("pong", () => {
    if (connection) connection.isAlive = true;
  });

  socket.on("close", () => {
    clearTimeout(handshakeTimer);
    if (!connection) return;
    const registry = connectionsByWorkspace.get(connection.workspaceId);
    if (registry?.get(connection.replicaId) === connection) {
      registry.delete(connection.replicaId);
      if (registry.size === 0) connectionsByWorkspace.delete(connection.workspaceId);
      broadcastPresence(connectionsByWorkspace, connection.workspaceId, connection.replicaId, connection.actorId, "offline");
    }
  });
}

function register(
  connectionsByWorkspace: Map<string, Map<string, Connection>>,
  socket: WebSocket,
  workspaceId: string,
  replicaId: string,
  actorId: string
): Connection {
  let registry = connectionsByWorkspace.get(workspaceId);
  if (!registry) {
    registry = new Map();
    connectionsByWorkspace.set(workspaceId, registry);
  }
  registry.get(replicaId)?.socket.terminate();
  const connection: Connection = { socket, workspaceId, replicaId, actorId, isAlive: true };
  registry.set(replicaId, connection);
  return connection;
}

function broadcastPresence(
  connectionsByWorkspace: Map<string, Map<string, Connection>>,
  workspaceId: string,
  replicaId: string,
  actorId: string,
  status: PresenceStatus
): void {
  broadcast(connectionsByWorkspace, workspaceId, {
    type: "presence",
    presence: { replicaId, actorId, status, lastSeenAt: new Date().toISOString() }
  }, replicaId);
}

function broadcast(
  connectionsByWorkspace: Map<string, Map<string, Connection>>,
  workspaceId: string,
  message: WsFanOutMessage,
  excludeReplicaId: string
): void {
  const registry = connectionsByWorkspace.get(workspaceId);
  if (!registry) return;
  const payload = JSON.stringify(wsFanOutMessageSchema.parse(message));
  for (const [replicaId, connection] of registry) {
    if (replicaId === excludeReplicaId) continue;
    if (connection.socket.readyState === connection.socket.OPEN) connection.socket.send(payload);
  }
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
