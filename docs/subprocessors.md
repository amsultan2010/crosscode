# subprocessors

> **draft.** not yet in force. see the checklist at the end.

everyone who processes data on crosscode's behalf, what they get, and where it sits. this
page is the authoritative list referenced by the [privacy policy](./privacy-policy.md) and
the [data processing agreement](./dpa.md).

six vendors. there is no seventh: the docs site loads no fonts, no cdn scripts and no
third-party tags, and the only external hostname anywhere in its html is `github.com`.

effective from {{EFFECTIVE_DATE}}.

## the list

| subprocessor | what it does for crosscode | data it can access | where it runs | transfer mechanism |
| --- | --- | --- | --- | --- |
| **vercel inc.** | hosts the website and the serverless api. everything passes through it in transit | all request and response data in transit, including file contents; server logs including ip addresses | united states (`iad1`, plus edge) | [vercel dpa](https://vercel.com/legal/dpa), eu sccs; vercel is eu–us data privacy framework certified |
| **supabase inc.** | postgres database and authentication | everything stored: file contents and paths, account records, project and invite records, device-code rows, email addresses, password hashes, github identities, sessions; automated backups | **canada**, aws `ca-central-1`, montréal | [supabase dpa](https://supabase.com/legal/dpa), eu sccs, plus the eu adequacy decision for canadian commercial organisations |
| **github, inc.** (microsoft) | oauth identity provider; hosts the public repository and the uptime workflow | your github account identity; the repository-access check at invite redemption is made against github with your own oauth token | united states | [github dpa](https://github.com/customer-terms/github-data-protection-agreement), eu sccs; microsoft is data privacy framework certified |
| **posthog, inc.** | product analytics | server-side: seven named events keyed on your supabase user id, with at most a file-version count and a new-user flag. website: four page events with no account id and no persistent identifier. no file contents, no paths, no branch or repository names, no email, no github login | united states (`us.i.posthog.com`) | [posthog dpa](https://posthog.com/dpa), eu sccs |
| **functional software, inc. (sentry)** | error monitoring | route template, http method, status, platform request id, a redacted error message, and stack frames from crosscode's own code by basename. request bodies, headers, cookies and environment are never sent | united states (`ingest.us.sentry.io`) | [sentry dpa](https://sentry.io/legal/dpa/), eu sccs |
| **npm, inc.** (github / microsoft) | distributes the `crosscode-cli` package | nothing about you. download requests carry an ip address and a user agent to npm, as any package install does | united states | covered by the github/microsoft terms above |

**sub-subprocessors.** vercel and supabase each run on aws and front their endpoints with
cloudflare, and both use their own further subprocessors. their dpas and subprocessor lists
govern those; crosscode does not contract with them directly.

## notable, because people ask

- **no ai or model provider is on this list, and none will be added without notice.**
  crosscode has no ai features and holds no model provider credentials. your code is never
  sent to a model provider by the hosted service. the only agent involved is the one
  already running on your machine, reading your files locally.
- **no advertising, marketing, session-recording or support-desk vendor.** no crm, no chat
  widget, no email marketing platform. support runs on github issues and one mailbox.
- **no payment processor**, because crosscode is free and collects no payment details.
- **vercel and supabase are the two that matter.** they are the only subprocessors that can
  reach your file contents. the other four cannot.

## changes

adding or replacing a subprocessor is a change to what happens to your data, so:

- **30 days' advance notice** before a new subprocessor starts processing. notice goes to
  account holders by email and appears as a dated entry in the change log below. every
  version of this page is in the repository's git history.
- **emergency replacement.** if a vendor fails or has to be dropped for a security reason,
  we may act sooner. you get told what changed and why within 3 business days.

### how to object

reply to the notice, or write to **privacy@getcrosscode.dev**, before the 30 days are up.
say which subprocessor and why.

we will explain the choice and look for an alternative. if there isn't one you can live
with, you can stop syncing and ask for deletion under §9 of the
[privacy policy](./privacy-policy.md). the service is free, so there is nothing to refund
and nothing holding you to it. objecting does not entitle you to have the vendor removed;
it entitles you to a straight answer and a clean exit.

## change log

| date | change |
| --- | --- |
| {{EFFECTIVE_DATE}} | initial list published. |

## before this takes effect

- `{{EFFECTIVE_DATE}}`: the date this list is first published, in two places on this page.
- confirm each vendor's dpa link still resolves and that the account is on terms that
  incorporate it. several require signing or accepting the dpa in the vendor dashboard
  rather than it applying automatically.
- confirm the vercel deployment region. `iad1` is vercel's default for new projects and
  matches the deployment, but it is a dashboard setting rather than something this
  repository pins.
