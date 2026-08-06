# Crosscode — the plan

**The only plan document in this repo.** If it isn't on this page, we don't build it.
No other plan files. No status reports. No design docs.

---

## The one thing we build

**Real-time codebase sync between teammates.** You edit, their copy updates within seconds.
They edit, yours does. Nobody presses anything or notices anything.

The *only* interruption is when you both changed the same lines of the same file — and that
goes to your own coding agent, not to a Crosscode UI.

That's the whole product.

---

## The core workflow

**Joining**

```
Alice:  crosscode invite  →  https://getcrosscode.dev/join/7f3a9c2e

Bob clicks it, signs in with GitHub, and the page gives him:
        git clone git@github.com:acme/app.git && cd app
        crosscode join CC-7F3A-9C2E
```

Two pasted lines. That's the entire onboarding budget.

**Working**

```
you edit a file
  → daemon notices ~300ms after you stop typing
  → sends that one file's change over an open socket
  → teammate's daemon receives it:

      they haven't touched that file   → write it.     silent.
      they touched different lines     → auto-merge.   silent.
      they touched the SAME lines      → conflict → their agent fixes it
```

The first case is ~95% of real use — you're on auth, they're on billing. Nobody sees anything.

**Conflict.** The agent gets theirs / yours / the common ancestor, fixes it, moves on.
Crosscode never judges the change, classifies risk, or reviews code. **The user's own agent
does the work.** Crosscode just delivers the right information at the right moment.

**Rules that keep it invisible**
- Never write a file the user or their agent touched in the last ~10s
- Never sync during a rebase / merge / bisect — pause, then resync
- Same branch only; different branches means you don't want to sync
- Everything undoable with one command

---

## Decisions (settled — don't relitigate)

| | |
|---|---|
| Merging | 3-way hunk merge via `git merge-file`. No CRDT. |
| Scope | Uncommitted working-tree files only. Commits, branches, push/pull stay pure git. |
| Rooms | Same project + same branch name. |
| What syncs | Tracked files only, plus a hard denylist (`.env*`, `*.pem`, `*.key`, credentials). |
| Agents | MCP is the baseline so every agent works. Hooks are a bonus for Claude Code and Codex. |
| Offline | Durable change log, ~7 day retention, catch-up on reconnect. |
| Sign-in | GitHub OAuth, as a device-code handshake: the CLI prints a URL and a short code, the browser signs in and binds the code. No loopback callback server. The invite page verifies the invitee actually has repo access. |
| Daemon | Per checkout, started by `crosscode start`, auto-restarts on crash. |
| Hosting | Hosted only. No self-hosting, no `--service` flag. |
| Presence | No ambient UI. The agent can see who's working on what via MCP. |
| Encryption | TLS in transit + at rest. No E2E, no device pairing. |
| Billing | None. Keep a `plan` column for later. |
| AI reviewer | v2, not now. |
| Method | Strip first, then rebuild. |

---

## What we do NOT build

Proposals you accept or reject · tasks · claims · scope leases · handoffs · intents ·
checkpoints · validation profiles · publish-to-branch · autonomy tiers · semantic review ·
risk classification · dependency graphs · E2E device pairing · billing · seats ·
usage counters · self-hosting · a web app · a TUI.

We built all of this once. That's why we lost the plot.

**Hard limits:**

| | Start | Now | Target |
|---|---|---|---|
| CLI commands | ~45 | 5 | **5** — `start` `invite` `join` `status` `stop` |
| MCP tools | 22 | 4 | **4** — `status` `conflicts` `resolve` `pause` |
| Skills | 0 | 1 | **1** |
| DB tables | 24 | 6 | **7** — the six below plus `device_codes` for sign-in |
| Source lines | ~13,700 | ~7,200 | **~3,500** |

Counted, not remembered. `.command("` in `apps/cli/src/index.ts`, `TOOL_NAMES` in
`apps/mcp-server/src/tool-catalog.ts`, `CREATE TABLE` in `apps/service/migrations/`, and
`find apps/*/src packages/*/src -name '*.ts' -not -name '*.test.ts' | xargs wc -l`.

