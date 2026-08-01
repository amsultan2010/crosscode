# Contributing to Crosscode

Thanks for your interest in contributing. Crosscode is a local-first coordination
layer for developers and coding agents working in separate checkouts of the same
Git repository — see [README.md](./README.md) for what it does and
[BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) for the authoritative,
milestone-by-milestone status of what's implemented and tested.

## Before you start

- For small bug fixes, open a PR directly.
- For anything larger — new features, protocol/schema changes, or anything that
  touches the daemon/service trust boundary — open an issue first so the
  approach can be discussed before you invest time in an implementation.
- Check [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) for current scope
  decisions. In particular: the supported product surface is the daemon + MCP
  server (plus the CLI as the daemon's local tool). `apps/vscode-extension` is
  frozen and unsupported by decision — it stays in the repo, built and tested,
  but does not receive new feature work.

## Development setup

Prerequisites:

- Node.js 24 or newer
- pnpm 11
- Git
- A Supabase project, or Docker Desktop (or another Docker-compatible runtime)
  for local-only testing against a plain Postgres instance — see
  `infra/docker-compose.yml`

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

- `apps/cli` — the daemon's local admin/setup CLI (`pnpm crosscode -- <command>`)
- `apps/daemon` — the per-worktree daemon: the sole local authority for
  capture, checkpoints, and sync (`pnpm daemon`)
- `apps/mcp-server` — the standards-compliant MCP server that editors/agents
  connect to; it talks to the daemon over its authenticated loopback HTTP API
  (`pnpm mcp`)
- `apps/service` — the coordination service: Supabase-hosted PostgreSQL
  operations, auth, and audit records (`pnpm service`)
- `apps/docs-site` — the documentation site (`pnpm docs:dev` / `docs:build`)
- `apps/vscode-extension` — frozen and unsupported (see above); do not send PRs
  adding features here

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

- `pnpm build` (`tsc --noEmit` plus the extension build) and `pnpm test` pass
  locally.
- Keep PRs focused — one change per PR.
- Describe what changed and why in the PR description; use the PR template.
- If your change touches the daemon/service trust boundary (auth, RLS,
  validation, exclusions, checkpoints), call that out explicitly in the PR
  description — see [docs/security.md](./docs/security.md) for the current
  security model.
- Do not commit secrets, `.env` files, or real Supabase credentials.

## Reporting bugs and requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For security
vulnerabilities, do not open a public issue — see [SECURITY.md](./SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
