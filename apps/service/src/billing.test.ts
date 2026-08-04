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
