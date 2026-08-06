# Privacy Policy

> **Draft.** This page is written but not yet in force. The double-brace placeholders below are
> unfilled. Do not rely on it as a legal document until the checklist at the end is done.

This is the complete notice required by Articles 13 and 14 of the UK/EU GDPR. It is long
because those articles are long.

If you want the short honest version — what the service can and cannot see — read
[Privacy: what we can and can't see](./privacy.md). That page is the summary; this page is
the complete one. Where the two disagree, this page governs, but they are not meant to
disagree.

Effective from {{EFFECTIVE_DATE}}.

## 1. Who is responsible

The controller for the hosted Crosscode coordination service is {{PROVIDER_NAME}}, an
individual acting as a sole proprietor, at {{PROVIDER_ADDRESS}}.

There is no company. Crosscode is a pre-1.0 side project run by one person, and that person
is the one who answers privacy mail.

Contact: **privacy@getcrosscode.dev**

There is no Data Protection Officer. The service does not meet any of the Art. 37(1)
thresholds that would require one.

<!-- LAWYER: no GDPR Art. 27 EU representative and no UK representative is appointed. At
     current scale (a handful of users, no EU marketing) the Art. 3(2) targeting test is
     arguably not met, so Art. 27 arguably does not bite. Revisit the moment there are
     paying or EU-recruited users. -->

## 2. What this covers

The **hosted coordination service** at `www.getcrosscode.dev`: the website, the sign-in
flow, the API the daemon talks to, and the docs site.

It does not cover the Crosscode software itself. The CLI, daemon and MCP server are MIT
licensed and run on your machine. Running them without signing in sends nothing anywhere.

## 3. Categories of personal data

### 3.1 Data about you, the account holder

| Category | What exactly | Where in the code |
| --- | --- | --- |
| Account identity | Supabase user id (UUID), email address, GitHub numeric id, GitHub login | `users` table, `apps/service/migrations/001_sync.sql` |
| Authentication records | Email address, password hash if you used the email/password path, GitHub OAuth identity, session and refresh tokens | Supabase Auth |
| Pending sign-in | SHA-256 of the device code, the short user code you type, and — while the handshake is open — the session it will hand to your terminal | `device_codes` table, `apps/service/src/store.ts` |
| Project records | Project name, repository as `owner/repo`, your role, who created what, invite codes and who redeemed them | `projects`, `project_members`, `invites` |
| Checkout records | A replica id per checkout, the branch it is on, when it was last seen | `replicas` |
| Presence | Which branch you are on and which paths you touched recently. Held in memory in the websocket gateway, never written to the database | `apps/service/src/ws.ts` |
| Usage events | Seven named events (`user_activated`, `device_authorized`, `project_created`, `invite_created`, `invite_redeemed`, `replica_registered`, `changes_published`), each carrying your Supabase user id, a timestamp, and at most a file-version count and a new-user flag | `apps/service/src/analytics.ts` |
| Website analytics | Four page events with no account id and no persistent identifier attached — see [Cookies and local storage](./cookies.md) | `apps/docs-site/src/analytics.js` |
| Error reports | Route template, HTTP method, status, a platform request id, and a redacted error message | `apps/service/src/observability.ts` |
| Server logs | Standard request logs kept by Vercel and Supabase, which include IP addresses | Vercel and Supabase platform defaults |

### 3.2 The file contents

**We hold the contents of the files you sync.** There is no end-to-end encryption. Files
are encrypted in transit (TLS) and at rest under keys the service manages, which means
someone with production access could read them.

What is stored for each change: the path, the content, the hashes either side merged
against, whether it was a modify or a delete, a timestamp, a size, and a sequence number.

Only files Git already tracks are ever sent. Untracked files never leave your machine, and
a hard denylist drops `.env*`, `.envrc`, `.npmrc`, `.netrc`, `credentials*`, `secret*`,
SSH private keys, and `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks` / `*.keystore` before
a change is captured — see `packages/core/src/index.ts`.

### 3.3 Personal data belonging to other people, inside your files

This is the exposure most policies leave out, so it is stated first-class here.

Source code routinely contains other people's personal data: names and email addresses in
comments, `git blame` context and `CODEOWNERS`; real email addresses in test fixtures;
customer names, addresses or order records in seed data and database dumps; screenshots and
sample payloads.

When you sync a repository, that data passes through and is stored by the coordination
service in exactly the same way as the rest of the file content. Neither of us can filter
it — the denylist matches paths, not contents, and nothing inspects what your files say.

For that data, **you are the controller and Crosscode is your processor.** The
[Data Processing Agreement](./dpa.md) is the terms on which we process it, offered
accept-by-reference so nobody has to negotiate one.

If you cannot make that commitment for a given repository, do not sync it. Crosscode is
opt-in per checkout and stopping it leaves an ordinary Git repository behind.

## 4. Categories of data subject

- **Account holders**: people who sign in and sync.
- **Third parties whose personal data sits inside synced files**: everyone described in
  §3.3. They have no relationship with Crosscode and no way to know their data is here,
  which is precisely why §3.3 exists.

## 5. Why we process it, and on what legal basis

### 5.1 Providing the service — Art. 6(1)(b), contract

Storing and relaying your file changes, keeping your account and projects, running the
device sign-in handshake, and deciding who may sync with whom. Without this there is no
product to perform.

### 5.2 Security, abuse prevention and error monitoring — Art. 6(1)(f), legitimate interests

Rate limiting, invite and device-code expiry, the append-only change log, server logs, and
error reports.

*Balancing note.* The interest is keeping a service that holds plaintext source code from
being broken into or abused, which is as much your interest as ours. The data used is
narrow: error reports carry a route template, a method, a status, a platform request id and
an error message that has been run through `redact()` — which strips quoted spans,
anything path-shaped, filenames, and long opaque runs — plus stack frames from our own code
by basename only. Request bodies, headers, cookies and environment are never read. Server
logs carry IP addresses, which is unavoidable for any hosted service. Nobody is profiled,
no decision is made about anybody, and none of it is combined with anything else. A user
would expect a service holding their code to watch for intrusions. We consider the interest
to prevail; if you disagree, see §9 on objection.

### 5.3 Product analytics — Art. 6(1)(f), legitimate interests

Counting how many people reach the service and whether they get as far as syncing.

*Balancing note.* Server-side events are keyed on your Supabase user id, carry no file
paths, no content, no branch or repository names, no email and no GitHub login, and are
built from a two-property allowlist rather than spread from an object. Website events carry
no account id and — once the change described in [Cookies and local storage](./cookies.md)
ships — no persistent identifier at all, so they cannot be linked across visits. Nothing is
sold, nothing is shared with advertisers, and no profile is built. The intrusion is close
to nil and the alternative is having no idea whether the project is used at all. We
consider the interest to prevail.

### 5.4 Legal compliance — Art. 6(1)(c), legal obligation

Responding to lawful requests, keeping records where the law requires it, and handling
notice-and-takedown.

### 5.5 Data inside your files — you decide

For the third-party personal data in §3.3, Crosscode does not choose a legal basis: you do,
as controller. We process it only on your instructions, under the [DPA](./dpa.md).

## 6. Who receives it

Vendors we use to run the service, listed with what each one gets, where it sits, and under
what transfer mechanism, on the [Subprocessors](./subprocessors.md) page. That page is the
authoritative list and it changes with 30 days' notice.

Beyond that: nobody. Your data is not sold, not rented, not shared with advertisers, and
**never used to train an AI model** — ours or anyone else's. Crosscode has no AI features
and stores no model provider credentials. The only agent involved is the one already on
your machine, reading your files locally.

We disclose data to a public authority only where legally compelled, and will tell you
unless the law forbids it.

## 7. International transfers

The provider is a sole proprietor and every vendor is outside the UK/EEA. Details per
vendor are on [Subprocessors](./subprocessors.md); the mechanisms in use are:

- **Canada** (Supabase's database and auth run in AWS `ca-central-1`, Montréal): covered by
  the European Commission's adequacy decision for Canadian commercial organisations, with
  Supabase's Standard Contractual Clauses as a belt-and-braces backstop.
- **United States** (Vercel, PostHog, Sentry, GitHub, npm): each vendor's Data Processing
  Addendum, incorporating the EU Standard Contractual Clauses; several are additionally
  certified under the EU–US Data Privacy Framework.

<!-- LAWYER: no transfer impact assessment has been written. At this scale that is a
     deliberate deferral, not an oversight. Needed before any enterprise or public-sector
     user. -->

## 8. How long we keep it

| Category | Retention | Basis |
| --- | --- | --- |
| File change history | About 7 days, then deleted | `HISTORY_RETENTION_DAYS = 7`, `apps/service/src/store.ts`. The window exists so a checkout that was offline can replay what it missed; one away longer resynchronizes from full content instead. **The sweep that performs the deletion is not yet automated in this repository** — see the note below. |
| Account record, projects, memberships | Until you ask us to delete them | Needed to perform the contract |
| Supabase Auth records (email, password hash, GitHub identity, sessions) | Until account deletion; refresh tokens expire or are revoked on sign-out | Needed to perform the contract |
| Device sign-in codes | About 15 minutes, and consumed on first successful poll. Rows older than an hour are deleted at the start of the next handshake; the session payload is nulled the moment the terminal collects it | `apps/service/src/store.ts` |
| Invite codes | Until they expire or are redeemed; the row survives to record that it was used | `invites` table |
| Replica records | Until the project is deleted | `replicas` table |
| Presence | In memory only. Gone when the connection closes or the process restarts | `apps/service/src/ws.ts` |
| Server-side analytics events | PostHog's project retention setting, currently the plan default | PostHog |
| Website analytics events | As above | PostHog |
| Error reports | Sentry's project retention setting, currently the plan default (90 days on Sentry's standard plans) | Sentry |
| Server and platform logs | Vercel's and Supabase's own log retention, which is days, not months, on their current plans | Vercel, Supabase |
| Database backups | Supabase's automated backups, on the plan's schedule. Deleted data survives in a backup until that backup ages out | Supabase |

**Honest note on the 7 days.** The service enforces the window on the way *out*: a cursor
pointing at history older than what survives is refused rather than answered with a partial
page, and the daemon resynchronizes from full content. The deletion job itself is operated
outside this repository — there is no cron entry or scheduled function in the source tree
that performs it. Treat "about 7 days" as the retention *target* and the serving guarantee,
not as a verified automated delete.

<!-- LAWYER: this is a real gap. Either land the sweep as a scheduled job with a test, or
     the 7-day claim on this page and on privacy.md needs softening further. -->

## 9. Your rights

Under the UK/EU GDPR you can ask for:

- **Access** — a copy of the personal data we hold about you.
- **Rectification** — correction of anything inaccurate.
- **Erasure** — deletion of your account, your projects, and the change history attached to
  them. Your repositories are unaffected, because they were never ours.
- **Restriction** — that we stop processing while a dispute is resolved.
- **Portability** — the data you gave us, in a machine-readable form.
- **Objection** — to anything done on legitimate interests (§5.2, §5.3). Say so and we
  stop, unless we can show compelling grounds that override your interests.
- **Withdrawal of consent** — where we ever rely on consent. Today we do not; if that
  changes, withdrawing is as easy as giving it and does not affect what came before.

**How to exercise them:** email **privacy@getcrosscode.dev**. We respond within one month
of receipt, extendable by two further months for genuinely complex requests, in which case
we will tell you inside the first month and say why.

Requests are free. We may ask you to prove you control the account before acting on one —
handing someone else's source code to whoever asked is the failure mode a policy like this
exists to prevent.

**One limit, stated plainly.** Removing a member from a project ends their access
immediately, but it cannot un-share what they already have: they had a full checkout of the
repository. No product can reach into a copy someone already holds.

### If you are one of the third parties in §3.3

Your data reached us inside someone else's repository. We usually cannot identify you, and
searching stored file contents to find you would mean reading them, which is worse than the
problem. Ask the person or team that syncs the repository — they are the controller. If you
tell us who they are at **privacy@getcrosscode.dev**, we will pass the request on.

### Complaints

Tell us first if you are willing — **privacy@getcrosscode.dev** — but you do not have to.
You can complain to a supervisory authority in the EU/EEA member state where you live,
work, or where you think something went wrong. In the UK that is the Information
Commissioner's Office (`ico.org.uk`).

## 10. Automated decision-making

There is none. No automated decision produces legal or similarly significant effects about
anybody, and there is no profiling. Nothing in the service scores, ranks, or classifies
users. The analytics events in §3.1 are counted in aggregate and are not used to make
decisions about individuals.

## 11. Age

You must be at least 16 to use Crosscode, or the age of digital consent in your country if
that is higher. This matches §3 of the [Terms of Service](./terms.md). The service is not
directed at children and collects no data knowingly from them. If you believe a child's
data is here, write to **privacy@getcrosscode.dev** and it will be deleted.

## 12. Is any of this required of you?

Providing an email address and a GitHub identity is a condition of having an account —
without them there is nobody to authorise and no way to check repository access at invite
redemption. Not providing them means not using the hosted service. The software still works
locally.

Syncing any given repository is entirely your choice, per checkout.

## 13. Changes to this policy

Every version of this page is in the repository's Git history, so what changed and when is
public and checkable.

For material changes — a new purpose, a new legal basis, a new category of data — we will
give at least **30 days' notice** by email to account holders and by a dated note at the top
of this page, before the change takes effect. Corrections and clarifications go live
immediately and are visible in the Git history.

## Before this takes effect

Fill in, in this file:

- `{{PROVIDER_NAME}}` — the legal name of the individual provider
- `{{PROVIDER_ADDRESS}}` — a postal address for legal notices
- `{{EFFECTIVE_DATE}}` — the date this policy takes effect

And resolve, before publishing:

- The retention-sweep gap in §8. Either automate the delete or soften the claim.
- The two `<!-- LAWYER -->` notes in §1 and §7.
- Confirm the actual retention settings configured in the PostHog and Sentry projects and
  replace "the plan default" in §8 with the number.
