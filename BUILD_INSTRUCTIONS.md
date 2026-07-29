# Crosscode — Functional Build Instructions

## 0. Current implementation status

Last updated: 2026-07-28.

Crosscode currently has a tested local safety core, but it is not yet a deployable multi-machine collaboration product. The daemon is the sole local authority; the CLI and current MCP-shaped entry point communicate through its authenticated loopback API.

### Completed

- A real per-worktree daemon executable with exclusive lifecycle locking, a mode-`0600` discovery descriptor, loopback-only HTTP, filesystem observation, Git polling, and graceful shutdown.
- Runtime-validated local API contracts with bearer authentication, strict JSON schemas, malformed-body handling, a 1 MiB request limit, safe error envelopes, and trusted validation profiles.
- SQLite append-only local events and atomic projections for tasks, claims, operations, validations, checkpoints, cursors, captured hashes, and Git/materialization state.
- Stable transaction capture across repository, reflog, index, operation, checkpoint-tree, and per-file hash boundaries.
- Hidden Git checkpoints that include eligible untracked work without moving HEAD or modifying the user's real index or visible branch history.
- Explicit proposal acceptance/rejection, stale-base refusal, pre-application checkpoints, temporary-file materialization, and restart reconciliation.
- Crash recovery that rolls back only proposal-matching bytes, preserves newer developer edits, and marks ambiguous recovery as conflicted.
- Built-in and committed path exclusions, symlink traversal protection, checkpoint-ref validation, critical-path risk recomputation, text-only transaction enforcement, and byte-preserving checkpoint restoration.
- Same-HEAD reset detection through the HEAD reflog plus branch, HEAD, index, merge, rebase, cherry-pick, revert, and worktree observation.
- HTTP-backed CLI commands for initialization, join metadata, status, tasks, path claims, checkpoints, proposals, accept/reject, configured validation, and command wrapping.
- A standards-compliant MCP stdio server (`@modelcontextprotocol/sdk`) exposing all twelve section 13 coordination tools with JSON-Schema tool discovery, backed end-to-end by the daemon HTTP client, with documented Claude Code/Codex CLI/OpenCode configurations (`docs/mcp-clients.md`) and automated coverage for `crosscode run -- <tool>` exit-code/argument pass-through.
- A real child-process fixture covering daemon exclusivity, authenticated readiness, offline edits, pending proposals, branch transitions, `SIGKILL`, restart recovery, checkpoint persistence, and graceful shutdown.
- Milestone B1: a standalone PostgreSQL service with one-time enrollment, short-lived authenticated replica access, current-membership authorization, idempotent ordered operation ingest, cursor reconnect, audit records, and daemon polling from a durable SQLite outbox.
- Milestone B2: an authenticated WebSocket gateway (`/v1/stream`) that broadcasts presence on connect/disconnect and fans out accepted operations live to subscribed replicas, plus a daemon-side live sync client with reconnect backoff that falls back to the existing 1s poll whenever the socket is unavailable, covered by unit tests. A real three-daemon/PostgreSQL fixture (`apps/daemon/src/live-coordination.integration.test.ts`) is written to verify live presence visibility across replicas, live proposal fan-out well within one poll interval, and lossless recovery through the poll fallback after a WebSocket outage; see the B2 acceptance note under Milestone B for its actual run status.

Current verification baseline:

- TypeScript build passes.
- 84 tests pass without a configured test database (adding CLI `run` argument/exit-code coverage); more total once `CROSSCODE_TEST_DATABASE_URL` is set, adding the real-PostgreSQL B1 reconnect, service store, and B2 live-coordination fixtures.
- Statement/function coverage were last measured with a real PostgreSQL database attached (87.87%/86.88%); this update was authored without one available and did not reverify those percentages.
- Dependency audit reports no known vulnerabilities.
- Final correctness, TypeScript, and security reviews found no remaining critical or high findings.

### Partially implemented

- The network coordination service implements the B1 durable HTTP path plus the B2 live WebSocket vertical: authenticated presence broadcast and live operation fan-out at `/v1/stream`, with graceful poll fallback. Durable session summaries for disconnected replicas and network synchronization of tasks/claims/handoffs remain outstanding.
- Deterministic conflict analysis handles independent, stale-base, critical-path, and basic Git three-way analysis. Hunk overlap, delete-vs-modify records, interface impact, dependency graphs, and proposal diff artifacts are incomplete.
- Validation runs committed profiles locally and binds results to an exact tree. Validation policy enforcement before publish and shared validation reporting are incomplete.

### Not implemented

- Durable session summaries for disconnected replicas, and network synchronization of tasks/claims/intent/handoffs over the live channel.
- Publish planning and safe ordinary Git commit/push workflow.
- VS Code/Cursor extension.
- Provider-neutral AI semantic review.
- Full three-participant end-to-end acceptance fixture.

