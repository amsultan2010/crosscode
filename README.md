# Crosscode

[![CI](https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml/badge.svg)](https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Crosscode makes working on a codebase together feel closer to working on one document together.**

Google Docs solved this for writing. Code did not get that: everyone works on their own copy, nobody sees anyone else's work until a pull request lands, and the team spends real time stitching it all back together at the end. That gap is what Crosscode closes.

Each person (or agent) works in their own normal Git checkout. A small background program — the daemon — watches that checkout and notices whenever an edit has settled, then sends a record of it to a shared coordination service, which passes it on to everyone else. Within seconds, your teammates can see what you just built.

It stops one step short of a shared document, deliberately: incoming edits are **never written to your files automatically**. They show up as *proposals* — you look at the diff and pull it in with one command. Live typing into someone else's working tree is the one thing you do not want in code, so that decision stays yours.

Everything stays ordinary Git. Crosscode doesn't replace your editor, your agent, your Git host, your branches, your staging area, or your commits — and if you turn it off, your repository is unchanged.

**Who it's for.** Teams building something together on one codebase, where the people are all running coding agents — a startup, a hackathon crew, any project moving faster than its pull requests. It keeps working when you are the only person online that day, because the project is still shared and your teammates' work will land on it again. What it is *not* for is a repository only one person will ever touch: there is nothing to coordinate with, and plain Git is the better tool. Human-only teams can use it too, though it pays off most once agents are in the mix.

**There is no web app.** Everything you do day to day — signing in, claiming work, reviewing proposals, accepting, publishing — is a `crosscode` command or an MCP tool call your agent makes against your local daemon. The website is only a landing page, sign-up/sign-in, and these docs.

### What you need before you start

Crosscode is not a hosted service yet. Someone on your team has to run the coordination service (a small Node process backed by a [Supabase](https://supabase.com) project) — see [Set up Supabase and run the coordination service](#set-up-supabase-and-run-the-coordination-service). Once that exists, everyone else just points their checkout at it.

## Quickstart

This assumes the coordination service is already running and you know its URL (`http://127.0.0.1:8788` if you started it locally).

1. **Set up the checkout.** `init` writes Crosscode's local state for this worktree, and has to come first.

   ```bash
   crosscode init --json
   ```

2. **Get an account.** If you don't have one, sign up straight from the terminal:

   ```bash
   crosscode signup --email <email> --password <password> --service <service-url> --json
   ```

   This creates the account, logs you in, and gives you a personal workspace, so there is nothing else to join. You can also sign up on the website if one is deployed, then log in below.

   Accounts live in a Supabase project. Crosscode ships with the hosted Crosscode project compiled in — its `anon` public key, the same one the website serves to browsers — so this step needs no environment setup. **If the coordination service you are pointing at is self-hosted, it verifies tokens against its own Supabase project, so you must sign in against that same project:**

   ```bash
   export SUPABASE_URL="https://<project-ref>.supabase.co"   # the project the service uses
   export SUPABASE_ANON_KEY="<anon public key>"
   ```

   Set both or neither; setting one alone fails with `SUPABASE_CONFIG_MISSING`. Whoever runs the service has these two values — see [Set up Supabase and run the coordination service](#set-up-supabase-and-run-the-coordination-service).

3. **Or log in, if the account already exists.**

   ```bash
   crosscode login --web <site-url> --service <service-url>
   ```

   In a real terminal this opens the sign-in page in your browser and the CLI picks up the session on a loopback callback; tokens are never printed. Both flags are optional: `--service` defaults to the hosted coordination service and `--web` to the hosted website (`apps/daemon/src/hosted.ts`), so bare `crosscode login` works. Self-hosters override with the flags or with `CROSSCODE_SERVICE_URL` / `CROSSCODE_WEB_URL`. Add `--no-browser` to print the URL instead of opening it.

   Agents, CI, and anything without a browser should use the headless path instead, which needs no `--web` at all:

   ```bash
   crosscode login --email <email> --password <password> --json
   # {"value":{"userId":"…","email":"…"}}
   ```

   Full contract: [BUILD_INSTRUCTIONS.md § Authentication](./BUILD_INSTRUCTIONS.md#authentication--crosscode-login) and [`docs/onboarding-contracts.md`](./docs/onboarding-contracts.md).

4. **Join someone else's workspace** — only if you're not using your own personal one.

   ```bash
   crosscode join --workspace <workspaceId> --json   # or --invite <code>, or --pair <code>
   ```

5. **Do real work.** Start the daemon (`pnpm daemon`, or let the MCP server start it for you) and use the commands under [Normal workflow](#normal-workflow).

## Fastest way to try it with an agent

Paste the prompt in [`docs/install-prompt.md`](./docs/install-prompt.md) into any MCP-capable coding agent (Claude Code, Codex CLI, OpenCode, Cursor, etc.). The agent clones this repository, installs dependencies, and registers the Crosscode MCP server for your project itself — no manual `init`/daemon step. The daemon starts itself, in the background, the first time the agent calls a Crosscode tool.

## What works today

**Watching your checkout**

- One daemon per Git checkout/worktree, which survives restarts
- Captures an edit once it has settled, with before/after hashes so a stale edit can't be applied on top of a newer one
- Records everything to a local append-only SQLite log, plus an outbox for work made while offline
- Hidden Git checkpoints — snapshots that never move `HEAD`, touch your index, or show up in branch history
- Notices branch switches, commits, resets, index changes, merges, rebases, cherry-picks, and reverts

**Sharing work with everyone else**

- A coordination service backed by Supabase-hosted PostgreSQL, with an immutable audit log
- Uploads are idempotent, and after a disconnect the daemon resumes from exactly where it left off
- Live presence, tasks, claims, handoffs, and intents over WebSocket, falling back to polling when the socket drops. Paired installs (`crosscode join --pair`) subscribe with their workspace token and get the same live updates as a logged-in one
- Text and binary files (binaries travel base64-encoded and are restored byte-for-byte), and renames tracked as real renames rather than a delete plus an add

**Reviewing before anything lands**

- Inspect, diff, accept, or reject each incoming proposal explicitly
- Applying a change is crash-safe and never clobbers a newer local edit
- Validation profiles that only come from a committed `.crosscode/config.yaml`, so nobody can smuggle in an arbitrary command
- An optional AI reviewer for genuinely ambiguous conflicts. It only ever advises — it can't decide anything on its own, it's off unless workspace policy turns it on, and its suggestions still need human approval
- A per-workspace autonomy setting (always ask / auto-apply when clean / auto-apply always) for teams that want to loosen the always-ask default
- `publish --branch` turns accepted work into ordinary commits on a real branch, with a dry-run plan first

**Accounts and teams**

- Sign up yourself, from the website or `crosscode signup` — no administrator step needed. Your first account gets a personal workspace automatically
- Multiple workspaces, memberships, roles, invite codes, and one-time pairing codes, all from the CLI or the service's HTTP API
- Sign-in goes through Supabase Auth, in a browser (`crosscode login`) or headlessly for agents and CI (`crosscode login --email/--password`), and this machine registers itself the first time the daemon starts

**Connecting your tools**

- A standards-compliant MCP server that starts the daemon for you on the first tool call
- Any MCP-capable agent or editor works: Claude Code, Codex CLI, OpenCode, Cursor, VS Code, Gemini CLI. There's no editor plugin to install — see [`docs/mcp-clients.md`](./docs/mcp-clients.md)
- Nobody, human or agent, has to open a website to do routine work. See [`AGENTS.md`](./AGENTS.md)

See [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) for the authoritative, milestone-by-milestone status of what's implemented and tested, including which of the above are v1/placeholder implementations with known gaps, and [Current limitations](#current-limitations) for the honest gaps.

## Safety model

Crosscode follows four rules:

1. **Your files win locally.** Whatever is on your disk is the truth for your own work.
2. **Nothing from anyone else is written without your say-so.** Remote work arrives as a proposal; accepting it is an explicit act.
3. **Every write is checked and backed up first.** Before applying a proposal, Crosscode re-checks that your files still match what the change was based on, and takes a checkpoint it can roll back to.
4. **Some things are refused outright:** excluded paths, files that look like secrets, symlinks pointing outside the repository, and payloads that are malformed or whose content doesn't match its hash.

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
- **`anon` public key** (Project Settings → API) → `SUPABASE_ANON_KEY`, used by every member's `crosscode login`. Members of a self-hosted deployment must set this and `SUPABASE_URL` in their own environment, because the CLI otherwise signs in against the hosted Crosscode project it has compiled in, and this service would reject those tokens as having the wrong issuer.
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
| `CROSSCODE_TRUST_PROXY_TLS` | Set to `true` only when a proxy in front terminates TLS and forwards plaintext (managed container hosts do this). Permits a non-loopback bind without a local certificate. | unset |
| `CROSSCODE_ALLOWED_ORIGINS` | Comma-separated exact browser origins allowed to call the API cross-origin, e.g. `https://crosscode-one.vercel.app`. Empty means no browser may call it. | unset |

### Deploying the coordination service

The service's clients are daemons and the CLI, not a browser — the website talks only to
Supabase (sign-in) and to a loopback port on your own machine (the `crosscode login`
callback), never to this service.

The service must run as a **persistent process**, not on serverless functions: `apps/daemon`
holds an open WebSocket to `/v1/stream` for live coordination, and serverless platforms drop
long-lived connections between invocations. `apps/service/Dockerfile` builds a deployable
image for any container host (Fly, Railway, Render, Cloud Run, or Docker on a VPS):

```bash
# Build from the repository root, not from apps/service.
docker build -f apps/service/Dockerfile -t crosscode-service .
```

Set on the host: `DATABASE_URL`, `SUPABASE_URL`, and — when a proxy in front terminates TLS —
`CROSSCODE_TRUST_PROXY_TLS=true`. `CROSSCODE_ALLOWED_ORIGINS` stays unset in the CLI-only
product, which means no browser origin may call the API cross-origin; it exists for anyone
building their own browser client against the service.

Run `pnpm service:migrate` with a migration-owner connection before starting a new service version. `CROSSCODE_RUNTIME_DB_ROLE` applies the required least-privilege grants, and service startup refuses a role that can update/delete immutable operations or audit rows. The runtime never executes DDL. Non-loopback PostgreSQL URLs must specify exactly one `sslmode=verify-full` and cannot use host/SSL query overrides. For local-only testing against a plain (non-Supabase) Postgres instance, `infra/docker-compose.yml` still starts one on `127.0.0.1:5432`; it is not used in production, where `DATABASE_URL` points at Supabase.

## Workspaces, members, and invites (CLI and API only)

Crosscode's multi-tenant machinery is intact — workspaces, memberships, invites, one-time pairing codes, roles, Row Level Security, presence, and billing all live in the coordination service. **None of it has a web UI.** You reach it from the CLI or directly over the service's HTTP API:

| What | How |
| --- | --- |
| Create a workspace | `POST /v1/workspaces`, or automatically: a user with no memberships gets a personal workspace on their first authenticated request |
| List your memberships | `GET /v1/memberships` |
| Create / list / revoke an invite | `POST /v1/invites`, `GET /v1/invites`, `DELETE /v1/invites/:id` (owner only) |
| Redeem an invite | `crosscode join --invite <code>`, or `POST /v1/invites/:code/redeem` |
| Mint a one-time pairing code | `POST /v1/pairing-codes` (owner or member) |
| Redeem a pairing code from a checkout | `crosscode join --pair <code>` — no prior `init` and no login required |
| List / revoke a paired device | `crosscode devices list` / `crosscode devices revoke <tokenId>`, or `GET`/`DELETE /v1/workspace-tokens[/:id]` (owner only) |
| List / remove a member | `crosscode members list` / `crosscode members remove <memberId>`, or `GET /v1/members`, `DELETE /v1/members/:id` (owner only) |
| Set the autonomy tier | `crosscode workspace autonomy get` / `crosscode workspace autonomy set <tier>` |
| Read plan and usage | `crosscode billing status [--workspace <id>]` |

Revoking a device or removing a member takes effect on that credential's very next
request: `ccw_` workspace tokens are opaque and resolved against the database on every
call, and every authorization path filters on the member's `disabled_at`. Removing a
member also retires their replicas and revokes their workspace tokens in the same
transaction. A workspace always keeps at least one owner, and an owner cannot remove
themselves. Both actions are refused to a `ccw_` token: team management needs a real
Supabase session, so a leaked terminal-side credential cannot retire its own audit trail.

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

`crosscode login` reaches Supabase Auth through the hosted Crosscode project compiled into the CLI unless `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set in its own environment (the project URL and anon key collected above) — which, for a self-hosted service, they must be, so that the tokens it mints carry the issuer this service verifies. Set both or neither; one alone fails with `SUPABASE_CONFIG_MISSING`. There is no separate replica-enrollment step: the daemon self-registers a replica for the authenticated member the first time it starts with a logged-in session and no replica identity of its own yet.

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

**Output.** `--json` is a position-independent flag accepted on every command. With it, stdout is exactly one line of compact JSON: `{"value":…}` on success, `{"error":{"code":…,"message":…,"hint":…}}` on failure. Without it, the same data is pretty-printed for a human: the success value on its own, without the `value` envelope, and errors still under `error`. Nothing else is written to stdout, so it is safe to parse directly.

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
| `SUPABASE_CONFIG_MISSING` | No Supabase project resolved, or only one of the two variables is set | Set both `SUPABASE_URL` and `SUPABASE_ANON_KEY`, or unset both to use the compiled-in hosted project |
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
pnpm build                 # tsc --noEmit under strict, then esbuild-bundles dist/
pnpm test                  # unit + local-daemon suites
pnpm test:postgres         # PostgreSQL suites, serialized; needs CROSSCODE_TEST_DATABASE_URL
pnpm docs:build            # regenerates the docs site from docs/*.md
pnpm audit --audit-level high
```

### Packaging

`pnpm build` bundles three entrypoints into `dist/` with esbuild — `cli.js` (the
`crosscode` bin), `mcp.js` (the `crosscode-mcp` bin), and `daemon.js`, which is not a bin
but is spawned by the MCP server's bootstrap from wherever it was installed. The
`@crosscode/*` workspace packages are inlined; the ten real npm dependencies stay external
and are declared on the root manifest. `scripts/build.mjs` fails the build if anything from
`node_modules` gets inlined, which is what keeps that list honest.

The root package is the published one. To check the tarball before publishing:

```bash
npm pack                                    # inspect contents; dist/ + README + LICENSE only
npm i -g ./crosscode-cli-*.tgz             # or --prefix <dir> to keep it out of your global bin
cd $(mktemp -d) && git init -q . && crosscode init --json && crosscode status --json
```

`apps/service` is deliberately not part of this package: it deploys as a container.

`pnpm test` skips the PostgreSQL suites unless `CROSSCODE_TEST_DATABASE_URL` is set, and
they should be run through `pnpm test:postgres` rather than by setting that variable for
`pnpm test`: they share one database, and running them alongside parallel test files lets
unrelated suites interleave session and presence rows. CI runs both steps separately for
the same reason.

The current suite covers protocol boundaries, authenticated daemon HTTP, Git checkpoints, filesystem capture, SQLite restart recovery, outbox identity, stale-base refusal, exclusions, binary safety, crash rollback, Git transitions, MCP-to-daemon mapping, and real daemon child-process restart behavior.

For the implementation plan and current milestone ledger, see [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md).

## Current limitations

- Production PostgreSQL role grants still need environment-specific deployment hardening. Retention is opt-in and admin-only: `pnpm service:prune -- --older-than-days <n>` deletes old audit events and ended sessions; cursor-reconnect-dependent tables are deliberately never pruned.
- Supabase refresh tokens are stored in the OS keychain when available (macOS `security`, Linux `secret-tool`); otherwise, including on Windows, the mode-`0600` Git-directory configuration fallback is used.
- Binary files are shared base64-encoded with byte-exact materialization; any conflict involving a binary file requires human approval, since deterministic hunk/merge analysis is text-only.
- Renames are tracked as first-class rename changes (old path, new path, content); a rename conflicting with pending work on either path, moving into or out of a critical path, or whose source has diverged locally always requires approval.
- Dependency-impact analysis for `.ts`/`.tsx` is a syntactic AST walk, not a type-checker-backed analysis (see BUILD_INSTRUCTIONS.md Milestone C for exact scope).
- There is no hosted/managed coordination service yet — you run a Supabase project and the service yourself.
- There is no production website deployed yet, so `crosscode login` has no default site to open. Pass `--web <url>` or set `CROSSCODE_WEB_URL`, or use the headless `--email`/`--password` path, which needs neither. (`CROSSCODE_DASHBOARD_URL` is still read as a deprecated fallback for setups made before the web dashboard was removed; it warns once on stderr. Prefer `CROSSCODE_WEB_URL`.)
- Workspace, membership, invite, and billing management is CLI- and API-only. There is no web UI for any of it, by decision — the website is landing, sign-up/sign-in, and docs.
- Billing has no payment provider behind it yet (see BUILD_INSTRUCTIONS.md Phase 10). The limits themselves are enforced: seat caps are checked inside the transaction that adds a member, and the autonomy tier a plan unlocks is checked on the write path, both answering `402` rather than `403` so a client can tell "out of seats" from "not allowed". The semantic-review call counter is deliberately not metered — review is delegated to your own already-connected MCP agent and never leaves your machine, so there is no per-call cost to bill and `GET /v1/workspace/billing` correctly reports zero calls used.
- `pnpm test` skips the PostgreSQL integration suites unless `CROSSCODE_TEST_DATABASE_URL` is set, so a local run leaves the service's store, pairing, and reconnect paths unexercised. CI sets it; to run them locally use `pnpm test:postgres`.
- There is no linter or formatter configured. `pnpm build` (`tsc --noEmit`) under `strict` is the only static gate.
- Not on npm yet. The `@crosscode/cli` package builds, packs, and installs — `npm pack` produces a tarball whose `crosscode` and `crosscode-mcp` binaries work outside this repo on nothing but Node 24 — but it has never been published, so the documented install path is still a cloned checkout run via `pnpm install` and `tsx` (see `docs/install-prompt.md`). The unscoped name `crosscode` is owned by an unrelated project, which is why the package is published under the `@crosscode` scope while both binaries keep their short names. Publishing is one `npm publish` away; `docs/install-prompt.md`, `docs/mcp-clients.md`, and the marketing site's install snippet all need updating to the npm path at the same time. There is no editor marketplace extension.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev
setup, workspace layout, and PR expectations. Participation in this project is
governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). To report a security
vulnerability, see [SECURITY.md](./SECURITY.md) rather than opening a public
issue. Crosscode is licensed under the [MIT License](./LICENSE).
