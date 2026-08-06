<h1 align="center">
  <a href="https://getcrosscode.dev"><img src="assets/LOGO-square.png" alt="Crosscode" width="64" valign="middle" /></a> Crosscode
</h1>

<p align="center">
  <a href="https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml"><img src="https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/amsultan2010/crosscode"><img src="https://img.shields.io/github/stars/amsultan2010/crosscode?style=flat&label=%E2%98%85&color=08C" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/node-24%2B-4493F8?style=flat" alt="Requires Node 24 or newer" />
  <img src="https://img.shields.io/badge/status-pre--1.0-B45309?style=flat" alt="Status: pre-1.0" />
</p>

<p align="center">
  <strong>Real-time codebase sync between teammates.</strong><br/>
  You edit a file, their checkout updates within seconds. They edit, yours does.
  Nobody presses anything and nobody watches anything.
</p>

<p align="center">
  <sub>Node 24 and a Git checkout. Nothing to deploy.</sub>
</p>

> [!IMPORTANT]
> **Pre-1.0, and specific about it.** `crosscode-cli` installs from npm, and the sync
> engine underneath it — the shadow ref, the three-way merge, hot-file deferral, offline
> catch-up — is built and tested. The pre-edit hook now registers the command that actually
> runs, and the daemon now notices a commit or a pull on the branch you are already on.
>
> One thing between you and a working `crosscode start` is not finished. The device
> handshake itself is live: `start` gets a URL and a confirmation code from the service, and
> polls for the session. But the GitHub OAuth application behind our Supabase project is
> misconfigured, so the browser half of the sign-in ends on a GitHub 404. Until that is
> corrected, `start`, `invite`, and `join` all stop at sign-in, because all three need a
> session first.
>
> Nobody has yet completed the quickstart on a clean machine, so treat it as the intended
> path rather than a measured one. There is also no end-to-end encryption: the coordination
> service can read the files you sync, which [docs/privacy.md](./docs/privacy.md) spells out
> in full. [PLAN.md](./PLAN.md) is the single source of truth for what is done.

## How it works

You both work in ordinary Git checkouts. A small background daemon per checkout notices an
edit once it settles, sends that one file to whoever is on the same branch, and applies
theirs to your working tree the same way. Commits, branches, and pushes stay pure Git.
Crosscode only ever touches uncommitted working-tree files, and never a file you or your
agent touched in the last few seconds.

The only interruption is the case that genuinely needs a decision: you both changed the same
lines of the same file. That goes to your own coding agent, with the three sides of the
merge, and your agent fixes it. Crosscode never judges the change, classifies risk, or
reviews code. It delivers the right information at the right moment, and your agent does the
work.

There is no web app, no dashboard, and no UI. Five CLI commands, four MCP tools, one skill.

## Features

<table>
<tr>
<td width="50%" valign="top">

### Silent by default

An edit that lands cleanly is written to your working tree with no prompt, no diff, and no
notification. That is roughly 95% of real use.

</td>
<td width="50%" valign="top">

### Conflicts go to your agent

Same-line collisions arrive as `ours` / `theirs` / `ancestor` on your own coding agent, which
merges them without being asked.

[Docs →](./docs/mcp-clients.md)

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Pure Git underneath

One ref, `refs/crosscode/shadow`, holds the last agreed state. `HEAD` never moves, and
nothing shows up in `git log`.

[Docs →](./docs/architecture.md)

</td>
<td width="50%" valign="top">

### One-command undo

Everything Crosscode writes is reversible with
`git checkout refs/crosscode/shadow -- <path>`.

[Docs →](./docs/architecture.md)

</td>
</tr>
<tr>
<td width="50%" valign="top">

### MCP native

A standard stdio MCP server, so there is no editor extension to install. Claude Code and
Codex also get a pre-edit hook.

[Docs →](./docs/mcp-clients.md)

</td>
<td width="50%" valign="top">

### Secrets never move

`.env*`, `*.pem`, `*.key`, and anything credential-shaped are dropped before capture, even
when Git tracks them. Untracked files are never sent.

[Docs →](./docs/privacy.md)

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Survives the network

The daemon keeps capturing offline and catches up from its cursor. History is kept about 7
days; past that a replica resyncs from full content.

[Docs →](./docs/protocol.md)

</td>
<td width="50%" valign="top">

### Two-line onboarding

`crosscode invite` prints a link. The join page checks the invitee actually has repo access,
then hands them a `git clone` and a `crosscode join`.

[Docs →](./docs/onboarding-contracts.md)

</td>
</tr>
</table>

## Quickstart

```bash
npm install -g crosscode-cli
cd your-repo
crosscode start
```

`crosscode start` does the whole setup and is safe to re-run: it signs you in with GitHub,
attaches this checkout to a project, starts the background daemon, and installs the MCP
server, the `crosscode` skill, and the pre-edit hooks for your coding agent. Restart your
agent afterwards so it picks up the new MCP server.

Sign-in prints a URL and a short confirmation code and waits. You open the URL, sign in
with GitHub, and enter the code; there is no callback server listening on your machine and
nothing to paste back into the terminal. On a remote shell, `--no-browser` prints the URL
instead of opening one.

To bring a teammate in:

```bash
crosscode invite          # prints https://getcrosscode.dev/join/7f3a9c2e
```

They open the link, sign in with GitHub, and the page gives them two lines to paste:

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

