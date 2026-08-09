# data processing agreement

> **draft.** not yet in force. the double-brace placeholders are unfilled and the scc annex in
> §13 is a placeholder. do not rely on this as a signed agreement until the checklist at the
> end is done.

this is the article 28 agreement between you and crosscode for the personal data that ends
up inside the files you sync. it applies automatically when you use the hosted service.
you do not have to sign, request or negotiate anything. if you need a counter-signed copy
for your own records, write to **legal@getcrosscode.dev**.

it is short on purpose. everything in it is a commitment a one-person project can actually
keep.

effective from {{EFFECTIVE_DATE}}.

## 1. parties and roles

- **controller:** you: the account holder, or the organisation you sync on behalf of.
- **processor:** {{PROVIDER_NAME}}, an individual acting as a sole proprietor, at
  {{PROVIDER_ADDRESS}} ("crosscode").

you decide why and how the personal data inside your repositories is processed. crosscode
processes it only to run the sync service, on your instructions.

for your own account data (your email, your github identity, your projects) crosscode is
the **controller**, not your processor, and the [privacy policy](./privacy-policy.md)
governs instead. this agreement covers only the data inside your files.

## 2. subject matter, nature and purpose

**subject matter.** real-time synchronisation of uncommitted working-tree files between git
checkouts of the same repository.

**nature of the processing.** receiving file changes from your checkouts, storing them,
relaying them to your other checkouts and to members you have invited, and deleting them
when the retention window passes. also: authenticating your users, deciding who may sync
with whom, recording errors, and counting usage.

**purpose.** to perform the sync service for you. nothing else. in particular the data is
never used to train a model, is never sold or shared with advertisers, and is never
processed for crosscode's own purposes beyond the security, error-monitoring and
usage-counting described in §5 of the [privacy policy](./privacy-policy.md).

**duration.** from when you first sync until you stop and ask for deletion, or the account
ends.

## 3. types of personal data

whatever your repositories contain. crosscode does not inspect file contents and cannot
categorise them, so this is stated by shape rather than by list:

- personal data written into source code and configuration: names and email addresses in
  comments, `CODEOWNERS`, authorship metadata.
- personal data in test fixtures, seed data, sample payloads, screenshots and database
  dumps: names, email addresses, postal addresses, order and customer records, and anything
  else that ends up in a fixture.
- anything else a tracked file happens to hold.

**two limits that reduce this materially.** only files git already *tracks* are ever sent, and
untracked files never leave the machine. and a path denylist drops `.env*`, `.envrc`,
`.npmrc`, `.netrc`, `credentials*`, `secret*`, ssh private keys, and `*.pem` / `*.key` /
`*.p12` / `*.pfx` / `*.jks` / `*.keystore` before a change is captured, rather than
filtering them later. `packages/core/src/index.ts` is the authoritative list.

**special category data (art. 9) and criminal offence data (art. 10) are outside the scope
of this agreement.** the service is not designed for them and you must not sync
repositories that contain them.

## 4. categories of data subject

whoever your repositories describe: your customers and end users, your employees and
contributors, and third parties named in code, fixtures or documentation.

## 5. your instructions

crosscode processes the data only on your documented instructions. using the service is
the instruction: syncing a checkout instructs us to store and relay its tracked file
changes.

further instructions go to **privacy@getcrosscode.dev**. we will follow reasonable ones
that the service is technically capable of. if an instruction would require a feature that
does not exist, we will say so rather than agree and not do it.

if an instruction would breach data protection law, we will tell you and may pause that
processing.

crosscode will not transfer the data to a third country except as described in §7 and §13,
and will tell you if legally required to do so unless the law forbids the telling.

## 6. confidentiality

exactly one person has production access: {{PROVIDER_NAME}}. there is no team, so there is
no list of authorised personnel to maintain and nobody else to bind. that person is bound
to confidentiality by this agreement.

if that ever stops being true (a second maintainer, a contractor with production access)
each such person will be under a written confidentiality obligation before they get access,
and this section will be updated to say so.

## 7. security measures (art. 32)

what the code actually does. written to be checkable against the repository, not to sound
reassuring.

### 7.1 the one thing to understand first

**there is no end-to-end encryption.** files are encrypted in transit and at rest, but
under keys crosscode manages, which means someone with production access could read your
file contents. a dpa that implied otherwise would be worse than no dpa.

