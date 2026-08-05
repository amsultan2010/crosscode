# Workstream C: legal and support surface (2026-08-04)

Three new docs pages (Terms of Service, refund policy, support) plus a Stripe pre-launch
checklist. Branch `amsultan2010/cc-c-legal-support`.

## Placeholders to fill, in one pass

Four strings, used verbatim. Fill them everywhere before publishing.

| Placeholder | Where it appears | What it needs |
| --- | --- | --- |
| `[LEGAL ENTITY NAME]` | `docs/terms.md` (2), `docs/refund-policy.md` (1) | The company or sole-trader name that operates the hosted service |
| `[JURISDICTION]` | `docs/terms.md` (2) | Governing law and venue, e.g. "England and Wales" |
| `[SUPPORT EMAIL]` | `docs/terms.md` (2), `docs/refund-policy.md` (5), `docs/support.md` (4) | The billing and account address, also the one Stripe requires on a live account |
| `[EFFECTIVE DATE]` | `docs/terms.md` (1), `docs/refund-policy.md` (1) | Set on the day the terms go into force |

```bash
grep -rn "\[LEGAL ENTITY NAME\]\|\[JURISDICTION\]\|\[SUPPORT EMAIL\]\|\[EFFECTIVE DATE\]" docs/terms.md docs/refund-policy.md docs/support.md
```

Both legal pages open with a blockquote banner reading **"Draft, not in force."** Delete it
only when a lawyer has reviewed the text and the effective date is set. The support page has
no banner, because nothing on it is a legal claim.

## URLs produced, for workstream E to link

| Page | URL | Source |
| --- | --- | --- |
| Terms of Service | `/docs/terms.html` | `docs/terms.md` |
| Refund policy | `/docs/refund-policy.html` | `docs/refund-policy.md` |
| Support | `/docs/support.html` | `docs/support.md` |

Raw markdown is served alongside each, at `/docs/terms.md`, `/docs/refund-policy.md`, and
`/docs/support.md`, which is what the "View raw markdown" footer link on each page points at.

**Request for E, since I do not own `index.html`:** the landing page footer should link at
least `/docs/terms.html` and `/docs/support.html`. Stripe will look for reachable terms and a
contact route on a live account, and a footer is where a reviewer looks first.

## What changed

**New files**

- `docs/terms.md`. Twelve sections written against what the product does: MIT-licensed
  client software excluded from the terms outright, the hosted service described as a relay,
  no licence taken in customer code, the encryption position with its three stated limits
  (lost key, visible metadata, task titles not yet encrypted), subscription renewal and
  per-seat Team proration, the never-destroy termination rule, warranty disclaimer, and a
  liability cap at the greater of 12 months of fees or $50.
- `docs/refund-policy.md`. Prices, a 14-day first-purchase refund window, what cancelling
  does and does not do, the 14-day payment-failure grace period, and the exact four things
  to send when asking for a refund.
- `docs/support.md`. GitHub issues for bugs, `[SUPPORT EMAIL]` for billing and account
  problems, response-time targets stated as targets rather than an SLA, what to put in a bug
  report, what to put in a billing message, and a short list of behaviours that look like
  bugs but are the product working.
- `docs/status/2026-08-04-stripe-launch-checklist.md`. Nine steps, derived from the code with
  file and line citations.
- `docs/status/assets/2026-08-04-{terms,refund-policy,support}.png`. Screenshots of the built
  pages served locally.

**Modified**

- `apps/docs-site/scripts/generate-docs.mjs`. Three entries in `GENERATED_PAGES` and one new
  `NAV_GROUPS` group, "Support & legal". No new rendering code: the pages use the same
  `renderPage()` output as every other generated doc, so they inherit whatever E does to the
  stylesheet.
- `apps/docs-site/vite.config.js`. Three new rollup inputs, which is what puts the pages in
  `dist/`.
- `apps/docs-site/.gitignore`. Three lines, so the newly generated
  `docs/{support,terms,refund-policy}.html` stay out of git like every other generated page.
  Without it the build's own output shows up as an untracked change on every run.
- `apps/docs-site/docs/{index,install,cli,limitations}.html`. These four are hand-written
  rather than generated, and each carries its own copy of the sidebar. Added the same
  "Support & legal" block to each so the sidebar is identical on every docs page. Nothing
  else in them was touched.

I wrote no CSS and no hand-written HTML page. The `<nav>` block added to the four
hand-written pages is a copy of what the generator emits, class names included.

## Verification

### 1. `pnpm docs:build` passes and emits the three pages