### Known foundation debt

- `LocalEvent` is still represented internally as an open `type: string` plus `payload: unknown`; define a discriminated, runtime-validated event union while adding service event contracts.
- The repository does not yet contain the planned `packages/test-fixtures` package, committed config example, protocol/security documents, or a dedicated threat model.
- `docs/architecture.md` still describes the in-process sequencer as the MVP boundary and should be revised when Milestone B replaces it.

### Recommended next gate

Implement Phase 3 next: network-synced tasks, claims, intents, and handoffs; complete deterministic conflict/risk classification (hunk overlap, delete-vs-modify, interface impact, dependency graphs); and shared validation status. B1's durable authenticated HTTP/reconnect vertical and B2's live WebSocket presence/fan-out vertical are both complete.

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

### Phase 5 — VS Code/Cursor extension — NOT STARTED

- Build status, tasks/claims, proposal review, file decoration, and validation views.
- Use normal diff/confirmation UI and the daemon API only.

**Exit criteria:** a VS Code/Cursor user can complete all common review/accept/reject actions without the terminal; disabling the extension does not disrupt daemon sync.

### Phase 6 — AI review and publishing — NOT STARTED

- Add provider-agnostic semantic-review interface, strict structured output, redaction, audit, policy controls, and test gates.
- Implement conservative publish workflow for accepted validated state.

**Exit criteria:** ambiguous changes receive a non-authoritative AI proposal, high-risk changes require approval, and publishing creates/pushes normal Git commits without force operations.

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

- [ ] A plain editor with only the daemon can join and contribute safely.
- [ ] Codex, Claude Code, and OpenCode can use shared MCP tools when configured.
- [ ] Cursor/VS Code can see and review activity through the extension.
- [ ] Independent changes from three separate worktrees preserve all participants' work.
- [ ] Same-file/same-symbol and delete-vs-modify collisions never silently overwrite files.
- [ ] A user can keep using ordinary `git commit`, `git pull`, branches, worktrees, and rebase; Crosscode detects and safely reconciles state changes.
- [x] Automatic checkpoints are recoverable and do not pollute normal branch history.
- [ ] Offline edits persist and reconnect without duplicate events or blind overwrites.
- [ ] High-risk paths and all AI-generated resolutions require explicit approval by default.
- [ ] Repository secrets and excluded files never leave the machine through Crosscode events or AI review.
- [ ] Accepted work can be published as standard Git commits to a normal remote.
- [ ] Removing/turning off Crosscode leaves an ordinary functioning repository with all code still present.

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

### Milestone B — real shared coordination service and authenticated sync — PARTIAL (B1, B2 COMPLETE)

Turn the in-process service into a standalone HTTP/WebSocket service with PostgreSQL durable storage. Add authenticated workspace membership and per-workspace authorization before allowing operations to sync.

- [x] Implement the tables named in section 7, beginning with workspaces, members, replicas, operations, and audit events.
- [x] Authenticate users and replicas with one-time enrollment, short-lived credentials, and current PostgreSQL membership checks. OS-keychain storage remains a hardening task; the current headless fallback is mode `0600` under the Git directory.
- [x] Assign idempotent server sequence numbers and expose cursor-based reconnect sync.
- [x] Fan out presence and proposals through WebSockets.
- [ ] Retain durable summaries for disconnected replicas (the `sessions` table exists but is not yet populated; presence is currently ephemeral, held in memory by the gateway).
- [x] Validate every inbound payload with the protocol schemas and enforce owner/member/viewer permissions at the service boundary.
- [x] Bind the local daemon to loopback only and require its generated local secret on every API request.
- [x] Add a daemon-owned network sync client and durable outbound delivery state. The in-memory `CoordinationService` remains only as a compatibility test double.

**Acceptance test:** run three daemons in separate worktrees against one service process. Restart the service and reconnect an offline daemon; each event appears once, in order, and no proposal is applied before explicit local acceptance.

**B1 acceptance: passed.** Real PostgreSQL integration covers one-time enrollment, exact idempotent retry, conflicting client-sequence rejection, service restart, offline outbox recovery, ordered cursor download, duplicate-free proposals, and no automatic file write.

**B2 acceptance: written, not yet run against a live database.** A real three-daemon/PostgreSQL fixture (`apps/daemon/src/live-coordination.integration.test.ts`) is in place and asserts that connect/disconnect presence is visible live to the other replicas, that an accepted proposal from one daemon reaches the other two over `/v1/stream` well within a single poll interval (proving the live path, not just eventual poll consistency), and that a daemon with no live socket at all still catches up losslessly through the existing 1s poll fallback. It follows the same `describe.skipIf(!CROSSCODE_TEST_DATABASE_URL)` convention as the B1 fixture and compiles and skips cleanly without a database, but no environment with a reachable PostgreSQL instance was available while authoring it, so it has not yet actually been executed end-to-end; this remains to be confirmed against a real database before treating B2 as proven. Durable session summaries for disconnected replicas remain outstanding.

