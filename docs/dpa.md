# Data Processing Agreement

> **Draft.** Not yet in force. The double-brace placeholders are unfilled and the SCC annex in
> §13 is a placeholder. Do not rely on this as a signed agreement until the checklist at the
> end is done.

This is the Article 28 agreement between you and Crosscode for the personal data that ends
up inside the files you sync. It applies automatically when you use the hosted service —
you do not have to sign, request or negotiate anything. If you need a counter-signed copy
for your own records, write to **legal@getcrosscode.dev**.

It is short on purpose. Everything in it is a commitment a one-person project can actually
keep.

Effective from {{EFFECTIVE_DATE}}.

## 1. Parties and roles

- **Controller:** you — the account holder, or the organisation you sync on behalf of.
- **Processor:** {{PROVIDER_NAME}}, an individual acting as a sole proprietor, at
  {{PROVIDER_ADDRESS}} ("Crosscode").

You decide why and how the personal data inside your repositories is processed. Crosscode
processes it only to run the sync service, on your instructions.

For your own account data — your email, your GitHub identity, your projects — Crosscode is
the **controller**, not your processor, and the [Privacy Policy](./privacy-policy.md)
governs instead. This agreement covers only the data inside your files.

## 2. Subject matter, nature and purpose

**Subject matter.** Real-time synchronisation of uncommitted working-tree files between Git
checkouts of the same repository.

**Nature of the processing.** Receiving file changes from your checkouts, storing them,
relaying them to your other checkouts and to members you have invited, and deleting them
when the retention window passes. Also: authenticating your users, deciding who may sync
with whom, recording errors, and counting usage.

**Purpose.** To perform the sync service for you. Nothing else. In particular the data is
never used to train a model, is never sold or shared with advertisers, and is never
processed for Crosscode's own purposes beyond the security, error-monitoring and
usage-counting described in §5 of the [Privacy Policy](./privacy-policy.md).

**Duration.** From when you first sync until you stop and ask for deletion, or the account
ends.

## 3. Types of personal data

Whatever your repositories contain. Crosscode does not inspect file contents and cannot
categorise them, so this is stated by shape rather than by list:

- Personal data written into source code and configuration: names and email addresses in
  comments, `CODEOWNERS`, authorship metadata.
- Personal data in test fixtures, seed data, sample payloads, screenshots and database
  dumps: names, email addresses, postal addresses, order and customer records, and anything
  else that ends up in a fixture.
- Anything else a tracked file happens to hold.

**Two limits that reduce this materially.** Only files Git already *tracks* are ever sent —
untracked files never leave the machine. And a path denylist drops `.env*`, `.envrc`,
`.npmrc`, `.netrc`, `credentials*`, `secret*`, SSH private keys, and `*.pem` / `*.key` /
`*.p12` / `*.pfx` / `*.jks` / `*.keystore` before a change is captured, rather than
filtering them later. `packages/core/src/index.ts` is the authoritative list.

**Special category data (Art. 9) and criminal offence data (Art. 10) are outside the scope
of this agreement.** The service is not designed for them and you must not sync
repositories that contain them.

## 4. Categories of data subject

Whoever your repositories describe: your customers and end users, your employees and
contributors, and third parties named in code, fixtures or documentation.

## 5. Your instructions

Crosscode processes the data only on your documented instructions. Using the service is
the instruction: syncing a checkout instructs us to store and relay its tracked file
changes.

Further instructions go to **privacy@getcrosscode.dev**. We will follow reasonable ones
that the service is technically capable of. If an instruction would require a feature that
does not exist, we will say so rather than agree and not do it.

If an instruction would breach data protection law, we will tell you and may pause that
processing.

Crosscode will not transfer the data to a third country except as described in §7 and §13,
and will tell you if legally required to do so unless the law forbids the telling.

## 6. Confidentiality

Exactly one person has production access: {{PROVIDER_NAME}}. There is no team, so there is
no list of authorised personnel to maintain and nobody else to bind. That person is bound
to confidentiality by this agreement.

If that ever stops being true — a second maintainer, a contractor with production access —
each such person will be under a written confidentiality obligation before they get access,
and this section will be updated to say so.

## 7. Security measures (Art. 32)

What the code actually does. Written to be checkable against the repository, not to sound
reassuring.

### 7.1 The one thing to understand first

**There is no end-to-end encryption.** Files are encrypted in transit and at rest, but
under keys Crosscode manages, which means someone with production access could read your
file contents. A DPA that implied otherwise would be worse than no DPA.

