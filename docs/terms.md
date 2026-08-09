# terms of service

> **before this takes effect:** set `{{EFFECTIVE_DATE}}`, put the provider's legal name in
> `{{PROVIDER_NAME}}` and a postal address for notices in `{{PROVIDER_ADDRESS}}`, and choose
> `{{JURISDICTION}}` for governing law and venue. decide separately whether the optional
> arbitration block in section 14 is switched on. full checklist at the bottom of this page.

- **effective date:** {{EFFECTIVE_DATE}}
- **provider:** {{PROVIDER_NAME}} ("we", "us"), an individual operating crosscode as a sole
  proprietor and the operator of crosscode. there is no company behind it.
- **address for legal notices:** {{PROVIDER_ADDRESS}}
- **governing law:** {{jurisdiction}}
- **contact:** support@getcrosscode.dev

## 1. what these terms cover

these terms govern your use of the **hosted crosscode coordination service**, reachable at
`https://www.getcrosscode.dev` and the api under `/v1/`, together with the website and the
accounts and projects it manages.

they do **not** govern the crosscode software itself. the cli, the daemon, and the mcp
server are published under the mit licence, and that licence is the only thing that applies
to your copy of them. you may read, modify, fork, and self-host them, with no obligation to
us. there is no supported self-hosted deployment of the coordination service.

## 2. what the service does

crosscode syncs uncommitted working-tree files between separate git checkouts of the same
repository. a daemon runs on your machine, watches your checkout, and sends a settled edit
to the other checkouts on the same branch, where it is written or merged into the working
tree. the hosted service relays those changes and holds the state that makes a project a
project: accounts, memberships, invite codes, and about seven days of change history.

two properties of the design are worth stating in the terms themselves, because they limit
what we can do for you as much as what we can do to you:

- **we only ever touch uncommitted working-tree files.** your commits, branches, index, and
  remotes are never modified, and nothing in crosscode pushes anywhere.
- **we do not host your repository.** your git repository stays on your disk and on whatever
  git host you already use. if you stop using crosscode, your repository is unchanged.

## 3. accounts and eligibility

you need an account to use the hosted service. you can create one by signing in with github,
or with an email address and a password.

you must be at least 16 years old, or the age of digital consent in your country if that is
higher. keep your credentials secret, and tell us promptly if you believe an account or a
device has been compromised. you are responsible for everything done with your credentials.

**sanctions and export control.** you may not create or use an account if you are resident
in, or ordinarily located in, a country or territory subject to comprehensive us or uk
trade sanctions, or if you are on a restricted-party list such as the us treasury's
specially designated nationals list. you confirm you are not, and you agree not to use the
service on behalf of anyone who is. if we learn otherwise we will terminate the account.

a project is one repository. whoever creates it can invite others, and an invite can only be
redeemed by a github account that already has access to that repository. a project member
can be removed, which takes effect on the next request their daemon makes.

<!-- LAWYER: sanctions screening here is contractual only, no automated screening is
implemented. Decide whether that is acceptable at this scale or whether the clause should
be softened to match. -->

## 4. acceptable use

do not use the service to:

- break the law, infringe someone else's rights, or distribute material you have no right
  to distribute.
- store or relay content whose purpose is to harm: malware, credential-harvesting kits, or
  material that is illegal to possess.
- store or relay child sexual abuse material, content that incites violence or terrorism, or
  content that is unlawful to distribute where you or we are located.
- gain access to a project you were not invited to, or to another customer's data.
- attack the service: denial of service, credential stuffing, scraping, probing for
  vulnerabilities outside a disclosure process, or working around rate limits or retention
  windows.
- resell or sublicense access to the hosted service.
- export, re-export, or transfer the service or anything obtained through it in breach of
  applicable sanctions or export control law, or make it available to a person restricted
  under section 3.