### Milestone C — safe multi-replica integration pipeline — PARTIAL

Complete the deterministic analysis and materialization path before adding any automated convenience.

- [x] Compare per-file base content hashes before application and immediately before atomic rename.
- [x] Use Git three-way merge for stale-base analysis; never build a custom text merge engine.
- [ ] Complete classification for non-overlapping hunks, delete-vs-modify, interface, and dependency-impact changes. Independent, stale-base, and critical-path cases are implemented.
- [ ] Preserve both inputs and candidate patches as explicit conflict-recovery/audit artifacts.
- [ ] Add a proposal diff command. Checkpoint inspect/restore commands are implemented.
- [x] Require explicit acceptance before materialization and block locally classified high/critical work.
- [x] Journal in-progress materialization and recover safely after crashes without overwriting newer developer edits.

**Acceptance test:** a deterministic three-worktree fixture preserves all independent changes; same-file/same-symbol and delete-vs-modify cases leave files untouched and provide a recovery/proposal record.

### Milestone D — validation and publish workflow — DONE

Implement team configuration parsing and publishing only after the integration pipeline is reliable.

- [x] Parse committed `.crosscode/config.yaml` and run only trusted configured commands.
- [x] Record command, exit code, duration, bounded/redacted output, exact tested tree, and runner identity (`runnerId`).
- [x] Require passing applicable validation for the exact accepted tree before publish.
- [x] Implement `publish --branch <branch>` with explicit confirmation or explicit noninteractive `--yes` policy. It must create ordinary commits only from accepted state, never stage unrelated user work, force-push, reset, rebase, or alter remotes.
- [x] Add a dry-run publish plan explaining the commit tree and changed paths before any branch/ref update.

**Acceptance test:** accepted work in a fixture is validated and published as a normal commit on a test remote; unstaged unrelated files and the active branch remain unchanged.

### Milestone E — production agent and editor entry points — PARTIAL (MCP server and CLI wrapper COMPLETE)

Keep the daemon as the correctness authority; integrations only add context.

- [x] Make the current MCP-shaped stdio process a standards-compliant MCP transport backed by the daemon HTTP API, with initialization, tool discovery, JSON-schema inputs, and the tools listed in section 13. `apps/mcp-server/src/index.ts` uses the official `@modelcontextprotocol/sdk` `Server`, implements `ListToolsRequestSchema`/`CallToolRequestSchema`, and generates JSON Schema input declarations from the same Zod request schemas the daemon HTTP API validates against (`zodToJsonSchema`).
- [x] Replace placeholder MCP coordination methods with persisted daemon/service operations. All twelve tools from section 13 (`get_workspace_state` through `create_checkpoint`) call `DaemonClient` methods that hit the real daemon HTTP API (`/v1/status`, `/v1/tasks`, `/v1/claims`, `/v1/transactions`, `/v1/operations`, `/v1/handoffs`, `/v1/validate`, `/v1/checkpoints`); none are stubbed or echo fake data. Covered by `apps/mcp-server/src/index.test.ts`, including an end-to-end test that drives a real stdio `initialize`/`tools/list`/`tools/call` exchange against a real daemon.
- [x] Provide documented MCP configurations for Codex, Claude Code, and OpenCode. See `docs/mcp-clients.md` for exact config file locations (`.mcp.json`, `~/.codex/config.toml`, `opencode.json`) per client; no additional auth/token setup is needed on the client side because the MCP server authenticates to the daemon itself via the local connection descriptor (`.git/crosscode/daemon.json`).
- [x] Add automated coverage for `crosscode run -- <tool>` argument and exit-code pass-through; the wrapper implementation exists. Covered by `apps/cli/src/index.test.ts`, which asserts zero and nonzero child exit codes pass through unchanged, that arguments (including ones shaped like CLI flags) are forwarded to the child verbatim after `--`, and that a missing `--`/command is rejected.
- [ ] Build the VS Code/Cursor extension last: status, tasks, claims, proposals, validation, diff review, and confirmation UI only. It must not contain sync authority.

**Acceptance test:** an unwrapped editor, each MCP client, and the VS Code extension can collaborate in the same workspace; disabling any integration leaves daemon coordination intact. MCP server and CLI wrapper acceptance are proven by the automated tests above; the VS Code/Cursor extension remains not started, so the full multi-integration acceptance test is not yet run.

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
