# Crosscode

Crosscode is a local-first coordination layer for developers and coding agents working in separate checkouts of the same Git repository. It watches ordinary filesystem and Git activity, records stable edits as durable transactions, exchanges those transactions through an authenticated coordination service, and presents remote work as proposals. A remote proposal is never written into a checkout until that replica explicitly accepts it.

Git remains the durable history and publishing layer. Crosscode does not replace your editor, agent, Git host, branches, worktrees, staging area, or normal commits.

## What works today

- One durable daemon per Git checkout/worktree
- Settled filesystem-edit capture with stable before/after hashes
- SQLite append-only local events, projections, and an offline outbox
- Hidden Git checkpoints without moving HEAD or changing the real index
- Detection of branches, commits, resets, index changes, merges, rebases, cherry-picks, and reverts
- PostgreSQL-backed coordination-service operations and audit records
- One-time replica enrollment and short-lived authenticated access credentials
- Idempotent operation upload with ordered, cursor-based reconnect downloads
- Explicit proposal inspection, acceptance, and rejection
- Crash-safe application that preserves newer developer edits
- Trusted committed validation profiles
- HTTP-backed CLI and daemon-backed MCP-shaped tool mapping

WebSocket presence, the VS Code extension, publishing, and AI semantic review are not implemented yet.

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
coordination service --- PostgreSQL operations + audit log
        |
        v
other daemons receive reviewable proposals
```

The daemon binds only to loopback and publishes a mode-`0600` connection descriptor under the worktree Git directory. Service access tokens remain in daemon memory; the longer-lived replica secret is stored only in the mode-`0600` local daemon configuration outside versioned files.

## Prerequisites

- Node.js 22 or newer
- pnpm 11
- Git
- PostgreSQL 17, or Docker Desktop/another Docker-compatible runtime

Install dependencies:

```bash
pnpm install
pnpm build
pnpm test
```

## Run the PostgreSQL coordination service

The included Compose configuration binds PostgreSQL to local port `5432`.

```bash
export POSTGRES_PASSWORD="$(openssl rand -base64 32)"
docker compose -f infra/docker-compose.yml up -d postgres

docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U crosscode -d crosscode \
  -c "CREATE ROLE crosscode_runtime LOGIN PASSWORD 'crosscode-runtime-local-only';"

export MIGRATION_DATABASE_URL="postgresql://crosscode:${POSTGRES_PASSWORD}@127.0.0.1:5432/crosscode"
export CROSSCODE_RUNTIME_DB_ROLE="crosscode_runtime"
export DATABASE_URL="postgresql://crosscode_runtime:crosscode-runtime-local-only@127.0.0.1:5432/crosscode"
export CROSSCODE_JWT_SECRET="$(openssl rand -base64 48)"
pnpm service:migrate
pnpm service
```

The service defaults to `http://127.0.0.1:8788`. Plain HTTP is allowed only on loopback. To bind to another interface, configure both `CROSSCODE_TLS_KEY` and `CROSSCODE_TLS_CERT`; startup refuses non-loopback plaintext HTTP.

Service environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | required |
| `CROSSCODE_JWT_SECRET` | HS256 signing secret, at least 32 bytes | required |
| `CROSSCODE_SERVICE_HOST` | Listen address | `127.0.0.1` |
| `CROSSCODE_SERVICE_PORT` | Listen port | `8788` |
| `CROSSCODE_TLS_KEY` | TLS private-key path | unset |
| `CROSSCODE_TLS_CERT` | TLS certificate path | unset |

Run `pnpm service:migrate` with a migration-owner connection before starting a new service version. `CROSSCODE_RUNTIME_DB_ROLE` applies the required least-privilege grants, and service startup refuses a role that can update/delete immutable operations or audit rows. The runtime never executes DDL. Non-loopback PostgreSQL URLs must specify exactly one `sslmode=verify-full` and cannot use host/SSL query overrides. The checked-in migration is at `apps/service/migrations/001_initial.sql`.

## Create a workspace and enroll replicas

Provisioning is an administrator-side command that writes a one-time enrollment record directly to PostgreSQL. The raw enrollment token is printed once and is never stored by the service.

Create the workspace owner:

```bash
export MIGRATION_DATABASE_URL="postgresql://crosscode:${POSTGRES_PASSWORD}@127.0.0.1:5432/crosscode"
OWNER_ENROLLMENT_JSON="$(pnpm --silent service:provision create my-workspace alice)"
echo "${OWNER_ENROLLMENT_JSON}"
```

The JSON contains `workspaceId` and `enrollmentToken`. In Alice's checkout:

```bash
pnpm crosscode -- init --json
export CROSSCODE_ENROLLMENT_TOKEN="<owner enrollmentToken>"
pnpm crosscode -- join --service http://127.0.0.1:8788 --json
pnpm daemon
```

Provision another member in the same workspace:

```bash
MEMBER_ENROLLMENT_JSON="$(pnpm --silent service:provision join <workspaceId> bob member)"
echo "${MEMBER_ENROLLMENT_JSON}"
```

Then run the same `init`, `CROSSCODE_ENROLLMENT_TOKEN`, `join`, and `daemon` commands in Bob's separate checkout. Enrollment tokens are one-time and expire after 15 minutes. Do not put them in shell history, committed files, chat, or logs.

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
<git-dir>/crosscode/config.json   # replica identity, service URL, replica secret (0600)
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

- B1 uses polling for reconnect; WebSocket fan-out and presence are B2.
- Production PostgreSQL role grants and retention policies still need environment-specific deployment hardening.
- Replica secrets use the protected Git-directory configuration fallback; OS-keychain integration is still planned.
- Transactions are text-only. Binary files are rejected for sharing, although checkpoint restore preserves their exact bytes.
- Renames are represented as explicit delete/add changes.
- Hunk-level, interface-impact, and semantic-conflict analysis is incomplete.
- MCP transport is not yet fully standards-compliant.
- There is no safe publish command or editor extension yet.
