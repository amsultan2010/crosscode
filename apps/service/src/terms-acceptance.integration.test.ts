import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgStore } from "./store.js";

/**
 * migrations/003_terms_acceptances.sql against a real PostgreSQL, doing what
 * terms-acceptance.test.ts's in-memory stand-in claims it does.
 *
 * What only a real database can show: that the CHECK constraints are the ones the code
 * assumes, that "the newest version of each document" is a DISTINCT ON over accepted_at and
 * not a guess, that the table is behind row level security with no policy to escape through,
 * and that the health route -- which scans every public table -- covers this one. The last
 * of those is the outage `device_codes` shipped: a table with no grant to the runtime role,
 * 500ing on every request, while /healthz answered `ok`.
 *
 * Gated on CROSSCODE_TEST_DATABASE_URL. Without it these tests skip, and a skipped suite has
 * proved nothing.
 */
const databaseUrl = process.env.CROSSCODE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("terms acceptances on PostgreSQL", () => {
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
      "SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'terms_acceptances'"
    );
    expect(table.rows[0]?.rowsecurity).toBe(true);
    const policies = await store.pool.query("SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'terms_acceptances'");
    expect(policies.rowCount).toBe(0);
  });

  it("is one of the tables the health route checks, because it checks all of them", async () => {
    const { unreadableTables } = await store.checkHealth();
    expect(unreadableTables).toEqual([]);

    const scanned = await store.pool.query<{ table: string }>(
      `SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`
    );
    expect(scanned.rows.map((row) => row.table)).toContain("terms_acceptances");
  });

  /**
   * The append-only guarantee, asserted as a privilege rather than a habit. This connection
   * is the migration role, which owns the table and therefore *can* rewrite it -- which is
   * exactly what the check refuses to start a service on.
   */
  it("refuses to run the service as a role that can rewrite an acceptance", async () => {
    await expect(store.assertRuntimePrivileges()).rejects.toThrow(/terms_acceptances/);
  });

  it("appends a row per document, and answers with the newest version of each", async () => {
    const userId = randomUUID();

    await store.recordAcceptances([
      { userId, document: "terms", version: "2025-01-01", surface: "signup" },
      { userId, document: "privacy", version: "2025-01-01", surface: "signup" }
    ]);
    await store.recordAcceptances([
      { userId, document: "terms", version: "2026-08-01", surface: "device", ip: "203.0.113.7", userAgent: "Mozilla/5.0" }
    ]);

    expect(await store.latestAcceptedVersions(userId)).toEqual({ terms: "2026-08-01", privacy: "2025-01-01" });

    // Three rows, not two: accepting a new version of the terms did not replace the row
    // saying which text was accepted in January.
    const rows = await store.pool.query<{ document: string; version: string; surface: string; ip: string | null }>(
      "SELECT document, version, surface, ip FROM terms_acceptances WHERE user_id = $1 ORDER BY accepted_at",
      [userId]
    );
    expect(rows.rows).toEqual([
      { document: "terms", version: "2025-01-01", surface: "signup", ip: null },
      { document: "privacy", version: "2025-01-01", surface: "signup", ip: null },
      { document: "terms", version: "2026-08-01", surface: "device", ip: "203.0.113.7" }
    ]);
  });

  it("knows nothing about a user who has accepted nothing", async () => {
    expect(await store.latestAcceptedVersions(randomUUID())).toEqual({});
    // Not a uuid at all is the same answer, and never a database error.
    expect(await store.latestAcceptedVersions("not-a-user")).toEqual({});
  });

  it("refuses a document or a surface the code does not know about", async () => {
    const userId = randomUUID();

    await expect(store.pool.query(
      "INSERT INTO terms_acceptances (id, user_id, document, version, surface) VALUES ($1, $2, 'eula', '2026-08-01', 'signup')",
      [randomUUID(), userId]
    )).rejects.toThrow();

    await expect(store.pool.query(
      "INSERT INTO terms_acceptances (id, user_id, document, version, surface) VALUES ($1, $2, 'terms', '2026-08-01', 'billboard')",
      [randomUUID(), userId]
    )).rejects.toThrow();
  });
});
