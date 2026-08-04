// Admin-invoked retention tool; the service also runs the operations sweep on a schedule
// (retention.ts).
//
// Tables that participate in cursor-based reconnect -- tasks, claims, handoffs, intents,
// validations -- are still off limits here: a long-offline replica downloads everything
// after its last-known cursor, and age-pruning them would hand it a short list it would
// read as "caught up". Do not extend this script to any of them.
//
// `operations` used to be on that list and no longer is, because it is the one table that
// now has a protocol answer for the problem: pruneOperationsByRetention() deletes strictly
// a prefix of each workspace's sequence and records how far it reached, and a replica
// asking for a cursor below that watermark is told to resync (cursor-too-old) instead of
// being served a truncated page. The window is the plan's, not this script's
// --older-than-days, which governs only audit_events and sessions.
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
    const swept = await store.pruneOperationsByRetention();
    const operationsDeleted = swept.reduce((total, result) => total + result.deleted, 0);
    process.stdout.write(`operations deleted: ${operationsDeleted}\n`);
    for (const result of swept.filter((entry) => entry.deleted > 0)) {
      process.stdout.write(`  workspace ${result.workspaceId} (${result.plan}, ${result.retentionDays}d): ${result.deleted} through sequence ${result.prunedThrough}\n`);
    }
  }
  finally { await store.close(); }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Prune failed"}\n`);
  process.exitCode = 1;
});
