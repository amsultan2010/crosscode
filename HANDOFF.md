# Handoff

Open items each workstream wanted to change in files another workstream owns. Add a section
rather than replacing this file. Earlier handoffs were lost that way.

# Workstream E (truthfulness)

Changes I would have made in files another workstream owns. I did not touch them.

## 1. Retention: keep the sweep and the wording in step (A and B)

`HISTORY_RETENTION_DAYS = 7` (`apps/service/src/store.ts:68`) drives the `cursor-too-old`
answer to a replica whose cursor has aged out, which is the guarantee the docs now state:
history beyond the window is no longer served back. Any change to the constant or to a
sweep over `file_versions` needs the same change on the pages that state it:
`docs/privacy.md:41`, `docs/terms.md:110`, `docs/support.md:65`,
`apps/docs-site/index.html` (privacy seal note), `docs/architecture.md:85`, and
`docs/security.md:112`.

## 2. Encryption at rest (A and B)

`docs/privacy.md:6` and `docs/terms.md:89` say files are encrypted at rest "under keys we
manage". Crosscode adds no encryption of its own; the at-rest encryption is whatever
Supabase and Vercel provide, under keys **they** hold. Suggest "encrypted at rest by our
hosts, Supabase and Vercel, under keys they hold". I made that change in
`apps/docs-site/index.html` and `docs/security.md:93`.

The owner should keep the vendor pages evidencing this (Supabase and Vercel encryption-at-
rest documentation) in the compliance folder, so the claim has a source if it is ever
questioned.

## 3. Denylist wording (B, if `docs/privacy.md` enumerates it)

The denylist is now an enumerated list of patterns in `packages/core/src/index.ts`. Copy
the category list from `docs/security.md` ("What is never sent") if privacy.md repeats it.

## 4. Other dead scripts in `package.json` (owner)

I deleted `service:billing-sweep` as briefed. Two more scripts, `service:prune`
(`apps/service/src/prune.ts`) and `service:provision`
(`apps/service/src/provision-admin.ts`), were outside my brief, which allowed one deletion.
Confirm both resolve before the next release.

# Workstream D (terms acceptance mechanism)

Changes I wanted to make in files another workstream owns. None of them are blocking; the
mechanism works without them.

## 1. `docs/terms.md`: a version line (workstream A)

`apps/service/src/legal.ts` defines `LEGAL_VERSIONS.terms = "2026-08-01"`, and that exact
string is what lands in `terms_acceptances.version` and is printed next to the link on every
consent control. It has to equal the version of the text people were shown.

Add to the header block, and keep the two in step:

```
- **Version:** 2026-08-01
```

When the effective date is chosen, change it in **both** places (the doc and `legal.ts`).
Changing `legal.ts` alone is safe by design (every account is prompted again on next
sign-in) but the document would then say one thing and the record another.

## 2. `docs/privacy-policy.md` must exist (workstream B)

Every consent control links to `/docs/privacy-policy.html`, per this brief. **Landed** with
workstream B's privacy suite, so the link no longer 404s. `LEGAL_URLS` in
`apps/service/src/legal.ts` is the one place to change if the filename ends up different.

Its version should also be `2026-08-01` (`LEGAL_VERSIONS.privacy`).

## 3. `apps/docs-site/src/style.css`: a `.consent` rule (workstream F)

The consent block renders as `<input type="checkbox"> <label>` plus an optional hint and an
error paragraph, inside `.consent`. It is legible unstyled but wants roughly:

```css
.consent { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 0.6rem; align-items: start; }
.consent label { grid-column: 2; }
.consent p { grid-column: 2; margin: 0; font-size: 0.9em; }
```

## 4. `apps/docs-site/auth/src/account.js`: OAuth returns are not recorded

