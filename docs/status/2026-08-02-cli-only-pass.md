# CLI-only pass — what landed, what didn't (2026-08-02)

Status of the pass that deleted the web dashboard and re-centred Crosscode on the CLI.
Four parallel workstreams, each in its own worktree, merged into `amsultan2010/surgeonfish`
with zero conflicts.

This file is a snapshot of *one merge*, not a living roadmap — the roadmap is
[`BUILD_INSTRUCTIONS.md`](../../BUILD_INSTRUCTIONS.md). Read this one for "what state did the
CLI-only pass actually leave the repo in."

## The decisions this pass was built against

Frozen before any work started, so the four workstreams could run without talking to each other:

1. **Teams: delete the web UI only.** The multi-tenant backend is untouched. Workspaces,
   memberships, invites, pairing codes, roles, RLS, presence, and billing all still exist in
   `apps/service` and in the migrations, reachable from the CLI and the HTTP API. "Deleted"
   applies to the browser UI, never to the service.
2. **Auth: `crosscode login` becomes a browser flow** — loopback callback, `state` check —
   with the existing email/password path kept as the headless path for agents and CI.
3. **Website: landing + auth + docs.** Nothing behind auth except the login callback page.
4. **The VS Code extension goes**, taken literally from "CLI only".

One conflict between decisions 1 and 2 was resolved explicitly: pairing codes and invites
**survive** as CLI + API features. Nothing in the web UI mints them anymore, but the endpoints
and `crosscode join --pair` / `--invite` remain.

## Verification of the merged result

Run on the merged tree, not on the individual branches.

| Check | Result |
| --- | --- |
| `pnpm install` | PASS — clean, lockfile consistent |
| `pnpm build` (`tsc --noEmit`) | PASS |
| `pnpm test` | PASS — 25 files passed / 6 skipped; 231 tests passed / 11 skipped |
| `pnpm docs:build` | PASS — landing + 4 auth pages + 8 docs pages emitted |
| Four branches merged | PASS — zero conflicts |

The 11 skipped tests need `CROSSCODE_TEST_DATABASE_URL`; they are the Postgres integration
suites and were skipped before this pass too. Local node is v22.22.2 against a declared
`"node": ">=24"` — pnpm warns and proceeds. Pre-existing, unrelated to this work.

## Per-workstream outcome

### 1. Website reduction — PASS

`apps/docs-site/dashboard/` deleted in full: 4,435 lines across the dashboard view, onboarding,
the spotlight tour, analytics, settings, sign-in, invite redemption, the live-feed WebSocket
client, the API client, and their tests.

Replaced by `apps/docs-site/auth/` — `signin.html`, `signup.html`, `reset.html`, `cli.html`,
plus a shared `auth-form.js` and the Supabase client carried over from the deleted tree. Vite
inputs updated, landing page and `docs/install.html` copy rewritten around the CLI flow,
`@crosscode/protocol` dropped from the site's dependencies (it was dashboard-only).

Self-reported verification: build, `pnpm test`, and Orca-browser checks of the rendered pages
all passed.

### 2. CLI browser login — PASS

New `apps/daemon/src/browser-login.ts` (168 lines) plus 109 lines of tests. Implements the
frozen contract: loopback server on `127.0.0.1`, ephemeral port, `/callback`, 32-character
hex `state`, CORS preflight, `LOGIN_STATE_MISMATCH`, `LOGIN_TIMEOUT` at 300s, `--no-browser`,
and the preserved `--email`/`--password` headless path. `apps/mcp-server/src/bootstrap.ts` now
points people at `crosscode login` instead of a dashboard.

**Cross-workstream seam verified by hand after the merge** — this is the one thing neither
agent could check, since each owned only one side of it. The site posts and the CLI parses the
same shape, field for field:

```
POST http://127.0.0.1:<port>/callback
{ state, access_token, refresh_token, expires_at, user: { id, email } }
```

`cliSignInUrl()` builds `/auth/cli.html?port=&state=`, which is exactly the path and query
`apps/docs-site/auth/src/cli.js` reads. The three CORS headers match. Verified by reading both
sides, not by running the flow end-to-end against a deployed site.