Crosscode built E2E encryption once and removed it: it cost a device-pairing ceremony, a
keyring, epochs, rotation and recovery paths, for a product whose durable artifact is a Git
repository you already have. That trade is stated openly in the
[security model](/docs/safety.html) and it is the trade you are accepting here.

If a repository cannot be read by us, do not sync it.

### 7.2 Encryption

- **In transit:** TLS everywhere. Database connections require `sslmode=verify-full` — both
  certificate chain and hostname are verified, with a private root supplied where the
  managed provider uses one. A non-loopback connection string without `verify-full` is
  refused at startup, not warned about.
- **At rest:** provider-managed encryption on Supabase's storage layer.

### 7.3 Minimisation before capture

- **Tracked files only.** Untracked files are never eligible.
- **The secret denylist in §3**, enforced before a change is captured rather than filtered
  after.
- **Nothing outside the working tree.** Symlinks that leave the checkout are refused.
- **Retention.** Change history is kept for about 7 days
  (`HISTORY_RETENTION_DAYS = 7`) and then deleted. See the honest note in §8 of the
  [Privacy Policy](./privacy-policy.md) about the state of the deletion job.

### 7.4 Access control

- Sign-in is GitHub OAuth or email/password through Supabase Auth. The service verifies
  access tokens against Supabase's JWKS and takes identity from the verified claims, never
  from anything the client asserts.
- Project membership is re-derived server-side on **every** request rather than trusted from
  a scope in the token, so a removed member loses access on their next request.
- Invite redemption verifies through GitHub that the redeeming account can actually read
  the repository. A valid code held by someone without repo access is refused.
- CLI sign-in is a device-code handshake: no local listener, two codes of deliberately
  unequal power, only a SHA-256 of the device code is stored, ~15-minute expiry,
  single-use, and the poll route is rate-limited.
- Row Level Security is on from the first migration. The service connects with a
  least-privilege role that cannot UPDATE, DELETE or TRUNCATE the change log; retention
  runs on a separate connection.

### 7.5 Integrity

The receiving daemon verifies every change before applying it: content must hash to the
`contentHash` on the wire, and the merge base must resolve to the `baseHash` the sender
recorded. A change failing either is not applied. The check is deliberately the receiver's
— a service willing to substitute content would substitute the hash beside it.

### 7.6 Telemetry hygiene

Error reports are built field by field from an allowlist. The message goes through
`redact()`, which strips quoted spans, anything path-shaped, filenames with a known
extension, and runs of 24+ opaque characters. Routes are templated so identifiers become
`:id`. Request bodies, headers, cookies and environment are never read. Analytics
properties are allowlisted and carry no content, paths, branch names, repository names,
emails or GitHub logins.

### 7.7 What is not in place

Stated because omitting it is the thing that makes a security annex dishonest:

- No SOC 2, ISO 27001 or any third-party audit.
- No penetration test.
- No formal business continuity or disaster recovery plan beyond the managed provider's
  automated backups.
- No 24/7 on-call. One person, best effort.
- Availability, resilience and restore testing (Art. 32(1)(b)–(c)) rest on Supabase's and
  Vercel's platform guarantees, not on anything Crosscode operates.

## 8. Sub-processors

You give **general written authorisation** for the sub-processors listed on
[Subprocessors](./subprocessors.md), and for changes to that list on the terms stated
there: **30 days' advance notice**, a right to object within that window, and emergency
replacement with notice within 3 business days where a vendor fails or must be dropped for
a security reason.

Each sub-processor is engaged under a written agreement imposing data protection
obligations no less protective than these. Crosscode remains fully liable to you for their
performance.

## 9. Assisting you

**Data subject requests.** If a data subject contacts Crosscode about data inside your
repository, we will not respond substantively — we will tell them to contact you, and tell
you within **5 business days** if we can identify you. Realistically we usually cannot
identify whose data is in a file, because identifying it would mean reading your files.

We will help you answer a request as far as the service technically allows. In practice
that means deleting a project, deleting an account, or deleting the change history attached
to either. Crosscode cannot search inside stored file contents for one person's data, and
would not, because doing so means reading your code.

**DPIAs and prior consultation.** We will give you the information described in this
agreement and in the [Privacy Policy](./privacy-policy.md) to support an Art. 35 assessment
or an Art. 36 consultation. That information is this documentation; there is no
questionnaire desk behind it.

## 10. Personal data breach

**Crosscode will notify you without undue delay and in any event within 48 hours** of
becoming aware of a personal data breach affecting your data. 48 hours, not 72, so that you
retain time inside your own 72-hour Art. 33 clock.

The notification will describe the nature of the breach, the categories and approximate
number of data subjects and records affected, the likely consequences, and the measures
taken or proposed — or, where the facts are not yet established, what is known so far,
followed by updates as the picture firms up. Notice goes to the email address on the
account, from **security@getcrosscode.dev**.

