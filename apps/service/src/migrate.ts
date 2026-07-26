import { PgStore } from "./store.js";

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
      await store.pool.query(`GRANT INSERT ON replicas, operations, operation_files, audit_events TO ${role}`);
      await store.pool.query(`GRANT UPDATE (used_at) ON enrollments TO ${role}`);
      await store.pool.query(`GRANT UPDATE (last_seen_at) ON replicas TO ${role}`);
      await store.pool.query(`GRANT UPDATE (next_sequence) ON workspaces TO ${role}`);
    }
  }
  finally { await store.close(); }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Migration failed"}\n`);
  process.exitCode = 1;
});
