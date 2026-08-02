# Crosscode — Build Instructions & Roadmap

This document is a living reference: **current status** and **the plan**. It is deliberately not a full spec — implementation detail lives in the code and in `docs/architecture.md`, `docs/protocol.md`, `docs/mcp-clients.md`, `docs/security.md`, `README.md`, and `AGENTS.md`. Read those for how things work; read this for what's done and what's next.

## What Crosscode is

A local-first coordination layer for people and coding agents working in separate checkouts of the same Git repo. A daemon watches filesystem/Git activity, captures edits as durable transactions, and exchanges them through a coordination service. Remote work always arrives as a reviewable proposal — never auto-written into a checkout — and Git remains the durable history/publishing layer. Full product framing: `README.md`. Agent-facing contract (capability ladder, trust model, CLI/MCP-first positioning): `AGENTS.md`.

**Product-scope decision (2026-08-01): Crosscode has no standalone solo use case.** The whole point is coordinating concurrent editors on a repo. One person running one agent alone has nothing to coordinate with, and shouldn't be the product's framing or free-tier target. The one legitimate non-team case is **one person running multiple concurrent agents** (e.g. Claude in one worktree, Codex in another, same repo) — that's still real multi-party coordination, just intra-person. Design free-tier/messaging around "coordinate concurrent editors, human or agent," not "useful even completely alone."

**Fundamental rules** (unchanged, non-negotiable):

1. The local filesystem is always authoritative for local work.
2. Remote operations arrive as proposals and are never automatically applied without a policy decision (see the autonomy-slider plan below — "automatic" is now a configurable policy, not a removal of this rule).
3. Every materialization re-checks the local base and creates a checkpoint first.
4. High-risk/critical changes always require explicit approval regardless of any policy setting.

## Current status

