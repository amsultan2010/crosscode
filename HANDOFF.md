# Handoff from workstream B (privacy suite)

Changes I wanted to make in files another workstream owns. Not made.

## `docs/terms.md` — workstream A

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

## `docs/privacy.md` — a claim I could not verify

Under *How long it is kept*: "Older changes are deleted by a scheduled job."

**There is no such job in this repository.** I grepped the source tree for a cron entry, a
Vercel cron config, a scheduled function and a `DELETE FROM file_versions`, and queried
`cron.job` on the production Supabase database — the `pg_cron` schema does not exist there.
What the code does enforce is the *serving* side: `listChanges` refuses a cursor pointing at
history older than what survives, and reports `retentionDays: 7`
(`apps/service/src/store.ts:458`).

I did not edit `privacy.md` beyond the cross-links my brief allows. I documented the gap
honestly in `docs/privacy-policy.md` §8 and flagged it with a `<!-- LAWYER -->` comment.
Someone should either land the sweep as a scheduled job with a test, or soften the sentence
in `privacy.md`.

## `apps/docs-site/scripts/generate-docs.mjs` — `stripHtmlComments`, shared with workstream C

Workstream C's edits arrived in this worktree mid-run (Crosscode was syncing the two
checkouts). I removed C's page registrations from my branch so it builds standalone, but I
**kept** C's `stripHtmlComments()` helper — without it the `<!-- LAWYER: ... -->` notes in
my four pages render as escaped visible text on the published site, because the renderer
runs with `html: false`. If C's branch merges first, this is the same function twice and
the merge is a no-op. If mine merges first, C's is redundant. Either way, keep exactly one.

## `docs/support.md` — whoever owns it

It still contains the literal placeholder `[SUPPORT EMAIL]` in three table rows. The real
address is `support@getcrosscode.dev`.

## `apps/docs-site/src/analytics.js` — workstream E

`docs/cookies.md` is written for the post-removal state of `crosscode_distinct_id`, as my
brief instructs. If that removal does not land, the cookies page is wrong. Its "Before this
takes effect" checklist says so.

Same file: `docs/observability.md` notes the module is not included on
`apps/docs-site/auth/signup.html`, so `sign_up_completed` never fires. Not mine to fix, but
it affects what the analytics section of the privacy policy describes.