```
$ pnpm docs:build
[generate-docs] wrote generated doc pages, public/docs/*.md, llms.txt, llms-full.txt
vite v5.4.20 building for production...
✓ 26 modules transformed.
dist/docs/support.html                           9.30 kB │ gzip:  3.56 kB
dist/docs/refund-policy.html                    11.79 kB │ gzip:  4.45 kB
dist/docs/terms.html                            18.25 kB │ gzip:  7.02 kB
...
✓ built in 402ms
```

Seventeen HTML pages in `dist/` (landing, four auth, twelve docs), up from fourteen.

### 2. Served locally, each URL returns a styled page with working navigation

```
$ cd apps/docs-site/dist && python3 -m http.server 8931
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8931/docs/terms.html
200
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8931/docs/refund-policy.html
200
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8931/docs/support.html
200
```

Checked in Orca's browser. Screenshots: [terms](assets/2026-08-04-terms.png),
[refund policy](assets/2026-08-04-refund-policy.png), [support](assets/2026-08-04-support.png).
All three render with the site header, the docs sidebar, and the site stylesheet.

The sidebar on a page I did not generate carries the new group, and clicking through it
navigates:

```
$ orca eval --expression "JSON.stringify(Array.from(document.querySelectorAll('.docs-sidebar a')).map(a=>a.getAttribute('href')))"
["/docs/index.html","/docs/architecture.html","/docs/safety.html","/docs/privacy.html",
 "/docs/protocol.html","/docs/install.html","/docs/mcp-clients.html","/docs/cli.html",
 "/docs/limitations.html","/docs/support.html","/docs/terms.html","/docs/refund-policy.html"]
  (read on /docs/limitations.html, a hand-written page)

$ orca click --element <ref for "Refund policy">   # from /docs/architecture.html
$ orca eval --expression "location.href"
http://127.0.0.1:8931/docs/refund-policy.html
```

### 3. No em dash anywhere in the new pages

Counting U+2014 and its two HTML entities across the source markdown, the generated HTML, and
the built output, with a script rather than a grep pattern, so this file does not have to
contain the character it is checking for:

```
$ python3 - <<'PY'
import glob
files = ["docs/terms.md","docs/refund-policy.md","docs/support.md",
         "apps/docs-site/docs/terms.html","apps/docs-site/docs/refund-policy.html",
         "apps/docs-site/docs/support.html",
         "docs/status/2026-08-04-stripe-launch-checklist.md"]
for pattern in ("terms","refund-policy","support"):
    files += glob.glob(f"apps/docs-site/dist/docs/{pattern}.*")
total = 0
for f in sorted(files):
    s = open(f, encoding="utf8").read()
    n = sum(s.count(t) for t in ("\u2014", "\x26mdash;", "\x26#8212;"))
    total += n
    print(f"{n}  {f}")
print("total em dashes:", total)
PY
0  apps/docs-site/dist/docs/refund-policy.html
0  apps/docs-site/dist/docs/refund-policy.md
0  apps/docs-site/dist/docs/support.html
0  apps/docs-site/dist/docs/support.md
0  apps/docs-site/dist/docs/terms.html
0  apps/docs-site/dist/docs/terms.md
0  apps/docs-site/docs/refund-policy.html
0  apps/docs-site/docs/support.html
0  apps/docs-site/docs/terms.html
0  docs/refund-policy.md
0  docs/status/2026-08-04-stripe-launch-checklist.md
0  docs/support.md
0  docs/terms.md
total em dashes: 0
```

This status file passes the same count.

**Pre-existing em dashes I did not touch.** `apps/docs-site/scripts/generate-docs.mjs` has
three in its own comments and one in the title line of the `llms-full.txt` it emits, all
predating this work. `docs/privacy.md`,
`docs/security.md`, `README.md`, and the four hand-written docs pages have many. Under the
surgical-changes rule I left them alone rather than rewriting text no part of this workstream
needed. They are a cheap follow-up if the user wants the whole repo clean.

### 4. Placeholders

Listed in the table at the top of this file, with counts per file. No invented entity name,
jurisdiction, email, or date appears anywhere in the four documents.

### 5. Consistency with the implemented billing behaviour

Every claim in the refund policy and the checklist traces to a line I read:

