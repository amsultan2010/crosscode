import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
