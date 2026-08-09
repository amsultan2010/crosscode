<h1 align="center">
  <a href="https://www.getcrosscode.dev"><img src="assets/LOGO-square.png" alt="crosscode" width="64" valign="middle" /></a> crosscode
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/crosscode-cli"><img src="https://img.shields.io/npm/v/crosscode-cli?style=flat&color=08C&label=npm" alt="crosscode-cli on npm" /></a>
  <a href="https://www.npmjs.com/package/crosscode-cli"><img src="https://img.shields.io/npm/dw/crosscode-cli?style=flat&color=08C&label=downloads" alt="crosscode-cli weekly downloads" /></a>
  <a href="https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml"><img src="https://github.com/amsultan2010/crosscode/actions/workflows/ci.yml/badge.svg" alt="ci" /></a>
  <a href="https://github.com/amsultan2010/crosscode"><img src="https://img.shields.io/github/stars/amsultan2010/crosscode?style=flat&label=%E2%98%85&color=08C" alt="github stars" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="license: mit" /></a>
  <img src="https://img.shields.io/badge/node-24%2B-4493F8?style=flat" alt="requires node 24 or newer" />
</p>

<p align="center">
  <strong>multiplayer agentic coding.</strong><br/>
  real-time sync for coding with others in the agentic era. you edit a file, their checkout
  updates within seconds. they edit, yours does. nobody presses anything and nobody watches
  anything.
</p>

<p align="center">
  built by <a href="https://www.amsultan.site">abdullah sultan</a>
</p>

<p align="center">
  <sub>node 24 and a git checkout. nothing to deploy.</sub>
</p>

<!-- TODO(abdullah): record a ~10s screen capture of a sync landing in a second
     checkout (edit on the left, file updating on the right), save it as
     assets/demo.gif, and replace this comment with:
     <p align="center"><img src="assets/demo.gif" alt="a file edit in one checkout appearing in another within seconds" width="720" /></p>
-->

paste [the install prompt](./docs/install-prompt.md) into the coding agent you already have
open and it does the rest. prefer to type it yourself:

```bash
npm install -g crosscode-cli
```

## works with the agent you already run

<p>
  <strong>claude code</strong> &nbsp;&middot;&nbsp;
  <strong>codex cli</strong> &nbsp;&middot;&nbsp;
  <strong>opencode</strong> &nbsp;&middot;&nbsp;
  <strong>cursor</strong>
</p>

<p>
  <kbd>gemini cli</kbd> &nbsp;
  <kbd>vs code</kbd> &nbsp;
  <kbd>amp</kbd> &nbsp;
  <kbd>cline</kbd> &nbsp;
  <kbd>zed</kbd> &nbsp;
  <kbd>windsurf</kbd> &nbsp;
  <kbd>+ any mcp client</kbd>
</p>

