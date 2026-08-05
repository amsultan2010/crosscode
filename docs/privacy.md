# Privacy: what we can and can't see

Crosscode syncs your uncommitted edits between checkouts, so those files pass through our
coordination service. This page says exactly what that service holds.

**We hold your file contents.** There is no end-to-end encryption. Files are encrypted in
transit (TLS) and at rest, under keys we manage, which means a Crosscode engineer with
production access could read them. We would rather say that plainly than imply otherwise.

If that is not acceptable for a given repository, do not sync it. Crosscode is opt-in per
checkout and stopping it leaves an ordinary Git repository behind.

## What the service stores

- **The files you edit while syncing**: path, content, the hashes either side merged
  against, and whether the change was a modify or a delete. Tracked files only.
- **Your GitHub account identity** — the account you signed in with, and the project
  memberships we use to decide who may sync with whom.
- **Your repository, as `owner/repo`.** Projects are keyed on it. If a repository's *name*
  is confidential, this is not the tool for it.
- **Timestamps, sizes, and sequence numbers.** When you were active and how large a change
  was.
- **Presence**: which branch you are on and which paths you touched recently, so a teammate's
  agent can answer "who is working on what". This is in memory in the websocket gateway, not
  in the database.

## What never leaves your machine

- **Untracked files.** Only files Git already tracks are ever sent.
- **Secrets, even when tracked.** `.env*`, `*.pem`, `*.key`, and similar are on a hard
  denylist, dropped before a change is captured rather than filtered later.
- **Your commits, branches, index, stash, and remotes.** Crosscode reads and writes
  working-tree files and one ref of its own (`refs/crosscode/shadow`). Nothing in Crosscode
  pushes anywhere.

## How long it is kept

About 7 days. That window is what makes offline catch-up possible: a checkout that comes
back within it replays what it missed, and one that has been away longer is told to
resynchronize from full content rather than handed a partial history. Older changes are
deleted by a scheduled job.

Your repository is the durable artifact the whole time, on your disk, as ordinary Git.

## What we never do

- We never send your code to a third-party AI provider. Crosscode has no AI features and
  stores no model provider credentials. The only agent involved is the one already on your
  machine, and it reads your files locally.
- We never push to your Git remotes.
- We do not sell or share your data.

## Removing someone

Removing a member from a project ends their access immediately: their daemon stops receiving
on its next request. It cannot un-share what they already have — they had a full checkout of
the repository. No product can reach into a copy someone already holds, and we would rather
tell you that than let you believe otherwise.

## Deleting your data

Ask us and we delete your account, your projects, and the change history attached to them.
See [support](./support.md). Your repositories are unaffected, because they were never ours.
