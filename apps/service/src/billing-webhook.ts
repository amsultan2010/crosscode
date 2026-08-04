// Turns a verified Stripe webhook delivery into a workspace plan change.
//
// The single design decision here is that an event is a *signal to reconcile*, never a
// source of truth: the handler takes the subscription id out of the body and then re-reads
// that subscription's current state from Stripe before writing anything. Three otherwise
// awkward properties fall out of that for free.
//
// - Ordering does not matter. Stripe does not promise events arrive in the order they
//   happened, and a "subscription updated" that lands after a "subscription deleted" would
//   otherwise resurrect a cancelled plan.
// - Replay does not matter. Re-delivering last week's event produces the write today's
//   state implies, which is a no-op.
// - Partial failure does not matter. The write is idempotent, so a delivery that failed
//   halfway is safe for Stripe to retry.
import type { BillingProvider } from "./billing.js";
import type { PgStore } from "./store.js";
import type { StripeWebhookEvent } from "./stripe.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebhookOutcome = {
  workspaceId: string | null;
  /** False when the event is not one this service acts on, or names nothing it knows. */
  applied: boolean;
};

export async function applyStripeWebhookEvent(
  store: PgStore, provider: BillingProvider, event: StripeWebhookEvent
): Promise<WebhookOutcome> {
  const object = event.data.object;
  let subscriptionId: string | null = null;
  let claimedWorkspaceId: string | null = null;

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    subscriptionId = object.subscription ?? null;
    claimedWorkspaceId = object.client_reference_id ?? object.metadata?.workspaceId ?? null;
  } else if (event.type.startsWith("customer.subscription.")) {
    subscriptionId = object.id ?? null;
    claimedWorkspaceId = object.metadata?.workspaceId ?? null;
  } else if (event.type.startsWith("invoice.")) {
    // Payment success and failure both land here; both are handled by re-reading the
    // subscription, whose status Stripe has already moved to (or out of) past_due.
    subscriptionId = object.subscription ?? null;
  } else {
    // Anything else is acknowledged rather than errored, so Stripe stops retrying an event
    // this service simply has no opinion about.
    return { workspaceId: null, applied: false };
  }

  // The database mapping wins over anything in the event body. client_reference_id and
  // metadata are only consulted when there is no mapping yet -- the first checkout for a
  // subscription created outside the normal flow -- and even then only if they look like a
  // workspace id, so a malformed or hostile value resolves to nothing rather than to a row.
  const mapped = await store.findWorkspaceForBilling({ subscriptionId, customerId: object.customer ?? null });
  const workspaceId = mapped ?? (claimedWorkspaceId && UUID_PATTERN.test(claimedWorkspaceId) ? claimedWorkspaceId : null);
  if (!workspaceId || !subscriptionId) return { workspaceId, applied: false };

  const state = await provider.getSubscriptionState(subscriptionId);
  await store.applySubscriptionState({ workspaceId, state });
  return { workspaceId, applied: true };
}
