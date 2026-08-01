# Crosscode

Crosscode is a local-first coordination layer for developers and coding agents working in separate checkouts of the same Git repository. It watches ordinary filesystem and Git activity, records stable edits as durable transactions, exchanges those transactions through an authenticated coordination service, and presents remote work as proposals. A remote proposal is never written into a checkout until that replica explicitly accepts it.

Git remains the durable history and publishing layer. Crosscode does not replace your editor, agent, Git host, branches, worktrees, staging area, or normal commits.

## Fastest way to try it

Paste the prompt in [`docs/install-prompt.md`](./docs/install-prompt.md) into any MCP-capable coding agent (Claude Code, Codex CLI, OpenCode, Cursor, etc.). The agent clones this repository, installs dependencies, and registers the Crosscode MCP server for your project itself — no manual `init`/daemon step. The daemon starts itself, in the background, the first time the agent calls a Crosscode tool.

## What works today

- One durable daemon per Git checkout/worktree
- Settled filesystem-edit capture with stable before/after hashes
- SQLite append-only local events, projections, and an offline outbox
- Hidden Git checkpoints without moving HEAD or changing the real index
- Detection of branches, commits, resets, index changes, merges, rebases, cherry-picks, and reverts
- Supabase-hosted PostgreSQL coordination-service operations and audit records
- Supabase Auth sign-in (`crosscode -- login`) and self-service replica registration, with short-lived authenticated access tokens
- Idempotent operation upload with ordered, cursor-based reconnect downloads
- Explicit proposal inspection, acceptance, and rejection
- Crash-safe application that preserves newer developer edits
- Trusted committed validation profiles
- HTTP-backed CLI and a standards-compliant MCP server (`apps/mcp-server`) that auto-bootstraps the daemon on first connection
- Live WebSocket presence, task, claim, handoff, and intent fan-out, with a durable poll fallback
- `publish --branch` with a dry-run plan, publishing accepted work as ordinary commits to a real remote
- Editor/agent integration exclusively through the MCP server — the supported product surface is the daemon + MCP server (plus the CLI as the daemon's local tool). A previously-built VS Code/Cursor extension exists in-tree (`apps/vscode-extension`) but is frozen and unsupported by decision; VS Code and Cursor users connect via MCP instead (`docs/mcp-clients.md`)
- A bounded, non-authoritative AI semantic reviewer for ambiguous conflicts, gated behind explicit workspace policy and human approval

See [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) for the authoritative, milestone-by-milestone status of what's implemented and tested.

## Safety model

Crosscode follows four rules:

1. The local filesystem remains authoritative for local work.
2. Remote operations arrive as proposals and are never automatically applied.
3. Every materialization checks the local base again and creates a checkpoint first.
4. Excluded paths, common secret files, symlink traversal, malformed payloads, and unsupported binary transactions are rejected.

If Crosscode is stopped or removed, the repository remains an ordinary Git repository. Checkpoints live under `refs/crosscode/checkpoints/...` and do not pollute normal branch history.

## Architecture

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

The daemon binds only to loopback and publishes a mode-`0600` connection descriptor under the worktree Git directory. Service access tokens remain in daemon memory; the longer-lived Supabase refresh token is stored in the OS keychain when available (macOS `security`, Linux `secret-tool`), or otherwise in the mode-`0600` local daemon configuration outside versioned files.

## Prerequisites

- Node.js 24 or newer
- pnpm 11
- Git
- A Supabase project (or Docker Desktop/another Docker-compatible runtime, for local-only testing against a plain Postgres instance — see `infra/docker-compose.yml`)

Install dependencies:

```bash
pnpm install
pnpm build
pnpm test
```

## Set up Supabase and run the coordination service

Crosscode's coordination service verifies Supabase-issued JWTs and stores workspace/operation state in Supabase-hosted PostgreSQL. Create a Supabase project (or use an existing one), then from its dashboard collect:

- **Project URL** (Project Settings → API) → `SUPABASE_URL`
- **`anon` public key** (Project Settings → API) → `SUPABASE_ANON_KEY`, used by every member's `crosscode -- login`
- **`service_role` key** (Project Settings → API) → `SUPABASE_SERVICE_ROLE_KEY`, used only by the admin-side `service:provision` command — never distribute this key to members
- **JWT Secret** (Project Settings → API → JWT Settings) → `SUPABASE_JWT_SECRET`, used by the service to verify Supabase-issued access tokens
- **Connection string** (Project Settings → Database) → `DATABASE_URL` (Supabase's pooled `postgres://` connection string works as-is)

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_JWT_SECRET="<project JWT secret>"
export SUPABASE_SERVICE_ROLE_KEY="<project service_role key>"
export DATABASE_URL="<Supabase pooled connection string>"
export MIGRATION_DATABASE_URL="${DATABASE_URL}"
pnpm service:migrate
pnpm service
```

The last migration (`apps/service/migrations/004_supabase_auth.sql`) enables Row Level Security and maps `members` to Supabase's `auth.users` by `user_id`; because a real `REFERENCES auth.users(id)` foreign key requires the `auth` schema (which only exists inside an actual Supabase project, not a plain test Postgres instance), add it once by hand after migrating against Supabase:

```sql
ALTER TABLE members ADD CONSTRAINT members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
```

The service defaults to `http://127.0.0.1:8788`. Plain HTTP is allowed only on loopback. To bind to another interface, configure both `CROSSCODE_TLS_KEY` and `CROSSCODE_TLS_CERT`; startup refuses non-loopback plaintext HTTP.

Service environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | Supabase (or plain) PostgreSQL connection string | required |
| `SUPABASE_URL` | Supabase project URL, used to verify token issuer | required |
| `SUPABASE_JWT_SECRET` | Supabase project JWT secret, at least 32 bytes | required |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key; only needed by `pnpm service:provision`, not by `pnpm service` itself | required for provisioning |
| `CROSSCODE_SERVICE_HOST` | Listen address | `127.0.0.1` |
| `CROSSCODE_SERVICE_PORT` | Listen port | `8788` |
| `CROSSCODE_TLS_KEY` | TLS private-key path | unset |
| `CROSSCODE_TLS_CERT` | TLS certificate path | unset |

Run `pnpm service:migrate` with a migration-owner connection before starting a new service version. `CROSSCODE_RUNTIME_DB_ROLE` applies the required least-privilege grants, and service startup refuses a role that can update/delete immutable operations or audit rows. The runtime never executes DDL. Non-loopback PostgreSQL URLs must specify exactly one `sslmode=verify-full` and cannot use host/SSL query overrides. For local-only testing against a plain (non-Supabase) Postgres instance, `infra/docker-compose.yml` still starts one on `127.0.0.1:5432`; it is not used in production, where `DATABASE_URL` points at Supabase.

## Create a workspace and invite members

`pnpm service:provision` is an administrator-side command. It creates or invites a Supabase Auth user by email (via the Supabase admin API, using `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) and writes the corresponding workspace/member row directly to Postgres (`MIGRATION_DATABASE_URL` or `DATABASE_URL`).

Create the workspace and its owner:

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<project service_role key>"
export MIGRATION_DATABASE_URL="<Supabase pooled connection string>"
OWNER_JSON="$(pnpm --silent service:provision create my-workspace alice@example.com)"
echo "${OWNER_JSON}"
```

The JSON contains the new `workspaceId`. `create` calls Supabase's `auth.admin.createUser` with `email_confirm: true` but no password, so Alice needs to set one (Supabase dashboard → Authentication → Users → send a password-reset email, or `supabase.auth.resetPasswordForEmail`) before her first login. In Alice's checkout:

```bash
pnpm crosscode -- init --json
pnpm crosscode -- join --workspace <workspaceId> --json
pnpm crosscode -- login --email alice@example.com --password <her password> --service http://127.0.0.1:8788 --json
pnpm daemon
```

`crosscode -- login` needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` set in its own environment (the anon key collected above) to reach Supabase Auth. There is no separate replica-enrollment step: the daemon self-registers a replica for the authenticated member the first time it starts with a logged-in session and no replica identity of its own yet.

Invite another member to the same workspace:

```bash
MEMBER_JSON="$(pnpm --silent service:provision join <workspaceId> bob@example.com member)"
echo "${MEMBER_JSON}"
```

`join` calls Supabase's `auth.admin.inviteUserByEmail`, which sends Bob a real Supabase invite email with a link to set his own password. Once he has one, run the same `init`, `join --workspace <workspaceId>`, `login`, and `daemon` commands in Bob's separate checkout.

To create a read-only service member, use `viewer` instead of `member`. Viewers may download operations but cannot upload them.

## Normal workflow

With the daemon running:

```bash
# Repository, daemon, outbox, cursor, and service health
pnpm crosscode -- status --json

# Declare local work
pnpm crosscode -- task create "Implement checkout API" --path server/routes/checkout --json
pnpm crosscode -- claim path server/routes/checkout --task <task-id> --json

# Create or inspect safety checkpoints
pnpm crosscode -- checkpoint --message "before integration" --json
pnpm crosscode -- checkpoint inspect <checkpoint-ref> --json

# Review remote work
pnpm crosscode -- proposals list --json
pnpm crosscode -- proposals inspect <operation-id> --json

# Materialize only after an explicit decision
pnpm crosscode -- accept <operation-id> --json
pnpm crosscode -- reject <operation-id> --json

# Run commands from a committed validation profile
pnpm crosscode -- validate --profile fast --json
```

The daemon continues capturing work while the service is unavailable. Pending outbound events survive daemon restarts. When connectivity returns, the daemon retries the same immutable event IDs, records acknowledgements, downloads operations after its saved cursor, and stores remote operations as proposals without changing files.

## Team validation configuration

Validation commands and exclusions come only from committed `.crosscode/config.yaml` at `HEAD`:

```yaml
version: 1
validation:
  profiles:
    fast:
      commands:
        - pnpm build
        - pnpm test
excludedPaths:
  - private/**
  - '**/*.pem'
```

Arbitrary validation commands are not accepted through HTTP or CLI arguments. A validation result records its command, exit code, duration, bounded/redacted output, and exact checkpoint tree. If the tree changes while validation runs, the result is invalidated.

## Local files and Git refs

Crosscode stores machine-local state under the repository's resolved Git directory:

```text
<git-dir>/crosscode/config.json   # replica identity, service URL, Supabase session (access + refresh token) (0600)
<git-dir>/crosscode/daemon.json   # ephemeral loopback descriptor and secret (0600)
<git-dir>/crosscode/state.sqlite  # events, projections, cursor, outbox (0600)
<git-dir>/crosscode/daemon.lock   # one-daemon ownership
```

Safety snapshots use:

```text
refs/crosscode/checkpoints/<replica-id>/<timestamp>-<uuid>
```

Crosscode never stages, unstages, commits, pushes, force-pushes, resets, rebases, or changes remotes automatically.

## Development and verification

```bash
pnpm build
pnpm test
pnpm audit --audit-level high
```

The current suite covers protocol boundaries, authenticated daemon HTTP, Git checkpoints, filesystem capture, SQLite restart recovery, outbox identity, stale-base refusal, exclusions, binary safety, crash rollback, Git transitions, MCP-to-daemon mapping, and real daemon child-process restart behavior.

For the implementation plan and current milestone ledger, see [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md).

## Current limitations

- Production PostgreSQL role grants still need environment-specific deployment hardening. Retention is opt-in and admin-only: `pnpm service:prune -- --older-than-days <n>` deletes old audit events and ended sessions; cursor-reconnect-dependent tables are deliberately never pruned.
- Supabase refresh tokens are stored in the OS keychain when available (macOS `security`, Linux `secret-tool`); otherwise, including on Windows, the mode-`0600` Git-directory configuration fallback is used.
- Binary files are shared base64-encoded with byte-exact materialization; any conflict involving a binary file requires human approval, since deterministic hunk/merge analysis is text-only.
- Renames are tracked as first-class rename changes (old path, new path, content); a rename conflicting with pending work on either path, moving into or out of a critical path, or whose source has diverged locally always requires approval.
- Dependency-impact analysis for `.ts`/`.tsx` is a syntactic AST walk, not a type-checker-backed analysis (see BUILD_INSTRUCTIONS.md Milestone C for exact scope).
- There is no hosted/managed coordination service yet — you run a Supabase project and the service yourself.
- Team-workspace provisioning (multi-person/multi-agent sync) requires a running coordination service and an administrator running `pnpm service:provision` with the Supabase service-role key; there is no self-serve signup or billing yet.
- Deliberately not published to npm or any editor marketplace — the supported surface is the daemon + MCP server, run from a cloned checkout via `pnpm install` and `tsx` (see `docs/install-prompt.md`). The in-tree VS Code/Cursor extension is frozen and unsupported by decision.
