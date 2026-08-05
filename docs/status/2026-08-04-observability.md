# Workstream B: observability and uptime (2026-08-04)

Sentry error tracking for the service, opt-in crash reporting for the daemon, four PostHog
events on the marketing site, and a scheduled health check that opens a GitHub issue when
the API stops answering. All of it is inert until it is configured, and none of it can be
configured yet because neither account exists. `docs/observability.md` is the checklist that
turns it on.

## What changed

| File | Change |
| --- | --- |
| `apps/service/src/observability.ts` | New. The reporter: DSN parsing, redaction, event building, Sentry envelope transport, and `observeRequest` for 5xx responses |
| `apps/service/src/observability.test.ts` | New. 11 tests |
| `apps/service/src/serverless.ts` | 12 lines: build a reporter from the environment, observe each request, capture and flush on a thrown error |
| `apps/service/src/main.ts` | 7 lines: build a reporter, attach a second `request` listener, capture a startup failure |
| `apps/daemon/src/observability.ts` | New. The two-variable opt-in gate over the same reporter |
| `apps/daemon/src/observability.test.ts` | New. 5 tests |
| `apps/daemon/src/main.ts` | 8 lines: capture a failed daemon start, flush on shutdown |
| `apps/docs-site/src/analytics.js` | New. Four PostHog events, no-op without a key |
| `apps/docs-site/src/analytics.test.ts` | New. 5 tests, jsdom |
| `.github/workflows/uptime.yml` | New. Health probe every 5 minutes, issue open and close |
| `docs/observability.md` | New. Setup checklist, what is never sent, uptime runbook |

Nothing else was touched. `apps/service/src/http.ts`, `.github/workflows/ci.yml`,
`apps/docs-site/index.html`, `src/style.css`, `src/main.js`, `README.md`,
`BUILD_INSTRUCTIONS.md` and the existing `docs/*.md` are all unmodified.

## Two design decisions worth reviewing

**No `@sentry/node` dependency.** The daemon is bundled into the published
`crosscode-cli` tarball by `scripts/build.mjs`, and every runtime dependency there is a
real npm package users install to run a file watcher. Sentry ingest is one POST of an
envelope, so the transport is 20 lines. It also makes the privacy constraint provable:
because the event is built field by field rather than by handing an `Error` to an SDK,
there is no code path that serializes custom properties, `cause`, request bodies or
headers. The cost is no breadcrumbs, no tracing and no automatic release health. If the
team later wants those, replacing the transport with the SDK means keeping `redact()` as a
`beforeSend` hook.

**The daemon imports the reporter from the service app by relative path**
(`../../service/src/observability.js`), the same way `apps/cli` imports
`../../daemon/src/client.js`. One copy of the redaction rules is the only way both
processes stay held to the same ones. It pulls nothing from the service runtime with it:
`observability.ts` imports `node:crypto` and one type.

## Success criteria

### 1. `pnpm build` and `pnpm test` pass

```
$ pnpm build
$ tsc --noEmit && node scripts/build.mjs
  dist/daemon.js      230.1kb
  dist/cli.js         157.6kb
  dist/mcp.js          72.5kb
⚡ Done in 15ms

$ pnpm test
 Test Files  37 passed | 9 skipped (46)
      Tests  411 passed | 42 skipped (453)
   Duration  71.92s
```

The 9 skipped files are the PostgreSQL suites, which skip without
`CROSSCODE_TEST_DATABASE_URL`. That is their behaviour on `main` too; CI runs them in a
separate step. I did not run `pnpm test:postgres` because no local Postgres is running, and
nothing in this workstream touches the database.

### 2. With no `SENTRY_DSN`, initialisation is a no-op and makes no network call

`apps/service/src/observability.test.ts`, "is inert and opens no socket". `fetch` is
replaced with a spy that rejects, so any call would fail the test loudly:

```ts
const fetchSpy = vi.fn(() => Promise.reject(new Error("no network call should happen")));
vi.stubGlobal("fetch", fetchSpy);
const reporter = createObservability({});
expect(reporter.enabled).toBe(false);
reporter.capture(new Error("boom"), { route: "/v1/health", method: "GET" });
await reporter.flush();
expect(fetchSpy).not.toHaveBeenCalled();
```

A second test proves nothing is even attached: with reporting off, `observeRequest` leaves
`response.listenerCount("finish")` at 0, so a 5xx costs nothing.

### 3. An error carrying file content and paths is redacted before the transport

`apps/service/src/observability.test.ts`, "strips file contents and paths from an error
before it reaches the transport". The transport is injected, so the assertion is on the
exact object that would have been serialized into the envelope:

