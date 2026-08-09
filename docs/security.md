# security model

crosscode moves uncommitted file contents between machines. three things carry that:
a per-checkout daemon, a coordination service, and the local clients that talk to the
daemon. this page is what defends each, and what does not.

## authentication

sign-in is **github oauth**, and there is no other path. members authenticate through the
website; the cli obtains the resulting session by a **device-code handshake** and stores it
mode-`0600` in `<git-dir>/crosscode/config.json`, preferring the os keychain for the refresh
token where one exists (macos `security`, linux `secret-tool`).

the cli asks the service for a pair of codes, prints a url and the short `userCode`, and
polls. the user signs in on the website and types the code, which binds it to their
session; the next poll returns the session. what that shape buys, and costs:

- **no listener on the machine.** there is no callback server, no ephemeral port, and no
  local endpoint another process on a shared machine could race, squat, or post into. that
  whole class of attack does not apply, which is the main reason the flow is shaped this
  way.
- **two codes, deliberately unequal.** `deviceCode` is the cli's bearer secret and is never
  displayed; the service stores only a hash of it. `userCode` is the part a human reads
  aloud and types, and on its own it authorises nothing: it names a pending request that
  still has to be bound by someone who has signed in to github.
- **short-lived and single-use.** the pair expires in about fifteen minutes and is consumed
  on the first successful poll, so a code read over a shoulder or left in scrollback is not
  a durable credential.
- **the poll route is the exposed one.** it is the only route reachable without a session,
  so it is rate-limited; an unbounded poll is an offline guessing oracle for `deviceCode`.
- **the residual risk is social.** a device flow's real weakness is that a user can be
  talked into signing in and entering a code an attacker generated. nothing in the protocol
  prevents that. the `/device` page's job is to state plainly what the code will authorise,
  and a code the user did not personally start is one to refuse.
- tokens are never printed, in `--json` mode or out of it, so they stay out of terminal
  scrollback, ci logs, and agent transcripts. there is no `CROSSCODE_TOKEN` to set or leak.

the service verifies supabase access tokens against jwks and takes the github identity from
the verified claims, never from anything the client asserts. device sign-in only produces
such a token; it does not widen what one means.

every service request re-derives project membership server-side for the authenticated user
rather than trusting a scope in the token, so a removed member loses access on their next
request instead of when a token expires.

## invite redemption

an invite code is a bearer secret, so the interesting check is the one after it:
**redemption verifies through github that the redeeming account actually has access to the
repository.** a valid code from someone with no repo access is refused. this is the reason
identity is github-only.

codes are stored hashed, single-use, and expiring. unknown, expired, and already-consumed
codes are answered identically so the endpoint is not an oracle, and redemption is
rate-limited by ip.

## the daemon's local api

the daemon binds loopback only and writes a mode-`0600` connection descriptor
(`<git-dir>/crosscode/daemon.json`) holding its port and a random secret. every local
request carries that secret as a bearer token. clients refuse a descriptor whose permissions
are wider than owner-only or which is owned by another user, so a shared machine cannot hand
one user's descriptor to another.

the mcp server and the pre-edit hook hold no state and no credentials of their own; they
read that descriptor and forward.

the daemon ↔ filesystem boundary is fully trusted. the daemon reads and writes the checkout
it manages, with no sandbox between the two.

## what is never sent

enforced before a change is captured, not filtered afterwards:

