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
| Sign-in | GitHub OAuth. The invite page verifies the invitee actually has repo access. |
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
| CLI commands | ~45 | 4 | **5** — `start` `invite` `join` `status` `stop` |
| MCP tools | 22 | 1 | **4** — `status` `conflicts` `resolve` `pause` |
| Skills | 0 | 0 | **1** |
| DB tables | 24 | 11 | **6** |
| Source lines | ~13,700 | ~6,000 | **~3,500** |

The remaining gap to target is Phase 3's rewrite, not more deleting. What is left is the
old transaction-shaped protocol and the routes built on it.

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
Presence is in-memory in the websocket gateway.

---

## Checklist

**Done:** 1 (strip) · 2 (merge core proven). **Next:** 3. Nothing in 3–7 is started.

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
- [ ] Rewrite `packages/protocol` (~1,000 lines → ~150)
- [x] 6-table migration, RLS from day one
- [ ] GitHub OAuth
- [x] `POST /v1/projects` · `POST /v1/invites` · `POST /v1/invites/:code/redeem` · `GET /v1/changes?since=` · `POST /v1/changes`
- [x] Websocket `/v1/stream`
- [x] **Verify:** two replicas, 100 changes in order; cursor catch-up after forced disconnect

### 4 — Daemon
- [ ] Watch (tracked files, denylist, ~300ms per-file debounce) → shadow diff → publish
- [ ] Receive → apply / merge / conflict
- [ ] Hot-file deferral, loop suppression
- [ ] Reconnect, catch-up, full resync when cursor is too old
- [ ] Auto-pause on git operations; auto-restart on crash
- [ ] **Verify:** three real daemons, concurrent edits, all converge identical; one intentional collision → exactly one conflict

### 5 — CLI + onboarding
- [ ] Cut to 5 commands
- [ ] `start`: config → GitHub sign-in → project → daemon → install MCP + skill + hooks. Idempotent.
- [ ] `invite` → URL; `/join/:code` page verifies repo access → copy-paste block
- [ ] `join <code>` → redeem → same setup
- [ ] **Verify:** fresh machine, link to syncing in under 60s, typing only the two given lines

### 6 — Agent surface
- [ ] The `crosscode` skill — what's happening in the background · how to resolve a conflict · when to do nothing
- [ ] 4 MCP tools, conflicts piggybacked on every response
- [ ] Claude Code + Codex hooks firing before file edits
- [ ] **Verify:** two live agent sessions on one repo; neither mentions Crosscode until a real conflict, which the receiving agent resolves unprompted

### 7 — Docs + harden
- [ ] Rewrite `README.md` and `docs/{architecture,protocol,onboarding-contracts,mcp-clients,install-prompt}.md` — all describe the deleted architecture
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
