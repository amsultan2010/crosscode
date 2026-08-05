import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { verifySupabaseAccessToken } from "./auth.js";
import { createServiceServer, type ServiceServerOptions } from "./http.js";
import { hashDeviceCode, normalizeUserCode, type DeviceBindResult, type DeviceClaimResult, type DeviceSession, type PgStore, type StartedDeviceCode } from "./store.js";
import { signTestSupabaseToken, testSupabaseJwks } from "./test-jwks.js";

/**
 * The device handshake end to end, over real HTTP, through the real route handlers.
 *
 * What is stubbed is the table underneath, in memory -- deliberately mirroring the SQL in
 * migrations/002_device_codes.sql statement for statement, including the read-and-clear
 * that makes a code collectable exactly once. The routes, the auth, the rate limiting and
 * the wire shapes are all the real ones, and the session the CLI ends up holding is fed
 * back through verifySupabaseAccessToken -- the same function every other route in the
 * service authenticates with -- because a handshake that produces a token the service
 * would not accept has proved nothing.
 */

const supabaseUrl = "https://rzsslbmahvoesjxmgefr.supabase.co";
const userId = "5c9f2a10-2222-4333-8444-555566667777";

type DeviceRow = { deviceCode: string; userCode: string; expiresAt: number; session: DeviceSession | null; consumed: boolean };

/** The table, in memory. Every method is the SQL in 002_device_codes.sql, minus the SQL. */
function inMemoryDeviceStore(seed: Partial<DeviceRow> = {}) {
  const rows: DeviceRow[] = [];
  let minted = 0;
  return {
    rows,
    async startDeviceCode({ expiresInSeconds }: { expiresInSeconds: number }): Promise<StartedDeviceCode> {
      minted += 1;
      const row: DeviceRow = {
        deviceCode: `device-code-${minted}`,
        userCode: `WDJB-MJH${minted}`,
        expiresAt: Date.now() + expiresInSeconds * 1_000,
        session: null,
        consumed: false,
        ...seed
      };
      rows.push(row);
      return { deviceCode: row.deviceCode, userCode: row.userCode, expiresAt: new Date(row.expiresAt).toISOString() };
    },
    async bindDeviceCode(input: { userCode: string; userId: string; session: DeviceSession }): Promise<DeviceBindResult> {
      const row = rows.find((entry) => entry.userCode === input.userCode);
      if (!row) return { status: "unknown" };
      if (row.consumed) return { status: "consumed" };
      if (row.expiresAt <= Date.now()) return { status: "expired" };
      if (row.session) return { status: "already-bound" };
      row.session = input.session;
      return { status: "bound" };
    },
    async claimDeviceCode(deviceCode: string): Promise<DeviceClaimResult> {
      const row = rows.find((entry) => entry.deviceCode === deviceCode);
      if (!row) return { status: "unknown" };
      if (row.consumed) return { status: "consumed" };
      if (row.expiresAt <= Date.now()) return { status: "expired" };
      if (!row.session) return { status: "pending" };
      const { session } = row;
      row.consumed = true;
      row.session = null;
      return { status: "complete", session };
    }
  };
}

