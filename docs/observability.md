# Observability: errors, analytics, uptime

Crosscode had no error tracking, no product analytics and no uptime check. The hosted API
answered 500 on every route for an unknown length of time and we found out by running
`curl` by hand. This page describes what is now wired in and, below that, the ordered
checklist that turns it on.

Everything here is off until it is configured. No key, no network call.

| What | Where | Turned on by |
| --- | --- | --- |
| Service errors and 5xx responses | `apps/service/src/observability.ts`, hooked in `serverless.ts` and `main.ts` | `SENTRY_DSN` |
| Daemon crashes | `apps/daemon/src/observability.ts` | `CROSSCODE_ERROR_REPORTING=on` **and** `CROSSCODE_SENTRY_DSN` |
| Site analytics | `apps/docs-site/src/analytics.js` | `VITE_POSTHOG_KEY` at build time |
| Uptime check | `.github/workflows/uptime.yml` | Nothing. It runs every 5 minutes already |

## What is never sent

The service handles file contents, paths, patches, and the branch names people work on.
None of them can reach Sentry. The report is built field by field from an allowlist
rather than by handing an `Error` to an SDK that serializes whatever it finds:

- **The message** goes through `redact()`, which removes quoted spans, anything containing
  a `/` or `\`, filenames with a known extension, runs of 24 or more opaque characters
  (ciphertext, hashes, tokens), everything after the first line, and anything past 200
  characters.
- **The route** is a template. Every path segment that is not a fixed part of the API
  surface becomes `:id`, so `/v1/invites/CC-7F3A-9C2E/redeem` is reported as
  `/v1/invites/:id/redeem`. Query strings are dropped whole.
- **Custom error properties and `cause` are not read at all**, so an error that carries a
  patch or a path on a property cannot leak it.
- **Stack frames** are sent as basename, function, line and column. The raw stack string is
  dropped, because its first line is the message and would route around redaction.
- Request bodies, headers, cookies and environment variables are never read.

The tests that hold this are `apps/service/src/observability.test.ts`. There is no
`@sentry/node` dependency: the daemon ships inside the published `crosscode-cli` tarball,
so a runtime dependency there is one more package every user installs, and Sentry ingest is
one POST of an envelope.

## Setup checklist

Do these in order. Steps 1 to 3 are Sentry, 4 to 6 are PostHog, 7 to 9 are uptime.

### 1. Create the Sentry project

1. Sign up at <https://sentry.io> and create an organization.
2. Create a project: platform **Node.js**, name `crosscode-service`.
3. Copy the DSN it shows you. It looks like
   `https://<32 hex chars>@o<org id>.ingest.us.sentry.io/<project id>`.
4. In **Settings, Security and Privacy**, turn on **Data Scrubber** and **Use Default
   Scrubbers**, and add `filename`, `path`, `patch`, `diff`, `content` to **Additional
   Sensitive Fields**. This repo already strips those, so it is a second layer, not the
   first one.

### 2. Set the DSN on Vercel

In the Vercel project that serves `www.getcrosscode.dev`, go to **Settings, Environment
Variables** and add, for Production and Preview:

| Name | Value |
| --- | --- |
| `SENTRY_DSN` | the DSN from step 1 |

