# abuse handling runbook (internal)

**internal document. not published to the docs site, not linked from the footer.** it stays
in the repository because it needs to be version-controlled and reviewable, not because it is
for users. the user-facing pages are [copyright and dmca](./dmca.md) and
[eu dsa contact](./dsa-contact.md).

both safe harbors those pages rely on are conditional on **actually acting**. §512(c) needs
expeditious action and a reasonably implemented repeat-infringer policy; dsa art. 6 protects
only until you have actual knowledge and then do nothing. this file is the procedure that
makes those true. it is also honest about what the service cannot currently do. the
[gap list](#capability-gaps) at the end is the most useful part of this document.

---

## 1. a notice arrives

| inbox | what it is | page |
| --- | --- | --- |
| `legal@getcrosscode.dev` | us copyright takedown, counter-notice | [dmca.md](./dmca.md) |
| `abuse@getcrosscode.dev` | illegal content under the dsa, and authority contact | [dsa-contact.md](./dsa-contact.md) |
| `security@getcrosscode.dev` | vulnerability disclosure, **not this runbook**, see SECURITY.md | n/a |
| `support@getcrosscode.dev` | ordinary support, **not this runbook** | [support.md](./support.md) |

all of these forward to one personal inbox. misrouted mail is common; route it by what the
notice actually asks for, not by which address it arrived at.

**first action, same day, always: acknowledge receipt.** reply from the address it came to,
say it was received, say a decision follows within 3 business days. the acknowledgement is
required by dsa art. 16(4) and it is the single cheapest thing that makes the rest of the
process defensible. do it before you start assessing.

## 2. validate the notice

check it against the statutory elements. do not skip this: acting on an invalid notice is how
you end up removing content you had no basis to remove, and §512(g)(1)/(4) only protects
good-faith removal made in response to a notice.

- **copyright**: the six elements of §512(c)(3)(a), enumerated in [dmca.md](./dmca.md#how-to-send-a-notice).
- **illegal content**: the four elements of dsa art. 16(2), enumerated in
  [dsa-contact.md](./dsa-contact.md#reporting-illegal-content-article-16).

if an element is missing, reply naming **which** element and what would fix it. do not act on
the notice yet, and do not silently drop it. log the exchange either way.

**locating the content.** every valid notice must give you `owner/repo`, the branch, and the
file paths, because that is what the data is keyed on. with those:

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

run these against production postgres (supabase sql editor). there is no admin api and no
`crosscode admin` command. see [gap g1](#capability-gaps).

**expect the content to be gone already.** the change log is retained about 7 days
(`HISTORY_RETENTION_DAYS` in `apps/service/src/store.ts`). a notice about a change from last
month is a notice about rows that no longer exist. that is a legitimate and complete answer
to a takedown, say so, and say that the user's own git repository is not ours and is not
affected. check [gap g9](#capability-gaps) before relying on the 7 days as fact.

## 3. disable access to the content

ordered from the operation the service actually supports well to the one it barely supports.
read [gap g3](#capability-gaps) before doing anything at file granularity.

**a. delete the whole project: the only clean operation.**

```sql
DELETE FROM projects WHERE id = $1;
```

`project_members`, `invites`, `replicas`, and `file_versions` are all
`REFERENCES projects (id) ON DELETE CASCADE` (`apps/service/migrations/001_sync.sql`), so one
statement removes every stored byte for that project. members' daemons then fail
`requireMembership` on their next request. this is the operation to prefer when the whole
project is the problem.

**b. remove one member's access.**

```sql
DELETE FROM project_members WHERE project_id = $1 AND user_id = $2;
```

`PgStore.requireMembership` is the single authorization check on every project-scoped route
(`store.ts`), so their next http request is refused. it does **not** close an open websocket:
membership is checked once at subscribe and never again ([gap g7](#capability-gaps)). follow
it with a service redeploy if the removal needs to bite immediately.

**c. delete specific changes: only if you have read g3.**

```sql
DELETE FROM file_versions
 WHERE project_id = $1 AND branch = $2 AND version->>'path' = ANY($3);
```

this removes the content but can silently break the room for everyone in it. prefer (a) or
(b) unless the notice is genuinely narrow and the project is otherwise legitimate; if you do
run it, tell the project's members that they should stop and restart their daemons so they
resynchronize from full content.

**privileges.** the runtime role deliberately has no `UPDATE`/`DELETE`/`TRUNCATE` on
`file_versions`; `assertRuntimePrivileges()` refuses to start the service if it does. every
statement above therefore runs as the **migration role**, not the role the service uses. that
is the right security posture and it means the takedown path is not exercised by anything
routine. see [gap g2](#capability-gaps).

## 4. record the strike

there is no strikes table ([gap g5](#capability-gaps)). until there is, keep the record in a
private repository or a file the operator controls, one row per action, containing:

- date received, date acted, inbox it arrived at
- notice sender and the full text of the notice
- `owner/repo`, branch, paths, project id, and the user id acted against
- the decision, and the reason for it
- whether a counter-notice or appeal followed, and how it resolved
- whether the strike was later removed, and why

strike accounting is in [dmca.md](./dmca.md#repeat-infringers): a strike is recorded on a
valid, unwithdrawn, un-reversed takedown; **three strikes** against one account, or one
deliberate and clear-cut infringement, terminates it. that threshold is only meaningful if
the record above actually exists, which is the whole reason §512(i) says "reasonably
implemented" rather than "adopted".

## 5. terminate an account

order matters, because `users.id` is referenced by `projects.created_by`, `invites.created_by`,
`invites.redeemed_by`, `replicas.user_id`, and `project_members.user_id`, and **none of those
cascade**. a bare `DELETE FROM users` fails on a foreign key.

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

**then delete the identity in supabase auth** (dashboard → authentication → users). skipping
this means they sign in again and `upsertUser` recreates the row on their first request, so
the termination undoes itself. even with it done, an access token already issued keeps
working until it expires: verification is a local jwks check in `apps/service/src/auth.ts`
with no revocation lookup ([gap g6](#capability-gaps)). project-scoped routes still fail,
because those hit `requireMembership` against the database on every request.

this same procedure is what answers a user's own deletion request under
[privacy.md](./privacy.md#deleting-your-data). it is the only account-deletion path there is.

## 6. issue the statement of reasons

required by dsa art. 17 for **every** restriction (content removal, project deletion,
account suspension or termination) whatever prompted it. email it to the address on the
account. contents are listed in
[dsa-contact.md](./dsa-contact.md#statement-of-reasons-article-17): what was restricted,
whether it is permanent, the facts relied on, the legal or contractual ground, and how to
appeal. state explicitly that no automated means were used, because none are.

for copyright specifically, also send the complainant's notice to the affected user and point
them at the [counter-notice procedure](./dmca.md#counter-notice). if a counter-notice arrives,
forward it to the complainant and hold restoration for **not less than 10 and not more than 14
business days** unless they file suit. diary the date; the window is statutory.

we do **not** submit statements of reasons to the commission's dsa transparency database:
art. 24(5) requires it, art. 19 exempts micro enterprises, and the exemption is relied on.

## 7. keep the record

keep everything in step 4 (notices, decisions, statements of reasons, dates) for **three
years** from the date of the action. reasons, in order of how much they matter:

- the repeat-infringer policy is worthless without a history to count strikes against.
- §512(f) misrepresentation claims and dsa appeals both look backwards.
- if crosscode ever crosses the micro-enterprise threshold, dsa art. 15 transparency
  reporting starts, and it is asked for the counts this record already holds.

note the asymmetry: the *content* is gone in ~7 days, but the *record about the content*
lives three years. that is intentional and worth keeping intentional: the record should hold
paths, hashes, and decisions, **not** copies of the file contents themselves.

---

## capability gaps

operations this runbook needs that the service cannot currently perform. written down rather
than designed around, because an honest gap list is what makes the procedure usable under
time pressure.

**g1: no admin surface at all.** the routes in `apps/service/src/http.ts` are health, the
three device-auth routes, create project, create invite, redeem invite, register replica, and
publish/list changes. there is no admin route, no `crosscode admin` subcommand, and no
moderation ui. every operation in this runbook is hand-written sql typed into a production
database console: no dry-run, no confirmation, no undo, and no audit trail of what the
operator did.

**g2: the takedown path runs on an elevated credential and is never exercised.** the runtime
role cannot delete from `file_versions` by design (`assertRuntimePrivileges`). correct
posture, but it means every deletion here needs the migration role, and nothing in ci or in
normal operation ever runs these statements. the first time they are used will be under a
legal deadline.

**g3: no way to disable one file without risking the room.** this is the significant one.
`listChanges` assumes retention only ever deletes a *prefix* of a room's sequence: it derives
`resyncFrom` from `min(sequence)` and answers `cursor-too-old` only when a cursor falls below
it. deleting a row from the *middle* produces a hole that is served as an ordinary page with
the row simply absent, so replicas never see that change and are never told to resynchronize.
worse, a later change may be a `patch` chained through the deleted version's `contentHash`
(`packages/protocol/src/sync.ts`), and that patch can no longer be applied. net effect: a
per-file takedown can silently corrupt a project for every member. **today the only safe
takedown granularity is the whole project.** fixing this properly means either a tombstone
(replace `version` with a redacted marker at the same sequence, preserving contiguity) or a
`resyncFrom` watermark the service can raise by hand.

**g4: nothing prevents re-publication.** there is no per-project or per-path blocklist.
delete the rows and the same daemon republishes the same file on its next settled edit. access
removal (project deletion or member removal) is the only durable stop, which is why step 3
prefers it.

**g5: no strike, suspension, or termination state in the database.** no column, no table, no
audit log. nothing records that an account was warned, struck, or terminated. the
repeat-infringer policy in `dmca.md` is therefore implemented entirely outside the system,
in whatever record step 4 is kept in.

**g6: termination is not immediate.** supabase access tokens are verified locally against
the jwks (`apps/service/src/auth.ts`) with no revocation check on the request path. a deleted
user's existing token stays valid until it expires; the access-token lifetime is set in the
supabase project, not in this repository. project-scoped routes do fail immediately, because
`requireMembership` reads the database on every request.

**g7: open websockets survive membership removal.** `subscribe()` in
`apps/service/src/ws.ts` calls `requireMembership` once during the handshake and never again.
a removed member with a live socket keeps receiving the room's broadcasts until the socket
drops or the service redeploys. there is no way to kick a connection.

**g8: account deletion is a multi-statement manual sequence with no cascade.** step 5 exists
only because `users` has no cascading deletes. it is easy to get wrong under pressure and it
is the same path that answers a user's privacy request, so it is not only a moderation
concern.

**g9: there is no retention job in this repository.** `docs/privacy.md` and
`docs/terms.md` both say change history is pruned after about seven days by a scheduled job.
`HISTORY_RETENTION_DAYS = 7` exists in `store.ts` and `file_versions_created_at_idx` exists to
support the sweep, but there is no `pg_cron` migration, no vercel cron entry
(`apps/docs-site/vercel.json` has none), and no github actions workflow that deletes from
`file_versions`, and the three workflows are `ci`, `smoke`, and `uptime`. either the job runs
somewhere outside version control, in which case it should be recorded here, or content is
being retained longer than the privacy page promises. **confirm this before telling any
notice-sender that content has aged out.**

<!-- LAWYER: G9 is the one with legal exposure beyond this runbook: docs/privacy.md makes a
     retention promise to users, and a promise a system does not keep is a
     misrepresentation question, not just a bug. Flag to whoever owns the privacy suite. -->

**g10: no trusted-flagger or authority-verification path.** dsa art. 22 trusted flaggers are
an online-platform obligation and do not apply here, but there is also no way to verify that
a message claiming to be from a member state authority is one. at this scale that is a
judgement call made by reading the email; it is listed so the absence is deliberate.

## before this is relied on

this runbook uses no placeholder tokens of its own. it does depend on things that are not
done yet:

- the dmca designated agent must be **registered**: see the checklist at the end of
  [dmca.md](./dmca.md#before-this-takes-effect). until then this procedure is good practice
  rather than a safe harbor.
- decide where the step 4 record lives, and write the location into this file.
- resolve **g9** (find the retention job or build it) before the first notice arrives.
