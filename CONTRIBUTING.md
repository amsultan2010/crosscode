# Contributing to Crosscode

Thanks for your interest in contributing. Crosscode is real-time codebase sync
between teammates: you edit a file, their checkout updates within seconds, and
the only interruption is a same-line conflict, which goes to their own coding
agent. [README.md](./README.md) covers what it does, and [PLAN.md](./PLAN.md) is
the single source of truth for what is built so far.

## Before you start

- For small bug fixes, open a PR directly.
- For anything larger, open an issue first so the approach can be discussed
  before you invest time in an implementation. That covers new features,
  protocol or schema changes, and anything touching the daemon/service trust
  boundary.
- Scope decisions to know about, all of them settled in [PLAN.md](./PLAN.md).
  Crosscode is CLI-first: the supported surface is the daemon and the MCP server,
  plus the CLI as the daemon's local tool. There is no web app, no TUI, and no
  editor extension, so PRs adding one will be declined. The hard limits are five
  CLI commands, four MCP tools, and one skill; a PR that adds a sixth command or
  a fifth tool needs to argue for it first. Crosscode surfaces conflicts and
  never resolves them itself, so changes that make Crosscode judge, classify, or
  review a change are out of scope.

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

## Workspace layout

This is a pnpm workspace. The packages under `packages/` hold the wire contract
(`protocol`) and the merge core (`core`, `git`). The apps under `apps/` are:

- `apps/cli`: the daemon's local admin/setup CLI (`pnpm crosscode -- <command>`)
- `apps/daemon`: the per-checkout daemon, the sole local authority for capture,
  the shadow ref, and sync (`pnpm daemon`)
- `apps/mcp-server`: the standards-compliant MCP server that editors and agents
  connect to. It talks to the daemon over its authenticated loopback HTTP API
  (`pnpm mcp`)
- `apps/service`: the coordination service, holding Supabase-hosted PostgreSQL
  operations, auth, and audit records (`pnpm service`)
- `apps/docs-site`: the website, meaning the landing page, the join page, the
  auth pages, and the docs generated from the root `docs/*.md`
  (`pnpm docs:dev` / `docs:build`). The auth pages still implement the removed
  email/password `crosscode login` flow and do not match the CLI's GitHub
  device-code sign-in; they need a decision rather than a copy edit

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
- If your change touches the daemon/service trust boundary (auth, RLS, the
  shadow ref, the apply rule, or the secret denylist), call that out explicitly
  in the PR description. [docs/security.md](./docs/security.md) has the current
  security model.
- Do not commit secrets, `.env` files, or real Supabase credentials.

## Licensing your contribution

Crosscode is [MIT licensed](./LICENSE), and everything you contribute is
licensed under the MIT License too. You keep the copyright in your work; you are
licensing it, not assigning it. There is no CLA to sign.

To make that explicit on every commit, this project uses the [Developer
Certificate of Origin](https://developercertificate.org/) (DCO). The DCO is a
short statement that you wrote the change, or that you have the right to submit
it under the same licence. Certify it by signing off your commits:

```bash
git commit -s -m "Your message"
```

That appends a line to the commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and an email you can be reached at; the name and email must
match the commit's author. Forgot the sign-off? Fix the last commit with
`git commit -s --amend`, or a whole branch with
`git rebase --signoff origin/main`, then force-push.

CI (`.github/workflows/dco.yml`) checks every non-merge commit in a pull request
for a matching sign-off and fails the PR if one is missing. That check is the
whole enforcement mechanism — there is no bot to comment and no other gate.

The name and logo are not covered by the MIT License. See
[TRADEMARK.md](./TRADEMARK.md) for what you can do with them.

## Reporting bugs and requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For security
vulnerabilities, do not open a public issue. Follow [SECURITY.md](./SECURITY.md)
instead.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
