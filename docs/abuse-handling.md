# Abuse handling runbook (internal)

**Internal document. Not published to the docs site, not linked from the footer.** It stays
in the repository because it needs to be version-controlled and reviewable, not because it is
for users. The user-facing pages are [Copyright and DMCA](./dmca.md) and
[EU DSA contact](./dsa-contact.md).

Both safe harbors those pages rely on are conditional on **actually acting**. §512(c) needs
expeditious action and a reasonably implemented repeat-infringer policy; DSA Art. 6 protects
only until you have actual knowledge and then do nothing. This file is the procedure that
makes those true. It is also honest about what the service cannot currently do — the
[gap list](#capability-gaps) at the end is the most useful part of this document.

---

## 1. A notice arrives

| Inbox | What it is | Page |
| --- | --- | --- |
| `legal@getcrosscode.dev` | US copyright takedown, counter-notice | [dmca.md](./dmca.md) |
| `abuse@getcrosscode.dev` | Illegal content under the DSA, and authority contact | [dsa-contact.md](./dsa-contact.md) |
| `security@getcrosscode.dev` | Vulnerability disclosure — **not this runbook**, see SECURITY.md | — |
| `support@getcrosscode.dev` | Ordinary support — **not this runbook** | [support.md](./support.md) |

All of these forward to one personal inbox. Misrouted mail is common; route it by what the
notice actually asks for, not by which address it arrived at.

**First action, same day, always: acknowledge receipt.** Reply from the address it came to,
say it was received, say a decision follows within 3 business days. The acknowledgement is
required by DSA Art. 16(4) and it is the single cheapest thing that makes the rest of the
process defensible. Do it before you start assessing.

## 2. Validate the notice

Check it against the statutory elements. Do not skip this: acting on an invalid notice is how
you end up removing content you had no basis to remove, and §512(g)(1)/(4) only protects
good-faith removal made in response to a notice.

- **Copyright** — the six elements of §512(c)(3)(A), enumerated in [dmca.md](./dmca.md#how-to-send-a-notice).
- **Illegal content** — the four elements of DSA Art. 16(2), enumerated in
  [dsa-contact.md](./dsa-contact.md#reporting-illegal-content-article-16).

If an element is missing, reply naming **which** element and what would fix it. Do not act on
the notice yet, and do not silently drop it. Log the exchange either way.

**Locating the content.** Every valid notice must give you `owner/repo`, the branch, and the
file paths, because that is what the data is keyed on. With those:

```sql
-- Which project is it?
SELECT id, name, repo, created_by, created_at FROM projects WHERE repo = $1;

-- Who is in it?
SELECT m.user_id, m.role, u.github_login, u.email
  FROM project_members m JOIN users u ON u.id = m.user_id
 WHERE m.project_id = $1;

-- The changes themselves. File content lives only in file_versions.version (jsonb):
-- {path, op, baseHash, contentHash, content | patch}.
SELECT sequence, replica_id, created_at,
       version->>'path' AS path, version->>'op' AS op,
       length(version->>'content') AS content_bytes
  FROM file_versions
 WHERE project_id = $1 AND branch = $2 AND version->>'path' = ANY($3)
 ORDER BY sequence;
```

Run these against production Postgres (Supabase SQL editor). There is no admin API and no
`crosscode admin` command — see [gap G1](#capability-gaps).

**Expect the content to be gone already.** The change log is retained about 7 days
(`HISTORY_RETENTION_DAYS` in `apps/service/src/store.ts`). A notice about a change from last
month is a notice about rows that no longer exist. That is a legitimate and complete answer
to a takedown — say so, and say that the user's own Git repository is not ours and is not
affected. Check [gap G9](#capability-gaps) before relying on the 7 days as fact.

## 3. Disable access to the content

Ordered from the operation the service actually supports well to the one it barely supports.
Read [gap G3](#capability-gaps) before doing anything at file granularity.

**a. Delete the whole project — the only clean operation.**

```sql
DELETE FROM projects WHERE id = $1;
```

`project_members`, `invites`, `replicas`, and `file_versions` are all
`REFERENCES projects (id) ON DELETE CASCADE` (`apps/service/migrations/001_sync.sql`), so one
statement removes every stored byte for that project. Members' daemons then fail
`requireMembership` on their next request. This is the operation to prefer when the whole
project is the problem.

**b. Remove one member's access.**

```sql
DELETE FROM project_members WHERE project_id = $1 AND user_id = $2;
```

`PgStore.requireMembership` is the single authorization check on every project-scoped route
(`store.ts`), so their next HTTP request is refused. It does **not** close an open websocket —
membership is checked once at subscribe and never again ([gap G7](#capability-gaps)). Follow
it with a service redeploy if the removal needs to bite immediately.

**c. Delete specific changes — only if you have read G3.**

```sql
DELETE FROM file_versions
 WHERE project_id = $1 AND branch = $2 AND version->>'path' = ANY($3);
```

This removes the content but can silently break the room for everyone in it. Prefer (a) or
(b) unless the notice is genuinely narrow and the project is otherwise legitimate; if you do
run it, tell the project's members that they should stop and restart their daemons so they
resynchronize from full content.

**Privileges.** The runtime role deliberately has no `UPDATE`/`DELETE`/`TRUNCATE` on
`file_versions`; `assertRuntimePrivileges()` refuses to start the service if it does. Every
statement above therefore runs as the **migration role**, not the role the service uses. That
is the right security posture and it means the takedown path is not exercised by anything
routine — see [gap G2](#capability-gaps).

## 4. Record the strike

There is no strikes table ([gap G5](#capability-gaps)). Until there is, keep the record in a
private repository or a file the operator controls, one row per action, containing:

- date received, date acted, inbox it arrived at
- notice sender and the full text of the notice
- `owner/repo`, branch, paths, project id, and the user id acted against
- the decision, and the reason for it
- whether a counter-notice or appeal followed, and how it resolved
- whether the strike was later removed, and why

Strike accounting is in [dmca.md](./dmca.md#repeat-infringers): a strike is recorded on a
valid, unwithdrawn, un-reversed takedown; **three strikes** against one account, or one
deliberate and clear-cut infringement, terminates it. That threshold is only meaningful if
the record above actually exists, which is the whole reason §512(i) says "reasonably
implemented" rather than "adopted".

## 5. Terminate an account

Order matters — `users.id` is referenced by `projects.created_by`, `invites.created_by`,
`invites.redeemed_by`, `replicas.user_id`, and `project_members.user_id`, and **none of those
cascade**. A bare `DELETE FROM users` fails on a foreign key.

```sql
-- 1. their projects (cascades to members, invites, replicas, file_versions)
DELETE FROM projects WHERE created_by = $1;
-- 2. memberships and checkouts in other people's projects
DELETE FROM replicas WHERE user_id = $1;
DELETE FROM project_members WHERE user_id = $1;
-- 3. invites they created or redeemed
DELETE FROM invites WHERE created_by = $1;
UPDATE invites SET redeemed_by = NULL WHERE redeemed_by = $1;
-- 4. finally the row itself
DELETE FROM users WHERE id = $1;
```

**Then delete the identity in Supabase Auth** (dashboard → Authentication → Users). Skipping
this means they sign in again and `upsertUser` recreates the row on their first request, so
the termination undoes itself. Even with it done, an access token already issued keeps
working until it expires: verification is a local JWKS check in `apps/service/src/auth.ts`
with no revocation lookup ([gap G6](#capability-gaps)). Project-scoped routes still fail,
because those hit `requireMembership` against the database on every request.

This same procedure is what answers a user's own deletion request under
[privacy.md](./privacy.md#deleting-your-data). It is the only account-deletion path there is.

## 6. Issue the statement of reasons

Required by DSA Art. 17 for **every** restriction — content removal, project deletion,
account suspension or termination — whatever prompted it. Email it to the address on the
account. Contents are listed in
[dsa-contact.md](./dsa-contact.md#statement-of-reasons-article-17): what was restricted,
whether it is permanent, the facts relied on, the legal or contractual ground, and how to
appeal. State explicitly that no automated means were used, because none are.

For copyright specifically, also send the complainant's notice to the affected user and point
them at the [counter-notice procedure](./dmca.md#counter-notice). If a counter-notice arrives,
forward it to the complainant and hold restoration for **not less than 10 and not more than 14
business days** unless they file suit. Diary the date; the window is statutory.

We do **not** submit statements of reasons to the Commission's DSA Transparency Database:
Art. 24(5) requires it, Art. 19 exempts micro enterprises, and the exemption is relied on.

## 7. Keep the record

Keep everything in step 4 — notices, decisions, statements of reasons, dates — for **three
years** from the date of the action. Reasons, in order of how much they matter:

- The repeat-infringer policy is worthless without a history to count strikes against.
- §512(f) misrepresentation claims and DSA appeals both look backwards.
- If Crosscode ever crosses the micro-enterprise threshold, DSA Art. 15 transparency
  reporting starts, and it is asked for the counts this record already holds.

Note the asymmetry: the *content* is gone in ~7 days, but the *record about the content*
lives three years. That is intentional and worth keeping intentional — the record should hold
paths, hashes, and decisions, **not** copies of the file contents themselves.

---

## Capability gaps

Operations this runbook needs that the service cannot currently perform. Written down rather
than designed around, because an honest gap list is what makes the procedure usable under
time pressure.

**G1 — No admin surface at all.** The routes in `apps/service/src/http.ts` are health, the
three device-auth routes, create project, create invite, redeem invite, register replica, and
publish/list changes. There is no admin route, no `crosscode admin` subcommand, and no
moderation UI. Every operation in this runbook is hand-written SQL typed into a production
database console: no dry-run, no confirmation, no undo, and no audit trail of what the
operator did.

**G2 — The takedown path runs on an elevated credential and is never exercised.** The runtime
role cannot delete from `file_versions` by design (`assertRuntimePrivileges`). Correct
posture, but it means every deletion here needs the migration role, and nothing in CI or in
normal operation ever runs these statements. The first time they are used will be under a
legal deadline.

**G3 — No way to disable one file without risking the room.** This is the significant one.
`listChanges` assumes retention only ever deletes a *prefix* of a room's sequence: it derives
`resyncFrom` from `min(sequence)` and answers `cursor-too-old` only when a cursor falls below
it. Deleting a row from the *middle* produces a hole that is served as an ordinary page with
the row simply absent — replicas never see that change and are never told to resynchronize.
Worse, a later change may be a `patch` chained through the deleted version's `contentHash`
(`packages/protocol/src/sync.ts`), and that patch can no longer be applied. Net effect: a
per-file takedown can silently corrupt a project for every member. **Today the only safe
takedown granularity is the whole project.** Fixing this properly means either a tombstone
(replace `version` with a redacted marker at the same sequence, preserving contiguity) or a
`resyncFrom` watermark the service can raise by hand.

**G4 — Nothing prevents re-publication.** There is no per-project or per-path blocklist.
Delete the rows and the same daemon republishes the same file on its next settled edit. Access
removal (project deletion or member removal) is the only durable stop, which is why step 3
prefers it.

**G5 — No strike, suspension, or termination state in the database.** No column, no table, no
audit log. `projects.plan` exists and is unread, but nothing records that an account was
warned, struck, or terminated. The repeat-infringer policy in `dmca.md` is therefore
implemented entirely outside the system, in whatever record step 4 is kept in.

**G6 — Termination is not immediate.** Supabase access tokens are verified locally against
the JWKS (`apps/service/src/auth.ts`) with no revocation check on the request path. A deleted
user's existing token stays valid until it expires; the access-token lifetime is set in the
Supabase project, not in this repository. Project-scoped routes do fail immediately, because
`requireMembership` reads the database on every request.

**G7 — Open websockets survive membership removal.** `subscribe()` in
`apps/service/src/ws.ts` calls `requireMembership` once during the handshake and never again.
A removed member with a live socket keeps receiving the room's broadcasts until the socket
drops or the service redeploys. There is no way to kick a connection.

**G8 — Account deletion is a multi-statement manual sequence with no cascade.** Step 5 exists
only because `users` has no cascading deletes. It is easy to get wrong under pressure and it
is the same path that answers a user's privacy request, so it is not only a moderation
concern.

**G9 — There is no retention job in this repository.** `docs/privacy.md` and
`docs/terms.md` both say change history is pruned after about seven days by a scheduled job.
`HISTORY_RETENTION_DAYS = 7` exists in `store.ts` and `file_versions_created_at_idx` exists to
support the sweep, but there is no `pg_cron` migration, no Vercel cron entry
(`apps/docs-site/vercel.json` has none), and no GitHub Actions workflow that deletes from
`file_versions` — the three workflows are `ci`, `smoke`, and `uptime`. Either the job runs
somewhere outside version control, in which case it should be recorded here, or content is
being retained longer than the privacy page promises. **Confirm this before telling any
notice-sender that content has aged out.**

<!-- LAWYER: G9 is the one with legal exposure beyond this runbook — docs/privacy.md makes a
     retention promise to users, and a promise a system does not keep is a
     misrepresentation question, not just a bug. Flag to whoever owns the privacy suite. -->

**G10 — No trusted-flagger or authority-verification path.** DSA Art. 22 trusted flaggers are
an online-platform obligation and do not apply here, but there is also no way to verify that
a message claiming to be from a Member State authority is one. At this scale that is a
judgement call made by reading the email; it is listed so the absence is deliberate.

## Before this is relied on

This runbook uses no placeholder tokens of its own. It does depend on things that are not
done yet:

- The DMCA designated agent must be **registered** — see the checklist at the end of
  [dmca.md](./dmca.md#before-this-takes-effect). Until then this procedure is good practice
  rather than a safe harbor.
- Decide where the step 4 record lives, and write the location into this file.
- Resolve **G9** — find the retention job or build it — before the first notice arrives.
