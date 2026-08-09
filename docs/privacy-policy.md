# privacy policy

> **draft.** this page is written but not yet in force. the double-brace placeholders below are
> unfilled. do not rely on it as a legal document until the checklist at the end is done.

this is the complete notice required by articles 13 and 14 of the uk/eu gdpr. it is long
because those articles are long.

if you want the short honest version (what the service can and cannot see) read
[privacy: what we can and can't see](./privacy.md). that page is the summary; this page is
the complete one. where the two disagree, this page governs, but they are not meant to
disagree.

effective from {{EFFECTIVE_DATE}}.

## 1. who is responsible

the controller for the hosted crosscode coordination service is {{PROVIDER_NAME}}, an
individual acting as a sole proprietor, at {{PROVIDER_ADDRESS}}.

there is no company. crosscode is run by one person, and that person
is the one who answers privacy mail.

contact: **privacy@getcrosscode.dev**

there is no data protection officer. the service does not meet any of the art. 37(1)
thresholds that would require one.

<!-- LAWYER: no GDPR Art. 27 EU representative and no UK representative is appointed. At
     current scale (a handful of users, no EU marketing) the Art. 3(2) targeting test is
     arguably not met, so Art. 27 arguably does not bite. Revisit the moment there are
     paying or EU-recruited users. -->

## 2. what this covers

the **hosted coordination service** at `www.getcrosscode.dev`: the website, the sign-in
flow, the api the daemon talks to, and the docs site.

it does not cover the crosscode software itself. the cli, daemon and mcp server are mit
licensed and run on your machine. running them without signing in sends nothing anywhere.

## 3. categories of personal data

### 3.1 data about you, the account holder

| category | what exactly | where in the code |
| --- | --- | --- |
| account identity | supabase user id (uuid), email address, github numeric id, github login | `users` table, `apps/service/migrations/001_sync.sql` |
| authentication records | email address, password hash if you used the email/password path, github oauth identity, session and refresh tokens | supabase auth |
| pending sign-in | sha-256 of the device code, the short user code you type, and (while the handshake is open) the session it will hand to your terminal | `device_codes` table, `apps/service/src/store.ts` |
| project records | project name, repository as `owner/repo`, your role, who created what, invite codes and who redeemed them | `projects`, `project_members`, `invites` |
| checkout records | a replica id per checkout, the branch it is on, when it was last seen | `replicas` |
| presence | which branch you are on and which paths you touched recently. held in memory in the websocket gateway, never written to the database | `apps/service/src/ws.ts` |
| usage events | seven named events (`user_activated`, `device_authorized`, `project_created`, `invite_created`, `invite_redeemed`, `replica_registered`, `changes_published`), each carrying your supabase user id, a timestamp, and at most a file-version count and a new-user flag | `apps/service/src/analytics.ts` |
| website analytics | four page events with no account id and no persistent identifier attached, see [cookies and local storage](./cookies.md) | `apps/docs-site/src/analytics.js` |
| error reports | route template, http method, status, a platform request id, and a redacted error message | `apps/service/src/observability.ts` |
| server logs | standard request logs kept by vercel and supabase, which include ip addresses | vercel and supabase platform defaults |

### 3.2 the file contents

**we hold the contents of the files you sync.** there is no end-to-end encryption. files
are encrypted in transit (tls) and at rest under keys the service manages, which means
someone with production access could read them.

what is stored for each change: the path, the content, the hashes either side merged
against, whether it was a modify or a delete, a timestamp, a size, and a sequence number.

only files git already tracks are ever sent. untracked files never leave your machine, and
a hard denylist drops `.env*`, `.envrc`, `.npmrc`, `.netrc`, `credentials*`, `secret*`,
ssh private keys, and `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks` / `*.keystore` before
a change is captured. see `packages/core/src/index.ts`.

### 3.3 personal data belonging to other people, inside your files

this is the exposure most policies leave out, so it is stated first-class here.

source code routinely contains other people's personal data: names and email addresses in
comments, `git blame` context and `CODEOWNERS`; real email addresses in test fixtures;
customer names, addresses or order records in seed data and database dumps; screenshots and
sample payloads.

when you sync a repository, that data passes through and is stored by the coordination
service in exactly the same way as the rest of the file content. neither of us can filter
it: the denylist matches paths, not contents, and nothing inspects what your files say.

for that data, **you are the controller and crosscode is your processor.** the
[data processing agreement](./dpa.md) is the terms on which we process it, offered
accept-by-reference so nobody has to negotiate one.

if you cannot make that commitment for a given repository, do not sync it. crosscode is
opt-in per checkout and stopping it leaves an ordinary git repository behind.

## 4. categories of data subject

- **account holders**: people who sign in and sync.
- **third parties whose personal data sits inside synced files**: everyone described in
  §3.3. they have no relationship with crosscode and no way to know their data is here,
  which is precisely why §3.3 exists.

## 5. why we process it, and on what legal basis

### 5.1 providing the service: art. 6(1)(b), contract

storing and relaying your file changes, keeping your account and projects, running the
device sign-in handshake, and deciding who may sync with whom. without this there is no
product to perform.

### 5.2 security, abuse prevention and error monitoring: art. 6(1)(f), legitimate interests

rate limiting, invite and device-code expiry, the append-only change log, server logs, and
error reports.

*balancing note.* the interest is keeping a service that holds plaintext source code from
being broken into or abused, which is as much your interest as ours. the data used is
narrow: error reports carry a route template, a method, a status, a platform request id and
an error message that has been run through `redact()` (which strips quoted spans,
anything path-shaped, filenames, and long opaque runs) plus stack frames from our own code
by basename only. request bodies, headers, cookies and environment are never read. server
logs carry ip addresses, which is unavoidable for any hosted service. nobody is profiled,
no decision is made about anybody, and none of it is combined with anything else. a user
would expect a service holding their code to watch for intrusions. we consider the interest
to prevail; if you disagree, see §9 on objection.

### 5.3 product analytics: art. 6(1)(f), legitimate interests

counting how many people reach the service and whether they get as far as syncing.

*balancing note.* server-side events are keyed on your supabase user id, carry no file
paths, no content, no branch or repository names, no email and no github login, and are
built from a two-property allowlist rather than spread from an object. website events carry
no account id and (once the change described in [cookies and local storage](./cookies.md)
ships) no persistent identifier at all, so they cannot be linked across visits. nothing is
sold, nothing is shared with advertisers, and no profile is built. the intrusion is close
to nil and the alternative is having no idea whether the project is used at all. we
consider the interest to prevail.

### 5.4 legal compliance: art. 6(1)(c), legal obligation

responding to lawful requests, keeping records where the law requires it, and handling
notice-and-takedown.

### 5.5 data inside your files: you decide

for the third-party personal data in §3.3, crosscode does not choose a legal basis: you do,
as controller. we process it only on your instructions, under the [dpa](./dpa.md).

## 6. who receives it

vendors we use to run the service, listed with what each one gets, where it sits, and under
what transfer mechanism, on the [subprocessors](./subprocessors.md) page. that page is the
authoritative list and it changes with 30 days' notice.

beyond that: nobody. your data is not sold, not rented, not shared with advertisers, and
**never used to train an ai model**, ours or anyone else's. crosscode has no ai features
and stores no model provider credentials. the only agent involved is the one already on
your machine, reading your files locally.

we disclose data to a public authority only where legally compelled, and will tell you
unless the law forbids it.

## 7. international transfers

the provider is a sole proprietor and every vendor is outside the uk/eea. details per
vendor are on [subprocessors](./subprocessors.md); the mechanisms in use are:

- **canada** (supabase's database and auth run in aws `ca-central-1`, montréal): covered by
  the european commission's adequacy decision for canadian commercial organisations, with
  supabase's standard contractual clauses as a belt-and-braces backstop.
- **united states** (vercel, posthog, sentry, github, npm): each vendor's data processing
  addendum, incorporating the eu standard contractual clauses; several are additionally
  certified under the eu–us data privacy framework.

<!-- LAWYER: no transfer impact assessment has been written. At this scale that is a
     deliberate deferral, not an oversight. Needed before any enterprise or public-sector
     user. -->

## 8. how long we keep it

| category | retention | basis |
| --- | --- | --- |
| file change history | about 7 days, then deleted | `HISTORY_RETENTION_DAYS = 7`, `apps/service/src/store.ts`. the window exists so a checkout that was offline can replay what it missed; one away longer resynchronizes from full content instead. beyond that window, history is no longer served back to any checkout. |
| account record, projects, memberships | until you ask us to delete them | needed to perform the contract |
| supabase auth records (email, password hash, github identity, sessions) | until account deletion; refresh tokens expire or are revoked on sign-out | needed to perform the contract |
| device sign-in codes | about 15 minutes, and consumed on first successful poll. rows older than an hour are deleted at the start of the next handshake; the session payload is nulled the moment the terminal collects it | `apps/service/src/store.ts` |
| invite codes | until they expire or are redeemed; the row survives to record that it was used | `invites` table |
| replica records | until the project is deleted | `replicas` table |
| presence | in memory only. gone when the connection closes or the process restarts | `apps/service/src/ws.ts` |
| server-side analytics events | posthog's project retention setting, currently the plan default | posthog |
| website analytics events | as above | posthog |
| error reports | sentry's project retention setting, currently the plan default (90 days on sentry's standard plans) | sentry |
| server and platform logs | vercel's and supabase's own log retention, which is days, not months, on their current plans | vercel, supabase |
| database backups | supabase's automated backups, on the plan's schedule. deleted data survives in a backup until that backup ages out | supabase |

**note on the 7 days.** the window is enforced on the way *out*: a cursor pointing at
history older than the window is refused rather than answered with a partial page, and the
daemon resynchronizes from full content instead. "about 7 days" is the period for which
history remains replayable to your checkouts.

<!-- LAWYER: this is a real gap. Either land the sweep as a scheduled job with a test, or
     the 7-day claim on this page and on privacy.md needs softening further. -->

## 9. your rights

under the uk/eu gdpr you can ask for:

- **access**: a copy of the personal data we hold about you.
- **rectification**: correction of anything inaccurate.
- **erasure**: deletion of your account, your projects, and the change history attached to
  them. your repositories are unaffected, because they were never ours.
- **restriction**: that we stop processing while a dispute is resolved.
- **portability**: the data you gave us, in a machine-readable form.
- **objection**: to anything done on legitimate interests (§5.2, §5.3). say so and we
  stop, unless we can show compelling grounds that override your interests.
- **withdrawal of consent**: where we ever rely on consent. today we do not; if that
  changes, withdrawing is as easy as giving it and does not affect what came before.

**how to exercise them:** email **privacy@getcrosscode.dev**. we respond within one month
of receipt, extendable by two further months for genuinely complex requests, in which case
we will tell you inside the first month and say why.

requests are free. we may ask you to prove you control the account before acting on one.
handing someone else's source code to whoever asked is the failure mode a policy like this
exists to prevent.

**one limit, stated plainly.** removing a member from a project ends their access
immediately, but it cannot un-share what they already have: they had a full checkout of the
repository. no product can reach into a copy someone already holds.

### if you are one of the third parties in §3.3

your data reached us inside someone else's repository. we usually cannot identify you, and
searching stored file contents to find you would mean reading them, which is worse than the
problem. ask the person or team that syncs the repository: they are the controller. if you
tell us who they are at **privacy@getcrosscode.dev**, we will pass the request on.

### complaints

tell us first if you are willing (**privacy@getcrosscode.dev**) but you do not have to.
you can complain to a supervisory authority in the eu/eea member state where you live,
work, or where you think something went wrong. in the uk that is the information
commissioner's office (`ico.org.uk`).

## 10. automated decision-making

there is none. no automated decision produces legal or similarly significant effects about
anybody, and there is no profiling. nothing in the service scores, ranks, or classifies
users. the analytics events in §3.1 are counted in aggregate and are not used to make
decisions about individuals.

## 11. age

you must be at least 16 to use crosscode, or the age of digital consent in your country if
that is higher. this matches §3 of the [terms of service](./terms.md). the service is not
directed at children and collects no data knowingly from them. if you believe a child's
data is here, write to **privacy@getcrosscode.dev** and it will be deleted.

## 12. is any of this required of you?

providing an email address and a github identity is a condition of having an account.
without them there is nobody to authorise and no way to check repository access at invite
redemption. not providing them means not using the hosted service. the software still works
locally.

syncing any given repository is entirely your choice, per checkout.

## 13. changes to this policy

every version of this page is in the repository's git history, so what changed and when is
public and checkable.

for material changes (a new purpose, a new legal basis, a new category of data) we will
give at least **30 days' notice** by email to account holders and by a dated note at the top
of this page, before the change takes effect. corrections and clarifications go live
immediately and are visible in the git history.

## before this takes effect

fill in, in this file:

- `{{PROVIDER_NAME}}`: the legal name of the individual provider
- `{{PROVIDER_ADDRESS}}`: a postal address for legal notices
- `{{EFFECTIVE_DATE}}`: the date this policy takes effect

and resolve, before publishing:

- the retention-sweep gap in §8. either automate the delete or soften the claim.
- the two `<!-- LAWYER -->` notes in §1 and §7.
- confirm the actual retention settings configured in the posthog and sentry projects and
  replace "the plan default" in §8 with the number.
