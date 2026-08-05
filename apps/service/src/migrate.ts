import { PgStore } from "./store.js";

/**
 * Applies the schema, then (optionally) narrows what the role the service actually runs as
 * may do. The split matters: migrations own the tables, the runtime does not, and the
 * change log stays append-only because the runtime role has no way to rewrite it.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
  const store = new PgStore(databaseUrl);
  try {
    await store.migrate();
    const runtimeRole = process.env.CROSSCODE_RUNTIME_DB_ROLE;
    if (runtimeRole) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtimeRole)) throw new Error("CROSSCODE_RUNTIME_DB_ROLE is invalid");
      const role = `"${runtimeRole}"`;
      await store.pool.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`);
      await store.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await store.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
      await store.pool.query(`GRANT INSERT ON users, projects, project_members, invites, replicas, file_versions TO ${role}`);
      // Exactly the columns the routes write after a row exists, and nothing else. No
      // UPDATE at all on file_versions: retention deletes rows as the migration role.
      await store.pool.query(`GRANT UPDATE (github_id, github_login, email) ON users TO ${role}`);
      await store.pool.query(`GRANT UPDATE (redeemed_at, redeemed_by) ON invites TO ${role}`);
      await store.pool.query(`GRANT UPDATE (last_seen_at) ON replicas TO ${role}`);
    }
  }
  finally { await store.close(); }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Migration failed"}\n`);
  process.exitCode = 1;
});
