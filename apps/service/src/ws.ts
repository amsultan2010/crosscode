import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  presenceSchema,
  wsSubscribeSchema,
  wsSyncClientMessageSchema,
  wsSyncServerMessageSchema,
  type Change,
  type Presence,
  type WsSyncServerMessage
} from "@crosscode/protocol";
import type { JWTVerifyGetKey } from "jose";
import { verifySupabaseAccessToken } from "./auth.js";
import type { PgStore } from "./store.js";

export type WebSocketGatewayOptions = {
  store: PgStore;
  jwks: JWTVerifyGetKey;
  supabaseUrl: string;
};

export type WebSocketGateway = {
  /** Live push for a room. The sending replica never receives its own change back. */
  broadcastChanges: (projectId: string, branch: string, changes: readonly Change[], excludeReplicaId: string) => void;
};

const STREAM_PATH = "/v1/stream";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
/** One replay page. Matches the contract's ceiling on `limit`. */
const REPLAY_PAGE = 500;
/**
 * The largest frame a client may send. Matches http.ts's default body limit, and is orders
 * of magnitude more than the two things a client ever sends -- a subscribe and a presence
 * frame. Without it `ws` accepts 100 MiB per message, which is 100 MiB a single
 * unauthenticated-until-subscribe socket can make the process buffer.
 */
const MAX_MESSAGE_BYTES = 1_048_576;

/**
 * A room is a project *and* a branch. Two branches of one repository are two rooms that
 * never see each other's changes -- syncing across branches is exactly what somebody who
 * switched branches is asking not to happen.
 */
function roomKey(projectId: string, branch: string): string {
  return `${projectId} ${branch}`;
}

type Connection = {
  socket: WebSocket;
  room: string;
  replicaId: string;
  /** What this replica last said it is working on. Process-local; nothing persists it. */
  presence: Presence;
  isAlive: boolean;
  /**
   * Live messages that arrived while the replay was still streaming. Draining them after
   * the replay -- rather than sending them as they arrive -- is what keeps a subscriber's
   * stream in sequence order across the handover from history to live.
   */
  pending: WsSyncServerMessage[] | null;
};

export function attachWebSocketGateway(server: Server, options: WebSocketGatewayOptions): WebSocketGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const rooms = new Map<string, Map<string, Connection>>();

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://service.local");
      if (url.pathname !== STREAM_PATH) {
        socket.destroy();
        return;
      }
      // The subscribe frame in the contract carries no credential, so the token rides the
      // upgrade request: an Authorization header for a daemon, or ?access_token= for a
      // browser, which cannot set headers on a WebSocket.
      const userId = await subscriberUserId(request, url, options);
      if (!userId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws, userId, options, rooms);
      });
    })();
  });

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const connection of room.values()) {
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
    broadcastChanges(projectId, branch, changes, excludeReplicaId) {
      for (const change of changes) {
        deliver(rooms, roomKey(projectId, branch), { type: "change", change }, excludeReplicaId);
      }
    }
  };
}

/** The verified Supabase user behind an upgrade request, or undefined if there isn't one. */
async function subscriberUserId(
  request: IncomingMessage,
  url: URL,
  options: WebSocketGatewayOptions
): Promise<string | undefined> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : url.searchParams.get("access_token") ?? undefined;
  if (!token) return undefined;
  try {
    return (await verifySupabaseAccessToken(token, options.jwks, options.supabaseUrl)).userId;
  } catch {
    return undefined;
  }
}

function handleConnection(
  socket: WebSocket,
  userId: string,
  options: WebSocketGatewayOptions,
  rooms: Map<string, Map<string, Connection>>
): void {
  let connection: Connection | undefined;
  // The handshake is asynchronous, so a client that sends two subscribes back to back
  // would otherwise get two registrations for one socket.
  let subscribing = false;
  let closed = false;

  const handshakeTimer = setTimeout(() => {
    if (!connection) socket.close(1008, "Subscribe timeout");
  }, HANDSHAKE_TIMEOUT_MS);

  socket.on("message", (data: RawData) => {
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        send(socket, { type: "error", message: "Message must be valid JSON" });
        return;
      }
      if (!connection) {
        if (subscribing) return;
        subscribing = true;
        clearTimeout(handshakeTimer);
        const request = wsSubscribeSchema.safeParse(parsed);
        if (!request.success) {
          send(socket, { type: "error", message: "First message must be a subscribe" });
          socket.close(1008, "Subscribe required");
          return;
        }
        try {
          const established = await subscribe(socket, userId, request.data, options, rooms);
          // The socket can die while the handshake is still in flight, and the close handler
          // had nothing to remove when it ran. Without this the room keeps an entry nobody
          // is on the other end of: it collects every broadcast and appears in every peer's
          // presence list for the lifetime of the process.
          if (closed) release(rooms, established);
          else connection = established;
        } catch {
          subscribing = false;
          send(socket, { type: "error", message: "Subscription rejected" });
          socket.close(1008, "Subscription rejected");
        }
        return;
      }
      // After the handshake, the only thing a client says is what it is working on.
      const message = wsSyncClientMessageSchema.safeParse(parsed);
      if (!message.success || message.data.type !== "presence") return;
      const own = message.data.peers.find((peer) => peer.replicaId === connection!.replicaId);
      if (!own) return;
      // Only the paths are the client's to report. Taking the frame whole would let a
      // replica publish any `actor` it liked into every peer's presence list -- naming
      // somebody else as the one editing a file -- and any `branch`, which is the room it
      // was authorized for and not something a message may restate.
      connection.presence = { ...connection.presence, paths: own.paths };
      publishPresence(rooms, connection.room);
    })();
  });

  socket.on("pong", () => {
    if (connection) connection.isAlive = true;
  });

  // `ws` reports a protocol failure -- a frame past the payload limit, a reserved opcode,
  // invalid UTF-8 in a text frame -- by emitting `error` on the socket, and an `error` with
  // no listener is an uncaught exception that takes the whole process down. One malformed
  // frame from one client is not an outage for everybody else's rooms. `ws` closes the
  // connection itself; the close handler does the rest.
  socket.on("error", () => {});

  socket.on("close", () => {
    clearTimeout(handshakeTimer);
    closed = true;
    if (connection) release(rooms, connection);
  });
}