Two optional variables, both of which already default to something sensible:
`SENTRY_ENVIRONMENT` (defaults to Vercel's own `VERCEL_ENV`, so "production" or "preview")
and `SENTRY_RELEASE` (defaults to `VERCEL_GIT_COMMIT_SHA`).

Redeploy. Environment variables are read at instance start, so an existing deployment does
not pick this up.

### 3. Verify that service errors land

Run this from a checkout, with the DSN in the environment. It sends one event and exits:

```bash
SENTRY_DSN='<your DSN>' npx tsx -e 'import("./apps/service/src/observability.js").then(async (module) => {
  const reporter = module.createObservability(process.env);
  reporter.capture(new Error("crosscode observability smoke test"), { route: "/v1/changes", method: "GET", status: 500 });
  await reporter.flush();
  console.log("sent:", reporter.enabled);
})'
```

It prints `sent: true`. Within about 30 seconds the Sentry issue stream shows
`Error: crosscode observability smoke test` tagged `route:/v1/changes`, `method:GET`,
`status:500`. If it prints `sent: false`, the DSN did not parse.

Then check the deployed service: an unhandled error or any 5xx response opens an issue with
the same tags. To confirm on production without breaking anything, request a route that does
not exist under a workspace path and look at the tags; a 404 is not reported, so if you need
a real 5xx, wait for one rather than manufacturing it.

Set up alerting while you are there: **Alerts, Create Alert, Issues**, condition "a new
issue is created", action "send a notification to" your email or Slack. Without this, Sentry
records the outage and still nobody is told.

### 4. Create the PostHog project

1. Sign up at <https://posthog.com> (the free tier covers 1 million events a month).
2. Create a project named `crosscode-site`.
3. Copy the **Project API key**, which starts with `phc_`, and note your region host:
   `https://us.i.posthog.com` or `https://eu.i.posthog.com`.

### 5. Set the PostHog key on Vercel

Same Vercel project, **Settings, Environment Variables**, for Production and Preview:

| Name | Value |
| --- | --- |
| `VITE_POSTHOG_KEY` | the `phc_...` key |
| `VITE_POSTHOG_HOST` | only if your region is not US, for example `https://eu.i.posthog.com` |

These are build-time variables. Vite inlines them, so the key must be present when the site
builds, and a redeploy is required. With no key set, Vite eliminates the whole module: the
built file is empty and contains no PostHog URL. With a key it is about 2 kB.

### 6. Verify that site events land

1. Open the deployed site and confirm the network tab shows one POST to
   `<host>/i/v0/e/` with `"event":"landing_page_view"`.
2. Click **Copy install prompt**. A second POST carries `install_prompt_copied`.
3. Go to the sign-up page and submit the form. That is `sign_up_started`, and either the
   signed-in card or the "check your email" line that follows is `sign_up_completed`.
4. In PostHog, **Activity** shows all four within a few seconds.

Four events exist and no more: `landing_page_view`, `install_prompt_copied`,
`sign_up_started`, `sign_up_completed`. They answer whether anyone activates. Each carries
`$current_url`, `$referrer` and a random `distinct_id` held in `sessionStorage`. It dies
with the browser tab, so a returning visitor is a new one; nothing persistent is written to
the device. No email, no account id, nothing derived from the visitor.

`sign_up_started` and `sign_up_completed` are counted once per browser tab session, so the
link click on the landing page and the form submit that follows it are one event, not two.

`sign_up_completed` also requires `sign_up_started` earlier in the same tab. The signed-in
card is what the sign-up page draws for anyone who already has a session, and a sign-in on
the shared form draws it too; without that condition both would report a sign-up that never
happened. So verify step 3 above in a tab that has not signed in, or the event will not
fire and the page will look broken when it is not.

### 7. Confirm the health route the uptime job watches

`.github/workflows/uptime.yml` probes `https://www.getcrosscode.dev/api/healthz`. The
service answers health at `/health` and `/healthz`, outside the versioned surface:

```
https://www.getcrosscode.dev/api/health     → 200
https://www.getcrosscode.dev/api/healthz    → 200
https://www.getcrosscode.dev/api/v1/health  → 401   ← no such route
```

The default used to be `/api/v1/health`, which matches nothing and therefore fell to the
bearer check like any other unmatched path. The job reported an outage on every run against
a healthy service, the worst state an alert can be in, because it teaches everyone to
ignore it. If you need to repoint it, prefer a repository variable over a commit:
**Settings, Secrets and variables, Actions, Variables, New repository variable**, named
`CROSSCODE_HEALTH_URL`.

Health is not only liveness. It answers 503, and names the tables, when the runtime role
cannot read one. That is not hypothetical: `device_codes` shipped without a grant to
`crosscode_runtime`, every sign-in failed on `permission denied`, and this route answered
`ok` throughout, because whether the process was running was all it asked.

### 8. The `uptime` label

The workflow files issues under the label `uptime`, and `gh issue create` fails outright on
a label that does not exist, so a real outage would have gone unfiled on top of going
undetected. The label now exists on this repository. Recreate it only on a fork:

```bash
gh label create uptime --color B45309 --description "Automated service health check failures"
```

### 9. Make the failure reach a person

A GitHub issue nobody is watching is not an alert. Do one of these:

- Watch the repository with **Custom, Issues** so a new issue emails you, or
- Add the GitHub Slack app and run `/github subscribe amsultan2010/crosscode issues` in the
  channel you actually read.

Then run the workflow by hand once (**Actions, Uptime, Run workflow**) and check the run
log. Point `CROSSCODE_HEALTH_URL` at a path you know is broken first, confirm an issue
opens, then point it back at `/api/healthz` and confirm the issue closes. Proving both
directions is the point: an alert that fires is only half of a working alert path.

## What the uptime check does

- Every 5 minutes, plus on demand. Five minutes is the shortest cron GitHub accepts, and
  scheduled runs are queued rather than guaranteed, so a busy Actions window can delay a run
  by 10 minutes or more.
- Two attempts 20 seconds apart, each with a 10 second timeout. One failed probe is as
  likely to be a cold start or a dropped connection on a shared runner as a real outage, and
  an issue opened for that teaches everyone to ignore the next one.
- Anything other than HTTP 200 on both attempts is a failure. The first 500 in a row opens
  an issue titled "Service health check failing" carrying the URL, the status code, the
  first 500 bytes of the body and a link to the run. Later failures comment on that issue
  rather than opening more.
- The first successful probe after a failure closes the issue with a timestamp.

This is the free tier of uptime monitoring. Buy a real monitor (Better Stack, Checkly,
Pingdom) when either of these becomes true: you need detection faster than 10 minutes, or
you need a phone to ring at 03:00. Point it at the same route, 1 minute interval, alert
after two consecutive failures, and keep this workflow as the backstop.

### When the uptime check fires

1. Open the URL yourself. `curl -i https://www.getcrosscode.dev/api/health`. A 401 here
   means the probe URL is wrong, not that the service is down. See step 7.
2. If it answers 500, read the Vercel function logs for the deployment:
   **Vercel, the project, Logs**, filter on status 500. The `ERR_MODULE_NOT_FOUND` class of
   failure appears there and nowhere else, because the function never gets far enough to
   report to Sentry.
3. If Sentry has issues from the same window, the process started and a route threw. The
   `route` and `status` tags say which one.
4. If the URL answers 200 and the check still failed, suspect the runner rather than the
   service, and check <https://www.githubstatus.com>.
5. Roll back from the Vercel dashboard (**Deployments**, the last known good one, **Promote
   to Production**) before debugging. A promotion takes seconds and a diagnosis does not.

## Daemon crash reporting

The daemon runs on a user's machine, watching their checkout. `docs/privacy.md` is blunt
that the coordination service can read the files you sync, and the only reason that is
survivable is that the list of what leaves your machine is short and stated. A crash
reporter that switched itself on and started sending from a developer's laptop would add an
unlisted item to that list. So daemon reporting needs two variables, not one:

```bash
export CROSSCODE_ERROR_REPORTING=on
export CROSSCODE_SENTRY_DSN='https://...'
```

A DSN on its own does nothing. That is what stops a DSN inherited from a shell profile or a
CI environment from quietly starting to report.

What is sent when it is on: the error type, a redacted one-line message, stack frames as
basename plus line number, which daemon stage failed (`startup`, `watch`, `publish`,
`sync`), and the daemon version. What is not sent: file contents, paths, diffs, repository
name, remote URL, email, workspace id, device id.

Use a separate Sentry project from the service, so daemon noise from user machines does not
bury a service outage.

## Where the include actually is

`apps/docs-site/src/analytics.js` is a standalone module and has to be included per page.
It is included in `apps/docs-site/index.html` and in
`apps/docs-site/auth/signup.html`. `landing_page_view` and `install_prompt_copied` fire
from the landing page, as does `sign_up_started` on a click through to
`/auth/signup.html`. `sign_up_completed` fires from the sign-up page itself, which is why
the include is on both pages: without it the funnel has no last step.