`mountAuthForm` records an acceptance for the email/password paths. The OAuth buttons
redirect away, so the tick cannot be recorded before the round trip; on return `account.js`
renders "you're signed in" and records nothing. The service refuses every route until an
acceptance exists and `/device` asks again, so coverage holds; a `surface: 'signup'` row
for an OAuth sign-up would need `account.js` to call `recordAcceptance` when it finds a
session and `fetchOutstanding` is non-empty.

## 5. `apps/daemon`: surface the 403 from `POST /v1/replicas`

Registering a replica now 403s with `Accept the current Crosscode terms and privacy at
https://www.getcrosscode.dev/device to continue` when the account owes an acceptance. In
practice `crosscode start` records one before the daemon ever runs, so this is the
terms-changed case. Worth passing the service's message through rather than reporting a
generic registration failure.

## 6. `docs/observability.md`: the grant note

That doc records the `device_codes` outage (table shipped without a grant to
`crosscode_runtime`, every request 500ing, `/healthz` answering `ok`). `terms_acceptances`
grants `SELECT, INSERT` in `migrations/003_terms_acceptances.sql` and in
`apps/service/src/migrate.ts`, and `/healthz` covers it because it scans every public table.
Worth one line saying the runbook's check now has a third table behind it.

# Workstream B (privacy suite)

Changes I wanted to make in files another workstream owns. Not made.

## `docs/terms.md`: workstream A

1. **Incorporate the DPA by reference.** `docs/dpa.md` is written to apply automatically
   ("accept-by-reference from the terms"), but nothing in the terms currently says so, which
   means it does not actually apply. Add to §5 (*Your content, and who owns it*) or §1:

   > Where the files you sync contain personal data belonging to other people, you are the
   > controller of that data and we are your processor. The [Data Processing
   > Agreement](/docs/dpa.html) sets out the terms on which we process it and forms part of
   > these terms. You do not need to sign or request it.

2. **Point at the new privacy pages.** §6 and the closing links reference
   `docs/privacy.md` only. Add `/docs/privacy-policy.html`, `/docs/cookies.html` and
   `/docs/subprocessors.html`.

3. **Age.** `docs/privacy-policy.md` §11 states minimum age 16 and cites terms §3. Keep the
   two in step if §3 changes.

## `docs/privacy.md`: where the retention claim is enforced

Under *How long it is kept*: "Older changes are deleted by a scheduled job."

The serving side is enforced in code: `listChanges` refuses a cursor pointing at history
older than what survives, and reports `retentionDays: 7`
(`apps/service/src/store.ts:458`). The scheduled deletion runs on the same window. Keep a
test on the sweep so the two halves stay in step, and keep `docs/privacy-policy.md` §8
matching this page.

I did not edit `privacy.md` beyond the cross-links my brief allows.

## `apps/docs-site/scripts/generate-docs.mjs`: `stripHtmlComments`, shared with workstream C

Workstream C's edits arrived in this worktree mid-run (Crosscode was syncing the two
checkouts). I removed C's page registrations from my branch so it builds standalone, but I
**kept** C's `stripHtmlComments()` helper: without it the `<!-- LAWYER: ... -->` notes in
my four pages render as escaped visible text on the published site, because the renderer
runs with `html: false`. If C's branch merges first, this is the same function twice and
the merge is a no-op. If mine merges first, C's is redundant. Either way, keep exactly one.

## `docs/support.md`: whoever owns it

It contained the literal placeholder `[SUPPORT EMAIL]` in three table rows. **Resolved**:
the rows now read `support@getcrosscode.dev`.

## `apps/docs-site/src/analytics.js`: workstream E

`docs/cookies.md` is written for the post-removal state of `crosscode_distinct_id`, as my
brief instructs. If that removal does not land, the cookies page is wrong. Its "Before this
takes effect" checklist says so.

Same file: `docs/observability.md` notes that `sign_up_completed` needs the module included
on `apps/docs-site/auth/signup.html`. Not mine to add, but it affects what the analytics
section of the privacy policy describes.
