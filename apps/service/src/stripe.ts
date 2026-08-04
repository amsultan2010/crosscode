// Stripe implementation of the BillingProvider seam in billing.ts.
//
// Written against Stripe's REST API with `fetch` and `node:crypto` rather than the official
// SDK, for two reasons. The provider's whole surface is six calls, and taking `fetchImpl` as
// an option makes every one of them testable offline against an exact expected request body
// -- which matters more here than anywhere else in this service, because the alternative is
// having no coverage at all until someone points it at a live Stripe account. And the
// service image stays free of a dependency whose only job would be to build form bodies.
//
// The one place that trade is genuinely load-bearing is verifyStripeSignature() below,
// which reimplements Stripe's documented signature scheme. It is the security boundary for
// the only unauthenticated write route in the service, so it is kept small, constant-time,
// and covered by tests for each way it must refuse.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  type BillingCustomer,
  type BillingInterval,
  type BillingProvider,
  type ChangeSubscriptionInput,
  type CheckoutOptions,
  type CheckoutSession,
  type PaidPlan,
  type SubscriptionState,
  type SubscriptionStatus,
  DEFAULT_BILLING_INTERVAL,
  PAID_PLANS
} from "./billing.js";

const STRIPE_API_BASE = "https://api.stripe.com";
/** Stripe's own documented replay window for webhook timestamps. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export class StripeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class StripeSignatureError extends Error {}

/** Which Stripe Price backs each (plan, interval) pair in this deployment. */
export type StripePriceCatalog = Record<PaidPlan, Partial<Record<BillingInterval, string>>>;

const priceCatalogSchema = z.record(
  z.enum(["essential", "pro", "unlimited", "team", "student"]),
  z.object({ month: z.string().min(1).optional(), year: z.string().min(1).optional() }).strict()
);

/**
 * Parses CROSSCODE_STRIPE_PRICES. One JSON secret rather than ten environment variables,
 * because ten is what makes an operator get one wrong and only find out at checkout.
 * A plan may omit an interval; asking to check out for the missing one is a clear refusal.
 */
export function parseStripePriceCatalog(raw: string): StripePriceCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CROSSCODE_STRIPE_PRICES must be JSON, e.g. {\"pro\":{\"year\":\"price_123\"}}");
  }
  const catalog = priceCatalogSchema.safeParse(parsed);
  if (!catalog.success) throw new Error(`CROSSCODE_STRIPE_PRICES is not a valid price catalog: ${catalog.error.issues[0]?.message ?? "unknown"}`);
  const complete = {} as StripePriceCatalog;
  for (const plan of PAID_PLANS) complete[plan] = catalog.data[plan] ?? {};
  if (Object.values(complete).every((prices) => Object.keys(prices).length === 0)) {
    throw new Error("CROSSCODE_STRIPE_PRICES names no prices; at least one plan/interval is required");
  }
  return complete;
}

