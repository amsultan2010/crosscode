# Security model

Crosscode moves uncommitted file contents between machines. Three things carry that:
a per-checkout daemon, a coordination service, and the local clients that talk to the
daemon. This page is what defends each, and what does not.

## Authentication

Sign-in is **GitHub OAuth**, and there is no other path. Members authenticate through the
website; the CLI obtains the resulting session by a **device-code handshake** and stores it
mode-`0600` in `<git-dir>/crosscode/config.json`, preferring the OS keychain for the refresh
token where one exists (macOS `security`, Linux `secret-tool`).

The CLI asks the service for a pair of codes, prints a URL and the short `userCode`, and
polls. The user signs in on the website and types the code, which binds it to their
session; the next poll returns the session. What that shape buys, and costs:

- **No listener on the machine.** There is no callback server, no ephemeral port, and no
  local endpoint another process on a shared machine could race, squat, or POST into. That
  whole class of attack does not apply, which is the main reason the flow is shaped this
  way.
- **Two codes, deliberately unequal.** `deviceCode` is the CLI's bearer secret and is never
  displayed; the service stores only a hash of it. `userCode` is the part a human reads
  aloud and types, and on its own it authorises nothing: it names a pending request that
  still has to be bound by someone who has signed in to GitHub.
- **Short-lived and single-use.** The pair expires in about fifteen minutes and is consumed
  on the first successful poll, so a code read over a shoulder or left in scrollback is not
  a durable credential.
- **The poll route is the exposed one.** It is the only route reachable without a session,
  so it is rate-limited; an unbounded poll is an offline guessing oracle for `deviceCode`.
- **The residual risk is social.** A device flow's real weakness is that a user can be
  talked into signing in and entering a code an attacker generated. Nothing in the protocol
  prevents that. The `/device` page's job is to state plainly what the code will authorise,
  and a code the user did not personally start is one to refuse.
- Tokens are never printed, in `--json` mode or out of it, so they stay out of terminal
  scrollback, CI logs, and agent transcripts. There is no `CROSSCODE_TOKEN` to set or leak.

The service verifies Supabase access tokens against JWKS and takes the GitHub identity from
the verified claims, never from anything the client asserts. Device sign-in only produces
such a token; it does not widen what one means.

Every service request re-derives project membership server-side for the authenticated user
rather than trusting a scope in the token, so a removed member loses access on their next
request instead of when a token expires.

## Invite redemption

An invite code is a bearer secret, so the interesting check is the one after it:
**redemption verifies through GitHub that the redeeming account actually has access to the
repository.** A valid code from someone with no repo access is refused. This is the reason
identity is GitHub-only.

Codes are stored hashed, single-use, and expiring. Unknown, expired, and already-consumed
codes are answered identically so the endpoint is not an oracle, and redemption is
rate-limited by IP.

## The daemon's local API

The daemon binds loopback only and writes a mode-`0600` connection descriptor
(`<git-dir>/crosscode/daemon.json`) holding its port and a random secret. Every local
request carries that secret as a bearer token. Clients refuse a descriptor whose permissions
are wider than owner-only or which is owned by another user, so a shared machine cannot hand
one user's descriptor to another.

The MCP server and the pre-edit hook hold no state and no credentials of their own; they
read that descriptor and forward.

The daemon ↔ filesystem boundary is fully trusted. The daemon reads and writes the checkout
it manages, with no sandbox between the two.

## What is never sent

Enforced before a change is captured, not filtered afterwards:

