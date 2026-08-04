# Crosscode — Build Instructions & Roadmap

This document is a living reference: **current status** and **the plan**. It is deliberately not a full spec — implementation detail lives in the code and in `docs/architecture.md`, `docs/protocol.md`, `docs/mcp-clients.md`, `docs/security.md`, `README.md`, and `AGENTS.md`. Read those for how things work; read this for what's done and what's next.

## What Crosscode is

A local-first coordination layer for people and coding agents working in separate checkouts of the same Git repo. A daemon watches filesystem/Git activity, captures edits as durable transactions, and exchanges them through a coordination service. Remote work always arrives as a reviewable proposal — never auto-written into a checkout — and Git remains the durable history/publishing layer.

**Framing (2026-08-04).** The value proposition is *collaboration*, not collision defence. Coding together still works like emailing a `.docx` around: separate copies, no visibility into anyone else's work, a merge at the end. Google Docs fixed that for writing; Crosscode moves code toward it. Pitch what the team gains — seeing each other's work as it lands, taking a change with one command instead of a pull-request round trip — not what they are protected from. Overwrites are a real failure mode the safety model handles, but they are rare, and leading with them sells a defence against something most teams have not been bitten by. It also stops one deliberate step short of live editing: the accept step stays, because live typing into someone else's working tree is the one thing you do not want in code. Full product framing: `README.md`. Agent-facing contract (capability ladder, trust model, CLI/MCP-first positioning): `AGENTS.md`.

**Product-surface decision (2026-08-02): Crosscode is a CLI-first product.** The product surface is the daemon, the MCP server, and the CLI. The website is a landing page, sign-up/sign-in (including the `crosscode login` callback page), and the generated docs — nothing else lives behind auth. Two consequences, both deliberate:

- **There is no web dashboard**, and no web UI for teams, invites, settings, onboarding, analytics, or a live feed. The multi-tenant backend is untouched: workspaces, memberships, invites, pairing codes, roles, RLS, presence, and billing all still exist in `apps/service` and in the SQL migrations. They are reached from the CLI and the HTTP API. "Deleted" applies to the browser UI, never to the service.
- **There is no editor extension.** Editors and agents integrate through MCP, which is the one integration contract.

**Product-scope decision (2026-08-01, reaffirmed and sharpened 2026-08-04): Crosscode is for shared projects whose team members all run coding agents.** That is the audience — not "anyone with agents."

Two situations count, and only these two:

1. **Several people on one project, all of them running agents.** The primary case, and what every feature is shaped for: invites, roles, seats, presence, claims, handoffs, per-workspace autonomy policy. This is why the product exists.
2. **One person working alone *right now* on a project they share with others**, whose teammates simply aren't coding today. Still the same case — the repository is shared, their agents will land work on it again, and the proposals waiting on return are exactly what Crosscode makes safe.

**Explicitly out of scope:** a repository only one person will ever touch. There is nothing to coordinate with, and plain Git is the better tool. Do not frame the product, the free tier, or the marketing site around solo use — "you don't need a team" is the wrong message, and was briefly live on the landing page in error (corrected 2026-08-04).

One person running several of their *own* agents in parallel worktrees is a real coordination problem, but it is not the wedge and must not lead the messaging: it converts poorly into the team product and describes a user who can often get by without us. Design free tier and messaging around "your team's agents are colliding," not "useful even completely alone." 

**Fundamental rules** (unchanged, non-negotiable):

1. The local filesystem is always authoritative for local work.
2. Remote operations arrive as proposals and are never automatically applied without a policy decision (see the autonomy-slider plan below — "automatic" is now a configurable policy, not a removal of this rule).
3. Every materialization re-checks the local base and creates a checkpoint first.
4. High-risk/critical changes always require explicit approval regardless of any policy setting.

## Architecture

```text
human / coding agent
        |
        |  CLI (`crosscode …`)      MCP tools (stdio)
        v                            v
per-worktree daemon --- SQLite events + outbox
        |
        | authenticated HTTP sync (Supabase JWT or ccw_ workspace token)
        v
coordination service --- Supabase-hosted PostgreSQL operations + audit log
        |
        v
other daemons receive reviewable proposals
```

The website sits beside this, not inside it: it originates accounts (sign-up/sign-in/password reset) and hands a session back to the CLI over a loopback callback, then gets out of the way. Full design: `docs/architecture.md`.

### Apps

| App | What it is |
| --- | --- |
| `apps/daemon` | The per-worktree daemon — the sole local authority for capture, checkpoints, materialization, and sync (`pnpm daemon`). |
| `apps/cli` | The local CLI over the daemon's loopback HTTP API, plus login/join/init (`pnpm crosscode <command>`). |
| `apps/mcp-server` | The standards-compliant MCP server agents connect to; bootstraps the daemon on first connection (`pnpm mcp`). |
| `apps/service` | The multi-tenant coordination service: Supabase-Postgres operations, auth, workspaces, memberships, invites, pairing codes, projects, billing, audit (`pnpm service`). No UI. |
| `apps/docs-site` | The website: landing page, auth pages (sign-up, sign-in, password reset, `/auth/cli.html`), and the docs pages generated from the root `docs/*.md` (`pnpm docs:dev` / `docs:build`). |

## Authentication — `crosscode login`

