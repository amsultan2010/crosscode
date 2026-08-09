# cookies and local storage

> **draft.** not yet in force. see the checklist at the end.

there is no cookie banner on this site, and this page still has to exist. the eprivacy
directive governs *any* storing of or access to information on your device (`localStorage`
and `sessionStorage` are covered exactly as cookies are) and disclosure is required even
where the item is strictly necessary and consent is not.

so: every item, what it is for, how long it lasts, and whether it needs your consent.

effective from {{EFFECTIVE_DATE}}.

## what we set

| name | type | set by | purpose | duration | strictly necessary? |
| --- | --- | --- | --- | --- | --- |
| `sb-rzsslbmahvoesjxmgefr-auth-token` | `localStorage` | supabase auth (`@supabase/supabase-js`), on the sign-in, sign-up, reset, join and device pages | holds your session and refresh token so you stay signed in across pages and can complete a cli device sign-in | until you sign out or the refresh token is revoked | **yes.** consent-exempt: without it there is no sign-in |
| `crosscode_analytics_once:<event>` | `sessionStorage` | `apps/docs-site/src/analytics.js` | marks that a funnel event (`sign_up_started`, `sign_up_completed`) has already been counted in this tab, so two triggers do not count it twice | until the browser tab is closed | **no.** see "why there is no banner" below |
| `__cf_bm` | cookie, on `supabase.co` | cloudflare, in front of supabase | bot management on the auth api the sign-in pages call | 30 minutes | **yes.** set by supabase's infrastructure, not by crosscode, and not readable by this site |

that is the whole list. there is no analytics cookie, no advertising cookie, no
session-recording script, no chat widget, no cdn font, and no third-party tag: the only
external hostname in this site's html is `github.com`.

## what we used to set, and no longer do

`crosscode_distinct_id` was a random uuid in `localStorage` that gave each browser a stable
identity across visits, so posthog could tell a returning visitor from a new one.

it has been removed. website analytics events now go out with no persistent identifier,
which means they cannot be linked into a per-visitor history. it is a real loss of signal
and worth it on a site whose pitch is that we hold your code and would rather say so
plainly than track you around a page about it.

if you visited before the change, the old value may still be sitting in your browser's
local storage. nothing reads it any more. clearing site data removes it.

## why there is no banner

strictly necessary items are consent-exempt, so the auth token and `__cf_bm` need no
banner.

that leaves `crosscode_analytics_once:*`. it is a per-tab flag holding the string `"1"`; it
identifies nobody, carries no identifier, is deleted when the tab closes, and exists solely
to stop one event being counted twice.

<!-- LAWYER: the strict reading of Art. 5(3) ePrivacy is that only "strictly necessary for
     the service the user requested" is exempt, and a de-duplication flag for our own
     analytics is not that. The judgement here is that a per-tab "1" with no identifier is
     de minimis and a banner would be worse for users than the thing it consents to. If a
     regulator disagrees, the fix is small: drop the flag and accept double counting. -->

## turning it off

- **analytics:** any content blocker that blocks `us.i.posthog.com` stops the events. so
  does denying storage for this site. the code falls back and sends the event without the
  dedup flag rather than breaking. a build with no posthog key installs no listeners and
  sends nothing at all, which is what a fork or a local `pnpm docs:dev` runs.
- **the auth token:** clearing site data signs you out. there is no way to stay signed in
  without it.
- **do not track / global privacy control:** not currently honoured as a signal. stated
  because claiming otherwise without the code to back it would be worse.

## the cli and daemon

not a browser, no cookies. the cli stores your session in
`<git-dir>/crosscode/config.json` at mode `0600`, preferring the os keychain for the
refresh token where one exists (macos `security`, linux `secret-tool`). see the
[security model](/docs/safety.html).

## related

- [privacy policy](./privacy-policy.md): the complete art. 13/14 notice
- [privacy: what we can and can't see](./privacy.md): the plain-language summary
- [subprocessors](./subprocessors.md): who else touches this data

## before this takes effect

- `{{EFFECTIVE_DATE}}`: the date this page takes effect.
- confirm the `crosscode_distinct_id` removal has actually shipped to production before
  publishing. this page describes the post-removal state.
- resolve the `<!-- LAWYER -->` note above on `crosscode_analytics_once:*`.
- if the supabase project ref ever changes, the auth token key name in the table changes
  with it: it is `sb-<project-ref>-auth-token`.
