# Support

Something is broken, or you need a human. This page says where to go and what to bring.

## Where to go

| What is wrong | Where | Expect a reply |
| --- | --- | --- |
| A bug, a crash, a wrong result, a missing feature | [GitHub issues](https://github.com/amsultan2010/crosscode/issues) | 2 business days for a first response |
| Account access, a lost project, a compromised credential | support@getcrosscode.dev | 1 business day |
| Deleting your account or your data | support@getcrosscode.dev | 2 business days |
| A security vulnerability | [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md), never a public issue | 2 business days |
| Illegal content, or content that breaches [section 4 of the terms](/docs/terms.html) | abuse@getcrosscode.dev — see the [DSA contact page](/docs/dsa-contact.html) for what to include | 2 business days |
| A copyright complaint or counter-notice | legal@getcrosscode.dev — see the [DMCA page](/docs/dmca.html) | 2 business days |
| A privacy request: access, deletion, or a question about what we hold | privacy@getcrosscode.dev | 30 days, usually much sooner |

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

If your agent is finding out about conflicts on its next tool call rather than before it
edits a file, check `.claude/settings.json`: `crosscode start` on 0.1.0 wrote the wrong
command into the `PreToolUse` hook. Re-running `start` on a later release repairs it in
place, and [MCP client setup](./mcp-clients.md) has the entry that works.

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
- **`git pull` refuses, and the changes it would bring are ones you already have.** A
  teammate committed and pushed work the two of you were both holding uncommitted, so git
  sees local modifications in the way and stops, even though the bytes are identical. This
  is git behaving correctly and Crosscode declining to intervene: making the pull succeed
  would mean checking files out on your behalf, and Crosscode never touches your tree
  around a commit. Ask your agent to clear the way — it can stash, pull, and drop the
  stash — or do it yourself. Nothing is lost while the pull is outstanding; the two
  checkouts keep syncing uncommitted files in the meantime.

## Legal

- [Terms of Service](/docs/terms.html)
- [Privacy: what we can and can't see](/docs/privacy.html) — the plain-language version
- [Privacy Policy](/docs/privacy-policy.html) — the formal notice, and how to exercise your rights
- [Cookies](/docs/cookies.html)
- [Subprocessors](/docs/subprocessors.html) — the third parties that process data for us
- [Data Processing Addendum](/docs/dpa.html) — for business users; applies without signing
- [Copyright and DMCA](/docs/dmca.html)
- [DSA contact and illegal content reports](/docs/dsa-contact.html)
- [Accessibility](/docs/accessibility.html)
