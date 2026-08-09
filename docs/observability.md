# observability: errors, analytics, uptime

crosscode had no error tracking, no product analytics and no uptime check. the hosted api
answered 500 on every route for an unknown length of time and we found out by running
`curl` by hand. this page describes what is now wired in and, below that, the ordered
checklist that turns it on.

everything here is off until it is configured. no key, no network call.

| what | where | turned on by |
| --- | --- | --- |
| service errors and 5xx responses | `apps/service/src/observability.ts`, hooked in `serverless.ts` and `main.ts` | `SENTRY_DSN` |
| daemon crashes | `apps/daemon/src/observability.ts` | `CROSSCODE_ERROR_REPORTING=on` **and** `CROSSCODE_SENTRY_DSN` |
| site analytics | `apps/docs-site/src/analytics.js` | `VITE_POSTHOG_KEY` at build time |
| uptime check | `.github/workflows/uptime.yml` | nothing. it runs every 5 minutes already |

## what is never sent

the service handles file contents, paths, patches, and the branch names people work on.
none of them can reach sentry. the report is built field by field from an allowlist
rather than by handing an `Error` to an sdk that serializes whatever it finds:

- **the message** goes through `redact()`, which removes quoted spans, anything containing
  a `/` or `\`, filenames with a known extension, runs of 24 or more opaque characters
  (ciphertext, hashes, tokens), everything after the first line, and anything past 200
  characters.
- **the route** is a template. every path segment that is not a fixed part of the api
  surface becomes `:id`, so `/v1/invites/CC-7F3A-9C2E/redeem` is reported as
  `/v1/invites/:id/redeem`. query strings are dropped whole.
- **custom error properties and `cause` are not read at all**, so an error that carries a
  patch or a path on a property cannot leak it.
- **stack frames** are sent as basename, function, line and column. the raw stack string is
  dropped, because its first line is the message and would route around redaction.
- request bodies, headers, cookies and environment variables are never read.

the tests that hold this are `apps/service/src/observability.test.ts`. there is no
`@sentry/node` dependency: the daemon ships inside the published `crosscode-cli` tarball,
so a runtime dependency there is one more package every user installs, and sentry ingest is
one post of an envelope.

## setup checklist

do these in order. steps 1 to 3 are sentry, 4 to 6 are posthog, 7 to 9 are uptime.

### 1. create the sentry project

1. sign up at <https://sentry.io> and create an organization.
2. create a project: platform **node.js**, name `crosscode-service`.
3. copy the dsn it shows you. it looks like
   `https://<32 hex chars>@o<org id>.ingest.us.sentry.io/<project id>`.
4. in **settings, security and privacy**, turn on **data scrubber** and **use default
   scrubbers**, and add `filename`, `path`, `patch`, `diff`, `content` to **additional
   sensitive fields**. this repo already strips those, so it is a second layer, not the
   first one.

### 2. set the dsn on vercel

in the vercel project that serves `www.getcrosscode.dev`, go to **settings, environment
variables** and add, for production and preview:

| name | value |
| --- | --- |
| `SENTRY_DSN` | the dsn from step 1 |

