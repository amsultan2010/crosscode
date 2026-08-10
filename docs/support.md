# support

something is not going the way you expect, or you need a human. this page says where to go
and what to bring.

## where to go

| what is wrong | where | expect a reply |
| --- | --- | --- |
| a bug, a crash, a wrong result, a missing feature | [github issues](https://github.com/amsultan2010/crosscode/issues) | 2 business days for a first response |
| account access, a lost project, a compromised credential | support@getcrosscode.dev | 1 business day |
| deleting your account or your data | support@getcrosscode.dev | 2 business days |
| a security vulnerability | [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md), never a public issue | 2 business days |
| illegal content, or content that breaches [section 4 of the terms](/docs/terms.html) | abuse@getcrosscode.dev, see the [dsa contact page](/docs/dsa-contact.html) for what to include | 2 business days |
| a copyright complaint or counter-notice | legal@getcrosscode.dev, see the [dmca page](/docs/dmca.html) | 2 business days |
| a privacy request: access, deletion, or a question about what we hold | privacy@getcrosscode.dev | 30 days, usually much sooner |

those are targets, not a service level agreement. crosscode is a small project and there is
no 24-hour desk behind it. if a reply matters by a deadline, say so in the first message.

bugs belong on github rather than in email, even if you would rather not write in public,
because the next person hitting the same thing needs to find it. if the bug cannot be
described without something confidential, open an issue saying only that much and email the
detail.

## before you file

```bash
crosscode --version
crosscode status
```

if your agent is finding out about conflicts on its next tool call rather than before it
edits a file, check `.claude/settings.local.json`: `crosscode start` on 0.1.0 wrote the
wrong command into the `PreToolUse` hook, and releases before 0.1.5 wrote it into the
committed `settings.json` instead. re-running `start` on a later release repairs both in
place -- it installs the working entry in `settings.local.json` and takes the committed one
back out -- and [mcp client setup](./mcp-clients.md) has the entry that works.

`status` reports the branch, whether the daemon is connected, whether sync is paused, the
cursor, pending conflicts, and who else is on the branch. it prints no tokens and no file
contents.

if the daemon itself is the problem, `crosscode stop` then `crosscode start` gets you a
fresh one, and the error on the way is usually more specific than the one you started with.

## what to put in a bug report

1. **what you ran**, verbatim, including flags.
2. **what you expected, and what happened instead.** one sentence each.
3. **`crosscode --version`** and **`crosscode status`** output.
4. **your os and node version** (`node --version`). crosscode needs node 24 or newer.
5. **which agent or editor** was driving it, if one was: claude code, codex cli, cursor,
   opencode, gemini cli, or none.
6. **whether it reproduces**, and the smallest sequence that does it.

redact anything you would not post publicly. we do not need your source code.

## things that are working as intended

- **a file changed under you without asking.** that is the product. a teammate edited it and
  you had not touched it, so it was written silently.
- **a teammate's edit has not arrived.** check you are both on the same branch. same project
  *and* same branch name is what makes a room; different branches never sync.
- **an untracked file is not syncing.** only tracked files sync, and `.env*`, `*.pem`,
  `*.key` and similar never sync even when tracked.
- **nothing syncs during a rebase or bisect.** sync pauses for the duration and resyncs
  after.
- **a conflicted file stopped syncing in both directions.** it is quarantined until the
  conflict is resolved, so a half-merged file is never published.
- **history older than about 7 days is gone.** a checkout that was offline longer is told to
  resynchronize rather than handed a partial history.
- **`git pull` refuses, and the changes it would bring are ones you already have.** a
  teammate committed and pushed work the two of you were both holding uncommitted, so git
  sees local modifications in the way and stops, even though the bytes are identical. this
  is git behaving correctly and crosscode declining to intervene: making the pull succeed
  would mean checking files out on your behalf, and crosscode never touches your tree
  around a commit. ask your agent to clear the way (it can stash, pull, and drop the
  stash) or do it yourself. nothing is lost while the pull is outstanding; the two
  checkouts keep syncing uncommitted files in the meantime.

## legal

- [terms of service](/docs/terms.html)
- [privacy: what we can and can't see](/docs/privacy.html): the plain-language version
- [privacy policy](/docs/privacy-policy.html): the formal notice, and how to exercise your rights
- [cookies](/docs/cookies.html)
- [subprocessors](/docs/subprocessors.html): the third parties that process data for us
- [data processing addendum](/docs/dpa.html): for business users; applies without signing
- [copyright and dmca](/docs/dmca.html)
- [dsa contact and illegal content reports](/docs/dsa-contact.html)
- [accessibility](/docs/accessibility.html)
