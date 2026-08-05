import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Conflict, PauseRequest, ResolveConflictRequest, SyncStatus } from "@crosscode/protocol";
import { DAEMON_ROUTES } from "./daemon-api.js";

/**
 * Stands in for the daemon's local HTTP API, which is being written in another workstream.
 * It answers the four routes in DAEMON_ROUTES with the wire contract's own shapes, so these
 * tests exercise the real fetch/parse path rather than a hand-waved client.
 */
export interface FakeDaemon {
  url: string;
  secret: string;
  status: SyncStatus;
  conflicts: Conflict[];
  resolved: ResolveConflictRequest[];
  paused: PauseRequest[];
  close(): Promise<void>;
}

export const sampleStatus: SyncStatus = {
  branch: "main",
  connected: true,
  paused: false,
  cursor: 12,
  pendingConflicts: 0,
  peers: []
};

export function sampleConflict(path: string, id = `c-${path}`): Conflict {
  return {
    id,
    path,
    detectedAt: "2026-08-05T10:00:00.000Z",
    ours: "ours\n",
    theirs: "theirs\n",
    ancestor: "base\n",
    binary: false,
    peer: "bob"
  };
}

const SECRET = "test-secret";

export async function startFakeDaemon(initial: Partial<Pick<FakeDaemon, "status" | "conflicts">> = {}): Promise<FakeDaemon> {
  const state = {
    status: initial.status ?? sampleStatus,
    conflicts: initial.conflicts ?? [],
    resolved: [] as ResolveConflictRequest[],
    paused: [] as PauseRequest[]
  };

  const server: Server = createServer((request, response) => {
    const send = (data: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, data }));
    };
    const path = (request.url ?? "").split("?")[0];
    if (request.headers.authorization !== `Bearer ${SECRET}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (request.method === "GET" && path === DAEMON_ROUTES.status) return send({ ...state.status, pendingConflicts: state.conflicts.length });
    if (request.method === "GET" && path === DAEMON_ROUTES.conflicts) return send(state.conflicts);

    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (request.method === "POST" && path === DAEMON_ROUTES.resolve) {
        state.resolved.push(parsed as ResolveConflictRequest);
        state.conflicts = state.conflicts.filter((conflict) => conflict.id !== (parsed as ResolveConflictRequest).conflictId);
        return send({ resolved: true });
      }
      if (request.method === "POST" && path === DAEMON_ROUTES.pause) {
        state.paused.push(parsed as PauseRequest);
        state.status = { ...state.status, paused: (parsed as PauseRequest).paused };
        return send({ paused: (parsed as PauseRequest).paused });
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: `no route ${request.method} ${path}` }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    secret: SECRET,
    get status() { return state.status; },
    set status(value: SyncStatus) { state.status = value; },
    get conflicts() { return state.conflicts; },
    set conflicts(value: Conflict[]) { state.conflicts = value; },
    get resolved() { return state.resolved; },
    get paused() { return state.paused; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