- **untracked files.** only files git tracks are eligible.
- **a hard secret denylist**, even when tracked: environment files (`.env*`, `.envrc`,
  `.npmrc`, `.netrc`, `.pgpass`, `.htpasswd`); the `.aws/`, `.ssh/`, `.kube/` and `.gnupg/`
  directories; ssh keys (`id_rsa` and friends); keys and keystores by extension (`.pem`,
  `.key`, `.p8`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ovpn`, `.gpg`, `.asc`);
  credentials by name (`credentials`, `secrets`, `*-credentials.*`,
  `*service-account*.json`, `kubeconfig`); and terraform `*.tfvars`/`*.tfstate`. the list
  is one array of patterns in `packages/core/src/index.ts` and nowhere else. real-time
  syncing an `.env` would be a serious incident, so this check is the earliest one in the
  pipeline.
- **anything outside the working tree.** symlinks that leave the checkout are refused.

## integrity on receive

the receiver verifies every change before applying it: the content must hash to the
`contentHash` on the wire, and the merge base must resolve to the `baseHash` the sender
recorded. a change that fails either is not applied.

that check has to be the receiver's rather than the service's. a service willing to
substitute content would substitute the hash beside it, so a server-side check is a
garbage-in filter and nothing more.

## encryption

tls in transit. at rest, the data sits in supabase postgres and on vercel, encrypted by
those providers under keys they hold; crosscode adds no encryption layer of its own.
**there is no end-to-end encryption**, no device pairing, and no key exchange. the service can read the file contents
it stores; [privacy.md](./privacy.md) says so in the same words.

we built e2e once and removed it. it bought a real property and cost a device-pairing
ceremony, a keyring, epochs, rotation, and recovery paths, for a product whose durable
artifact is a git repository the user already has. the honest trade for this product is
fewer moving parts and a plain statement of what we hold.

## service ↔ database

row level security is on from the first migration. the service connects with a
least-privilege role that cannot rewrite history: `file_versions` has no update or delete
policy at all, so no request-handling path can erase or alter a change. any retention sweep
runs as the owner on a separate connection, never through the runtime role.

## what a malicious member can do

given a valid session and project membership:

- publish changes to files in that project and read the changes other members publish. that
  is the product; a member of a project is someone you have given your working tree to.
- see presence for the project: branch and recently touched paths.

what they cannot do:

- reach another project. every read and write is scoped to a project the caller belongs to,
  and there is no cross-project query path.
- impersonate another member or replica. ingest checks that the change's `replicaId` belongs
  to the authenticated user.
- write outside the working tree, or touch commits, branches, or remotes on a receiving
  machine. the receiver applies working-tree file writes only, under the rules in
  [architecture.md](./architecture.md).
- force a write onto a file someone is actively editing. hot-file deferral holds it.

## threat model, stated plainly

holds against: an attacker on the network (tls); another local user on a shared machine
(loopback binding, `0600` descriptors and config); a member removed from a project (access
ends on their next request); a service that corrupts stored content (receiver-side hash
verification); an invite forwarded to someone without repo access (github check).

does **not** hold against: a compromised member device, which holds the checkout and the
session; a member who leaves with what they already synced; anyone with production access to
our service, who can read stored file contents; traffic analysis of when you work and how
large your changes are.

report vulnerabilities per [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md),
never in a public issue.

## breach response runbook

crosscode stores plaintext customer source code. a breach here is severe by definition:
there is no "only metadata was exposed" outcome available. assume the worst category until
the evidence rules it out.

the gdpr clock is **72 hours** to notify a supervisory authority, and crosscode's
[dpa](./dpa.md) promises controllers notice within **48 hours**. both clocks start at
*awareness*, not at containment.

**who decides: the project owner.** one person, named in the
[privacy policy](./privacy-policy.md), owns every call below: severity, notification,
disclosure. there is no committee to convene and no escalation path. if the owner is
unreachable, the breach waits, which is a real risk of a one-person project and is stated
rather than papered over.

### 1. detection

where a breach realistically surfaces:

- **sentry**: a spike in 5xx, an unfamiliar error type, or auth errors from a route that
  should not produce them.
- **the uptime workflow** (`.github/workflows/uptime.yml`): opens a github issue on two
  consecutive failed probes. an outage is not a breach, but they arrive together often
  enough that this is a trigger to look.
- **a user or researcher emailing `security@getcrosscode.dev`**, per
  [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md). this is
  the most likely source. treat it as credible until disproven.
- **vercel or supabase telling you**: a provider security notice, or an unrecognised login
  to either dashboard.
- **anomalies you notice yourself**: unexpected rows in `device_codes`, invites redeemed by
  accounts you do not recognise, egress or database size that does not match usage.

**awareness starts** when you have a reasonable degree of certainty that a security
incident occurred and it involved personal data. not when you finish investigating. write
the timestamp down the moment you reach it, because the 72 hours is measured from there and you
will be asked to evidence it.

### 2. first 60 minutes: contain, then preserve

in this order:

1. **stop the bleeding.** rotate what is exposed: supabase service role key and database
   password, `SENTRY_DSN`, `POSTHOG_KEY`, and any github oauth app secret. if a deployment
   is the cause, promote the last known good one from the vercel dashboard. a promotion
   takes seconds and a diagnosis does not.
2. **do not delete anything.** not logs, not rows, not the bad deployment. evidence first;
   see step 3.
3. **revoke sessions** if account takeover is plausible: supabase auth, sign out all users
   on the affected accounts.
4. **write down the clock**: when it started, and how you know.

### 3. preserve evidence

before anything ages out. vercel and supabase log retention is days, not months, so this is
genuinely urgent:

- export vercel function logs for the window (**vercel → project → logs**, filter and
  export).
- export supabase postgres logs and the auth audit log for the window.
- export the sentry issues involved, including the full event json, not just the title.
- snapshot the database if data was modified: supabase's dashboard can take one on demand.
- note the deployment sha in production at the time (`VERCEL_GIT_COMMIT_SHA`).
- keep the original report email intact, headers included.

put all of it in one dated folder outside the repository. do not commit evidence containing
personal data to a public repo.

### 4. assess severity

| level | what it means | examples |
| --- | --- | --- |
| **p1, file contents exposed** | someone who should not have been able to read stored file contents did, or plausibly could have | database credential leak, rls bypass, a route serving another project's changes, backup left readable |
| **p2, account or auth compromise** | identity or session data exposed, without confirmed content access | device-code or session token leak, oauth secret exposure, account takeover |
| **p3, metadata exposure** | records about accounts and projects, no file contents | email addresses, github logins, `owner/repo` names, project membership |
| **p4, no personal data** | a security issue with no personal data involved | a vulnerability reported and fixed before exploitation, with logs showing no access |

**p1 and p2 are notifiable.** p3 usually is, because repository names alone can be commercially
sensitive, and the honest reading is that `owner/repo` plus membership tells an attacker who
works on what. p4 is not notifiable, but write it up anyway.

the three questions that decide it: *was personal data involved? could someone unauthorised
have accessed it? is there a risk to those people's rights and freedoms?* if you cannot
answer the second one "no" with evidence, treat it as yes.

### 5. notify

**supervisory authority: within 72 hours of awareness.** late is better than never: a late
notification must explain the delay, so file within the window even if the picture is
incomplete. art. 33(4) explicitly allows notifying in phases.

```text
Subject: Personal data breach notification, Crosscode

1. Nature of the breach
   What happened, in two sentences. When it started, when it was discovered, whether it is
   contained now.

2. Categories and approximate number of data subjects
   Account holders affected: N.
   Third parties whose personal data was inside the affected repositories: unknown.
   Crosscode does not inspect file contents and cannot enumerate them. See the privacy
   policy, §3.3.

3. Categories and approximate number of records
   Which of: file contents and paths; account records (email, GitHub identity);
   authentication records; project and membership records; analytics or error reports.
   Number of file versions, projects and accounts, as best established.

4. Likely consequences
   For a P1: source code, and any personal data inside it, was readable by an unauthorised
   party. Downstream risk to the affected users' own customers, which those users must
   assess as controllers.

5. Measures taken and proposed
   Containment already done, credentials rotated, fix deployed, notifications sent, changes
   to prevent recurrence.

6. Contact
   {{PROVIDER_NAME}}, privacy@getcrosscode.dev

7. What is not yet known
   State it explicitly, with the date by which you expect to know.
```

**affected users: without undue delay, where there is high risk to their rights and
freedoms.** for a p1, assume there is. send from `security@getcrosscode.dev`:

```text
Subject: Security incident affecting your Crosscode data, action needed

What happened
  On <date> <one sentence: what an unauthorised party was able to do>. We discovered it on
  <date> at <time UTC>.

What of yours was involved
  <Specific to this user: which projects, which repositories, whether file contents were
  readable, whether their email address or GitHub identity was exposed.>

What this means for you
  Crosscode stores the contents of files you synced. Treat any secret that was in a tracked
  file in <repos> as exposed, and rotate it. Untracked files never left your machine, and
  .env files and key material are on a hard denylist and were never stored.

  If those repositories contain other people's personal data (names in fixtures, customer
  records in seed data) you are the controller for it and may have your own notification
  obligation. Our data processing agreement is at /docs/dpa.html.