You can also hand the whole setup to your coding agent. Paste
[the install prompt](./docs/install-prompt.md) into Claude Code, Codex CLI, OpenCode,
Cursor, or any MCP-capable agent, and it runs the same commands and wires up the MCP config
itself. Codex CLI's config is TOML and `start` does not write it, so Codex users add a
three-line entry by hand. See [MCP client setup](./docs/mcp-clients.md).

## Works with the agent you already run

<p>
  <kbd>Claude Code</kbd> &nbsp;
  <kbd>Codex CLI</kbd> &nbsp;
  <kbd>OpenCode</kbd> &nbsp;
  <kbd>Cursor</kbd> &nbsp;
  <kbd>Gemini CLI</kbd> &nbsp;
  <kbd>VS Code</kbd> &nbsp;
  <kbd>Amp</kbd> &nbsp;
  <kbd>Cline</kbd> &nbsp;
  <kbd>Zed</kbd> &nbsp;
  <kbd>Windsurf</kbd> &nbsp;
  <kbd>+ any MCP client</kbd>
</p>

## What your agent sees

Four MCP tools, `status`, `conflicts`, `resolve`, and `pause`, plus one skill that says how
to use them and, mostly, when to leave them alone.

Every response from every tool carries any pending conflicts, whether the tool was asked for
them or not. That is deliberate. An agent only looks at anything when it is invoked, so a
conflict that arrives while it is idle would otherwise sit unseen. This way it trips over
one the next time it does anything at all. Claude Code and Codex additionally get a hook
that runs before a file edit, which moves that moment earlier still — a conflict on a file
is known before the agent writes over it rather than after. The hook is a bonus on top of
MCP, not a requirement — every other client relies on the piggybacked conflicts alone.

The bar this is built to: **neither side's agent mentions Crosscode until a real conflict**,
which the receiving agent then resolves without being asked. See
[`skills/crosscode/SKILL.md`](./skills/crosscode/SKILL.md) for what the agent is told.

## The apply rule

One Git ref does most of the work. `refs/crosscode/shadow` points at a commit whose tree is
the last state both sides agreed on. From that one ref come the merge base, "have I edited
this since we synced?", undo, and content storage in Git's own object store.

The sync unit is one file: `{ path, op, baseHash, contentHash, content-or-patch }`. No
bundles, no lifecycle, no accept or reject. For an incoming change to path `P`, where `L` is
your disk and `S` is the shadow:

1. `L == S` **and the sender built from `S`** → write it, silently.
2. Otherwise → 3-way merge against the sender's base. Clean → write it silently. Conflict →
   surface it to your agent.
3. Only if that base blob is genuinely missing → catch up from the cursor and retry.

Binaries are never merged, so concurrent binary edits are always a conflict. A conflicted
path is quarantined, neither published nor applied, until it is resolved.

Rules that keep it invisible:

- Never write a file you or your agent touched in the last ~10 seconds.
- Never sync during a rebase, merge, or bisect. Pause, then resync.
- Same branch only. Different branches means you did not want to sync.
- Everything is undoable with one command.

More in [architecture](./docs/architecture.md) and [protocol](./docs/protocol.md).

## What syncs, and what never does

Tracked files only, plus a hard denylist. Your commits, branches, index, stash, and remotes
are never touched, and nothing Crosscode does pushes to a remote. If you stop Crosscode or
remove it, your repository is an ordinary Git repository, exactly as it was.

Your files do pass through the hosted coordination service, and there is no end-to-end
encryption, so we can read them. [docs/privacy.md](./docs/privacy.md) lists exactly what the
service stores and for how long, and [docs/security.md](./docs/security.md) has the threat
model.

## Pricing

The hosted service is free. There are no paid plans, no seats, and no payment details
collected. See [docs/terms.md](./docs/terms.md).

## What Crosscode is not

No accept-or-reject step on incoming work, no tasks, claims, or handoffs, no hidden snapshot
layer, no validation profiles, no risk classification, no AI reviewer, no seats, no web app,
no TUI. We built all of that once, which is how we learned to stop.

## Developing

```bash
pnpm install
pnpm build          # typecheck + bundle
pnpm test           # vitest
```

Layout: `packages/protocol` (the wire contract), `packages/core` and `packages/git` (the
merge core), `apps/daemon` (per-checkout sync), `apps/service` (the hosted coordination
service), `apps/cli`, `apps/mcp-server` (four tools and the pre-edit hook),
`skills/crosscode` (the agent skill), `apps/docs-site` (landing page and these docs).

Want to contribute? See [CONTRIBUTING.md](./CONTRIBUTING.md). `PLAN.md` is the only plan
document in this repository, and `spike/` holds a throwaway proof of the merge core outside
the build.

Docs: [architecture](./docs/architecture.md) · [protocol](./docs/protocol.md) ·
[MCP clients and hooks](./docs/mcp-clients.md) ·
[onboarding contracts](./docs/onboarding-contracts.md) ·
[install prompt](./docs/install-prompt.md) · [security](./docs/security.md) ·
[privacy](./docs/privacy.md) · [observability](./docs/observability.md) ·
[terms](./docs/terms.md) · [support](./docs/support.md)

## Community and support

- **Issues:** missing something, or hit a bug?
  [Open an issue](https://github.com/amsultan2010/crosscode/issues).
- **Security:** report vulnerabilities privately per [SECURITY.md](./SECURITY.md), never in a
  public issue.
- **Privacy:** [docs/privacy.md](./docs/privacy.md) lists everything the service can see.
- **Show support:** [star this repo](https://github.com/amsultan2010/crosscode) to follow
  along.

## License

Crosscode is free and open source under the [MIT License](./LICENSE).
