# Stripe pre-launch checklist (2026-08-04)

Everything that has to exist in the Stripe dashboard and in this repo before a real card can
move a workspace between plans. Derived from the code that is actually deployed:
`apps/service/src/stripe.ts`, `apps/service/src/billing.ts`, `apps/service/src/main.ts`,
`apps/service/src/http.ts`, `apps/service/src/billing-webhook.ts`, `apps/cli/src/index.ts`,
and `apps/docs-site/vercel.json`.

Two blockers sit outside this list and are tracked elsewhere: `crosscode-cli` is not
published to npm, and `https://www.getcrosscode.dev/api/v1/*` currently answers 500
(`ERR_MODULE_NOT_FOUND` for `@crosscode/service/src/serverless.ts`, being fixed by workstream
A). Step 8 below cannot pass until the second one is fixed.

## 1. Create the products and prices

Ten prices, one per (plan, interval). Currency USD, recurring. The numbers come from
`PLAN_PRICING` in `apps/service/src/billing.ts:108-114`; annual is twelve months for the
price of ten on every row.

| Product | Interval | Amount | Billing model |
| --- | --- | --- | --- |
| Crosscode Essential | month | $2.50 | flat, quantity always 1 |
| Crosscode Essential | year | $25.00 | flat, quantity always 1 |
| Crosscode Pro | month | $5.00 | flat, quantity always 1 |
| Crosscode Pro | year | $50.00 | flat, quantity always 1 |
| Crosscode Unlimited | month | $7.50 | flat, quantity always 1 |
| Crosscode Unlimited | year | $75.00 | flat, quantity always 1 |
| Crosscode Team | month | $5.00 per seat | **per unit**, quantity = active members |
| Crosscode Team | year | $50.00 per seat | **per unit**, quantity = active members |
| Crosscode Student | month | $2.50 | flat, not self-serve |
| Crosscode Student | year | $25.00 | flat, not self-serve |

Notes that come from the code rather than from Stripe's defaults:

- **Team must be a per-unit price, not a flat one.** `seatQuantityFor()`
  (`billing.ts:133-135`) returns the active member count for `team` and `1` for everything
  else, and that number is sent as the Stripe line-item quantity. A flat Team price would
  bill $5 for a 20-person workspace.
- **Every other plan collapses to quantity 1** inside the checkout route
  (`http.ts:793-794`), so a client passing `--seats 10` on Pro cannot turn a $5 subscription
  into a $50 one. Do not model those as per-unit prices.
- **Student prices can be created but will never be bought self-serve.** The checkout route
  refuses `plan: "student"` with 403 (`http.ts:786-788`) and the CLI does not list it in
  `PURCHASABLE_PLANS` (`apps/cli/src/index.ts:27`). Create them only if you intend to grant
  the tier out of band from the dashboard.
- **Promotion codes are enabled** on every checkout session
  (`allow_promotion_codes: true`, `stripe.ts:128`), so any coupon you create in the
  dashboard is redeemable at checkout. Create none if you do not want that.

Collect the ten `price_...` ids. They go into one environment variable in step 3.

## 2. Create the webhook endpoint

- **URL:** `https://www.getcrosscode.dev/v1/webhooks/stripe`
  (`/api/v1/webhooks/stripe` reaches the same function; `vercel.json` rewrites both `/v1/*`
  and `/api/*` to `api/[...path].ts`, which strips the `/api` prefix before routing).
- **Events to subscribe.** `applyStripeWebhookEvent` (`billing-webhook.ts:34-49`) acts on
  exactly these shapes and acknowledges everything else without doing anything:

  | Event | Why it is needed |
  | --- | --- |
  | `checkout.session.completed` | First purchase; carries `client_reference_id` = workspace id |
  | `checkout.session.async_payment_succeeded` | Delayed payment methods completing |
  | `customer.subscription.created` | Subscription state after checkout |
  | `customer.subscription.updated` | Plan change, seat change, cancel-at-period-end |
  | `customer.subscription.deleted` | Period ended after a cancellation |
  | `invoice.paid` | Clears a dunning grace period |
  | `invoice.payment_failed` | Opens the 14-day grace period |

  `invoice.payment_succeeded` may be subscribed instead of or alongside `invoice.paid`: the
  handler branches on the `invoice.` prefix, not on the exact type.
- **Copy the signing secret** (`whsec_...`). It is required, not optional:
  `loadBilling()` (`main.ts:115-119`) throws at startup if `CROSSCODE_STRIPE_SECRET_KEY` is
  set without `CROSSCODE_STRIPE_WEBHOOK_SECRET`, and without the secret the route answers 404
  rather than running a weakened check (`http.ts:335-337`).

