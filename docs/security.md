# Security model

## Authentication

Workspace members authenticate directly against Supabase Auth, either through
`crosscode login` (loopback browser callback) or `crosscode login
--email/--password` (headless). The daemon stores the resulting Supabase
session (short-lived access token plus a longer-lived refresh token) rather
than a Crosscode-issued credential. The coordination service verifies each
request's access token against Supabase's own signing key
(`verifySupabaseAccessToken`, `apps/service/src/auth.ts`). Supabase signs
access tokens with an asymmetric key (ES256 by default), fetched and cached
from `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, not a shared secret, so
there is nothing equivalent to `CROSSCODE_JWT_SECRET` to configure or leak.
`SUPABASE_URL` is still used to check the expected token issuer
(`<SUPABASE_URL>/auth/v1`) and the `authenticated` audience. Claims
(`SupabaseAccessClaims`):

```ts
{
  userId: string;             // JWT subject; Supabase auth.users id
  email: string | undefined;
  expiresAt: string;
}
```

A Supabase access token carries only the member's `auth.users` id, not a
workspace, replica, or role scope the way Crosscode's own previously-issued
tokens did. Every authenticated request must therefore also carry an
`x-crosscode-workspace-id` header naming the workspace it targets
(`apps/service/src/http.ts`); the service then re-derives role and membership
server-side for that `(userId, workspaceId)` pair on every request
(`resolveMembership`), so a disabled member loses access immediately rather
than waiting for its token to expire. POST bodies also carry their own
`event.workspaceId`, which is checked against the header for a redundant
principal-binding match.

## Sign-in threat model

The browser sign-in path exists so a human does not have to type a password
into a terminal. It moves a live Supabase session from a web page into a local
process, which is exactly the shape that OAuth loopback redirects have to get
right, so the same defenses apply.

- **Loopback-only binding.** The callback server binds `127.0.0.1` on an
  ephemeral port, never `0.0.0.0` and never a fixed port. Nothing off the machine
  can reach it, and nothing can squat the port in advance.
- **The `state` parameter.** The CLI generates a 32-character random `state`,
  puts it in the URL it opens, and requires the callback body to echo it back.
  A callback with a missing or mismatched `state` is rejected with
  `LOGIN_STATE_MISMATCH` and the session is discarded. This is what stops
  another local process (or a stray browser tab, or a page the user was
  tricked into opening) from POSTing an attacker-chosen session into a CLI
  that happens to be waiting.
- **Bounded lifetime.** The server accepts exactly one callback and shuts down;
  if none arrives within 300 seconds the command fails with `LOGIN_TIMEOUT`
  rather than leaving a listener open. The permissive CORS headers on
  `/callback` (`Access-Control-Allow-Origin: *`) exist only so the site's fetch
  succeeds. They widen who may *send* to the endpoint, which is why `state` and
  not origin is the thing being trusted.
- **Tokens are never printed.** Neither the access token nor the refresh token
  is written to stdout, in `--json` mode or out of it. `crosscode login --json`
  emits only `{"value":{"userId":"…","email":"…"}}`. This keeps credentials out
  of terminal scrollback, CI logs, and any agent transcript that captures
  command output. For the same reason there is no `CROSSCODE_TOKEN`
  environment variable to set or leak.
- **The session lands in a mode-`0600` file.** Both login paths persist through
  the same daemon config writer to `<git-dir>/crosscode/config.json`, owner
  read/write only, outside versioned files. The refresh token prefers the OS
  keychain where one exists (see below). The browser path introduces no
  new storage location and no new credential type.
- **Headless is not a downgrade path.** `--email/--password` signs in against
  Supabase directly with no loopback server and no `state` involved, so agents
  and CI never exercise the browser surface at all.

## Revocation

Three credentials can be taken away, and none of them requires waiting for an expiry:

- **A member.** `crosscode members remove <memberId>` (`DELETE /v1/members/:id`, owner
  only) sets `members.disabled_at`. Every authorization path already filters on it
  (`resolveMembership`, `resolveWorkspaceToken`, `assertReplicaOwnership`), so access
  ends on the next request. The row is disabled rather than deleted because operations,
  validations, and audit events reference it and history has to stay attributable. The
  same transaction retires their replicas and revokes their workspace tokens, so removing
  someone does not leave their machines still ingesting. A workspace always keeps at least
  one owner, and an owner cannot remove themselves.
- **A paired device.** `crosscode devices revoke <tokenId>`
  (`DELETE /v1/workspace-tokens/:id`, owner only) sets `workspace_tokens.revoked_at` and
  disables the associated replica. `ccw_` tokens never expire and are not
  self-describing. They are opaque random bytes resolved against the database on every
  request, which is what makes immediate revocation possible.
- **A Supabase session.** `crosscode logout` clears this checkout's session (and any
  `ccw_` token) from the config file and the OS keychain, and signs out of Supabase.

Both server-side revocations are refused to a `ccw_` token
(`assertSupabaseCredential`): team management stays behind a real Supabase session, so a
leaked terminal-side credential cannot revoke its peers or remove the owner who would
revoke it. Both are audited (`member.removed`, `workspace_token.revoked`).

## End-to-end encryption

Every file payload Crosscode syncs is encrypted on the sending device with a key the
coordination service has never held. The hosted service at `www.getcrosscode.dev` stores
ciphertext in `operations.event`, the single home of file content since migration 013, and
cannot read it: not with a database dump, not with a subpoena, not with an engineer at a
console.

The scope is the file payload. Tasks, claims, handoffs, published intents, and validation
results are stored in the clear, and [What the server can and cannot
see](#what-the-server-can-and-cannot-see) lists exactly which fields those are.

This section is the reasoning as well as the mechanism. If any of it stops being true, the
claim on the landing page has to come down with it.

### Why full end-to-end, and not encryption at rest

The obvious cheaper option is a per-workspace key that *we* hold, applied at rest. It is
worth naming what that would and would not buy, because it is the default most products
pick.

Encryption at rest under a key we hold defends against exactly one thing: someone
obtaining the storage without also obtaining the service. It does nothing about a
compromised service process, a malicious or coerced insider, a subpoena, or a
misconfigured internal tool. In all of those the key is right there next to the data. For
a coordination service the accurate summary would be "we can read your code, but we promise
to be careful," which is the sentence a developer evaluating a tool for their employer's
private repository is trying to avoid hearing.

Full end-to-end was affordable here for one structural reason: **the service never
inspected file content in the first place.** Conflict classification, diffing, dependency
analysis, three-way merges, and AI review all run client-side in `apps/daemon` and
`packages/core`. The service is a store-and-forward relay that assigns sequence numbers
and fans messages out. The only place it ever touched content was the integrity check at
`apps/service/src/http.ts`, discussed below, and that check was never load-bearing.

So encryption costs the service no capability it was using. That will not stay true for
free: any future server-side feature that needs to read content (search across a
workspace, server-rendered diffs, a web review UI) would have to break this, and the
answer is that it does not get built server-side. That is the trade.

### What the server can and cannot see

Encrypted, under a key we do not have:

- File contents (`afterContent`), unified patches, and the base snapshot.
- **File paths.** A path is as sensitive as content, since
  `src/billing/stripe-webhook-v2.ts` tells you a great deal on its own, so paths are
  inside the ciphertext rather than beside it.
- Content hashes (`beforeHash`, `afterHash`, `base.files[].contentHash`). A SHA-256 of a
  file is a confirmation oracle: anyone holding a candidate file can check whether you
  have it. Leaving hashes in the clear would have quietly undone much of the encryption.
- The natural-language `intent` describing what the change was for.

In the clear, and therefore visible to us:

- Workspace, member, replica, and project ids, and `actor_id`, normally an email address.
  Multi-tenant authorization is done on these; they cannot be encrypted.
- **`repoRemote`**, the normalized git remote, for example `github.com/acme/secret-project`.
  Projects are keyed on it (Contract B), so it is stored as-is. If a repository's *name*
  is itself confidential, self-host.
- Timestamps, sequence numbers, and the number of files an operation touches.
- Ciphertext length, which bounds the plaintext size. A large commit looks like a large
  commit.
- The change kind per file (`add`/`modify`/`delete`/`rename`).
- Task titles, claim targets, published intent text, handoff notes, and validation output
  are **not yet sealed**. Task titles and claim targets do contain paths and descriptions
  of what someone is working on. This is a real gap, it is not covered by the claim above,
  and the privacy page states it rather than omitting it. The envelope built here is
  reusable for them.

Per-file rows still exist server-side, keyed by a `pathToken` instead of a path:
`HMAC-SHA256(pathKey, transactionId || "\0" || path)`. The transaction id is mixed in so
the *same* file in two operations produces two unrelated tokens. Without that, the service
could build a per-file change history without decrypting anything. The service keeps only
what it used the column for: "an operation may change each path at most once."

### What replaces the server-side hash check

`http.ts` used to verify `afterHash === contentHash(afterContent)` on every ingested
change. With ciphertext there is no plaintext to hash, so the check is gone for sealed
operations. It should be, and its removal loses nothing:

**That check never protected a receiving client.** It ran on our server, on data our
server could rewrite. A service willing to substitute `afterContent` would substitute
`afterHash` to match, and the check would pass. It was only ever a garbage-in filter that
caught a *client* miscomputing its own hash. That is useful, but it is not evidence of
anything to anyone downstream.

The check that always mattered is the receiver's. `assertChangeIntegrity`
(`apps/daemon/src/index.ts`) re-verifies every downloaded change before anything is
applied, and did so before this work existed, because the server's word was never
sufficient. Encryption *upgrades* that check rather than removing it:

- The payload is sealed with **AES-256-GCM**. Opening it verifies an authentication tag
  computed under a key the service has never held. A modified byte does not decrypt.
- The workspace id, the sending replica id, and the operation id are bound in as
  **additional authenticated data**, so a sealed payload cannot be moved to another
  workspace, re-attributed to a different replica, or spliced onto another operation.
- The clear-text `changes` array is outside the ciphertext, because the service needs a
  row per file. So the receiver recomputes every `pathToken` from the decrypted paths and
  compares, so a dropped, duplicated, reordered, or relabelled row is caught.
- The original plaintext hash check still runs afterwards, unchanged.

Net: integrity moves from *a hash the server could forge* to *an AEAD tag the server
cannot*. The structural checks that never needed plaintext still run server-side: one
change per path, principal binding, replica ownership, and role gates.

The same reasoning applies to `redactPath`, which refused to relay `.env` and friends.
That also only ever caught a well-meaning client; a malicious one renames the file. It now
runs client-side before capture and again before sealing, which is the only place a real
path is visible anyway.

### Where the key lives, and how it reaches a second device

A workspace key is 32 random bytes generated on a member's machine. From it, HKDF derives
a content key (AES-256-GCM) and a path key (HMAC). Keys are **epoched**: a keyring holds
every epoch it has been given, so history stays readable across rotations.

Storage is the same shape the Supabase refresh token already uses: the OS keychain when
one exists (macOS `security`, Linux `secret-tool`), otherwise a mode-`0600` file at
`<git-dir>/crosscode/keyring.json`, never committed. Because macOS silently truncates a
keychain secret written through stdin at 128 bytes, the keychain holds a small wrapping
key and the file holds the keyring encrypted under it. The refresh-token path was exposed
to the same limit and is now guarded too.

Reaching a second device uses the existing pairing flow (Contract A):

1. The new device generates an X25519 keypair and sends the public key with its pairing
   claim. It receives a workspace token but **no key**, so it can join, be seen, and send
   nothing readable until step 4.
2. Both machines display a 60-bit **fingerprint** of that public key, in the same
   read-aloud alphabet as a pairing code.
3. `crosscode pair` shows the claiming device's fingerprint and asks a human to confirm it
   matches what the other machine printed.
4. On confirmation, the approving device wraps each epoch key to the new device's public
   key (X25519 → HKDF → AES-256-GCM) and posts the results. The service stores and
   forwards them exactly as it does file payloads: it holds no private key.

**The fingerprint comparison is the whole security of that step, and it is not optional
theatre.** The service relays public keys, so it could offer one of its own and be handed
the workspace keyring. Comparing 60 bits out of band is what detects that. Grants are
therefore never issued automatically to a device nobody has approved. Auto-granting to
whatever the service listed would hand it the key on request and make every other claim on
this page false. The automatic sweep only re-grants to devices that already hold an epoch,
which is how a rotation reaches an offline machine without a second human decision.

A member joining by invite rather than pairing is approved the same way, with
`crosscode key devices` and `crosscode key approve <replicaId> --fingerprint <shown>`.

There is also `crosscode key export`, which prints the keyring as a recovery code to move
out of band (a password manager, Signal) for anyone who prefers not to trust the relay for
introductions at all.

### Rotation, and removing someone from a workspace

`crosscode key rotate` starts a new epoch and grants it to every already-approved device.
Everything sealed from that point is unreadable to anyone holding only the old epochs.

**Rotation cannot un-share history, and nothing can.** Someone who was in the workspace
downloaded and decrypted those operations on their own machine, and had a full checkout
of the repository besides. No key operation reaches back into a copy someone already has.
Any product claiming otherwise is describing access control, not cryptography.

What removal and rotation actually do, in order:

1. `crosscode members remove` sets `members.disabled_at`, and in the same transaction
   retires their replicas and revokes their workspace tokens. Server-side access ends on
   their next request. This is the step that matters most and it is immediate.
2. Their devices drop out of the grant recipient list, because it filters on active
   replicas and active members.
3. `crosscode key rotate` then makes all *future* operations unreadable to them even if
   they kept a copy of the old key and somehow regained transport access.

Rotation is not automatic on removal, because it is not free: every device has to pick up
the new epoch, and a device that is offline and never comes back is left behind. The CLI
prompts for it after a removal instead of deciding.

History under old epochs is **not** re-encrypted. The service cannot do it, because it
cannot read the data, and having clients do it would mean decrypting and re-uploading every
proposal a workspace has ever had. Old epochs stay in
the keyring; plan retention (`historyRetentionDays`) is what ages that data out.

### Default on, and what it costs to lose the key

Encryption is **on by default** for every workspace that talks to a hosted service. A
security property that is opt-in is a property most users do not have, and "we cannot read
your code" cannot carry an asterisk about a checkbox.

That default is affordable here for a specific reason worth being explicit about: **the
durable artifact is your Git repository, which you already have.** Losing a workspace key
costs the coordination history, meaning past proposals with their diffs and intents. It
costs no source. That is a bounded, recoverable loss, which is what makes default-on
defensible for Crosscode where it would not be for a hosted database.

We cannot reset a key for you. There is nothing on our side to reset it from; that is the
same fact as "we cannot read your code." Recovery is therefore local:

- Any other paired device still holding the key can grant it to a new one.
- `crosscode key export` produces a recovery code to store in a password manager.
  `crosscode key import` restores from it.
- If every copy is gone, `crosscode key rotate` on a fresh keyring gets the workspace
  working again immediately. History sealed under the lost epochs stays unreadable, and
  the daemon reports which operations it skipped rather than pretending they never
  existed.

An **anti-downgrade latch** backs the default: once a workspace has ingested one sealed
operation, the service refuses plaintext for it forever. There is no way to unlatch, since
an unlatch would be a supported path for making previously-unreadable data readable to us.
Whether a client encrypts is decided entirely by whether it holds a local
key, so nothing the service says can talk a client out of encrypting; the latch exists to
stop a rolled-back or misconfigured client from putting plaintext back.

`CROSSCODE_ENCRYPTION=off` exists for self-hosted deployments, where the operator and the
customer are the same party and readable payloads are worth more than a property that
party already has by owning the database. It cannot silently take effect on a workspace
that has already latched.

### Threat model, stated plainly

Holds against: a database dump or backup theft; a subpoena served on us; an engineer with
production access; a compromised or malicious service process reading stored data; a
service that tampers with stored payloads (detected by the AEAD tag).

Does **not** hold against: a compromised member device, which has the key and the checkout
and is not defended against; a member who leaves with data they already downloaded;
metadata analysis over what stays in the clear above; and an *actively malicious* service
during one pairing, which can offer its own public key. The fingerprint comparison detects
that, which is why the step is mandatory rather than advisory.

Not yet covered: task titles, claim targets, published intents, handoff notes, and
validation output, all of which reach the service in the clear.

## The billing webhook

`POST /v1/webhooks/stripe` is the only unauthenticated write route in a service that
authenticates everything else, and unlike `POST /v1/pairing-codes/claim` it is not
single-use either. Stripe holds no Crosscode credential, so the request signature is the
credential. Four independent defenses:

1. **The route does not exist without a signing secret.** No `CROSSCODE_STRIPE_WEBHOOK_SECRET`
   configured means 404, rather than a weaker check. A deployment that could take money but
   not verify what it is told about that money would be exactly the configuration in which
   this endpoint is worth attacking, so `apps/service/src/main.ts` requires the secret
   whenever a Stripe key is present.
2. **The signature is verified over the raw bytes, before parsing.**
   `verifyStripeSignature` (`apps/service/src/stripe.ts`) recomputes HMAC-SHA256 over
   `<timestamp>.<body>` and compares it constant-time (`timingSafeEqual`) against every
   `v1=` entry in the header, since there is more than one during a secret rotation. The
   signature is attacker-supplied and the secret is not, so a byte-at-a-time comparison
   would leak the expected digest under enough attempts. A header with no timestamp or no
   `v1` entry is refused rather than falling through to "nothing to compare, so pass", which
   is the classic way this check is written wrong. An unsigned body never reaches
   `JSON.parse`, let alone a write.
3. **Replay is bounded twice.** The signed timestamp must be within five minutes, checked in
   both directions (a future timestamp is as much a sign of forgery as a stale one), which
   bounds how long a captured-off-the-wire *valid* delivery stays useful. Inside that window
   the `billing_events` table records Stripe's event id, so a redelivery is a no-op.
   `processed_at` is set only after the handler succeeds, so a delivery that died halfway is
   retried rather than silently swallowed.
4. **The event is a signal, not a fact.** The handler
   (`apps/service/src/billing-webhook.ts`) takes the subscription id out of the body and
   re-reads that subscription's authoritative state from Stripe before writing anything.
   Out-of-order delivery, redelivery, and replay therefore all converge on the same write, so
   a stale event cannot roll a plan backwards. Which workspace an event applies to comes
   from the service's own customer/subscription mapping in Postgres;
   `client_reference_id`/`metadata` in the body are consulted only when no mapping exists
   yet, and only when they parse as a workspace id.

The routes that spend money (`/v1/workspace/billing/checkout|cancel|portal`) are the mirror
image: owner-only and Supabase-session-only, so a leaked `ccw_` workspace token reaches the
daemon ingest/read surface and can never start, change, or cancel a subscription.

## Provisioning and replica self-registration

Workspace and member provisioning is still an administrator-side operation
(`pnpm service:provision`), but it now creates or invites a Supabase Auth user
by email through the Supabase admin API (`SUPABASE_SERVICE_ROLE_KEY`) and
writes the corresponding workspace/member row straight to Postgres. There is
no one-time enrollment token or replica secret anymore. A replica (an
individual daemon/device identity) is self-registered by the authenticated
member calling `POST /v1/replicas` (`CoordinationServiceClient
.ensureReplicaRegistered`, `apps/daemon/src/service-client.ts`), which the
daemon does automatically the first time it starts with a logged-in session,
rather than being minted by exchanging an admin-issued token. The Supabase
session's refresh token is stored in the OS keychain when available (macOS
`security`, Linux `secret-tool`), the same way the replica secret used to be;
otherwise it falls back to the daemon's local, mode-`0600` config file
(`<git-dir>/crosscode/config.json`) outside versioned files. It is never committed and
never sent anywhere but Supabase and the coordination service. The daemon
refreshes an expiring access token automatically (`refreshAccessToken`) using
the stored refresh token, and re-persists the rotated session through the same
keychain-preferred path.

## Redaction

`redactValidationOutput` (`apps/daemon/src/index.ts`) truncates validation output
to 64 KB and regex-replaces likely secrets in place:

```
/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)([^\s]+)/gi
```

matches are replaced with `$1[REDACTED]`.

Separately, `configuredExcludedPaths`/`matchesConfiguredExclusion`
(`apps/daemon/src/config.ts`) read `excludedPaths` from the committed
`.crosscode/config.yaml` at `HEAD` and glob-match (`minimatch`, `dot: true`)
outgoing file paths against them. Excluded paths are dropped before a change is
even captured as a transaction. They never reach the redaction step, because they never
leave the local checkout.

## Sensitive-action confirmation

Per BUILD_INSTRUCTIONS.md section 16, these require explicit local user approval
regardless of automation elsewhere:

- Applying a high- or critical-risk operation.
- Requesting a semantic review when not pre-approved by workspace policy
  (`configuredAiReviewPolicy`'s `externalAiReview: "approved"` plus
  `requireLocalConfirmation`).
- Publishing a Git commit (`publish` requires a prior passing validation and, outside
  `dryRun`, an explicit confirmation or `--yes`). Publishing writes a commit and moves a
  local branch ref; it never pushes to a remote, and nothing in Crosscode does.
- Changing remotes, branch policy, or workspace membership. Removing a member
  (`crosscode members remove`) and revoking a paired device (`crosscode devices revoke`)
  both prompt unless `--yes` is passed, and both are owner-only.

The AI semantic reviewer (BUILD_INSTRUCTIONS.md section 12) is bounded and
non-authoritative: it cannot write files or publish commits directly, must
require human approval for `high`/`critical` risk regardless of its own
confidence score, and must never receive secrets, `.env` contents, credentials,
private keys, or excluded paths. Review is delegated to the workspace member's
own already-connected MCP agent (Claude Code, Codex CLI, etc.) rather than a
separate external AI provider: `AgentDelegatedReviewer`
(`packages/core/src/agent-delegated-reviewer.ts`) parks the redacted review
bundle behind `GET /v1/semantic-reviews/pending` until the connected agent
calls the `submit_semantic_review` MCP tool (`POST
/v1/semantic-reviews/:requestId/submit`, `docs/mcp-clients.md`) with its
judgment, or the request times out into the safe `uncertain`/
`requiresHumanApproval` fallback. Crosscode stores, configures, or transmits no
separate AI provider credentials for this. The redaction, prompt-injection
resistance, risk safety gate, and audit-record guarantees described above and
in BUILD_INSTRUCTIONS.md section 12 apply identically to the agent-delegated
bundle.

Concretely, prompt-injection resistance on that path means each pending review carries a
`prompt` alongside its structured `request`: `SEMANTIC_REVIEW_SYSTEM_PREAMBLE` plus the
file content wrapped in explicit `<untrusted-content>` delimiters
(`buildSemanticReviewPrompt`, `packages/core/src/semantic-review.ts`). The reviewing agent
is itself an LLM reading repository text that may contain instructions aimed at it, so it
receives that text already framed as data rather than as a bare JSON blob it has to decide
how to interpret. The preamble states that the delimited content is never instructions,
that the reviewer has no tool, file, Git, or publish capability, and that a human decides
what happens next. That last part is true: `resolveSemanticReview` only writes an audit
record.

### `policy.autoApplyRisk`

An optional `policy.autoApplyRisk` field on the committed `.crosscode/config.yaml`
(enum `low | medium | high | critical`, default `low` within an explicit `policy`
block) lets the daemon auto-materialize newly-arrived proposals instead of
waiting for an explicit `accept`. It does not add a new materialization path or
weaken any gate above: a proposal is only auto-applied if it already passes the
same `assertApplicable`/`assertChangeApplicable` checks a manual `accept` would
require (today, only the `independent`/`low`-risk classification satisfies that),
and its risk is at or under the configured threshold. Critical-risk paths are
never eligible regardless of policy. An auto-applied proposal is recorded with a
distinct `transaction.auto_applied` local event so it's visibly different from a
human-initiated accept. No `policy` block committed (the default) leaves
today's always-explicit-accept behavior completely unchanged.

## Threat model

Trust boundaries:

- **Website ↔ CLI:** the only thing the site ever hands the CLI is a Supabase
  session, over the loopback callback described above, guarded by `state`. The
  site holds no workspace state, issues no Crosscode-specific credential, and
  cannot reach a daemon. There is no browser surface that reads or writes
  coordination data at all, so a compromised web page's blast radius stops at
  "can attempt to deliver a session to a login that is already waiting", which
  is what `state` is there to reject.
- **Daemon ↔ local filesystem:** fully trusted. The daemon reads and writes the
  checkout it manages directly; there is no sandboxing between the daemon
  process and the repository it watches.
- **Daemon ↔ coordination service:** authenticated with a Supabase-issued JWT
  plus the `x-crosscode-workspace-id` header naming the target workspace.
  Every request re-derives role and membership server-side
  (`resolveMembership`), not just the token payload.
- **Service ↔ PostgreSQL:** the runtime connects with a least-privilege role
  (`CROSSCODE_RUNTIME_DB_ROLE`) that cannot update/delete immutable `operations`
  or `audit_events` rows, and the service refuses to start with a role that can.
  The runtime never executes DDL. History retention is the one thing that deletes
  `operations`, and it is deliberately kept outside that role: the scheduled sweep
  opens a second connection with `CROSSCODE_RETENTION_DATABASE_URL`, so no
  request-handling code path can reach a connection able to erase history. Row Level Security policies
  (`004_supabase_auth.sql`) are defense-in-depth on top of this. The service
  itself still connects with a privileged role rather than through PostgREST,
  so application-level authorization in `resolveMembership` remains the primary
  enforcement point; the RLS policies matter if the Supabase project's
  PostgREST/anon/authenticated roles are ever used to query these tables
  directly.

What a malicious or compromised replica **can** do, given its role's server-side
checks (`apps/service/src/auth.ts`, `store.ts`):

- Upload operations, tasks, claims, handoffs, and intents within its own role's
  permissions (an `owner`/`member` can write; a `viewer` cannot, and every ingest
  endpoint rejects `viewer` with 403).
- See other members' presence, tasks, claims, handoffs, and intents within the
  same workspace, since these fan out to every subscribed replica in that
  workspace.

What it **cannot** do:

- Impersonate another member or replica: every ingest endpoint checks that the
  event's `workspaceId`/`replicaId`/`actorId` match the authenticated identity
  and rejects a mismatch with 403.
- Bypass per-workspace authorization: all reads and writes are scoped to the
  caller's `workspaceId`; there is no cross-workspace query path.
- Force materialization on another replica: remote operations only ever arrive
  as proposals. A receiving daemon decides locally whether to accept, and the
  service has no mechanism to push a write into another checkout.
