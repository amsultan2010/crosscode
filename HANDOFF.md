# Handoff from workstream D (terms acceptance mechanism)

Changes I wanted to make in files another workstream owns. None of them are blocking; the
mechanism works without them.

## 1. `docs/terms.md` — a version line (workstream A)

`apps/service/src/legal.ts` defines `LEGAL_VERSIONS.terms = "2026-08-01"`, and that exact
string is what lands in `terms_acceptances.version` and is printed next to the link on every
consent control. It has to equal the version of the text people were shown.

Add to the header block, and keep the two in step:

```
- **Version:** 2026-08-01
```

When the effective date is chosen, change it in **both** places (the doc and `legal.ts`).
Changing `legal.ts` alone is safe by design — every account is prompted again on next
sign-in — but the document would then say one thing and the record another.

## 2. `docs/privacy-policy.md` must exist (workstream B)

Every consent control links to `/docs/privacy-policy.html`, per this brief. That page does
not exist in my worktree. Until it lands the link 404s. `LEGAL_URLS` in
`apps/service/src/legal.ts` is the one place to change if the filename ends up different.

Its version should also be `2026-08-01` (`LEGAL_VERSIONS.privacy`).

## 3. `apps/docs-site/src/style.css` — a `.consent` rule (workstream F)

The consent block renders as `<input type="checkbox"> <label>` plus an optional hint and an
error paragraph, inside `.consent`. It is legible unstyled but wants roughly:

```css
.consent { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 0.6rem; align-items: start; }
.consent label { grid-column: 2; }
.consent p { grid-column: 2; margin: 0; font-size: 0.9em; }
```

## 4. `apps/docs-site/auth/src/account.js` — OAuth returns are not recorded

`mountAuthForm` records an acceptance for the email/password paths. The OAuth buttons
redirect away, so the tick cannot be recorded before the round trip; on return `account.js`
renders "you're signed in" and records nothing. Nothing breaks — the service refuses every
route until an acceptance exists, and `/device` asks again — but a `surface: 'signup'` row
for an OAuth sign-up would need `account.js` to call `recordAcceptance` when it finds a
session and `fetchOutstanding` is non-empty.

## 5. `apps/daemon` — surface the 403 from `POST /v1/replicas`

Registering a replica now 403s with `Accept the current Crosscode terms and privacy at
https://www.getcrosscode.dev/device to continue` when the account owes an acceptance. In
practice `crosscode start` records one before the daemon ever runs, so this is the
terms-changed case. Worth passing the service's message through rather than reporting a
generic registration failure.

## 6. `docs/observability.md` — the grant note

That doc records the `device_codes` outage (table shipped without a grant to
`crosscode_runtime`, every request 500ing, `/healthz` answering `ok`). `terms_acceptances`
grants `SELECT, INSERT` in `migrations/003_terms_acceptances.sql` and in
`apps/service/src/migrate.ts`, and `/healthz` covers it because it scans every public table.
Worth one line saying the runbook's check now has a third table behind it.