### 3. VS Code extension removal — PASS

`apps/vscode-extension/` deleted (16 files, 3,245 lines). Root `build` script reduced to the
typecheck, `@vscode/vsce-sign` and `keytar` removed from `pnpm-workspace.yaml` build
allowances after confirming the extension was their only consumer, lockfile regenerated
(−2,078 lines). `esbuild` stayed — Vite needs it.

### 4. Docs rewrite — PASS

`README.md`, `BUILD_INSTRUCTIONS.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/architecture.md`,
`docs/security.md`, `docs/install-prompt.md`, `docs/mcp-clients.md`, and
`docs/onboarding-contracts.md` rewritten CLI-first. `onboarding-contracts.md` was rewritten
rather than deleted — Contracts A (pairing) and C (personal workspace) still describe live
backend behavior; only the dashboard-facing Contract D went away.

## Not fully completed

Nothing here blocks the build or the tests. These are the honest gaps.

### Stale comments naming consumers that no longer exist

The service, protocol, and git packages were explicitly out of every workstream's ownership,
so their comments still describe the dashboard and the extension as live consumers:

| File | Line | What it says |
| --- | --- | --- |
| `apps/service/src/store.ts` | 235 | "Powers the dashboard's 'your teams' / workspace switcher" |
| `apps/service/src/http.ts` | 144, 157 | "dashboard can group its activity by project", "(dashboard …)" |
| `apps/service/src/http.test.ts` | 380 | test named "for the dashboard's team switcher" |
| `apps/service/migrations/009_pairing.sql` | 3 | "the dashboard mints" |
| `apps/service/migrations/010_projects.sql` | 2, 36 | "the dashboard could not", "dashboard groups those under 'Unassigned'" |
| `packages/protocol/src/index.ts` | 290 | "The dashboard mints a code" |
| `packages/protocol/src/index.test.ts` | 204 | "the path the dashboard reads" |
| `packages/git/src/typescript-graph.ts` | 10 | "VS Code extension, which imports @crosscode/git" |

The described *behavior* is still correct — pairing codes are still minted, projects still
group activity. Only the named consumer is wrong; it is the CLI and the API now. Migration
comments are historical record and are arguably fine to leave.

### `crosscode login` has no default website URL

`resolveWebUrl()` requires `--web`, `CROSSCODE_WEB_URL`, or the legacy `CROSSCODE_DASHBOARD_URL`,
and throws `WEB_URL_REQUIRED` when none is set. The frozen contract said "else the production
default" — there is no production domain yet, so the workstream chose to fail fast rather than
guess. Correct call, but it means bare `crosscode login` does not work out of the box until a
domain exists and the default is filled in.

### `CROSSCODE_DASHBOARD_URL` outlives the dashboard

Still read as a fallback in `apps/daemon/src/browser-login.ts` and
`apps/mcp-server/src/bootstrap.ts`. Deliberate backward compatibility for anyone who already
set it, but the name is now a lie. Worth deprecating in favour of `CROSSCODE_WEB_URL`.

### The login flow was never run end-to-end against a deployed site

Both halves are unit-tested and were verified by reading them against each other, and the CLI
side has an end-to-end test driven by a scripted callback POST. Nobody has run a real browser
against a deployed `/auth/cli.html` and completed a real Supabase sign-in — there is no
deployment to run it against. First real integration test once a domain exists.

### Untouched by design

- **Billing enforcement.** The `assertSeatCapAvailable` / `assertSemanticReviewCallAvailable` /
  `assertPlanAllowsAutonomyTier` helpers still are not wired into their call sites — a
  pre-existing Phase 10 gap, not something this pass touched.
- **`expires_at` is required** by the callback schema. Supabase populates it on a signed-in
  session, so this is fine in practice, but a session without it fails as
  `LOGIN_CALLBACK_INVALID` rather than degrading.

## Suggested next steps

1. Scrub the nine stale comments above — mechanical, one small commit.
2. Stand up a real deployment, then fill in the default `WEB_URL` and run the login flow
   end-to-end for real.
3. Deprecate `CROSSCODE_DASHBOARD_URL` in favour of `CROSSCODE_WEB_URL`.