crosscode built e2e encryption once and removed it: it cost a device-pairing ceremony, a
keyring, epochs, rotation and recovery paths, for a product whose durable artifact is a git
repository you already have. that trade is stated openly in the
[security model](/docs/safety.html) and it is the trade you are accepting here.

if a repository cannot be read by us, do not sync it.

### 7.2 encryption

- **in transit:** tls everywhere. database connections require `sslmode=verify-full`, so both
  certificate chain and hostname are verified, with a private root supplied where the
  managed provider uses one. a non-loopback connection string without `verify-full` is
  refused at startup, not warned about.
- **at rest:** provider-managed encryption on supabase's storage layer.

### 7.3 minimisation before capture

- **tracked files only.** untracked files are never eligible.
- **the secret denylist in §3**, enforced before a change is captured rather than filtered
  after.
- **nothing outside the working tree.** symlinks that leave the checkout are refused.
- **retention.** change history is kept for about 7 days
  (`HISTORY_RETENTION_DAYS = 7`) and then deleted. see the honest note in §8 of the
  [privacy policy](./privacy-policy.md) about the state of the deletion job.

### 7.4 access control

- sign-in is github oauth or email/password through supabase auth. the service verifies
  access tokens against supabase's jwks and takes identity from the verified claims, never
  from anything the client asserts.
- project membership is re-derived server-side on **every** request rather than trusted from
  a scope in the token, so a removed member loses access on their next request.
- invite redemption verifies through github that the redeeming account can actually read
  the repository. a valid code held by someone without repo access is refused.
- cli sign-in is a device-code handshake: no local listener, two codes of deliberately
  unequal power, only a sha-256 of the device code is stored, ~15-minute expiry,
  single-use, and the poll route is rate-limited.
- row level security is on from the first migration. the service connects with a
  least-privilege role that cannot update, delete or truncate the change log; retention
  runs on a separate connection.

### 7.5 integrity

the receiving daemon verifies every change before applying it: content must hash to the
`contentHash` on the wire, and the merge base must resolve to the `baseHash` the sender
recorded. a change failing either is not applied. the check is deliberately the receiver's
a service willing to substitute content would substitute the hash beside it.

### 7.6 telemetry hygiene

error reports are built field by field from an allowlist. the message goes through
`redact()`, which strips quoted spans, anything path-shaped, filenames with a known
extension, and runs of 24+ opaque characters. routes are templated so identifiers become
`:id`. request bodies, headers, cookies and environment are never read. analytics
properties are allowlisted and carry no content, paths, branch names, repository names,
emails or github logins.

### 7.7 what is not in place

stated because omitting it is the thing that makes a security annex dishonest:

- no soc 2, iso 27001 or any third-party audit.
- no penetration test.
- no formal business continuity or disaster recovery plan beyond the managed provider's
  automated backups.
- no 24/7 on-call. one person, best effort.
- availability, resilience and restore testing (art. 32(1)(b)–(c)) rest on supabase's and
  vercel's platform guarantees, not on anything crosscode operates.

## 8. sub-processors

you give **general written authorisation** for the sub-processors listed on
[subprocessors](./subprocessors.md), and for changes to that list on the terms stated
there: **30 days' advance notice**, a right to object within that window, and emergency
replacement with notice within 3 business days where a vendor fails or must be dropped for
a security reason.

each sub-processor is engaged under a written agreement imposing data protection
obligations no less protective than these. crosscode remains fully liable to you for their
performance.

## 9. assisting you

**data subject requests.** if a data subject contacts crosscode about data inside your
repository, we will not respond substantively. we will tell them to contact you, and tell
you within **5 business days** if we can identify you. realistically we usually cannot
identify whose data is in a file, because identifying it would mean reading your files.

we will help you answer a request as far as the service technically allows. in practice
that means deleting a project, deleting an account, or deleting the change history attached
to either. crosscode cannot search inside stored file contents for one person's data, and
would not, because doing so means reading your code.

**dpias and prior consultation.** we will give you the information described in this
agreement and in the [privacy policy](./privacy-policy.md) to support an art. 35 assessment
or an art. 36 consultation. that information is this documentation; there is no
questionnaire desk behind it.

## 10. personal data breach

**crosscode will notify you without undue delay and in any event within 48 hours** of
becoming aware of a personal data breach affecting your data. 48 hours, not 72, so that you
retain time inside your own 72-hour art. 33 clock.

the notification will describe the nature of the breach, the categories and approximate
number of data subjects and records affected, the likely consequences, and the measures
taken or proposed, or, where the facts are not yet established, what is known so far,
followed by updates as the picture firms up. notice goes to the email address on the
account, from **security@getcrosscode.dev**.