**how this is enforced.** we do not scan, index, or read synced file contents to police this
section. there is no automated content moderation and no proactive review; the only way we
learn of prohibited content is a report from a person. when we receive one we look at what
is reported, and nothing else. if we act, we do the narrowest thing that fixes it: removing
or disabling access to specific content, suspending a project, or terminating an account
under section 8. we tell the affected user what we did and why, on the terms in section 8.

**reporting.** report illegal content, including content you believe breaches this section,
to abuse@getcrosscode.dev. copyright complaints have their own route in section 9. our eu
digital services act contact point and the details of what a report should contain are on
the [dsa contact page](/docs/dsa-contact.html).

if you find a security vulnerability, report it under
[SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md) rather than
by opening a public issue. good-faith security research on your own project is welcome
and is not a breach of this section.

## 5. your content, and who owns it

**you own your code.** nothing in these terms transfers any ownership of it. you grant us
only the narrow licence we need in order to run the service for you: to store the files you
sync and relay them to the other members of your project, for as long as you use it.

we also process the metadata a coordination service needs in order to route work: your
github identity, project and replica identifiers, your repository as `owner/repo`, activity
timestamps, change sizes, and which paths you touched recently. we process it to run the
service, to keep it working, and to answer support requests. we do not sell it and we do
not train models on it.

you are responsible for what you sync, including whether you are allowed to share a given
repository's contents with the other members of that project.

**data processing.** where you sync files containing personal data and data protection law
makes you the controller of it, we act as your processor. the
[data processing addendum](/docs/dpa.html) sets out that arrangement, and it is incorporated
into these terms by reference and applies without a separate signature. if you need a signed
copy or a different set of terms, write to legal@getcrosscode.dev.

**feedback.** if you send us an idea, a feature request, or a bug report (in a github
issue, by email, or anywhere else) we may use it, build it, and ship it without owing you
anything and without any obligation of confidence. you keep whatever rights you already had;
you simply do not gain a claim against us because we built something you suggested.

## 6. encryption, and what it does not cover

your files are encrypted in transit (tls) and at rest, under keys we manage. **there is no
end-to-end encryption.** we can read the file contents we store, which means so can anyone
with production access on our side, and so could anyone who lawfully compels us.

we say that plainly rather than implying more:

- do not sync a repository whose contents you are not willing to place with us on that
  basis. crosscode is opt-in per checkout.
- untracked files are never sent, and tracked files matching a hard denylist (`.env*`,
  `.envrc`, `.npmrc`, `.netrc`, `credentials`, `secrets`, ssh private keys, and
  `.pem`/`.key`/`.p12`/`.pfx`/`.jks`/`.keystore` files) are dropped before a change is
  captured. the list itself is in `packages/core/src/index.ts`, so it is checkable.
- your repository is the durable artifact throughout. if you stop, nothing of yours is lost.

the documents that describe this in detail are incorporated into these terms by reference:

- [`docs/privacy.md`](/docs/privacy.html): the plain-language statement of what we hold and
  what we can see.
- [privacy policy](/docs/privacy-policy.html): the formal notice, including your rights and
  the legal bases we rely on.
- [cookies](/docs/cookies.html) and [subprocessors](/docs/subprocessors.html): what is set
  in your browser, and which third parties process data on our behalf.

## 7. price

the hosted service is currently free, with no paid plans, no seats, and no payment details
collected. if that changes we will give at least 30 days' notice by email before any charge
takes effect, and using the service after that means accepting the new terms.

change history is retained for about seven days regardless. that is a technical limit of how
offline catch-up works, not a plan feature.

## 8. suspension and termination

**you may stop at any time.** run `crosscode stop`, delete the local state under your
repository's git directory, and you are done.

**we may suspend or terminate** an account or a project that breaches section 4, or that
puts the service or other customers at risk. except where the breach is serious enough that
waiting would cause harm, we will contact you first and give you a chance to fix it.