> [!IMPORTANT]
> [`crosscode-cli`](https://www.npmjs.com/package/crosscode-cli) installs from npm, and the
> sync engine underneath it (the shadow ref, the
> three-way merge, hot-file deferral, offline catch-up) is built and tested. the pre-edit
> hook registers the command that runs, and the daemon notices a commit or a pull on the
> branch you are already on.
>
> syncing is opt-in per checkout and covers tracked files on the branch you are sharing.
> those files are relayed by the hosted service rather than encrypted end to end, which
> [docs/privacy.md](./docs/privacy.md) spells out in full. [PLAN.md](./PLAN.md) tracks what
> is done.

## how it works

you both work in ordinary git checkouts. a small background daemon per checkout notices an
edit once it settles, sends that one file to whoever is on the same branch, and applies
theirs to your working tree the same way. commits, branches, and pushes stay pure git.
crosscode only ever touches uncommitted working-tree files, and never a file you or your
agent touched in the last few seconds.

the only interruption is the case that genuinely needs a decision: you both changed the same
lines of the same file. that goes to your own coding agent, with the three sides of the
merge, and your agent fixes it. crosscode never judges the change, classifies risk, or
reviews code. it delivers the right information at the right moment, and your agent does the
work.

there is no web app, no dashboard, and no ui. five cli commands, four mcp tools, one skill,
installed in two places so that whichever agent you run reads it.

## features

<table>
<tr>
<td width="50%" valign="top">

### silent by default

an edit that lands cleanly is written to your working tree with no prompt, no diff, and no
notification. that is roughly 95% of real use.

</td>
<td width="50%" valign="top">

### conflicts go to your agent

same-line collisions arrive as `ours` / `theirs` / `ancestor` on your own coding agent, which
merges them without being asked.

[docs →](./docs/mcp-clients.md)

</td>
</tr>
<tr>
<td width="50%" valign="top">

### pure git underneath

one ref, `refs/crosscode/shadow`, holds the last agreed state. `HEAD` never moves, and
nothing shows up in `git log`.

[docs →](./docs/architecture.md)

</td>
<td width="50%" valign="top">

### one-command undo

everything crosscode writes is reversible with
`git checkout refs/crosscode/shadow -- <path>`.

[docs →](./docs/architecture.md)

</td>
</tr>
<tr>
<td width="50%" valign="top">

### mcp native

a standard stdio mcp server, so there is no editor extension to install. claude code and
codex also get a pre-edit hook.

[docs →](./docs/mcp-clients.md) · [mcp.so →](https://mcp.so/servers/crosscode-cli-66206f)

</td>
<td width="50%" valign="top">

### secrets never move

dropped before capture, even when git tracks them: `.env*` and `.envrc`/`.npmrc`/`.netrc`/
`.pgpass`/`.htpasswd`/`.pypirc`/`.dockercfg`/`.git-credentials`; `.aws/`, `.ssh/`,
`.kube/`, `.gnupg/`; `id_rsa` and friends; `*.pem`/`*.key`/`*.p8`/`*.p12`/`*.pfx`/`*.jks`/
`*.keystore`/`*.keytab`/`*.kdbx`/`*.ovpn`/`*.gpg`/`*.asc`; anything with `credentials` or
`secrets` in a path segment, `*service-account*.json`, `kubeconfig`; `*.tfvars` and
`*.tfstate`. the patterns are anchored to path segments and extensions so ordinary source
keeps syncing, and the full list is
[`SECRET_PATH_PATTERNS`](./packages/core/src/index.ts). untracked files are never sent.

[docs →](./docs/privacy.md)

</td>
</tr>
<tr>
<td width="50%" valign="top">

### survives the network

the daemon keeps capturing offline and catches up from its cursor. history is kept about 7
days; past that a replica resyncs from full content.

[docs →](./docs/protocol.md)

</td>
<td width="50%" valign="top">

### two-line onboarding

`crosscode invite` prints a link. the join page checks the invitee actually has repo access,
then hands them a `git clone` and a `crosscode join`.

[docs →](./docs/onboarding-contracts.md)

</td>
</tr>
</table>

## quickstart

hand the setup to the agent you already have open. paste
[the install prompt](./docs/install-prompt.md) into claude code, codex cli, opencode,
cursor, or any mcp-capable agent: it installs the cli, runs `crosscode start` in the
checkout, and wires up its own mcp config. codex cli's config is toml and `start` does not
write it, so codex users add a three-line entry by hand. see
[mcp client setup](./docs/mcp-clients.md).

or run the same thing yourself:

```bash
npm install -g crosscode-cli
cd your-repo
crosscode start
```

the published package is [`crosscode-cli`](https://www.npmjs.com/package/crosscode-cli),
which ships both binaries: `crosscode` (the cli) and `crosscode-mcp` (the mcp server and
pre-edit hook).

`crosscode start` does the whole setup and is safe to re-run: it signs you in with github,
attaches this checkout to a project, starts the background daemon, and installs the mcp
server, the `crosscode` skill, the matching block in `AGENTS.md` for agents that read that
instead of a skill, and the pre-edit hooks for your coding agent. restart your agent
afterwards so it picks up the new mcp server.

sign-in prints a url and a short confirmation code and waits. you open the url, sign in
with github, and enter the code; there is no callback server listening on your machine and
nothing to paste back into the terminal. on a remote shell, `--no-browser` prints the url
instead of opening one.

to bring a teammate in:

```bash
crosscode invite          # prints https://www.getcrosscode.dev/join/7f3a9c2e
```

they open the link, sign in with github, and the page gives them two lines to paste:

```bash
git clone git@github.com:acme/app.git && cd app
crosscode join CC-7F3A-9C2E
```

that is the entire onboarding budget. from there, both checkouts are in sync.

the other two commands, and that is all of them:

```bash
crosscode status     # branch, connected, paused, who else is on this branch
crosscode stop       # stop syncing this checkout
```

## mcp server configuration

`crosscode start` writes this for you. to add it by hand, put it in `.mcp.json` at the
checkout root (claude code), `.cursor/mcp.json` (cursor), or `.gemini/settings.json`
(gemini cli):

```json
{
  "mcpServers": {
    "crosscode": {
      "command": "crosscode-mcp",
      "args": []
    }
  }
}
```

the server speaks mcp over stdio and discovers the checkout from its working directory, so
launch it with `cwd` set to the checkout root. codex cli's config is toml, and opencode
uses its own shape; both are in [mcp clients and hooks](./docs/mcp-clients.md).

## tools

four, and there will not be a fifth.

| tool | what it does |
| --- | --- |
| `status` | sync status for this checkout: branch, connected, paused, and who else is working on what. read-only. |
| `conflicts` | list unresolved sync conflicts. each carries ours/theirs/ancestor text for a 3-way merge. |
| `resolve` | resolve one conflict with your merged file content, written to disk and republished to the team. |
| `pause` | pause or resume syncing for this checkout, for a rebase, bisect, or bulk rewrite. |

every response from every tool also carries any pending conflicts, whether it was asked for
them or not. the full catalog, with input schemas, is in
[mcp clients and hooks](./docs/mcp-clients.md).

## what syncs, and what never does

only the files you sync ever leave the room: tracked files you edit on the branch you are
sharing, minus a hard denylist. untracked files stay put, and your commits, branches, index,
stash, and remotes are never touched, so nothing crosscode does pushes to a remote. if you
stop crosscode or remove it, your repository is an ordinary git repository, exactly as it
was.

those files are relayed by the hosted coordination service rather than encrypted end to end,
so someone with production access could read them. [docs/privacy.md](./docs/privacy.md)
lists exactly what the service stores and for how long, and
[docs/security.md](./docs/security.md) has the threat model.

## the apply rule

one git ref does most of the work. `refs/crosscode/shadow` points at a commit whose tree is
the last state both sides agreed on. from that one ref come the merge base, "have i edited
this since we synced?", undo, and content storage in git's own object store.

the sync unit is one file: `{ path, op, baseHash, contentHash, content-or-patch }`. no
bundles, no lifecycle, no accept or reject. for an incoming change to path `P`, where `L` is
your disk and `S` is the shadow:

1. `L == S` **and the sender built from `S`**: write it, silently.
2. otherwise, 3-way merge against the sender's base. clean means write it silently. a
   conflict is surfaced to your agent.
3. only if that base blob is genuinely missing, catch up from the cursor and retry.

binaries are never merged, so concurrent binary edits are always a conflict. a conflicted
path is quarantined, neither published nor applied, until it is resolved.

rules that keep it invisible:

- never write a file you or your agent touched in the last ~10 seconds.
- never sync during a rebase, merge, or bisect. pause, then resync.
- same branch only. different branches means you did not want to sync.
- everything is undoable with one command.

more in [architecture](./docs/architecture.md) and [protocol](./docs/protocol.md).

## pricing

the hosted service is free. there are no paid plans, no seats, and no payment details
collected. see [docs/terms.md](./docs/terms.md).

## what your agent sees

four mcp tools, `status`, `conflicts`, `resolve`, and `pause`, plus one skill that says how
to use them and, mostly, when to leave them alone. claude code reads that skill from
`.claude/skills/crosscode/`; codex cli, cursor, opencode, and gemini cli read the same text
from the crosscode block `start` writes into `AGENTS.md`.

every response from every tool carries any pending conflicts, whether the tool was asked for
them or not. that is deliberate. an agent only looks at anything when it is invoked, so a
conflict that arrives while it is idle would otherwise sit unseen. this way it trips over
one the next time it does anything at all. claude code and codex additionally get a hook
that runs before a file edit, which moves that moment earlier still: a conflict on a file
is known before the agent writes over it rather than after. the hook is a bonus on top of
mcp, not a requirement, and every other client relies on the piggybacked conflicts alone.

the bar this is built to: **neither side's agent mentions crosscode until a real conflict**,
which the receiving agent then resolves without being asked. see
[`skills/crosscode/SKILL.md`](./skills/crosscode/SKILL.md) for what the agent is told. that
file is the only copy there is: `start` installs it verbatim as the skill and, with the
frontmatter stripped, as the `AGENTS.md` block, and a test fails if the three drift apart.

## what crosscode is not

no accept-or-reject step on incoming work, no tasks, claims, or handoffs, no hidden snapshot
layer, no validation profiles, no risk classification, no ai reviewer, no seats, no web app,
no tui. we built all of that once, which is how we learned to stop.

## developing

```bash
pnpm install
pnpm build          # typecheck + bundle
pnpm test           # vitest
```

layout: `packages/protocol` (the wire contract), `packages/sync` (the apply rule, shadow
ref, and 3-way merge), `packages/git` (the git plumbing it runs on), `packages/core` (the
denylist and hashing), `apps/daemon` (per-checkout sync), `apps/service` (the hosted
coordination service), `apps/cli` (five commands), `apps/mcp-server` (four tools and the
pre-edit hook), `skills/crosscode` (the agent skill), `apps/docs-site` (landing page and
these docs).

want to contribute? see [CONTRIBUTING.md](./CONTRIBUTING.md). `PLAN.md` is the only plan
document in this repository, and `spike/` holds a throwaway proof of the merge core outside
the build.

docs: [architecture](./docs/architecture.md) · [protocol](./docs/protocol.md) ·
[mcp clients and hooks](./docs/mcp-clients.md) ·
[onboarding contracts](./docs/onboarding-contracts.md) ·
[install prompt](./docs/install-prompt.md) · [security](./docs/security.md) ·
[privacy](./docs/privacy.md) · [observability](./docs/observability.md) ·
[terms](./docs/terms.md) · [support](./docs/support.md)

## community and support

- **issues:** missing something, or hit a bug?
  [open an issue](https://github.com/amsultan2010/crosscode/issues).
- **security:** report vulnerabilities privately per [SECURITY.md](./SECURITY.md), never in a
  public issue.
- **privacy:** [docs/privacy.md](./docs/privacy.md) lists everything the service can see.
- **show support:** [star this repo](https://github.com/amsultan2010/crosscode) to follow
  along.

## license

crosscode is free and open source under the [mit license](./LICENSE).

## trademark

the mit license covers the code. it does not cover the name "crosscode" or the logos in
[`assets/`](./assets). fork it, ship it, write about it. just don't present a modified
version as crosscode itself. [TRADEMARK.md](./TRADEMARK.md) has the details, and
`legal@getcrosscode.dev` handles anything it doesn't cover.
