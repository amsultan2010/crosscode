# Support

Something is broken, or you need a human. This page says where to go and what to bring.

## Where to go

| What is wrong | Where | Expect a reply |
| --- | --- | --- |
| A bug, a crash, a wrong result, a missing feature | [GitHub issues](https://github.com/amsultan2010/crosscode/issues) | 2 business days for a first response |
| Billing, refunds, subscriptions, invoices | [SUPPORT EMAIL] | 2 business days |
| Account access, a lost workspace, a compromised credential | [SUPPORT EMAIL] | 1 business day |
| A security vulnerability | [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md), never a public issue | 2 business days |

Those are targets on a self-serve plan, not a service level agreement. Crosscode is a small
project and there is no 24-hour desk behind it. If a reply matters by a deadline, say so in
the first message rather than waiting.

Bugs belong on GitHub rather than in email, even if you would rather not write in public,
because the next person hitting the same thing needs to be able to find it. If the bug
cannot be described without something confidential, open an issue that says only that much
and email [SUPPORT EMAIL] with the detail.

## Before you file

Two commands answer most of what we would ask you anyway:

```bash
crosscode --version
crosscode status --json
```

`status` reports the repository, the daemon, the outbox, the sync cursor, and the service
health it can see. It prints no tokens and no file contents.

If the daemon is the problem, `crosscode init --json` followed by `crosscode start` gets you
a fresh daemon for the checkout, and the error you get on the way is usually more specific
than the one you started with.

## What to put in a bug report

1. **What you ran**, verbatim, including flags. Add `--json` to the failing command and paste
   that line: it carries an `error.code` we can branch on, which "it failed" does not.
2. **What you expected, and what happened instead.** One sentence each is enough.
3. **`crosscode --version`** and **`crosscode status --json`** output.
4. **Your OS and Node version** (`node --version`). Crosscode needs Node 24 or newer.
5. **Which agent or editor** was driving it, if one was: Claude Code, Codex CLI, Cursor,
   OpenCode, Gemini CLI, or none.
6. **Whether it reproduces**, and the smallest sequence that reproduces it.

Redact anything you would not post publicly. We do not need your source code, and we cannot
read the encrypted payloads on our side anyway, so please do not paste proprietary file
contents into an issue.

## What to put in a billing message

Send these to [SUPPORT EMAIL]:

1. The **workspace id**, from `crosscode billing status --json`.
2. The **invoice id or receipt**, from the Stripe page `crosscode billing portal` opens.
3. The **email address on the account**. Write from it, or from another owner of the same
   workspace.
4. What you want to happen. The [Refund policy](/docs/refund-policy.html) covers what we can
   do and when.

Never send us a card number, a password, or an access token. We will never ask for any of
them.

## Things that are working as intended

Worth checking before you file:

- **A proposal did not apply itself.** That is the product. Remote work arrives as a
  proposal and is materialized by `crosscode accept <operation-id>`, or automatically only
  if your workspace's autonomy tier says so and the change is clean.
- **A new member was refused with a 402.** The workspace hit its plan's seat cap. Existing
  members are never evicted; the next seat is what gets refused.
- **History older than your retention window is gone.** Free keeps 7 days, and paid plans
  keep 30 to 365. A checkout that was offline longer is told to resynchronize rather than
  handed a partial history.
- **`crosscode billing upgrade --plan student` is refused.** Student pricing is not
  self-serve until there is a verification flow. See the
  [Refund policy](/docs/refund-policy.html).

[Limitations](/docs/limitations.html) lists the known gaps in more detail. Checking it first
often turns a bug report into a shorter question.

## Legal

- [Terms of Service](/docs/terms.html)
- [Refund policy](/docs/refund-policy.html)
- [Privacy](/docs/privacy.html)
