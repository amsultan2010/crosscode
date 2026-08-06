# EU Digital Services Act: contact and notice-and-action

Crosscode's hosted service stores files at the request of the people who use it. Under
Regulation (EU) 2022/2065 (the Digital Services Act) that makes it a **hosting service**, and
a handful of obligations follow regardless of how small the provider is. This page is how we
meet them.

- **Effective date:** {{EFFECTIVE_DATE}}
- **Provider:** {{PROVIDER_NAME}}, an individual acting as a sole proprietor
- **Postal address:** {{PROVIDER_ADDRESS}}
- **Single point of contact:** `abuse@getcrosscode.dev`

Crosscode is not established in the EU. The DSA applies anyway, because the service is
offered to users in the EU.

## Single point of contact (Articles 11 and 12)

`abuse@getcrosscode.dev` is the single electronic point of contact for **both**:

- **Member State authorities, the Commission, and the European Board for Digital Services**
  (Art. 11), and
- **users of the service** (Art. 12).

There is one address rather than two because there is one person reading it. Splitting it
would create a second inbox that is checked less often, which is worse for everyone.

**Language:** notices and correspondence are accepted and answered in **English**. This is
the only language the provider speaks well enough to act on a legal notice in, and Art. 11(3)
and 12(3) require us to say so rather than leave you to guess.

This is a direct communication channel with a human, not a bot, and not a route into a
support queue. So that it can be found without having to ask for it, the same address is
published as a plain `mailto:` link — <mailto:abuse@getcrosscode.dev> — on this page, in the
site footer under "Trust", and as raw markdown at `/docs/dsa-contact.md`.

## Reporting illegal content (Article 16)

Anyone — you do not need an account — may report content stored by Crosscode that they
believe is illegal. Email `abuse@getcrosscode.dev`.

**What your notice must contain.** Art. 16(2) sets this out, and a notice with all four
elements is one we can act on:

1. **A sufficiently substantiated explanation** of why you believe the content is illegal.
2. **A clear indication of the exact location** of the content. For Crosscode that is: the
   repository as `owner/repo`, the branch, and the file paths. Our change log is keyed on
   those three, so a notice without them usually cannot be acted on.
3. **Your name and email**, unless the report concerns child sexual abuse material or one of
   the other offences in Articles 3 to 7 of Directive 2011/93/EU, where you may report
   anonymously.
4. **A statement** that you believe in good faith that the information in the notice is
   accurate and complete.

**What happens next.**

- We **confirm receipt** by email, without undue delay, to the address in the notice.
- We **assess** the notice against the elements above and against what the content actually
  is.
- We **tell you the decision** and the reasons for it, and note any use of automated means in
  reaching it. There are none: every decision here is made by a person reading the notice.
- If we act, the affected user gets a **statement of reasons** (below).

A notice that gives us actual knowledge of illegal content is what removes the Art. 6 hosting
liability shield if we do nothing about it. That is the whole reason this address exists and
is monitored.

**No ticketing system.** Reports arrive by email and are worked through a written internal
procedure (`docs/abuse-handling.md` in the repository). Art. 16 requires a mechanism that is
easy to access and user-friendly and allows notices to be submitted electronically; email
plus a documented procedure is that, at this scale. We would rather describe what exists than
name a system we have not built.

## Statement of reasons (Article 17)

Whenever we restrict content or an account — remove or disable access to specific files,
suspend or terminate an account or a project — the affected user receives a clear and
specific statement of reasons, by email to the address on their account. It says:

- **What was restricted**: the repository, branch, and paths, or the account.
- **Whether it is still visible to others**, and whether the restriction is temporary or
  permanent.
- **The facts and circumstances** we relied on, including whether the decision followed a
  notice from someone else, and whether automated means were used. They were not.
- **The legal ground** — the specific provision the content is said to break, and why we
  consider it applicable — **or the contractual ground**, meaning the clause of the
  [Terms of Service](/docs/terms.html) relied on, and why.
- **How to appeal**: reply to the email, or write to `legal@getcrosscode.dev`. We answer.
  Users also keep their right to go to a court, and Art. 21 out-of-court dispute settlement
  is unaffected by anything we say here.

We do not submit these statements to the Commission's DSA Transparency Database. Art. 24(5)
requires that, but Art. 19 exempts micro and small enterprises from that Section, and
Crosscode is one person with no employees and no revenue.

## Transparency reports (Article 15) — exemption relied on

We do not publish annual transparency reports. **Art. 15(2) exempts micro and small
enterprises**, and Crosscode qualifies: it is run by a single individual, with no employees,
and it earns nothing — well under the Commission Recommendation 2003/361/EC thresholds for a
micro enterprise (fewer than 10 staff and turnover at or below €2 million).

We are stating the exemption rather than staying quiet about it, because the exemption stops
applying the moment the business grows past the threshold, and a documented reliance is
easier to revisit than an unexplained silence. If Crosscode ever employs anyone or takes
revenue, this section is the thing to re-check.

We keep the underlying records anyway — notices received, actions taken, dates — because
`docs/abuse-handling.md` requires it and because the count is the first thing anyone will ask
for. See that runbook for the retention period.

## Deferred: EU legal representative (Article 13)

Article 13 requires a provider that is not established in the EU but offers services there to
**designate a legal or natural person in a Member State as its legal representative**, and to
notify their details to that Member State's Digital Services Coordinator.

**We have not done this, and the decision is deliberate.** Designating a representative means
a paid service provider in an EU state and an ongoing cost, for a free, pre-1.0 side project
with no EU user base to speak of. The provider has accepted that exposure knowingly rather
than overlooked it.

<!-- LAWYER: Art. 13 has no micro-enterprise exemption — unlike Art. 15 and the Section 3
     obligations, it applies on its face to every non-EU provider offering services in the
     EU, and the representative can be held liable for non-compliance. The judgement being
     made is a risk one (enforcement against a free, no-revenue, sub-100-user project is
     unlikely) rather than a legal one. Confirm that framing, and confirm the trigger for
     revisiting it: first paying EU user, or first EU enforcement contact, whichever is
     first. -->

## What this page is not

It is not a route for copyright takedowns under US law — those go to `legal@getcrosscode.dev`
and are described in [Copyright and DMCA](/docs/dmca.html). It is not support:
`support@getcrosscode.dev` is for that. It is not security disclosure:
`security@getcrosscode.dev` and
[SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md) are for that.

Crosscode is a coordination service, not a public platform. There is no feed, no public
content, no recommender system, and no advertising, so the DSA obligations attached to online
platforms and to very large ones do not apply. What does apply is what is on this page.

## Before this takes effect

- `{{PROVIDER_NAME}}` — the legal name of the individual provider.
- `{{PROVIDER_ADDRESS}}` — the postal address for legal notices.
- `{{EFFECTIVE_DATE}}` — the date this page takes effect.
- Confirm the **Art. 15(2) micro-enterprise exemption** still holds on the effective date.
- Confirm the **Art. 13 legal representative** deferral is still the decision, and record the
  trigger for revisiting it.