const servers: ReturnType<typeof createServiceServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("signing a terminal in", () => {
  it("carries a session from the browser to the CLI: start, pending, bind, complete", async () => {
    const store = inMemoryDeviceStore();
    const base = await listen(store);
    const jwks = await testSupabaseJwks();
    const browserToken = await signTestSupabaseToken(supabaseUrl, { sub: userId });

    // 1. The terminal opens a handshake. It has no credential to present, and that is the
    //    point: producing one is what this route is for.
    const started = await post(base, "/v1/auth/github/device", {});
    expect(started.status).toBe(201);
    const start = await data<{ deviceCode: string; userCode: string; verificationUrl: string; intervalSeconds: number; expiresInSeconds: number }>(started);
    expect(start.verificationUrl).toBe("https://www.getcrosscode.dev/device");
    expect(start.intervalSeconds).toBe(5);
    expect(start.expiresInSeconds).toBeGreaterThan(600);

    // 2. Nobody has signed in yet, so the CLI is told to keep waiting rather than refused.
    const waiting = await post(base, "/v1/auth/github/device/token", { deviceCode: start.deviceCode });
    expect(waiting.status).toBe(200);
    expect(await data(waiting)).toEqual({ status: "pending" });

    // 3. The browser, signed in with GitHub, binds the code the human typed. Lower case
    //    and no dash: the same code, typed by a human.
    const bound = await post(base, "/v1/auth/github/device/bind", {
      userCode: start.userCode.replace("-", "").toLowerCase(),
      refreshToken: "refresh-token",
      githubToken: "gho_provider"
    }, browserToken);
    expect(bound.status).toBe(200);

    // 4. The CLI collects it.
    const completed = await post(base, "/v1/auth/github/device/token", { deviceCode: start.deviceCode });
    expect(completed.status).toBe(200);
    const payload = await data<{ status: string; session: { accessToken: string; refreshToken: string; expiresAt: string }; githubToken: string }>(completed);
    expect(payload.status).toBe("complete");
    expect(payload.session.refreshToken).toBe("refresh-token");
    // The GitHub token is beside the session, not inside it: the session is what the CLI
    // writes to disk, and syncDaemonConfigSchema is strict about what that contains.
    expect(payload.githubToken).toBe("gho_provider");
    expect(Object.keys(payload.session).sort()).toEqual(["accessToken", "expiresAt", "refreshToken"]);

    // 5. And the session it now holds is one the rest of the service accepts. This is the
    //    whole claim the handshake makes.
    const claims = await verifySupabaseAccessToken(payload.session.accessToken, jwks, supabaseUrl);
    expect(claims.userId).toBe(userId);
    expect(payload.session.expiresAt).toBe(claims.expiresAt);
    expect((await post(base, "/v1/projects", { name: "app", repo: "acme/app" }, payload.session.accessToken)).status).toBe(201);
  });

  it("hands the session over exactly once, then says the code is spent", async () => {
    const store = inMemoryDeviceStore();
    const base = await listen(store);
    const start = await data<{ deviceCode: string; userCode: string }>(await post(base, "/v1/auth/github/device", {}));
    await post(base, "/v1/auth/github/device/bind", { userCode: start.userCode, refreshToken: "r" }, await signTestSupabaseToken(supabaseUrl));

    expect((await post(base, "/v1/auth/github/device/token", { deviceCode: start.deviceCode })).status).toBe(200);
    // Whoever polls second gets nothing -- including somebody who read the code out of a
    // process listing after the fact.
    expect((await post(base, "/v1/auth/github/device/token", { deviceCode: start.deviceCode })).status).toBe(409);
    // And the row is left holding no tokens at all.
    expect(store.rows[0]!.session).toBeNull();
  });

  it("refuses a code nobody minted, and an expired one, without confusing the two", async () => {
    const expired = inMemoryDeviceStore({ expiresAt: Date.now() - 1_000 });
    const base = await listen(expired);

    expect((await post(base, "/v1/auth/github/device/token", { deviceCode: "not-a-device-code" })).status).toBe(404);

    const start = await data<{ deviceCode: string; userCode: string }>(await post(base, "/v1/auth/github/device", {}));
    expect((await post(base, "/v1/auth/github/device/token", { deviceCode: start.deviceCode })).status).toBe(410);
    // The browser is told the same thing, so a human who typed a code from a terminal they
    // left open yesterday is told to get a fresh one rather than that they typed it wrong.
    const bind = await post(base, "/v1/auth/github/device/bind", { userCode: start.userCode, refreshToken: "r" }, await signTestSupabaseToken(supabaseUrl));
    expect(bind.status).toBe(410);
  });

  it("refuses a confirmation code that is not one of ours, and one that is already signed in", async () => {
    const store = inMemoryDeviceStore();
    const base = await listen(store);
    const token = await signTestSupabaseToken(supabaseUrl);
    const start = await data<{ userCode: string }>(await post(base, "/v1/auth/github/device", {}));

    // Not a code at all: refused before the table is touched.
    expect((await post(base, "/v1/auth/github/device/bind", { userCode: "nope", refreshToken: "r" }, token)).status).toBe(400);
    // A well-formed code for a handshake that does not exist.
    expect((await post(base, "/v1/auth/github/device/bind", { userCode: "AAAA-BBBB", refreshToken: "r" }, token)).status).toBe(404);

    expect((await post(base, "/v1/auth/github/device/bind", { userCode: start.userCode, refreshToken: "r" }, token)).status).toBe(200);
    // A second sign-in on a live code is somebody redirecting a handshake that is already
    // claimed, not a retry.
    const second = await post(base, "/v1/auth/github/device/bind", { userCode: start.userCode, refreshToken: "r" }, await signTestSupabaseToken(supabaseUrl, { sub: "another-user" }));
    expect(second.status).toBe(409);
    expect(store.rows[0]!.session?.refreshToken).toBe("r");
  });

  it("refuses to sign a terminal in from a session that is not a GitHub one", async () => {
    const store = inMemoryDeviceStore();
    const base = await listen(store);
    const start = await data<{ userCode: string }>(await post(base, "/v1/auth/github/device", {}));
    // A Supabase project can have other providers enabled. A session from one of them has
    // no GitHub identity, and every repository check downstream of sign-in needs one.
    const google = await signTestSupabaseToken(supabaseUrl, { provider: "google", github: null });

    expect((await post(base, "/v1/auth/github/device/bind", { userCode: start.userCode, refreshToken: "r" }, google)).status).toBe(403);
    // Unauthenticated is still unauthenticated: bind is the one half of the handshake that
    // is behind the bearer check.
    expect((await post(base, "/v1/auth/github/device/bind", { userCode: start.userCode, refreshToken: "r" })).status).toBe(401);
    expect(store.rows[0]!.session).toBeNull();
  });

  it("throttles a client that polls far faster than it was told to", async () => {
    const base = await listen(inMemoryDeviceStore());
    const deviceCode = "device-code-being-hammered";

    // Thirty a minute against the five-second interval it was handed: an honest CLI never
    // reaches this, and one guessing codes gets nowhere near enough attempts to matter.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      statuses.push((await post(base, "/v1/auth/github/device/token", { deviceCode })).status);
    }

    expect(statuses.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Keyed on the code, so the office next door polling its own handshake is unaffected.
    expect((await post(base, "/v1/auth/github/device/token", { deviceCode: "some-other-code" })).status).toBe(404);
  });
});

