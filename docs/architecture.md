# Crosscode architecture

```text
your checkout                          teammate's checkout
  file edit                              file edit
     |                                       |
  daemon (per checkout)                  daemon
     |  publish one file                     |
     +------> coordination service <---------+
              (Postgres + websocket)
     |                                       |
  apply / merge / conflict               apply / merge / conflict
     |
  your coding agent  <-- MCP tools + pre-edit hook, only on a conflict
```

Four moving parts, and the smallest one is the point.

## Daemon (`apps/daemon`)

One daemon per checkout, started by `crosscode start`, restarted automatically if it
crashes. It watches tracked files (with a hard denylist for `.env*`, `*.pem`, `*.key`, and
similar), debounces about 300ms per file so an edit is sent once it settles, diffs against
the shadow ref, and publishes one file at a time. In the other direction it receives
changes and applies them.

It binds only to loopback and writes a mode-`0600` connection descriptor under the
checkout's Git directory; the CLI and the MCP server connect to that.

**The shadow ref.** `refs/crosscode/shadow` points at a commit whose tree is the last state
both sides agreed on. That single ref gives the merge base, the answer to "have I edited
this since we synced?", undo (`git checkout refs/crosscode/shadow -- <path>`), and content
storage in Git's own object store. It never moves `HEAD` and never shows up in `git log`.
The sender advances its shadow when it publishes, which is what stops a change being
rebroadcast forever.

**Apply rule** for an incoming change to path `P`, with `L` = local disk and `S` = shadow:

1. `L == S` **and the sender built from `S`** → write it, silently.
2. Otherwise → 3-way merge against the sender's base, resolved by content hash out of Git's
   object store. Clean → write silently. Conflict → surface it.
3. Only if that base blob is genuinely missing → catch up from the cursor, then retry.

All four clauses are load-bearing; the earlier draft of this rule lost data on concurrent
edits, which is why `spike/` exists. Binary files are never merged, so concurrent binary
edits are always a conflict. A conflicted path is quarantined, neither published nor
applied, until it is resolved.

**Deferral and pausing.** A file the user or their agent touched in the last ~10 seconds is
never written to; the write is deferred. Syncing pauses entirely during a rebase, merge, or
bisect, and resyncs afterwards.

**When `HEAD` moves.** Switching branch is a different room: the daemon resets the shadow to
the new `HEAD`, drops what was in flight, and rejoins. A commit or a pull on the *same*
branch is subtler — the branch is unchanged and no git operation is in progress, but the
tree the shadow points at is no longer what both sides agreed on. The daemon has to notice
and rebase the shadow onto the new `HEAD` without discarding uncommitted work that is
genuinely local, and without republishing everything each time somebody commits.

What it deliberately does **not** do is touch your working tree to make `git pull` succeed.
If a teammate commits and pushes changes you are still holding uncommitted, git refuses the
pull — "your local changes would be overwritten" — even though the content is identical.
Crosscode could clear that by checking files out for you, and checking files out on your
behalf around a commit is exactly the magic invariant 1 exists to forbid. Instead it tells
your agent a pull is waiting, and your agent, which is allowed to run git, clears the way.

## Coordination service (`apps/service`)

A store-and-forward relay on Supabase-hosted Postgres. Six tables carry the product:
`users`, `projects`, `project_members`, `invites`, `replicas`, `file_versions`. Sign-in
adds a seventh, `device_codes`, holding short-lived pending sign-ins. Presence is in-memory
in the websocket gateway, not a table.

Routes: `POST /v1/projects`, `POST /v1/invites`, `POST /v1/invites/:code/redeem`,
`POST /v1/replicas`, `GET /v1/changes?since=`, `POST /v1/changes`, and the websocket at
`/v1/stream`. Sign-in adds `POST /v1/auth/github/device` and `/device/token` — the only
routes exempt from the bearer check, because their whole job is to hand out a session to a
caller who has none. Redeeming an invite verifies the invitee actually has access to the
repo. Row Level Security is on from the first migration.

The service assigns sequence numbers and fans changes out. It does not merge, classify, or
inspect anything. Changes are retained about 7 days; a replica whose cursor is older than
that is told to resync from full content rather than handed a partial history.

A room is one project plus one branch name. Different branches do not sync, because
different branches mean you did not want to.

## Clients (`apps/cli`, `apps/mcp-server`)

Neither holds sync state. Both talk to the local daemon's loopback HTTP API.

The CLI is five commands: `start`, `invite`, `join`, `status`, `stop`.

The MCP server is four tools (`status`, `conflicts`, `resolve`, `pause`) and one pre-edit
hook, reached as `crosscode-mcp hook`. Every tool response carries any pending conflicts, so
an agent finds out about one on its next call regardless of what that call was for; the hook
only moves that moment earlier, to before a write rather than after. See
[mcp-clients.md](./mcp-clients.md).

## Where a conflict goes

Nowhere near a Crosscode UI, because there isn't one. A conflict is handed to the user's own
coding agent as `ours` / `theirs` / `ancestor`, and the agent merges it and calls `resolve`.
The [`crosscode` skill](../skills/crosscode/SKILL.md) is what teaches it to do that quietly.

## Invariants

1. Uncommitted working-tree files are the entire scope. Commits, branches, the index, and
   remotes are never touched, and nothing here pushes.
2. Never write a file the user or their agent touched in the last ~10 seconds.
3. Tracked files only, minus the secret denylist.
4. Same project and same branch, or no sync at all.
5. Everything is undoable with one command.
6. Stop Crosscode and the repository is an ordinary Git repository.

See [protocol.md](./protocol.md) for the wire shapes and [PLAN.md](../PLAN.md) for what is
built so far.
