import type { PgStore } from "./store.js";

export type Plan = "free" | "essential" | "pro" | "unlimited" | "team" | "student";
/** Every plan that costs money, i.e. everything a checkout can be started for. */
export type PaidPlan = Exclude<Plan, "free">;
export type AutonomyTier = "always-ask" | "auto-if-clean" | "auto-always";
export type BillingInterval = "month" | "year";

export const PAID_PLANS: readonly PaidPlan[] = ["essential", "pro", "unlimited", "team", "student"];

export class BillingLimitError extends Error {}
/** A billing action that cannot be carried out at all, e.g. checkout with no Stripe key. */
export class BillingConfigurationError extends Error {}

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
// (operations, whose event column holds every proposed file body). It is enforced by
// PgStore.pruneOperationsByRetention(), swept on a schedule by retention.ts.
// Team is differentiated by org controls -- SSO, audit export
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

/**
 * How many workspaces one user may create for themselves.
 *
 * Plans are per-workspace, so without this an account can farm unlimited free workspaces --
 * each with its own seats, its own retention window, and its own storage -- and use the
 * hosted service as free unmetered storage. Set far above what a real person needs (a
 * heavy user runs a handful of repos, and repos are unlimited *within* a workspace), so it
 * is an abuse ceiling rather than a plan wall.
 *
 * The Contract C personal workspace is deliberately outside this count: it is provisioned
 * by ensurePersonalWorkspace(), not createWorkspace(), so a user can never be locked out of
 * the workspace their first authenticated request depends on.
 */
export const MAX_SELF_SERVE_WORKSPACES_PER_USER = 10;

export function assertSelfServeWorkspaceAvailable(currentOwnedCount: number): void {
  if (currentOwnedCount >= MAX_SELF_SERVE_WORKSPACES_PER_USER) {
    throw new BillingLimitError(
      `You already own ${MAX_SELF_SERVE_WORKSPACES_PER_USER} workspaces, which is the per-account limit`
    );
  }
}

// workspaces.autonomy_tier is stored as 0/1/2; PLAN_LIMITS names the same three tiers.
export const AUTONOMY_TIER_NAMES: Record<0 | 1 | 2, AutonomyTier> = {
  0: "always-ask",
  1: "auto-if-clean",
  2: "auto-always"
};

/**
 * The highest autonomy tier a plan unlocks. A downgrade clamps to this rather than
 * erroring: auto-always is the paid wall, so losing it has to feel like losing a feature,
 * not like the workspace breaking. Falling back to auto-if-clean keeps proposals flowing.
 */
export function maxAutonomyTierFor(plan: Plan): 0 | 1 | 2 {
  const allowed = PLAN_LIMITS[plan].autonomyTiers;
  for (const tier of [2, 1, 0] as const) {
    if (allowed.includes(AUTONOMY_TIER_NAMES[tier])) return tier;
  }
  return 0;
}

/** The clamp above, applied to a stored tier. Used on the read path as well as the write
 *  path, so a workspace whose grace period lapsed between sweeps still reports the tier it
 *  is entitled to rather than the one it last paid for. */
export function clampAutonomyTierToPlan(tier: 0 | 1 | 2, plan: Plan): 0 | 1 | 2 {
  const maximum = maxAutonomyTierFor(plan);
  return tier > maximum ? maximum : tier;
}

// Monthly and annual list prices, in cents. Annual is twelve months for the price of ten.
//
// Annual is not a discount for its own sake: at $2.50/mo Stripe takes $0.30 + 2.9%, which
// is ~15% of the charge, against ~4% on a $25 annual one. At this end of the price ladder
// the payment fee is the single largest cost line, so annual is the default the CLI offers
// and monthly is the opt-out (see DEFAULT_BILLING_INTERVAL and `crosscode billing plans`).
//
// Team is per-seat and priced at Pro's per-head rate. Unlimited therefore undercuts it
// from two seats up, which is the deliberate tradeoff recorded in BUILD_INSTRUCTIONS.md:
// Team is bought for org controls, not for seat count.
export const PLAN_PRICING: Record<PaidPlan, { monthlyCents: number; annualCents: number; perSeat: boolean }> = {
  essential: { monthlyCents: 250, annualCents: 2_500, perSeat: false },
  pro: { monthlyCents: 500, annualCents: 5_000, perSeat: false },
  unlimited: { monthlyCents: 750, annualCents: 7_500, perSeat: false },
  team: { monthlyCents: 500, annualCents: 5_000, perSeat: true },
  student: { monthlyCents: 250, annualCents: 2_500, perSeat: false }
};

export const DEFAULT_BILLING_INTERVAL: BillingInterval = "year";

/**
 * How long a workspace keeps its paid limits after a payment fails. Chosen to outlast
 * Stripe's default dunning schedule (retries over ~3 weeks are configurable, but the first
 * few land inside two weeks), so the common case -- an expired card that gets replaced --
 * never costs anyone access at all.
 */
