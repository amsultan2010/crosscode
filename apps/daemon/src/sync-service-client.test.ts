import { createServer } from "node:http";
import { createServer as createSocketServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredSession } from "./supabase-client.js";

/**
 * Supabase access tokens last an hour and a daemon is expected to outlive that. Before
 * this, one did not: `register()` threw "Access token is invalid or expired", the daemon
 * died with a stack trace, and the refresh token sitting in the config next to the dead
 * access token was never spent.
 */

const refreshStoredSession = vi.hoisted(() => vi.fn());
vi.mock("./supabase-client.js", () => ({ refreshStoredSession }));

const { SyncServiceClient } = await import("./sync-service-client.js");

const servers: Server[] = [];
afterEach(async () => {
  refreshStoredSession.mockReset();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Records the bearer on every request, and answers whatever the client asked for. */
async function recordingService(): Promise<{ url: string; bearers: string[] }> {
  const bearers: string[] = [];
  const server = createServer((request, response) => {
    bearers.push(String(request.headers.authorization));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: { replicaId: "11111111-2222-4333-8444-555566667777", cursor: 0 } }));
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bearers };
}

/** Captured before any spy replaces it, so a spy's own implementation can still schedule. */
const realSetTimeout = globalThis.setTimeout;

async function waitFor(description: string, probe: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((next) => realSetTimeout(next, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const session = (expiresAt: string, accessToken = "old-token"): StoredSession =>
  ({ accessToken, refreshToken: "refresh-1", expiresAt });

const configFor = (url: string, expiresAt: string) =>
  ({ projectId: "project-1", repo: "acme/app", service: { url, session: session(expiresAt) } });

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

describe("the sync client's session", () => {
  it("refreshes an expired token, persists it, and sends the new one", async () => {
    const service = await recordingService();
    refreshStoredSession.mockResolvedValue(session(inAnHour(), "new-token"));
    const persisted: StoredSession[] = [];
    const client = new SyncServiceClient(configFor(service.url, anHourAgo()), "main", undefined, async (next) => { persisted.push(next); });

    await client.register();

    expect(refreshStoredSession).toHaveBeenCalledTimes(1);
    expect(service.bearers).toEqual(["Bearer new-token"]);
    // Persisted, because Supabase rotates the refresh token: the next start-up needs this
    // one, not the one that was already spent.
    expect(persisted.map((entry) => entry.accessToken)).toEqual(["new-token"]);
  });

  it("leaves a token that is still good alone", async () => {
    const service = await recordingService();
    const client = new SyncServiceClient(configFor(service.url, inAnHour()), "main");

    await client.register();

    expect(refreshStoredSession).not.toHaveBeenCalled();
    expect(service.bearers).toEqual(["Bearer old-token"]);
  });

  it("spends the refresh token once when several calls find it expired together", async () => {
    const service = await recordingService();
    // Supabase rotates the refresh token, so a second concurrent refresh would be spending
    // one that no longer exists.
    refreshStoredSession.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return session(inAnHour(), "new-token");
    });
    const client = new SyncServiceClient(configFor(service.url, anHourAgo()), "main");

    await Promise.all([client.register(), client.register(), client.register()]);

    expect(refreshStoredSession).toHaveBeenCalledTimes(1);
    expect(service.bearers).toEqual(["Bearer new-token", "Bearer new-token", "Bearer new-token"]);
  });
});

describe("the sync client's stream", () => {
  /** Accepts the TCP connection and answers nothing at all: a half-open upgrade. */
  async function silentHost(): Promise<{ url: string; connections: Socket[] }> {
    const connections: Socket[] = [];
    const server = createSocketServer((socket) => connections.push(socket));
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connections };
  }

  /**
   * A host that accepts the connection and never completes the WebSocket upgrade emits
   * neither "open" nor "close", so nothing ever scheduled a reconnect or started the poll
   * fallback. The daemon sat there reporting `connected: false` and receiving nothing, for
   * as long as it ran -- exactly the case polling exists to cover.
   */
  it("falls back to polling when the host accepts the connection but never answers the upgrade", async () => {
    const host = await silentHost();
    const client = new SyncServiceClient(configFor(host.url, inAnHour()), "main", "11111111-2222-4333-8444-555566667777", undefined, 20, 100);
    let polls = 0;
    try {
      client.start({ onChange: () => {}, onPoll: async () => { polls += 1; } }, () => 0);
      await waitFor("the poll fallback to start", () => polls > 0);
    } finally {
      client.stop();
      for (const connection of host.connections) connection.destroy();
    }

    expect(polls).toBeGreaterThan(0);
  }, 10_000);

  /**
   * Every daemon watching a checkout reconnects on the same schedule when the service
   * restarts, so a fixed doubling sequence lands them all on the service at the same
   * instant, over and over. The delays have to be spread.
   */
  it("spreads its reconnect delays rather than retrying in lockstep", async () => {
    const host = await silentHost();
    const delays: number[] = [];
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (ms !== undefined && ms >= 300) delays.push(ms);
      return realSetTimeout(handler as () => void, ms, ...rest);
    }) as typeof setTimeout);
    const client = new SyncServiceClient(configFor(host.url, inAnHour()), "main", "11111111-2222-4333-8444-555566667777", undefined, 20, 30);
    try {
      client.start({ onChange: () => {}, onPoll: async () => {} }, () => 0);
      await waitFor("three reconnect delays", () => delays.length >= 3);
    } finally {
      timer.mockRestore();
      client.stop();
      for (const connection of host.connections) connection.destroy();
    }

    // 500, 1000, 2000 exactly is the lockstep sequence; jitter makes each one its own value.
    expect(delays.slice(0, 3).some((delay) => !Number.isInteger(delay) || ![500, 1_000, 2_000].includes(delay))).toBe(true);
  }, 10_000);
});
