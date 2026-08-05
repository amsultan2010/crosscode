# Crosscode

[![CI](https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml/badge.svg)](https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Real-time codebase sync between teammates.** You edit a file, their checkout updates
within seconds. They edit, yours does. Nobody presses anything and nobody watches anything.

You both work in ordinary Git checkouts. A small background daemon per checkout notices an
edit once it settles, sends that one file to whoever is on the same branch, and applies
theirs to your working tree the same way. Commits, branches, and pushes stay pure Git —
Crosscode only ever touches uncommitted working-tree files, and never a file you or your
agent touched in the last few seconds.

The only interruption is the case that genuinely needs a decision: **you both changed the
same lines of the same file.** That goes to your own coding agent, with the three sides of
the merge, and your agent fixes it. Crosscode never judges the change, classifies risk, or
reviews code. It delivers the right information at the right moment; your agent does the
work.

**There is no web app, no dashboard, and no UI.** Five CLI commands, four MCP tools, one
skill.

> **Status.** The wire contract (`packages/protocol/src/sync.ts`), the merge core, and the
> agent surface in this README are built. The coordination service, the daemon, and the CLI
> are being rebuilt against that contract right now, and until they land the quickstart
> below describes the product rather than something you can install. `PLAN.md` is the
> single source of truth for what is done.

## Quickstart

Node 24 and a Git checkout are the only requirements.

```bash
npm install -g @crosscode/cli
cd your-repo
crosscode start
```

`crosscode start` does the whole setup and is safe to re-run: it signs you in with GitHub,
attaches this checkout to a project, starts the background daemon, and installs the MCP
server, the `crosscode` skill, and the pre-edit hooks for your coding agent. Restart your
agent afterwards so it picks up the new MCP server.

To bring a teammate in:

```bash
crosscode invite          # prints https://getcrosscode.dev/join/7f3a9c2e
```

They open the link, sign in with GitHub (the page checks they actually have access to the
repo), and the page gives them two lines to paste:

```bash
git clone git@github.com:acme/app.git && cd app
crosscode join CC-7F3A-9C2E
```

That is the entire onboarding budget. From there, both checkouts are in sync.

The other two commands, and that is all of them:

```bash
crosscode status     # branch, connected, paused, who else is on this branch
crosscode stop       # stop syncing this checkout
```

## What your agent sees

Your coding agent gets four MCP tools — `status`, `conflicts`, `resolve`, `pause` — and one
skill that tells it how to use them and, mostly, when to leave them alone.

Every response from every tool carries any pending conflicts, whether the tool was asked
for them or not. That is deliberate: an agent only looks at anything when it is invoked, so
a conflict that arrives while it is idle would otherwise sit unseen. This way it trips over
one the next time it does anything at all. Claude Code and Codex additionally get a hook
that runs before a file edit, so a conflict on a file is known before the agent writes over
it.

The bar this is built to: **neither side's agent mentions Crosscode until a real conflict**,
which the receiving agent then resolves without being asked.

See [`docs/mcp-clients.md`](./docs/mcp-clients.md) for configuration and
[`skills/crosscode/SKILL.md`](./skills/crosscode/SKILL.md) for what the agent is told.

## How it works

One Git ref does most of the work. `refs/crosscode/shadow` points at a commit whose tree is
the last state both sides agreed on. From that one ref come the merge base, "have I edited
this since we synced?", undo (`git checkout refs/crosscode/shadow -- <path>`), and content
storage in Git's own object store. It never moves `HEAD` and never appears in `git log`.

The sync unit is one file: `{ path, op, baseHash, contentHash, content-or-patch }`. No
bundles, no lifecycle, no accept/reject. For an incoming change to path `P`, where `L` is
your disk and `S` is the shadow:

1. `L == S` **and the sender built from `S`** → write it, silently.
2. Otherwise → 3-way merge against the sender's base. Clean → write it silently; conflict →
   surface it to your agent.
3. Only if that base blob is genuinely missing → catch up from the cursor and retry.

Binaries are never merged: concurrent binary edits are always a conflict. A conflicted path
is quarantined — neither published nor applied — until it is resolved.

Rules that keep it invisible:

- Never write a file you or your agent touched in the last ~10 seconds.
- Never sync during a rebase, merge, or bisect. Pause, then resync.
- Same branch only. Different branches means you did not want to sync.
- Everything is undoable with one command.

More in [`docs/architecture.md`](./docs/architecture.md) and
[`docs/protocol.md`](./docs/protocol.md).

## What syncs, and what never does

Tracked files only, plus a hard denylist: `.env*`, `*.pem`, `*.key`, and anything that
looks like credentials, are never sent even if they are tracked. Untracked files are never
sent. Your commits, branches, index, stash, and remotes are never touched, and nothing
Crosscode does pushes to a remote.

If you stop Crosscode or remove it, your repository is an ordinary Git repository, exactly
as it was.

## What Crosscode is not

No accept-or-reject step on incoming work, no tasks, claims, or handoffs, no hidden
snapshot layer, no validation profiles, no risk classification, no AI reviewer, no seats, no
web app, no TUI. We built all of that once, which is how we learned to stop.

## Working on Crosscode

```bash
pnpm install
pnpm build          # typecheck + bundle
pnpm test           # vitest
```

Layout: `packages/protocol` (the wire contract), `packages/core` and `packages/git` (the
merge core), `apps/daemon` (per-checkout sync), `apps/service` (the hosted coordination
service), `apps/cli`, `apps/mcp-server` (four tools and the pre-edit hook),
`skills/crosscode` (the agent skill), `apps/docs-site` (landing page and these docs).

`PLAN.md` is the only plan document in this repository. `spike/` holds the throwaway proof
of the merge core and is outside the build.

Docs: [architecture](./docs/architecture.md) · [protocol](./docs/protocol.md) ·
[MCP clients and hooks](./docs/mcp-clients.md) ·
[onboarding contracts](./docs/onboarding-contracts.md) ·
[install prompt](./docs/install-prompt.md) · [security](./docs/security.md) ·
[privacy](./docs/privacy.md) · [support](./docs/support.md)

MIT licensed. Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md). Vulnerabilities:
[SECURITY.md](./SECURITY.md), never a public issue.