Four of the five rows are at target. Source lines are not, and the honest reading is that
the number has gone **up** since the last count: the service and the daemon grew while the
protocol shrank. The gap is no longer one rewrite waiting to happen — `packages/protocol`
is already down to 282 lines and holds nothing transaction-shaped. Closing the rest means
deleting from `apps/service` (2,109) and `apps/daemon` (1,893), and nothing on this page
authorises that yet.

---

## How it works (brief)

**One git ref does most of the work.** `refs/crosscode/shadow` points at a commit whose tree
is the last state both sides agreed on. Free from that: the merge base, "have I edited this
since we synced?", undo (`git checkout refs/crosscode/shadow -- <path>`), and content storage
in git's own object store. Never moves HEAD, never appears in `git log`.

**Sync unit is one file:** `{ path, op, baseHash, contentHash, content-or-patch }`. No bundles,
no lifecycle, no accept/reject. `op` is `modify` or `delete` — without it a delete is
indistinguishable from an empty file.

**Apply rule** for incoming change to `P`, where `L` = my disk, `S` = shadow:
1. `L == S` **and the sender built from `S`** → write it, silent
2. Otherwise → 3-way merge against the sender's base, resolved by content hash from git's
   object store; clean → write silent, conflict → surface
3. Only if that base blob is genuinely missing → catch up from cursor, retry

The sender advances its shadow on send. Binaries are never merged — concurrent binary edits
are always a conflict. A conflicted path is quarantined: neither published nor applied until
it is resolved.

Phase 2 proved all four of those clauses are load-bearing — the earlier draft of this rule
lost data silently on concurrent edits, and rebroadcast forever without the shadow advance.

**Six tables:** `users` `projects` `project_members` `invites` `replicas` `file_versions`.
Presence is in-memory in the websocket gateway. Sign-in adds a seventh, `device_codes`,
holding a hashed device code and the user code the browser binds to a session; rows are
short-lived and single-use.

---

## Checklist

**Done:** 1 (strip) · 2 (merge core proven) · 4 (daemon). **Mostly done:** 3, 5, 6.
**Not started:** 7 beyond the docs rewrite.

A box is ticked when the thing is on `main` and its verify line was actually run. It is not
ticked because the design is agreed or the code is written on a branch somewhere. Every one
of the four boxes left open below is a thing a user would notice, and three of them are one
fact seen from three sides: sign-in has never once run to completion. It is a dashboard
setting away rather than a line of code away, which makes it easy to keep calling done.

Phase 2's proof lives in `spike/` — throwaway, outside the build. Read its README before
starting Phase 4; port the algorithm, not the code.

### 1 — Strip
- [x] Tasks / claims / handoffs / intents — daemon, routes, 4 tables, CLI, MCP
- [x] Proposal lifecycle — accept, reject, analyze, diff, artifacts
- [x] Checkpoints · validation profiles · publish-to-branch · autonomy tiers
- [x] Semantic review, agent-delegated reviewer, TypeScript dependency graph
- [x] E2E key + device pairing — `workspace-key.ts`, `sealing.ts`, pairing routes, migrations 009/015
- [x] Stripe — `billing*.ts`, `stripe.ts`, migrations 008/011/014
- [x] Self-hosting — `--service` flag and docs
- [x] `provision-admin.ts` · `prune.ts` · `retention.ts`
- [x] **Verify:** builds; only sync-related code remains

### 2 — Prove the merge core
- [x] Two temp checkouts, no service, no network
- [x] Shadow ref + apply rule + hot-file deferral + loop suppression
- [x] Cases: disjoint files · same file disjoint hunks · same file same lines · delete vs edit · rename · binary · offline then reconnect
- [x] **Verify:** both sides converge byte-identical with zero interaction; same-line case yields exactly one conflict and writes nothing

### 3 — Protocol + service
- [x] Rewrite `packages/protocol` — 282 lines, and nothing transaction-shaped left in it
- [x] 6-table migration, RLS from day one
- [ ] GitHub OAuth — routes, table and `/device` page are built and live: `start` gets a
      code from `POST /v1/auth/github/device`, `/device/token` polls, and the page binds
      the code to a Supabase session. What is left is not code. The GitHub OAuth
      application configured on the Supabase project is wrong — its `client_id` sends a
      signed-in browser to a GitHub 404 — so no session is ever minted and this still
      blocks `start`, `invite`, and `join` alike. Fix in the Supabase dashboard, not here.