```ts
const error = new Error(
  "Failed to seal /Users/ana/work/acme/src/billing.ts: const STRIPE_KEY = \"sk_live_51NfakeSecretValue\"\n" +
  "  offending chunk: aGVsbG8gdGhpcyBpcyBjaXBoZXJ0ZXh0IGZvciBhIGZpbGU="
);
reporter.capture(error, { route: "/v1/workspaces/:id/operations", method: "POST", status: 500, requestId: "iad1::abc-123" });
await reporter.flush();

expect(value).toBe("Failed to seal [path]: const STRIPE_KEY = [redacted]");
for (const secret of ["ana", "acme", "billing.ts", "sk_live", "aGVsbG8", "ciphertext"]) {
  expect(value).not.toContain(secret);
}
// and against the whole serialized event, not just the message:
const serialized = JSON.stringify(sent[0]);
for (const secret of ["ana", "acme", "billing.ts", "sk_live", "aGVsbG8"]) {
  expect(serialized).not.toContain(secret);
}
```

A second test proves the other leak paths are closed: an error with `cause`, a `filePath`
property and a `patch` property sends none of them, and the raw stack string is replaced by
parsed frames whose filenames contain no `/`.

I also sent a real envelope to a local HTTP sink to confirm the wire format, since a test
with an injected transport does not prove the transport itself. The path in the message came
out redacted:

```
$ SENTRY_DSN=http://publickey@127.0.0.1:8973/4501 npx tsx /tmp/smoke.mts
enabled: true

PATH /api/4501/envelope/
AUTH Sentry sentry_version=7, sentry_client=crosscode/1, sentry_key=publickey
CT application/x-sentry-envelope
{"event_id":"72373f6b6e42444d9f008d0bdc147aff","dsn":"http://publickey@127.0.0.1:8973/4501","sent_at":"2026-08-04T22:00:41.087Z"}
{"type":"event"}
{"event_id":"72373f6b...","timestamp":1785880841,"platform":"node","level":"error","environment":"production","transaction":"GET /v1/health","tags":{"route":"/v1/health","method":"GET","status":"500"},"exception":{"values":[{"type":"Error","value":"smoke test from [path]","stacktrace":{"frames":[...,{"function":"<anonymous>","filename":"smoke.mts","lineno":4,"colno":18}]}}]}}
```

Not verified: that Sentry's own ingest accepts this envelope. It matches the documented
envelope format, but no account exists to send it to. Step 3 of the checklist in
`docs/observability.md` is the exact command that closes this, and it prints `sent: true`
locally today.

### 4. Daemon telemetry is off by default

`apps/daemon/src/observability.test.ts`, "is off by default", same rejecting-fetch spy:

```ts
const telemetry = createDaemonTelemetry({});
expect(telemetryEnabled({})).toBe(false);
expect(telemetry.enabled).toBe(false);
telemetry.capture(new Error("watcher died"), "watch");
await telemetry.flush();
expect(fetchSpy).not.toHaveBeenCalled();
```

Three more tests cover the gate: a DSN alone does not enable it (so a DSN inherited from a
shell profile or CI cannot silently start reporting), `CROSSCODE_ERROR_REPORTING=on` without
a DSN does not enable it, and only the literal value `on` counts, case-insensitively.

```
$ npx vitest run apps/daemon/src/observability.test.ts --reporter=verbose
 ✓ daemon telemetry > is off by default 2ms
 ✓ daemon telemetry > stays off when only a DSN is present, so an inherited DSN cannot switch it on 0ms
 ✓ daemon telemetry > stays off when the opt-in is set without a DSN 0ms
 ✓ daemon telemetry > reports only after both the opt-in and the DSN are set, and sends no path or content 4ms
 ✓ daemon telemetry > accepts the opt-in case-insensitively and rejects anything else 0ms
```

### 5. `pnpm docs:build` passes, and the module is a no-op with no key

```
$ pnpm docs:build
dist/index.html                                 38.63 kB │ gzip: 10.70 kB
dist/assets/main-Drebcaih.js                     1.34 kB │ gzip:  0.67 kB
✓ built in 190ms
```

`analytics.js` does not appear in that output because `index.html` does not include it yet;
that include belongs to workstream E (see the contract below). To prove the module builds
and that it is genuinely inert, I built it standalone through Vite twice. With no key, Vite
eliminates the entire module:

```
$ npx vite build --config /tmp/vite-analytics.config.js
✓ 1 modules transformed.
/tmp/analytics-build/analytics.js  0.05 kB │ gzip: 0.07 kB

$ cat /tmp/analytics-build/analytics.js
function t(e, r = {}) {
}
export { t as capture };
```

No listeners, no storage, no PostHog URL in the bundle at all. With a key:

```
$ VITE_POSTHOG_KEY=phc_example npx vite build --config /tmp/vite-analytics.config.js
/tmp/analytics-build/analytics.js  2.29 kB │ gzip: 1.08 kB
$ grep -o "https://us.i.posthog.com" ... ; grep -o "<event names>" ...
https://us.i.posthog.com
install_prompt_copied
landing_page_view
sign_up_completed
sign_up_started
```

The jsdom test file adds behavioural proof: with no key, a copy-button click and a direct
`capture()` call both reach `fetch` zero times and write nothing to `localStorage`.

### 6. `docs/observability.md` gives an ordered setup checklist

Nine numbered steps in three groups: Sentry (create the project, set `SENTRY_DSN` on Vercel
for Production and Preview, verify with a one-line command that sends a real event and
prints `sent: true`), PostHog (create the project, set `VITE_POSTHOG_KEY` and optionally
`VITE_POSTHOG_HOST` on Vercel, verify each of the four events in the network tab and in
PostHog Activity), uptime (set `CROSSCODE_HEALTH_URL` if the route moves, create the
`uptime` label with the exact `gh label create` command, and subscribe a human so the issue
reaches someone). Step 9 says to run the workflow by hand today, while the API is still
answering 500, because a failing API is the cheapest end-to-end test of the alert path.

The page also documents what is never sent, what the uptime check does and when to buy a
paid monitor instead, and a five-step runbook for when the check fires.

## Uptime workflow: what I verified locally

I extracted the probe step and ran it against a local server, since GitHub's scheduler
cannot be exercised from here.

```
$ HEALTH_URL=http://127.0.0.1:8971/ok bash /tmp/probe.sh
Health check passed: 200
$ cat $GITHUB_OUTPUT
healthy=true

$ HEALTH_URL=http://127.0.0.1:8971/api/v1/health bash /tmp/probe.sh   # server answers 500
Attempt 1 failed with status 500
Attempt 2 failed with status 500
$ cat $GITHUB_OUTPUT
healthy=false
url=http://127.0.0.1:8971/api/v1/health
status=500
body<<EOF
ERR_MODULE_NOT_FOUND
EOF

$ HEALTH_URL=http://127.0.0.1:9999/dead bash /tmp/probe.sh            # nothing listening
Attempt 1 failed with status 000
Attempt 2 failed with status 000
$ cat $GITHUB_OUTPUT
healthy=false
status=000
```

All three step scripts pass `bash -n`, and the file parses as YAML.

Not verified: the `gh issue create` and `gh issue close` steps, which need the workflow to
run on GitHub with `issues: write`. The first scheduled run after this branch merges is the
test. It requires the `uptime` label to exist first (checklist step 8), otherwise
`gh issue create --label uptime` fails and the outage goes unreported.

## Contracts with other workstreams

- **Workstream E owns `apps/docs-site/index.html`.** The module is at exactly
  `apps/docs-site/src/analytics.js`, so
  `<script type="module" src="/src/analytics.js"></script>` resolves as is. I did not edit
  `index.html`.
- **A second include is worth adding to `apps/docs-site/auth/signup.html`.** I did not add
  it: that file is not mine and not listed as anyone's, so I left it alone. Without it,
  `sign_up_started` still fires when someone clicks a link to `/auth/signup.html` from a
  page that does include the module, and `sign_up_completed` never fires at all. The
  sign-up events read the DOM through delegated listeners and a `MutationObserver`, so
  `auth/src/auth-form.js` and `auth/src/account.js` need no changes either way.
- **Workstream A owns `GET /health`.** The uptime workflow assumes
  `https://www.getcrosscode.dev/api/v1/health` returns 200. If it lands on a different path,
  set the `CROSSCODE_HEALTH_URL` repository variable rather than editing the workflow.
- **`apps/service/src/serverless.ts` and `main.ts` have small edits from this branch**, and
  A is reworking `serverless.ts` for the Vercel `ERR_MODULE_NOT_FOUND` fix. My changes there
  are three added blocks: an import, a reporter built from the environment, and a
  try/catch/finally around the existing handler body. They should rebase cleanly onto any
  change to how the handler is exported.

## What I could not do

- **No Sentry or PostHog account exists**, so no event has been confirmed to land in either
  product. Every command needed to confirm that is written out in `docs/observability.md`
  with the expected output.
- **The hosted API answers 500 on every route**, so I could not point the health probe at
  the real service and watch it pass. Workstream A owns that fix.
- **`pnpm test:postgres` was not run** (no local Postgres). Nothing here touches the
  database.
- **The daemon's opt-in is an environment variable pair, not a setting in a config file.**
  A field in `daemonConfigSchema` would be the better home, but that schema lives in
  `packages/protocol`, which this workstream does not own. If the coordinator wants it
  there, the change is one optional `errorReporting` object in the schema plus reading it in
  `apps/daemon/src/main.ts`, and the gate in `apps/daemon/src/observability.ts` stays as it
  is.