export const PAYMENT_GRACE_PERIOD_DAYS = 14;

export function priceCentsFor(plan: PaidPlan, interval: BillingInterval, seats: number): number {
  const pricing = PLAN_PRICING[plan];
  const unit = interval === "year" ? pricing.annualCents : pricing.monthlyCents;
  return unit * (pricing.perSeat ? Math.max(1, seats) : 1);
}

/** Team bills per active member; every other plan is one flat subscription. */
export function seatQuantityFor(plan: PaidPlan, activeMemberCount: number): number {
  return PLAN_PRICING[plan].perSeat ? Math.max(1, activeMemberCount) : 1;
}

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
  /** The plan being paid for, which differs from `plan` only while a payment is failing. */
  billingPlan: PaidPlan | null;
  billingInterval: BillingInterval | null;
  billingStatus: string | null;
  billingSeats: number | null;
  /** Set only during a dunning grace period; the deadline after which free's limits apply. */
  gracePeriodEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  /** Who the receipts go to. Advisory -- the subscription belongs to the workspace. */
  billingOwnerActorId: string | null;
  /** null when this deployment has no Stripe key, which is the self-hosted case. */
  priceCents: number | null;
};

// Read-only summary for the CLI's `crosscode billing status`.
export async function getWorkspaceBillingStatus(store: PgStore, workspaceId: string, when: Date = new Date()): Promise<WorkspaceBillingStatus> {
  // Reads the *effective* plan, which is the stored plan unless a grace period has lapsed
  // since the last sweep -- see PgStore.getWorkspaceBilling.
  const record = await store.getWorkspaceBilling(workspaceId);
  const currentMemberCount = await store.countActiveMembers(workspaceId);

  const usageResult = await store.pool.query<{ count: number }>(
    "SELECT count FROM usage_counters WHERE workspace_id = $1 AND metric = 'semantic_review_calls' AND period_start = $2",
    [workspaceId, monthStart(when)]
  );
  const semanticReviewCallsUsedThisMonth = usageResult.rows[0]?.count ?? 0;

  const limits = PLAN_LIMITS[record.plan];
  return {
    workspaceId,
    plan: record.plan,
    seatCap: limits.seatCap,
    currentMemberCount,
    semanticReviewCallsPerMonth: limits.semanticReviewCallsPerMonth,
    semanticReviewCallsUsedThisMonth,
    autonomyTiers: limits.autonomyTiers,
    historyRetentionDays: limits.historyRetentionDays,
    billingPlan: record.billingPlan,
    billingInterval: record.billingInterval,
    billingStatus: record.billingStatus,
    billingSeats: record.billingSeats,
    gracePeriodEndsAt: record.gracePeriodEndsAt,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    currentPeriodEnd: record.currentPeriodEnd,
    billingOwnerActorId: record.billingOwnerActorId,
    priceCents: record.billingPlan && record.billingInterval
      ? priceCentsFor(record.billingPlan, record.billingInterval, record.billingSeats ?? 1)
      : null
  };
}

export type BillingCustomer = { customerId: string; workspaceId: string };
export type CheckoutSession = { url: string };

export type CheckoutOptions = {
  interval?: BillingInterval;
  /** Subscription quantity. Only Team charges per seat; see seatQuantityFor(). */
  seats?: number;
  /** Reuse the workspace's existing customer so a second purchase does not orphan a card. */
  customerId?: string | null;
  /** Prefills the checkout form when the workspace has no customer yet. */
  email?: string | null;
};

export type ChangeSubscriptionInput = {
  subscriptionId: string;
  plan: PaidPlan;
  interval: BillingInterval;
  seats: number;
};

/**
 * Stripe's subscription statuses, verbatim. Kept as the provider's vocabulary rather than
 * collapsed at the edge, because entitlementForSubscription() below is the single place
 * that decides what each one means for a workspace, and it is worth being able to read it.
 */
export type SubscriptionStatus =
  | "active" | "trialing" | "past_due" | "incomplete" | "incomplete_expired" | "unpaid" | "canceled" | "paused";

