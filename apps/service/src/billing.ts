import type { PgStore } from "./store.js";

export type Plan = "free" | "essential" | "pro" | "unlimited" | "team" | "student";
export type AutonomyTier = "always-ask" | "auto-if-clean" | "auto-always";

export class BillingLimitError extends Error {}

const ALL_AUTONOMY_TIERS: readonly AutonomyTier[] = ["always-ask", "auto-if-clean", "auto-always"];

// Adoption-first ladder (BUILD_INSTRUCTIONS.md Phase 10). Two axes are deliberately NOT
// walls:
//
// - Semantic review is unlimited on every plan including free. It runs on the member's
//   own connected MCP agent and costs Crosscode nothing (see incrementSemanticReviewUsage
//   below), so capping it would be arbitrary friction rather than cost recovery.
// - Seats are generous below Team, because a workspace gets more valuable the more people
//   are in it. Charging per head below the org tier taxes the one loop that grows usage.
//
// What is left as a wall: auto-always autonomy (the "I trust it now" moment) and
// historyRetentionDays, which bounds the only table that grows without limit
// (operation_files.payload). Team is differentiated by org controls -- SSO, audit export
// -- not by seat count, which is why it shares Unlimited's caps. Student mirrors Pro's
// limits at Essential's price (verification is enforced elsewhere, not by these caps).
export const PLAN_LIMITS: Record<Plan, {
  seatCap: number;
  semanticReviewCallsPerMonth: number;
  autonomyTiers: readonly AutonomyTier[];
  historyRetentionDays: number;
}> = {
  free: { seatCap: 5, semanticReviewCallsPerMonth: Infinity, autonomyTiers: ["always-ask", "auto-if-clean"], historyRetentionDays: 7 },
  essential: { seatCap: 10, semanticReviewCallsPerMonth: Infinity, autonomyTiers: ALL_AUTONOMY_TIERS, historyRetentionDays: 30 },
  pro: { seatCap: 25, semanticReviewCallsPerMonth: Infinity, autonomyTiers: ALL_AUTONOMY_TIERS, historyRetentionDays: 90 },
  unlimited: { seatCap: Infinity, semanticReviewCallsPerMonth: Infinity, autonomyTiers: ALL_AUTONOMY_TIERS, historyRetentionDays: 365 },
  team: { seatCap: Infinity, semanticReviewCallsPerMonth: Infinity, autonomyTiers: ALL_AUTONOMY_TIERS, historyRetentionDays: 365 },
  student: { seatCap: 25, semanticReviewCallsPerMonth: Infinity, autonomyTiers: ALL_AUTONOMY_TIERS, historyRetentionDays: 90 }
};

export function assertSeatCapAvailable(plan: Plan, currentMemberCount: number): void {
  const { seatCap } = PLAN_LIMITS[plan];
  if (currentMemberCount >= seatCap) {
    throw new BillingLimitError(`Plan '${plan}' seat cap (${seatCap}) reached`);
  }
}

export function assertSemanticReviewCallAvailable(plan: Plan, usageThisMonth: number): void {
  const { semanticReviewCallsPerMonth } = PLAN_LIMITS[plan];
  if (usageThisMonth >= semanticReviewCallsPerMonth) {
    throw new BillingLimitError(`Plan '${plan}' semantic review call cap (${semanticReviewCallsPerMonth}) reached for this month`);
  }
}

export function assertPlanAllowsAutonomyTier(plan: Plan, tier: AutonomyTier): void {
  if (!PLAN_LIMITS[plan].autonomyTiers.includes(tier)) {
    throw new BillingLimitError(`Plan '${plan}' does not unlock autonomy tier '${tier}'`);
  }
}