- [x] `POST /v1/projects` · `POST /v1/invites` · `POST /v1/invites/:code/redeem` · `GET /v1/changes?since=` · `POST /v1/changes`
- [x] Websocket `/v1/stream`
- [x] **Verify:** two replicas, 100 changes in order; cursor catch-up after forced disconnect

### 4 — Daemon
- [x] Watch (tracked files, denylist, ~300ms per-file debounce) → shadow diff → publish
- [x] Receive → apply / merge / conflict
- [x] Hot-file deferral, loop suppression
- [x] Reconnect, catch-up, full resync when cursor is too old
- [x] Auto-pause on git operations; auto-restart on crash
- [x] **Verify:** three real daemons, concurrent edits, all converge identical; one intentional collision → exactly one conflict

### 5 — CLI + onboarding
- [x] Cut to 5 commands
- [x] `start`: config → GitHub sign-in → project → daemon → install MCP + skill + hooks. Idempotent.
- [x] `invite` → URL; `/join/:code` page verifies repo access → copy-paste block
- [x] `join <code>` → redeem → same setup
- [ ] **Verify:** fresh machine, link to syncing in under 60s, typing only the two given
      lines. Still blocked on the OAuth application above: `start` now reaches sign-in and
      prints a real code, and stops there because no browser can complete it. Nobody has
      run this on a clean machine, so the 60-second figure is a target and no page may
      print it as a measurement.

### 6 — Agent surface
- [x] The `crosscode` skill — what's happening in the background · how to resolve a conflict · when to do nothing
- [x] 4 MCP tools, conflicts piggybacked on every response
- [x] Claude Code + Codex hooks firing before file edits. `start` installs
      `crosscode-mcp hook`, which reads the payload on stdin and exits 2 on a conflicted
      path. 0.1.0 installed `crosscode status --json` instead — stdin ignored, no way to
      learn the file, no way to exit 2 — so an upgrade rewrites that entry in place rather
      than leaving it and adding a second.
- [ ] **Verify:** two live agent sessions on one repo; neither mentions Crosscode until a real conflict, which the receiving agent resolves unprompted

### 7 — Docs + harden
- [x] Rewrite `README.md` and `docs/{architecture,protocol,onboarding-contracts,mcp-clients,install-prompt}.md` — all describe the deleted architecture
- [ ] Large-repo watcher performance; binary and large files
- [ ] Battery/CPU measured over a real workday
- [ ] Retention job; resync under bad networks
- [ ] **Verify:** README quickstart works literally on a clean machine

---

## Known risks

- Writing to a file with an unsaved editor buffer, or one the agent is mid-edit on
- Secrets: real-time syncing an untracked `.env` would be a serious incident
- A file watcher over a large monorepo isn't free — measure, don't assume
- Three-way convergence is unproven; the spike only ran two replicas. Test before Phase 4
- Under sustained typing a hot file can defer forever — deferral needs a ceiling
- **Migrations do not grant to the runtime role, and nothing catches it.** `001` created
  six tables and granted `crosscode_runtime` nothing; the grants were applied once, by
  hand, outside the repo. So `device_codes` shipped unreadable and every sign-in 500ed with
  `permission denied` while CI was green and `/healthz` said `ok`. `002` now carries its
  own grant and health fails on an unreadable table, but the next migration has to remember
  the same thing, and only a convention says it will
- **`git pull` can refuse where the content is identical, and we do not fix it.** Alice
  commits and pushes what she and Bob both hold uncommitted; Bob's `git pull` refuses with
  "your local changes would be overwritten", even though the bytes match. Making it succeed
  would mean touching Bob's working tree to line it up with a commit, which is exactly the
  magic this product refuses. What ships is the noticing: the daemon rebases the shadow and
  tells Bob's agent, which can clear the way itself. That leaves a real papercut in place on
  purpose, and it is the first thing a real team will hit
- **Sign-in has never completed once, end to end.** Every piece is deployed and the pieces
  answer correctly in isolation, which is a state that reads as working and is not. Nothing
  should be called done here until one person has gone from `crosscode start` to a synced
  file without being told what to type