## 3. Set the environment variables

All of these go on the **Vercel project** for `apps/docs-site` (the service runs as the
`api/[...path].ts` function there), and on any self-hosted container that is meant to sell
anything. They are read in `apps/service/src/main.ts:115-131` and, for the serverless path,
by `createServerlessHandler` from the same `process.env`.

| Variable | Required | Value |
| --- | --- | --- |
| `CROSSCODE_STRIPE_SECRET_KEY` | to sell anything | `sk_test_...` first, `sk_live_...` at launch |
| `CROSSCODE_STRIPE_WEBHOOK_SECRET` | yes, whenever the key is set | `whsec_...` from step 2 |
| `CROSSCODE_STRIPE_PRICES` | yes | one JSON object, see below |
| `CROSSCODE_STRIPE_SUCCESS_URL` | yes | where Stripe returns the browser after checkout |
| `CROSSCODE_STRIPE_CANCEL_URL` | no | defaults to the success URL |
| `CROSSCODE_STRIPE_PORTAL_RETURN_URL` | no | defaults to the success URL |
| `CROSSCODE_STRIPE_API_VERSION` | no | pins `Stripe-Version`; unset uses the account default |

`CROSSCODE_STRIPE_PRICES` is one secret rather than ten variables, parsed and validated by
`parseStripePriceCatalog` (`stripe.ts:55-70`). A plan may omit an interval, and asking to
check out for a missing one is a clear 400 rather than a silent wrong charge.

```json
{
  "essential": { "month": "price_...", "year": "price_..." },
  "pro":       { "month": "price_...", "year": "price_..." },
  "unlimited": { "month": "price_...", "year": "price_..." },
  "team":      { "month": "price_...", "year": "price_..." },
  "student":   { "month": "price_...", "year": "price_..." }
}
```

Set it as one line of JSON. The parser rejects unknown plan keys, unknown interval keys
(`.strict()`), and a catalog naming no prices at all.

**Open question for `CROSSCODE_STRIPE_SUCCESS_URL`.** The code requires it and the comment
in `main.ts:119-122` says it is a page on the marketing site, but no such page exists today:
`apps/docs-site` has the landing page, four auth pages, and the docs. Until one exists,
`https://www.getcrosscode.dev/docs/index.html` works and is not a dead link. A short
"payment received, back to your terminal" page belongs to the landing-page workstream (E),
which owns `index.html` and `src/**`.

## 4. Set the price ids where nothing else needs them

Nothing else. There is no price id, product id, or publishable key anywhere in the client:
`crosscode billing upgrade` posts a plan name to the service and follows the URL it gets
back. The CLI never talks to Stripe.

## 5. Run the migration

`014_billing_lifecycle.sql` carries the grace-period and subscription-state columns on
`workspaces`, the `billing_events` replay ledger, and `operations.retention_days`. Confirm it
is applied against the production database before enabling the key:

```bash
MIGRATION_DATABASE_URL="<supabase pooled connection string>" pnpm service:migrate
```

## 6. Schedule the sweeps

Neither is load-bearing for enforcement (a lapsed grace period is applied at read time by
`EFFECTIVE_PLAN_SQL`), but both keep stored state honest:

- `pnpm service:billing-sweep` daily, writing lapsed grace periods down durably and auditing
  them (`apps/service/src/billing-sweep.ts`).
- `pnpm service:prune` for history retention. The interval sweep in `main.ts` needs a
  persistent process, so on the Vercel function deployment this has to be driven externally.

## 7. Test-mode end-to-end run

Do the whole thing in test mode before switching to live keys. Test cards:
`4242 4242 4242 4242` succeeds, `4000 0000 0000 9995` fails with `insufficient_funds`, any
future expiry and any CVC.

