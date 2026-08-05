import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashDeviceCode, PgStore } from "./store.js";

/**
 * The device-code table against a real PostgreSQL: the statements in
 * migrations/002_device_codes.sql, doing what device-flow.test.ts's in-memory stand-in
 * claims they do.
 *
 * What only a real database can show: that the device code is never stored in the clear,
 * that collection is a read-and-clear rather than a read, and that the table is behind row
 * level security with no policy -- which is what stops a PostgREST caller holding an
 * `authenticated` JWT from reading sessions in flight.
 *
 * Gated on CROSSCODE_TEST_DATABASE_URL. Without it these tests skip, and a skipped suite
 * has proved nothing.
 */
const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("device codes on PostgreSQL", () => {
  let store: PgStore;

  beforeAll(async () => {
    store = new PgStore(databaseUrl!);
    await store.migrate();
  });

  afterAll(async () => {
    await store.close();
  });

  it("keeps the table behind row level security, with no policy to escape through", async () => {
    const table = await store.pool.query<{ rowsecurity: boolean }>(
      "SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'device_codes'"
    );
    expect(table.rows[0]?.rowsecurity).toBe(true);
    const policies = await store.pool.query("SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'device_codes'");
    expect(policies.rowCount).toBe(0);
  });

  it("stores the device code only as a hash", async () => {
    const started = await store.startDeviceCode({ expiresInSeconds: 900 });

    const row = await store.pool.query<{ device_code_hash: string; user_code: string; session: unknown }>(
      "SELECT device_code_hash, user_code, session FROM device_codes WHERE device_code_hash = $1",
      [hashDeviceCode(started.deviceCode)]
    );
    expect(row.rows[0]?.device_code_hash).toBe(hashDeviceCode(started.deviceCode));
    expect(row.rows[0]?.session).toBeNull();
    // The one spelling of the user code, so a browser's normalized input finds it.
    expect(row.rows[0]?.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // Nowhere in the table, in any column, is the code the CLI is holding.
    const leaked = await store.pool.query("SELECT 1 FROM device_codes WHERE device_code_hash = $1 OR user_code = $1", [started.deviceCode]);
    expect(leaked.rowCount).toBe(0);
  });

  it("carries a session from a bind to exactly one claim", async () => {
    const started = await store.startDeviceCode({ expiresInSeconds: 900 });
    const userId = randomUUID();
    const session = { accessToken: "access", refreshToken: "refresh", expiresAt: "2030-01-01T00:00:00.000Z", githubToken: "gho_x" };

    expect(await store.claimDeviceCode(started.deviceCode)).toEqual({ status: "pending" });
    expect(await store.bindDeviceCode({ userCode: started.userCode, userId, session })).toEqual({ status: "bound" });
    expect(await store.claimDeviceCode(started.deviceCode)).toEqual({ status: "complete", session });

    // Collected once. The row survives so a replay can be told which of the two happened,
    // and it survives holding nothing.
    expect(await store.claimDeviceCode(started.deviceCode)).toEqual({ status: "consumed" });
    expect(await store.bindDeviceCode({ userCode: started.userCode, userId, session })).toEqual({ status: "consumed" });
    const row = await store.pool.query<{ session: unknown; consumed_at: Date | null; user_id: string }>(
      "SELECT session, consumed_at, user_id FROM device_codes WHERE device_code_hash = $1",
      [hashDeviceCode(started.deviceCode)]
    );
    expect(row.rows[0]?.session).toBeNull();
    expect(row.rows[0]?.consumed_at).not.toBeNull();
    expect(row.rows[0]?.user_id).toBe(userId);
  });

  it("refuses a second sign-in on a live code, and anything at all on an expired one", async () => {
    const started = await store.startDeviceCode({ expiresInSeconds: 900 });
    const session = { accessToken: "access", refreshToken: "refresh", expiresAt: "2030-01-01T00:00:00.000Z" };
    await store.bindDeviceCode({ userCode: started.userCode, userId: randomUUID(), session });

    expect(await store.bindDeviceCode({ userCode: started.userCode, userId: randomUUID(), session })).toEqual({ status: "already-bound" });

    const stale = await store.startDeviceCode({ expiresInSeconds: 900 });
    await store.pool.query("UPDATE device_codes SET expires_at = now() - interval '1 minute' WHERE device_code_hash = $1", [hashDeviceCode(stale.deviceCode)]);
    expect(await store.claimDeviceCode(stale.deviceCode)).toEqual({ status: "expired" });
    expect(await store.bindDeviceCode({ userCode: stale.userCode, userId: randomUUID(), session })).toEqual({ status: "expired" });
  });

  it("knows nothing about a code it did not mint", async () => {
    expect(await store.claimDeviceCode("a-device-code-from-nowhere")).toEqual({ status: "unknown" });
    expect(await store.bindDeviceCode({
      userCode: "AAAA-BBBB",
      userId: randomUUID(),
      session: { accessToken: "a", refreshToken: "r", expiresAt: "2030-01-01T00:00:00.000Z" }
    })).toEqual({ status: "unknown" });
  });

  it("sweeps codes that expired long enough ago to be of no interest to anyone", async () => {
    const stale = await store.startDeviceCode({ expiresInSeconds: 900 });
    await store.pool.query("UPDATE device_codes SET expires_at = now() - interval '2 hours' WHERE device_code_hash = $1", [hashDeviceCode(stale.deviceCode)]);

    // The sweep runs at the top of the next handshake, where there is time to spare.
    await store.startDeviceCode({ expiresInSeconds: 900 });

    expect(await store.claimDeviceCode(stale.deviceCode)).toEqual({ status: "unknown" });
  });
});
