# Copyright and DMCA

Crosscode's hosted coordination service stores files that users choose to sync. If you
believe something stored there infringes your copyright, this page is how you tell us, and
what we do about it.

> **Not yet in force.** The designated agent below has **not yet been registered** with the
> US Copyright Office. Until that registration exists, the §512(c) safe harbor does not
> attach, no matter what this page says. See
> [Before this takes effect](#before-this-takes-effect).

- **Effective date:** {{EFFECTIVE_DATE}}
- **Designated agent:** {{PROVIDER_NAME}}
- **Address for notices:** {{PROVIDER_ADDRESS}}
- **Email:** `legal@getcrosscode.dev`

## What this page covers, and what it does not

It covers **content users store on the hosted service**: the uncommitted working-tree files
their daemons publish, and the project and repository names attached to them. That is
material stored at a user's direction, which is what 17 U.S.C. §512(c) is about.

It does **not** cover Crosscode's own software. The CLI, daemon, and MCP server are ours and
are published under the MIT Licence. A complaint about that code is an ordinary dispute with
us, not a takedown request, and belongs at `legal@getcrosscode.dev` in plain prose.

It also does not reach copies we never had. Crosscode syncs between checkouts; every member
of a project holds a full Git repository on their own disk. Removing content from our
service removes it from our service. It cannot un-copy what someone already cloned. We would
rather say that here than let a notice-sender believe otherwise.

## How to send a notice

Email `legal@getcrosscode.dev`, or post to the address above. A notice must include all six
elements that §512(c)(3)(A) requires. A notice missing any of them is not a valid notice, and
we will tell you which element is missing rather than ignoring it.

1. **A signature** (physical or electronic) of the copyright owner, or of a person
   authorised to act for them.
2. **Identification of the copyrighted work** you say is infringed. If several works on the
   same project are covered, a representative list is enough.
3. **Identification of the infringing material**, with enough detail for us to find it. For
   Crosscode that means: the repository as `owner/repo`, the branch, and the file paths. We
   store changes keyed on exactly those three things, so a notice giving them is one we can
   act on and a notice without them usually is not.
4. **Your contact details**: address, telephone number, and email.
5. **A statement** that you believe in good faith that the use is not authorised by the
   copyright owner, its agent, or the law.
6. **A statement that the information in the notice is accurate**, and (under penalty of
   perjury) that you are the owner or are authorised to act for them.

Misrepresenting that material is infringing carries liability for damages under §512(f). We
mention it because it is a real provision, not to discourage a genuine notice.

## What we do when a notice arrives

- **We acknowledge receipt by email**, to the address in the notice.
- **We act expeditiously.** In practice: a valid notice is assessed and access to the
  identified material disabled **within 3 business days** of receipt. Crosscode is run by one
  person, and 3 business days is what one person can honestly commit to; if a notice arrives
  during an absence long enough to break that, the acknowledgement will say so.
- **We notify the affected user** with the reason, the material affected, and a copy of the
  notice, and we tell them how to counter-notify.
- **We record a strike** against the account.
- **We keep the notice, our decision, and the dates**, so a pattern of repeat infringement is
  something we can actually establish rather than assert.

The internal procedure is written down in `docs/abuse-handling.md` in the repository,
including where it is currently thin. An undocumented procedure is one that fails the first
time it is needed.

## Counter-notice

If your content was removed and you believe that was a mistake or a misidentification, send a
counter-notice to `legal@getcrosscode.dev`. Under §512(g)(3) it must contain:

1. **Your signature**, physical or electronic.
2. **Identification of the material** that was removed, and where it was before removal:
   again `owner/repo`, branch, and paths.
3. **A statement under penalty of perjury** that you have a good-faith belief the material
   was removed as a result of mistake or misidentification.
4. **Your name, address, and telephone number**, plus your consent to the jurisdiction of the
   US Federal District Court for the district of your address (or, if your address is
   outside the United States, of any district in which we may be found) and your consent to
   accept service of process from the person who sent the original notice.

On receiving a valid counter-notice we forward it to the original complainant and tell them
we will restore the material in **not less than 10 and not more than 14 business days**,
unless they first tell us they have filed a court action seeking to restrain the activity.
That window is statutory, not a policy of ours, and we cannot shorten it.

<!-- LAWYER: §512(g) restoration assumes the material still exists to restore. Change
     history is pruned after about 7 days, so by the end of a 10-14 business day window the
     removed changes are gone regardless of the outcome. The counter-notifier's working tree
     still holds their own work, so nothing of theirs is actually lost, but the sentence
     "we will restore" may need rewording to "we will re-enable syncing for" to stay
     accurate. Confirm the phrasing. -->

## Repeat infringers

We terminate the accounts of repeat infringers in appropriate circumstances, as §512(i)
requires. Concretely:

- A **strike** is recorded when we disable access to content in response to a valid notice
  that is not withdrawn and not reversed by a counter-notice.
- **Three strikes** against one account, or a single deliberate and clear-cut infringement,
  results in termination of that account and of the projects it owns.
- A strike is removed if the notice behind it is withdrawn, if a counter-notice restores the
  material and the complainant does not sue, or if we conclude the notice was wrong.
- **Terminated means terminated**: the account and its projects are deleted, not suspended
  pending appeal. You may write to `legal@getcrosscode.dev` to contest it, and we will
  answer.

A project's owner is accountable for content their project stores, but a strike attaches to
the account that published the change, because that is what our change log records.

## Registration: an owner action, not a code change

Two of the four things §512(c) requires cannot be done by editing this repository. They are
the ones providers most often skip, and skipping either means the safe harbor never attaches
at all:

1. **Register the designated agent** with the US Copyright Office at
   <https://www.copyright.gov/dmca-directory/>. It costs about $6 and takes half an hour. It
   requires a **public physical address**. The address in the directory is published, so it
   must be one you are willing to have on a public register.
2. **Renew it every three years.** The registration expires. An **expired registration is
   legally identical to no registration**, and the expiry is silent: nothing breaks, no
   deploy fails, no alert fires. A provider who registered once and forgot is a provider with
   no safe harbor, and that is the usual way it is lost.

Publishing this page satisfies the second requirement of §512(c) (the agent's contact
information must be available on the service). Having a repeat-infringer policy and acting on
notices are the other two, and they are only real if the procedure in
`docs/abuse-handling.md` is actually followed.

## Before this takes effect

- `{{PROVIDER_NAME}}`: the legal name of the individual provider, matching the name filed
  with the Copyright Office.
- `{{PROVIDER_ADDRESS}}`: the public postal address for legal notices, matching the address
  filed with the Copyright Office.
- `{{EFFECTIVE_DATE}}`: the date this page takes effect. Set it no earlier than the date the
  Copyright Office registration is confirmed.
- **Register the designated agent** at <https://www.copyright.gov/dmca-directory/>, and put a
  calendar reminder **three years out** for renewal.
- **Remove the "Not yet in force" banner** at the top of this page once the registration is
  confirmed.
