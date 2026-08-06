# Cookies and local storage

> **Draft.** Not yet in force. See the checklist at the end.

There is no cookie banner on this site, and this page still has to exist. The ePrivacy
Directive governs *any* storing of or access to information on your device — `localStorage`
and `sessionStorage` are covered exactly as cookies are — and disclosure is required even
where the item is strictly necessary and consent is not.

So: every item, what it is for, how long it lasts, and whether it needs your consent.

Effective from {{EFFECTIVE_DATE}}.

## What we set

| Name | Type | Set by | Purpose | Duration | Strictly necessary? |
| --- | --- | --- | --- | --- | --- |
| `sb-rzsslbmahvoesjxmgefr-auth-token` | `localStorage` | Supabase Auth (`@supabase/supabase-js`), on the sign-in, sign-up, reset, join and device pages | Holds your session and refresh token so you stay signed in across pages and can complete a CLI device sign-in | Until you sign out or the refresh token is revoked | **Yes.** Consent-exempt: without it there is no sign-in |
| `crosscode_analytics_once:<event>` | `sessionStorage` | `apps/docs-site/src/analytics.js` | Marks that a funnel event (`sign_up_started`, `sign_up_completed`) has already been counted in this tab, so two triggers do not count it twice | Until the browser tab is closed | **No.** See "Why there is no banner" below |
| `__cf_bm` | Cookie, on `supabase.co` | Cloudflare, in front of Supabase | Bot management on the auth API the sign-in pages call | 30 minutes | **Yes.** Set by Supabase's infrastructure, not by Crosscode, and not readable by this site |

That is the whole list. There is no analytics cookie, no advertising cookie, no
session-recording script, no chat widget, no CDN font, and no third-party tag: the only
external hostname in this site's HTML is `github.com`.

## What we used to set, and no longer do

`crosscode_distinct_id` — a random UUID in `localStorage` that gave each browser a stable
identity across visits, so PostHog could tell a returning visitor from a new one.

It has been removed. Website analytics events now go out with no persistent identifier,
which means they cannot be linked into a per-visitor history. It is a real loss of signal
and worth it on a site whose pitch is that we hold your code and would rather say so
plainly than track you around a page about it.

If you visited before the change, the old value may still be sitting in your browser's
local storage. Nothing reads it any more. Clearing site data removes it.

## Why there is no banner

Strictly necessary items are consent-exempt, so the auth token and `__cf_bm` need no
banner.

That leaves `crosscode_analytics_once:*`. It is a per-tab flag holding the string `"1"`; it
identifies nobody, carries no identifier, is deleted when the tab closes, and exists solely
to stop one event being counted twice.

<!-- LAWYER: the strict reading of Art. 5(3) ePrivacy is that only "strictly necessary for
     the service the user requested" is exempt, and a de-duplication flag for our own
     analytics is not that. The judgement here is that a per-tab "1" with no identifier is
     de minimis and a banner would be worse for users than the thing it consents to. If a
     regulator disagrees, the fix is small: drop the flag and accept double counting. -->

## Turning it off

- **Analytics:** any content blocker that blocks `us.i.posthog.com` stops the events. So
  does denying storage for this site — the code falls back and sends the event without the
  dedup flag rather than breaking. A build with no PostHog key installs no listeners and
  sends nothing at all, which is what a fork or a local `pnpm docs:dev` runs.
- **The auth token:** clearing site data signs you out. There is no way to stay signed in
  without it.
- **Do Not Track / Global Privacy Control:** not currently honoured as a signal. Stated
  because claiming otherwise without the code to back it would be worse.

## The CLI and daemon

Not a browser, no cookies. The CLI stores your session in
`<git-dir>/crosscode/config.json` at mode `0600`, preferring the OS keychain for the
refresh token where one exists (macOS `security`, Linux `secret-tool`). See the
[security model](/docs/safety.html).

## Related

- [Privacy Policy](./privacy-policy.md) — the complete Art. 13/14 notice
- [Privacy: what we can and can't see](./privacy.md) — the plain-language summary
- [Subprocessors](./subprocessors.md) — who else touches this data

## Before this takes effect

- `{{EFFECTIVE_DATE}}` — the date this page takes effect.
- Confirm the `crosscode_distinct_id` removal has actually shipped to production before
  publishing. This page describes the post-removal state.
- Resolve the `<!-- LAWYER -->` note above on `crosscode_analytics_once:*`.
- If the Supabase project ref ever changes, the auth token key name in the table changes
  with it — it is `sb-<project-ref>-auth-token`.
