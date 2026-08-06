import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  changeSchema,
  listChangesQuerySchema,
  presenceSchema,
  publishChangesRequestSchema,
  registerSyncReplicaRequestSchema,
  wsPresenceSchema,
  wsSubscribeSchema,
  type Change,
  type Presence
} from "@crosscode/protocol";

/**
 * A test double for the coordination service: the four sync routes and the stream, in
 * process, backed by an array. Phase 3 builds the real one; the daemon is built against
 * the contract either way, and this is what lets three real daemons be tested before that
 * service exists.
 *
 * It lives in src/ rather than beside the test so tsc holds it to the same contract as
 * everything else that speaks it.
 */

type Subscriber = { socket: WebSocket; projectId: string; branch: string; replicaId: string; presence: Presence };

export type SyncServiceStub = {
  url: string;
  changes: Change[];
  /** How many times `GET /v1/changes` has been asked, so a test can catch a spin. */
  readonly listCalls: number;
  /** Sequences at or below this are "no longer retained", to exercise cursor-too-old. */
  retentionFloor: number;
  /** Drops every open stream, as a network partition would. */
  disconnectAll(): void;
  close(): Promise<void>;
};

export type SyncServiceStubOptions = {
  /**
   * Whether the stub answers a WebSocket upgrade at all. False stands in for a serverless
   * host, which cannot: the routes work, `/v1/stream` never will, and the daemon has to
   * fall back to polling rather than reconnect forever.
   */
  streams?: boolean;
};

export async function startSyncServiceStub(options: SyncServiceStubOptions = {}): Promise<SyncServiceStub> {
  const changes: Change[] = [];
  const subscribers = new Set<Subscriber>();
  let sequence = 0;
  const state = { retentionFloor: 0, listCalls: 0 };

  const send = (response: import("node:http").ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = request.method === "POST" ? JSON.parse(await text(request)) : undefined;

      if (request.method === "POST" && url.pathname === "/v1/replicas") {
        registerSyncReplicaRequestSchema.parse(body);
        send(response, 200, { ok: true, data: { replicaId: randomUUID(), cursor: sequence } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/changes") {
        const parsed = publishChangesRequestSchema.parse(body);
        const stored = parsed.versions.map((version) => changeSchema.parse({
          sequence: (sequence += 1),
          projectId: parsed.projectId,
          branch: parsed.branch,
          replicaId: parsed.replicaId,
          createdAt: new Date().toISOString(),
          version
        }));
        changes.push(...stored);
        for (const change of stored) {
          for (const subscriber of subscribers) {
            if (subscriber.projectId !== change.projectId || subscriber.branch !== change.branch) continue;
            if (subscriber.replicaId === change.replicaId) continue;
            subscriber.socket.send(JSON.stringify({ type: "change", change }));
          }
        }
        send(response, 200, { ok: true, data: { cursor: sequence } });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/changes") {
        state.listCalls += 1;
        const query = listChangesQuerySchema.parse({
          projectId: url.searchParams.get("projectId"),
          branch: url.searchParams.get("branch"),
          since: Number(url.searchParams.get("since") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 200)
        });
        if (query.since < state.retentionFloor) {
          send(response, 200, { ok: true, data: { status: "cursor-too-old", resyncFrom: state.retentionFloor, retentionDays: 7 } });
          return;
        }
        const page = changes
          .filter((change) => change.projectId === query.projectId && change.branch === query.branch && change.sequence > query.since)
          .slice(0, query.limit);
        send(response, 200, { ok: true, data: { changes: page, cursor: page.at(-1)?.sequence ?? query.since } });
        return;
      }
      send(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      send(response, 400, { ok: false, error: error instanceof Error ? error.message : "bad request" });
    }
  });

  // Presence, like the real gateway: each connection's latest self-report is kept and the
  // whole room is told who else is in it. It is how a peer's HEAD travels, so a daemon test
  // that skipped it would not be testing the path the service actually provides.
  const publishPresence = (room: Subscriber) => {
    for (const subscriber of subscribers) {
      if (subscriber.projectId !== room.projectId || subscriber.branch !== room.branch) continue;
      const peers = [...subscribers]
        .filter((peer) => peer.projectId === room.projectId && peer.branch === room.branch && peer.replicaId !== subscriber.replicaId)
        .map((peer) => peer.presence);
      subscriber.socket.send(JSON.stringify({ type: "presence", peers }));
    }
  };

  // No upgrade listener at all when streams are off, which is what makes node destroy the
  // socket -- the client's view of a host that does not serve WebSockets.
  const sockets = options.streams === false ? undefined : new WebSocketServer({ server, path: "/v1/stream" });
  sockets?.on("connection", (socket) => {
    let subscriber: Subscriber | undefined;
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(data.toString());
      if (!subscriber) {
        const parsed = wsSubscribeSchema.safeParse(message);
        if (!parsed.success) return;
        const { projectId, branch, replicaId } = parsed.data;
        subscriber = { socket, projectId, branch, replicaId, presence: presenceSchema.parse({ replicaId, actor: replicaId, branch, paths: [] }) };
        subscribers.add(subscriber);
        socket.once("close", () => {
          subscribers.delete(subscriber!);
          publishPresence(subscriber!);
        });
        publishPresence(subscriber);
        return;
      }
      const presence = wsPresenceSchema.safeParse(message);
      const own = presence.success ? presence.data.peers.find((peer) => peer.replicaId === subscriber!.replicaId) : undefined;
      if (!own) return;
      subscriber.presence = own;
      publishPresence(subscriber);
    });
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    changes,
    get listCalls() { return state.listCalls; },
    get retentionFloor() { return state.retentionFloor; },
    set retentionFloor(value: number) { state.retentionFloor = value; },
    disconnectAll() {
      for (const subscriber of [...subscribers]) subscriber.socket.terminate();
      subscribers.clear();
    },
    async close() {
      for (const subscriber of [...subscribers]) subscriber.socket.terminate();
      sockets?.close();
      // `server.close` only stops new connections; it waits for the open ones, and the
      // daemon's fetch keeps its sockets alive between requests. Without this the close
      // never resolves and the test's teardown hook dies on its own timeout instead.
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  };
}

async function text(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