| Claim | Code |
| --- | --- |
| Monthly and annual prices ($2.50/$25, $5/$50, $7.50/$75, $5/$50 per seat) | `apps/service/src/billing.ts:108-114` (`PLAN_PRICING`) |
| Annual is the default, `--monthly` is the opt-out | `billing.ts:116` (`DEFAULT_BILLING_INTERVAL = "year"`), `apps/cli/src/index.ts:485-487` |
| Seat caps 5/10/25/unlimited and retention 7/30/90/365 days | `billing.ts:33-45` (`PLAN_LIMITS`) |
| Team bills per active member; every other plan is quantity 1 | `billing.ts:133-135` (`seatQuantityFor`), `apps/service/src/http.ts:793-794` |
| Cancellation is `cancel_at_period_end`, never immediate | `apps/service/src/stripe.ts:165-171`, `http.ts:832-845` |
| Cancellation and downgrade destroy nothing | `billing.ts:319-336` (`entitlementForSubscription`), BUILD_INSTRUCTIONS.md Phase 10 lifecycle section |
| Over-cap workspaces keep every member; the next seat gets 402 | `billing.ts:137-142` (`assertSeatCapAvailable`, checked only when adding a member) |
| Auto-always clamps to auto-if-clean rather than erroring | `billing.ts:82-96` (`maxAutonomyTierFor`, `clampAutonomyTierToPlan`) |
| History keeps the window it was written under | `operations.retention_days` in `apps/service/migrations/014_billing_lifecycle.sql:72-87` |
| 14-day grace period on payment failure, set once | `billing.ts:118-124` (`PAYMENT_GRACE_PERIOD_DAYS = 14`) |
| A plan change moves the subscription in place, prorated, either direction | `stripe.ts:138-152` (`proration_behavior: "create_prorations"`), `http.ts:801-816` |
| `crosscode billing portal` is where invoices live | `stripe.ts:177-183`, `http.ts:854-860` |
| Student cannot be bought self-serve | `http.ts:786-788` (403), `apps/cli/src/index.ts:27` (`PURCHASABLE_PLANS` omits it) |
| `workspaceId` is in `crosscode billing status --json` | `billing.ts:184-206` (`WorkspaceBillingStatus`) |
| Webhook events acted on | `apps/service/src/billing-webhook.ts:34-49` |
| Webhook route 404s without a signing secret | `http.ts:334-337`; `apps/service/src/main.ts:115-119` requires the secret alongside the key |
| Five-minute signature tolerance, constant-time compare | `stripe.ts:273-302` (`verifyStripeSignature`), `stripe.ts:32` |
| Environment variables and their defaults | `main.ts:115-131` |
| Webhook URL routing | `apps/docs-site/vercel.json` rewrites, `apps/docs-site/api/[...path].ts:27` strips `/api` |

The one number the policy states that the code does not: **the 14-day first-purchase refund
window**. There is no refund code path at all, self-serve or otherwise. Refunds are issued by
hand from the Stripe dashboard, which is what the policy says. It is a commitment the user is
choosing to make, not a description of behaviour, and it is the one line in the refund policy
that a lawyer should look at hardest.

### 6. No dead links in the built output

Extracted every `href` from the three built pages and resolved it against `dist/`:

```
docs/terms.html          19 links
docs/refund-policy.html  19 links
docs/support.html        20 links
BROKEN: none
```

Internal targets checked: `/`, the twelve `/docs/*.html` pages, the three `/docs/*.md` raw
sources, and the stylesheet and favicon assets. Off-site links are
`https://github.com/amsultan2010/crosscode`, `.../issues`, and `.../blob/main/SECURITY.md`;
they are well formed but not fetched, because the repository may not be public yet.

## Things I could not do, and things for the user

1. **A lawyer has not seen any of this.** It is a draft written to match the product, not
   reviewed advice. Both legal pages say so at the top.
2. **`CROSSCODE_STRIPE_SUCCESS_URL` has no page to point at.** The service requires the
   variable, and `apps/docs-site` has no "payment received" page. `/docs/index.html` works as
   a stopgap. A real one belongs to workstream E, which owns `index.html` and `src/**`.
3. **The landing page footer needs the legal links.** I did not add them, because
   `index.html` is E's file. The URLs are in the table above.
4. **Nothing in the checklist was executed.** There is no Stripe account, no test-mode key,
   and no working hosted API (`https://www.getcrosscode.dev/api/v1/*` still answers 500, which
   workstream A is fixing), so steps 7 and 8 of the checklist are written to be run by the
   user once those exist and are marked as unverified there.
5. **`llms.txt` does not list the new pages.** Its entry list is a curated index of reference
   docs for agents, and terms and refund policy are not that. Say the word and it is a
   four-line change to `generateLlmsTxt()`.
6. **BUILD_INSTRUCTIONS.md is untouched**, per the rules of engagement. The coordinator folds
   this file in at merge time. The one stale fact worth carrying over: Phase 10 names the
   billing migration `012_billing_lifecycle.sql`, but the file on disk is
   `014_billing_lifecycle.sql`.
