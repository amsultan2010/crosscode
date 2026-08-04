import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  wsErrorMessageSchema,
  wsFanOutMessageSchema,
  wsSubscribeAckSchema,
  wsSubscribeRequestSchema,
  WORKSPACE_TOKEN_PREFIX,
  type PresenceStatus,
  type RemoteClaim,
  type RemoteHandoff,
  type RemoteIntent,
  type RemoteOperation,
  type RemoteTask,
  type RemoteValidation,
  type WsFanOutMessage
} from "@crosscode/protocol";
import type { JWTVerifyGetKey } from "jose";
import { verifySupabaseAccessToken } from "./auth.js";
import type { Membership, PgStore } from "./store.js";

export type WebSocketGatewayOptions = {
  store: PgStore;
  jwks: JWTVerifyGetKey;
  supabaseUrl: string;
};

export type WebSocketGateway = {
  broadcastOperation: (workspaceId: string, operation: RemoteOperation, excludeReplicaId: string) => void;
  broadcastTask: (workspaceId: string, task: RemoteTask, excludeReplicaId: string) => void;
  broadcastClaim: (workspaceId: string, claim: RemoteClaim, excludeReplicaId: string) => void;
  broadcastHandoff: (workspaceId: string, handoff: RemoteHandoff, excludeReplicaId: string) => void;
  broadcastIntent: (workspaceId: string, intent: RemoteIntent, excludeReplicaId: string) => void;
  broadcastValidation: (workspaceId: string, validation: RemoteValidation, excludeReplicaId: string) => void;
};

const STREAM_PATH = "/v1/stream";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

type Connection = {
  socket: WebSocket;
  workspaceId: string;
  replicaId: string;
  actorId: string;
  // Captured at handshake so the offline broadcast on close can still attribute this
  // replica to its project without another database round-trip.
  projectId: string | null;
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
    },
    broadcastTask(workspaceId, task, excludeReplicaId) {
      broadcast(connectionsByWorkspace, workspaceId, { type: "task", task }, excludeReplicaId);
    },
    broadcastClaim(workspaceId, claim, excludeReplicaId) {
      broadcast(connectionsByWorkspace, workspaceId, { type: "claim", claim }, excludeReplicaId);
    },
    broadcastHandoff(workspaceId, handoff, excludeReplicaId) {
      broadcast(connectionsByWorkspace, workspaceId, { type: "handoff", handoff }, excludeReplicaId);
    },
    broadcastIntent(workspaceId, intent, excludeReplicaId) {
      broadcast(connectionsByWorkspace, workspaceId, { type: "intent", intent }, excludeReplicaId);
    },
    broadcastValidation(workspaceId, validation, excludeReplicaId) {
      broadcast(connectionsByWorkspace, workspaceId, { type: "validation", validation }, excludeReplicaId);
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
        const membership = await resolveSubscriber(options, request.accessToken, request.workspaceId);
        const projectId = await options.store.assertReplicaOwnership(membership.workspaceId, membership.memberId, request.replicaId);
        connection = register(connectionsByWorkspace, socket, membership.workspaceId, request.replicaId, membership.actorId, projectId);
        const cursor = await options.store.getCursor(membership.workspaceId);
        send(socket, wsSubscribeAckSchema.parse({ type: "subscribed", cursor }));
        broadcastPresence(connectionsByWorkspace, membership.workspaceId, request.replicaId, membership.actorId, projectId, "online");
        await options.store.recordSessionStart(membership.workspaceId, request.replicaId, cursor);
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
    const closed = connection;
    const registry = connectionsByWorkspace.get(closed.workspaceId);
    if (registry?.get(closed.replicaId) === closed) {
      registry.delete(closed.replicaId);
      if (registry.size === 0) connectionsByWorkspace.delete(closed.workspaceId);
      broadcastPresence(connectionsByWorkspace, closed.workspaceId, closed.replicaId, closed.actorId, closed.projectId, "offline");
      // Session bookkeeping is best-effort: the socket is already gone, so a failed
      // write here has nobody to report to. It must still be caught -- an unhandled
      // rejection on a database blip would take the whole service process down.
      void (async () => {
        const cursor = await options.store.getCursor(closed.workspaceId);
        await options.store.recordSessionEnd(closed.workspaceId, closed.replicaId, cursor);
      })().catch((error: unknown) => {
        process.stderr.write(`Crosscode session end failed for replica ${closed.replicaId}: ${errorMessage(error)}\n`);
      });
    }
  });
}

/**
 * Resolves whichever credential the daemon offered to the membership it acts as. A
 * `ccw_` workspace token is accepted alongside a Supabase access token so a paired
 * install (`crosscode join --pair`) gets live sync too instead of silently falling
 * back to the polling loop -- it already reaches the ingest/read surface over HTTP
 * with the same credential, and the token names its own workspace, so subscribing
 * grants it nothing it did not already have.
 */
async function resolveSubscriber(
  options: WebSocketGatewayOptions,
  credential: string,
  workspaceId: string
): Promise<Membership> {
  if (credential.startsWith(WORKSPACE_TOKEN_PREFIX)) {
    const resolved = await options.store.resolveWorkspaceToken(credential);
    if (resolved.workspaceId !== workspaceId) throw new Error("Workspace token is scoped to a different workspace");
    const { replicaId: _replicaId, ...membership } = resolved;
    return membership;
  }
  const claims = await verifySupabaseAccessToken(credential, options.jwks, options.supabaseUrl);
  return options.store.resolveMembership(claims.userId, workspaceId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function register(
  connectionsByWorkspace: Map<string, Map<string, Connection>>,
  socket: WebSocket,
  workspaceId: string,
  replicaId: string,
  actorId: string,
  projectId: string | null
): Connection {
  let registry = connectionsByWorkspace.get(workspaceId);
  if (!registry) {
    registry = new Map();
    connectionsByWorkspace.set(workspaceId, registry);
  }
  registry.get(replicaId)?.socket.terminate();
  const connection: Connection = { socket, workspaceId, replicaId, actorId, projectId, isAlive: true };
  registry.set(replicaId, connection);
  return connection;
}

function broadcastPresence(
  connectionsByWorkspace: Map<string, Map<string, Connection>>,
  workspaceId: string,
  replicaId: string,
  actorId: string,
  projectId: string | null,
  status: PresenceStatus
): void {
  broadcast(connectionsByWorkspace, workspaceId, {
    type: "presence",
    presence: { replicaId, actorId, status, lastSeenAt: new Date().toISOString(), projectId }
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