export type StripeBillingOptions = {
  secretKey: string;
  prices: StripePriceCatalog;
  /** Where Stripe returns the browser after a completed or abandoned checkout. */
  successUrl: string;
  cancelUrl: string;
  /** Where the billing portal returns to. Defaults to successUrl. */
  portalReturnUrl?: string;
  apiBaseUrl?: string;
  /** Pins the Stripe API version when set; otherwise the account's default applies. */
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class StripeBillingProvider implements BillingProvider {
  private readonly priceToPlan: Map<string, { plan: PaidPlan; interval: BillingInterval }>;

  constructor(private readonly options: StripeBillingOptions) {
    this.priceToPlan = new Map();
    for (const plan of PAID_PLANS) {
      for (const interval of ["month", "year"] as const) {
        const price = options.prices[plan][interval];
        if (price) this.priceToPlan.set(price, { plan, interval });
      }
    }
  }

  priceFor(plan: PaidPlan, interval: BillingInterval): string {
    const price = this.options.prices[plan][interval];
    if (!price) throw new StripeApiError(400, `No Stripe price is configured for the ${interval}ly ${plan} plan`);
    return price;
  }

  async createCustomer(workspaceId: string, email: string): Promise<BillingCustomer> {
    // Keyed on the workspace so a retried request -- or two owners racing to be first to
    // upgrade -- cannot leave the workspace with two customers and two cards on file.
    const customer = await this.request<{ id: string }>("POST", "/v1/customers", {
      email,
      metadata: { workspaceId }
    }, `crosscode-customer-${workspaceId}`);
    return { customerId: customer.id, workspaceId };
  }

  async createCheckoutSession(workspaceId: string, plan: PaidPlan, options: CheckoutOptions = {}): Promise<CheckoutSession> {
    const interval = options.interval ?? DEFAULT_BILLING_INTERVAL;
    const seats = Math.max(1, options.seats ?? 1);
    const session = await this.request<{ url: string | null }>("POST", "/v1/checkout/sessions", {
      mode: "subscription",
      // client_reference_id is what links the completed session back to a workspace, and
      // it is echoed to the webhook. Stripe treats it as opaque; it is not trusted on its
      // own -- the handler only uses it to find a workspace whose row it then reconciles
      // against the subscription Stripe reports.
      client_reference_id: workspaceId,
      success_url: this.options.successUrl,
      cancel_url: this.options.cancelUrl,
      allow_promotion_codes: true,
      ...(options.customerId ? { customer: options.customerId } : options.email ? { customer_email: options.email } : {}),
      line_items: [{ price: this.priceFor(plan, interval), quantity: seats }],
      metadata: { workspaceId, plan, interval },
      subscription_data: { metadata: { workspaceId, plan, interval } }
    });
    if (!session.url) throw new StripeApiError(502, "Stripe returned a checkout session with no URL");
    return { url: session.url };
  }

  async changeSubscription(input: ChangeSubscriptionInput): Promise<void> {
    const subscription = await this.fetchSubscription(input.subscriptionId);
    const item = subscription.items.data[0];
    if (!item) throw new StripeApiError(502, "Stripe subscription has no line items to change");
    await this.request("POST", `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, {
      items: [{ id: item.id, price: this.priceFor(input.plan, input.interval), quantity: Math.max(1, input.seats) }],
      // Stripe works out the mid-cycle credit and charge; there is no arithmetic on this
      // side, which is the point -- proration is exactly the thing not to reimplement.
      proration_behavior: "create_prorations",
      // A plan change is also an un-cancellation: someone moving to another tier is not
      // still on their way out.
      cancel_at_period_end: false,
      metadata: { plan: input.plan, interval: input.interval }
    });
  }

  async setSeatQuantity(subscriptionId: string, seats: number): Promise<void> {
    const subscription = await this.fetchSubscription(subscriptionId);
    const item = subscription.items.data[0];
    if (!item) throw new StripeApiError(502, "Stripe subscription has no line items to resize");
    if (item.quantity === seats) return;
    await this.request("POST", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      items: [{ id: item.id, quantity: Math.max(1, seats) }],
      proration_behavior: "create_prorations"
    });
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    // Not DELETE /v1/subscriptions/:id, which ends it on the spot. The workspace paid
    // through the end of the period and keeps its limits until then.
    await this.request("POST", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      cancel_at_period_end: true
    });
  }

  async getSubscriptionState(subscriptionId: string): Promise<SubscriptionState> {
    return this.toState(await this.fetchSubscription(subscriptionId));
  }

  async createPortalSession(customerId: string, returnUrl?: string): Promise<CheckoutSession> {
    const session = await this.request<{ url: string }>("POST", "/v1/billing_portal/sessions", {
      customer: customerId,
      return_url: returnUrl ?? this.options.portalReturnUrl ?? this.options.successUrl
    });
    return { url: session.url };
  }

  private async fetchSubscription(subscriptionId: string): Promise<StripeSubscription> {
    return stripeSubscriptionSchema.parse(
      await this.request<unknown>("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`)
    );
  }

  private toState(subscription: StripeSubscription): SubscriptionState {
    const item = subscription.items.data[0];
    const price = item?.price.id;
    const known = price ? this.priceToPlan.get(price) : undefined;
    // Stripe moved current_period_end from the subscription onto its items in a recent API
    // version. Reading both means this works whichever version the account is pinned to.
    const periodEnd = subscription.current_period_end ?? item?.current_period_end ?? null;
    return {
      subscriptionId: subscription.id,
      customerId: subscription.customer,
      status: subscription.status,
      // The price catalog is authoritative, not the metadata a checkout wrote: metadata is
      // editable in the Stripe dashboard, and the price is what is actually being charged.
      plan: known?.plan ?? null,
      interval: known?.interval ?? intervalFrom(item?.price.recurring?.interval),
      seats: item?.quantity ?? 1,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: periodEnd === null ? null : new Date(periodEnd * 1_000).toISOString()
    };
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const encoded = body ? encodeStripeForm(body) : undefined;
    const url = new URL(path, this.options.apiBaseUrl ?? STRIPE_API_BASE);
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.options.secretKey}`,
        ...(encoded === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        ...(this.options.apiVersion ? { "stripe-version": this.options.apiVersion } : {})
      },
      body: encoded,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000)
    });
    const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    if (!response.ok) {
      throw new StripeApiError(response.status, payload?.error?.message ?? `Stripe request failed with status ${response.status}`);
    }
    return payload as T;
  }
}

/**
 * Stripe's `a[b][0][c]=v` form encoding. Arrays index positionally, nested objects nest by
 * key, and booleans/numbers stringify -- there is nothing else to it.
 */
export function encodeStripeForm(body: Record<string, unknown>): string {
  const parameters: string[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(`${prefix}[${index}]`, entry));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) walk(`${prefix}[${key}]`, nested);
      return;
    }
    parameters.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(body)) walk(key, value);
  return parameters.join("&");
}

/**
 * Verifies a `Stripe-Signature` header against the raw request body, per Stripe's scheme:
 * the signed payload is `<timestamp>.<body>`, HMAC-SHA256 under the endpoint's signing
 * secret, hex-encoded, and presented as one or more `v1=` entries (more than one during a
 * secret rotation).
 *
 * Three refusals, each of which matters on an unauthenticated route:
 * - a body that does not match its signature (forged or tampered with in transit),
 * - a timestamp outside the tolerance, which bounds how long a *validly signed* capture
 *   stays replayable to five minutes,
 * - a header that does not parse, rather than falling through to "no v1 entries, so
 *   nothing to compare, so pass".
 *
 * The comparison is constant-time. The signature is attacker-supplied and the secret is
 * not, so a byte-at-a-time comparison would leak the expected digest under enough attempts.
 */
export function verifyStripeSignature(
  payload: string, header: string | undefined, secret: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {}
): void {
  if (!header) throw new StripeSignatureError("Stripe-Signature header is missing");
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1") signatures.push(value);
  }
  if (timestamp === undefined) throw new StripeSignatureError("Stripe-Signature header has no timestamp");
  if (signatures.length === 0) throw new StripeSignatureError("Stripe-Signature header has no v1 signature");

  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  // Both directions: a future timestamp is as much a sign of a forged header as a stale one.
  if (Math.abs(now - timestamp) > tolerance) throw new StripeSignatureError("Stripe-Signature timestamp is outside the tolerance window");

  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex"), "utf8");
  const matched = signatures.some((signature) => {
    const candidate = Buffer.from(signature, "utf8");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!matched) throw new StripeSignatureError("Stripe-Signature does not match the request body");
}

function intervalFrom(value: string | undefined): BillingInterval | null {
  return value === "month" || value === "year" ? value : null;
}

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] =
  ["active", "trialing", "past_due", "incomplete", "incomplete_expired", "unpaid", "canceled", "paused"];

// Only the fields this service reads. Everything else Stripe sends is ignored rather than
// rejected, so a Stripe API version that adds fields does not break the webhook.
const stripeSubscriptionSchema = z.object({
  id: z.string().min(1),
  customer: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES as [SubscriptionStatus, ...SubscriptionStatus[]]),
  cancel_at_period_end: z.boolean().default(false),
  current_period_end: z.number().int().nullish(),
  items: z.object({
    data: z.array(z.object({
      id: z.string().min(1),
      quantity: z.number().int().positive().default(1),
      current_period_end: z.number().int().nullish(),
      price: z.object({
        id: z.string().min(1),
        recurring: z.object({ interval: z.string() }).nullish()
      })
    }))
  })
});
type StripeSubscription = z.infer<typeof stripeSubscriptionSchema>;

/**
 * The webhook envelope, kept as loose as it can be: the handler treats an event as a
 * *signal to re-read authoritative state from Stripe*, so the only fields it needs from the
 * body are the event id (for the replay ledger), the type, and enough of the object to say
 * which subscription or workspace to reconcile.
 */
export const stripeWebhookEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({
    object: z.object({
      id: z.string().optional(),
      object: z.string().optional(),
      customer: z.string().nullish(),
      subscription: z.string().nullish(),
      client_reference_id: z.string().nullish(),
      metadata: z.record(z.string()).nullish()
    }).passthrough()
  })
}).passthrough();
export type StripeWebhookEvent = z.infer<typeof stripeWebhookEventSchema>;