```bash
# 1. A logged-in checkout with an owner role. Confirm the starting state.
crosscode billing status --json
# expect: {"value":{"plan":"free","billingPlan":null,"seatCap":5,"historyRetentionDays":7,...}}

# 2. Start a checkout. Annual is the default; --monthly is the opt-out.
crosscode billing upgrade --plan pro --no-browser --json
# expect: {"value":{"mode":"checkout","plan":"pro","interval":"year","seats":1,
#          "url":"https://checkout.stripe.com/...","priceCents":5000,"monthlyEquivalentCents":500}}

# 3. Open that URL, pay with 4242 4242 4242 4242.

# 4. The webhook should have landed before you finish typing this.
crosscode billing status --json
# expect: plan "pro", billingPlan "pro", billingInterval "year", billingStatus "active",
#         historyRetentionDays 90, seatCap 25, currentPeriodEnd set, priceCents 5000.

# 5. Move in place, in both directions. mode must be "updated", never "checkout":
#    a second checkout session would leave the workspace paying twice.
crosscode billing upgrade --plan unlimited --json      # expect mode "updated", priceCents 7500
crosscode billing upgrade --plan essential --json      # expect mode "updated", priceCents 2500

# 6. The portal, which is Stripe's own page and the only place a card is edited.
crosscode billing portal --no-browser --json

# 7. Cancel. It must not take effect immediately.
crosscode billing cancel --yes --json
crosscode billing status --json
# expect: cancelAtPeriodEnd true, plan still "essential", currentPeriodEnd unchanged.
```

Then check in the Stripe dashboard that the subscription shows "cancels on <date>" rather
than "canceled", and that the invoice for step 5 carries proration line items in both
directions.

Two things worth testing on a Team workspace specifically, since they are the only per-seat
paths: redeem an invite and confirm the subscription quantity goes up, then remove a member
and confirm it goes down. `reconcileSeatQuantity` (`billing.ts:346-361`) never throws, so a
failure here shows up as a wrong quantity in Stripe and a logged error, not as a failed CLI
command.

## 8. Verify the webhook signature path

This is the one unauthenticated write route in the service, so verify it against the real
deployment rather than trusting the unit tests.

```bash
# In the Stripe dashboard, on the endpoint from step 2: "Send test webhook" ->
# customer.subscription.updated. Expect 200 {"received":true,"duplicate":false,...}.

# A body Stripe did not sign must be refused with 400, not accepted:
curl -i -X POST https://www.getcrosscode.dev/v1/webhooks/stripe \
  -H 'content-type: application/json' \
  -H 'stripe-signature: t=1,v1=deadbeef' \
  -d '{"id":"evt_forged","type":"customer.subscription.updated","data":{"object":{"id":"sub_x"}}}'
# expect: HTTP/1.1 400, "Stripe-Signature timestamp is outside the tolerance window"

# With no signature header at all:
curl -i -X POST https://www.getcrosscode.dev/v1/webhooks/stripe \
  -H 'content-type: application/json' -d '{}'
# expect: HTTP/1.1 400, "Stripe-Signature header is missing"
# A 404 here means CROSSCODE_STRIPE_WEBHOOK_SECRET is not set on the deployment.

# Redelivery is a no-op. Use "Resend" on a delivered event in the dashboard:
# expect: 200 {"received":true,"duplicate":true} on the second delivery.
```

**The one platform-specific risk.** `verifyStripeSignature` HMACs the *raw request bytes*
(`http.ts:338-344` reads the stream itself with `readRawBody`). A serverless platform that
buffers and re-serializes the body would change those bytes and every signature would fail.
The dashboard "Send test webhook" above is the check for this, and it is worth doing before
the first live payment rather than after.

## 9. Switch to live

1. Recreate the ten prices in live mode. Test-mode price ids do not work with a live key.
2. Recreate the webhook endpoint in live mode; the signing secret is different.
3. Replace `CROSSCODE_STRIPE_SECRET_KEY`, `CROSSCODE_STRIPE_WEBHOOK_SECRET`, and
   `CROSSCODE_STRIPE_PRICES` on the deployment, then redeploy so the function picks them up.
4. Confirm the business settings Stripe requires for a live account: statement descriptor,
   support email and phone, business address, and tax settings if you are collecting tax.
5. Publish the legal pages this workstream drafted, with the placeholders filled in:
   `/docs/terms.html`, `/docs/refund-policy.html`, `/docs/support.html`. Stripe expects a live
   account to have reachable terms, a refund policy, and a contact route.
6. Buy one real subscription on the cheapest plan with your own card, confirm it, then refund
   it from the dashboard. That is the only way to learn that the live path works.

## What this checklist deliberately does not cover

- **Tax.** Stripe Tax is not wired into the checkout session
  (`createCheckoutSession`, `stripe.ts:116-136`, sets no `automatic_tax`). Turning it on is a
  code change, not configuration.
- **Trials.** No `trial_period_days` anywhere. The free plan is the trial.
- **Dunning email content**, which is entirely Stripe's, and whose retry schedule should stay
  inside the 14-day `PAYMENT_GRACE_PERIOD_DAYS` window (`billing.ts:124`).
- **Student verification**, which does not exist. Until it does, grant the tier by hand and
  leave self-serve checkout refusing it.
