# Crosscode architecture

```text
editor / agent / CLI
        |
        v
per-worktree daemon --- SQLite events + outbox
        |
        | authenticated HTTP sync
        v
coordination service --- Supabase-hosted PostgreSQL operations + audit log
        |
        v
other daemons receive reviewable proposals
```

## Daemon (`apps/daemon`)

One daemon runs per Git checkout/worktree. It watches filesystem and Git activity,
captures settled edits as immutable transactions (stable before/after content
hashes), and appends them to a local append-only SQLite event log alongside
projections, an offline outbox, and the download cursor. It creates safety
checkpoints under `refs/crosscode/checkpoints/<replica-id>/...` before any
materialization and never moves `HEAD` or changes the real index. It binds only to
loopback and exposes a mode-`0600` connection descriptor under the worktree's Git
directory; the same descriptor is what `apps/mcp-server` and `apps/cli` connect to.

## Coordination service (`apps/service`)

The service is a Supabase-hosted-PostgreSQL-backed record of workspace state:
operations, tasks, claims, handoffs, intents, and an audit log
(`apps/service/migrations/001_initial.sql`, `002_handoffs_intents.sql`,
`003_validations_cursor.sql`, `004_supabase_auth.sql`). Workspace members
authenticate directly against Supabase Auth (email + password, `crosscode --
login`); the service verifies the resulting Supabase-issued JWTs
(fetched from `SUPABASE_URL`'s JWKS endpoint, `apps/service/src/auth.ts`) rather than
signing its own. A replica (an individual daemon/device identity) is
self-registered by an authenticated member calling `POST /v1/replicas`
(`apps/service/src/http.ts`) instead of being minted through an admin-issued
enrollment token. Every authenticated request carries an
`x-crosscode-workspace-id` header naming which workspace it targets, since a
Supabase access token only carries the member's `auth.users` id, not a
workspace/replica scope the way Crosscode's own previously-issued tokens did.
Daemons upload operations idempotently and download them back in cursor order.
Live updates also fan out over WebSocket (presence, task, claim, handoff,
intent, operation), with a durable poll fallback when a replica is offline. The
service enforces workspace membership and role on every request (including
Postgres Row Level Security as defense-in-depth alongside the service's own
`resolveMembership` checks); it does not execute anything a replica sends it
beyond storing and relaying it. Workspace and member provisioning
(`pnpm service:provision`) remains an administrator-side operation, now backed
by the Supabase admin API (`SUPABASE_SERVICE_ROLE_KEY`) to create or invite
Supabase Auth users instead of writing one-time enrollment tokens.

## Thin clients (`apps/cli`, `apps/mcp-server`)

The CLI and the MCP server hold no sync state of their own. They talk to the local
daemon's HTTP API and render or forward its state: status, tasks, claims, proposal
inspection, accept/reject, checkpoints, and validation runs. `apps/mcp-server`
additionally bootstraps the daemon on first connection if one isn't already running
for the worktree. These two, plus the daemon itself, are the entire supported
product surface: editors and agents (including VS Code and Cursor) integrate via
MCP (`docs/mcp-clients.md`). A previously-built VS Code/Cursor extension remains
in-tree at `apps/vscode-extension` but is frozen and unsupported by decision.

## Safety invariants

1. The local filesystem remains authoritative for local work.
2. Remote operations arrive as proposals and are never automatically applied.
3. Every materialization checks the local base again and creates a checkpoint first.
4. Excluded paths, common secret files, symlink traversal, malformed payloads, and
   unsupported binary transactions are rejected.

If Crosscode is stopped or removed, the repository remains an ordinary Git
repository — Git is the durable history and publishing layer, and checkpoints live
under `refs/crosscode/checkpoints/...` without polluting normal branch history.

See [README.md](../README.md) for setup and current capabilities, and
[BUILD_INSTRUCTIONS.md](../BUILD_INSTRUCTIONS.md) for the milestone-by-milestone
implementation status.
