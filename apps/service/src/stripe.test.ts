import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  StripeApiError,
  StripeBillingProvider,
  StripeSignatureError,
  encodeStripeForm,
  parseStripePriceCatalog,
  verifyStripeSignature
} from "./stripe.js";

const PRICES = JSON.stringify({
  essential: { month: "price_essential_month", year: "price_essential_year" },
  pro: { month: "price_pro_month", year: "price_pro_year" },
  unlimited: { year: "price_unlimited_year" },
  team: { month: "price_team_month", year: "price_team_year" }
});

/** Records every request and answers each path with a canned body. */
function recordingFetch(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: URL | string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      method: init.method ?? "GET",
      path,
      body: typeof init.body === "string" ? init.body : "",
      headers: (init.headers ?? {}) as Record<string, string>
    });
    const payload = responses[`${init.method ?? "GET"} ${path}`] ?? responses[path];
    if (payload === undefined) return new Response(JSON.stringify({ error: { message: "no stub" } }), { status: 404 });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function provider(fetchImpl: typeof fetch): StripeBillingProvider {
  return new StripeBillingProvider({
    secretKey: "sk_test_123",
    prices: parseStripePriceCatalog(PRICES),
    successUrl: "https://crosscode.dev/billing/done",
    cancelUrl: "https://crosscode.dev/billing/cancelled",
    fetchImpl
  });
}

const ACTIVE_SUBSCRIPTION = {
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  current_period_end: 1_800_000_000,
  items: { data: [{ id: "si_1", quantity: 3, price: { id: "price_team_year", recurring: { interval: "year" } } }] }
};

describe("encodeStripeForm", () => {
  it("encodes nested objects and arrays the way Stripe's API expects", () => {
    expect(encodeStripeForm({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 2 }],
      metadata: { workspaceId: "w-1" },
      allow_promotion_codes: true
    })).toBe(
      "mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=2" +
      "&metadata%5BworkspaceId%5D=w-1&allow_promotion_codes=true"
    );
  });

  it("omits undefined and null rather than sending the strings", () => {
    expect(encodeStripeForm({ customer: undefined, coupon: null, price: "price_1" })).toBe("price=price_1");
  });
});

describe("parseStripePriceCatalog", () => {
  it("fills in every plan, leaving unconfigured intervals absent", () => {
    const catalog = parseStripePriceCatalog(PRICES);
    expect(catalog.pro).toEqual({ month: "price_pro_month", year: "price_pro_year" });
    expect(catalog.unlimited.month).toBeUndefined();
    expect(catalog.student).toEqual({});
  });

  it("refuses malformed JSON, unknown plans, and an empty catalog", () => {
    expect(() => parseStripePriceCatalog("not json")).toThrow(/must be JSON/);
    expect(() => parseStripePriceCatalog(JSON.stringify({ enterprise: { year: "price_x" } }))).toThrow(/not a valid price catalog/);
    expect(() => parseStripePriceCatalog("{}")).toThrow(/names no prices/);
  });

  it("refuses to check out an interval the catalog does not price", () => {
    // Better a clear refusal than a checkout session for the wrong cadence.
    expect(() => provider(recordingFetch({}).fetchImpl).priceFor("unlimited", "month")).toThrow(StripeApiError);
    expect(() => provider(recordingFetch({}).fetchImpl).priceFor("student", "year")).toThrow(/No Stripe price is configured/);
  });
});