/** The two helpers the store exposes for the routes, checked where they are cheapest to check. */
describe("the code a human retypes", () => {
  it("is one code however it is typed, and nothing else is a code", async () => {
    expect(normalizeUserCode("wdjb-mjht")).toBe("WDJB-MJHT");
    expect(normalizeUserCode(" WDJBMJHT ")).toBe("WDJB-MJHT");
    expect(normalizeUserCode("WDJB-MJH")).toBeUndefined();
    expect(normalizeUserCode("WDJB-MJHT-EXTRA")).toBeUndefined();
    expect(normalizeUserCode("wdjb mjh!")).toBeUndefined();
  });

  it("never puts the device code itself in a rate-limit key or a table", async () => {
    expect(hashDeviceCode("device-code")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceCode("device-code")).not.toContain("device-code");
    expect(hashDeviceCode("device-code")).toBe(hashDeviceCode("device-code"));
    expect(hashDeviceCode("device-code")).not.toBe(hashDeviceCode("device-code2"));
  });
});

async function listen(device: ReturnType<typeof inMemoryDeviceStore>, overrides: Partial<ServiceServerOptions> = {}): Promise<string> {
  const store = {
    ...device,
    upsertUser: async () => ({ created: false }),
    createProject: async () => ({ id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", name: "app", repo: "acme/app", plan: "free", createdAt: "2026-01-01T00:00:00.000Z" })
  } as unknown as PgStore;
  const server = createServiceServer({
    store,
    jwks: await testSupabaseJwks(),
    supabaseUrl,
    appUrl: "https://www.getcrosscode.dev",
    ...overrides
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(base: string, path: string, body: unknown, accessToken?: string): Promise<Response> {
  return fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body)
  });
}

async function data<T>(response: Response): Promise<T> {
  return (await response.json() as { data: T }).data;
}