Notifying **your** supervisory authority and **your** data subjects is your decision and
your obligation as controller. Crosscode will give you what you need to make it.

The breach runbook that produces this notification is in the
[security model](/docs/safety.html#breach-response-runbook).

## 11. Deletion and return

On termination, or on your request at any time, Crosscode will delete your projects, their
change history, and your account records.

**Return.** There is nothing to hand back. The data Crosscode holds is a ~7-day log of
changes to files you already have, in a repository on your own disk that is the durable
artifact the whole time. If you want an export anyway, ask within 30 days of termination
and we will provide what the service can produce.

**The limits, stated plainly:**

- **Backups.** Deleted rows survive in the managed provider's automated backups until those
  backups age out on the provider's schedule. They are not restored except to recover from
  a failure, and if a restore ever reinstates deleted data it is re-deleted.
- **Copies teammates already hold.** Every member of a project had a full checkout.
  Deletion here cannot reach a copy someone already has, and no product can.

## 12. Audit

You may verify compliance with this agreement by:

1. **Reading the source.** Crosscode is MIT licensed and public at
   `github.com/amsultan2010/crosscode`. Every security claim in §7 names the file that
   implements it. This is a stronger audit right than most processors offer and it costs
   you nothing.
2. **Asking.** Written questions to **privacy@getcrosscode.dev** get a written answer
   within 30 days, at most once per 12 months absent a breach or a regulator's demand.
3. **Sub-processor reports.** We will pass on whatever certifications and audit reports
   Supabase and Vercel make available to their customers.

**On-site inspection is not offered.** There is no site — one person, no office, no
datacentre of our own. An on-premises audit right would be a promise that could not be
kept. If your compliance programme requires one, Crosscode is not a suitable processor for
that workload, and it is better that you learn it here than after signing.

## 13. International transfers

Sub-processors are in the United States and Canada; the per-vendor detail and mechanism is
on [Subprocessors](./subprocessors.md).

Where the EU Standard Contractual Clauses are needed for a transfer under this agreement,
Module Three (processor to sub-processor) applies, together with the UK Addendum for UK
transfers, and they are incorporated by reference with the annexes completed as follows:

- **Annex I(A), Parties** — you as data exporter; {{PROVIDER_NAME}}, {{PROVIDER_ADDRESS}}
  as data importer.
- **Annex I(B), Description of transfer** — §§2, 3 and 4 of this agreement.
- **Annex I(C), Competent supervisory authority** — the authority competent for you as
  controller.
- **Annex II, Technical and organisational measures** — §7 of this agreement, in full,
  including §7.7.
- **Annex III, Sub-processors** — the [Subprocessors](./subprocessors.md) page as it stands
  from time to time.

<!-- LAWYER: this incorporates the SCCs by reference with a mapped-annex approach rather
     than attaching an executed copy. That is common and generally workable, but the
     annexes have not been reviewed against the 2021/914 text, the Module Three selection
     assumes the exporter is a controller, and no transfer impact assessment exists. All
     three need a lawyer before any customer relies on this. -->

## 14. General

**Governing law and venue:** {{JURISDICTION}}. Where the SCCs apply, their own governing
law and forum clauses prevail over this section for the transfers they cover.

**Precedence.** For the personal data inside your files, this agreement prevails over the
[Terms of Service](./terms.md) if the two conflict. For everything else the Terms govern.

**Changes.** Material changes get 30 days' notice by the same route as §8. Every version of
this page is in the repository's Git history.

**Liability.** The limitation of liability in the [Terms of Service](./terms.md) applies to
this agreement, except where the GDPR or the SCCs make a limitation unenforceable, in which
case the statutory position governs.

## Before this takes effect

Fill in, in this file:

- `{{PROVIDER_NAME}}` — appears in §1, §6, and Annex I(A) in §13
- `{{PROVIDER_ADDRESS}}` — appears in §1 and Annex I(A) in §13
- `{{JURISDICTION}}` — §14
- `{{EFFECTIVE_DATE}}` — the header

And resolve, before publishing:

- The `<!-- LAWYER -->` note in §13 on the SCC annexes and the missing transfer impact
  assessment.
- Add an accept-by-reference clause to the [Terms of Service](./terms.md) pointing here, so
  this agreement is actually incorporated. That file is owned by another workstream — see
  `HANDOFF.md`.
- Decide whether the 48-hour breach deadline in §10 is one you can meet as a single person.
  It is deliberately tighter than the 72 hours the law gives your controller. If it is not
  realistic, change it before publishing rather than miss it later.
