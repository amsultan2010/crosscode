# Crosscode architecture

```text
human / coding agent
        |
        |  CLI (`crosscode …`)      MCP tools (stdio)
        v                            v
per-worktree daemon --- SQLite events + outbox
        |
        | authenticated HTTP sync
        v
coordination service --- Supabase-hosted PostgreSQL operations + audit log
        |
        v
other daemons receive reviewable proposals
```

Crosscode's job is to get every teammate's settled work in front of everyone
else within seconds, instead of at pull-request time. The topology above is
what that requires: a daemon per checkout so edits are captured where they
happen, and one coordination service so every other checkout learns about them.
The accept step is a design choice, not a limitation. Proposals are applied by
the person whose working tree it is, never pushed into it.

Crosscode is CLI-first. Every coordination operation happens against the local
daemon through the CLI or MCP: status, tasks, claims, proposal review,
accept/reject, checkpoints, validation, and publish. The website
(`apps/docs-site`) is not part of this topology: it is a landing page, the auth
pages (sign-up, sign-in, password reset, and the `crosscode login` callback at
`/auth/cli.html`), and the documentation generated from the root `docs/*.md`.
Nothing else lives behind auth, and no browser page reads or writes workspace
state.

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
authenticate directly against Supabase Auth, with `crosscode login` (loopback
browser callback) or `crosscode login --email/--password` (headless). See
[Sign-in](#sign-in-crosscode-login) below. The service verifies the resulting Supabase-issued JWTs
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

The service is multi-tenant and keeps the whole team surface: workspaces,
memberships, roles, invites (`/v1/invites`), one-time pairing codes
(`/v1/pairing-codes`), projects (`/v1/projects`), presence, and billing. All of
it is reached from the CLI or over HTTP; none of it has a web UI.

File payloads reach the service sealed. Contents, paths, diffs, content hashes,
and the change intent recorded with a transaction are encrypted under a
workspace key the service never holds, so `operations.transaction` stores an
opaque blob plus one HMAC path token per changed file. Tasks, claims, handoffs,
published intents, and validation results are stored in the clear, which is what
lets the service enforce membership and order them by cursor. See
[security.md](./security.md#end-to-end-encryption).

## Sign-in (`crosscode login`)

`crosscode login` has two paths to the same Supabase session, and the daemon
cannot tell them apart afterwards.

**Browser (default, needs a TTY).** The CLI starts a short-lived HTTP server
bound to `127.0.0.1` on an ephemeral port with a single `/callback` route, and
generates a 32-character random `state`. It opens
`${WEB_URL}/auth/cli.html?port=<port>&state=<state>`. `WEB_URL` comes from
`--web`, else `CROSSCODE_WEB_URL`, else the deprecated `CROSSCODE_DASHBOARD_URL`,
else the hosted default `https://www.getcrosscode.dev` compiled into
`apps/daemon/src/hosted.ts`. Because there is a default, bare `crosscode login`
works and `WEB_URL_REQUIRED` is no longer reachable. That page signs the
visitor in against Supabase (rendering the ordinary sign-in form if they aren't
already), then POSTs the session back to `http://127.0.0.1:<port>/callback` as
`{ state, access_token, refresh_token, expires_at, user: { id, email } }` and
tells them to return to the terminal. The loopback server answers the CORS
preflight (`OPTIONS /callback` → `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Methods: POST, OPTIONS`,
`Access-Control-Allow-Headers: content-type`) so that fetch succeeds. A
mismatched or missing `state` fails with `LOGIN_STATE_MISMATCH`; no callback
within 300 seconds fails with `LOGIN_TIMEOUT`. `--no-browser` prints the URL
instead of opening it.

**Headless.** `crosscode login --email <e> --password <p>` signs in directly
against Supabase with no browser, no loopback server, and no TTY. This is the
path for coding agents and CI.

Either way the session is persisted by the same daemon config writer into the
mode-`0600` `<git-dir>/crosscode/config.json` (refresh token to the OS keychain
where one is available). Tokens are never printed and never appear in `--json`
output; `crosscode login --json` emits only
`{"value":{"userId":"…","email":"…"}}`. See
[security.md](./security.md#sign-in-threat-model) for why.

## Thin clients (`apps/cli`, `apps/mcp-server`)

The CLI and the MCP server hold no sync state of their own. They talk to the local
daemon's HTTP API and render or forward its state: status, tasks, claims, proposal
inspection, accept/reject, checkpoints, and validation runs. `apps/mcp-server`
additionally bootstraps the daemon on first connection if one isn't already running
for the worktree. These two, plus the daemon itself, are the entire supported
product surface: every editor and agent, including VS Code and Cursor,
integrates via MCP ([mcp-clients.md](./mcp-clients.md)). There is no editor
extension. [`AGENTS.md`](../AGENTS.md) formalizes the contract: humans and
agents alike get direct access to every routine operation (status, claims,
checkpoints, accept/reject, publish) with no website involved.

## Safety invariants

1. The local filesystem remains authoritative for local work.
2. Remote operations arrive as proposals and are never automatically applied.
3. Every materialization checks the local base again and creates a checkpoint first.
4. Excluded paths, common secret files, symlink traversal, and payloads that are
   malformed or whose content does not match its recorded hash are rejected.
   Binary files themselves are supported. They travel base64-encoded and are
   materialized byte-exactly, but any *conflict* involving one requires human
   approval, since hunk-level merge analysis is text-only.

If Crosscode is stopped or removed, the repository remains an ordinary Git
repository. Git is the durable history and publishing layer, and checkpoints live
under `refs/crosscode/checkpoints/...` without polluting normal branch history.

See [README.md](../README.md) for setup and current capabilities, and
[BUILD_INSTRUCTIONS.md](../BUILD_INSTRUCTIONS.md) for the milestone-by-milestone
implementation status.
