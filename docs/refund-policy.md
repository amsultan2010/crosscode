# Refund policy

> **Draft, not in force.** This document is a working draft awaiting review by a qualified
> lawyer. It describes the policy Crosscode intends to operate under, and it does not bind
> anyone yet. Placeholders in square brackets are unfilled. Do not rely on this page until
> this banner is gone and an effective date is set.

- **Effective date:** [EFFECTIVE DATE]
- **Provider:** [LEGAL ENTITY NAME]
- **Requests:** [SUPPORT EMAIL]

This policy is part of the [Terms of Service](/docs/terms.html). It describes what you pay,
what happens when you stop paying, and how to get money back.

## What a subscription costs

Every plan can be billed monthly or annually. Annual is twelve months for the price of ten,
and it is the default: `crosscode billing upgrade --plan pro` buys the annual price unless
you pass `--monthly`.

| Plan | Monthly | Annual | Seat cap | History retention |
| --- | --- | --- | --- | --- |
| Free | $0 | $0 | 5 | 7 days |
| Essential | $2.50 | $25.00 | 10 | 30 days |
| Pro | $5.00 | $50.00 | 25 | 90 days |
| Unlimited | $7.50 | $75.00 | unlimited | 365 days |
| Team | $5.00 per seat | $50.00 per seat | unlimited | 365 days |

Prices are in US dollars and exclude any tax collected at checkout. Team is the one plan
billed per head: its Stripe quantity tracks the active member count, and adding or removing
a member is prorated by Stripe for the rest of the period.

Student pricing exists (Pro's limits at Essential's price) but cannot be bought self-serve.
`crosscode billing upgrade --plan student` is refused, because the verification flow that
would stop it being a discount for anyone who asks does not exist yet. It is granted out of
band.

## The 14-day refund window

**A workspace's first paid subscription can be refunded in full within 14 days of the first
charge.** Email [SUPPORT EMAIL] with the workspace id and we will refund it and drop the
workspace back to Free. You do not have to give a reason.

The window applies once per workspace, to its first purchase. It is not available again on
a later upgrade, a renewal, or a repurchase after a cancellation.

Outside that window:

- **Renewals are not automatically refundable.** If a renewal took you by surprise, write to
  [SUPPORT EMAIL] within 14 days of the charge and we will look at it. An annual renewal on
  a workspace with no recorded activity since the charge is refunded in full.
- **Duplicate or clearly mistaken charges are refunded in full**, whenever we find them.
- **We refund the unused portion of an annual subscription** if we discontinue the hosted
  service, as stated in the Terms of Service.

Where consumer law in your country gives you a stronger right to a refund, that law wins
over this section.

## Cancelling

```bash
crosscode billing cancel
```

Cancellation sets Stripe's `cancel_at_period_end`. It is never an immediate termination,
and it deletes nothing:

- **You keep your plan's limits until the end of the period you already paid for.** The
  subscription then stops renewing.
- **The workspace falls to Free's limits after that**, not to nothing. Members, operation
  history, replicas, device tokens, and settings all survive.
- **Auto-always autonomy falls back to auto-if-clean**, because Free does not unlock it.
  This is a clamp rather than an error, so proposals keep flowing.
- **A workspace over Free's 5-seat cap keeps every existing member.** The cap is checked
  only when a new member is added, so the *next* seat is refused with a 402. Nobody is
  counted out, disabled, or evicted.
- **History already written keeps the retention window it was written under.** Each
  operation carries the retention days of the plan in effect when it was recorded, so
  dropping to a shorter window stops history being extended and never retroactively deletes
  what was already promised.

**There is no partial refund for the unused remainder of a period on cancellation.** You
paid for the period, and you keep the plan for the whole of it. Cancel before renewal if
you do not want the next one.

Downgrading instead of cancelling works the same way, except that it happens immediately
and Stripe prorates the difference as a credit against your next invoice.
`crosscode billing upgrade --plan essential` from Pro is a downgrade; the command moves the
existing subscription in place rather than starting a second one.

## When a payment fails

A failed payment does not cut anyone off:

- **A 14-day grace period opens** on the first failure, and every paid limit is retained
  throughout it. The deadline is set once and is never pushed further out by repeated
  failure events.
- **Stripe retries the card** during that time. Replacing the card with
  `crosscode billing portal` and paying successfully clears the deadline and restores
  everything.
- **When the grace period lapses**, the workspace falls to Free's *limits*. Members,
  history, replicas, tokens, and settings survive, exactly as on cancellation.

`crosscode billing status` shows the grace deadline while one is set.

## How to request a refund

Email [SUPPORT EMAIL] with:

1. **The workspace id.** `crosscode billing status --json` prints it as `workspaceId`.
2. **The Stripe invoice id or receipt.** `crosscode billing portal` opens Stripe's own page,
   where every invoice for the workspace is downloadable.
3. **The email address on the account**, which must be the one writing to us, or an owner of
   the same workspace.
4. **What you want**: a refund, a cancellation, or both. A refund does not cancel the
   subscription by itself, and a cancellation does not refund by itself.

We reply within two business days. An approved refund is issued through Stripe to the
original payment method, and Stripe typically takes 5 to 10 business days to return it to
the card.

Only a workspace owner can request a refund for that workspace. We cannot refund a payment
made by someone who is no longer a member without the current owner's agreement, because
the subscription belongs to the workspace rather than to the person who paid.

## What we do not refund

- The unused remainder of a period after a cancellation, as described above.
- Charges more than 14 days old on a subscription that was in active use, other than the
  cases listed in the 14-day section.
- Anything relating to self-hosting. If you run your own coordination service you pay us
  nothing, so there is nothing to refund.

Questions go to [SUPPORT EMAIL], or see the [Support page](/docs/support.html).
