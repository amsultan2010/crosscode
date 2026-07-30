// Admin-invoked-only retention tool. Most tables (operations, tasks, claims, handoffs,
// intents, validations) participate in cursor-based reconnect, where a long-offline replica
// downloads everything after its last-known cursor — pruning them by age would silently break
// that guarantee. Only audit_events (a pure audit trail) and ended sessions (presence
// bookkeeping) are safe to prune here; do not extend this script to any other table.
import { PgStore } from "./store.js";

function parseOlderThanDays(argv: readonly string[]): number {
  const index = argv.indexOf("--older-than-days");
  if (index === -1 || !argv[index + 1]) throw new Error("--older-than-days <n> is required");
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error("--older-than-days must be a positive integer");
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
  const olderThanDays = parseOlderThanDays(process.argv.slice(2));
  const store = new PgStore(databaseUrl);
  try {
    const auditEventsDeleted = await store.pruneAuditEvents(olderThanDays);
    const sessionsDeleted = await store.pruneEndedSessions(olderThanDays);
    process.stdout.write(`audit_events deleted: ${auditEventsDeleted}\n`);
    process.stdout.write(`sessions deleted: ${sessionsDeleted}\n`);
  }
  finally { await store.close(); }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Prune failed"}\n`);
  process.exitCode = 1;
});
