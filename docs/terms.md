# Terms of Service

> **Draft, not in force.** This document is a working draft awaiting review by a qualified
> lawyer. It describes the terms Crosscode intends to operate under, and it does not bind
> anyone yet. Placeholders in square brackets are unfilled. Do not rely on this page as a
> contract until this banner is gone and an effective date is set.

- **Effective date:** [EFFECTIVE DATE]
- **Provider:** [LEGAL ENTITY NAME] ("we", "us"), the operator of Crosscode
- **Governing law:** [JURISDICTION]
- **Contact:** [SUPPORT EMAIL]

## 1. What these terms cover

These terms govern your use of the **hosted Crosscode coordination service**, reachable at
`https://www.getcrosscode.dev` and the API under `/v1/`, together with the website and the
accounts, workspaces, and subscriptions it manages.

They do **not** govern the Crosscode software itself. The CLI, the daemon, and the MCP
server are published under the MIT Licence, and that licence is the only thing that applies
to your copy of them. You may read, modify, fork, and self-host them, with no obligation to
us. If you run your own coordination service, none of these terms apply to you: there is no
account and no subscription, and we are not in the loop at all.

## 2. What the service does

Crosscode coordinates people and coding agents working in separate Git checkouts of the
same repository. A daemon runs on your machine, watches your checkout, and captures settled
edits. The hosted service relays those records to the other checkouts in your workspace,
where they arrive as proposals a person or agent reviews before anything is written to
disk.

The service also holds the state that makes a workspace a workspace: accounts, memberships,
invite and pairing codes, roles, presence, tasks, claims, and the operation history your
plan's retention window covers.

Two properties of the design are worth stating in the terms themselves, because they limit
what we can do for you as much as what we can do to you:

- **We do not write to your files.** Remote work arrives as a proposal. Materializing it is
  an explicit act taken on your machine, by you or by an agent you configured. Workspace
  autonomy settings can automate that decision inside your own checkout, and they never
  move the decision to our side.
- **We do not host your repository.** Your Git repository stays on your disk and on
  whatever Git host you already use. If you stop using Crosscode, your repository is
  unchanged.

## 3. Accounts and eligibility

You need an account to use the hosted service. Accounts are created from the CLI
(`crosscode signup`) or on the website, and authenticate through Supabase Auth.

You must be at least 16 years old, or the age of digital consent in your country if that is
higher. You must give an email address you control, keep your credentials secret, and tell
us promptly if you believe an account or a device token has been compromised. You are
responsible for everything done with your credentials.

One account may create a limited number of workspaces (currently 10 self-serve workspaces
per account, plus the personal workspace provisioned automatically on first use). This is an
abuse ceiling, not a plan feature, and we may adjust it.

Workspaces have owners and members. A workspace owner controls its membership, its invite
and pairing codes, its autonomy tier, and its subscription. If you join a workspace you do
not own, the owner can remove you and revoke your device tokens, and both take effect on
the next request that credential makes.

## 4. Acceptable use

Do not use the service to:

- Break the law, infringe someone else's rights, or distribute material you have no right
  to distribute.
- Store or relay content whose purpose is to harm: malware, credential-harvesting kits, or
  material that is illegal to possess. We cannot read your file payloads (see section 6),
  so this is a rule you are trusted to keep rather than one we filter for.
- Gain access to a workspace you were not invited to, or to another customer's data.
- Attack the service: denial of service, credential stuffing, scraping, probing for
  vulnerabilities outside a disclosure process, or working around rate limits, seat caps,
  or retention windows.
- Resell or sublicense access to the hosted service, or use one paid workspace as shared
  infrastructure for parties who are not its members. Self-hosting exists for cases the
  hosted plans do not fit.

If you find a security vulnerability, report it under
[SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md) rather than
by opening a public issue. Good-faith security research on your own workspace is welcome
and is not a breach of this section.

## 5. Your content, and who owns it

**You own your code.** Nothing in these terms transfers any ownership of it, and you grant
us **no licence in it**. That is not generosity, it is a consequence of the design: the
file payloads we relay are encrypted before they reach us, so a licence to use them would
be a licence to use bytes we cannot read.

We do process the unencrypted metadata a coordination service needs in order to route work:
account email, workspace and device identifiers, your repository's Git remote URL, activity
timestamps, payload sizes, the kind of change each file underwent, and the task titles,
claim targets, intents, and validation output your workspace records. We process it to run
the service, to enforce your plan's limits, to keep an audit log, to bill you, and to
answer support requests. We do not sell it and we do not train models on it.

You are responsible for what you put into a workspace, including whether you are allowed to
share a given repository's contents with the other members of that workspace.

## 6. Encryption, and what it does not cover

File payloads are end to end encrypted by default. Contents, paths, diffs, and content
hashes are sealed on your machine under a workspace key that is generated on your machine
and never sent to us. We store ciphertext and relay it. We cannot decrypt it for you, for
ourselves, or for anyone who compels us to try.

The limits of that, stated plainly:

- **We cannot recover your history if you lose every copy of your key.** `crosscode key
  export` prints a recovery code. Keep it somewhere you trust. Losing the key costs you
  coordination history, not source code: your repository was on your disk the whole time.