**Core coordination engine — complete and tested.** Per-worktree daemon (SQLite event log, hidden Git checkpoints, crash-safe materialization, Git-transition detection), a Supabase-Postgres-backed coordination service (authenticated sync, live WebSocket fan-out, audit log), deterministic conflict classification plus an AST-based TypeScript dependency graph, validation-gated publish, and a real (non-mock) AI semantic reviewer (`AgentDelegatedReviewer`, delegates to the workspace member's own connected MCP agent — no external AI provider). Auto-triggers at classification time, not just on demand. See `docs/architecture.md` for the full design and `README.md`'s "What works today" for the exact feature list.

**Agent-first surface pass — complete (2026-08-01).** Four parallel workstreams closed the gap between "supports agents" and "designed for agents to prefer":

- **CLI** rewritten on `commander`: proper `--help`, a `commands --json` machine-readable catalog, structured `{error: {code, message, hint}}` errors, JSON-first output preserved throughout. (`apps/cli`)
- **MCP server** now self-describing: workflow-sequencing resources, tool descriptions that explain *when* to call each tool relative to others, a generated tool catalog as the single source of truth for `docs/mcp-clients.md`, and — closing a real gap found during review — MCP tools for the full proposal lifecycle (`accept_proposal`, `reject_proposal`, `publish_branch`, `diff_proposal`, `inspect_proposal`, `list_proposal_artifacts`) that previously only existed as CLI commands. An agent can now do the entire workflow through MCP alone, no shell access required. (`apps/mcp-server`)
- **Docs site** now agent-crawlable: HTML pages generate from the root `docs/*.md` at build time (single source of truth, no more hand-transcribed drift), plus `llms.txt`/`llms-full.txt` and raw `.md` served directly. (`apps/docs-site`)
- **Root `AGENTS.md`** created as the file coding agents auto-load: capability ladder, MCP trust model, and the CLI/MCP-first workflow contract, moved out of this document.

**Daemon test flakiness — fixed (2026-08-01).** Root causes were: `DaemonClient`'s HTTP request timeout was a hardcoded 3s (too tight for a real daemon under load — also a latent production fragility, not just a test artifact — now 10s); vitest ran daemon-spawning integration/e2e tests with unbounded fork concurrency, so real child daemon processes starved each other for CPU (now capped at `maxForks: 4`); and the heaviest test cases in `process.test.ts`/`three-participant.e2e.test.ts` had tighter per-test timeouts than lighter cases in the same files — an inverted budget, not just contention — now rebalanced to match real cost.

**Verification baseline:** TypeScript build passes; full vitest suite passes cleanly and repeatably (24 test files, 204 tests, 6 skipped pending `CROSSCODE_TEST_DATABASE_URL`); `pnpm audit --audit-level high` clean; docs-site (including the dashboard) builds; CLI/MCP manually smoke-tested.

**Phases 8/9/10 v1 — implemented (2026-08-02).** Invite-by-code/link, self-serve workspace creation, the autonomy slider, a billing placeholder, and a web dashboard all landed together against the same hosted Supabase project this repo already used for dev. Detail and remaining gaps are under each phase below — none of the three is fully "done" against its original exit criteria yet, but each has a working v1.

## The plan

Three initiatives, in this order. Each is a precondition for the next in practice (tiers need something to meter; the autonomy slider is most valuable once a hosted service makes teams easy to form).

### Phase 8 — Hosted multi-tenant coordination service + frictionless team setup (v1 shipped)

**Problem:** the multiplayer feature — the actual point of the product — currently requires a team to stand up their own Supabase project, run migrations, and have an admin run `service:provision` with a service-role key to invite each member by email. That's not frictionless, and it undercuts the "open a folder, invite your team" vision.

**What's already there to build on:** the coordination service already does multi-tenant workspace isolation — every table is scoped by `workspace_id` with Postgres RLS as defense-in-depth, and Supabase Auth already handles member identity. The gap is *who operates the service* and *how people join*, not the underlying data model.

**Scope:**
- Crosscode runs one hosted, multi-tenant instance of the coordination service (you operate the Supabase project; teams no longer run their own).
- Self-serve workspace creation: opening a folder and connecting an agent creates a workspace against the hosted service automatically — no `service:provision`/admin step for the common case. Self-hosting stays available for teams who want it.
- Invite-by-code/link: a workspace owner generates a short-lived invite (from CLI/MCP, since that should be the frictionless path for someone already in their agent), a teammate redeems it either in the web dashboard (click to join, Supabase Auth handles account creation) or via `crosscode join --invite <code>`.
- Web dashboard v1 (folds in the previously-separate "Phase 8 dashboard" plan): sign in, see live presence/tasks/claims/proposals/validation status for a workspace by subscribing to the existing `/v1/stream` WebSocket and reading existing REST endpoints — no new service-side read model needed. Redeem invites here. Task/claim/intent writes go through the same authenticated API the daemon already uses.
- **Explicitly deferred within this phase:** proposal accept/reject and anything that materializes changes into a participant's working tree stays daemon-only (a browser has no local filesystem access — this is Fundamental Rule 1). "Accept from the dashboard" needs a new remote-command channel (service → daemon) that doesn't exist yet; that's a distinct follow-up once read-only + invites + task management are proven.

**Real cost of this decision:** taking on hosting/ops/billing liability for other people's workspace metadata (proposals, diffs, task descriptions — not raw source unless proposals pass through) starting now, not deferred. Confirmed as the right tradeoff (2026-08-01) because it's what actually makes team setup frictionless — self-host-only doesn't solve the problem.

**Exit criteria:** a user opens a folder in their agent, a workspace exists with zero manual service setup, they generate an invite, a teammate joins from the dashboard with just an email, and both are coordinating through the same workspace within minutes.

**Shipped (v1):** self-serve `crosscode -- signup` (with an optional `--invite <code>`), invite create/list/revoke/redeem (CLI + `POST/GET /v1/invites`, `POST /v1/invites/:code/redeem`), self-serve `POST /v1/workspaces`, and a read-only web dashboard (`apps/docs-site/dashboard`, served at `/dashboard` on the same build/deploy as the marketing site) with sign-in, invite redemption, and live presence/tasks/claims/proposals/validation status over `/v1/stream`. All running against the same Supabase project this repo already used for dev — "hosted" here means the code path exists and works against a real project, not that a separate production deployment/ops setup has been stood up yet. Proposal accept/reject from the dashboard remains explicitly out of scope per Fundamental Rule 1, as planned.

**Onboarding rework (in flight, per [`docs/onboarding-contracts.md`](./docs/onboarding-contracts.md)).** The v1 dashboard put team creation first: a new account landed on two static onboarding slides plus a "copy the install prompt" step that verified nothing, then reached a dashboard whose only available action was the "Create workspace" form. That order is backwards — the first thing a new user should do is connect their MCP server and see it actually verified. `#/onboarding` is now: **welcome → connect MCP → verify → dashboard**. The connect step shows the install prompt *and* a freshly minted one-time pairing code (`POST /v1/pairing-codes`, Contract A) to hand to a coding agent; the verify step polls `GET /v1/pairing-codes/:pairingId` every 2s with a live status, an expiry countdown, and a "mint a new code" action once the 15-minute TTL lapses. Verification is blocking for the primary button but always skippable — skipping still lands on the dashboard. Because signup auto-provisions a personal workspace (Contract C), onboarding no longer needs a team to exist and never gates on creating one; "create a team" is an ordinary, optional post-onboarding action.

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

## Non-goals (still true)

- A new code editor/IDE, or a replacement Git host/implementation.
- Character-by-character CRDT/OT live editing — proposals stay reviewable units, even at the most automatic autonomy tier.
- Automatic force-push, rebase, reset, or commit on a user's active branch, ever.
- The browser dashboard writing directly to a participant's filesystem (see Phase 8's deferred scope).
- Deep bespoke integrations with every commercial agent — MCP is the one contract.

## Where implementation detail lives

- Architecture, daemon/service responsibilities, data model: `docs/architecture.md`
- Wire protocol, event schemas: `docs/protocol.md`
- MCP tool catalog and client setup: `docs/mcp-clients.md`
- Security/threat model: `docs/security.md`
- Agent-facing contract, capability ladder, MCP trust model: `AGENTS.md`
- Setup, current feature list, safety model: `README.md`
