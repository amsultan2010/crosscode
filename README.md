# Crosscode

[![CI](https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml/badge.svg)](https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Crosscode is a local-first coordination layer for developers and coding agents working in separate checkouts of the same Git repository. It watches ordinary filesystem and Git activity, records stable edits as durable transactions, exchanges those transactions through an authenticated coordination service, and presents remote work as proposals. A remote proposal is never written into a checkout until that replica explicitly accepts it.

Git remains the durable history and publishing layer. Crosscode does not replace your editor, agent, Git host, branches, worktrees, staging area, or normal commits.

Crosscode is a CLI-first product. Everything you do day to day — signing in, joining a workspace, claiming work, reviewing proposals, accepting, publishing — is a `crosscode` command or an MCP tool call against your local daemon. The website is a landing page, sign-up/sign-in, and these docs; there is no web dashboard.

## Quickstart

1. **Create an account** on the Crosscode site (sign-up page), or from a terminal with `crosscode signup --email <e> --password <p>`.

2. **Log in from your checkout.**

   ```bash
   crosscode login
   ```

   With a TTY and no flags, this opens your browser, you complete the sign-in on the site, and the CLI receives the session on a loopback callback. Tokens are never printed. Add `--no-browser` to print the URL instead of opening it, or `--web <url>` to point at a different site.

   For agents, CI, and anything headless, use the non-interactive path — no browser, no TTY:

   ```bash
   crosscode login --email <email> --password <password> --json
   # {"value":{"userId":"…","email":"…"}}
   ```

   Full contract: [BUILD_INSTRUCTIONS.md § Authentication](./BUILD_INSTRUCTIONS.md#authentication--crosscode-login) and [`docs/onboarding-contracts.md`](./docs/onboarding-contracts.md).

3. **Initialize the checkout** and join a workspace.

   ```bash
   crosscode init --json
   crosscode join --workspace <workspaceId> --json   # or --invite <code>, or --pair <code>
   ```

   Signing up auto-provisions a personal workspace, so `--workspace` is only needed to join someone else's.

4. **Do real work.** Start the daemon (`pnpm daemon`, or let the MCP server start it for you) and use the commands under [Normal workflow](#normal-workflow).

## Fastest way to try it with an agent

Paste the prompt in [`docs/install-prompt.md`](./docs/install-prompt.md) into any MCP-capable coding agent (Claude Code, Codex CLI, OpenCode, Cursor, etc.). The agent clones this repository, installs dependencies, and registers the Crosscode MCP server for your project itself — no manual `init`/daemon step. The daemon starts itself, in the background, the first time the agent calls a Crosscode tool.

## What works today

- One durable daemon per Git checkout/worktree
- Settled filesystem-edit capture with stable before/after hashes
- SQLite append-only local events, projections, and an offline outbox
- Hidden Git checkpoints without moving HEAD or changing the real index
- Detection of branches, commits, resets, index changes, merges, rebases, cherry-picks, and reverts
- Supabase-hosted PostgreSQL coordination-service operations and audit records
- Supabase Auth sign-in — `crosscode login` (loopback browser flow) and `crosscode login --email/--password` (headless) — plus self-service replica registration, with short-lived authenticated access tokens
- Idempotent operation upload with ordered, cursor-based reconnect downloads
- Explicit proposal inspection, acceptance, and rejection
- Crash-safe application that preserves newer developer edits
- Trusted committed validation profiles
- HTTP-backed CLI and a standards-compliant MCP server (`apps/mcp-server`) that auto-bootstraps the daemon on first connection
- Live WebSocket presence, task, claim, handoff, and intent fan-out, with a durable poll fallback
- `publish --branch` with a dry-run plan, publishing accepted work as ordinary commits to a real remote
- Editor/agent integration exclusively through the MCP server — the supported product surface is the daemon + MCP server (plus the CLI as the daemon's local tool). Every editor, including VS Code and Cursor, connects via MCP (`docs/mcp-clients.md`)
- CLI/MCP-first end to end: status, claiming, checkpoints, proposal review, accept/reject, and publish are all direct CLI/MCP operations against the local daemon. Nobody — human or agent — needs to open a website to do routine work; the site exists for sign-up/sign-in and documentation. See [`AGENTS.md`](./AGENTS.md)
- A bounded, non-authoritative AI semantic reviewer for ambiguous conflicts, gated behind explicit workspace policy and human approval
- Self-serve account creation (site sign-up or `crosscode signup`), self-serve workspace creation, and an auto-provisioned personal workspace on first authenticated request — no admin `service:provision` step required for the common case
- Multi-tenant workspaces, memberships, invites, one-time pairing codes, presence, and billing endpoints, all reachable from the CLI and the coordination service's HTTP API. There is no web UI for any of them
- A per-workspace autonomy tier (always-ask / auto-if-clean / auto-always) that extends the existing accept-gated auto-apply mechanism without weakening it
- A billing data model and plan-gating helpers behind a `BillingProvider` interface, with a stub implementation pending a real Stripe account

See [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) for the authoritative, milestone-by-milestone status of what's implemented and tested, including which of the above are v1/placeholder implementations with known gaps.

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
- **`anon` public key** (Project Settings → API) → `SUPABASE_ANON_KEY`, used by every member's `crosscode login`
- **`service_role` key** (Project Settings → API) → `SUPABASE_SERVICE_ROLE_KEY`, used only by the admin-side `service:provision` command — never distribute this key to members
- **Connection string** (Project Settings → Database) → `DATABASE_URL` (Supabase's pooled `postgres://` connection string works as-is)

Supabase projects sign access tokens with an asymmetric key (ES256 by default), verified via the project's public JWKS endpoint (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`) rather than a shared secret — there is no JWT secret to configure.

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<project service_role key>"
export DATABASE_URL="<Supabase pooled connection string>"
export MIGRATION_DATABASE_URL="${DATABASE_URL}"
pnpm service:migrate
pnpm service
```

Migration `004_supabase_auth.sql` enables Row Level Security and maps `members` to Supabase's `auth.users` by `user_id`; `005_rls_hardening.sql` adds the RLS policies for `handoffs`/`intents` and moves the `membership_workspace_ids()` helper into a `private` schema so it isn't directly callable as a PostgREST RPC endpoint. Because a real `REFERENCES auth.users(id)` foreign key requires the `auth` schema (which only exists inside an actual Supabase project, not a plain test Postgres instance), add it once by hand after migrating against Supabase:

```sql
ALTER TABLE members ADD CONSTRAINT members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
```

The service defaults to `http://127.0.0.1:8788`. Plain HTTP is allowed only on loopback. To bind to another interface, configure both `CROSSCODE_TLS_KEY` and `CROSSCODE_TLS_CERT`; startup refuses non-loopback plaintext HTTP.

Service environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | Supabase (or plain) PostgreSQL connection string | required |
| `SUPABASE_URL` | Supabase project URL, used to verify token issuer and fetch its JWKS | required |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key; only needed by `pnpm service:provision`, not by `pnpm service` itself | required for provisioning |
| `CROSSCODE_SERVICE_HOST` | Listen address | `127.0.0.1` |
| `CROSSCODE_SERVICE_PORT` | Listen port | `8788` |
| `CROSSCODE_TLS_KEY` | TLS private-key path | unset |
| `CROSSCODE_TLS_CERT` | TLS certificate path | unset |

Run `pnpm service:migrate` with a migration-owner connection before starting a new service version. `CROSSCODE_RUNTIME_DB_ROLE` applies the required least-privilege grants, and service startup refuses a role that can update/delete immutable operations or audit rows. The runtime never executes DDL. Non-loopback PostgreSQL URLs must specify exactly one `sslmode=verify-full` and cannot use host/SSL query overrides. For local-only testing against a plain (non-Supabase) Postgres instance, `infra/docker-compose.yml` still starts one on `127.0.0.1:5432`; it is not used in production, where `DATABASE_URL` points at Supabase.

## Workspaces, members, and invites (CLI and API only)

Crosscode's multi-tenant machinery is intact — workspaces, memberships, invites, one-time pairing codes, roles, Row Level Security, presence, and billing all live in the coordination service. **None of it has a web UI.** You reach it from the CLI or directly over the service's HTTP API:

| What | How |
| --- | --- |
| Create a workspace | `POST /v1/workspaces`, or automatically: a user with no memberships gets a personal workspace on their first authenticated request |
| List your memberships | `GET /v1/memberships` |
| Create / list / revoke an invite | `POST /v1/invites`, `GET /v1/invites`, `DELETE /v1/invites/:code` (owner only) |
| Redeem an invite | `crosscode join --invite <code>`, or `POST /v1/invites/:code/redeem` |
| Mint a one-time pairing code | `POST /v1/pairing-codes` (owner or member) |
| Redeem a pairing code from a checkout | `crosscode join --pair <code>` — no prior `init` and no login required |
| Set the autonomy tier | `crosscode workspace autonomy get` / `crosscode workspace autonomy set <tier>` |
| Read plan and usage | `crosscode billing status --workspace <id>` |

`pnpm service:provision` remains available as an administrator-side command for the self-hosted case. It creates or invites a Supabase Auth user by email (via the Supabase admin API, using `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) and writes the corresponding workspace/member row directly to Postgres (`MIGRATION_DATABASE_URL` or `DATABASE_URL`).

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
pnpm crosscode init --json
pnpm crosscode join --workspace <workspaceId> --json
pnpm crosscode login --email alice@example.com --password <her password> --service http://127.0.0.1:8788 --json
pnpm daemon
```

`crosscode login` needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` set in its own environment (the anon key collected above) to reach Supabase Auth. There is no separate replica-enrollment step: the daemon self-registers a replica for the authenticated member the first time it starts with a logged-in session and no replica identity of its own yet.

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
pnpm crosscode status --json

# Declare local work
pnpm crosscode task create "Implement checkout API" --path server/routes/checkout --json
pnpm crosscode claim path server/routes/checkout --task <task-id> --json

# Create or inspect safety checkpoints
pnpm crosscode checkpoint --message "before integration" --json
pnpm crosscode checkpoint inspect <checkpoint-ref> --json

# Review remote work
pnpm crosscode proposals list --json
pnpm crosscode proposals inspect <operation-id> --json

# Materialize only after an explicit decision
pnpm crosscode accept <operation-id> --json
pnpm crosscode reject <operation-id> --json

# Run commands from a committed validation profile
pnpm crosscode validate --profile fast --json
```

The daemon continues capturing work while the service is unavailable. Pending outbound events survive daemon restarts. When connectivity returns, the daemon retries the same immutable event IDs, records acknowledgements, downloads operations after its saved cursor, and stores remote operations as proposals without changing files.

## For coding agents

Crosscode is designed to be driven by an agent with shell access and no browser. See [`AGENTS.md`](./AGENTS.md) for the full agent-facing contract; the short version:

**Discovery.** `crosscode commands --json` prints the entire command tree — every command, its arguments, its options, and its description — as machine-readable JSON. Branch on that rather than parsing `--help`.

```bash
crosscode commands --json
```

**Output.** `--json` is a position-independent flag accepted on every command. With it, stdout is exactly one line of compact JSON: `{"value":…}` on success, `{"error":{"code":…,"message":…,"hint":…}}` on failure. Without it, the same objects are pretty-printed. Nothing else is written to stdout, so it is safe to parse directly.

**Login.** Never shell out to a browser. Use the non-interactive path:

```bash
crosscode login --email "$EMAIL" --password "$PASSWORD" --json
# {"value":{"userId":"…","email":"…"}}
```

`CROSSCODE_EMAIL` / `CROSSCODE_PASSWORD` work in place of the flags. Access and refresh tokens are never printed and never appear in `--json` output — they go straight to the mode-`0600` daemon config. There is no token environment variable to set.

**Exit codes.** `0` on success. `1` on any error, with the failure described by the `error.code` on stdout. `crosscode run -- <command>` is the exception: it propagates the wrapped command's own exit code unchanged.

**Error codes to branch on:**

| `error.code` | Meaning | What an agent should do |
| --- | --- | --- |
| `USAGE_ERROR` | Bad or missing arguments | Re-read `crosscode commands --json`; do not retry verbatim |
| `UNKNOWN_COMMAND` | No such command | Re-read `crosscode commands --json` |
| `DAEMON_UNAVAILABLE` | No daemon for this worktree | Run `crosscode init`, then start the daemon (or make one MCP tool call, which bootstraps it) |
| `LOGIN_STATE_MISMATCH` | Browser callback carried a wrong or missing `state` | Do not retry the browser flow unattended; use `--email`/`--password` |
| `LOGIN_TIMEOUT` | No browser callback within 300s | Use `--email`/`--password`, or `--no-browser` and hand the URL to a human |
| `UNTRUSTED_VALIDATION_ARGS` | Tried to pass validation commands as arguments | Use `--profile <name>`; profiles come only from committed `.crosscode/config.yaml` |
| `CONFIRMATION_REQUIRED` | `publish` needs confirmation and there is no TTY | Pass `--yes`, only if publishing was actually authorized |
| `CANCELLED` | A confirmation was declined | Stop; do not retry |
| `COMMAND_FAILED` | Anything else | Report `error.message` verbatim rather than guessing |

**MCP.** The same operations are available as MCP tools with no shell at all — including the full proposal lifecycle (`inspect_proposal`, `diff_proposal`, `accept_proposal`, `reject_proposal`, `publish_branch`). See [`docs/mcp-clients.md`](./docs/mcp-clients.md) for the tool catalog and client setup.

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
- Workspace, membership, invite, and billing management is CLI- and API-only. There is no web UI for any of it, by decision — the website is landing, sign-up/sign-in, and docs.
- Billing is a placeholder: the plan/usage data model and enforcement helpers exist, but there is no Stripe account behind them yet (see BUILD_INSTRUCTIONS.md Phase 10).
- Deliberately not published to npm or any editor marketplace — the supported surface is the daemon + MCP server, run from a cloned checkout via `pnpm install` and `tsx` (see `docs/install-prompt.md`).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev
setup, workspace layout, and PR expectations. Participation in this project is
governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). To report a security
vulnerability, see [SECURITY.md](./SECURITY.md) rather than opening a public
issue. Crosscode is licensed under the [MIT License](./LICENSE).