- **Encryption does not hide everything.** The metadata listed in section 5 is in the
  clear, including your repository's Git remote URL and your task titles. If a repository's
  name or the description of what you are working on is itself confidential, self-host.
- **Task titles, claim targets, intents, and validation output are not encrypted yet.**
  These can contain file paths. We would rather say so than let "end to end encrypted"
  imply more coverage than it has today.

[`docs/privacy.md`](/docs/privacy.html) is the current, detailed statement of what is
visible to us, and is incorporated into these terms by reference.

## 7. Plans, billing, and renewal

Plan prices, seat caps, and retention windows are listed on the
[Refund policy](/docs/refund-policy.html) page, and the plan in force for a workspace is
readable at any time with `crosscode billing status`.

- **Subscriptions belong to the workspace, not to the person.** The billing owner recorded
  against a workspace is a label for receipts. If that member leaves, the role moves to the
  longest-tenured remaining owner and the subscription is untouched.
- **Payments are processed by Stripe.** We never see or store your card number. Stripe's
  own terms apply to the payment itself.
- **Subscriptions renew automatically** at the end of each period, monthly or annual as
  chosen, at the then-current price, until cancelled. Annual is the default and is twelve
  months for the price of ten.
- **The Team plan bills per active member.** Adding or removing a member changes the
  subscription quantity, and Stripe prorates the difference for the rest of the period.
- **Changing plan mid-period** moves the existing subscription in place, in either
  direction, prorated by Stripe. It does not start a second subscription.
- **Taxes** are your responsibility where they are not collected at checkout.
- **Price changes** apply from your next renewal, and we will give at least 30 days' notice
  by email before one takes effect.

Cancellation and refunds are covered by the [Refund policy](/docs/refund-policy.html),
which forms part of these terms.

## 8. Suspension and termination

**You may stop at any time.** Cancel with `crosscode billing cancel`, delete the local
state under your repository's Git directory, and you are done. Cancellation takes effect at
the end of the paid period.

**We may suspend or terminate** an account or a workspace that breaches section 4, that
puts the service or other customers at risk, or whose payment has failed past the grace
period described in the refund policy. Except where the breach is serious enough that
waiting would cause harm, we will contact you first and give you a chance to fix it.

**Nothing is destroyed by a plan change.** A downgrade, a cancellation, or a failed payment
costs a workspace a capability, never its data: members, history inside the window already
promised, replicas, device tokens, and settings all survive. A workspace over the seat cap
of its new plan keeps every existing member, and the next seat is refused.

**On termination** of the hosted service for a workspace, we may delete its stored
operations and metadata after 30 days. Your repository, your commits, and your local
Crosscode state are unaffected, because they were never ours.

**We may discontinue the hosted service.** If we do, we will give at least 90 days' notice
and refund the unused portion of any annual subscription. The CLI, daemon, and MCP server
are MIT-licensed and self-hostable, so the software outlives us running it.

## 9. Warranty disclaimer

The hosted service is provided "as is" and "as available", without warranties of any kind,
express or implied, including merchantability, fitness for a particular purpose, and
non-infringement. We do not warrant that the service will be uninterrupted, that proposals
will always be delivered promptly, or that it is free of defects.

There is no service level agreement on any self-serve plan. SLA commitments exist only
where a Team plan or a separate written agreement says so.

Crosscode is a coordination layer, not a backup, not a version control system, and not a
substitute for one. Git is your source of truth. Keep your own copies.

## 10. Limitation of liability

To the maximum extent the law allows:

- Neither party is liable for indirect, incidental, special, consequential, or punitive
  damages, or for lost profits, lost revenue, or lost data, even if advised that they were
  possible.
- Our total liability arising out of or relating to the hosted service is capped at the
  greater of the amounts you paid us for it in the 12 months before the claim, or 50 US
  dollars.

Nothing here excludes liability that cannot lawfully be excluded, including for fraud or
for death or personal injury caused by negligence. Some jurisdictions do not allow some of
these exclusions, in which case they apply only as far as that jurisdiction permits.

The MIT Licence carries its own warranty disclaimer for the software, and it is unaffected
by this section.

## 11. Changes to these terms

We may change these terms. For a material change, we will give at least 30 days' notice by
email to the address on your account and by updating the effective date at the top of this
page. Continuing to use the hosted service after a change takes effect means you accept it.
If you do not, cancel before it takes effect and the refund policy applies as written on
the day you cancel.

Every version of this page is in the repository's Git history, so what changed and when is
checkable rather than something you have to take on trust.

## 12. General

- **Governing law and venue:** [JURISDICTION].
- **Entire agreement:** these terms, the refund policy, and the privacy documentation are
  the whole agreement between you and [LEGAL ENTITY NAME] about the hosted service, and
  replace anything said before.
- **Severability:** if a provision is unenforceable, the rest stays in force.
- **No waiver:** not enforcing a provision once does not waive it.
- **Assignment:** you may not assign these terms without our consent. We may assign them to
  a successor in a merger or an acquisition of substantially all our assets.

Questions about these terms go to [SUPPORT EMAIL]. See also the
[Support page](/docs/support.html).
