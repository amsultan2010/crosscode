# crosscode architecture

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

four moving parts, and the smallest one is the point.

## daemon (`apps/daemon`)

one daemon per checkout, started by `crosscode start`, restarted automatically if it
crashes. it watches tracked files (with a hard denylist for `.env*`, `*.pem`, `*.key`, and
similar), debounces about 300ms per file so an edit is sent once it settles, diffs against
the shadow ref, and publishes one file at a time. in the other direction it receives
changes and applies them.

it binds only to loopback and writes a mode-`0600` connection descriptor under the
checkout's git directory; the cli and the mcp server connect to that.

**the shadow ref.** `refs/crosscode/shadow` points at a commit whose tree is the last state
both sides agreed on. that single ref gives the merge base, the answer to "have i edited
this since we synced?", undo (`git checkout refs/crosscode/shadow -- <path>`), and content
storage in git's own object store. it never moves `HEAD` and never shows up in `git log`.
the sender advances its shadow when it publishes, which is what stops a change being
rebroadcast forever.

**apply rule** for an incoming change to path `P`, with `L` = local disk and `S` = shadow:

1. `L == S` **and the sender built from `S`** → write it, silently.
2. otherwise → 3-way merge against the sender's base, resolved by content hash out of git's
   object store. clean → write silently. conflict → surface it.
3. only if that base blob is genuinely missing → catch up from the cursor, then retry.

all four clauses are load-bearing; the earlier draft of this rule lost data on concurrent
edits, which is why `spike/` exists. binary files are never merged, so concurrent binary
edits are always a conflict. a conflicted path is quarantined, neither published nor
applied, until it is resolved.

**deferral and pausing.** a file the user or their agent touched in the last ~10 seconds is
never written to; the write is deferred. syncing pauses entirely during a rebase, merge, or
bisect, and resyncs afterwards.

**when `HEAD` moves.** switching branch is a different room: the daemon resets the shadow to
the new `HEAD`, drops what was in flight, and rejoins. a commit or a pull on the *same*
branch is subtler: the branch is unchanged and no git operation is in progress, but the
tree the shadow points at is no longer what both sides agreed on. the daemon has to notice
and rebase the shadow onto the new `HEAD` without discarding uncommitted work that is
genuinely local, and without republishing everything each time somebody commits.

what it deliberately does **not** do is touch your working tree to make `git pull` succeed.
if a teammate commits and pushes changes you are still holding uncommitted, git refuses the
pull ("your local changes would be overwritten") even though the content is identical.
crosscode could clear that by checking files out for you, and checking files out on your
behalf around a commit is exactly the magic invariant 1 exists to forbid. instead it tells
your agent a pull is waiting, and your agent, which is allowed to run git, clears the way.

## coordination service (`apps/service`)

a store-and-forward relay on supabase-hosted postgres. six tables carry the product:
`users`, `projects`, `project_members`, `invites`, `replicas`, `file_versions`. two more
support it: `device_codes` holds short-lived pending sign-ins, and `terms_acceptances`
records which version of the terms and privacy notice each account has accepted. presence
is in-memory in the websocket gateway, not a table.

routes: `POST /v1/projects`, `POST /v1/invites`, `POST /v1/invites/:code/redeem`,
`POST /v1/replicas`, `GET /v1/changes?since=`, `POST /v1/changes`, and the websocket at
`/v1/stream`. sign-in adds `POST /v1/auth/github/device`, `/device/token` and
`/device/bind`; terms acceptance adds `GET /v1/legal`, `POST /v1/legal/acceptances` and
`GET /v1/legal/acceptances`. the device routes, with `GET /health` and `/healthz`, are the
only ones exempt from the bearer check, because their whole job is to serve a caller who
has no session yet. redeeming an
invite verifies the invitee actually has access to the repo, using the invitee's own github
token passed as `x-crosscode-github-token`. row level security is on from the first
migration; `device_codes` carries no policy at all, which denies it to every role that does
not bypass rls.

the service assigns sequence numbers and fans changes out. it does not merge, classify, or
inspect anything. about 7 days of changes are replayable (`HISTORY_RETENTION_DAYS` in
`apps/service/src/store.ts`); a replica whose cursor is older than that is told to resync
from full content rather than handed a partial history.

a room is one project plus one branch name. different branches do not sync, because
different branches mean you did not want to.

## clients (`apps/cli`, `apps/mcp-server`)

neither holds sync state. both talk to the local daemon's loopback http api.

the cli is five commands: `start`, `invite`, `join`, `status`, `stop`.

the mcp server is four tools (`status`, `conflicts`, `resolve`, `pause`) and one pre-edit
hook, reached as `crosscode-mcp hook`. every tool response carries any pending conflicts, so
an agent finds out about one on its next call regardless of what that call was for; the hook
only moves that moment earlier, to before a write rather than after. see
[mcp-clients.md](./mcp-clients.md).

## where a conflict goes

nowhere near a crosscode ui, because there isn't one. a conflict is handed to the user's own
coding agent as `ours` / `theirs` / `ancestor`, and the agent merges it and calls `resolve`.
the [`crosscode` skill](../skills/crosscode/SKILL.md) is what teaches it to do that quietly.

## invariants

1. uncommitted working-tree files are the entire scope. commits, branches, the index, and
   remotes are never touched, and nothing here pushes.
2. never write a file the user or their agent touched in the last ~10 seconds.
3. tracked files only, minus the secret denylist.
4. same project and same branch, or no sync at all.
5. everything is undoable with one command.
6. stop crosscode and the repository is an ordinary git repository.

see [protocol.md](./protocol.md) for the wire shapes and [PLAN.md](../PLAN.md) for what is
built so far.
