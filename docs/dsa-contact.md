# eu digital services act: contact and notice-and-action

crosscode's hosted service stores files at the request of the people who use it. under
regulation (eu) 2022/2065 (the digital services act) that makes it a **hosting service**, and
a handful of obligations follow regardless of how small the provider is. this page is how we
meet them.

- **effective date:** {{EFFECTIVE_DATE}}
- **provider:** {{PROVIDER_NAME}}, an individual acting as a sole proprietor
- **postal address:** {{PROVIDER_ADDRESS}}
- **single point of contact:** `abuse@getcrosscode.dev`

crosscode is not established in the eu. the dsa applies anyway, because the service is
offered to users in the eu.

## single point of contact (articles 11 and 12)

`abuse@getcrosscode.dev` is the single electronic point of contact for **both**:

- **member state authorities, the commission, and the european board for digital services**
  (art. 11), and
- **users of the service** (art. 12).

there is one address rather than two because there is one person reading it. splitting it
would create a second inbox that is checked less often, which is worse for everyone.

**language:** notices and correspondence are accepted and answered in **english**. this is
the only language the provider speaks well enough to act on a legal notice in, and art. 11(3)
and 12(3) require us to say so rather than leave you to guess.

this is a direct communication channel with a human, not a bot, and not a route into a
support queue. so that it can be found without having to ask for it, the same address is
published as a plain `mailto:` link (<mailto:abuse@getcrosscode.dev>) on this page, in the
site footer under "trust", and as raw markdown at `/docs/dsa-contact.md`.

## reporting illegal content (article 16)

anyone (you do not need an account) may report content stored by crosscode that they
believe is illegal. email `abuse@getcrosscode.dev`.

**what your notice must contain.** art. 16(2) sets this out, and a notice with all four
elements is one we can act on:

1. **a sufficiently substantiated explanation** of why you believe the content is illegal.
2. **a clear indication of the exact location** of the content. for crosscode that is: the
   repository as `owner/repo`, the branch, and the file paths. our change log is keyed on
   those three, so a notice without them usually cannot be acted on.
3. **your name and email**, unless the report concerns child sexual abuse material or one of
   the other offences in articles 3 to 7 of directive 2011/93/eu, where you may report
   anonymously.
4. **a statement** that you believe in good faith that the information in the notice is
   accurate and complete.

**what happens next.**

- we **confirm receipt** by email, without undue delay, to the address in the notice.
- we **assess** the notice against the elements above and against what the content actually
  is.
- we **tell you the decision** and the reasons for it, and note any use of automated means in
  reaching it. there are none: every decision here is made by a person reading the notice.
- if we act, the affected user gets a **statement of reasons** (below).

a notice that gives us actual knowledge of illegal content is what removes the art. 6 hosting
liability shield if we do nothing about it. that is the whole reason this address exists and
is monitored.

**no ticketing system.** reports arrive by email and are worked through a written internal
procedure (`docs/abuse-handling.md` in the repository). art. 16 requires a mechanism that is
easy to access and user-friendly and allows notices to be submitted electronically; email
plus a documented procedure is that, at this scale. we would rather describe what exists than
name a system we have not built.

## statement of reasons (article 17)

whenever we restrict content or an account (remove or disable access to specific files,
suspend or terminate an account or a project) the affected user receives a clear and
specific statement of reasons, by email to the address on their account. it says:

- **what was restricted**: the repository, branch, and paths, or the account.
- **whether it is still visible to others**, and whether the restriction is temporary or
  permanent.
- **the facts and circumstances** we relied on, including whether the decision followed a
  notice from someone else, and whether automated means were used. they were not.
- **the legal ground** (the specific provision the content is said to break, and why we
  consider it applicable) **or the contractual ground**, meaning the clause of the
  [terms of service](/docs/terms.html) relied on, and why.
- **how to appeal**: reply to the email, or write to `legal@getcrosscode.dev`. we answer.
  users also keep their right to go to a court, and art. 21 out-of-court dispute settlement
  is unaffected by anything we say here.

we do not submit these statements to the commission's dsa transparency database. art. 24(5)
requires that, but art. 19 exempts micro and small enterprises from that section, and
crosscode is one person with no employees and no revenue.

## transparency reports (article 15): exemption relied on

we do not publish annual transparency reports. **art. 15(2) exempts micro and small
enterprises**, and crosscode qualifies: it is run by a single individual, with no employees,
and it earns nothing, well under the commission recommendation 2003/361/ec thresholds for a
micro enterprise (fewer than 10 staff and turnover at or below €2 million).

we are stating the exemption rather than staying quiet about it, because the exemption stops
applying the moment the business grows past the threshold, and a documented reliance is
easier to revisit than an unexplained silence. if crosscode ever employs anyone or takes
revenue, this section is the thing to re-check.

we keep the underlying records anyway (notices received, actions taken, dates) because
`docs/abuse-handling.md` requires it and because the count is the first thing anyone will ask
for. see that runbook for the retention period.

## deferred: eu legal representative (article 13)

article 13 requires a provider that is not established in the eu but offers services there to
**designate a legal or natural person in a member state as its legal representative**, and to
notify their details to that member state's digital services coordinator.

**we have not done this, and the decision is deliberate.** designating a representative means
a paid service provider in an eu state and an ongoing cost, for a free side project
with no eu user base to speak of. the provider has accepted that exposure knowingly rather
than overlooked it.

<!-- LAWYER: Art. 13 has no micro-enterprise exemption, unlike Art. 15 and the Section 3
     obligations, it applies on its face to every non-EU provider offering services in the
     EU, and the representative can be held liable for non-compliance. The judgement being
     made is a risk one (enforcement against a free, no-revenue, sub-100-user project is
     unlikely) rather than a legal one. Confirm that framing, and confirm the trigger for
     revisiting it: first paying EU user, or first EU enforcement contact, whichever is
     first. -->

## what this page is not

it is not a route for copyright takedowns under us law. those go to `legal@getcrosscode.dev`
and are described in [copyright and dmca](/docs/dmca.html). it is not support:
`support@getcrosscode.dev` is for that. it is not security disclosure:
`security@getcrosscode.dev` and
[SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md) are for that.

crosscode is a coordination service, not a public platform. there is no feed, no public
content, no recommender system, and no advertising, so the dsa obligations attached to online
platforms and to very large ones do not apply. what does apply is what is on this page.

## before this takes effect

- `{{PROVIDER_NAME}}`: the legal name of the individual provider.
- `{{PROVIDER_ADDRESS}}`: the postal address for legal notices.
- `{{EFFECTIVE_DATE}}`: the date this page takes effect.
- confirm the **art. 15(2) micro-enterprise exemption** still holds on the effective date.
- confirm the **art. 13 legal representative** deferral is still the decision, and record the
  trigger for revisiting it.
