import { describe, expect, it } from "vitest";
import {
  BillingLimitError,
  PLAN_LIMITS,
  StubBillingProvider,
  assertPlanAllowsAutonomyTier,
  assertSeatCapAvailable,
  assertSemanticReviewCallAvailable
} from "./billing.js";

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
  it("allows a call while usage is under the plan's monthly cap", () => {
    expect(() => assertSemanticReviewCallAvailable("pro", PLAN_LIMITS.pro.semanticReviewCallsPerMonth - 1)).not.toThrow();
  });

  it("throws once the plan's monthly review-call cap would be exceeded", () => {
    expect(() => assertSemanticReviewCallAvailable("pro", PLAN_LIMITS.pro.semanticReviewCallsPerMonth)).toThrow(BillingLimitError);
  });

  it("always throws on the free plan, which has no review calls", () => {
    expect(() => assertSemanticReviewCallAvailable("free", 0)).toThrow(BillingLimitError);
  });

  it("never throws for the unlimited plan", () => {
    expect(() => assertSemanticReviewCallAvailable("unlimited", 1_000_000)).not.toThrow();
  });
});

describe("assertPlanAllowsAutonomyTier", () => {
  it("allows always-ask on every plan", () => {
    for (const plan of Object.keys(PLAN_LIMITS) as Array<keyof typeof PLAN_LIMITS>) {
      expect(() => assertPlanAllowsAutonomyTier(plan, "always-ask")).not.toThrow();
    }
  });

  it("throws for auto-if-clean on plans that don't unlock it", () => {
    expect(() => assertPlanAllowsAutonomyTier("free", "auto-if-clean")).toThrow(BillingLimitError);
    expect(() => assertPlanAllowsAutonomyTier("essential", "auto-if-clean")).toThrow(BillingLimitError);
  });

  it("allows auto-if-clean on pro, unlimited, and student", () => {
    expect(() => assertPlanAllowsAutonomyTier("pro", "auto-if-clean")).not.toThrow();
    expect(() => assertPlanAllowsAutonomyTier("unlimited", "auto-if-clean")).not.toThrow();
    expect(() => assertPlanAllowsAutonomyTier("student", "auto-if-clean")).not.toThrow();
  });

  it("throws for auto-always on every plan except unlimited", () => {
    expect(() => assertPlanAllowsAutonomyTier("free", "auto-always")).toThrow(BillingLimitError);
    expect(() => assertPlanAllowsAutonomyTier("essential", "auto-always")).toThrow(BillingLimitError);
    expect(() => assertPlanAllowsAutonomyTier("pro", "auto-always")).toThrow(BillingLimitError);
    expect(() => assertPlanAllowsAutonomyTier("student", "auto-always")).toThrow(BillingLimitError);
    expect(() => assertPlanAllowsAutonomyTier("unlimited", "auto-always")).not.toThrow();
  });
});

describe("StubBillingProvider", () => {
  it("creates an in-memory customer without any network calls", async () => {
    const provider = new StubBillingProvider();
    const customer = await provider.createCustomer("workspace-1", "owner@example.com");
    expect(customer.workspaceId).toBe("workspace-1");
    expect(customer.customerId).toBeTruthy();
  });

  it("returns a stub checkout session URL", async () => {
    const provider = new StubBillingProvider();
    const session = await provider.createCheckoutSession("workspace-1", "pro");
    expect(session.url).toContain("workspace-1");
    expect(session.url).toContain("pro");
  });

  it("cancels a subscription as a no-op without throwing", async () => {
    const provider = new StubBillingProvider();
    await expect(provider.cancelSubscription("workspace-1")).resolves.toBeUndefined();
  });
});
