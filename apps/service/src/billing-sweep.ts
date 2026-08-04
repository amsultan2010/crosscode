// Writes down the effect of a lapsed payment grace period: the workspace falls to free's
// limits, its autonomy tier is clamped to what free unlocks, and nothing is deleted.
//
// Deliberately not part of prune.ts, which is a retention tool with a standing warning
// against being extended -- this deletes nothing at all. It is also not load-bearing for
// enforcement: every read path derives the effective plan from the grace deadline directly
// (EFFECTIVE_PLAN_SQL in store.ts), so a service whose sweep has not run for a week still
// refuses seats and auto-always correctly. This exists so the stored plan, the audit trail,
// and `crosscode billing status` eventually agree with what is already being enforced.
//
// Run it on a schedule (daily is ample -- the grace period is measured in weeks).
import { PgStore } from "./store.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
  const store = new PgStore(databaseUrl);
  try {
    const expired = await store.expireBillingGracePeriods();
    process.stdout.write(`grace periods expired: ${expired}\n`);
  } finally {
    await store.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Billing sweep failed"}\n`);
  process.exitCode = 1;
});
