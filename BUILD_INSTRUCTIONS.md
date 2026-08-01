# Crosscode — Functional Build Instructions

## 0. Current implementation status

Last updated: 2026-08-01 (Milestones A-E complete; the post-E backend-completion pass, the hardening pass, and a subsequent Supabase Auth + Supabase-hosted Postgres migration — see below — are all complete).

**Scope decision (2026-07-30): the product surface is the daemon + MCP server only.** The VS Code/Cursor extension and npm/VS Code Marketplace publishing are NOT part of the product going forward — this is a deliberate decision, not a deferral. Editors and agents integrate with Crosscode exclusively through the MCP server (`apps/mcp-server`, see `docs/mcp-clients.md`) and the daemon's CLI (`apps/cli`, the daemon's local admin/setup tool). The existing `apps/vscode-extension` code remains in the repository as-is (built, tested, functional) but is frozen and unsupported; it receives no further work, and no extension-related item counts as outstanding anywhere in this document. Distribution stays clone-and-run via `tsx` (`docs/install-prompt.md`); nothing is published to npm or any marketplace. Sections below that specify or track extension work (14, Phase 5, Milestone E, parts of 13/22) are retained as historical record of what was built, superseded by this decision.

Crosscode now has a tested local safety core and a working multi-replica coordination path: real daemons exchange live proposals, tasks, claims, handoffs, and validation results through an authenticated PostgreSQL-backed service, deterministically classify conflicts, optionally auto-apply low-risk proposals under an explicit committed policy, gate publish on validation, and are reachable from any MCP client. The daemon remains the sole local authority; the CLI and MCP entry point communicate through its authenticated loopback API. What remains genuinely open: a real (non-mock) AI review provider. A Google-Docs-style live web dashboard with browser accounts remains a separately-scoped future track and is intentionally not part of this repository yet; see section 1's non-goals for the current release boundary.

### Completed

