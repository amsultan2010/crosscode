# Crosscode — Build Instructions & Roadmap

This document is a living reference: **current status** and **the plan**. It is deliberately not a full spec — implementation detail lives in the code and in `docs/architecture.md`, `docs/protocol.md`, `docs/mcp-clients.md`, `docs/security.md`, `README.md`, and `AGENTS.md`. Read those for how things work; read this for what's done and what's next.

## What Crosscode is

A local-first coordination layer for people and coding agents working in separate checkouts of the same Git repo. A daemon watches filesystem/Git activity, captures edits as durable transactions, and exchanges them through a coordination service. Remote work always arrives as a reviewable proposal — never auto-written into a checkout — and Git remains the durable history/publishing layer. Full product framing: `README.md`. Agent-facing contract (capability ladder, trust model, CLI/MCP-first positioning): `AGENTS.md`.

**Product-surface decision (2026-08-02): Crosscode is a CLI-first product.** The product surface is the daemon, the MCP server, and the CLI. The website is a landing page, sign-up/sign-in (including the `crosscode login` callback page), and the generated docs — nothing else lives behind auth. Two consequences, both deliberate:

- **There is no web dashboard**, and no web UI for teams, invites, settings, onboarding, analytics, or a live feed. The multi-tenant backend is untouched: workspaces, memberships, invites, pairing codes, roles, RLS, presence, and billing all still exist in `apps/service` and in the SQL migrations. They are reached from the CLI and the HTTP API. "Deleted" applies to the browser UI, never to the service.
- **There is no editor extension.** Editors and agents integrate through MCP, which is the one integration contract.

**Product-scope decision (2026-08-01): Crosscode has no standalone solo use case.** The whole point is coordinating concurrent editors on a repo. One person running one agent alone has nothing to coordinate with, and shouldn't be the product's framing or free-tier target. The one legitimate non-team case is **one person running multiple concurrent agents** (e.g. Claude in one worktree, Codex in another, same repo) — that's still real multi-party coordination, just intra-person. Design free-tier/messaging around "coordinate concurrent editors, human or agent," not "useful even completely alone."

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
- It opens the browser at `${WEB_URL}/auth/cli.html?port=<port>&state=<state>`, where `WEB_URL` comes from `--web <url>`, else `CROSSCODE_WEB_URL`, else the production default.
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

**Verification baseline:** TypeScript build passes; full vitest suite passes cleanly and repeatably (24 test files, 204 tests, 6 skipped pending `CROSSCODE_TEST_DATABASE_URL`); `pnpm audit --audit-level high` clean; docs-site builds; CLI/MCP manually smoke-tested.

**Phases 8/9/10 v1 — implemented (2026-08-02).** Invite-by-code/link, self-serve workspace creation, the autonomy slider, and a billing placeholder all landed together against the same hosted Supabase project this repo already used for dev. Detail and remaining gaps are under each phase below — none is fully "done" against its original exit criteria yet, but each has a working v1.

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

### Phase 10 — Tiered pricing & billing (placeholder v1 shipped)

**Billing provider:** Stripe (account setup pending — not yet created).

**Metering axes** (chosen to track cost and value together, not project count — a solo user with many small projects isn't costing more or getting more value than one with one project):

- **Semantic review calls/month** — direct cost driver (LLM usage via the workspace member's connected agent).
- **Seats / active workspace members** — the axis that makes it a team tool.
- **Autonomy tier availability** — tier 2/3 auto-apply (Phase 9) gated to paid plans, since it depends on semantic review anyway.

**Tiers (draft, subject to real usage data once Phase 8 ships):**

| Tier | Price | Semantic review | Autonomy | Seats |
| --- | --- | --- | --- | --- |
| Free | $0 | Off | Always-ask only | Small team cap |
| Essential | $5/mo | On, capped calls/mo | Always-ask only | Small cap (e.g. 3) |
| Pro | $10/mo | Higher cap | Auto-apply-if-clean unlocked | Higher cap |
| Unlimited | $15/mo | Unlimited | All tiers unlocked | Unlimited |
| Student | Essential price | Pro-level features | Pro-level | Pro-level |

Student tier requires real verification (e.g. SheerID or `.edu`-gated flow) to avoid resale abuse.

**Design intent:** the free→paid wall should be hit naturally through wanting to collaborate — free tier should be good enough that a solo multi-agent user (see the solo-use decision above) likes it, and the first real friction point is inviting teammate #2 or wanting a conflict to auto-resolve, not an artificial cap.

**Exit criteria:** Stripe account exists and is wired to workspace creation/upgrade; each tier's caps are enforced server-side (not just UI-hidden); student verification flow works; downgrade/cancellation doesn't destroy workspace data.

**Shipped (v1, placeholder):** `workspaces.plan` (free/essential/pro/unlimited/student) plus unused-until-real-key `stripe_customer_id`/`stripe_subscription_id` columns, a `usage_counters` table metering semantic review calls/month, a `BillingProvider` interface with a `StubBillingProvider` (no real Stripe account exists yet, so no `stripe` package dependency was added), and `assertSeatCapAvailable`/`assertSemanticReviewCallAvailable`/`assertPlanAllowsAutonomyTier` enforcement helpers plus a read-only `crosscode billing status`. **Not yet done:** wiring those assert helpers into the actual invite-redeem/workspace-creation/autonomy-tier-set call sites (they exist and are unit-tested in isolation but aren't enforced end-to-end yet), and the Stripe account itself.

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