function monthStart(when: Date): string {
  return `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// Increments the semantic-review-call counter for the current month. Callers should
// run assertSemanticReviewCallAvailable() first; this only records usage.
//
// Deliberately has no call site today, unlike the seat cap and autonomy tier, which are
// enforced in store.ts. Semantic review is delegated to the workspace member's own
// already-connected MCP agent (AgentDelegatedReviewer) and never leaves their machine,
// so there is no per-call cost to Crosscode to meter and no service-side request to hang
// a counter on. Wiring it up would mean adding a network round-trip to the service
// before every local review purely to bill for it. Keep this and
// assertSemanticReviewCallAvailable ready for the day an external, paid provider is
// offered; until then GET /v1/workspace/billing correctly reports 0 calls used.
export async function incrementSemanticReviewUsage(store: PgStore, workspaceId: string, when: Date = new Date()): Promise<number> {
  const result = await store.pool.query<{ count: number }>(
    `INSERT INTO usage_counters (workspace_id, metric, period_start, count)
     VALUES ($1, 'semantic_review_calls', $2, 1)
     ON CONFLICT (workspace_id, metric, period_start)
       DO UPDATE SET count = usage_counters.count + 1
     RETURNING count`,
    [workspaceId, monthStart(when)]
  );
  return result.rows[0]!.count;
}

export type WorkspaceBillingStatus = {
  workspaceId: string;
  plan: Plan;
  seatCap: number;
  currentMemberCount: number;
  semanticReviewCallsPerMonth: number;
  semanticReviewCallsUsedThisMonth: number;
  autonomyTiers: readonly AutonomyTier[];
  historyRetentionDays: number;
};

// Read-only summary for the CLI's `crosscode billing status`.
export async function getWorkspaceBillingStatus(store: PgStore, workspaceId: string, when: Date = new Date()): Promise<WorkspaceBillingStatus> {
  const workspaceResult = await store.pool.query<{ plan: Plan }>(
    "SELECT plan FROM workspaces WHERE id = $1",
    [workspaceId]
  );
  const workspace = workspaceResult.rows[0];
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const memberResult = await store.pool.query<{ count: string }>(
    "SELECT count(*) FROM members WHERE workspace_id = $1 AND disabled_at IS NULL",
    [workspaceId]
  );
  const currentMemberCount = Number(memberResult.rows[0]!.count);

  const usageResult = await store.pool.query<{ count: number }>(
    "SELECT count FROM usage_counters WHERE workspace_id = $1 AND metric = 'semantic_review_calls' AND period_start = $2",
    [workspaceId, monthStart(when)]
  );
  const semanticReviewCallsUsedThisMonth = usageResult.rows[0]?.count ?? 0;

  const limits = PLAN_LIMITS[workspace.plan];
  return {
    workspaceId,
    plan: workspace.plan,
    seatCap: limits.seatCap,
    currentMemberCount,
    semanticReviewCallsPerMonth: limits.semanticReviewCallsPerMonth,
    semanticReviewCallsUsedThisMonth,
    autonomyTiers: limits.autonomyTiers,
    historyRetentionDays: limits.historyRetentionDays
  };
}

export type BillingCustomer = { customerId: string; workspaceId: string };
export type CheckoutSession = { url: string };

export interface BillingProvider {
  createCustomer(workspaceId: string, email: string): Promise<BillingCustomer>;
  createCheckoutSession(workspaceId: string, plan: Exclude<Plan, "free">): Promise<CheckoutSession>;
  cancelSubscription(workspaceId: string): Promise<void>;
}

// Safe no-op/in-memory default until a Stripe account exists. A real
// StripeBillingProvider implementing this same interface plugs in here later.
export class StubBillingProvider implements BillingProvider {
  private readonly customers = new Map<string, BillingCustomer>();

  async createCustomer(workspaceId: string, _email: string): Promise<BillingCustomer> {
    const customer: BillingCustomer = { customerId: `stub_cus_${workspaceId}`, workspaceId };
    this.customers.set(workspaceId, customer);
    return customer;
  }

  async createCheckoutSession(workspaceId: string, plan: Exclude<Plan, "free">): Promise<CheckoutSession> {
    return { url: `stub://checkout/${workspaceId}/${plan}` };
  }

  async cancelSubscription(_workspaceId: string): Promise<void> {
    // No-op: no real subscription exists to cancel.
  }
}