What we have done
  <Containment, rotation, fix, deployment.> The service is <state> as of <time UTC>.

What we are asking you to do
  1. Rotate any credential that was in a tracked file in the affected repositories.
  2. Review <repo> for personal data you may need to notify people about.
  3. <Anything user-specific: re-authenticate, revoke a token.>

We are sorry. Questions to security@getcrosscode.dev; we will answer every one.

{{PROVIDER_NAME}}, Crosscode
```

do not minimise, do not lead with what was *not* affected, and do not say "out of an
abundance of caution" about something you know happened. the candour in
[privacy.md](./privacy.md) is a legal asset only if it survives contact with a bad day.

**also notify:** any affected user's own supervisory authority is *their* call, not yours.
give them what they need and say so explicitly.

### 6. post-mortem

within 10 working days, in the repository under `docs/incidents/`, public unless
publishing would expose an unfixed vulnerability or another user's data:

- timeline in utc: first exposure, first evidence, awareness, containment, notification,
  resolution.
- root cause. not "human error": the change that made it possible, and why review did not
  catch it.
- what detection missed, and what would have caught it sooner.
- fixes landed, with commit shas.
- what is deliberately *not* being fixed, and why.

keep the art. 33(5) internal record for every breach including the ones you decide are not
notifiable: the facts, the effects, and the remedial action. the regulator can ask for it,
and "we assessed it and decided not to notify" is only a defence if the assessment was
written down at the time.

### 7. what this runbook does not have

- **no on-call rotation.** one person, best effort. a breach discovered at 03:00 on a
  saturday is handled when the owner wakes up.
- **no forensic retainer, no incident response firm, no cyber insurance.** deferred at this
  scale, and a deliberate accepted risk rather than an oversight.
- **no pre-signed regulator contact.** the competent authority follows from
  `{{JURISDICTION}}`, which is not yet chosen. choosing it is on the pre-launch checklist
  precisely so this step is not being worked out during an incident.

<!-- LAWYER: whether Crosscode is a controller or a processor changes who notifies the
     authority and when. For account data it is the controller (72 hours, direct). For data
     inside users' files it is a processor (notify the controller, no direct authority
     obligation). A single breach will usually be both at once, which is why this runbook
     notifies on both tracks. Confirm that reading. -->

### before this takes effect

- `{{PROVIDER_NAME}}`: in the notification templates in §5
- `{{JURISDICTION}}`: in §7, which determines the competent supervisory authority
