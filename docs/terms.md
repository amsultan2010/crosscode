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
accounts and projects it manages.

They do **not** govern the Crosscode software itself. The CLI, the daemon, and the MCP
server are published under the MIT Licence, and that licence is the only thing that applies
to your copy of them. You may read, modify, fork, and self-host them, with no obligation to
us. There is no supported self-hosted deployment of the coordination service.

## 2. What the service does

Crosscode syncs uncommitted working-tree files between separate Git checkouts of the same
repository. A daemon runs on your machine, watches your checkout, and sends a settled edit
to the other checkouts on the same branch, where it is written or merged into the working
tree. The hosted service relays those changes and holds the state that makes a project a
project: accounts, memberships, invite codes, and about seven days of change history.

Two properties of the design are worth stating in the terms themselves, because they limit
what we can do for you as much as what we can do to you:

- **We only ever touch uncommitted working-tree files.** Your commits, branches, index, and
  remotes are never modified, and nothing in Crosscode pushes anywhere.
- **We do not host your repository.** Your Git repository stays on your disk and on whatever
  Git host you already use. If you stop using Crosscode, your repository is unchanged.

## 3. Accounts and eligibility

You need an account to use the hosted service. Accounts are created by signing in with
GitHub; there is no separate password.

You must be at least 16 years old, or the age of digital consent in your country if that is
higher. Keep your credentials secret, and tell us promptly if you believe an account or a
device has been compromised. You are responsible for everything done with your credentials.

A project is one repository. Whoever creates it can invite others, and an invite can only be
redeemed by a GitHub account that already has access to that repository. A project member
can be removed, which takes effect on the next request their daemon makes.

## 4. Acceptable use

Do not use the service to:

- Break the law, infringe someone else's rights, or distribute material you have no right
  to distribute.
- Store or relay content whose purpose is to harm: malware, credential-harvesting kits, or
  material that is illegal to possess.
- Gain access to a project you were not invited to, or to another customer's data.
- Attack the service: denial of service, credential stuffing, scraping, probing for
  vulnerabilities outside a disclosure process, or working around rate limits or retention
  windows.
- Resell or sublicense access to the hosted service.

If you find a security vulnerability, report it under
[SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md) rather than
by opening a public issue. Good-faith security research on your own project is welcome
and is not a breach of this section.

## 5. Your content, and who owns it

**You own your code.** Nothing in these terms transfers any ownership of it. You grant us
only the narrow licence we need in order to run the service for you: to store the files you
sync and relay them to the other members of your project, for as long as you use it.

We also process the metadata a coordination service needs in order to route work: your
GitHub identity, project and replica identifiers, your repository as `owner/repo`, activity
timestamps, change sizes, and which paths you touched recently. We process it to run the
service, to keep it working, and to answer support requests. We do not sell it and we do
not train models on it.

You are responsible for what you sync, including whether you are allowed to share a given
repository's contents with the other members of that project.

## 6. Encryption, and what it does not cover

Your files are encrypted in transit (TLS) and at rest, under keys we manage. **There is no
end-to-end encryption.** We can read the file contents we store, which means so can anyone
with production access on our side, and so could anyone who lawfully compels us.

We say that plainly rather than implying more:

- Do not sync a repository whose contents you are not willing to place with us on that
  basis. Crosscode is opt-in per checkout.
- Untracked files are never sent, and `.env*`, `*.pem`, `*.key`, and similar are never sent
  even when tracked.
- Your repository is the durable artifact throughout. If you stop, nothing of yours is lost.

[`docs/privacy.md`](/docs/privacy.html) is the current, detailed statement of what we hold,
and is incorporated into these terms by reference.

## 7. Price

The hosted service is currently free, with no paid plans, no seats, and no payment details
collected. If that changes we will give at least 30 days' notice by email before any charge
takes effect, and using the service after that means accepting the new terms.

Change history is retained for about seven days regardless. That is a technical limit of how
offline catch-up works, not a plan feature.

## 8. Suspension and termination

**You may stop at any time.** Run `crosscode stop`, delete the local state under your
repository's Git directory, and you are done.

**We may suspend or terminate** an account or a project that breaches section 4, or that
puts the service or other customers at risk. Except where the breach is serious enough that
waiting would cause harm, we will contact you first and give you a chance to fix it.

**On termination** of the hosted service for a project, we may delete its stored changes
and metadata after 30 days. Your repository, your commits, and your local
Crosscode state are unaffected, because they were never ours.

**We may discontinue the hosted service.** If we do, we will give at least 90 days' notice
by email. The CLI, daemon, and MCP server are MIT-licensed, so the software outlives us
running it.

## 9. Warranty disclaimer

The hosted service is provided "as is" and "as available", without warranties of any kind,
express or implied, including merchantability, fitness for a particular purpose, and
non-infringement. We do not warrant that the service will be uninterrupted, that changes
will always be delivered promptly, or that it is free of defects.

There is no service level agreement. Commitments of that kind exist only where a separate
written agreement says so.

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
If you do not, stop using it before it takes effect.

Every version of this page is in the repository's Git history, so what changed and when is
checkable rather than something you have to take on trust.

## 12. General

- **Governing law and venue:** [JURISDICTION].
- **Entire agreement:** these terms and the privacy documentation are
  the whole agreement between you and [LEGAL ENTITY NAME] about the hosted service, and
  replace anything said before.
- **Severability:** if a provision is unenforceable, the rest stays in force.
- **No waiver:** not enforcing a provision once does not waive it.
- **Assignment:** you may not assign these terms without our consent. We may assign them to
  a successor in a merger or an acquisition of substantially all our assets.

Questions about these terms go to [SUPPORT EMAIL]. See also the
[Support page](/docs/support.html).