- A real per-worktree daemon executable with exclusive lifecycle locking, a mode-`0600` discovery descriptor, loopback-only HTTP, filesystem observation, Git polling, and graceful shutdown.
- Runtime-validated local API contracts with bearer authentication, strict JSON schemas, malformed-body handling, a 1 MiB request limit, safe error envelopes, and trusted validation profiles.
- SQLite append-only local events and atomic projections for tasks, claims, operations, validations, checkpoints, cursors, captured hashes, and Git/materialization state.
- Stable transaction capture across repository, reflog, index, operation, checkpoint-tree, and per-file hash boundaries.
- Hidden Git checkpoints that include eligible untracked work without moving HEAD or modifying the user's real index or visible branch history.
- Explicit proposal acceptance/rejection, stale-base refusal, pre-application checkpoints, temporary-file materialization, and restart reconciliation.
- Crash recovery that rolls back only proposal-matching bytes, preserves newer developer edits, and marks ambiguous recovery as conflicted.
- Built-in and committed path exclusions, symlink traversal protection, checkpoint-ref validation, critical-path risk recomputation, and byte-preserving checkpoint restoration. (Transactions were text-only until the hardening pass below added base64 binary sharing.)
- Same-HEAD reset detection through the HEAD reflog plus branch, HEAD, index, merge, rebase, cherry-pick, revert, and worktree observation.
- HTTP-backed CLI commands for initialization, join metadata, status, tasks, path claims, checkpoints, proposals, accept/reject, configured validation, and command wrapping.
- A standards-compliant MCP stdio server (`@modelcontextprotocol/sdk`) exposing all twelve section 13 coordination tools with JSON-Schema tool discovery, backed end-to-end by the daemon HTTP client, with documented Claude Code/Codex CLI/OpenCode configurations (`docs/mcp-clients.md`) and automated coverage for `crosscode run -- <tool>` exit-code/argument pass-through.
- A real child-process fixture covering daemon exclusivity, authenticated readiness, offline edits, pending proposals, branch transitions, `SIGKILL`, restart recovery, checkpoint persistence, and graceful shutdown.
- Milestone B1: a standalone PostgreSQL service with one-time enrollment, short-lived authenticated replica access, current-membership authorization, idempotent ordered operation ingest, cursor reconnect, audit records, and daemon polling from a durable SQLite outbox.
- Milestone B2: an authenticated WebSocket gateway (`/v1/stream`) that broadcasts presence on connect/disconnect and fans out accepted operations, tasks, claims, handoffs, and intents live to subscribed replicas, plus a daemon-side live sync client with reconnect backoff that falls back to the existing 1s poll whenever the socket is unavailable, covered by unit tests. Real three-daemon/PostgreSQL fixtures (`apps/daemon/src/live-coordination.integration.test.ts`, `apps/daemon/src/live-handoff-intent.integration.test.ts`) have now been executed end-to-end against a real local PostgreSQL instance and pass, confirming live presence visibility, live task/claim/handoff/intent fan-out, live proposal fan-out well within one poll interval, and lossless recovery through the poll fallback after a WebSocket outage; see the B2 acceptance note under Milestone B.
- Milestone B durable presence: `sessions.summary` now persists the last-known server cursor at connect/disconnect (`PgStore.recordSessionStart`/`recordSessionEnd`), and `PgStore.listPresence` / `GET /v1/presence` expose every replica's status, last-seen time, and last-known cursor from that table — including replicas that are currently disconnected — rather than only the in-memory gateway's currently-open sockets.
- A VS Code/Cursor extension (`apps/vscode-extension`) implementing the Phase 5 MVP feature list as a thin daemon-HTTP client with no sync authority of its own: a status tree view, a tasks/claims tree view with create-task/claim-path/release-claim commands, a proposals tree view with normal `vscode.diff` review and confirm-gated accept/reject (extra confirmation copy for high/critical risk), a `FileDecorationProvider` badging claimed/proposed paths in the Explorer, and a validation view that runs a named committed profile on demand. It compiles (`tsc --noEmit`), bundles with esbuild, and packages with `vsce package` locally. It is now also automatically verified end-to-end inside a real, headless VS Code instance (`apps/vscode-extension/test/`, run with `pnpm --filter crosscode-vscode-extension test:vscode`) using the official `@vscode/test-electron` runner; see the Phase 5 status note below for exactly what that fixture exercises.
- Phase 6 (partial): provider-neutral AI semantic review in `packages/core` (types, strict output schema, redaction/bundle construction, prompt-injection-resistant request construction, policy gates) wired into the daemon's proposal accept flow as a non-authoritative, dependency-injected reviewer with a `MockSemanticReviewer` test double; see the Phase 6 entry under section 20 for the exact scope and what's still outstanding.
- `policy.autoApplyRisk`: an optional field on the committed `.crosscode/config.yaml` (`apps/daemon/src/config.ts`'s `configuredAutoApplyRisk`, enum `low|medium|high|critical`, default `low` within an explicit `policy` block) that lets the daemon auto-materialize newly-arrived proposals through the ordinary `accept()` path instead of waiting for an explicit accept, once they already pass every existing safety gate and their classified risk is at or under the threshold (`apps/daemon/src/index.ts`'s `autoApplyEligibleProposals`, called from both `syncRemote` and `sync`). Never weakens the existing critical-path hard block. Recorded with a distinct `transaction.auto_applied` local event. No committed `policy` block leaves today's always-explicit-accept behavior unchanged (regression-tested).
- Shared/service-side validation status reporting: the previously-unused `validations` Postgres table now has `event_id`/`replica_id` columns and a cursor index (`apps/service/migrations/003_validations_cursor.sql`), `PgStore.recordValidation`/`listValidations`, `POST`/`GET /v1/validations`, and a `validation` WebSocket fan-out type, all following the existing task/claim/handoff/intent pattern exactly. The daemon durably queues local validation results (`validationOutbound`), pushes them after every `validate()` call, subscribes to remote validation events live, and exposes them via `crosscode status --json`'s new `remoteValidations` field — a replica can now see another replica's local validation results.
- A discriminated, runtime-validated `LocalEvent` union (`apps/daemon/src/local-event.ts`) replacing the previous open `{ type: string; payload: unknown }`, covering all 35 distinct local event types the daemon persists. `DaemonStateStore.record()` now validates every event with `localEventSchema.parse()` before writing to SQLite; narrowing `persist()`'s signature against the union surfaced zero shape mismatches across the ~35 existing call sites. No SQLite storage-format change.
- OS-keychain replica-secret storage (`apps/daemon/src/keychain.ts`): shells out to platform-native secret stores (macOS `security`, Linux `secret-tool`) rather than a native npm dependency. `writeDaemonConfig`/`readDaemonConfig` (`apps/daemon/src/runtime.ts`) transparently store/resolve the replica secret through the keychain when available, omitting it from `config.json` on disk; any failure or unavailability (including Windows, which has no reliable non-interactive CLI-based secret store) degrades to the previous exact mode-`0600` file behavior, covered by both a real keychain round-trip test and a mocked-unavailable regression test.
- Opt-in, admin-only retention pruning (`apps/service/src/prune.ts`, `pnpm service:prune`): deletes old `audit_events` rows and ended `sessions` rows only, never automatically or on a schedule. Deliberately excludes `operations`/`tasks`/`claims`/`handoffs`/`intents`/`validations`, since those participate in cursor-based reconnect and pruning them would silently break a long-offline replica's catch-up guarantee (see README's "Offline and reconnect behavior").
- `docs/mcp-clients.md` now also documents Gemini CLI and Cursor, following the same config-format-verified-against-the-client's-own-docs standard as the existing three clients (config format checked, not launched end-to-end in this environment).
- Binary file support in the sharing pipeline: `changeTransactionSchema` gained an `afterEncoding: "utf8" | "base64"` field; `capture()` detects binary content (shared `isBinaryContent` helper, same null-byte/UTF-8-round-trip test `decodeText` always used) and base64-encodes it with hashes computed from the raw bytes; `accept()` materializes base64 changes byte-exactly; classification reads working-tree content as raw buffers (`readWorkingBuffer`) so a binary file in the working tree no longer crashes the entire capture pipeline (a real pre-existing bug — any locally-changed binary file previously threw from `changedPaths()` even for unrelated captures), while "binary file present" is never conflated with "file absent" in the add-conflict check. Binary changes carry no `unifiedPatch`, so `hunksOverlap`'s conservative undefined-patch behavior already escalates any same-path binary conflict to human approval; binary stale-base never auto-upgrades to `stale-base-resolved` (three-way merge is text-only); binary content is redacted from AI semantic-review bundles (`binary-content` redaction reason). Covered by end-to-end tests including a byte-exact 0-255-range round trip between two real daemons.
- True git-rename tracking: `changedPaths()` now diffs with `-M` and parses 3-token `R` records; `changeTransactionSchema` validates `previousPath` (required for `kind: "rename"`, forbidden otherwise); `capture()` reads a rename's base content from the old path's HEAD revision; `accept()` materializes the new path via the same temp-file-then-atomic-rename path and then removes the old path, clearing its captured-hash entry. Conflict detection checks both the old and the new path; critical-path risk (`riskForPath` via `analyzeOperation`/`transactionRisk`) applies to both names, so a rename cannot dodge critical classification in either direction. A rename's base check requires both the destination to be free and the source's current bytes to still match `beforeHash` — a locally-diverged source classifies as `stale-base` and refuses to materialize, preserving the local edit (regression-tested).
- `packages/test-fixtures`: a real shared package (per the repo-structure spec in section 4) exporting `createTempRepo`/`cleanupTempRepos`/`waitFor`, eliminating real duplicated setup code that previously existed across `live-coordination.integration.test.ts`, `live-handoff-intent.integration.test.ts`, and `reconnect.integration.test.ts`. Daemon-spawning helpers (`spawnDaemon`/`stopDaemon`/`stopAllDaemons`) deliberately stayed inside `apps/daemon/src/test-helpers.ts` rather than moving into `packages/test-fixtures`, to avoid a circular workspace dependency (`packages/test-fixtures` must stay a dependency-free leaf package; only `apps/daemon` depends on it, never the reverse).
- `docs/architecture.md` rewritten to match the real PostgreSQL-backed daemon/service architecture (replacing the stale in-process-sequencer description); new `docs/protocol.md` (event envelope, schemaVersion rule, the real network event/WS fan-out type list) and `docs/security.md` (the actual JWT/role auth model, redaction, sensitive-action gates, and a threat model section) now exist, closing the doc gaps named in section 4.
- Migrated identity and the coordination-service database from Crosscode's own self-issued JWTs/enrollment tokens and self-hosted PostgreSQL to Supabase Auth and Supabase-hosted PostgreSQL, so that workspace members authenticate the same way real product users will once there's a hosted signup flow, instead of the coordination service minting and verifying its own credentials. Workspace members now sign in directly against Supabase Auth by email/password (`crosscode -- login`, `apps/daemon/src/runtime.ts`'s `login`/`logout`), and the daemon stores the resulting Supabase session (access token in memory, refresh token via the same OS-keychain-preferred/mode-`0600`-fallback mechanism the old replica secret used) instead of a Crosscode-issued replica secret. `apps/service/src/auth.ts`'s `verifySupabaseAccessToken` verifies Supabase-issued JWTs against the project's JWKS (fetched and cached from `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` via `createSupabaseJwks`, since Supabase signs tokens with an asymmetric key, not a shared secret) instead of the service signing its own; `apps/service/src/main.ts` requires `SUPABASE_URL` plus a Supabase-hosted `DATABASE_URL` (`CROSSCODE_JWT_SECRET` no longer exists, and there is no equivalent `SUPABASE_JWT_SECRET` either). Because a Supabase access token carries only the member's `auth.users` id and no workspace/replica scope, every authenticated HTTP request now also carries an `x-crosscode-workspace-id` header (`apps/service/src/http.ts`), checked against the request body's own `event.workspaceId` for a redundant principal-binding match. A replica (individual daemon/device identity) is no longer minted by exchanging an admin-issued enrollment token; it is self-registered by the authenticated member calling the new `POST /v1/replicas` (`CoordinationServiceClient.ensureReplicaRegistered`), which the daemon calls automatically the first time it starts with a logged-in session and no `replicaId` yet. `apps/service/src/provision-admin.ts` (`pnpm service:provision`) remains an administrator-side command but now creates/invites a Supabase Auth user through the Supabase admin API (`SUPABASE_SERVICE_ROLE_KEY`) instead of writing a one-time enrollment record. `apps/service/migrations/004_supabase_auth.sql` adds a `members.user_id` column mapped to `auth.users`, drops the now-unused `replicas.credential_hash` column and the `enrollments` table, and enables Postgres Row Level Security across every workspace-scoped table as defense-in-depth (the service itself still connects with a privileged role rather than through PostgREST, so `resolveMembership` remains the primary authorization check). `infra/docker-compose.yml` is now documented as being for local/CI testing against a plain Postgres instance only; production points `DATABASE_URL` at Supabase. This migration is complete and covered by the existing daemon/service test suite; see `README.md`, `docs/architecture.md`, and `docs/security.md` for the updated setup and auth-model descriptions.

Current verification baseline:

- TypeScript build passes.
- 147 tests pass without a configured test database; 151 total once `CROSSCODE_TEST_DATABASE_URL` is set, adding the real-PostgreSQL B1 reconnect, service store, B2 live-coordination, and live handoff/intent fixtures (all confirmed passing against a real local PostgreSQL instance; see the note under Milestone B). A separate, non-vitest suite (`pnpm --filter crosscode-vscode-extension test:vscode`) launches a real headless VS Code instance and is not included in the counts above; it passes independently (see the Phase 5 note in section 20).
- Statement/function coverage with a real PostgreSQL database attached: 91.73%/90.00% overall (measured for this update; `store.ts` alone is 97.01%/97.14% now that session/presence durability is exercised end-to-end).
- `pnpm audit --audit-level high` reports no known vulnerabilities.
- Final correctness, TypeScript, and security reviews found no remaining critical or high findings.

### Partially implemented

- Deterministic conflict analysis handles independent, likely-compatible, stale-base, critical-path, delete-vs-modify, semantic-overlap, and interface-impact classification, plus basic Git three-way analysis. Hunk overlap is computed end-to-end from a real `git diff --no-index` patch generated at capture time (`packages/git`'s `unifiedDiff`, wired into `LocalDaemon.capture()`), not a hardcoded flag. Dependency-impact resolution for `.ts`/`.tsx` files now uses a real TypeScript AST import graph (`packages/git/src/typescript-graph.ts`), with the original textual/grep-based `findSymbolReferences` search preserved as a fallback for non-TypeScript files; see Milestone C for the AST approach's precise scope and limitations. The service's `operation_dependencies` table remains unused. `conflict_artifact` persists inputs/candidates for every approval-requiring classification, `crosscode proposals diff <operation-id>` exposes it live, and `crosscode proposals artifacts <operation-id>` now reads the persisted historical rows back directly.
- Validation runs committed profiles locally, binds results to an exact tree, gates publish (Milestone D is DONE), and now shares status across replicas (see above). Still incomplete: the `.crosscode/config.yaml` `policy.autoApplyRisk` field only gates the one classification (`independent`/low-risk) that already has `requiresApproval: false` today — extending auto-apply to `likely-compatible`/medium-risk proposals per the full classification table in section 11 would additionally require the "patch validation" step that table calls for, which does not exist yet.

### Not implemented

- A real external AI provider behind the semantic-review interface (only a mock reviewer test double exists; see Phase 6).

### Out of scope by decision (see the scope decision at the top of this section)

- The VS Code/Cursor extension as a supported product surface. The code in `apps/vscode-extension` stays in-tree, built and tested, but frozen; the former outstanding items tied to it (a human interactive walkthrough, a combined editor+MCP+extension fixture) are closed as moot, not pending.
- Publishing to npm or the VS Code Marketplace. Distribution is clone-and-run via `tsx`.
- A Google-Docs-style live web dashboard with browser accounts tied to MCP-authenticated agents (a separately-scoped future track; see section 1's non-goals).

### Known foundation debt

None outstanding.

### Recommended next gate

Milestones A through E are all COMPLETE, each confirmed by real fixtures rather than description: durable local daemon (A), authenticated HTTP/WebSocket sync including live task/claim/handoff/intent/validation fan-out and durable session summaries confirmed against a real PostgreSQL database (B), deterministic conflict/risk classification including an AST-based TypeScript dependency graph and a direct conflict-artifact read route (C), validation-gated publish (D), and a standards-compliant MCP server (E; the extension built under E is now frozen per the scope decision above). The post-E backend-completion pass and the full hardening pass (OS keychain, retention, MCP docs, binary file sharing, true rename tracking) are also complete. The single remaining engineering item is a real external AI-provider `SemanticReviewer` implementation behind the existing provider-neutral interface, once a provider and credentials are chosen (Phase 6). The web dashboard remains a separately-scoped future track.

## 1. Product definition

Build **Crosscode**, a local-first multiplayer coordination layer for people and coding agents working in the same Git repository from different tools.

Crosscode must let a team use Cursor, VS Code, Codex CLI, Claude Code, OpenCode, conventional terminals, and future agent products without replacing their editors, terminals, filesystem, Git host, or existing Git workflow.

The core product promise is:

> Git remains the durable history and publishing layer. Crosscode prevents late integration by coordinating intentions, claims, changes, tests, and conflicts while people and agents work.

The first release is functionality-only. Do not spend time on polished marketing pages, branding, animations, visual design systems, or a feature-rich web dashboard.

### Primary user outcome

Three developers can independently work in separate local checkouts using different agent tools. Crosscode detects overlaps early, distributes safe changes as reviewable transactions, preserves attribution and undo history, validates the integrated state, and publishes ordinary Git commits once the team accepts the work.

### Fundamental rules

1. The normal filesystem is always authoritative for a developer's local work.
2. Git objects and ordinary Git commits remain portable, inspectable, and sufficient to recover the project without Crosscode.
3. Crosscode must never silently overwrite local uncommitted work.
4. Claims are advisory, never hard locks.
5. Integrations add context and earlier warnings; lack of an integration must not break correctness.
6. Deterministic checks decide clear cases. AI only reviews ambiguity and never becomes the source of truth.
7. High-risk changes require explicit human approval by default.

## 2. Success criteria for the MVP

The MVP is successful when three local users can join the same repository workspace and:

- See presence, active tasks, path claims, and current repository health.
- Work normally in separate Git worktrees/checkouts with any editor or CLI.
- Have completed filesystem edits grouped into reversible change transactions.
- Receive remote non-overlapping changes as proposals, never as unexplained raw writes.
- Automatically detect line/path overlap and Git-base mismatches.
- Create Git-backed hidden checkpoints without moving a user's branch or staging area.
- Run configured validation commands and share their outcomes.
- Publish accepted work to a normal branch as ordinary Git commits.
- Recover from an offline participant and reconcile their changes safely after reconnect.
- Use the same coordination tools through MCP from Codex, Claude Code, and OpenCode when configured.

The MVP does **not** need live character-level editing, perfect semantic merges, deep support for every tool, or autonomous publication.

## 3. Architecture

Use a local-first architecture with a small, durable core.

```text
┌──────────────────────────────────────────────────────────────┐
│ Existing tools                                                │
│ Cursor / VS Code / Codex CLI / Claude Code / OpenCode / Vim │
└───────────────┬──────────────────────────────────────────────┘
                │ optional: extension, MCP, hooks, CLI wrapper
┌───────────────▼──────────────────────────────────────────────┐
│ Local Crosscode daemon (one per checkout/worktree)           │
│ - filesystem and Git observer                                │
│ - local event store                                          │
│ - transaction builder                                        │
│ - patch materializer                                         │
│ - checkpoint writer                                          │
│ - local HTTP/WebSocket/MCP endpoints                         │
└───────────────┬──────────────────────────────────────────────┘
                │ authenticated, encrypted operation stream
┌───────────────▼──────────────────────────────────────────────┐
│ Shared coordination service                                  │
│ - workspace membership and presence                          │
│ - task/claim registry                                        │
│ - append-only operation log                                  │
│ - sync and conflict orchestration                            │
│ - validation scheduling                                      │
│ - optional AI semantic-review jobs                           │
└───────────────┬──────────────────────────────────────────────┘
                │ optional, normal Git transport
┌───────────────▼──────────────────────────────────────────────┐
│ Git repositories / GitHub / GitLab / Bitbucket / self-hosted │
└──────────────────────────────────────────────────────────────┘
```

### Technology recommendation

Use TypeScript end-to-end for the first implementation:

- **Monorepo:** pnpm workspaces + Turborepo (or plain pnpm workspaces if simpler).
- **Daemon and CLI:** Node.js + TypeScript; use a proven file watcher such as `chokidar` and a Git library only where it is reliable. Prefer invoking Git's plumbing commands for hidden checkpoint creation.
- **Service:** TypeScript HTTP/WebSocket server, PostgreSQL for shared durable state, Redis only if needed for ephemeral fan-out/presence.
- **Local state:** SQLite, with append-only events and a materialized local state projection.
- **MCP:** TypeScript MCP server backed by the daemon API.
- **VS Code/Cursor extension:** TypeScript extension that communicates exclusively with `localhost` daemon endpoints.

Start with one machine/process per active worktree. Do not attempt multi-worktree daemon sharing until the basic model is reliable.

## 4. Repository structure

Create a monorepo structured around stable domain contracts rather than vendor tools.

```text
crosscode/
  apps/
    daemon/                 # local-first coordination process
    service/                # shared coordination API + WebSockets
    cli/                    # `crosscode` commands and tool wrappers
    mcp-server/             # agent-facing MCP server
    vscode-extension/       # VS Code/Cursor integration
  packages/
    protocol/               # event schema, validation, API contracts
    core/                   # transaction, patch, conflict domain logic
    git/                    # safe Git discovery/checkpoint primitives
    adapters/               # capability-based agent adapters
    test-fixtures/          # tiny sample repositories and scenarios
  docs/
    architecture.md
    protocol.md
    security.md
  infra/
    docker-compose.yml      # local service/Postgres only when needed
  .crosscode/
    config.example.yaml
```

Do not add a desktop app in the first milestone. The daemon, CLI, MCP server, and extension are enough to prove the product. A desktop app can later become a thin controller over the same daemon API.

## 5. Workspace model and identity

Crosscode has a shared **workspace** and many local **replicas**.

- A workspace identifies one collaboration context for a repository and selected branch policy.
- A replica is a participant's checkout/worktree plus local daemon state.
- A participant is a human identity; sessions and agents are attributed to that participant.
- A task is intentional work scoped by a description and advisory claims.

Derive a stable repository identity from normalized Git remote URL(s), repository root, and an explicit workspace ID. Never assume the active branch is `main`.

Store local metadata outside versioned project files by default:

```text
<repo>/.git/crosscode/state.sqlite
<repo>/.git/crosscode/config.json
```

Allow an optional committed `.crosscode/config.yaml` for team-shared validation commands, path exclusions, and policies. Do not include tokens, private identities, or machine-local paths in it.

## 6. Local daemon requirements

The daemon is the compatibility baseline and must work even with no editor extension or agent integration.

### Responsibilities

- Discover repository root, active worktree, HEAD, remotes, index state, and ignored files.
- Watch relevant tracked/untracked source files while excluding `.git`, build output, dependency directories, and configured paths.
- Debounce bursty writes and group stable edits into transactions.
- Snapshot before/after content and identify a transaction base commit/blob hash.
- Detect Git transitions: checkout, pull, rebase, cherry-pick, reset, merge, and worktree changes.
- Maintain a local append-only event log and local projections for tasks, claims, remote operations, and validation status.
- Exchange signed/authenticated events with the coordination service when online.
- Expose a localhost API for the CLI, MCP server, and extension.
- Materialize only explicitly accepted remote changes, and create a safety snapshot first.
- Create hidden Git checkpoints from immutable trees without modifying the user's branch, index, or normal commit history.

### Transaction boundaries

Never stream half-written files as collaboration changes. Produce a transaction only when at least one condition is satisfied:

- The workspace has been quiet for a configurable short debounce interval.
- A wrapped command exits.
- A native integration reports an edit/agent turn completed.
- The user invokes `crosscode checkpoint` or `crosscode share`.

Each transaction has a consistent before-state and after-state. If files change while a transaction is being assembled, retry rather than emitting an inconsistent patch.

### Local daemon API (first version)

```text
GET  /v1/status
GET  /v1/workspace
GET  /v1/tasks
POST /v1/tasks
POST /v1/claims
GET  /v1/operations
POST /v1/operations/:id/accept
POST /v1/operations/:id/reject
POST /v1/checkpoints
POST /v1/validate
POST /v1/publish
```

Bind to loopback only, require a per-daemon secret or local socket authentication, and never expose this port to the LAN by default.

## 7. Shared coordination service

Build the service as a coordination and audit system, not as a proprietary code store.

### Responsibilities

- Authenticate users and authorize workspace membership.
- Maintain ephemeral presence and durable session summaries.
- Receive immutable operations and assign globally ordered server sequence numbers.
- Store task and claim state with history.
- Fan out events to connected replicas.
- Track operation dependencies, acknowledgements, and conflict status.
- Schedule validation requests against configured worker environments later; initially accept client-reported validation with provenance.
- Queue optional AI semantic-review requests only after deterministic analysis marks an operation ambiguous.

### Service data model

At minimum define tables/documents for:

```text
workspaces
members
replicas
sessions
tasks
claims
operations
operation_files
operation_dependencies
operation_reviews
validations
checkpoints
audit_events
```

Use append-only operation and audit records. Mutable projections (for example, `task.status`) are conveniences and must preserve a history of who made the change and when.

## 8. Event and operation schema

Put all shared types in `packages/protocol` with runtime schema validation (for example Zod). Version every event and reject unknown/incompatible major versions cleanly.

### Core event envelope

```ts
type EventEnvelope<TType extends string, TPayload> = {
  id: string;                       // UUIDv7 or similarly sortable ID
  schemaVersion: 1;
  workspaceId: string;
  replicaId: string;
  actorId: string;
  sessionId?: string;
  agent?: AgentIdentity;
  type: TType;
  clientSequence: number;
  serverSequence?: number;
  createdAt: string;
  payload: TPayload;
  signature?: string;
};

type AgentIdentity = {
  provider: "cursor" | "codex" | "claude-code" | "opencode" | "devin-like" | "unknown";
  adapterId?: string;
  sessionReference?: string;
};
```

### Initial event types

```text
workspace.joined
workspace.left
presence.updated
task.created
task.updated
task.completed
claim.created
claim.released
intent.published
transaction.created
transaction.analyzed
transaction.proposed
transaction.accepted
transaction.rejected
transaction.applied
transaction.conflicted
validation.requested
validation.completed
checkpoint.created
git.head_changed
interface.changed
handoff.requested
handoff.responded
semantic_review.requested
semantic_review.completed
```

### Change transaction payload

```ts
type ChangeTransaction = {
  id: string;
  taskId?: string;
  intent?: string;
  base: {
    headCommit?: string;
    files: Array<{ path: string; blobHash?: string; contentHash: string }>;
  };
  changes: Array<{
    path: string;
    kind: "add" | "modify" | "delete" | "rename";
    beforeHash?: string;
    afterHash?: string;
    unifiedPatch?: string;
    symbols?: SymbolChange[];
  }>;
  provenance: {
    source: "filesystem" | "cli-wrapper" | "mcp" | "hook" | "extension";
    confidence: "known" | "inferred" | "unknown";
  };
  safety: {
    risk: "low" | "medium" | "high" | "critical";
    requiresApproval: boolean;
  };
};
```

Do not rely on an LLM-generated symbol list for correctness. Symbol data is optional enrichment from deterministic language tooling or adapters.

## 9. Tasks, claims, intentions, and handoffs

### Tasks

A task has title, owner, status, optional parent task, intent, paths, symbols, and acceptance notes. Task status is `planned`, `active`, `blocked`, `review`, `complete`, or `cancelled`.

### Claims

Claims are advisory scopes that reduce collisions; they never prevent a user from editing.

```ts
type Claim = {
  id: string;
  taskId: string;
  ownerId: string;
  kind: "path" | "symbol" | "interface";
  target: string;
  mode: "exclusive-preferred" | "shared";
  expiresAt?: string;
  createdAt: string;
};
```

When an incoming or planned change overlaps a claim:

1. Notify both owners.
2. Tell integrated agents to prefer a proposal or request a handoff.
3. Let humans override and continue working.
4. Never reject a local filesystem edit solely because a claim exists.

### Intention events

Intention is valuable context but not a permission system. Agents and humans may publish a plain-language intent before editing. Example: “Rename `CheckoutResponse.checkoutId` to `id` and add payment state.”

### Handoffs

Support `request_handoff`, `accept_handoff`, `decline_handoff`, and `propose_patch` flows. A proposal must remain a separate operation until the current replica explicitly accepts it.

## 10. Git integration and hidden checkpoints

Git compatibility is non-negotiable.

### Do

- Observe Git state and use normal Git metadata.
- Support any branch name, local-only repositories, common hosted remotes, and worktrees.
- Store automatic safety snapshots on hidden refs such as:

```text
refs/crosscode/checkpoints/<replica-id>/<timestamp>
refs/crosscode/tasks/<task-id>/<sequence>
refs/crosscode/integrations/<workspace-id>/<sequence>
```

- Create checkpoint commits through Git plumbing (`write-tree`, `commit-tree`, `update-ref`) or an equally safe Git library implementation.
- Record the base commit, tree, and blob IDs used by each operation.
- Provide a command to inspect and restore a checkpoint safely.

### Do not

- Run `git commit` on the user's checked-out branch behind their back.
- Stage or unstage a user's files.
- Force-push, reset, rebase, or change remotes automatically.
- Assume a clean working tree.
- Treat Git conflicts as an excuse to discard either side.

### Git state changes

When HEAD, index, or worktree identity changes:

1. Pause automatic remote-operation materialization.
2. Create a hidden checkpoint if possible.
3. Record the transition (`switch`, `pull`, `rebase`, `reset`, etc.) when recognizable.
4. Recompute each pending operation against the new base.
5. Resume only after deterministic analysis categorizes the result as safe, proposal-required, or conflicted.

Initial support must cover: normal commits, pulls, branch switches, worktrees, merges, rebases, cherry-picks, and local uncommitted edits. Treat submodules and sparse checkouts as explicit later work.

## 11. Sync and conflict pipeline

Build a conservative pipeline. No remote patch should be written over a local workspace without a base check and an acceptance decision.

```text
Local edits settle
  → daemon snapshots and creates transaction
  → checkpoint is written
  → transaction is sent to service
  → service fans out proposal
  → receiving daemon compares bases/hashes
  → deterministic overlap + dependency checks
  → apply automatically only if policy and risk allow
  → otherwise present proposal, AI review, or conflict
  → accepted patch materializes atomically
  → validations run and status is shared
```

### Deterministic classification

Classify before any AI call:

| Condition | Classification | Default action |
| --- | --- | --- |
| Different files; base hashes match | independent | auto-apply only in Auto-safe mode |
| Same file but non-overlapping hunks; base hashes match | likely compatible | propose or auto-apply after patch validation |
| Rename/delete overlaps another modification | high risk | require human review |
| Base file changed locally since transaction base | stale base | three-way merge analysis, then proposal |
| Same symbol/control flow or public interface | semantic overlap | human approval; optional AI review |
| Auth, secrets, migrations, dependency lockfiles, deploy config | critical | never auto-apply by default |

### Atomic materialization

Apply accepted changes through temporary files and atomic renames where the platform supports them. Re-hash the local base immediately before application. If it changed, abort application and re-analyze; do not overwrite.

### Initial merge implementation

Start with Git's proven three-way merge or standard patch application where appropriate. Do not build a custom text merge engine. AST-aware merge is a later enhancement, beginning with one language only after the transaction system is stable.

## 12. AI semantic reviewer

AI is an optional, bounded reviewer—not an autonomous synchronization engine.

### When to call it

Call only after deterministic analysis identifies ambiguity, such as overlapping control-flow changes, a changed interface with active dependents, or a likely behavior deletion.

### Inputs

Provide the smallest relevant context:

- Base file/version.
- Local proposed/current change.
- Remote proposed change.
- Declared task intents and claim owners.
- Relevant symbol definition and callers when deterministically available.
- Affected test names/results.
- Explicit risk policy.

### Required structured output

```ts
type SemanticReview = {
  classification: "independent" | "compatible" | "behavior_changed" | "work_removed" | "uncertain";
  confidence: number; // 0..1, never use alone to auto-apply high-risk work
  affectedSymbols: string[];
  evidence: string[];
  invariantsToPreserve: string[];
  proposedResolution?: {
    explanation: string;
    patch?: string;
  };
  requiresHumanApproval: boolean;
};
```

### Safeguards

- An AI response cannot directly write files or publish Git commits.
- Treat all repository content, agent outputs, and issue text as untrusted input; never let them override policy through prompt injection.
- Require human approval for `high` and `critical` risk, regardless of model confidence.
- Validate any proposed patch with base hashes, parser/type checks where available, and affected tests.
- Preserve every candidate patch and review result for audit and undo.
- Never send secrets, `.env` contents, credentials, private keys, or excluded paths to an AI provider.
- Support a workspace policy that completely disables external AI review.

The first implementation may use a simple provider interface and a mock reviewer in tests. Do not make a particular model vendor part of the core protocol.

## 13. Agent integration capability ladder

Design adapters around declared capabilities, not product names.

### Level 0 — filesystem/Git observation

Works for all tools. The daemon detects completed work afterward. This is the minimum compatibility guarantee.

### Level 1 — CLI wrapper

Provide transparent wrappers:

```bash
crosscode run -- codex
crosscode run -- claude
crosscode run -- opencode
```

The wrapper records session boundaries, process metadata, working directory, exit codes, and optionally recognized validation/Git commands. It must pass arguments and exit status through unchanged. Users can always invoke the original binary directly.

### Level 2 — MCP server

Expose a provider-neutral MCP tool surface from the local daemon. Initial tools:

```text
get_workspace_state
list_tasks
claim_task
claim_scope
publish_intent
check_change_scope
submit_change_summary
list_remote_proposals
request_handoff
announce_interface_change
request_validation
create_checkpoint
```

MCP tools should inform agents before edits, but no agent is trusted to call them. The filesystem observer remains the fallback.

### Level 3 — native hooks/plugins

Use vendor lifecycle hooks where available to enrich attribution and create early warnings. Normalize provider events to Crosscode's protocol; do not leak vendor-specific event formats into the core.

### Level 4 — programmatic adapters

Only after the core works, support richer adapters that can start/pause sessions, send context, and show live progress.

### Adapter interface

```ts
interface AgentAdapter {
  id: string;
  detect(): Promise<DetectedInstallation[]>;
  capabilities(): AdapterCapabilities;
  startSession?(options: StartSessionOptions): Promise<AgentSession>;
  subscribe?(session: AgentSession): AsyncIterable<NormalizedAgentEvent>;
  sendContext?(session: AgentSession, context: SharedContext): Promise<void>;
  pause?(session: AgentSession): Promise<void>;
}
```

Initial adapters:

- `generic-cli`: works for any executable.
- `codex`: MCP/CLI integration when installed.
- `claude-code`: MCP/CLI/hooks when installed.
- `opencode`: MCP/plugin integration when installed.
- `vscode-cursor`: extension and local context only.
- `devin-like`: remote-agent adapter based on webhooks/API when a stable supported API is available; otherwise represent it as a remote Git participant.

For remote agents that only create commits or push branches, ingest their Git activity as external transactions. Do not claim to have real-time pre-edit control when the provider cannot supply it.

## 14. VS Code and Cursor extension

> **Superseded by the section 0 scope decision (2026-07-30):** the extension is no longer part of the product surface — daemon + MCP only. This section is retained as the historical spec for what was built; `apps/vscode-extension` is frozen and unsupported. Editor users (including VS Code/Cursor) integrate via the MCP server instead (`docs/mcp-clients.md`).

Build one VS Code-compatible extension after daemon/CLI sync works.

The extension must contain no synchronization authority. It is a local UX client of the daemon.

### MVP extension features

- Connection/status indicator for the local daemon and workspace.
- Sidebar for participants, active tasks, claims, remote proposals, and validation state.
- Commands to create/release task claims, publish intent, accept/reject a patch, checkpoint, and validate.
- File decorations/hover text showing advisory claims and recent remote activity.
- Diff-based proposal review using normal editor diff UI.
- Clear warning before accepting a high-risk or stale-base proposal.

Do not attempt editor-DOM modifications, live shared cursors, or a custom code editor.

## 15. CLI commands

Implement a minimal, scriptable CLI:

```bash
crosscode init
crosscode join <workspace>
crosscode status --json
crosscode task create "Implement checkout API" --path server/routes/checkout
crosscode claim path src/checkout --task <id>
crosscode intent "Add paymentStatus to CheckoutResponse" --task <id>
crosscode proposals list
crosscode accept <operation-id>
crosscode reject <operation-id> --reason "..."
crosscode checkpoint [--message "..."]
crosscode validate [--profile affected]
crosscode publish --branch <branch>
crosscode run -- <tool-and-arguments>
```

Every command must provide a stable `--json` output mode for agents and scripts. Default human output should be concise and clear.

`publish` must require confirmation unless invoked in a noninteractive environment with an explicit `--yes` flag and workspace policy allows it. It should create ordinary commits only from accepted, validated state and never force-push.

## 16. Permissions and security

### Roles

Start with `owner`, `member`, and `viewer`:

- **owner:** workspace configuration, membership, publish policy, AI policy.
- **member:** tasks, claims, operations, checkpointing, proposal acceptance within policy.
- **viewer:** read-only presence/history/status.

### Sensitive actions

Require explicit local user approval for:

- Applying a high/critical-risk operation.
- Sending code to an external AI reviewer when not pre-approved by workspace policy.
- Publishing Git commits or pushes.
- Changing remotes, branch policy, or workspace membership.

### Security baseline

- Authenticate all service connections; use TLS for non-local traffic.
- Use short-lived credentials and store local credentials in the OS keychain where possible.
- Sign or bind operations to authenticated actor/replica identity.
- Validate every API and WebSocket payload at runtime.
- Rate-limit service endpoints and validate workspace authorization for every operation.
- Redact configured secret files and ignored sensitive paths from logs, telemetry, diffs, AI review, and outbound events.
- Record auditable security-relevant actions.
- Never execute received shell commands. Validation commands come only from trusted local/team configuration and still run in controlled environments.

## 17. Offline and reconnect behavior

Crosscode must remain useful without network access.

### Offline mode

- Continue normal local editing and Git usage.
- Persist local events and transactions in SQLite with monotonic client sequence numbers.
- Create local hidden checkpoints.
- Show that presence/remote state is stale.
- Do not apply remote operations that were not already received and accepted.

### Reconnect algorithm

1. Authenticate and exchange replica cursors/server sequence.
2. Upload locally queued immutable events idempotently.
3. Download missed remote operations.
4. Re-evaluate each pending operation against current local HEAD/files.
5. Materialize only safe or explicitly accepted proposals.
6. Surface conflicts with both original bases and current local state preserved.

Never replay offline operations by blindly overwriting current files.

## 18. Validation strategy

Validation should be explicit, reproducible, and attributable.

### Configuration

Use an optional committed config:

```yaml
# .crosscode/config.yaml
version: 1
validation:
  profiles:
    fast:
      commands:
        - pnpm lint
        - pnpm typecheck
    test:
      commands:
        - pnpm test
policy:
  autoApplyRisk: low
  externalAiReview: disabled
excludedPaths:
  - .env
  - '**/*.pem'
```

### Rules

- Capture command, exit code, duration, relevant commit/tree hashes, runner identity, and output summary.
- Never treat a client-reported green status as proof for a different tree state.
- Start with local validation; add isolated shared runners only when a stable service/core exists.
- Run affected validation after accepted integration when configured; run full validation before publish if available.

## 19. Test strategy

Treat synchronization correctness as the product. Build tests before implementations for core behaviors.

### Unit tests

- Event schema validation/version handling.
- Path exclusions and transaction debouncing.
- Base/hash checks.
- Claim overlap classification.
- Git hidden-ref checkpoint creation and restoration plans.
- Operation idempotency and ordering.
- Risk classification.
- Permission checks and secret redaction.
- AI reviewer structured-output validation and policy gates.

### Integration tests

Use temporary Git repositories and multiple daemon processes/instances to verify:

- Independent file edits synchronize as proposals/accepted changes.
- Same-file non-overlapping edits classify correctly.
- Stale-base edits never overwrite current work.
- Branch switch/rebase pauses and re-evaluates pending work.
- Offline queue reconnects idempotently.
- Hidden checkpoints do not alter HEAD, index, or visible branch history.
- MCP tool calls map to valid daemon operations.
- CLI wrapper preserves child exit status.

### End-to-end tests

Create a deterministic three-participant fixture:

1. “Cursor” user claims frontend and modifies a client call.
2. “Codex” user changes a shared API type.
3. “Claude Code” user updates a test fixture.
4. System detects the interface impact and produces proposals.
5. Accepted changes materialize without deleting either party's independent work.
6. Validation runs, a hidden checkpoint exists, and publish creates a normal commit on a test remote.

Include failure scenarios: concurrent same-symbol edits, delete-vs-modify, `git reset`, invalid operation payload, lost connectivity, and an AI reviewer returning malformed or unsafe output.

Target high coverage for protocol/core/git packages. Do not chase a global percentage at the expense of realistic multi-replica tests.

## 20. Phased implementation plan

Implement in order. Do not begin later phases until the preceding acceptance criteria pass.

### Phase 0 — foundation — PARTIAL

- Create monorepo, TypeScript conventions, runtime validation, linting, test harness, and fixture repos.
- Define protocol types, local SQLite schema, workspace configuration, and threat model.
- Implement repository discovery and read-only daemon status.

**Exit criteria:** `crosscode status --json` correctly reports repository/worktree/HEAD state in fixture repos and all protocol schemas are tested.

### Phase 1 — local safety core — COMPLETE

- Implement filesystem observation, debounce/transaction assembly, local append-only log, and hidden Git checkpoint creation.
- Build CLI commands for init, status, checkpoint, and transaction inspection.
- Implement no-network operation first.

**Exit criteria:** ordinary edits create reproducible transactions and hidden checkpoint refs without modifying HEAD, index, staging, or visible branch history.

### Phase 2 — service and basic sync — COMPLETE

- Implement authentication suitable for local development, workspace/member lifecycle, durable operation log, and WebSocket fan-out.
- Implement daemon join/reconnect and remote transaction proposals.
- Implement explicit accept/reject and safe atomic patch application.

**Exit criteria:** two daemons in separate temporary Git worktrees can exchange an independent change only after the receiver accepts it; local conflicting edits remain intact.

### Phase 3 — task coordination and validation — PARTIAL

- Add tasks, claims, intent events, presence, handoffs, and configured validation commands.
- Add deterministic conflict/risk classification and shared validation status.
- Add CLI JSON output for all core actions.

**Exit criteria:** three fixture participants can see claims, receive overlap warnings, accept safe work, and attribute a validation result to the exact tree tested.

### Phase 4 — MCP and tool adapters — COMPLETE

- [x] Implement MCP server and generic CLI wrapper.
- [x] Add Codex, Claude Code, and OpenCode configuration/documentation adapters built on the same MCP contract.
- [x] Normalize optional lifecycle events without making them necessary for sync (the CLI wrapper records session boundaries, process metadata, and exit codes without those events being required for daemon-level correctness).

**Exit criteria: met.** An MCP-capable client can claim a task, declare intent, query overlap, and create a checkpoint; the same workspace still works with an unwrapped generic editor.

### Phase 5 — VS Code/Cursor extension — BUILT AND VERIFIED, NOW FROZEN (out of scope per the section 0 scope decision)

- `apps/vscode-extension` implements the five MVP views/actions from section 14: a status view (daemon/repo/service/outbox health, the same fields as `crosscode status --json`), a tasks/claims view with create-task, claim-path, and release-claim commands, a proposals view with per-file diffs opened through the normal `vscode.diff` editor and modal-confirmed accept/reject (with extra warning copy for high/critical risk operations), a `FileDecorationProvider` badging claimed (`C`) and proposed (`P`) paths in the Explorer, and a validation view that runs a named committed profile on demand and lists pass/fail results.
- It contains no sync authority: every state-changing action calls an existing (or, for claim-release/task-update, newly exposed) method on `@crosscode/daemon`'s `DaemonClient` HTTP wrapper — it never writes files, never re-implements accept/reject, and degrades to a "disconnected" status when the daemon is unreachable rather than acting on stale/cached data.
- Verified by static/unit checks: `tsc --noEmit` passes with the extension's sources included, `pnpm --filter crosscode-vscode-extension build` bundles it with esbuild, and `vsce package --no-dependencies` produces a local `.vsix`. The daemon-API client wrapper (`src/client.ts`) has unit tests covering connection caching, reconnect-after-failure, and the accept/reject/validate/releaseClaim/proposals-filtering delegation.
- Verified by a real, non-interactive, CI-runnable extension-host integration suite (`apps/vscode-extension/test/`, run with `pnpm --filter crosscode-vscode-extension test:vscode`), built on the official `@vscode/test-electron` runner (the standard way to launch a real, unmodified VS Code build headlessly and execute test code inside its real extension host — no mocking of the `vscode` API). The orchestrator (`test/runTest.ts`) creates a temporary Git repository, seeds two pending proposals from a simulated second replica using the same in-process-`LocalDaemon`-then-real-process pattern as `apps/daemon/src/process.test.ts`, spawns a real `apps/daemon/src/main.ts` daemon process against that repository, and launches a real VS Code build with the extension loaded (`extensionDevelopmentPath`) and the temp repository open as its workspace folder. The suite that runs inside that real extension host (`test/suite/views.suite.ts`) then, against the real running daemon: confirms the status view's polled state matches a direct `DaemonClient.status()` call; drives `crosscode.createTask` and `crosscode.claimPath` through `vscode.commands.executeCommand` (stubbing only the interactive `showInputBox`/`showQuickPick`/`showWarningMessage` dialogs those commands would otherwise block on) and confirms the resulting task/claim are persisted by the real daemon, not just cached in the extension; confirms both seeded pending proposals appear in the proposals view; confirms the real `FileDecorationProvider` badges the claimed path `C` and a proposed path `P` (and badges an untouched path with nothing); accepts one proposal through `crosscode.acceptProposal` and confirms the daemon actually materializes the proposed file content into the workspace; rejects the other proposal through `crosscode.rejectProposal` and confirms the daemon leaves the workspace file absent (a real no-op); and runs the real `fast` validation profile committed in `.crosscode/config.yaml` through `crosscode.runValidation`, confirming one real passing and one real failing command result. `apps/vscode-extension/src/extension.ts` was changed to return `{ model, decorations }` from `activate()` so the test suite can observe the same live model/decoration-provider instances the extension registers with VS Code, rather than re-implementing them; no other production behavior changed. `esbuild.mjs` now also bundles the test suite, and both the main extension bundle and the test bundle were renamed from `.js` to `.cjs` — this was a **real, previously-undetected bug** this fixture caught: under this package's `"type": "module"`, the CJS-format esbuild output was silently unloadable by a real VS Code extension host (`ReferenceError: module is not defined in ES module scope`), so before this change the packaged extension could never have activated in an actual VS Code window at all. `package.json`'s `main` field was updated to match.
- One documented, environment-specific workaround was needed and is applied automatically by `test/runTest.ts`: VS Code's default `user-data-dir`/`extensions-dir` under this repository's (long) path produced a Unix domain socket path over the ~103-character OS limit (`IPC handle ... is longer than 103 chars`); the fixture passes short `--user-data-dir`/`--extensions-dir` paths under the OS temp directory, which is the documented fix for that specific error. This environment is macOS, so the Linux-specific `xvfb` headless-display workaround `@vscode/test-electron` documents for CI was not needed and was not exercised; on a Linux CI runner without a display, `xvfb-run` (or equivalent) would need to wrap `pnpm test:vscode`.
- Run twice in this environment to confirm it is not a fluke: both runs passed cleanly end-to-end, including the disable/deactivate check below.
- Not yet done: a human interactively clicking through the UI (this fixture is fully automated and headless, which is what was asked for; it does not replace a human sanity check of the actual visual rendering), and no `packages/test-fixtures`-style shared fixture package backs it (the fixture lives directly in `apps/vscode-extension/test/`).

**Exit criteria: met.** A VS Code/Cursor user can complete all common review/accept/reject actions without the terminal — proven automatically end-to-end against a real daemon and a real VS Code extension host, not just built. Disabling/deactivating the extension does not disrupt daemon sync: proven directly, not just by construction — after the real VS Code process running the extension host exits (deactivating the extension), `test/runTest.ts` calls `DaemonClient.status()` directly against the still-running daemon process and confirms it is unaffected and still serving the same workspace/replica identity.

### Phase 6 — AI review and publishing — PARTIAL

- Done: provider-neutral `SemanticReviewRequest`/`SemanticReview`/`SemanticReviewer` types and a strict runtime-validated response schema live in `packages/core` (`packages/core/src/semantic-review.ts`), with zero provider SDK in protocol/transaction code. A redaction-and-bundle-construction function rejects configured exclusions, `.env`/private-key/credential paths, and secret-pattern content, logging only hashes and reasons. Workspace policy (`externalAiReview: disabled|approved`, allowed-provider list, per-review local confirmation) is read from committed `.crosscode/config.yaml`. The daemon (`apps/daemon/src/index.ts`) only offers review for the two classifications deterministic analysis already marks ambiguous (`likely-compatible`, `semantic-overlap`); high/critical risk always forces `requiresHumanApproval`. A review only ever writes an immutable audit record (`semantic_review` table) — accepting it is itself audit-only, and materialization still runs through the existing checkpointed `accept()` path, which re-verifies base/local/proposed hashes against the approved review and refuses on any drift. Rejecting a review (or not approving one) leaves the working tree and Git state untouched. The reviewer is dependency-injected (`DaemonOptions.reviewer`); a `MockSemanticReviewer` test double in `packages/core` is the only implementation wired up. Unit/integration coverage: redaction, strict schema handling of malformed output, policy gates, prompt-injection-resistant request construction, human-rejection safety, and secrets never appearing in provider requests or audit logs (`packages/core/src/semantic-review.test.ts`, `apps/daemon/src/semantic-review.integration.test.ts`).
- Done (Milestone D, prior work): conservative publish workflow for accepted validated state (`apps/daemon/src/index.ts` `publish()`, `apps/daemon/src/publish.integration.test.ts`).
- Outstanding: no real external AI provider is integrated and no live network calls to one are made — no API keys are configured and none were authorized for this work; a concrete `SemanticReviewer` for a real vendor is a follow-up once a provider is chosen and credentials are available. The daemon does not yet auto-trigger a review at the moment deterministic analysis first classifies a transaction ambiguous; a review is requested on demand (CLI/editor UI wiring for that trigger is future work).

**Exit criteria:** ambiguous changes receive a non-authoritative AI proposal, high-risk changes require approval, and publishing creates/pushes normal Git commits without force operations. Met for the mock-backed reviewer; a real provider integration remains to close out this phase fully.

### Phase 7 — later enhancements — NOT STARTED

- Symbol/AST-aware analysis for a narrowly selected language.
- Isolated shared validation workers.
- Desktop control app.
- Rich native adapters where public stable APIs exist.
- Monorepo/submodule/sparse-checkout hardening.

## 21. Explicit non-goals for the first release

Do not build any of the following initially:

- A new code editor or IDE.
- A replacement Git host, Git implementation, or mandatory pull-request system.
- A shared network filesystem or direct writing into another person's working tree.
- Character-by-character CRDT/OT collaborative editing.
- Automatic resolution of behaviorally ambiguous conflicts.
- Automatic force-push, rebase, reset, staging, or commit on a user's active branch.
- Mandatory vendor lock-in, proprietary project file format, or mandatory agent wrapper.
- Deep integrations with every commercial coding agent.
- Autonomous coding agents that make product decisions without user control.
- UI polish beyond utilitarian CLI/extension flows.

## 22. Final acceptance checklist

Before calling the functional MVP complete, demonstrate all of the following with an automated fixture and a short manual walkthrough:

- [x] A plain editor with only the daemon can join and contribute safely. `apps/daemon/src/process.test.ts` drives a real spawned daemon child process with nothing but raw filesystem writes and the `crosscode` CLI (no MCP/editor wrapper) and shows the edit is captured, proposed, and durable across a restart; the three-participant fixture below (`apps/daemon/src/three-participant.e2e.test.ts`) shows the same raw-edit-plus-daemon flow for three independent participants.
- [x] Codex, Claude Code, and OpenCode can use shared MCP tools when configured. `apps/mcp-server/src/index.test.ts` drives a real stdio `initialize`/`tools/list`/`tools/call` exchange against a real daemon over the standards-compliant MCP transport all three clients are documented (`docs/mcp-clients.md`) to use identically; this proves the shared protocol contract end-to-end, not the literal Codex/Claude Code/OpenCode binaries, which were not available to launch in this environment.
- [x] Cursor/VS Code can see and review activity through the extension. Extension built, unit-tested at the client-wrapper level, locally packageable with `vsce package`, and now automatically exercised end-to-end inside a real, headless VS Code extension host against a real daemon (`apps/vscode-extension/test/`, `pnpm --filter crosscode-vscode-extension test:vscode`); see the Phase 5 note in section 20. No human has interactively clicked through the UI in this environment.
- [x] Independent changes from three separate worktrees preserve all participants' work. `apps/daemon/src/three-participant.e2e.test.ts` ("Cursor claims frontend and edits a client call, Codex changes a shared API type, and Claude Code updates a test fixture...") runs three real daemons against three real temporary clones and asserts every participant's own independent edit survives accepting the other two.
- [x] Same-file/same-symbol and delete-vs-modify collisions never silently overwrite files. Per-behavior coverage already existed in `apps/daemon/src/index.test.ts`; `apps/daemon/src/three-participant.e2e.test.ts` adds the same guarantee in the three-participant shape (two independent proposals for the same line, and a delete-vs-modify pair, both landing on a third untouched participant) and asserts the receiving file is byte-for-byte unchanged until a human accepts.
- [x] A user can keep using ordinary `git commit`, `git pull`, branches, worktrees, and rebase; Crosscode detects and safely reconciles state changes. Branch switches, hard resets, and the duration of an in-progress merge were already covered (`apps/daemon/src/index.test.ts`, and a git-reset case in `apps/daemon/src/three-participant.e2e.test.ts`). Three new fixtures in `apps/daemon/src/index.test.ts` close the remaining gap, each against a real `LocalDaemon` and real `git` subprocess calls (no simulation): (1) "detects an actual git rebase in progress..." runs a real `git rebase` that hits a genuine conflict (leaving an actual `rebase-apply` directory on disk), and proves the daemon's `observeGitTransition` detects it, creates a hidden checkpoint, leaves Git's own conflict-marker content in the working file untouched (no Crosscode overwrite), keeps a pending remote proposal blocked with "paused", and only accepts it after `git rebase --continue` and `reanalyzePendingOperations`. Note precisely what "detects the rebase" means here: a real rebase detaches HEAD onto the "onto" commit, so the daemon's transition-kind precedence reports `branch-switch` (branch goes from a name to detached) rather than a distinct "rebase" kind; `discoverRepository`'s own `rebase-merge`/`rebase-apply` detection is what identifies the underlying operation as `"rebase"`, which the test asserts directly via `status().operation`. (2) "creates a real second worktree with `git worktree add`..." runs a real `git worktree add -b <branch> <path>` and proves the original daemon's Git identity and transition detection (`observeGitTransition` reports `"unchanged"`) are undisturbed by the sibling worktree's existence, and that a second `LocalDaemon` opened in the new worktree reports its own distinct root and branch and keeps a fully isolated `operations`/`checkpoints` state (each worktree resolves its own `crosscode/state.sqlite` under Git's per-worktree, non-common `--git-path` resolution, confirmed empirically). (3) "detects and safely reconciles a real named `git pull`..." creates a real local file-based bare remote, advances it from a second clone, and runs a real `git pull origin main` that fast-forwards local HEAD; the daemon detects this as a `head-changed` transition, pauses a pending remote proposal until re-analysis, and both the pulled file and an unrelated pending proposal materialize correctly afterward with no corruption. All three pass under `pnpm test`.
- [x] Automatic checkpoints are recoverable and do not pollute normal branch history.
- [x] Offline edits persist and reconnect without duplicate events or blind overwrites. `apps/daemon/src/index.test.ts` ("persists a stable outbox event and reconnects without applying remote files") and the new "survives lost connectivity" case in `apps/daemon/src/three-participant.e2e.test.ts` cover restart-durability, a failed sync leaving work queued without duplication, and an idempotent retry uploading exactly once against an in-process transport; `apps/daemon/src/reconnect.integration.test.ts` proves the same dedupe property against a real PostgreSQL-backed service but is gated behind `CROSSCODE_TEST_DATABASE_URL` and was not run against a live database in this environment.
- [x] High-risk paths and all AI-generated resolutions require explicit approval by default (mock-backed reviewer; no real provider is wired in yet).
- [x] Repository secrets and excluded files never leave the machine through Crosscode events or AI review.
- [x] Accepted work can be published as standard Git commits to a normal remote. `apps/daemon/src/three-participant.e2e.test.ts` publishes accepted, validated work, pushes it with plain `git push` to a real temporary bare repository acting as a test remote, and asserts the remote's commit, parent, and file contents match.
- [x] Removing/turning off Crosscode leaves an ordinary functioning repository with all code still present. `apps/daemon/src/uninstall.integration.test.ts` deletes all of `.git/crosscode` after materializing an accepted change and shows the file content survives, `git status`/`git log` behave normally, and an ordinary `git commit` still works afterward.

## 23. Implementation discipline

Keep the first build small and observable. For every behavior that can affect a user's code or Git state, add a fixture test before implementation, log the decision with enough context to explain it, and provide a non-destructive recovery path.

If a choice trades convenience against preserving uncommitted work, preserve the work. The entire product is only credible if it is safer than manual late-stage merging.

## 24. Delivery plan: make Crosscode work across real replicas

The implementation now proves the durable local safety model described above. It is **not yet a deployable multi-machine collaboration product**. Status markers below are authoritative for delivery sequencing.

### Milestone A — durable local daemon — COMPLETE

Replace the temporary in-memory and JSON-backed daemon state with the specified SQLite append-only event store and materialized projections. Add filesystem observation with `chokidar`, debounce settled writes, and Git-transition observation.

- [x] Persist events, transactions, operations, task/claim history, checkpoints, and validation results atomically in `<git-dir>/crosscode/state.sqlite`.
- [x] Recover the complete local state after daemon restart without changing files, Git refs, index, or branch.
- [x] Watch tracked and eligible untracked files; exclude `.git`, dependency directories, outputs, configured exclusions, `.env`, keys, and certificates.
- [x] Assemble a transaction only from a stable before/after snapshot; retry if a file changes during assembly.
- [x] Detect checkout, pull, merge, rebase, reset, cherry-pick, and worktree changes. Pause pending materialization, checkpoint when safe, and re-analyze proposals afterward.

**Acceptance test: passed.** The real child-process fixture kills and restarts a daemon while a proposal is pending and the participant has offline work. The proposal, local transaction, event sequence, and checkpoints survive; no remote proposal is written automatically.

### Milestone B — real shared coordination service and authenticated sync — COMPLETE

Turn the in-process service into a standalone HTTP/WebSocket service with PostgreSQL durable storage. Add authenticated workspace membership and per-workspace authorization before allowing operations to sync.

- [x] Implement the tables named in section 7, beginning with workspaces, members, replicas, operations, and audit events.
- [x] Authenticate users and replicas with one-time enrollment, short-lived credentials, and current PostgreSQL membership checks. Replica secrets are now stored in the OS keychain when available (`apps/daemon/src/keychain.ts`), falling back to the mode-`0600` file under the Git directory when it isn't (e.g. Windows, or a headless environment without `secret-tool`).
- [x] Assign idempotent server sequence numbers and expose cursor-based reconnect sync.
- [x] Fan out presence and proposals through WebSockets.
- [x] Fan out tasks, claims, handoffs, and intents live over `/v1/stream` (not only the durable HTTP outbox/poll path). `apps/service/src/ws.ts` broadcasts `task`/`claim`/`handoff`/`intent` messages from `apps/service/src/http.ts` after each upsert; the daemon's `LiveSyncClient` (`apps/daemon/src/ws-client.ts`) subscribes via `onTask`/`onClaim`/`onHandoff`/`onIntent` callbacks and triggers an immediate resync (`apps/daemon/src/runtime.ts`) instead of waiting for the 1s poll fallback.
- [x] Retain durable summaries for disconnected replicas. `sessions.summary` (jsonb) now carries the last-known server cursor at connect/disconnect time (`PgStore.recordSessionStart`/`recordSessionEnd` in `apps/service/src/store.ts`), and `PgStore.listPresence` returns every replica in the workspace — online or offline — with its status, last-seen timestamp, and last-known cursor, sourced entirely from the `sessions`/`replicas` tables rather than in-memory gateway state. `GET /v1/presence` now serves this durable view.
- [x] Validate every inbound payload with the protocol schemas and enforce owner/member/viewer permissions at the service boundary.
- [x] Bind the local daemon to loopback only and require its generated local secret on every API request.
- [x] Add a daemon-owned network sync client and durable outbound delivery state. The in-memory `CoordinationService` remains only as a compatibility test double.

**Acceptance test: passed.** Three daemons in separate worktrees against one service process, run against a real local PostgreSQL instance (not just written and skipped): the B1 durable-sync fixture, the B2 live-presence/proposal fixture (`apps/daemon/src/live-coordination.integration.test.ts`), and the live handoff/intent fixture (`apps/daemon/src/live-handoff-intent.integration.test.ts`) all executed end-to-end and passed. Restarting the service and reconnecting an offline daemon still delivers each event once, in order, with no proposal applied before explicit local acceptance.

**B1 acceptance: passed.** Real PostgreSQL integration covers one-time enrollment, exact idempotent retry, conflicting client-sequence rejection, service restart, offline outbox recovery, ordered cursor download, duplicate-free proposals, and no automatic file write.

**B2 acceptance: passed, confirmed against a real database.** `apps/daemon/src/live-coordination.integration.test.ts` was previously written but never executed against a live PostgreSQL instance; it has now been run and passes, proving live presence visibility across three replicas, live proposal fan-out well within one poll interval, live task/claim fan-out and claim-release fan-out, and lossless recovery through the poll fallback after a WebSocket outage. `apps/daemon/src/live-handoff-intent.integration.test.ts` likewise passes, confirming live handoff/intent fan-out and lossless poll-fallback recovery for those event types. Durable session summaries (this milestone's remaining gap) are now implemented and covered by a real-PostgreSQL fixture in `apps/service/src/store.integration.test.ts` that constructs a fresh `PgStore` against the same database to prove the summary is read back from the table itself, not any in-process state.

Note: these two live-coordination fixtures spin up multiple real daemon child processes and assert on a fixed ~3s capture window; under heavy parallel CPU load (e.g. the full `pnpm test` suite's default worker concurrency) they can flake with a capture timeout unrelated to sync correctness. They pass reliably run alone or with reduced test-runner concurrency (for example `vitest run --pool=forks --poolOptions.forks.maxForks=2`). This is pre-existing test-runner contention, not a defect introduced here.

### Milestone C — safe multi-replica integration pipeline — COMPLETE

Complete the deterministic analysis and materialization path before adding any automated convenience.

- [x] Compare per-file base content hashes before application and immediately before atomic rename.
- [x] Use Git three-way merge for stale-base analysis; never build a custom text merge engine.
- [x] Complete classification for non-overlapping hunks, delete-vs-modify, interface, and dependency-impact changes. Independent, stale-base, critical-path, delete-vs-modify, and semantic-overlap were already implemented. Hunk overlap is now computed end-to-end from a real `git diff --no-index` patch generated at capture time (`unifiedDiff` in `packages/git`, wired into `LocalDaemon.capture()`) instead of degrading to "always overlapping" whenever no patch was supplied. A distinct `interface-impact` classification fires for an exported/public signature change with known dependents. Dependency resolution for `.ts`/`.tsx` files now uses a real TypeScript import graph (`findAstDependentFiles` in `packages/git/src/typescript-graph.ts`, built on the `typescript` compiler API): it parses import/export declarations across this monorepo's own tracked `.ts`/`.tsx` files (including workspace-package specifiers resolved through each package's `package.json` `exports` field, and relative specifiers including the `.js`-extension-referring-to-`.ts`-source convention this codebase's NodeNext module resolution requires) and walks the real reverse-import edges to find direct and transitive dependents of a changed exported symbol. It is a syntactic walk, not a type-checker-backed analysis: there is no `Program`/type checker, so it cannot see through indirection a parser can't (e.g. a computed or re-exported-through-a-barrel-with-renamed-namespace import), it does not understand tsconfig `paths` aliases (none exist in this repo's `tsconfig.json`, so this was not implemented), and it only resolves specifiers it can map onto a tracked file (bare npm packages and Node builtins are treated as external and stop the walk). The original textual, grep-based `findSymbolReferences` search is preserved unchanged and is used as the fallback whenever the changed file is not `.ts`/`.tsx` or the AST walk is inapplicable/fails, so no existing behavior regresses. `packages/git/src/typescript-graph.test.ts` unit-tests direct and transitive AST-based resolution and specifically proves the AST version does not false-positive on a file that only mentions the changed symbol's name in a comment or string, unlike the textual search, which does. The service's `operation_dependencies` table is still unused.
- [x] Preserve both inputs and candidate patches as explicit conflict-recovery/audit artifacts. The `conflict_artifact` SQLite table (base/local/proposed content, dependents, merged candidate) is persisted for every classification that requires approval: delete-vs-modify, semantic-overlap, interface-impact, stale-base, and stale-base-resolved. A direct read route now exists for these historical rows: `crosscode proposals artifacts <operation-id>` (CLI) → `client.artifacts` → `GET /v1/operations/:id/artifacts` → `LocalDaemon.conflictArtifacts` → `DaemonStateStore.listConflictArtifacts`, which reads the persisted rows straight out of SQLite rather than recomputing classification live. This is independent of the live-recomputed `proposals diff` command below -- `apps/daemon/src/index.test.ts` asserts that mutating the working tree after classification changes what a live `diffProposal` would recompute but does not change the rows `conflictArtifacts` reads back.
- [x] Add a proposal diff command. `crosscode proposals diff <operation-id>` (CLI) → `client.diff` → `LocalDaemon.diffProposal` returns per-file base/local/proposed content plus classification, risk, requiresApproval, and dependents. Checkpoint inspect/restore commands are implemented.
- [x] Require explicit acceptance before materialization and block locally classified high/critical work.
- [x] Journal in-progress materialization and recover safely after crashes without overwriting newer developer edits.

**Acceptance test:** a deterministic three-worktree fixture preserves all independent changes; same-file/same-symbol and delete-vs-modify cases leave files untouched and provide a recovery/proposal record.

**Milestone C acceptance note:** every checklist item above is implemented and covered by fixture tests — `packages/core/src/index.test.ts` unit-tests the classification decision table including `interface-impact`; `packages/git/src/index.test.ts` covers `unifiedDiff`; `packages/git/src/typescript-graph.test.ts` covers the AST-based import graph (direct importers, transitive importers across multiple hops, subdirectory/`.tsx` resolution, an unrelated-named-import negative case, the non-TypeScript fallback signal, and the textual-search false positive the AST version avoids); `apps/daemon/src/index.test.ts` covers real capture-generated hunk overlap (both non-overlapping and overlapping cases, without any test manually setting the patch field), delete-vs-modify, stale-base, stale-base-resolved, interface-impact with a direct-plus-transitive dependency chain resolved through the real AST graph, and reading back a persisted `conflict_artifact` row directly through `conflictArtifacts` after a subsequent local edit has changed what live recomputation would produce, in each case also asserting the persisted `conflict_artifact` row. The AST-based dependency graph is a syntactic walk over this monorepo's own tracked TypeScript files, not a full type-checker-backed analysis; see the dependency-impact checklist item above for its precise scope and limitations. The single combined three-worktree acceptance fixture is now in `apps/daemon/src/three-participant.e2e.test.ts`: a "Cursor" participant claims a frontend path and edits a client call, a "Codex" participant changes a shared, single-line-declared API type, and a "Claude Code" participant updates a test fixture, all three real daemons against real temporary Git clones; the fixture asserts the interface-impact proposal is detected and never silently materialized, the two independent changes accept cleanly without deleting either party's other work, validation runs, a hidden checkpoint exists without moving HEAD/branch, and `publish` produces a normal commit that is pushed with plain `git push` to a real temporary bare remote. The same file adds concurrent same-symbol-edit, delete-vs-modify, `git reset`, invalid HTTP operation payload, lost-connectivity, and malformed/unsafe semantic-reviewer failure scenarios in the same three-participant shape. This milestone is now COMPLETE.

### Milestone D — validation and publish workflow — DONE

Implement team configuration parsing and publishing only after the integration pipeline is reliable.

- [x] Parse committed `.crosscode/config.yaml` and run only trusted configured commands.
- [x] Record command, exit code, duration, bounded/redacted output, exact tested tree, and runner identity (`runnerId`).
- [x] Require passing applicable validation for the exact accepted tree before publish.
- [x] Implement `publish --branch <branch>` with explicit confirmation or explicit noninteractive `--yes` policy. It must create ordinary commits only from accepted state, never stage unrelated user work, force-push, reset, rebase, or alter remotes.
- [x] Add a dry-run publish plan explaining the commit tree and changed paths before any branch/ref update.

**Acceptance test:** accepted work in a fixture is validated and published as a normal commit on a test remote; unstaged unrelated files and the active branch remain unchanged.

### Milestone E — production agent and editor entry points — COMPLETE

Keep the daemon as the correctness authority; integrations only add context.

- [x] Make the current MCP-shaped stdio process a standards-compliant MCP transport backed by the daemon HTTP API, with initialization, tool discovery, JSON-schema inputs, and the tools listed in section 13. `apps/mcp-server/src/index.ts` uses the official `@modelcontextprotocol/sdk` `Server`, implements `ListToolsRequestSchema`/`CallToolRequestSchema`, and generates JSON Schema input declarations from the same Zod request schemas the daemon HTTP API validates against (`zodToJsonSchema`).
- [x] Replace placeholder MCP coordination methods with persisted daemon/service operations. All twelve tools from section 13 (`get_workspace_state` through `create_checkpoint`) call `DaemonClient` methods that hit the real daemon HTTP API (`/v1/status`, `/v1/tasks`, `/v1/claims`, `/v1/transactions`, `/v1/operations`, `/v1/handoffs`, `/v1/validate`, `/v1/checkpoints`); none are stubbed or echo fake data. Covered by `apps/mcp-server/src/index.test.ts`, including an end-to-end test that drives a real stdio `initialize`/`tools/list`/`tools/call` exchange against a real daemon.
- [x] Provide documented MCP configurations for Codex, Claude Code, and OpenCode. See `docs/mcp-clients.md` for exact config file locations (`.mcp.json`, `~/.codex/config.toml`, `opencode.json`) per client; no additional auth/token setup is needed on the client side because the MCP server authenticates to the daemon itself via the local connection descriptor (`.git/crosscode/daemon.json`).
- [x] Add automated coverage for `crosscode run -- <tool>` argument and exit-code pass-through; the wrapper implementation exists. Covered by `apps/cli/src/index.test.ts`, which asserts zero and nonzero child exit codes pass through unchanged, that arguments (including ones shaped like CLI flags) are forwarded to the child verbatim after `--`, and that a missing `--`/command is rejected.
- [x] Build the VS Code/Cursor extension last: status, tasks, claims, proposals, validation, diff review, and confirmation UI only. It must not contain sync authority. See the Phase 5 note in section 20 for the automated extension-host fixture that proves this.

**Acceptance test:** an unwrapped editor, each MCP client, and the VS Code extension can collaborate in the same workspace; disabling any integration leaves daemon coordination intact. MCP server and CLI wrapper acceptance are proven by the automated tests above. The VS Code/Cursor extension is now built and automatically verified end-to-end inside a real VS Code extension host against a real daemon (section 20, Phase 5), including a direct daemon-status check proving the daemon survives the extension host exiting; a single combined fixture driving an unwrapped editor, an MCP client, and the VS Code extension together in one workspace has not been written.

## 25. AI-assisted file review and semantic-conflict design

AI review is a bounded, non-authoritative aid for ambiguous changes. It must never be part of the path that decides whether a filesystem write, merge, Git commit, or publish happens.

### When AI review is allowed

Run deterministic checks first. Request a review only when they classify the work as ambiguous, including:

- overlapping edits to the same function/control flow;
- a public interface change with known dependents;
- a likely behavior deletion or incompatible contract change;
- a three-way merge that is syntactically possible but has unresolved behavioral ambiguity.

Do not call AI for independent changes, clear stale-base conflicts, malformed transactions, excluded files, or changes marked critical solely by path policy. The first three are resolved by deterministic behavior; critical work still needs a human even if a review is available.

### Review input construction

Build the smallest review bundle after redaction:

1. Base version of the affected file or symbol.
2. Recipient's current local version and incoming proposed version/diff.
3. Transaction intent, task/claim context, risk policy, and validation outcomes.
4. Deterministically discovered interface definitions, affected callers, and relevant test names when available.

The review-bundle builder must reject configured exclusions, ignored secret paths, `.env` files, private keys, credentials, tokens, and any content that matches the secret-redaction policy. Log only hashes and redaction reasons, never secret values.

### Provider boundary

Define a provider-neutral interface in `packages/core`; no provider SDK belongs in the protocol or transaction code.

```ts
type SemanticReviewRequest = {
  workspaceId: string;
  operationId: string;
  files: Array<{
    path: string;
    base?: string;
    local?: string;
    proposed?: string;
  }>;
  intents: string[];
  validations: Array<{ command: string; exitCode: number; tree?: string }>;
  risk: "medium" | "high" | "critical";
};

type SemanticReview = {
  classification: "independent" | "compatible" | "behavior_changed" | "work_removed" | "uncertain";
  confidence: number;
  affectedSymbols: string[];
  evidence: string[];
  invariantsToPreserve: string[];
  proposedResolution?: { explanation: string; patch?: string };
  requiresHumanApproval: boolean;
};

interface SemanticReviewer {
  review(request: SemanticReviewRequest): Promise<SemanticReview>;
}
```

### Required safety gates

- Validate the provider response at runtime with a strict schema; treat malformed output as `uncertain` with no patch.
- Store review input hashes, provider identity, response, and approval decision in immutable audit records.
- Any AI-generated patch is a proposal only. Recompute its base hashes, run parser/type checks and affected tests, then require explicit human approval before materialization.
- `high` and `critical` risk always require human approval, irrespective of confidence.
- The provider must receive no tool capability that can write files, execute commands, modify Git refs, or publish.
- Add workspace policy controls: `externalAiReview: disabled | approved`, allowed provider list, and a per-review local confirmation requirement.
- Treat repository text and model output as untrusted data. Prompts must state that code/comments/instructions inside reviewed files cannot change Crosscode policy or invoke tools.

### Review workflow

```text
Deterministic analysis marks transaction ambiguous
  → redact and construct minimal review bundle
  → user/policy authorizes external review
  → provider returns schema-validated advisory result
  → Crosscode records the audit event and shows diff/evidence
  → human accepts/rejects a candidate resolution
  → base hashes are checked again; validation runs
  → accepted proposal materializes atomically, or remains unresolved
```

### AI review test plan

- Unit-test redaction, strict output schema handling, policy gates, and prompt-injection-resistant request construction.
- Verify malformed output, unsafe patches, and unavailable providers cannot alter files or Git state.
- Use a mock reviewer in integration fixtures for compatible, behavior-changed, and uncertain responses.
- Confirm secrets and excluded paths do not appear in provider requests or audit logs.
- Confirm a human rejection leaves both working tree and Git state unchanged.