notifying **your** supervisory authority and **your** data subjects is your decision and
your obligation as controller. crosscode will give you what you need to make it.

the breach runbook that produces this notification is in the
[security model](/docs/safety.html#breach-response-runbook).

## 11. deletion and return

on termination, or on your request at any time, crosscode will delete your projects, their
change history, and your account records.

**return.** there is nothing to hand back. the data crosscode holds is a ~7-day log of
changes to files you already have, in a repository on your own disk that is the durable
artifact the whole time. if you want an export anyway, ask within 30 days of termination
and we will provide what the service can produce.

**the limits, stated plainly:**

- **backups.** deleted rows survive in the managed provider's automated backups until those
  backups age out on the provider's schedule. they are not restored except to recover from
  a failure, and if a restore ever reinstates deleted data it is re-deleted.
- **copies teammates already hold.** every member of a project had a full checkout.
  deletion here cannot reach a copy someone already has, and no product can.

## 12. audit

you may verify compliance with this agreement by:

1. **reading the source.** crosscode is mit licensed and public at
   `github.com/amsultan2010/crosscode`. every security claim in §7 names the file that
   implements it. this is a stronger audit right than most processors offer and it costs
   you nothing.
2. **asking.** written questions to **privacy@getcrosscode.dev** get a written answer
   within 30 days, at most once per 12 months absent a breach or a regulator's demand.
3. **sub-processor reports.** we will pass on whatever certifications and audit reports
   supabase and vercel make available to their customers.

**on-site inspection is not offered.** there is no site: one person, no office, no
datacentre of our own. an on-premises audit right would be a promise that could not be
kept. if your compliance programme requires one, crosscode is not a suitable processor for
that workload, and it is better that you learn it here than after signing.

## 13. international transfers

sub-processors are in the united states and canada; the per-vendor detail and mechanism is
on [subprocessors](./subprocessors.md).

where the eu standard contractual clauses are needed for a transfer under this agreement,
module three (processor to sub-processor) applies, together with the uk addendum for uk
transfers, and they are incorporated by reference with the annexes completed as follows:

- **annex i(a), parties**: you as data exporter; {{PROVIDER_NAME}}, {{PROVIDER_ADDRESS}}
  as data importer.
- **annex i(b), description of transfer**: §§2, 3 and 4 of this agreement.
- **annex i(c), competent supervisory authority**: the authority competent for you as
  controller.
- **annex ii, technical and organisational measures**: §7 of this agreement, in full,
  including §7.7.
- **annex iii, sub-processors**: the [subprocessors](./subprocessors.md) page as it stands
  from time to time.

<!-- LAWYER: this incorporates the SCCs by reference with a mapped-annex approach rather
     than attaching an executed copy. That is common and generally workable, but the
     annexes have not been reviewed against the 2021/914 text, the Module Three selection
     assumes the exporter is a controller, and no transfer impact assessment exists. All
     three need a lawyer before any customer relies on this. -->

## 14. general

**governing law and venue:** {{jurisdiction}}. where the sccs apply, their own governing
law and forum clauses prevail over this section for the transfers they cover.

**precedence.** for the personal data inside your files, this agreement prevails over the
[terms of service](./terms.md) if the two conflict. for everything else the terms govern.

**changes.** material changes get 30 days' notice by the same route as §8. every version of
this page is in the repository's git history.

**liability.** the limitation of liability in the [terms of service](./terms.md) applies to
this agreement, except where the gdpr or the sccs make a limitation unenforceable, in which
case the statutory position governs.

## before this takes effect

fill in, in this file:

- `{{PROVIDER_NAME}}`: appears in §1, §6, and annex i(a) in §13
- `{{PROVIDER_ADDRESS}}`: appears in §1 and annex i(a) in §13
- `{{JURISDICTION}}`: §14
- `{{EFFECTIVE_DATE}}`: the header

and resolve, before publishing:

- the `<!-- LAWYER -->` note in §13 on the scc annexes and the missing transfer impact
  assessment.
- add an accept-by-reference clause to the [terms of service](./terms.md) pointing here, so
  this agreement is actually incorporated. that file is owned by another workstream, see
  `HANDOFF.md`.
- decide whether the 48-hour breach deadline in §10 is one you can meet as a single person.
  it is deliberately tighter than the 72 hours the law gives your controller. if it is not
  realistic, change it before publishing rather than miss it later.
