# Security model

## Authentication

Workspace members authenticate directly against Supabase Auth (email +
password, `crosscode -- login`); the daemon stores the resulting Supabase
session (short-lived access token plus a longer-lived refresh token) rather
than a Crosscode-issued credential. The coordination service verifies each
request's access token against Supabase's own signing key
(`verifySupabaseAccessToken`, `apps/service/src/auth.ts`), configured via
`SUPABASE_JWT_SECRET` (must be at least 32 bytes) and `SUPABASE_URL` (used to
check the expected token issuer, `<SUPABASE_URL>/auth/v1`, and the
`authenticated` audience) — it no longer signs its own JWTs. Claims
(`SupabaseAccessClaims`):

```ts
{
  userId: string;             // JWT subject; Supabase auth.users id
  email: string | undefined;
  expiresAt: string;
}
```

A Supabase access token carries only the member's `auth.users` id — not a
workspace, replica, or role scope the way Crosscode's own previously-issued
tokens did. Every authenticated request must therefore also carry an
`x-crosscode-workspace-id` header naming the workspace it targets
(`apps/service/src/http.ts`); the service then re-derives role and membership
server-side for that `(userId, workspaceId)` pair on every request
(`resolveMembership`), so a disabled member loses access immediately rather
than waiting for its token to expire. POST bodies also carry their own
`event.workspaceId`, which is checked against the header for a redundant
principal-binding match.

## Provisioning and replica self-registration

Workspace and member provisioning is still an administrator-side operation
(`pnpm service:provision`), but it now creates or invites a Supabase Auth user
by email through the Supabase admin API (`SUPABASE_SERVICE_ROLE_KEY`) and
writes the corresponding workspace/member row straight to Postgres — there is
no one-time enrollment token or replica secret anymore. A replica (an
individual daemon/device identity) is self-registered by the authenticated
member calling `POST /v1/replicas` (`CoordinationServiceClient
.ensureReplicaRegistered`, `apps/daemon/src/service-client.ts`), which the
daemon does automatically the first time it starts with a logged-in session,
rather than being minted by exchanging an admin-issued token. The Supabase
session's refresh token is stored in the OS keychain when available (macOS
`security`, Linux `secret-tool`), the same way the replica secret used to be;
otherwise it falls back to the daemon's local, mode-`0600` config file
(`<git-dir>/crosscode/config.json`) outside versioned files — never committed,
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
even captured as a transaction — they never reach the redaction step because they
never leave the local checkout.

## Sensitive-action confirmation

Per BUILD_INSTRUCTIONS.md section 16, these require explicit local user approval
regardless of automation elsewhere:

- Applying a high- or critical-risk operation.
- Sending code to an external AI reviewer when not pre-approved by workspace
  policy (`configuredAiReviewPolicy`'s `externalAiReview: "approved"` plus
  `requireLocalConfirmation`).
- Publishing Git commits or pushes (`publish` requires a prior passing
  validation and, outside `dryRun`, an explicit confirmation or `--yes`).
- Changing remotes, branch policy, or workspace membership.

The AI semantic reviewer (BUILD_INSTRUCTIONS.md section 12) is bounded and
non-authoritative: it cannot write files or publish commits directly, must
require human approval for `high`/`critical` risk regardless of its own
confidence score, and must never receive secrets, `.env` contents, credentials,
private keys, or excluded paths.

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
  The runtime never executes DDL. Row Level Security policies
  (`004_supabase_auth.sql`) are defense-in-depth on top of this — the service
  itself still connects with a privileged role rather than through PostgREST,
  so application-level authorization in `resolveMembership` remains the primary
  enforcement point; the RLS policies matter if the Supabase project's
  PostgREST/anon/authenticated roles are ever used to query these tables
  directly.

What a malicious or compromised replica **can** do, given its role's server-side
checks (`apps/service/src/auth.ts`, `store.ts`):

- Upload operations, tasks, claims, handoffs, and intents within its own role's
  permissions (an `owner`/`member` can write; a `viewer` cannot — every ingest
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
