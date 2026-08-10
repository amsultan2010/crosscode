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
  /**
   * Seams for the three limits below, so a test can reach them without waiting out a real
   * token lifetime or filling a real socket buffer. Production passes none of them.
   */
  now?: () => number;
  maxBufferedBytes?: number;
  presenceRatePerMinute?: number;
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
 * How many bytes may sit unwritten on one socket before that client is dropped. A single
 * frame is at most MAX_MESSAGE_BYTES, so this is a few changes' worth of slack for an
 * ordinary hiccup and still bounded: without a ceiling, one consumer that stops reading
 * makes its room's entire change stream a server-side allocation nobody ever frees.
 */
const MAX_BUFFERED_BYTES = 4 * MAX_MESSAGE_BYTES;
/**
 * Presence frames a connection may send per window, and the window. One frame fans out to
 * every peer in the room, so an unbounded sender spends every other socket's bandwidth, not
 * just its own. A person editing produces a handful a second at most; this is well above
 * that and still two orders of magnitude below what a loop can push.
 */
const PRESENCE_RATE_PER_MINUTE = 120;
const RATE_WINDOW_MS = 60_000;
/**
 * setTimeout keeps its delay in a signed 32-bit int, and anything larger fires immediately --
 * which for the expiry timer would close every socket the moment it opened. Supabase tokens
 * live an hour, so this clamp never binds in practice; it is here so an absurd `exp` degrades
 * to "closes in 24 days" rather than "cannot hold a connection at all".
 */
const MAX_TIMEOUT_MS = 2_147_483_647;
/**
 * Why the session ended, in the application range (4000-4999). None of the protocol's own
 * codes mean "the credential you opened this with ran out", and the ones that come close
 * read as protocol failures. The daemon's client reconnects after *any* close -- with
 * backoff, and after refreshing its session -- so this is a reconnect with a fresh token
 * rather than an outage; see the `close` handler in apps/daemon/src/sync-service-client.ts.
 */
const TOKEN_EXPIRED_CLOSE_CODE = 4001;

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
  /** Settled at the handshake so `queue` -- which has no options in hand -- can enforce it. */
  maxBufferedBytes: number;
  /** A fixed window over this connection's presence frames, the shape http.ts rate limits on. */
  presenceWindow: { startedAt: number; count: number };
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
      const subscriber = await subscriberIdentity(request, url, options);
      if (!subscriber) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws, subscriber, options, rooms);
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

/** Who is behind an upgrade request, and until when, or undefined if nobody verifiable is. */
type Subscriber = { userId: string; expiresAtMs: number };

async function subscriberIdentity(
  request: IncomingMessage,
  url: URL,
  options: WebSocketGatewayOptions
): Promise<Subscriber | undefined> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : url.searchParams.get("access_token") ?? undefined;
  if (!token) return undefined;
  try {
    const claims = await verifySupabaseAccessToken(token, options.jwks, options.supabaseUrl);
    return { userId: claims.userId, expiresAtMs: Date.parse(claims.expiresAt) };
  } catch {
    return undefined;
  }
}

function handleConnection(
  socket: WebSocket,
  subscriber: Subscriber,
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

  /**
   * The token is verified once, at the upgrade, and nothing after that ever asks again -- so
   * without this the stream keeps delivering a repository's source for as long as the socket
   * stays open, however long ago the credential that opened it stopped being valid. The
   * token's own `exp` is the deadline, and it is a known instant, so one timer per connection
   * is the whole of it: no per-socket polling, and nothing to re-verify.
   */
  const expiryTimer = setTimeout(() => {
    socket.close(TOKEN_EXPIRED_CLOSE_CODE, "Access token expired");
  }, Math.min(Math.max(subscriber.expiresAtMs - (options.now ?? Date.now)(), 0), MAX_TIMEOUT_MS));
  expiryTimer.unref();

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
          const established = await subscribe(socket, subscriber.userId, request.data, options, rooms);
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
      // A presence frame costs every other socket in the room, not just the one that sent it,
      // and nothing stops a client sending them in a loop. Bounded with the same fixed window
      // http.ts rate limits on, keyed per connection because a stream has no other key. Over
      // the limit the frame is dropped -- which is what this handler already does with every
      // presence frame it will not act on, rather than closing a client for being chatty.
      if (!takePresenceFrame(connection, options)) return;
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
    clearTimeout(expiryTimer);
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
    maxBufferedBytes: options.maxBufferedBytes ?? MAX_BUFFERED_BYTES,
    presenceWindow: { startedAt: (options.now ?? Date.now)(), count: 0 },
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
    // Through `queue`, not `send`: the flush is the one place a whole room's backlog goes out
    // at once, which is exactly where a client that is not draining should be dropped.
    for (const message of buffered) queue(connection, message);
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

/** True if this connection may fan out one more presence frame in the current window. */
function takePresenceFrame(connection: Connection, options: WebSocketGatewayOptions): boolean {
  const now = (options.now ?? Date.now)();
  const window = connection.presenceWindow;
  if (now - window.startedAt >= RATE_WINDOW_MS) {
    window.startedAt = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count <= (options.presenceRatePerMinute ?? PRESENCE_RATE_PER_MINUTE);
}

function queue(connection: Connection, message: WsSyncServerMessage): void {
  if (connection.pending) {
    connection.pending.push(message);
    return;
  }
  // A client that stops reading does not stop its room: every change published into it keeps
  // being written to a socket that never drains, and the process holds the room's whole
  // change stream in memory on that one consumer's behalf. Past the ceiling the connection is
  // dropped instead. That is not data loss -- the client reconnects and subscribes from its
  // own cursor, which replays what it missed, and is told cursor-too-old (and resyncs over
  // HTTP) if it fell further behind than the history the store still holds.
  if (connection.socket.bufferedAmount > connection.maxBufferedBytes) {
    connection.socket.terminate();
    return;
  }
  send(connection.socket, message);
}

function send(socket: WebSocket, message: WsSyncServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(wsSyncServerMessageSchema.parse(message)));
}
