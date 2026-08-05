# Contributing to Crosscode

Thanks for your interest in contributing. Crosscode is a local-first coordination
layer for developers and coding agents working in separate checkouts of the same
Git repository. [README.md](./README.md) covers what it does, and
[BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) is the authoritative
milestone-by-milestone status of what is implemented and tested.

## Before you start

- For small bug fixes, open a PR directly.
- For anything larger, open an issue first so the approach can be discussed
  before you invest time in an implementation. That covers new features,
  protocol or schema changes, and anything touching the daemon/service trust
  boundary.
- Check [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) for current scope
  decisions. In particular: Crosscode is CLI-first. The supported product
  surface is the daemon + MCP server, plus the CLI as the daemon's local tool.
  There is no web UI for coordination work and no editor extension, and PRs
  adding either will be declined. The multi-tenant backend in `apps/service`
  (workspaces, memberships, invites, pairing codes, billing) is alive and
  maintained; it has no browser front end.

## Development setup

Prerequisites:

- Node.js 24 or newer
- pnpm 11
- Git
- A Supabase project, or Docker Desktop or another Docker-compatible runtime
  for local-only testing against a plain Postgres instance
  (`infra/docker-compose.yml`)

Install dependencies and build:

```bash
pnpm install
pnpm build
pnpm test
```

For the full coordination-service setup (Supabase project, environment
variables, migrations, workspace provisioning), see the "Set up Supabase and
run the coordination service" section of [README.md](./README.md).

## Workspace layout

This is a pnpm workspace. The apps under `apps/` are:

- `apps/cli`: the daemon's local admin/setup CLI (`pnpm crosscode -- <command>`)
- `apps/daemon`: the per-worktree daemon, the sole local authority for capture,
  checkpoints, and sync (`pnpm daemon`)
- `apps/mcp-server`: the standards-compliant MCP server that editors and agents
  connect to. It talks to the daemon over its authenticated loopback HTTP API
  (`pnpm mcp`)
- `apps/service`: the coordination service, holding Supabase-hosted PostgreSQL
  operations, auth, and audit records (`pnpm service`)
- `apps/docs-site`: the website, meaning the landing page, the auth pages
  (sign-up, sign-in, password reset, and the `crosscode login` callback), and
  the docs generated from the root `docs/*.md` (`pnpm docs:dev` / `docs:build`)

## Running tests

```bash
pnpm test          # vitest run --coverage
pnpm test:watch    # vitest, watch mode
```

Some integration tests require a real Postgres database and are skipped
otherwise:

```bash
export CROSSCODE_TEST_DATABASE_URL=postgresql://...
pnpm test:postgres
```

CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile`,
`pnpm build`, `pnpm test` (with a Postgres service container so the
Postgres-backed tests run), and `pnpm audit --audit-level high` on every push
and pull request.

## Before opening a PR

- `pnpm build` and `pnpm test` pass locally. If your change touches
  `apps/docs-site`, also run `pnpm docs:build`, which the root `tsc` does not
  cover.
- Keep PRs focused. One change per PR.
- Describe what changed and why in the PR description; use the PR template.
- If your change touches the daemon/service trust boundary (auth, RLS,
  validation, exclusions, checkpoints), call that out explicitly in the PR
  description. [docs/security.md](./docs/security.md) has the current security
  model.
- Do not commit secrets, `.env` files, or real Supabase credentials.

## Reporting bugs and requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For security
vulnerabilities, do not open a public issue. Follow [SECURITY.md](./SECURITY.md)
instead.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
