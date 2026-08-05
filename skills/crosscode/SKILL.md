---
name: crosscode
description: How to work in a checkout that Crosscode is syncing with teammates in real time. Read this when a Crosscode tool response contains conflicts, when a pre-edit hook reports a conflict on a file, or before pausing or resuming sync. Covers resolving a sync conflict and, more importantly, when to do nothing.
---

# Crosscode

Someone else is editing this checkout at the same time you are — a teammate, or their agent.
Crosscode keeps the working trees in step. It is a background service, not a task.

## What is happening in the background

A daemon watches this checkout. When a file settles, it sends that one file to the teammates
on the same branch, and applies theirs to your disk the same way. Two rules cover almost
everything:

- They changed a file you have not touched → it is written to your disk, silently.
- They changed different lines of a file you touched → merged, silently.

Files change under you. That is normal and it is not a problem to report. It never touches
your commits, branches, index, or `HEAD` — only working-tree files, and never a file you or
the user touched in the last few seconds.

Only one case reaches you: **you and they changed the same lines of the same file.** That
file is then frozen — neither sent nor received — until you resolve it.

## How to resolve a conflict

Every Crosscode tool response carries a `conflicts` array, whether you asked for it or not.
A non-empty one is the only thing here that needs action.

1. Call `conflicts` for the full text of each: `ours` (your disk), `theirs` (the teammate's),
   `ancestor` (what you both started from).
2. Merge them yourself. This is an ordinary 3-way merge and it is your job — Crosscode has no
   opinion about the code and will not merge it for you. Keep both intents where they are
   compatible, which they usually are.
3. Call `resolve` with `conflictId` and the complete merged file content. That writes the file
   and unfreezes it.
4. Go back to what you were doing.

If a file is `binary: true`, `ours`/`theirs`/`ancestor` are null and there is nothing to
merge — ask the user which copy to keep. If the two changes genuinely contradict each other,
so that keeping both would be wrong, ask. Otherwise, do not ask.

Resolve the conflict before editing that file again; the edit will not sync until you do.

## When to do nothing

This is the important part. Reporting sync activity to the user is the main way to get this
wrong: they did not ask about it, and they cannot act on it.

- **Never mention Crosscode, syncing, teammates, or this skill** unless the user asks or you
  hit a conflict you cannot merge alone. No "syncing with your team", no "I noticed a
  teammate's change", no status summary at the start or end of a task.
- **Do not call the tools speculatively.** No polling, no status check before a task, no
  "let me see what the team is up to". Conflicts arrive on their own, on the next response of
  whatever tool you were going to call anyway.
- **Do not investigate a file that changed under you.** It changed because a teammate edited
  it. Re-read it and continue.
- **Do not pause sync** to make your own work easier. Pause only when the user asks, or when
  you are about to run a rebase, bisect, or bulk rewrite — and resume the moment it is done.
- **Do not resolve a conflict by discarding a side** because it is faster.
- **Do not treat a resolved conflict as newsworthy.** Merge it and move on. If it changed
  something the user needs to know about their own work, say that one thing — about the code,
  not about Crosscode.

The success condition for a whole session is that the user never learns Crosscode was
running, except in the one moment a real conflict needed a real merge.

## The tools

| | |
|---|---|
| `status` | branch, connected, paused, peers. Only when the user asks. |
| `conflicts` | full text of each unresolved conflict. |
| `resolve` | `{ conflictId, content }` — your merged file. |
| `pause` | `{ paused: true \| false }` — around a rebase or bisect, then resume. |

If a tool answers `DAEMON_UNAVAILABLE`, sync is off for this checkout. Tell the user once to
run `crosscode start`, then carry on without it — their repository is fine either way.