**repeat infringers.** we terminate, in appropriate circumstances, the accounts of users who
repeatedly infringe copyright. in practice: a complaint under section 9 that we act on is
recorded against the account. two recorded complaints get a warning; a third gets the
account terminated and its projects deleted. a complaint you successfully counter-notify, or
that we determine is invalid, is not recorded. we may terminate sooner where the infringement
is flagrant.

**we tell you why.** if we remove content, disable access to it, suspend a project, or
terminate an account, we will email the affected account with: what we did, what content or
account it affected, why (including which part of section 4 or which report it rests on and
whether the decision was based on a report or on our own assessment) that no automated
decision-making was involved, and how to contest it. you can contest any such decision by
replying to that email or writing to legal@getcrosscode.dev, and a human will look at it
again. we will not send the notice where the law forbids it, such as where doing so would
prejudice an ongoing criminal investigation.

**on termination** of the hosted service for a project, we may delete its stored changes
and metadata after 30 days. your repository, your commits, and your local
crosscode state are unaffected, because they were never ours.

**we may discontinue the hosted service.** if we do, we will give at least 90 days' notice
by email. the cli, daemon, and mcp server are mit-licensed, so the software outlives us
running it.

## 9. copyright complaints

if you own copyright in material that is being stored or relayed through the hosted service
without permission, send a notice to legal@getcrosscode.dev. it needs to identify the work,
identify what you want removed precisely enough for us to find it, give your contact details,
state that you believe in good faith that the use is not authorised, state that the notice is
accurate and that you are authorised to act for the owner, and be signed. notices that leave
these out are not effective and we may not act on them.

the full procedure, including how to file a counter-notice if your content was removed and
what happens to your project while a complaint is open, is on the
[dmca page](/docs/dmca.html). accounts that attract repeated complaints are terminated under
section 8.

knowingly filing a false notice or counter-notice carries liability for damages under 17
u.s.c. §512(f), and we will pass on what a court orders us to.

## 10. warranty disclaimer

the hosted service is provided "as is" and "as available", without warranties of any kind,
express or implied, including merchantability, fitness for a particular purpose, and
non-infringement. we do not warrant that the service will be uninterrupted, that changes
will always be delivered promptly, or that it is free of defects.

**crosscode is software run as a side project.** the current release is 0.1.3. the
protocol, the cli's commands and flags, the data we store, and the service itself can change
or break between releases without notice, and features can be withdrawn. treat it as beta
and do not put anything on it that cannot survive it going away.

there is no service level agreement. commitments of that kind exist only where a separate
written agreement says so.

crosscode is a coordination layer, not a backup, not a version control system, and not a
substitute for one. git is your source of truth. keep your own copies.

## 11. limitation of liability

to the maximum extent the law allows:

- neither party is liable for indirect, incidental, special, consequential, or punitive
  damages, or for lost profits, lost revenue, or lost data, even if advised that they were
  possible.
- our total liability arising out of or relating to the hosted service is capped at the
  greater of the amounts you paid us for it in the 12 months before the claim, or 50 us
  dollars.

nothing here excludes liability that cannot lawfully be excluded, including for fraud or
for death or personal injury caused by negligence. some jurisdictions do not allow some of
these exclusions, in which case they apply only as far as that jurisdiction permits.

the mit licence carries its own warranty disclaimer for the software, and it is unaffected
by this section.

## 12. your indemnity

you will defend us against any third-party claim arising out of the content you sync through
the hosted service, your use of the service, or your breach of these terms, and you will
pay the damages, costs, and legal fees finally awarded against us or agreed in a settlement
you approve. that covers, in particular, a claim that something you synced infringes
someone's copyright or other rights, and a claim that you shared a repository's contents
with people who were not entitled to see them.

we will tell you about the claim promptly, let you control the defence of it, and help you
where you reasonably ask. we will not settle a claim in a way that admits fault on your
behalf without your agreement.