two optional variables, both of which already default to something sensible:
`SENTRY_ENVIRONMENT` (defaults to vercel's own `VERCEL_ENV`, so "production" or "preview")
and `SENTRY_RELEASE` (defaults to `VERCEL_GIT_COMMIT_SHA`).

redeploy. environment variables are read at instance start, so an existing deployment does
not pick this up.

### 3. verify that service errors land

run this from a checkout, with the dsn in the environment. it sends one event and exits:

```bash
SENTRY_DSN='<your DSN>' npx tsx -e 'import("./apps/service/src/observability.js").then(async (module) => {
  const reporter = module.createObservability(process.env);
  reporter.capture(new Error("crosscode observability smoke test"), { route: "/v1/changes", method: "GET", status: 500 });
  await reporter.flush();
  console.log("sent:", reporter.enabled);
})'
```

it prints `sent: true`. within about 30 seconds the sentry issue stream shows
`Error: crosscode observability smoke test` tagged `route:/v1/changes`, `method:GET`,
`status:500`. if it prints `sent: false`, the dsn did not parse.

then check the deployed service: an unhandled error or any 5xx response opens an issue with
the same tags. to confirm on production without breaking anything, request a route that does
not exist under a workspace path and look at the tags; a 404 is not reported, so if you need
a real 5xx, wait for one rather than manufacturing it.

set up alerting while you are there: **alerts, create alert, issues**, condition "a new
issue is created", action "send a notification to" your email or slack. without this, sentry
records the outage and still nobody is told.

### 4. create the posthog project

1. sign up at <https://posthog.com> (the free tier covers 1 million events a month).
2. create a project named `crosscode-site`.
3. copy the **project api key**, which starts with `phc_`, and note your region host:
   `https://us.i.posthog.com` or `https://eu.i.posthog.com`.

### 5. set the posthog key on vercel

same vercel project, **settings, environment variables**, for production and preview:

| name | value |
| --- | --- |
| `VITE_POSTHOG_KEY` | the `phc_...` key |
| `VITE_POSTHOG_HOST` | only if your region is not us, for example `https://eu.i.posthog.com` |

these are build-time variables. vite inlines them, so the key must be present when the site
builds, and a redeploy is required. with no key set, vite eliminates the whole module: the
built file is empty and contains no posthog url. with a key it is about 2 kb.

### 6. verify that site events land

1. open the deployed site and confirm the network tab shows one post to
   `<host>/i/v0/e/` with `"event":"landing_page_view"`.
2. click **copy install prompt**. a second post carries `install_prompt_copied`.
3. go to the sign-up page and submit the form. that is `sign_up_started`, and either the
   signed-in card or the "check your email" line that follows is `sign_up_completed`.
4. in posthog, **activity** shows all four within a few seconds.

four events exist and no more: `landing_page_view`, `install_prompt_copied`,
`sign_up_started`, `sign_up_completed`. they answer whether anyone activates. each carries
`$current_url`, `$referrer` and a random `distinct_id` held in `sessionStorage`. it dies
with the browser tab, so a returning visitor is a new one; nothing persistent is written to
the device. no email, no account id, nothing derived from the visitor.

`sign_up_started` and `sign_up_completed` are counted once per browser tab session, so the
link click on the landing page and the form submit that follows it are one event, not two.

`sign_up_completed` also requires `sign_up_started` earlier in the same tab. the signed-in
card is what the sign-up page draws for anyone who already has a session, and a sign-in on
the shared form draws it too; without that condition both would report a sign-up that never
happened. so verify step 3 above in a tab that has not signed in, or the event will not
fire and the page will look broken when it is not.

### 7. confirm the health route the uptime job watches

`.github/workflows/uptime.yml` probes `https://www.getcrosscode.dev/api/healthz`. the
service answers health at `/health` and `/healthz`, outside the versioned surface:

```
https://www.getcrosscode.dev/api/health     → 200
https://www.getcrosscode.dev/api/healthz    → 200
https://www.getcrosscode.dev/api/v1/health  → 401   ← no such route
```

the default used to be `/api/v1/health`, which matches nothing and therefore fell to the
bearer check like any other unmatched path. the job reported an outage on every run against
a healthy service, the worst state an alert can be in, because it teaches everyone to
ignore it. if you need to repoint it, prefer a repository variable over a commit:
**settings, secrets and variables, actions, variables, new repository variable**, named
`CROSSCODE_HEALTH_URL`.

health is not only liveness. it answers 503, and names the tables, when the runtime role
cannot read one. that is not hypothetical: `device_codes` shipped without a grant to
`crosscode_runtime`, every sign-in failed on `permission denied`, and this route answered
`ok` throughout, because whether the process was running was all it asked.

### 8. the `uptime` label

the workflow files issues under the label `uptime`, and `gh issue create` fails outright on
a label that does not exist, so a real outage would have gone unfiled on top of going
undetected. the label now exists on this repository. recreate it only on a fork:

```bash
gh label create uptime --color B45309 --description "Automated service health check failures"
```

### 9. make the failure reach a person

a github issue nobody is watching is not an alert. do one of these:

- watch the repository with **custom, issues** so a new issue emails you, or
- add the github slack app and run `/github subscribe amsultan2010/crosscode issues` in the
  channel you actually read.

then run the workflow by hand once (**actions, uptime, run workflow**) and check the run
log. point `CROSSCODE_HEALTH_URL` at a path you know is broken first, confirm an issue
opens, then point it back at `/api/healthz` and confirm the issue closes. proving both
directions is the point: an alert that fires is only half of a working alert path.

## what the uptime check does

- every 5 minutes, plus on demand. five minutes is the shortest cron github accepts, and
  scheduled runs are queued rather than guaranteed, so a busy actions window can delay a run
  by 10 minutes or more.
- two attempts 20 seconds apart, each with a 10 second timeout. one failed probe is as
  likely to be a cold start or a dropped connection on a shared runner as a real outage, and
  an issue opened for that teaches everyone to ignore the next one.
- anything other than http 200 on both attempts is a failure. the first 500 in a row opens
  an issue titled "service health check failing" carrying the url, the status code, the
  first 500 bytes of the body and a link to the run. later failures comment on that issue
  rather than opening more.
- the first successful probe after a failure closes the issue with a timestamp.

this is the free tier of uptime monitoring. buy a real monitor (better stack, checkly,
pingdom) when either of these becomes true: you need detection faster than 10 minutes, or
you need a phone to ring at 03:00. point it at the same route, 1 minute interval, alert
after two consecutive failures, and keep this workflow as the backstop.

### when the uptime check fires

1. open the url yourself. `curl -i https://www.getcrosscode.dev/api/health`. a 401 here
   means the probe url is wrong, not that the service is down. see step 7.
2. if it answers 500, read the vercel function logs for the deployment:
   **vercel, the project, logs**, filter on status 500. the `ERR_MODULE_NOT_FOUND` class of
   failure appears there and nowhere else, because the function never gets far enough to
   report to sentry.
3. if sentry has issues from the same window, the process started and a route threw. the
   `route` and `status` tags say which one.
4. if the url answers 200 and the check still failed, suspect the runner rather than the
   service, and check <https://www.githubstatus.com>.
5. roll back from the vercel dashboard (**deployments**, the last known good one, **promote
   to production**) before debugging. a promotion takes seconds and a diagnosis does not.

## daemon crash reporting

the daemon runs on a user's machine, watching their checkout. `docs/privacy.md` is blunt
that the coordination service can read the files you sync, and the only reason that is
survivable is that the list of what leaves your machine is short and stated. a crash
reporter that switched itself on and started sending from a developer's laptop would add an
unlisted item to that list. so daemon reporting needs two variables, not one:

```bash
export CROSSCODE_ERROR_REPORTING=on
export CROSSCODE_SENTRY_DSN='https://...'
```

a dsn on its own does nothing. that is what stops a dsn inherited from a shell profile or a
ci environment from quietly starting to report.

what is sent when it is on: the error type, a redacted one-line message, stack frames as
basename plus line number, which daemon stage failed (`startup`, `watch`, `publish`,
`sync`), and the daemon version. what is not sent: file contents, paths, diffs, repository
name, remote url, email, workspace id, device id.

use a separate sentry project from the service, so daemon noise from user machines does not
bury a service outage.

## where the include actually is

`apps/docs-site/src/analytics.js` is a standalone module and has to be included per page.
it is included in `apps/docs-site/index.html` and in
`apps/docs-site/auth/signup.html`. `landing_page_view` and `install_prompt_copied` fire
from the landing page, as does `sign_up_started` on a click through to
`/auth/signup.html`. `sign_up_completed` fires from the sign-up page itself, which is why
the include is on both pages: without it the funnel has no last step.