describe("StripeBillingProvider", () => {
  it("creates a subscription checkout session with the annual price, seats, and the workspace link", async () => {
    const { calls, fetchImpl } = recordingFetch({ "/v1/checkout/sessions": { url: "https://checkout.stripe.com/c/pay/cs_1" } });

    const session = await provider(fetchImpl).createCheckoutSession("w-1", "team", { interval: "year", seats: 4, customerId: "cus_1" });

    expect(session.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("line_items[0][price]")).toBe("price_team_year");
    expect(body.get("line_items[0][quantity]")).toBe("4");
    expect(body.get("customer")).toBe("cus_1");
    // client_reference_id is what the webhook uses to find the workspace on a first purchase.
    expect(body.get("client_reference_id")).toBe("w-1");
    expect(body.get("subscription_data[metadata][workspaceId]")).toBe("w-1");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk_test_123");
  });

  it("keys customer creation on the workspace so a retry cannot leave two cards on file", async () => {
    const { calls, fetchImpl } = recordingFetch({ "/v1/customers": { id: "cus_new" } });

    await provider(fetchImpl).createCustomer("w-1", "owner@example.com");

    expect(calls[0]!.headers["idempotency-key"]).toBe("crosscode-customer-w-1");
    expect(new URLSearchParams(calls[0]!.body).get("metadata[workspaceId]")).toBe("w-1");
  });

  it("moves an existing subscription with proration and clears a pending cancellation", async () => {
    const { calls, fetchImpl } = recordingFetch({
      "/v1/subscriptions/sub_1": ACTIVE_SUBSCRIPTION,
      "POST /v1/subscriptions/sub_1": ACTIVE_SUBSCRIPTION
    });

    await provider(fetchImpl).changeSubscription({ subscriptionId: "sub_1", plan: "essential", interval: "month", seats: 1 });

    const update = new URLSearchParams(calls[1]!.body);
    expect(update.get("items[0][id]")).toBe("si_1");
    expect(update.get("items[0][price]")).toBe("price_essential_month");
    // Stripe does the mid-cycle arithmetic; there is deliberately none on this side.
    expect(update.get("proration_behavior")).toBe("create_prorations");
    // Changing plan is also an un-cancellation.
    expect(update.get("cancel_at_period_end")).toBe("false");
  });

  it("resizes seats only when the quantity actually changed", async () => {
    const { calls, fetchImpl } = recordingFetch({
      "/v1/subscriptions/sub_1": ACTIVE_SUBSCRIPTION,
      "POST /v1/subscriptions/sub_1": ACTIVE_SUBSCRIPTION
    });
    const stripe = provider(fetchImpl);

    await stripe.setSeatQuantity("sub_1", 3);
    expect(calls).toHaveLength(1);

    await stripe.setSeatQuantity("sub_1", 5);
    expect(new URLSearchParams(calls[2]!.body).get("items[0][quantity]")).toBe("5");
  });

  it("cancels at period end rather than immediately, so nothing is lost mid-period", async () => {
    const { calls, fetchImpl } = recordingFetch({ "POST /v1/subscriptions/sub_1": ACTIVE_SUBSCRIPTION });

    await provider(fetchImpl).cancelSubscription("sub_1");

    expect(calls[0]!.method).toBe("POST");
    expect(new URLSearchParams(calls[0]!.body).get("cancel_at_period_end")).toBe("true");
  });

  it("resolves the plan from the price catalog, not from editable metadata", async () => {
    const { fetchImpl } = recordingFetch({
      "/v1/subscriptions/sub_1": { ...ACTIVE_SUBSCRIPTION, metadata: { plan: "unlimited" } }
    });

    const state = await provider(fetchImpl).getSubscriptionState("sub_1");

    // The metadata claims unlimited; the price says team, and the price is what is charged.
    expect(state).toEqual({
      subscriptionId: "sub_1", customerId: "cus_1", status: "active", plan: "team",
      interval: "year", seats: 3, cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date(1_800_000_000_000).toISOString()
    });
  });

  it("reads the period end off the subscription item when the API version moved it there", async () => {
    const { fetchImpl } = recordingFetch({
      "/v1/subscriptions/sub_1": {
        ...ACTIVE_SUBSCRIPTION,
        current_period_end: undefined,
        items: { data: [{ id: "si_1", quantity: 1, current_period_end: 1_700_000_000, price: { id: "price_pro_year" } }] }
      }
    });

    const state = await provider(fetchImpl).getSubscriptionState("sub_1");

    expect(state.currentPeriodEnd).toBe(new Date(1_700_000_000_000).toISOString());
    expect(state.plan).toBe("pro");
  });

  it("reports a subscription priced outside the catalog as having no plan", async () => {
    const { fetchImpl } = recordingFetch({
      "/v1/subscriptions/sub_1": {
        ...ACTIVE_SUBSCRIPTION,
        items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_legacy", recurring: { interval: "month" } } }] }
      }
    });

    const state = await provider(fetchImpl).getSubscriptionState("sub_1");

    // Null, not a guess: granting a plan for a price this deployment does not recognize
    // would be the one way a subscription could buy limits nobody priced.
    expect(state.plan).toBeNull();
    expect(state.interval).toBe("month");
  });

  it("surfaces Stripe's own error message rather than a bare status", async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: { message: "No such subscription: sub_gone" } }), { status: 404 }
    )) as unknown as typeof fetch;

    await expect(provider(fetchImpl).getSubscriptionState("sub_gone")).rejects.toThrow("No such subscription: sub_gone");
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
  const sign = (payload: string, key: string, timestamp: number) =>
    createHmac("sha256", key).update(`${timestamp}.${payload}`, "utf8").digest("hex");

  it("accepts a correctly signed body inside the tolerance window", () => {
    const now = 1_800_000_000;
    expect(() => verifyStripeSignature(body, `t=${now},v1=${sign(body, secret, now)}`, secret, { nowSeconds: now })).not.toThrow();
  });

  it("accepts any of several v1 entries, as sent during a secret rotation", () => {
    const now = 1_800_000_000;
    const header = `t=${now},v1=${sign(body, "whsec_old", now)},v1=${sign(body, secret, now)}`;
    expect(() => verifyStripeSignature(body, header, secret, { nowSeconds: now })).not.toThrow();
  });

  it("refuses a body that was altered after signing", () => {
    const now = 1_800_000_000;
    const header = `t=${now},v1=${sign(body, secret, now)}`;
    expect(() => verifyStripeSignature(`${body} `, header, secret, { nowSeconds: now })).toThrow(StripeSignatureError);
  });

  it("refuses a signature made with a different secret", () => {
    const now = 1_800_000_000;
    expect(() => verifyStripeSignature(body, `t=${now},v1=${sign(body, "whsec_other", now)}`, secret, { nowSeconds: now }))
      .toThrow(/does not match/);
  });

  it("bounds replay of a genuinely signed capture in both directions", () => {
    const signedAt = 1_800_000_000;
    const header = `t=${signedAt},v1=${sign(body, secret, signedAt)}`;
    // Stale: captured off the wire and replayed an hour later.
    expect(() => verifyStripeSignature(body, header, secret, { nowSeconds: signedAt + 3_600 })).toThrow(/tolerance window/);
    // Future-dated, which is as much a sign of forgery as a stale one.
    expect(() => verifyStripeSignature(body, header, secret, { nowSeconds: signedAt - 3_600 })).toThrow(/tolerance window/);
    // Inside the window it still verifies.
    expect(() => verifyStripeSignature(body, header, secret, { nowSeconds: signedAt + 299 })).not.toThrow();
  });

  it("refuses a missing, timestampless, or signatureless header instead of passing it", () => {
    const now = 1_800_000_000;
    // Each of these would sail through an implementation that only checks the entries it
    // happens to find, which is the classic way this check gets written wrong.
    expect(() => verifyStripeSignature(body, undefined, secret, { nowSeconds: now })).toThrow(/missing/);
    expect(() => verifyStripeSignature(body, `v1=${sign(body, secret, now)}`, secret, { nowSeconds: now })).toThrow(/no timestamp/);
    expect(() => verifyStripeSignature(body, `t=${now}`, secret, { nowSeconds: now })).toThrow(/no v1 signature/);
    expect(() => verifyStripeSignature(body, `t=${now},v0=abc`, secret, { nowSeconds: now })).toThrow(/no v1 signature/);
    // A truncated digest must not compare equal to a prefix of the real one.
    expect(() => verifyStripeSignature(body, `t=${now},v1=${sign(body, secret, now).slice(0, 8)}`, secret, { nowSeconds: now }))
      .toThrow(/does not match/);
  });
});