this section does not apply where the claim arises from our own breach of these terms, and
nothing in it requires you to pay for a liability the law says cannot be shifted to you. if
you are a consumer rather than a business, this section applies only to the extent the law
where you live permits.

## 13. changes to these terms

we may change these terms. for a material change, we will give at least 30 days' notice by
email to the address on your account and by updating the effective date at the top of this
page. continuing to use the hosted service after a change takes effect means you accept it.
if you do not, stop using it before it takes effect.

every version of this page is in the repository's git history, so what changed and when is
checkable rather than something you have to take on trust.

## 14. general

**talk to us first.** if you have a dispute with us, email legal@getcrosscode.dev describing
it and what you want, and give us 30 days to sort it out. most things end here. neither side
may start proceedings about a dispute before that 30 days is up, except to seek an
injunction or to protect intellectual property.

**notice.** we give you notice by email to the address on your account, and it counts as
received the day it is sent. you give us notice by email to legal@getcrosscode.dev, and for
notices the law requires in writing, also by post to {{PROVIDER_ADDRESS}}. notice by post
counts as received five business days after posting. keep the email address on your account
current; notice sent to a stale address still counts.

**force majeure.** neither side is liable for a delay or failure caused by something outside
its reasonable control: an outage at an upstream provider, a network or power failure, war,
civil unrest, natural disaster, epidemic, strike, or a legal or governmental order. this does
not excuse paying money that is owed. if such an event stops the service for more than 30
days, either side may terminate.

**governing law and venue:** {{jurisdiction}}. if you are a consumer, this does not take away
the protection of the mandatory law of the country you live in, or your right to bring a
claim in its courts.

**entire agreement:** these terms, the privacy documentation, and the dpa are the whole
agreement between you and {{PROVIDER_NAME}} about the hosted service, and replace anything
said before.

**severability:** if a provision is unenforceable, the rest stays in force.

**no waiver:** not enforcing a provision once does not waive it.

**assignment:** you may not assign these terms without our consent. we may assign them to
a successor in a merger or an acquisition of substantially all our assets, or to a company
formed to take over the operation of crosscode.

**third parties:** no one other than you and us has any right to enforce these terms.

### optional: arbitration and class-action waiver (not in force)

<!-- LAWYER: US only. This block is drafted but deliberately switched off. It is the
strongest anti-suit clause available in the US and is largely unenforceable against UK and
EU consumers, and {{JURISDICTION}} has not been chosen yet. Turn it on only if governing law
is a US state, and only after advice on notice and opt-out mechanics. To enable: delete this
comment and the "not in force" wording, and renumber into section 14 proper. -->

> the clause below is **not part of these terms** and does not apply to anyone. it is kept
> here so that what it would say is visible before it is ever switched on.

*if enabled:* any dispute not resolved by the informal process above would be settled by
binding individual arbitration rather than in court, under the rules of an established
arbitration provider, in the venue named in `{{JURISDICTION}}`. each side would waive a jury
trial. claims could be brought only individually, not as a class, collective, or
representative action, and an arbitrator could not consolidate claims. small-claims cases
could still go to court. you would have 30 days from first accepting these terms to opt out
of arbitration by emailing legal@getcrosscode.dev, without any effect on the rest of the
terms.

## before this takes effect

fill these in and delete the banner at the top of this page:

- `{{PROVIDER_NAME}}`: the provider's legal name, as an individual. appears in the header
  and in section 14.
- `{{PROVIDER_ADDRESS}}`: postal address for legal notices. appears in the header and in
  section 14.
- `{{JURISDICTION}}`: governing law and venue. appears in the header, in section 14, and in
  the optional arbitration block.
- `{{EFFECTIVE_DATE}}`: the date this page takes effect. appears in the header.

then decide whether the optional arbitration block in section 14 is switched on, and have a
lawyer read the whole page.

questions about these terms go to legal@getcrosscode.dev. everything else goes to
support@getcrosscode.dev. see the [support page](/docs/support.html).
