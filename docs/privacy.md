# privacy: what we can and can't see

crosscode syncs your uncommitted edits between checkouts, so those files pass through our
coordination service. this page says exactly what that service holds.

this is the honest summary. the complete, formal notice (legal bases, retention per
category, your rights and how to exercise them) is the
[privacy policy](./privacy-policy.md). alongside it: [cookies and local
storage](./cookies.md), [subprocessors](./subprocessors.md), and the [data processing
agreement](./dpa.md) for personal data that sits inside the files you sync.

**we hold your file contents.** there is no end-to-end encryption. files are encrypted in
transit (tls) and at rest, under keys we manage, which means a crosscode engineer with
production access could read them. we would rather say that plainly than imply otherwise.

if that is not acceptable for a given repository, do not sync it. crosscode is opt-in per
checkout and stopping it leaves an ordinary git repository behind.

## what the service stores

- **the files you edit while syncing**: path, content, the hashes either side merged
  against, and whether the change was a modify or a delete. tracked files only.
- **your github account identity**: the account you signed in with, and the project
  memberships we use to decide who may sync with whom.
- **your repository, as `owner/repo`.** projects are keyed on it. if a repository's *name*
  is confidential, this is not the tool for it.
- **timestamps, sizes, and sequence numbers.** when you were active and how large a change
  was.
- **presence**: which branch you are on and which paths you touched recently, so a teammate's
  agent can answer "who is working on what". this is in memory in the websocket gateway, not
  in the database.
- **a pending sign-in, while it is pending.** signing the cli in creates a row holding a
  hash of the device code and the short code you type into the page. it expires in about
  fifteen minutes and is consumed the moment sign-in completes.

## what never leaves your machine

- **untracked files.** only files git already tracks are ever sent.
- **secrets, even when tracked.** `.env*`, `*.pem`, `*.key`, and similar are on a hard
  denylist, dropped before a change is captured rather than filtered later.
- **your commits, branches, index, stash, and remotes.** crosscode reads and writes
  working-tree files and one ref of its own (`refs/crosscode/shadow`). nothing in crosscode
  pushes anywhere.

## how long it is kept

about 7 days. that window is what makes offline catch-up possible: a checkout that comes
back within it replays what it missed, and one that has been away longer is told to
resynchronize from full content rather than handed a partial history. beyond that window,
history is no longer served back to any checkout.

your repository is the durable artifact the whole time, on your disk, as ordinary git.

## what we never do

- we never send your code to a third-party ai provider. crosscode has no ai features and
  stores no model provider credentials. the only agent involved is the one already on your
  machine, and it reads your files locally.
- we never push to your git remotes.
- we do not sell or share your data.

## removing someone

removing a member from a project ends their access immediately: their daemon stops receiving
on its next request. it cannot un-share what they already have. they had a full checkout of
the repository. no product can reach into a copy someone already holds, and we would rather
tell you that than let you believe otherwise.

## deleting your data

ask us and we delete your account, your projects, and the change history attached to them.
see [support](./support.md). your repositories are unaffected, because they were never ours.

your other rights (access, rectification, restriction, portability, objection) and the
one-month response time are in §9 of the [privacy policy](./privacy-policy.md). write to
privacy@getcrosscode.dev for any of them.
