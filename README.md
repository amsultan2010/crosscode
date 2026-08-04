# Crosscode

[![CI](https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml/badge.svg)](https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Crosscode makes working on a codebase together feel closer to working on one document together.**

Google Docs solved this for writing. Code never got it. Everyone works on their own copy, nobody sees anyone else's work until a pull request lands, and the team spends real time stitching it back together at the end.

Each person or agent works in a normal Git checkout. A background daemon watches that checkout, notices when an edit has settled, and sends a record of it to a shared coordination service, which passes it on to everyone else. Your teammates see what you built within seconds.

It stops one step short of a shared document. Incoming edits are **never written to your files automatically**. They arrive as *proposals*: you read the diff and pull it in with one command. Live typing into someone else's working tree is the thing you do not want in code, so that decision stays yours.

Everything stays ordinary Git. Crosscode does not replace your editor, your agent, your Git host, your branches, or your commits, and if you turn it off your repository is unchanged.

**Who it's for.** Teams building on one codebase where the people are running coding agents: a startup, a hackathon crew, any project moving faster than its pull requests. It still works on a day when you are the only person online, because your teammates' work lands on the same project later. It is not for a repository only one person will ever touch, where there is nothing to coordinate and plain Git is the better tool. Human-only teams can use it, though it pays off most once agents are in the mix.

**There is no web app.** Signing in, claiming work, reviewing proposals, accepting, and publishing are all `crosscode` commands, or MCP tool calls your agent makes against your local daemon. The website is a landing page, sign-up/sign-in, and these docs.

> **Status as of 2026-08-04.** Two things below describe how Crosscode is built rather than
> what you can run today.
>
> - `@crosscode/cli` is not published to npm yet, so `npx @crosscode/cli` and
>   `npm install -g @crosscode/cli` both fail with a 404. Build and install from a clone
>   instead: see [Packaging](#packaging).
> - The hosted coordination service at `https://www.getcrosscode.dev` is deployed and the
>   site serves, but every `/api/v1/*` route currently answers 500, so the default service
>   is not usable. Running the service yourself works.

### What you need before you start

Node 24 and a Git checkout. Crosscode points at the hosted coordination service by default, so there is nothing to deploy and no Supabase project to create. Teams who would rather run the service themselves can, and then point their checkouts at it with `--service`. See [Set up Supabase and run the coordination service](#set-up-supabase-and-run-the-coordination-service).

## Quickstart

From inside the repository you want your team's agents to share:

```bash
npx @crosscode/cli start
```

That is the whole setup. It configures the checkout, opens your browser to sign in or create an account, attaches you to the personal workspace your account is given automatically, starts the background daemon, and registers the Crosscode MCP server with your coding agent. No flags, no service URL, no Supabase setup. Restart your agent afterwards so it picks up the new MCP server.

Install it properly once you know you want it, so the daemon runs from a stable path instead of npm's cache:

```bash
npm install -g @crosscode/cli
crosscode start
```

`start` is safe to re-run: every step it performs is skipped if it is already done, so in a configured checkout it just reports the state and makes sure the daemon is up. Useful flags:

```bash
crosscode start --mcp cursor        # register with Cursor, Gemini CLI (gemini), or OpenCode instead of Claude Code
crosscode start --no-mcp            # skip MCP registration entirely
crosscode start --no-browser        # print the sign-in URL instead of opening it, for remote shells
crosscode start --email <e> --password <p>   # headless sign-in, for agents and CI
crosscode start --service <url>     # a self-hosted coordination service
```

To bring a teammate in, generate an invite and have them run `crosscode start` and then `crosscode join --invite <code>` in their own checkout.

### The same setup, one step at a time

`crosscode start` is exactly the sequence below, and each command still exists if you want to drive it yourself.

1. **Set up the checkout.** `init` writes Crosscode's local state for this worktree, and has to come first.

   ```bash
   crosscode init --json
   ```

2. **Get an account.** If you don't have one, sign up straight from the terminal:

   ```bash
   crosscode signup --email <email> --password <password> --service <service-url> --json
   ```

   This creates the account, logs you in, and gives you a personal workspace, so there is nothing else to join. You can also sign up at `https://www.getcrosscode.dev/auth/signup.html` and then log in below.

   Accounts live in a Supabase project. Crosscode compiles in the hosted project's URL and `anon` public key, so this step needs no environment setup. Against a self-hosted service, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to that deployment's project instead, as described under [Set up Supabase and run the coordination service](#set-up-supabase-and-run-the-coordination-service).

3. **Or log in, if the account already exists.**

   ```bash
   crosscode login --web <site-url> --service <service-url>
   ```

   In a real terminal this opens the sign-in page in your browser and the CLI picks up the session on a loopback callback; tokens are never printed. Both flags are optional. `--service` defaults to the hosted coordination service and `--web` to the hosted website, both `https://www.getcrosscode.dev` (`apps/daemon/src/hosted.ts`), so bare `crosscode login` works. Self-hosters override with the flags or with `CROSSCODE_SERVICE_URL` / `CROSSCODE_WEB_URL`. Add `--no-browser` to print the URL instead of opening it.

   Agents, CI, and anything without a browser should use the headless path instead, which needs no `--web` at all:

   ```bash
   crosscode login --email <email> --password <password> --json
   # {"value":{"userId":"…","email":"…"}}
   ```

   Full contract: [BUILD_INSTRUCTIONS.md § Authentication](./BUILD_INSTRUCTIONS.md#authentication--crosscode-login) and [`docs/onboarding-contracts.md`](./docs/onboarding-contracts.md).

4. **Join someone else's workspace**, only if you are not using your own personal one.

   ```bash
   crosscode join --workspace <workspaceId> --json   # or --invite <code>, or --pair <code>
   ```

5. **Do real work.** Start the daemon (`crosscode start`, or let the MCP server start it for you) and use the commands under [Normal workflow](#normal-workflow).

## Fastest way to try it with an agent

Paste the prompt in [`docs/install-prompt.md`](./docs/install-prompt.md) into any MCP-capable coding agent (Claude Code, Codex CLI, OpenCode, Cursor, and so on). The agent installs the CLI from npm, runs `crosscode start`, and registers the Crosscode MCP server for your project, with no manual `init` or daemon step. The daemon starts itself in the background the first time the agent calls a Crosscode tool. This needs the npm package, so it does not work until `@crosscode/cli` is published.

## What works today

**Watching your checkout**

- One daemon per Git checkout/worktree, which survives restarts
- Captures an edit once it has settled, with before/after hashes so a stale edit can't be applied on top of a newer one
- Records everything to a local append-only SQLite log, plus an outbox for work made while offline
- Hidden Git checkpoints: snapshots that never move `HEAD`, touch your index, or show up in branch history
- Notices branch switches, commits, resets, index changes, merges, rebases, cherry-picks, and reverts

**Sharing work with everyone else**

- A coordination service backed by Supabase-hosted PostgreSQL, with an immutable audit log
- Uploads are idempotent, and after a disconnect the daemon resumes from exactly where it left off
- Live presence, tasks, claims, handoffs, and intents over WebSocket, falling back to polling when the socket drops. Paired installs (`crosscode join --pair`) subscribe with their workspace token and get the same live updates as a logged-in one
- Text and binary files (binaries travel base64-encoded and are restored byte-for-byte), and renames tracked as real renames rather than a delete plus an add
- **File payloads are end-to-end encrypted by default.** File contents, paths, diffs, content hashes, and the change intent attached to a transaction are sealed on your machine under a workspace key the coordination service never receives. Coordination metadata outside the file payload is not sealed: task titles, claim targets, published intents, handoff notes, and validation output reach the service in the clear, and they can carry paths. See [`docs/privacy.md`](./docs/privacy.md) for the full list of what stays visible, and [`docs/security.md`](./docs/security.md#end-to-end-encryption) for the design

**Reviewing before anything lands**

- Inspect, diff, accept, or reject each incoming proposal explicitly
- Applying a change is crash-safe and never clobbers a newer local edit
- Validation profiles that only come from a committed `.crosscode/config.yaml`, so nobody can smuggle in an arbitrary command
- An optional AI reviewer for ambiguous conflicts. It only advises. It is off unless workspace policy turns it on, and its suggestions still need human approval
- A per-workspace autonomy setting (always ask / auto-apply when clean / auto-apply always) for teams that want to loosen the always-ask default
- `publish --branch` turns accepted work into ordinary commits on a real branch, with a dry-run plan first

**Accounts and teams**

- Sign up yourself, from the website or `crosscode signup`, with no administrator step. Your first account gets a personal workspace automatically
- Multiple workspaces, memberships, roles, invite codes, and one-time pairing codes, all from the CLI or the service's HTTP API
- Sign-in goes through Supabase Auth, in a browser (`crosscode login`) or headlessly for agents and CI (`crosscode login --email/--password`), and this machine registers itself the first time the daemon starts

**Connecting your tools**

- A standards-compliant MCP server that starts the daemon for you on the first tool call
- Any MCP-capable agent or editor works: Claude Code, Codex CLI, OpenCode, Cursor, VS Code, Gemini CLI. There is no editor plugin to install. See [`docs/mcp-clients.md`](./docs/mcp-clients.md)
- Nobody, human or agent, has to open a website to do routine work. See [`AGENTS.md`](./AGENTS.md)

[BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) is the authoritative milestone-by-milestone status of what is implemented and tested, including which of the above are v1 implementations with known gaps. [Current limitations](#current-limitations) lists the gaps.

## Safety model

Crosscode follows five rules:

1. **Your files win locally.** Whatever is on your disk is the truth for your own work.
2. **Nothing from anyone else is written without your say-so.** Remote work arrives as a proposal; accepting it is an explicit act.
3. **Every write is checked and backed up first.** Before applying a proposal, Crosscode re-checks that your files still match what the change was based on, and takes a checkpoint it can roll back to.
4. **Some things are refused outright:** excluded paths, files that look like secrets, symlinks pointing outside the repository, and payloads that are malformed or whose content doesn't match its hash.
5. **The coordination service cannot read your file payloads.** Contents, paths, diffs, hashes, and change intents are encrypted before they leave your machine, and a receiving checkout verifies them against a key the service has never held rather than trusting what the service asserts about them. Task titles, claim targets, published intents, handoff notes, and validation output travel in the clear, so the service can read those.

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

To *use* Crosscode: Node.js 24 or newer, and Git. `npm install -g @crosscode/cli` (or `npx @crosscode/cli start`) brings the CLI, the daemon, and the MCP server, and the hosted coordination service is the default. Until the package is published you install from a clone instead, as described under [Packaging](#packaging).

To *work on* Crosscode, or to run the coordination service yourself, you also need:

- pnpm 11
- A Supabase project, or Docker Desktop or another Docker-compatible runtime for local-only testing against a plain Postgres instance (`infra/docker-compose.yml`)

```bash
pnpm install
pnpm build
pnpm test
```

## Set up Supabase and run the coordination service

Crosscode's coordination service verifies Supabase-issued JWTs and stores workspace/operation state in Supabase-hosted PostgreSQL. Create a Supabase project (or use an existing one), then from its dashboard collect:

- **Project URL** (Project Settings → API) → `SUPABASE_URL`
- **`anon` public key** (Project Settings → API) → `SUPABASE_ANON_KEY`, used by every member's `crosscode login`. Members of a self-hosted deployment must set this and `SUPABASE_URL` in their own environment, because the CLI otherwise signs in against the hosted Crosscode project it has compiled in, and this service would reject those tokens as having the wrong issuer.
- **`service_role` key** (Project Settings → API) → `SUPABASE_SERVICE_ROLE_KEY`, used only by the admin-side `service:provision` command. Never distribute this key to members
- **Connection string** (Project Settings → Database) → `DATABASE_URL` (Supabase's pooled `postgres://` connection string works as-is)

Supabase projects sign access tokens with an asymmetric key (ES256 by default), verified against the project's public JWKS endpoint (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`) rather than a shared secret. There is no JWT secret to configure.

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

The service's clients are daemons and the CLI, not a browser. The website talks only to
Supabase (sign-in) and to a loopback port on your own machine (the `crosscode login`
callback), never to this service.

Run it as a **persistent process** if you want live coordination: `apps/daemon` holds an open
WebSocket to `/v1/stream`, and serverless platforms drop long-lived connections between
invocations, so a function deployment falls back to polling. `apps/service/Dockerfile` builds
a deployable image for any container host (Fly, Railway, Render, Cloud Run, or Docker on a
VPS):

```bash
# Build from the repository root, not from apps/service.
docker build -f apps/service/Dockerfile -t crosscode-service .
```

The hosted deployment takes the other route and runs the service as Vercel functions inside
the website (`apps/docs-site/api/[...path].ts`), which is why it polls rather than streams.

Set on the host: `DATABASE_URL`, `SUPABASE_URL`, and `CROSSCODE_TRUST_PROXY_TLS=true` when a
proxy in front terminates TLS. `CROSSCODE_ALLOWED_ORIGINS` stays unset in the CLI-only
product, which means no browser origin may call the API cross-origin. It exists for anyone
building their own browser client against the service.

Run `pnpm service:migrate` with a migration-owner connection before starting a new service version. Point `CROSSCODE_RETENTION_DATABASE_URL` (and optionally `CROSSCODE_RETENTION_SWEEP_MINUTES`, default 60) at that same privileged connection to enable the scheduled history-retention sweep. The least-privilege runtime role cannot delete operations, so without it retention runs only when an admin invokes `pnpm service:prune`. The sweep interval needs a persistent process, so the Vercel function deployment has to drive it externally with a scheduled `pnpm service:prune` until a platform cron is wired. `CROSSCODE_RUNTIME_DB_ROLE` applies the least-privilege grants, and startup refuses a role that can update or delete immutable operations or audit rows. The runtime never executes DDL. Non-loopback PostgreSQL URLs must specify exactly one `sslmode=verify-full` and cannot use host/SSL query overrides. `infra/docker-compose.yml` starts a plain Postgres on `127.0.0.1:5432` for local testing only; production `DATABASE_URL` points at Supabase.

## Workspaces, members, and invites (CLI and API only)

Workspaces, memberships, invites, one-time pairing codes, roles, Row Level Security, presence, and billing all live in the coordination service. **None of it has a web UI.** You reach it from the CLI or directly over the service's HTTP API:

| What | How |
| --- | --- |
| Create a workspace | `POST /v1/workspaces`, or automatically: a user with no memberships gets a personal workspace on their first authenticated request |
| List your memberships | `GET /v1/memberships` |
| Create / list / revoke an invite | `POST /v1/invites`, `GET /v1/invites`, `DELETE /v1/invites/:id` (owner only) |
| Redeem an invite | `crosscode join --invite <code>`, or `POST /v1/invites/:code/redeem` |
| Mint a one-time pairing code | `POST /v1/pairing-codes` (owner or member) |
| Redeem a pairing code from a checkout | `crosscode join --pair <code>`, which needs no prior `init` and no login |
| List / revoke a paired device | `crosscode devices list` / `crosscode devices revoke <tokenId>`, or `GET`/`DELETE /v1/workspace-tokens[/:id]` (owner only) |
| List / remove a member | `crosscode members list` / `crosscode members remove <memberId>`, or `GET /v1/members`, `DELETE /v1/members/:id` (owner only) |
| Set the autonomy tier | `crosscode workspace autonomy get` / `crosscode workspace autonomy set <tier>` |
| Read plan and usage | `crosscode billing status [--workspace <id>]` |
| Change plan (either direction) | `crosscode billing upgrade --plan <plan> [--monthly] [--seats <n>]`, or `POST /v1/workspace/billing/checkout` (owner only). Opens Stripe's hosted checkout for a first subscription, or moves an existing one in place with proration |
| Cancel | `crosscode billing cancel`, or `POST /v1/workspace/billing/cancel` (owner only). Takes effect at the end of the paid period and deletes nothing |
| Manage cards and invoices | `crosscode billing portal`, or `POST /v1/workspace/billing/portal` (owner only). Stripe's own hosted page, not a Crosscode web UI |

Revoking a device or removing a member takes effect on that credential's next request.
`ccw_` workspace tokens are opaque and resolved against the database on every call, and
every authorization path filters on the member's `disabled_at`. Removing a member also
retires their replicas and revokes their workspace tokens in the same transaction. A
workspace always keeps at least one owner, and an owner cannot remove themselves. Both
actions are refused to a `ccw_` token, because team management needs a real Supabase
session, so a leaked terminal-side credential cannot retire its own audit trail.

`pnpm service:provision` is the administrator-side path for a self-hosted deployment. It creates or invites a Supabase Auth user by email (via the Supabase admin API, using `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`) and writes the matching workspace/member row straight to Postgres (`MIGRATION_DATABASE_URL` or `DATABASE_URL`).

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<project service_role key>"
export MIGRATION_DATABASE_URL="<Supabase pooled connection string>"

# Create the workspace and its owner. The JSON carries the new workspaceId.
pnpm --silent service:provision create my-workspace alice@example.com

# Add another member (or `viewer`, who may download operations but not upload them).
pnpm --silent service:provision join <workspaceId> bob@example.com member
```

`create` calls `auth.admin.createUser` with `email_confirm: true` and no password, so the owner sets one from the Supabase dashboard (Authentication → Users → password-reset email) before their first login. `join` calls `auth.admin.inviteUserByEmail`, which sends a real invite with a link to set a password. Each member then runs `crosscode init`, `crosscode join --workspace <workspaceId>`, `crosscode login`, and starts the daemon in their own checkout.

Remember that a self-hosted service needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` set in each member's environment, or `crosscode login` mints tokens against the compiled-in hosted project and this service rejects them for a wrong issuer. There is no separate replica-enrollment step: the daemon self-registers a replica for the authenticated member the first time it starts with a logged-in session and no replica identity of its own.

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

The daemon keeps capturing work while the service is unavailable, and pending outbound events survive restarts. When connectivity returns it retries the same immutable event IDs, records acknowledgements, downloads operations after its saved cursor, and stores what arrives as proposals without changing files.

## For coding agents

Crosscode is built to be driven by an agent with shell access and no browser. [`AGENTS.md`](./AGENTS.md) has the full contract. The short version:

**Discovery.** `crosscode commands --json` prints the entire command tree as machine-readable JSON: every command, its arguments, its options, and its description. Branch on that rather than parsing `--help`.

```bash
crosscode commands --json
```

**Output.** `--json` is a position-independent flag accepted on every command. With it, stdout is exactly one line of compact JSON: `{"value":…}` on success, `{"error":{"code":…,"message":…,"hint":…}}` on failure. Without it, the same data is pretty-printed for a human: the success value on its own, without the `value` envelope, and errors still under `error`. Nothing else is written to stdout, so it is safe to parse directly.

**Login.** Never shell out to a browser. Use the non-interactive path:

```bash
crosscode login --email "$EMAIL" --password "$PASSWORD" --json
# {"value":{"userId":"…","email":"…"}}
```

`CROSSCODE_EMAIL` / `CROSSCODE_PASSWORD` work in place of the flags. Access and refresh tokens are never printed and never appear in `--json` output. They go straight to the mode-`0600` daemon config, and there is no token environment variable to set.

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

**MCP.** The same operations are available as MCP tools with no shell at all, including the full proposal lifecycle (`inspect_proposal`, `diff_proposal`, `accept_proposal`, `reject_proposal`, `publish_branch`). See [`docs/mcp-clients.md`](./docs/mcp-clients.md) for the tool catalog and client setup.

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
<git-dir>/crosscode/keyring.json  # workspace encryption keys + this device's keypair (0600; encrypted under an OS-keychain key where available)
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

`pnpm build` bundles three entrypoints into `dist/` with esbuild: `cli.js`, `mcp.js`, and
`daemon.js`. The `@crosscode/*` workspace packages are inlined; the ten real npm
dependencies stay external and are declared on the root manifest. `scripts/build.mjs` fails
the build if anything from `node_modules` gets inlined, which is what keeps that list
accurate.

Both published bins, `crosscode` and `crosscode-mcp`, point at `dist/cli.js`, which
dispatches on the name it was invoked under. npm only auto-resolves `npx <package>` when
every `bin` entry names the same file, and `@crosscode/cli`'s unscoped name is `cli`, so two
distinct bin targets made `npx @crosscode/cli start` fail with "could not determine
executable to run". `dist/mcp.js` stays its own bundle, imported by `dist/cli.js` only when
serving MCP, so ordinary CLI invocations don't load the MCP SDK. `dist/daemon.js` is not a
bin; it is spawned from wherever it was installed. Windows `.cmd` shims lose the invoked bin
name, so `crosscode mcp` is the portable spelling of `crosscode-mcp` and is what `crosscode
start` writes into an MCP config there.

The root package is the published one. `@crosscode/cli` is not on npm yet, so the same
sequence is currently how you install the CLI at all, from a clone of this repository:

```bash
pnpm install && pnpm build
npm pack                                    # inspect contents; dist/ + README + LICENSE only
npm i -g ./crosscode-cli-*.tgz             # or --prefix <dir> to keep it out of your global bin
cd $(mktemp -d) && git init -q . && crosscode init --json && crosscode status --json
```

`apps/service` is not part of this package. It runs as functions inside the website's
deployment (`apps/docs-site/api/[...path].ts`), and self-hosters run it as a container.

Run the PostgreSQL suites through `pnpm test:postgres`, not by setting
`CROSSCODE_TEST_DATABASE_URL` for `pnpm test`. They share one database, and running them
alongside parallel test files lets unrelated suites interleave session and presence rows.
CI runs the two steps separately for the same reason.


For the implementation plan and current milestone ledger, see [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md).

## Current limitations

- **`@crosscode/cli` is not published to npm.** Every `npx @crosscode/cli` and `npm install -g @crosscode/cli` line above fails with a 404 today. Publishing is a manual release step nobody has run, not a design position. Until then, build and install from a clone (see [Packaging](#packaging)). The name is scoped because the unscoped `crosscode` belongs to an unrelated project; both binaries keep their short names, `crosscode` and `crosscode-mcp`.
- **The hosted API is down.** `https://www.getcrosscode.dev` serves the site and the sign-in page, but every `/api/v1/*` route returns 500, so `crosscode login`, `signup`, and sync against the default service all fail. A self-hosted service is unaffected.
- The hosted deployment runs the coordination service as Vercel functions, which cannot hold the `/v1/stream` WebSocket open, so live updates there degrade to polling. Container deployments and local runs get the socket.
- Billing is implemented against Stripe (`apps/service/src/stripe.ts`, BUILD_INSTRUCTIONS.md Phase 10), but no live Stripe account or price ids exist, so no real card has moved a workspace between plans. Without `CROSSCODE_STRIPE_*` configured the service has no billing surface: checkout answers `503` and the webhook route does not exist. Limits are enforced either way. Seat caps are checked inside the transaction that adds a member, the autonomy tier a plan unlocks is checked on both the read and write paths, and a lapsed payment drops a workspace to Free's limits at read time rather than waiting on a sweep. All three answer `402` rather than `403`, so a client can tell "out of seats" from "not allowed". Nothing is deleted by a downgrade, a cancellation, or a failed payment. The semantic-review call counter is not metered, because review runs on your own already-connected MCP agent and never leaves your machine, so `GET /v1/workspace/billing` correctly reports zero calls used.
- Student pricing cannot be bought self-serve. It is Pro's limits at Essential's price, and the verification flow that would stop it being a discount for anyone who asks does not exist, so `crosscode billing upgrade --plan student` is refused.
- Encryption covers file payloads, not coordination metadata. Task titles, claim targets, published intents, handoff notes, and validation output reach the service in the clear and can contain file paths. See [`docs/privacy.md`](./docs/privacy.md).
- Production PostgreSQL role grants still need environment-specific deployment hardening. Operation history is pruned to the workspace plan's `historyRetentionDays`, on a service-side schedule when `CROSSCODE_RETENTION_DATABASE_URL` names a role that may delete, and on demand via `pnpm service:prune`, which also deletes audit events and ended sessions older than `--older-than-days <n>`. A replica whose cursor falls outside the retained window is told to resynchronize explicitly. The other cursor-reconnect tables (tasks, claims, handoffs, intents, validations) are never pruned.
- Supabase refresh tokens are stored in the OS keychain when available (macOS `security`, Linux `secret-tool`); otherwise, including on Windows, the mode-`0600` Git-directory configuration fallback is used.
- Binary files are shared base64-encoded with byte-exact materialization. Any conflict involving a binary file requires human approval, since deterministic hunk/merge analysis is text-only.
- Renames are tracked as first-class rename changes (old path, new path, content). A rename conflicting with pending work on either path, moving into or out of a critical path, or whose source has diverged locally always requires approval.
- Dependency-impact analysis for `.ts`/`.tsx` is a syntactic AST walk, not a type-checker-backed analysis (see BUILD_INSTRUCTIONS.md Milestone C for exact scope).
- Workspace, membership, invite, and billing management is CLI- and API-only. There is no web UI for any of it, by decision. The website is landing, sign-up/sign-in, and docs. `CROSSCODE_DASHBOARD_URL` is still read as a deprecated fallback for setups made before the web dashboard was removed, and warns once on stderr; prefer `CROSSCODE_WEB_URL`.
- `pnpm test` skips the PostgreSQL integration suites unless `CROSSCODE_TEST_DATABASE_URL` is set, so a local run leaves the service's store, pairing, and reconnect paths unexercised. CI sets it; to run them locally use `pnpm test:postgres`.
- There is no linter or formatter configured. `pnpm build` (`tsc --noEmit`) under `strict` is the only static gate.
- There is no editor marketplace extension and there will not be one. MCP is the single integration contract.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev
setup, workspace layout, and PR expectations. Participation in this project is
governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). To report a security
vulnerability, see [SECURITY.md](./SECURITY.md) rather than opening a public
issue. Crosscode is licensed under the [MIT License](./LICENSE).
