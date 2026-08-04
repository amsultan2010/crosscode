import { describe, expect, it } from "vitest";
import {
  BillingLimitError,
  PAID_PLANS,
  PLAN_LIMITS,
  PLAN_PRICING,
  StubBillingProvider,
  assertPlanAllowsAutonomyTier,
  assertSeatCapAvailable,
  assertSemanticReviewCallAvailable,
  clampAutonomyTierToPlan,
  entitlementForSubscription,
  maxAutonomyTierFor,
  priceCentsFor,
  seatQuantityFor,
  type PaidPlan,
  type SubscriptionState
} from "./billing.js";

function subscription(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    subscriptionId: "sub_1", customerId: "cus_1", status: "active", plan: "pro",
    interval: "year", seats: 1, cancelAtPeriodEnd: false, currentPeriodEnd: null,
    ...overrides
  };
}

describe("assertSeatCapAvailable", () => {
  it("allows adding a member while under the plan's seat cap", () => {
    expect(() => assertSeatCapAvailable("essential", PLAN_LIMITS.essential.seatCap - 1)).not.toThrow();
  });

  it("throws once the plan's seat cap would be reached", () => {
    expect(() => assertSeatCapAvailable("essential", PLAN_LIMITS.essential.seatCap)).toThrow(BillingLimitError);
  });

  it("never throws for the unlimited plan", () => {
    expect(() => assertSeatCapAvailable("unlimited", 10_000)).not.toThrow();
  });
});

describe("assertSemanticReviewCallAvailable", () => {
  // Semantic review runs on the member's own connected MCP agent and costs Crosscode
  // nothing, so it is uncapped on every plan -- free included. The assert helper is kept
  // for a future hosted-LLM offering; today it must never fire.
  it("never throws on any plan, at any usage", () => {
    for (const plan of Object.keys(PLAN_LIMITS) as Array<keyof typeof PLAN_LIMITS>) {
      expect(() => assertSemanticReviewCallAvailable(plan, 1_000_000)).not.toThrow();
    }
  });
});

describe("assertPlanAllowsAutonomyTier", () => {
  it("allows always-ask on every plan", () => {
    for (const plan of Object.keys(PLAN_LIMITS) as Array<keyof typeof PLAN_LIMITS>) {
      expect(() => assertPlanAllowsAutonomyTier(plan, "always-ask")).not.toThrow();
    }
  });

  it("allows auto-if-clean on every plan, including free", () => {
    for (const plan of Object.keys(PLAN_LIMITS) as Array<keyof typeof PLAN_LIMITS>) {
      expect(() => assertPlanAllowsAutonomyTier(plan, "auto-if-clean")).not.toThrow();
    }
  });

  it("gates auto-always to paid plans only", () => {
    expect(() => assertPlanAllowsAutonomyTier("free", "auto-always")).toThrow(BillingLimitError);
    for (const plan of ["essential", "pro", "unlimited", "team", "student"] as const) {
      expect(() => assertPlanAllowsAutonomyTier(plan, "auto-always")).not.toThrow();
    }
  });
});

describe("PLAN_LIMITS ladder", () => {
  it("keeps the free plan generous enough for a solo user with agents", () => {
    expect(PLAN_LIMITS.free.seatCap).toBeGreaterThanOrEqual(5);
    expect(PLAN_LIMITS.free.semanticReviewCallsPerMonth).toBe(Infinity);
    expect(PLAN_LIMITS.free.autonomyTiers).toContain("auto-if-clean");
  });

  it("never lets a paid plan be worse than free on any axis", () => {
    for (const plan of ["essential", "pro", "unlimited", "team", "student"] as const) {
      expect(PLAN_LIMITS[plan].seatCap).toBeGreaterThanOrEqual(PLAN_LIMITS.free.seatCap);
      expect(PLAN_LIMITS[plan].historyRetentionDays).toBeGreaterThanOrEqual(PLAN_LIMITS.free.historyRetentionDays);
      expect(PLAN_LIMITS[plan].autonomyTiers.length).toBeGreaterThanOrEqual(PLAN_LIMITS.free.autonomyTiers.length);
    }
  });

  it("orders retention monotonically up the priced ladder", () => {
    const ladder = ["free", "essential", "pro", "unlimited"] as const;
    for (let index = 1; index < ladder.length; index += 1) {
      expect(PLAN_LIMITS[ladder[index]!].historyRetentionDays)
        .toBeGreaterThan(PLAN_LIMITS[ladder[index - 1]!].historyRetentionDays);
    }
  });

  it("gives team the same caps as unlimited, since it is differentiated by org controls", () => {
    expect(PLAN_LIMITS.team.seatCap).toBe(PLAN_LIMITS.unlimited.seatCap);
    expect(PLAN_LIMITS.team.historyRetentionDays).toBe(PLAN_LIMITS.unlimited.historyRetentionDays);
  });

  it("gives student pro-level limits", () => {
    expect(PLAN_LIMITS.student.seatCap).toBe(PLAN_LIMITS.pro.seatCap);
    expect(PLAN_LIMITS.student.historyRetentionDays).toBe(PLAN_LIMITS.pro.historyRetentionDays);
  });
});

