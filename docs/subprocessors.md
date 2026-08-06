# Subprocessors

> **Draft.** Not yet in force. See the checklist at the end.

Everyone who processes data on Crosscode's behalf, what they get, and where it sits. This
page is the authoritative list referenced by the [Privacy Policy](./privacy-policy.md) and
the [Data Processing Agreement](./dpa.md).

Six vendors. There is no seventh: the docs site loads no fonts, no CDN scripts and no
third-party tags, and the only external hostname anywhere in its HTML is `github.com`.

Effective from {{EFFECTIVE_DATE}}.

## The list

| Subprocessor | What it does for Crosscode | Data it can access | Where it runs | Transfer mechanism |
| --- | --- | --- | --- | --- |
| **Vercel Inc.** | Hosts the website and the serverless API. Everything passes through it in transit | All request and response data in transit, including file contents; server logs including IP addresses | United States (`iad1`, plus edge) | [Vercel DPA](https://vercel.com/legal/dpa), EU SCCs; Vercel is EU–US Data Privacy Framework certified |
| **Supabase Inc.** | Postgres database and authentication | Everything stored: file contents and paths, account records, project and invite records, device-code rows, email addresses, password hashes, GitHub identities, sessions; automated backups | **Canada**, AWS `ca-central-1`, Montréal | [Supabase DPA](https://supabase.com/legal/dpa), EU SCCs, plus the EU adequacy decision for Canadian commercial organisations |
| **GitHub, Inc.** (Microsoft) | OAuth identity provider; hosts the public repository and the uptime workflow | Your GitHub account identity; the repository-access check at invite redemption is made against GitHub with your own OAuth token | United States | [GitHub DPA](https://github.com/customer-terms/github-data-protection-agreement), EU SCCs; Microsoft is Data Privacy Framework certified |
| **PostHog, Inc.** | Product analytics | Server-side: seven named events keyed on your Supabase user id, with at most a file-version count and a new-user flag. Website: four page events with no account id and no persistent identifier. No file contents, no paths, no branch or repository names, no email, no GitHub login | United States (`us.i.posthog.com`) | [PostHog DPA](https://posthog.com/dpa), EU SCCs |
| **Functional Software, Inc. (Sentry)** | Error monitoring | Route template, HTTP method, status, platform request id, a redacted error message, and stack frames from Crosscode's own code by basename. Request bodies, headers, cookies and environment are never sent | United States (`ingest.us.sentry.io`) | [Sentry DPA](https://sentry.io/legal/dpa/), EU SCCs |
| **npm, Inc.** (GitHub / Microsoft) | Distributes the `crosscode-cli` package | Nothing about you. Download requests carry an IP address and a user agent to npm, as any package install does | United States | Covered by the GitHub/Microsoft terms above |

**Sub-subprocessors.** Vercel and Supabase each run on AWS and front their endpoints with
Cloudflare, and both use their own further subprocessors. Their DPAs and subprocessor lists
govern those; Crosscode does not contract with them directly.

## Notable, because people ask

- **No AI or model provider is on this list, and none will be added without notice.**
  Crosscode has no AI features and holds no model provider credentials. Your code is never
  sent to a model provider by the hosted service. The only agent involved is the one
  already running on your machine, reading your files locally.
- **No advertising, marketing, session-recording or support-desk vendor.** No CRM, no chat
  widget, no email marketing platform. Support runs on GitHub issues and one mailbox.
- **No payment processor**, because Crosscode is free and collects no payment details.
- **Vercel and Supabase are the two that matter.** They are the only subprocessors that can
  reach your file contents. The other four cannot.

## Changes

Adding or replacing a subprocessor is a change to what happens to your data, so:

- **30 days' advance notice** before a new subprocessor starts processing. Notice goes to
  account holders by email and appears as a dated entry in the change log below. Every
  version of this page is in the repository's Git history.
- **Emergency replacement.** If a vendor fails or has to be dropped for a security reason,
  we may act sooner. You get told what changed and why within 3 business days.

### How to object

Reply to the notice, or write to **privacy@getcrosscode.dev**, before the 30 days are up.
Say which subprocessor and why.

We will explain the choice and look for an alternative. If there isn't one you can live
with, you can stop syncing and ask for deletion under §9 of the
[Privacy Policy](./privacy-policy.md). The service is free, so there is nothing to refund
and nothing holding you to it. Objecting does not entitle you to have the vendor removed;
it entitles you to a straight answer and a clean exit.

## Change log

| Date | Change |
| --- | --- |
| {{EFFECTIVE_DATE}} | Initial list published. |

## Before this takes effect

- `{{EFFECTIVE_DATE}}`: the date this list is first published, in two places on this page.
- Confirm each vendor's DPA link still resolves and that the account is on terms that
  incorporate it. Several require signing or accepting the DPA in the vendor dashboard
  rather than it applying automatically.
- Confirm the Vercel deployment region. `iad1` is Vercel's default for new projects and
  matches the deployment, but it is a dashboard setting rather than something this
  repository pins.