This is a frozen contract. The CLI side and the site side are implemented against it independently and neither may renegotiate it.

- `crosscode login` with no flags and a TTY present starts a loopback HTTP server on `127.0.0.1` on an ephemeral port with the route `/callback`, and generates a 32-character random `state`.
- It opens the browser at `${WEB_URL}/auth/cli.html?port=<port>&state=<state>`, where `WEB_URL` comes from `--web <url>`, else `CROSSCODE_WEB_URL`, else the deprecated `CROSSCODE_DASHBOARD_URL` (still read so setups predating the dashboard's removal keep working; it prints a one-time notice on **stderr**, never stdout, so `--json` output stays a single parseable line), else the hosted default `DEFAULT_WEB_URL` in `apps/daemon/src/hosted.ts`. Both the CLI and the MCP server resolve the environment half through `configuredWebUrl()` in `apps/daemon/src/browser-login.ts` — the precedence chain lives in one place. Now that a hosted default exists, `WEB_URL_REQUIRED` is no longer reachable: bare `crosscode login` targets the hosted site.
- `/auth/cli.html` is a page on the marketing site. If the visitor is not signed in it renders the normal sign-in form. After a successful Supabase sign-in it POSTs JSON to `http://127.0.0.1:<port>/callback`:

  ```jsonc
  { "state": "<echoed state>",
    "access_token": "…",
    "refresh_token": "…",
    "expires_at": 1754131200,   // unix seconds
    "user": { "id": "…", "email": "…" } }
  ```

  then renders "You're signed in — return to your terminal."
- The CLI's loopback server answers the CORS preflight so the fetch from the site succeeds: `OPTIONS /callback` → `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: content-type`.
- A mismatched or missing `state` fails with the error code `LOGIN_STATE_MISMATCH`. No callback within 300 seconds fails with `LOGIN_TIMEOUT`, whose hint points at `--email`/`--password` or `--no-browser`.
- `--no-browser` prints the URL instead of opening it. `--email <e> --password <p>` keeps the existing headless path, which is what agents and CI use. There is deliberately **no** `CROSSCODE_TOKEN` environment variable.
- On success the session is persisted through the existing daemon config writer (the mode-`0600` `<git-dir>/crosscode/config.json`). Tokens are never printed to stdout and never appear in `--json` output. `crosscode login --json` emits `{"value":{"userId":"…","email":"…"}}`.

Threat model for this flow — why loopback-only, why `state`, why nothing is printed — is in `docs/security.md`.

## Current status

**Core coordination engine — complete and tested.** Per-worktree daemon (SQLite event log, hidden Git checkpoints, crash-safe materialization, Git-transition detection), a Supabase-Postgres-backed coordination service (authenticated sync, live WebSocket fan-out, audit log), deterministic conflict classification plus an AST-based TypeScript dependency graph, validation-gated publish, and a real (non-mock) AI semantic reviewer (`AgentDelegatedReviewer`, delegates to the workspace member's own connected MCP agent — no external AI provider). Auto-triggers at classification time, not just on demand. See `docs/architecture.md` for the full design and `README.md`'s "What works today" for the exact feature list.

**Agent-first surface pass — complete (2026-08-01).** Four parallel workstreams closed the gap between "supports agents" and "designed for agents to prefer":

- **CLI** rewritten on `commander`: proper `--help`, a `commands --json` machine-readable catalog, structured `{error: {code, message, hint}}` errors, JSON-first output preserved throughout. (`apps/cli`)
- **MCP server** now self-describing: workflow-sequencing resources, tool descriptions that explain *when* to call each tool relative to others, a generated tool catalog as the single source of truth for `docs/mcp-clients.md`, and — closing a real gap found during review — MCP tools for the full proposal lifecycle (`accept_proposal`, `reject_proposal`, `publish_branch`, `diff_proposal`, `inspect_proposal`, `list_proposal_artifacts`) that previously only existed as CLI commands. An agent can now do the entire workflow through MCP alone, no shell access required. (`apps/mcp-server`)
- **Website** now agent-crawlable: HTML pages generate from the root `docs/*.md` at build time (single source of truth, no more hand-transcribed drift), plus `llms.txt`/`llms-full.txt` and raw `.md` served directly. (`apps/docs-site`)
- **Root `AGENTS.md`** created as the file coding agents auto-load: capability ladder, MCP trust model, and the CLI/MCP-first workflow contract, moved out of this document.

**Daemon test flakiness — fixed (2026-08-01).** Root causes were: `DaemonClient`'s HTTP request timeout was a hardcoded 3s (too tight for a real daemon under load — also a latent production fragility, not just a test artifact — now 10s); vitest ran daemon-spawning integration/e2e tests with unbounded fork concurrency, so real child daemon processes starved each other for CPU (now capped at `maxForks: 4`); and the heaviest test cases in `process.test.ts`/`three-participant.e2e.test.ts` had tighter per-test timeouts than lighter cases in the same files — an inverted budget, not just contention — now rebalanced to match real cost.

**CLI-only pass — merged (2026-08-02).** The web dashboard was deleted outright and the product re-centred on the CLI. Four parallel workstreams, merged together with zero conflicts:

- **Website reduced** to landing + auth + docs. `apps/docs-site/dashboard/` is gone (~4,400 lines: dashboard, onboarding, spotlight tour, analytics, settings, invite redemption, live-feed WebSocket client and their tests). In its place, `apps/docs-site/auth/` serves `signin`, `signup`, `reset`, and the `cli.html` login-callback page. (`apps/docs-site`)
- **`crosscode login` became a browser flow** against the frozen contract above, with `--no-browser` and `--email`/`--password` preserved as the headless paths agents and CI use. New `apps/daemon/src/browser-login.ts` owns the loopback server, `state` check, CORS preflight, and timeout. (`apps/cli`, `apps/daemon`, `apps/mcp-server`)
- **VS Code extension deleted** along with its build wiring — root `build` script, `pnpm-workspace.yaml` build allowances for `@vscode/vsce-sign` and `keytar`, and 2,078 lines of lockfile. (`apps/vscode-extension`, removed)
- **Docs rewritten CLI-first** across `README.md`, this file, `AGENTS.md`, `CONTRIBUTING.md`, and `docs/`. (`docs/`)

What did **not** change, deliberately: the coordination service and every migration. Workspaces, memberships, invites, pairing codes, roles, RLS, presence, and billing are all still there and still tested — they lost their browser UI, not their existence. Known residue from this pass is tracked in [`docs/status/2026-08-02-cli-only-pass.md`](./docs/status/2026-08-02-cli-only-pass.md).

**Verification baseline (re-measured 2026-08-04).** Treat the numbers below as a dated observation, not a spec — run the commands rather than trusting the transcription. This paragraph sat at "25 files / 231 tests" for two days after the real figures moved, which is exactly the failure mode of hand-copied counts.

- `pnpm build` — `tsc --noEmit` under `strict`, then `scripts/build.mjs` bundles the three entrypoints to `dist/`. Passes.
- `pnpm test` — **30 files passed, 8 skipped (38); 352 tests passed, 39 skipped (391)**. The skips are the PostgreSQL-gated suites, which deliberately get no `CROSSCODE_TEST_DATABASE_URL` here.
- `pnpm test:postgres` — **8 files, 39 tests, none skipped.** Suites are discovered by the gate they read, and the run fails if a selected test reports as skipped rather than passed.
- `pnpm docs:build` — passes; emits the landing page, four auth pages, and eight docs pages.
- `docker build -f apps/service/Dockerfile -t crosscode-service .` — passes, and the container refuses to start without `DATABASE_URL`, as intended.

Node 24 is required (`engines.node`); the repo pins it and CI runs it.

**Phases 8/9/10 v1 — implemented (2026-08-02).** Invite-by-code/link, self-serve workspace creation, the autonomy slider, and a billing placeholder all landed together against the same hosted Supabase project this repo already used for dev. Detail and remaining gaps are under each phase below — none is fully "done" against its original exit criteria yet, but each has a working v1.

**Billing v2 — implemented (2026-08-04).** Phase 10's placeholder became a real Stripe
implementation: monthly/annual prices with annual as the default, `crosscode billing
upgrade|cancel|portal`, a signature-verified webhook, and a defined subscription lifecycle
whose governing rule is *never destroy, never hard-block*. See Phase 10 below for the
decisions and what is still outstanding (chiefly: the Stripe account itself).

## The plan

Three initiatives, in this order. Each is a precondition for the next in practice (tiers need something to meter; the autonomy slider is most valuable once a hosted service makes teams easy to form).

### Phase 8 — Hosted multi-tenant coordination service + frictionless team setup (v1 shipped)

**Problem:** the multiplayer feature — the actual point of the product — currently requires a team to stand up their own Supabase project, run migrations, and have an admin run `service:provision` with a service-role key to invite each member by email. That's not frictionless, and it undercuts the "open a folder, invite your team" vision.

**What's already there to build on:** the coordination service already does multi-tenant workspace isolation — every table is scoped by `workspace_id` with Postgres RLS as defense-in-depth, and Supabase Auth already handles member identity. The gap is *who operates the service* and *how people join*, not the underlying data model.

**Scope:**
- Crosscode runs one hosted, multi-tenant instance of the coordination service (you operate the Supabase project; teams no longer run their own).
- Self-serve workspace creation: opening a folder and connecting an agent creates a workspace against the hosted service automatically — no `service:provision`/admin step for the common case. Self-hosting stays available for teams who want it.
- Invite-by-code/link: a workspace owner generates a short-lived invite (`POST /v1/invites`), a teammate redeems it with `crosscode join --invite <code>` or `POST /v1/invites/:code/redeem`. There is no web redemption page — see the product-surface decision above.
- Reading workspace state — presence, tasks, claims, proposals, validation — is `crosscode status --json`, the equivalent MCP tools, and the existing REST/`/v1/stream` endpoints. There is deliberately no browser read model and no server-side aggregation endpoint.

**Real cost of this decision:** taking on hosting/ops/billing liability for other people's workspace metadata (proposals, diffs, task descriptions — not raw source unless proposals pass through) starting now, not deferred. Confirmed as the right tradeoff (2026-08-01) because it's what actually makes team setup frictionless — self-host-only doesn't solve the problem.

**Exit criteria:** a user creates an account, a workspace exists with zero manual service setup, they generate an invite, a teammate redeems it with one command, and both are coordinating through the same workspace within minutes.

**Shipped (v1):** self-serve `crosscode signup` (with an optional `--invite <code>`), invite create/list/revoke (`POST/GET/DELETE /v1/invites`) and redeem (`crosscode join --invite`, `POST /v1/invites/:code/redeem`), and self-serve `POST /v1/workspaces`. All running against the same Supabase project this repo already used for dev — "hosted" here means the code path exists and works against a real project, not that a separate production deployment/ops setup has been stood up yet.

**Onboarding (per [`docs/onboarding-contracts.md`](./docs/onboarding-contracts.md)).** Onboarding is the CLI: create an account on the site or with `crosscode signup`, `crosscode login`, `crosscode init`, `crosscode join`. Signup auto-provisions a personal workspace (Contract C), so nothing gates on creating a team. The pairing-code flow (Contract A) survives as a way to attach a checkout to a workspace without a login at all — mint with `POST /v1/pairing-codes`, redeem with `crosscode join --pair <code>`.

### Phase 9 — Autonomy slider (auto-apply vs. always-approve) (v1 shipped)

**Problem:** today, every proposal requires an explicit `accept`. Some users want that; some want closer to real-time (Google-Docs-adjacent) sync and are fine trusting validation + semantic review to catch what a human eye would've caught.

**Scope:** a per-workspace (or per-path) policy setting on top of the existing accept/reject flow — not a rewrite of it. A proposal is still created, classified, and validated identically; the policy controls whether `accept` fires automatically. Discrete tiers, not a continuous slider, because "how automatic" needs to map to testable conditions:

1. **Always ask** (today's behavior, default).
2. **Auto-apply if clean** — no path/claim overlap, validation passes, classified `independent` or `likely-compatible`.
3. **Auto-apply always** — everything except what Fundamental Rule 4 forbids (high/critical risk always requires approval, no exceptions, no policy override).

**Dependency:** tier 2+ should require semantic review to be enabled for the workspace — auto-apply is trusting the reviewer to catch what a human would've, so it shouldn't be available below the tier that includes review. This also gives the pricing tiers below a natural feature boundary.

**Exit criteria:** a workspace can configure its autonomy tier, tier 2/3 proposals materialize without a human calling `accept`, Fundamental Rule 4 is provably never bypassed regardless of tier, and switching tiers takes effect without restarting the daemon.

**Shipped (v1):** `workspaces.autonomy_tier` (0/1/2), `GET/PUT /v1/workspace/autonomy` (owner-only to set), `crosscode workspace autonomy get|set` plus matching MCP tools, and the daemon's existing local `autoApplyRisk` mechanism extended to also honor the workspace's synced tier — refreshed on each sync cycle, no daemon restart required. Every auto-apply attempt still routes through the same unchanged `accept()` → `assertApplicable`/`assertChangeApplicable` gate, which is the sole enforcement point for Fundamental Rule 4; a dedicated regression test proves a critical-risk proposal is never auto-applied at tier 2. One known gap: tier ≥1 requiring semantic review enabled is currently enforced client-side in the daemon (against the committed `.crosscode/config.yaml`), not server-side in the `PUT` handler, because the service has no visibility into that git-committed file — worth revisiting once review policy has a service-side home.

### Phase 10 — Tiered pricing & billing (Stripe implemented; account setup pending)

**Billing provider:** Stripe. `StripeBillingProvider` (`apps/service/src/stripe.ts`) implements
the `BillingProvider` interface against Stripe's REST API; `StubBillingProvider` remains the
default for deployments with no key. A live Stripe account and its price ids are the only
things left before real money moves.

**Objective:** maximize user count, free and paid. Revenue only has to keep hosting from
running at a loss; it is not the optimization target.

**Metering axes.** Two candidate axes were considered and rejected as walls:

- **Semantic review calls/month** — *rejected.* It reads like the direct cost driver, but
  review is delegated to the workspace member's own already-connected MCP agent and never
  leaves their machine, so it costs Crosscode nothing. Metering it would mean adding a
  network round-trip before every local review purely to bill for it. Uncapped on every
  plan, free included — and marketable: unlimited AI conflict review, on your own agent,
  code never leaves your machine.
- **Seats** — *rejected below Team.* A workspace gets more valuable the more people are in
  it, and the invite/pairing flow is the growth loop. Charging per head below the org tier
  taxes exactly the behaviour we want. Seat caps stay only as abuse guards.

The axes actually used:

- **History retention** — bounds `operations`, the only table that grows without limit.
  This is the real cost governor.
- **Autonomy tier availability** — auto-always (Phase 9) is the "I trust it now" moment,
  which is the honest point to ask for money.
- **Org controls** — SSO, audit export, SLA. What organizations actually buy.

**Tiers:**

| Tier | Monthly | Annual | Seats | History | Autonomy | Org controls |
| --- | --- | --- | --- | --- | --- | --- |
| Free | $0 | $0 | 5 | 7 days | always-ask, auto-if-clean | — |
| Essential | $2.50/mo | $25/yr | 10 | 30 days | all | — |
| Pro | $5.00/mo | $50/yr | 25 | 90 days | all | — |
| Unlimited | $7.50/mo | $75/yr | unlimited | 365 days | all | — |
| Team | $5.00/seat/mo | $50/seat/yr | unlimited | 365 days | all | SSO, audit export, SLA |
| Student | $2.50/mo | $25/yr | 25 (Pro-level) | 90 days (Pro-level) | all | — |

Annual is twelve months for the price of ten on every row. Semantic review is unlimited on
every row, so it is not a column. Limits live in `PLAN_LIMITS` and prices in `PLAN_PRICING`,
both in `apps/service/src/billing.ts`; the Stripe Price ids that back them are deployment
configuration (`CROSSCODE_STRIPE_PRICES`), never committed.

Student tier requires real verification (e.g. SheerID or `.edu`-gated flow) to avoid resale
abuse, which does not exist yet — so `POST /v1/workspace/billing/checkout` **refuses
`student` outright** (403) rather than selling Pro's limits at Essential's price to anyone
who asks. It stays an out-of-band grant until the verification flow lands.

**Deliberate tradeoff:** Unlimited ($7.50) has unlimited seats, so it undercuts Team from
two seats up. That is intended under a user-count objective — Team is differentiated by org
controls, not seat count. Revisit by changing numbers in `PLAN_PRICING`/`PLAN_LIMITS` if the
economics ever stop working.

**Billing note:** at $2.50/mo Stripe takes $0.30 + 2.9% ≈ 15% of revenue; at $25/yr it is
~4%. Annual billing is not a nice-to-have at these price points, and it is not treated as
one: `DEFAULT_BILLING_INTERVAL` is `year`, `startCheckoutRequestSchema.interval` defaults to
`year`, and the CLI's opt-out flag is `--monthly` rather than an opt-in `--annual`. A caller
that says nothing buys the annual plan.

#### Where upgrading happens

In the CLI, per the CLI-first product-surface decision above: the website stays landing,
auth, and docs, and gains no billing UI. What the browser is used for is Stripe's own hosted
Checkout and Billing Portal pages, which is where a card can safely be typed.

| Command | Endpoint | Behavior |
| --- | --- | --- |
| `crosscode billing status` | `GET /v1/workspace/billing` | Plan, limits, subscription state, grace deadline, who pays. |
| `crosscode billing upgrade --plan <p> [--monthly] [--seats n]` | `POST /v1/workspace/billing/checkout` | No subscription yet → a Stripe Checkout URL, opened in a browser (`--no-browser` prints it). An existing subscription → moved in place with proration, in **either** direction, because Checkout can only *create* subscriptions and sending someone back through it would leave the workspace paying twice. |
| `crosscode billing cancel` | `POST /v1/workspace/billing/cancel` | `cancel_at_period_end`, never an immediate delete. |
| `crosscode billing portal` | `POST /v1/workspace/billing/portal` | Stripe-hosted card/invoice management. |

All four are owner-only and Supabase-session-only: a `ccw_` workspace token reaches the
daemon ingest/read surface and can never spend money.

#### The webhook (`POST /v1/webhooks/stripe`)

The one unauthenticated write route in a service that authenticates everything else, and
the only one that is not also single-use (unlike the pairing claim). Stripe holds no
Crosscode credential, so the request signature *is* the credential. Four independent
defenses, each covered by a test in `apps/service/src/stripe.test.ts` and `http.test.ts`:

1. **The route does not exist without a signing secret.** No `CROSSCODE_STRIPE_WEBHOOK_SECRET`
   → 404, not a weakened check. `main.ts` requires the secret whenever a Stripe key is set.
2. **Signature verified over the raw bytes, before parsing.** `verifyStripeSignature()`
   recomputes HMAC-SHA256 over `<timestamp>.<body>` and compares constant-time against every
   `v1=` entry (there are several during a secret rotation). A malformed header — no `t`, no
   `v1` — is a refusal, not a fall-through. An unsigned body never reaches `JSON.parse`, let
   alone a write.
3. **Replay is bounded to five minutes** by the signed timestamp's tolerance, checked in both
   directions, and then to *once* by `billing_events`, which records Stripe's event id.
   `processed_at` is set only after the handler succeeds, so a delivery that died halfway is
   retried rather than swallowed.
4. **The event is a signal, not a fact.** The handler takes the subscription id out of the
   body and re-reads that subscription's authoritative state from Stripe before writing.
   Out-of-order delivery, redelivery, and replay therefore all converge on the same write —
   a stale "upgraded to pro" event that arrives after a cancellation cannot resurrect the
   plan. The workspace is resolved from the database's own customer/subscription mapping;
   `client_reference_id`/`metadata` are consulted only when no mapping exists yet, and only
   if they parse as a workspace id. A workspace that cancelled and bought again has a dead
   subscription still emitting for a while, so `applySubscriptionState` additionally refuses
   any event about a subscription that is not the workspace's current one while that current
   one is live — otherwise a delayed final invoice for the old subscription would take the
   plan the user just paid for straight back off them.

#### Lifecycle decisions

Previously undefined; the only stated requirement was that downgrade and cancellation must
not destroy workspace data. The rule underneath all of them is **never destroy, never
hard-block** — a plan change costs a capability, never access or history.

`workspaces.plan` is the *effective* plan and the single thing every limit is enforced
against. `workspaces.billing_plan` is what is being paid for. They differ only during a
grace period. `applySubscriptionState()` in `store.ts` is the sole write path for both, and
`EFFECTIVE_PLAN_SQL` applies a lapsed grace deadline at read time, so enforcement never
waits on a sweep.

- **Downgrade below the current seat count** → existing members keep working; the *next*
  seat is refused with 402. Nothing counts, disables, or evicts anybody: the cap is checked
  only inside the transaction that would add a member (`assertSeatAvailable`).
- **Downgrade shrinking retention** → each operation carries `operations.retention_days`,
  stamped from the plan in effect *when the row was written*, and
  `pruneWorkspaceOperations` measures each row against its own window instead of the
  workspace's current plan. Shrinking the window stops history being *extended*; it never
  retroactively deletes what was already promised.

  This is where this workstream met the retention one (#35), which shipped first and swept
  against the current plan — so a Pro→Essential downgrade would have deleted 60 days of
  history the workspace had been promised. Reconciling the two needed more than swapping the
  column in, because #35's cursor watermark depends on deletion removing a *prefix* of the
  sequence, and per-row windows let an expired row sit above a live one. The cutoff is
  therefore the sequence just below the **oldest still-live** row rather than the newest
  expired one: identical whenever one window applies to everything, and strictly more
  conservative the moment two do. A leftover NULL `retention_days` COALESCEs to the current
  plan's window, which is exactly #35's behavior, so nothing can outlive what it would have.
- **Payment failure** → a 14-day grace period during which every paid limit is retained
  (`PAYMENT_GRACE_PERIOD_DAYS`; chosen to outlast Stripe's first dunning retries, so a
  replaced card costs nobody anything). The deadline is set once by the first failure and is
  never pushed out by repeated failure events. When it lapses the workspace falls to Free's
  *limits*; members, history, replicas, tokens and settings all survive. A later successful
  payment clears the deadline and restores everything.
- **Auto-always on downgrade** → clamped to auto-if-clean, never an error. Clamped on the
  write path (`autonomy_tier = LEAST(autonomy_tier, …)`) and again on the read path
  (`getWorkspaceAutonomyTier`), which is what the daemon syncs its policy from — so a grace
  period that lapses between sweeps cannot leave a workspace auto-applying on a plan that no
  longer unlocks it. This closed a real hole: before, a downgrade left `autonomy_tier = 2`
  set and only *new writes* were gated.
- **Who pays** → the workspace, not the person. The Stripe customer is keyed by workspace id
  and the subscription belongs to the workspace; `billing_owner_member_id` is a label for
  receipts and display. When that member leaves, `disableMember` reassigns it to the
  longest-tenured remaining active owner and audits the change — the subscription is not
  touched, and a workspace can never lose its last owner anyway.
- **Team per-seat proration** → the subscription quantity tracks the active member count.
  `reconcileSeatQuantity` runs after an invite redemption or a member removal and lets Stripe
  compute the mid-cycle credit or charge (`proration_behavior: create_prorations`); there is
  deliberately no arithmetic on our side. It never throws — nobody should be unable to remove
  a member because Stripe is unreachable — and a missed call self-corrects on the next
  membership or plan change.

`pnpm service:billing-sweep` (`apps/service/src/billing-sweep.ts`) writes lapsed grace
periods down durably and audits them. Run it daily. It is not load-bearing for enforcement,
only for making the stored plan agree with what is already being enforced.

**Configuration** (all secrets, supplied by the host): `CROSSCODE_STRIPE_SECRET_KEY`,
`CROSSCODE_STRIPE_WEBHOOK_SECRET`, `CROSSCODE_STRIPE_PRICES` (one JSON object mapping each
plan/interval to its Stripe Price id — one secret rather than ten variables, because ten is
what makes an operator get one wrong and only find out at checkout),
`CROSSCODE_STRIPE_SUCCESS_URL`, and optionally `CROSSCODE_STRIPE_CANCEL_URL`,
`CROSSCODE_STRIPE_PORTAL_RETURN_URL`, `CROSSCODE_STRIPE_API_VERSION`. Setting none of them
leaves the service with no billing surface at all, which is the right shape for a
self-hoster.

**Design intent:** the free tier should comfortably fit a real small team (see the product-scope decision above) rather than tease them into upgrading — 5 seats is a whole team, not a trial. The first real friction point should be growing past that team, wanting a longer history to look back through, or wanting conflicts to auto-resolve, never an artificial cap.

**Exit criteria:** Stripe account exists and is wired to workspace creation/upgrade; each tier's caps are enforced server-side (not just UI-hidden); student verification flow works; downgrade/cancellation doesn't destroy workspace data.

**Shipped (v1, placeholder — 2026-08-02):** `workspaces.plan` (free/essential/pro/unlimited/team/student) plus then-unused `stripe_customer_id`/`stripe_subscription_id` columns, a `usage_counters` table metering semantic review calls/month, a `BillingProvider` interface with a `StubBillingProvider`, and `assertSeatCapAvailable`/`assertSemanticReviewCallAvailable`/`assertPlanAllowsAutonomyTier` enforcement helpers plus a read-only `crosscode billing status` that reports the plan's `historyRetentionDays`. `assertPlanAllowsAutonomyTier` and `assertSeatCapAvailable` are enforced end-to-end in `apps/service/src/store.ts` — the former on the autonomy-tier write path, the latter inside the transaction that adds a member — and both answer `402`.

**Shipped (v2, real provider — 2026-08-04):** `StripeBillingProvider` against the existing
`BillingProvider` seam, with monthly and annual prices and annual as the default everywhere;
`crosscode billing upgrade|cancel|portal` over three owner-only service routes; the
signature-verified, idempotent, replay-safe webhook described above; and the full lifecycle
above, backed by migration `012_billing_lifecycle.sql` (grace-period and subscription state
on `workspaces`, a `billing_events` replay ledger, `operations.retention_days`) plus
`apps/service/src/billing-lifecycle.integration.test.ts`, which exercises each decision
against real PostgreSQL — including that the members, history, and settings are all still
there afterwards.

Stripe is reached with `fetch` and `node:crypto` rather than the official SDK. The provider
is six calls, and taking `fetchImpl` as an option makes every one testable offline against
an exact expected request body; the alternative was no coverage at all until someone pointed
it at a live account. The cost is that `verifyStripeSignature()` reimplements Stripe's
signature scheme, which is why it is small, constant-time, and has a test for each way it
must refuse.

**Not yet done:**

- The Stripe account itself: the code path is complete and tested, but no live account,
  Price ids, or webhook endpoint exist yet, so no real card has moved a workspace between
  plans. Standing one up is configuration (`CROSSCODE_STRIPE_*`), not code.
- **Student verification.** Self-serve checkout refuses `student` (403) until a real
  verification flow exists; the tier's limits are implemented and can be granted out of band.

**Free-tier abuse guards (shipped alongside the generous free plan):**

- `MAX_SELF_SERVE_WORKSPACES_PER_USER` (10) caps how many workspaces one account can create,
  enforced inside `createWorkspace`'s transaction behind a per-user advisory lock so
  concurrent creates cannot race past it. Plans are per-workspace, so without this an
  account could farm unlimited free workspaces as free storage. The Contract C personal
  workspace comes from `ensurePersonalWorkspace()` and is deliberately not counted.
- Rate limiting is two-layered: a coarse pre-auth per-IP ceiling (3000/min) as a flood
  guard, and the real quota charged per authenticated identity (600/min, 30/min for replica
  registration) in `verifyToken`/`authenticate`. Per-IP alone was wrong in both directions —
  too loose for one abusive account, and too tight for an office or CI fleet behind one NAT
  address, where daemons throttled each other. `POST /v1/pairing-codes/claim` stays per-IP
  at 10/min: it is unauthenticated, so there is no identity to charge, and that limit is the
  brute-force defense for the 40-bit code space.

**Retention is enforced** (option (b) of the two designs sketched here previously).
`PgStore.pruneOperationsByRetention()` deletes each workspace's operations outside
`PLAN_LIMITS[plan].historyRetentionDays` and records how far it reached in
`workspaces.operations_pruned_through`. `GET /v1/operations` answers a cursor below that
watermark with an explicit `cursor-too-old` resync status (`410 Gone` for daemons that
predate it) instead of a truncated page, and the daemon adopts the watermark and reports
the gap — see docs/protocol.md. The sweep runs on a service-side interval configured with
`CROSSCODE_RETENTION_DATABASE_URL` (the request-serving role deliberately cannot delete
operations); `pnpm service:prune` runs it manually. Content is also no longer stored
twice: `operations.event` is the single home of a transaction's file bodies, and
`operation_files` is a per-path index into it.

`assertSemanticReviewCallAvailable` is deliberately left unwired rather than pending: semantic review is delegated to the member's own MCP agent and never reaches the service, so there is no per-call cost to meter, and wiring it would mean adding a network round-trip before every local review purely to bill for it (see the comment above `incrementSemanticReviewUsage` in `apps/service/src/billing.ts`). Every plan now carries an unlimited cap for it, so it can never fire.

### Phase 11 — Pairing a checkout to an account (backend v1 shipped)

**Problem:** nothing linked a local MCP/daemon install to a cloud account, so the first
thing a new user did was set up a team they didn't have yet.

**Shape:** signup auto-provisions a personal workspace, and a one-time pairing code binds
a local checkout to it — verified, not assumed. Explicit team creation is an ordinary
later action, never a gate. The frozen contracts live in `docs/onboarding-contracts.md`.

**Shipped (backend v1, Contracts A and C):**

- `POST /v1/pairing-codes` (Supabase JWT + workspace header) → `{ code, expiresAt, pairingId }`.
  Codes are `XXXX-XXXX` Crockford base32, 15-minute TTL, single-use, stored only as a SHA-256 hash.
- `GET /v1/pairing-codes/:pairingId` (Supabase JWT + workspace header) → `{ status, claimedAt, replicaId, actorId }`
  where status is `pending | claimed | expired`. Whoever minted the code polls this to
  confirm the claim.
- `POST /v1/pairing-codes/claim` — **unauthenticated**, the code is the credential. Returns
  `{ workspaceId, replicaId, token, projectId }`, where `token` is a `ccw_` workspace
  service token and `projectId` is null until the projects workstream populates it.
  Claiming is a single atomic conditional UPDATE; already-claimed, expired, and unknown
  codes all return an identical 410 so the endpoint is not an oracle. Rate limited to
  10 attempts/minute/IP.
- Workspace service tokens (`ccw_` + 32 random bytes base64url, SHA-256 hashed in
  `workspace_tokens`): the bearer auth now accepts either a Supabase JWT or one of these.
  A `ccw_` token resolves to its own workspace and reaches only the daemon ingest/read
  surface — it is rejected on `/v1/workspaces`, `/v1/memberships`, `/v1/invites`, and
  `/v1/pairing-codes`, so a terminal-side credential can never act as the user.
- Contract C: `workspaces.is_personal` / `members.is_personal`, and a user with zero
  memberships is auto-provisioned a personal workspace plus an owner membership on their
  first `GET /v1/memberships`. A partial unique index on `members(user_id) WHERE is_personal`
  makes that idempotent under concurrent requests, so the list is never empty.
- `crosscode join --pair <code> [--service <url>] [--replica-name <name>]` redeems a code
  from a local checkout and persists the returned workspace token into the 0600
  `.git/crosscode/config.json`. It needs no prior `crosscode init` and no login; the daemon
  uses that token for HTTP sync and falls back to polling (live sync over `/v1/stream`
  still requires a Supabase session).

Migration `009_pairing.sql` adds `pairing_codes` and `workspace_tokens`, and narrows
`members.user_id` from globally UNIQUE to unique per workspace — the old constraint capped
every account at one workspace for life, which Contract C's "personal workspace now, team
later" flow cannot live with.

**Verification:** `pnpm service:migrate` against an empty database, plus
`pnpm test` and (with `CROSSCODE_TEST_DATABASE_URL` set) `pnpm test:postgres`, which now
includes `apps/service/src/pairing.integration.test.ts`.

**Not in this workstream:** projects (Contract B), delivered separately as Phase 12.

### Phase 12 — Projects (repository entity) (backend shipped)

Until now `workspaces` was the only container, so there was no way to attribute
activity to the repository it came from. A **project** is a repository inside a workspace,
keyed by its normalized git remote when the checkout has one and by its absolute repo root
otherwise (see Contract B in `docs/onboarding-contracts.md`).

**Endpoints (service, all workspace-scoped via the `x-crosscode-workspace-id` header):**

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/projects` | `{ projects: Project[] }`, newest activity first. |
| `POST` | `/v1/projects` | Idempotent upsert from `{ repoRoot?, repoRemote? }` (at least one required); returns the `Project` with 200. |
| `GET` | `/v1/projects/:id` | The single `Project`; 404 for an unknown id **and** for one belonging to another workspace. |

`POST /v1/replicas` additionally accepts optional `repoRoot`/`repoRemote` and returns
`projectId`, so a daemon is attributed to its repository at registration time. The daemon
reports both automatically from the checkout it was started in.

**`projectId` on the existing read paths.** Storing the attribution is only half of it —
consumers group activity per project, so every read path that carries a replica or an
operation carries a nullable `projectId` too:

| Path | Field |
| --- | --- |
| `GET /v1/operations` | `operations[].projectId` (`remoteOperationSchema`) |
| `GET /v1/presence` | `sessions[].projectId` (`PresenceSummary`) |
| `/v1/stream` operation frame | `operation.projectId` |
| `/v1/stream` presence frame | `presence.projectId` (`presenceUpdateSchema`) |
| `POST /v1/replicas` | `projectId` |

Null everywhere means "unattributed" — pre-projects data, or a replica that reported no
repository — and consumers group those under "Unassigned". The presence frame carries it
because a consumer merges live updates into the `GET /v1/presence` snapshot; without it a
replica that connects after the initial load would silently lose its attribution.

**Schema (`010_projects.sql`):** a `projects` table with two partial unique indexes
(`(workspace_id, repo_remote)` when a remote exists, `(workspace_id, repo_root)` when it
does not — a plain `UNIQUE` would treat NULL remotes as distinct and allow unlimited
duplicates), plus nullable `project_id` columns on `replicas` and `operations`. Backfill is
deliberately skipped: NULL means "recorded before projects existed", and consumers group
those under "Unassigned". `operations.project_id` is derived server-side from the sending
replica, never from the client.

**Normalization** (`apps/service/src/projects.ts`, the dedup key): lowercase host, drop
credentials and port, convert `git@host:owner/repo` to `host/owner/repo`, strip a trailing
`.git` and trailing slashes. Path case is preserved, since repository paths are
case-sensitive.

## Non-goals (still true)

- A new code editor/IDE, or a replacement Git host/implementation.
- Character-by-character CRDT/OT live editing — proposals stay reviewable units, even at the most automatic autonomy tier.
- Automatic force-push, rebase, reset, or commit on a user's active branch, ever.
- A web UI for coordination work. Materializing a change into a working tree requires local filesystem access, which a browser does not have (Fundamental Rule 1); accept/reject/publish are daemon-only, and the rest of the surface follows the CLI-first decision above.
- An editor extension for any editor. MCP is the one integration contract.
- Deep bespoke integrations with every commercial agent — MCP is the one contract.

## Where implementation detail lives

- Architecture, daemon/service responsibilities, data model: `docs/architecture.md`
- Wire protocol, event schemas: `docs/protocol.md`
- MCP tool catalog and client setup: `docs/mcp-clients.md`
- Security/threat model: `docs/security.md`
- Agent-facing contract, capability ladder, MCP trust model: `AGENTS.md`
- Setup, current feature list, safety model: `README.md`
