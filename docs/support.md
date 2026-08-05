# Support

Something is broken, or you need a human. This page says where to go and what to bring.

## Where to go

| What is wrong | Where | Expect a reply |
| --- | --- | --- |
| A bug, a crash, a wrong result, a missing feature | [GitHub issues](https://github.com/amsultan2010/crosscode/issues) | 2 business days for a first response |
| Account access, a lost project, a compromised credential | [SUPPORT EMAIL] | 1 business day |
| Deleting your account or your data | [SUPPORT EMAIL] | 2 business days |
| A security vulnerability | [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md), never a public issue | 2 business days |

Those are targets, not a service level agreement. Crosscode is a small project and there is
no 24-hour desk behind it. If a reply matters by a deadline, say so in the first message.

Bugs belong on GitHub rather than in email, even if you would rather not write in public,
because the next person hitting the same thing needs to find it. If the bug cannot be
described without something confidential, open an issue saying only that much and email the
detail.

## Before you file

```bash
crosscode --version
crosscode status
```

`status` reports the branch, whether the daemon is connected, whether sync is paused, the
cursor, pending conflicts, and who else is on the branch. It prints no tokens and no file
contents.

If the daemon itself is the problem, `crosscode stop` then `crosscode start` gets you a
fresh one, and the error on the way is usually more specific than the one you started with.

## What to put in a bug report

1. **What you ran**, verbatim, including flags.
2. **What you expected, and what happened instead.** One sentence each.
3. **`crosscode --version`** and **`crosscode status`** output.
4. **Your OS and Node version** (`node --version`). Crosscode needs Node 24 or newer.
5. **Which agent or editor** was driving it, if one was: Claude Code, Codex CLI, Cursor,
   OpenCode, Gemini CLI, or none.
6. **Whether it reproduces**, and the smallest sequence that does it.

Redact anything you would not post publicly. We do not need your source code.

## Things that are working as intended

- **A file changed under you without asking.** That is the product. A teammate edited it and
  you had not touched it, so it was written silently.
- **A teammate's edit has not arrived.** Check you are both on the same branch. Same project
  *and* same branch name is what makes a room; different branches never sync.
- **An untracked file is not syncing.** Only tracked files sync, and `.env*`, `*.pem`,
  `*.key` and similar never sync even when tracked.
- **Nothing syncs during a rebase or bisect.** Sync pauses for the duration and resyncs
  after.
- **A conflicted file stopped syncing in both directions.** It is quarantined until the
  conflict is resolved, so a half-merged file is never published.
- **History older than about 7 days is gone.** A checkout that was offline longer is told to
  resynchronize rather than handed a partial history.

## Legal

- [Terms of Service](/docs/terms.html)
- [Privacy](/docs/privacy.html)