- **Untracked files.** Only files Git tracks are eligible.
- **A hard secret denylist**, even when tracked: environment files (`.env*`, `.envrc`,
  `.npmrc`, `.netrc`, `.pgpass`, `.htpasswd`); the `.aws/`, `.ssh/`, `.kube/` and `.gnupg/`
  directories; SSH keys (`id_rsa` and friends); keys and keystores by extension (`.pem`,
  `.key`, `.p8`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ovpn`, `.gpg`, `.asc`);
  credentials by name (`credentials`, `secrets`, `*-credentials.*`,
  `*service-account*.json`, `kubeconfig`); and Terraform `*.tfvars`/`*.tfstate`. The list
  is one array of patterns in `packages/core/src/index.ts` and nowhere else. Real-time
  syncing an `.env` would be a serious incident, so this check is the earliest one in the
  pipeline.
- **Anything outside the working tree.** Symlinks that leave the checkout are refused.

## Integrity on receive

The receiver verifies every change before applying it: the content must hash to the
`contentHash` on the wire, and the merge base must resolve to the `baseHash` the sender
recorded. A change that fails either is not applied.

That check has to be the receiver's rather than the service's. A service willing to
substitute content would substitute the hash beside it, so a server-side check is a
garbage-in filter and nothing more.

## Encryption

TLS in transit. At rest, the data sits in Supabase Postgres and on Vercel, encrypted by
those providers under keys they hold; Crosscode adds no encryption layer of its own.
**There is no end-to-end encryption**, no device pairing, and no key exchange. The service can read the file contents
it stores; [privacy.md](./privacy.md) says so in the same words.

We built E2E once and removed it. It bought a real property and cost a device-pairing
ceremony, a keyring, epochs, rotation, and recovery paths, for a product whose durable
artifact is a Git repository the user already has. The honest trade for this product is
fewer moving parts and a plain statement of what we hold.

## Service ↔ database

Row Level Security is on from the first migration. The service connects with a
least-privilege role that cannot rewrite history: `file_versions` has no UPDATE or DELETE
policy at all, so no request-handling path can erase or alter a change. Any retention sweep
runs as the owner on a separate connection, never through the runtime role.

## What a malicious member can do

Given a valid session and project membership:

- Publish changes to files in that project and read the changes other members publish. That
  is the product; a member of a project is someone you have given your working tree to.
- See presence for the project: branch and recently touched paths.

What they cannot do:

- Reach another project. Every read and write is scoped to a project the caller belongs to,
  and there is no cross-project query path.
- Impersonate another member or replica. Ingest checks that the change's `replicaId` belongs
  to the authenticated user.
- Write outside the working tree, or touch commits, branches, or remotes on a receiving
  machine. The receiver applies working-tree file writes only, under the rules in
  [architecture.md](./architecture.md).
- Force a write onto a file someone is actively editing. Hot-file deferral holds it.

## Threat model, stated plainly

Holds against: an attacker on the network (TLS); another local user on a shared machine
(loopback binding, `0600` descriptors and config); a member removed from a project (access
ends on their next request); a service that corrupts stored content (receiver-side hash
verification); an invite forwarded to someone without repo access (GitHub check).

Does **not** hold against: a compromised member device, which holds the checkout and the
session; a member who leaves with what they already synced; anyone with production access to
our service, who can read stored file contents; traffic analysis of when you work and how
large your changes are.

Report vulnerabilities per [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md),
never in a public issue.

## Breach response runbook

Crosscode stores plaintext customer source code. A breach here is severe by definition:
there is no "only metadata was exposed" outcome available. Assume the worst category until
the evidence rules it out.

The GDPR clock is **72 hours** to notify a supervisory authority, and Crosscode's
[DPA](./dpa.md) promises controllers notice within **48 hours**. Both clocks start at
*awareness*, not at containment.

**Who decides: the project owner.** One person, named in the
[privacy policy](./privacy-policy.md), owns every call below: severity, notification,
disclosure. There is no committee to convene and no escalation path. If the owner is
unreachable, the breach waits, which is a real risk of a one-person project and is stated
rather than papered over.

### 1. Detection

Where a breach realistically surfaces:

- **Sentry**: a spike in 5xx, an unfamiliar error type, or auth errors from a route that
  should not produce them.
- **The uptime workflow** (`.github/workflows/uptime.yml`): opens a GitHub issue on two
  consecutive failed probes. An outage is not a breach, but they arrive together often
  enough that this is a trigger to look.
- **A user or researcher emailing `security@getcrosscode.dev`**, per
  [SECURITY.md](https://github.com/amsultan2010/crosscode/blob/main/SECURITY.md). This is
  the most likely source. Treat it as credible until disproven.
- **Vercel or Supabase telling you**: a provider security notice, or an unrecognised login
  to either dashboard.
- **Anomalies you notice yourself**: unexpected rows in `device_codes`, invites redeemed by
  accounts you do not recognise, egress or database size that does not match usage.

**Awareness starts** when you have a reasonable degree of certainty that a security
incident occurred and it involved personal data. Not when you finish investigating. Write
the timestamp down the moment you reach it, because the 72 hours is measured from there and you
will be asked to evidence it.

### 2. First 60 minutes: contain, then preserve

In this order:

1. **Stop the bleeding.** Rotate what is exposed: Supabase service role key and database
   password, `SENTRY_DSN`, `POSTHOG_KEY`, and any GitHub OAuth app secret. If a deployment
   is the cause, promote the last known good one from the Vercel dashboard. A promotion
   takes seconds and a diagnosis does not.
2. **Do not delete anything.** Not logs, not rows, not the bad deployment. Evidence first;
   see step 3.
3. **Revoke sessions** if account takeover is plausible: Supabase Auth, sign out all users
   on the affected accounts.
4. **Write down the clock**: when it started, and how you know.

### 3. Preserve evidence

Before anything ages out. Vercel and Supabase log retention is days, not months, so this is
genuinely urgent:

- Export Vercel function logs for the window (**Vercel → project → Logs**, filter and
  export).
- Export Supabase Postgres logs and the auth audit log for the window.
- Export the Sentry issues involved, including the full event JSON, not just the title.
- Snapshot the database if data was modified: Supabase's dashboard can take one on demand.
- Note the deployment SHA in production at the time (`VERCEL_GIT_COMMIT_SHA`).
- Keep the original report email intact, headers included.

Put all of it in one dated folder outside the repository. Do not commit evidence containing
personal data to a public repo.

### 4. Assess severity

| Level | What it means | Examples |
| --- | --- | --- |
| **P1, file contents exposed** | Someone who should not have been able to read stored file contents did, or plausibly could have | Database credential leak, RLS bypass, a route serving another project's changes, backup left readable |
| **P2, account or auth compromise** | Identity or session data exposed, without confirmed content access | Device-code or session token leak, OAuth secret exposure, account takeover |
| **P3, metadata exposure** | Records about accounts and projects, no file contents | Email addresses, GitHub logins, `owner/repo` names, project membership |
| **P4, no personal data** | A security issue with no personal data involved | A vulnerability reported and fixed before exploitation, with logs showing no access |

**P1 and P2 are notifiable.** P3 usually is, because repository names alone can be commercially
sensitive, and the honest reading is that `owner/repo` plus membership tells an attacker who
works on what. P4 is not notifiable, but write it up anyway.

The three questions that decide it: *Was personal data involved? Could someone unauthorised
have accessed it? Is there a risk to those people's rights and freedoms?* If you cannot
answer the second one "no" with evidence, treat it as yes.

### 5. Notify

**Supervisory authority: within 72 hours of awareness.** Late is better than never: a late
notification must explain the delay, so file within the window even if the picture is
incomplete. Art. 33(4) explicitly allows notifying in phases.

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

**Affected users: without undue delay, where there is high risk to their rights and
freedoms.** For a P1, assume there is. Send from `security@getcrosscode.dev`:

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

Do not minimise, do not lead with what was *not* affected, and do not say "out of an
abundance of caution" about something you know happened. The candour in
[privacy.md](./privacy.md) is a legal asset only if it survives contact with a bad day.

**Also notify:** any affected user's own supervisory authority is *their* call, not yours.
Give them what they need and say so explicitly.

### 6. Post-mortem

Within 10 working days, in the repository under `docs/incidents/`, public unless
publishing would expose an unfixed vulnerability or another user's data:

- Timeline in UTC: first exposure, first evidence, awareness, containment, notification,
  resolution.
- Root cause. Not "human error": the change that made it possible, and why review did not
  catch it.
- What detection missed, and what would have caught it sooner.
- Fixes landed, with commit SHAs.
- What is deliberately *not* being fixed, and why.

Keep the Art. 33(5) internal record for every breach including the ones you decide are not
notifiable: the facts, the effects, and the remedial action. The regulator can ask for it,
and "we assessed it and decided not to notify" is only a defence if the assessment was
written down at the time.

### 7. What this runbook does not have

- **No on-call rotation.** One person, best effort. A breach discovered at 03:00 on a
  Saturday is handled when the owner wakes up.
- **No forensic retainer, no incident response firm, no cyber insurance.** Deferred at this
  scale, and a deliberate accepted risk rather than an oversight.
- **No pre-signed regulator contact.** The competent authority follows from
  `{{JURISDICTION}}`, which is not yet chosen. Choosing it is on the pre-launch checklist
  precisely so this step is not being worked out during an incident.

<!-- LAWYER: whether Crosscode is a controller or a processor changes who notifies the
     authority and when. For account data it is the controller (72 hours, direct). For data
     inside users' files it is a processor (notify the controller, no direct authority
     obligation). A single breach will usually be both at once, which is why this runbook
     notifies on both tracks. Confirm that reading. -->

### Before this takes effect

- `{{PROVIDER_NAME}}`: in the notification templates in §5
- `{{JURISDICTION}}`: in §7, which determines the competent supervisory authority
