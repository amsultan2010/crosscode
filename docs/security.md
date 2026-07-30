# Security model

## Authentication

The coordination service issues HS256 JWTs (`apps/service/src/auth.ts`) signed
with `CROSSCODE_JWT_SECRET` (must be at least 32 bytes). Tokens are scoped with
issuer `crosscode-service` and audience `crosscode-replica`; `verifyAccessToken`
rejects anything with a different issuer, audience, or algorithm. Claims
(`AccessClaims`):

```ts
{
  memberId: string;   // JWT subject
  actorId: string;
  workspaceId: string;
  replicaId: string;
  role: "owner" | "member" | "viewer";
  tokenVersion: number;
}
```

Access tokens are short-lived (default 900s TTL, `issueAccessToken`). Every
request re-derives authorization from the store (`reauthorize`), not just the
token, so a disabled member or replica loses access before its token expires.

## Enrollment and replica secrets

Workspace and member provisioning is an administrator-side operation
(`pnpm service:provision`) that writes a one-time enrollment record straight to
PostgreSQL; the raw enrollment token is printed once and never stored. A replica
exchanges that token for a long-lived replica secret and its first access token,
then uses the secret to mint further access tokens without re-enrolling.
Enrollment tokens expire after 15 minutes and are single-use. The replica secret
is stored only in the daemon's local, mode-`0600` config file
(`<git-dir>/crosscode/config.json`) outside versioned files — never committed,
never sent anywhere but the service.

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

### `policy.autoApplyRisk` (in progress)

**Not yet implemented in this codebase** — a parallel workstream is adding a
`policy.autoApplyRisk` field to the committed `.crosscode/config.yaml`
(enum `low | medium | high | critical`, default `low`). It controls which
risk-classified proposals the daemon may auto-accept instead of routing them
through the explicit human-accept flow described above. Until it lands, treat
every non-`low`-risk proposal as requiring an explicit `accept`/`reject`
decision; this field is a sensitive-action control and should be reviewed with
the same scrutiny as the confirmation points above once implemented.

## Threat model

Trust boundaries:

- **Daemon ↔ local filesystem:** fully trusted. The daemon reads and writes the
  checkout it manages directly; there is no sandboxing between the daemon
  process and the repository it watches.
- **Daemon ↔ coordination service:** authenticated and JWT-scoped per workspace
  membership. Every request re-derives role and membership server-side
  (`reauthorize`), not just the token payload.
- **Service ↔ PostgreSQL:** the runtime connects with a least-privilege role
  (`CROSSCODE_RUNTIME_DB_ROLE`) that cannot update/delete immutable `operations`
  or `audit_events` rows, and the service refuses to start with a role that can.
  The runtime never executes DDL.

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
