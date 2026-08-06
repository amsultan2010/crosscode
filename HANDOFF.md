# Handoff from workstream E (truthfulness)

Changes I would have made in files another workstream owns. I did not touch them.

## 1. Retention: the 7-day claim is not delivered by any code — please reword (A and B)

`HISTORY_RETENTION_DAYS = 7` (`apps/service/src/store.ts:68`) is only used to answer a
replica whose cursor has aged out with `cursor-too-old`. **There is no retention sweep
anywhere in the repo.** `package.json` points `service:prune` at
`apps/service/src/prune.ts`, which does not exist; `PLAN.md:167` ticks `prune.ts` and
`retention.ts` as done and they do not exist either; `apps/service/migrations/001_sync.sql`
gives `file_versions` no DELETE policy and no scheduled job. So change history is currently
retained **indefinitely**, and only the last ~7 days is replayable.

"We keep it for 7 days" is a deletion promise to a data subject. Suggested wording:

- `docs/privacy.md:41` ("About 7 days.") →
  "About 7 days of history is replayable, which is what makes offline catch-up possible.
  Pre-1.0 caveat: the sweep that deletes older history is not running yet, so the service
  still holds it. Until it is, treat the retention period as indefinite."
- `docs/terms.md:110` ("Change history is retained for about seven days regardless.") →
  "About seven days of change history is replayable regardless. Older history is not served
  back, and the sweep that deletes it is not running yet."
- `docs/support.md:65` ("History older than about 7 days is gone.") →
  "History older than about 7 days is no longer replayed to a checkout."

I already made the equivalent change in the files I own: `apps/docs-site/index.html`
(privacy seal note), `docs/architecture.md:85`, `docs/security.md:112`.

**The real fix is to build the sweep**, then revert all of this wording. Whoever owns
`apps/service`: a `prune.ts` that deletes `file_versions` older than
`HISTORY_RETENTION_DAYS`, run on a schedule, closes the gap.

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

I deleted `service:billing-sweep` as briefed. Two more scripts point at files that do not
exist and will fail the moment anyone runs them: `service:prune`
(`apps/service/src/prune.ts`) and `service:provision`
(`apps/service/src/provision-admin.ts`). Left alone — my brief allowed one deletion — but
they should go or be implemented. `PLAN.md:167` should stop claiming they are done.