describe("pricing ladder", () => {
  it("prices a year at ten months on every paid plan", () => {
    for (const plan of PAID_PLANS) {
      expect(PLAN_PRICING[plan].annualCents).toBe(PLAN_PRICING[plan].monthlyCents * 10);
    }
  });

  it("matches the published ladder, and gives student essential's price with pro's limits", () => {
    expect(PLAN_PRICING.essential.monthlyCents).toBe(250);
    expect(PLAN_PRICING.pro.monthlyCents).toBe(500);
    expect(PLAN_PRICING.unlimited.monthlyCents).toBe(750);
    expect(PLAN_PRICING.student.monthlyCents).toBe(PLAN_PRICING.essential.monthlyCents);
    expect(PLAN_LIMITS.student.historyRetentionDays).toBe(PLAN_LIMITS.pro.historyRetentionDays);
  });

  it("charges team per seat and everything else flat", () => {
    expect(seatQuantityFor("team", 7)).toBe(7);
    expect(priceCentsFor("team", "month", 7)).toBe(7 * 500);
    for (const plan of PAID_PLANS.filter((candidate) => candidate !== "team")) {
      expect(seatQuantityFor(plan, 7)).toBe(1);
      expect(priceCentsFor(plan, "month", 7)).toBe(PLAN_PRICING[plan].monthlyCents);
    }
  });

  it("lets unlimited undercut team from two seats up, which is the documented tradeoff", () => {
    expect(priceCentsFor("team", "month", 2)).toBeGreaterThan(priceCentsFor("unlimited", "month", 2));
    expect(priceCentsFor("team", "month", 1)).toBeLessThan(priceCentsFor("unlimited", "month", 1));
  });
});

describe("autonomy clamping on downgrade", () => {
  it("caps free at auto-if-clean and every paid plan at auto-always", () => {
    expect(maxAutonomyTierFor("free")).toBe(1);
    for (const plan of PAID_PLANS) expect(maxAutonomyTierFor(plan)).toBe(2);
  });

  it("falls back rather than erroring when a downgrade removes the tier in use", () => {
    // The paid wall costs the feature, not the workspace: a workspace on auto-always that
    // loses its plan lands on auto-if-clean and keeps working.
    expect(clampAutonomyTierToPlan(2, "free")).toBe(1);
    expect(clampAutonomyTierToPlan(1, "free")).toBe(1);
    expect(clampAutonomyTierToPlan(0, "free")).toBe(0);
    expect(clampAutonomyTierToPlan(2, "pro")).toBe(2);
  });
});

describe("entitlementForSubscription", () => {
  it("grants the paid plan while the subscription is healthy", () => {
    expect(entitlementForSubscription(subscription({ status: "active" }))).toEqual({ plan: "pro", inGrace: false });
    expect(entitlementForSubscription(subscription({ status: "trialing" }))).toEqual({ plan: "pro", inGrace: false });
  });

  it("keeps every paid limit while a payment is failing, and opens a grace period", () => {
    // A failed card must not cost anyone access mid-task; Stripe is still retrying.
    for (const status of ["past_due", "incomplete", "unpaid"] as const) {
      expect(entitlementForSubscription(subscription({ status }))).toEqual({ plan: "pro", inGrace: true });
    }
  });

  it("falls back to free's limits once the subscription is terminal, never destroying anything", () => {
    for (const status of ["canceled", "incomplete_expired", "paused"] as const) {
      expect(entitlementForSubscription(subscription({ status }))).toEqual({ plan: "free", inGrace: false });
    }
  });

  it("grants free when the subscription's price is not in this deployment's catalog", () => {
    // Better no plan than a guessed one: an unrecognized price must not buy limits, and
    // with nothing to protect a failing payment opens no grace period either.
    expect(entitlementForSubscription(subscription({ plan: null }))).toEqual({ plan: "free", inGrace: false });
    expect(entitlementForSubscription(subscription({ plan: null, status: "past_due" }))).toEqual({ plan: "free", inGrace: false });
  });

  it("never grants a plan outside PLAN_LIMITS, whatever the status", () => {
    const statuses = ["active", "trialing", "past_due", "incomplete", "unpaid", "canceled", "incomplete_expired", "paused"] as const;
    for (const status of statuses) {
      for (const plan of [...PAID_PLANS, null] as Array<PaidPlan | null>) {
        expect(PLAN_LIMITS[entitlementForSubscription(subscription({ status, plan })).plan]).toBeDefined();
      }
    }
  });
});

describe("StubBillingProvider", () => {
  it("creates an in-memory customer without any network calls", async () => {
    const provider = new StubBillingProvider();
    const customer = await provider.createCustomer("workspace-1", "owner@example.com");
    expect(customer.workspaceId).toBe("workspace-1");
    expect(customer.customerId).toBeTruthy();
  });

  it("returns a stub checkout session URL, defaulting to annual", async () => {
    const provider = new StubBillingProvider();
    const session = await provider.createCheckoutSession("workspace-1", "pro");
    expect(session.url).toContain("workspace-1");
    expect(session.url).toContain("pro");
    // Annual is the default everywhere the caller does not say, because at $2.50/month the
    // processor's fixed fee is ~15% of the charge against ~4% on the annual one.
    expect(session.url).toContain("year");
    expect((await provider.createCheckoutSession("workspace-1", "pro", { interval: "month" })).url).toContain("month");
  });

  it("cancels a subscription as a no-op without throwing", async () => {
    const provider = new StubBillingProvider();
    await expect(provider.cancelSubscription("workspace-1")).resolves.toBeUndefined();
  });
});