/** Takes a gone connection back out of its room, and tells whoever is left. */
function release(rooms: Map<string, Map<string, Connection>>, gone: Connection): void {
  const room = rooms.get(gone.room);
  if (room?.get(gone.replicaId) !== gone) return;
  room.delete(gone.replicaId);
  if (room.size === 0) {
    rooms.delete(gone.room);
    return;
  }
  publishPresence(rooms, gone.room);
}

/**
 * The handshake: prove the replica is this user's, in this project, on this branch; then
 * replay everything after `since` before any live change reaches the socket.
 */
async function subscribe(
  socket: WebSocket,
  userId: string,
  request: { projectId: string; branch: string; replicaId: string; since: number },
  options: WebSocketGatewayOptions,
  rooms: Map<string, Map<string, Connection>>
): Promise<Connection> {
  await options.store.requireMembership(request.projectId, userId);
  const replica = await options.store.touchReplica(request.projectId, userId, request.replicaId);
  if (replica.branch !== request.branch) throw new Error("Replica is registered to a different branch");

  const room = roomKey(request.projectId, request.branch);
  const connection: Connection = {
    socket,
    room,
    replicaId: request.replicaId,
    presence: { replicaId: request.replicaId, actor: userId, branch: request.branch, paths: [] },
    isAlive: true,
    // Buffering starts before the replay reads anything, so a change published mid-replay
    // is held rather than lost -- registering after the read would miss every change whose
    // sequence the read had already passed.
    pending: []
  };
  let registry = rooms.get(room);
  if (!registry) {
    registry = new Map();
    rooms.set(room, registry);
  }
  // One connection per replica. A reconnect after a drop the server has not noticed yet
  // would otherwise leave a zombie holding the replica's slot.
  registry.get(request.replicaId)?.socket.terminate();
  registry.set(request.replicaId, connection);

  try {
    await replay(socket, connection, request, options);
  } catch (error) {
    // Registration happened before the replay, so a failed replay has to take the entry
    // back out -- a room holding a connection nobody is on the other end of would collect
    // broadcasts and appear in everybody's presence list forever.
    if (registry.get(request.replicaId) === connection) registry.delete(request.replicaId);
    if (registry.size === 0) rooms.delete(room);
    throw error;
  }

  publishPresence(rooms, room);
  return connection;
}

/** Streams the room's history after `since`, then flushes whatever arrived meanwhile. */
async function replay(
  socket: WebSocket,
  connection: Connection,
  request: { projectId: string; branch: string; since: number },
  options: WebSocketGatewayOptions
): Promise<void> {
  try {
    let cursor = request.since;
    for (;;) {
      const page = await options.store.listChanges({
        projectId: request.projectId, branch: request.branch, since: cursor, limit: REPLAY_PAGE
      });
      if (page.status === "cursor-too-old") {
        // The socket cannot carry the cursor-too-old shape (the contract's server messages
        // are change/presence/error), so say so and close: the daemon resyncs over HTTP,
        // where that answer has a defined form.
        send(socket, { type: "error", message: `cursor-too-old: resync from ${page.resyncFrom}` });
        socket.close(1008, "cursor-too-old");
        break;
      }
      for (const change of page.changes) send(socket, { type: "change", change });
      if (page.changes.length < REPLAY_PAGE) break;
      cursor = page.cursor;
    }
  } finally {
    const buffered = connection.pending ?? [];
    connection.pending = null;
    for (const message of buffered) send(socket, message);
  }
}

/** Tells everyone in the room who else is in it. Presence is process-local and never stored. */
function publishPresence(rooms: Map<string, Map<string, Connection>>, room: string): void {
  const registry = rooms.get(room);
  if (!registry) return;
  for (const [replicaId, connection] of registry) {
    const peers = [...registry.values()]
      .filter((peer) => peer.replicaId !== replicaId)
      .map((peer) => presenceSchema.parse(peer.presence));
    queue(connection, { type: "presence", peers });
  }
}

function deliver(
  rooms: Map<string, Map<string, Connection>>,
  room: string,
  message: WsSyncServerMessage,
  excludeReplicaId: string
): void {
  const registry = rooms.get(room);
  if (!registry) return;
  for (const [replicaId, connection] of registry) {
    if (replicaId === excludeReplicaId) continue;
    queue(connection, message);
  }
}

function queue(connection: Connection, message: WsSyncServerMessage): void {
  if (connection.pending) {
    connection.pending.push(message);
    return;
  }
  send(connection.socket, message);
}

function send(socket: WebSocket, message: WsSyncServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(wsSyncServerMessageSchema.parse(message)));
}