export type SubscriptionState = {
  subscriptionId: string;
  customerId: string;
  status: SubscriptionStatus;
  /** Null when the subscription's price is not in this deployment's configured catalog. */
  plan: PaidPlan | null;
  interval: BillingInterval | null;
  seats: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

/**
 * The billing provider seam. Deliberately stateless and keyed by provider ids rather than
 * by workspace: the workspace -> customer/subscription mapping lives in Postgres, which is
 * the only place it can be transactional with the plan it grants.
 */
export interface BillingProvider {
  createCustomer(workspaceId: string, email: string): Promise<BillingCustomer>;
  createCheckoutSession(workspaceId: string, plan: PaidPlan, options?: CheckoutOptions): Promise<CheckoutSession>;
  /** Moves an existing subscription up or down the ladder in place, with proration. */
  changeSubscription(input: ChangeSubscriptionInput): Promise<void>;
  /** Team's per-seat quantity, re-set when membership changes mid-cycle. */
  setSeatQuantity(subscriptionId: string, seats: number): Promise<void>;
  /**
   * Cancels at the end of the paid period, never immediately: the workspace paid for the
   * period it is in, and nothing about a downgrade should take effect early.
   */
  cancelSubscription(subscriptionId: string): Promise<void>;
  /**
   * Authoritative current state, re-read from the provider. The webhook handler calls this
   * instead of trusting the event body, which is what makes out-of-order and replayed
   * deliveries harmless -- see http.ts.
   */
  getSubscriptionState(subscriptionId: string): Promise<SubscriptionState>;
  /** A provider-hosted page for cards and invoices. Not a Crosscode web UI. */
  createPortalSession(customerId: string, returnUrl?: string): Promise<CheckoutSession>;
}

/**
 * What a subscription's status entitles a workspace to. The two rules the lifecycle is
 * built on live here: a failing payment never costs access immediately (it opens a grace
 * period during which every paid limit is retained), and a terminal status falls back to
 * free's *limits* without deleting anything -- members, history, and the stored autonomy
 * tier all survive, they are just no longer all reachable.
 */
export function entitlementForSubscription(state: SubscriptionState): { plan: Plan; inGrace: boolean } {
  switch (state.status) {
    case "active":
    case "trialing":
      return { plan: state.plan ?? "free", inGrace: false };
    // Dunning. Stripe is still retrying the card; the workspace keeps everything.
    // A subscription with no recognizable plan has nothing to protect, so it opens no
    // grace period rather than leaving a deadline set on a workspace already at free.
    case "past_due":
    case "incomplete":
    case "unpaid":
      return state.plan ? { plan: state.plan, inGrace: true } : { plan: "free", inGrace: false };
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return { plan: "free", inGrace: false };
  }
}

/**
 * Best-effort seat reconciliation for Team, whose price is per active member. Stripe
 * prorates the difference for the remainder of the cycle by itself, so this is one call
 * with no arithmetic on our side.
 *
 * Never throws: a workspace owner removing a member must not be blocked because Stripe is
 * unreachable, and the quantity self-corrects on the next membership or plan change.
 */
export async function reconcileSeatQuantity(
  store: PgStore, provider: BillingProvider, workspaceId: string,
  onError: (error: unknown) => void
): Promise<void> {
  try {
    const record = await store.getWorkspaceBilling(workspaceId);
    if (record.billingPlan !== "team" || !record.stripeSubscriptionId) return;
    if (record.billingStatus === "canceled" || record.billingStatus === "incomplete_expired") return;
    const seats = seatQuantityFor("team", await store.countActiveMembers(workspaceId));
    if (seats === record.billingSeats) return;
    await provider.setSeatQuantity(record.stripeSubscriptionId, seats);
    await store.recordSeatQuantity(workspaceId, seats);
  } catch (error) {
    onError(error);
  }
}

/**
 * Safe no-op/in-memory default for deployments with no Stripe key: self-hosters, tests,
 * and local development. Everything it returns is inert, and http.ts refuses to expose the
 * webhook route at all unless a real signing secret is configured, so a service running on
 * this provider simply has no billing surface rather than a fake one.
 */
export class StubBillingProvider implements BillingProvider {
  private readonly customers = new Map<string, BillingCustomer>();
  private readonly seats = new Map<string, number>();

  async createCustomer(workspaceId: string, _email: string): Promise<BillingCustomer> {
    const customer: BillingCustomer = { customerId: `stub_cus_${workspaceId}`, workspaceId };
    this.customers.set(workspaceId, customer);
    return customer;
  }

  async createCheckoutSession(workspaceId: string, plan: PaidPlan, options: CheckoutOptions = {}): Promise<CheckoutSession> {
    const interval = options.interval ?? DEFAULT_BILLING_INTERVAL;
    return { url: `stub://checkout/${workspaceId}/${plan}/${interval}` };
  }

  async changeSubscription(_input: ChangeSubscriptionInput): Promise<void> {
    // No-op: no real subscription exists to move.
  }

  async setSeatQuantity(subscriptionId: string, seats: number): Promise<void> {
    this.seats.set(subscriptionId, seats);
  }

  async cancelSubscription(_subscriptionId: string): Promise<void> {
    // No-op: no real subscription exists to cancel.
  }

  async getSubscriptionState(subscriptionId: string): Promise<SubscriptionState> {
    return {
      subscriptionId, customerId: `stub_cus_${subscriptionId}`, status: "active",
      plan: null, interval: null, seats: this.seats.get(subscriptionId) ?? 1,
      cancelAtPeriodEnd: false, currentPeriodEnd: null
    };
  }

  async createPortalSession(customerId: string, _returnUrl?: string): Promise<CheckoutSession> {
    return { url: `stub://portal/${customerId}` };
  }
}
