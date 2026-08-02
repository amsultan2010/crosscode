# Onboarding & analytics rework — frozen contracts

Status: authoritative for the in-flight onboarding/analytics work. Four workstreams
implement against the contracts below. **No workstream may change a contract in this
document unilaterally** — if something here is unimplementable, stop and report rather
than inventing a different shape, because three other workstreams are coding against it.

## Why this exists

Today a freshly signed-up account lands on `#/onboarding` (two static slides plus a
"copy the install prompt" step that verifies nothing), then hits the dashboard, where
the only thing it can do is fill in the "Create workspace" form. That is backwards: the
first thing a new user should do is connect their MCP server and see it actually
verified; teams come later, and only as an option.

Two gaps make the desired order impossible today:

1. Nothing links a local MCP/daemon install to a cloud account. `apps/mcp-server/src/bootstrap.ts`
   mints a random local `workspaceId`; the daemon only reaches the service after
   `crosscode login` + `crosscode join`.
2. There is no project/repository entity anywhere — not in `packages/protocol`, not in
   the service store, not in the schema. Workspaces are the only container.

So: signup auto-provisions a personal workspace (something to bind a pairing to),
onboarding pairs and verifies against it, and explicit team creation moves to a
post-onboarding action.

## The new flow

```
sign up
  └─ service auto-provisions a personal workspace ("<name>'s workspace", owner)
       └─ #/onboarding
            1. welcome
            2. connect MCP  — show install prompt + one-time pairing code
            3. verify       — poll until the daemon claims the code; blocking but skippable
            4. anchored spotlight tour over the live dashboard
                 └─ #/dashboard  (projects + analytics sections visible)
                      └─ "Create a team" is now an ordinary action, not a gate
```

## Contract A — pairing & verification

A pairing code is a short-lived, single-use bearer secret. The dashboard mints one; the
user's coding agent hands it to the daemon; the daemon redeems it **unauthenticated**
(the code is the credential) and receives back a workspace-scoped service token. The
claim endpoint never returns a Supabase user session — a terminal-side credential must
not be able to act as the user.

Code format: `XXXX-XXXX`, Crockford base32, uppercase, from `crypto.randomBytes`. TTL 15
minutes. Single-use. Store only a SHA-256 hash of the code, never the plaintext.

### `POST /v1/pairing-codes` (Supabase JWT + workspace header)

Mints a code for the caller's workspace. Owner or member.

```jsonc
// response data
{ "code": "K4T9-2WQZ", "expiresAt": "2026-08-01T12:15:00.000Z", "pairingId": "<uuid>" }
```

### `GET /v1/pairing-codes/:pairingId` (Supabase JWT + workspace header)

Dashboard polls this. Poll every 2s, give up after 15 min.

```jsonc
{ "status": "pending" | "claimed" | "expired",
  "claimedAt": "<iso>" | null,
  "replicaId": "<uuid>" | null,
  "actorId": "<string>" | null }
```

### `POST /v1/pairing-codes/claim` (no auth — the code is the credential)

```jsonc
// request
{ "code": "K4T9-2WQZ", "actorId": "user@host", "replicaName": "laptop", "repoRoot": "/abs/path", "repoRemote": "git@github.com:o/r.git" | null }
// response data
{ "workspaceId": "<uuid>", "replicaId": "<uuid>", "token": "<opaque service token>", "projectId": "<uuid>" | null }
```

Claiming is atomic: a conditional `UPDATE ... WHERE claimed_at IS NULL AND expires_at > now()`
that returns zero rows means already-claimed or expired — respond 410, never 200. Rate
limit by IP: 10 attempts/minute, and treat unknown/expired codes identically so the
endpoint is not an oracle.

> **Ownership seam — read this before touching the claim handler.** `projectId` is
> declared here so the response shape is final, but the pairing workstream must ship it
> as a literal `null` and must not create a projects table, a `projects.ts`, or any
> project upsert. The projects workstream owns populating it: it extends the existing
> claim handler to upsert from `repoRoot`/`repoRemote` and return the real id. Both
> workstreams edit `apps/service/src/http.ts`, so keeping the project logic entirely on
> one side of this line is what keeps the merge mechanical.

### Workspace service tokens

Opaque, 32 random bytes, base64url, prefixed `ccw_`. Stored as SHA-256 hash in
`workspace_tokens`. Scoped to one workspace, never expiring but revocable. The service's
existing bearer auth accepts **either** a Supabase JWT or a `ccw_` token; a `ccw_` token
resolves to its workspace and grants only the daemon ingest/read surface — it must be
rejected on `/v1/workspaces`, `/v1/memberships`, `/v1/invites`, and `/v1/pairing-codes`.

## Contract B — projects

A project is a repository, keyed within a workspace by its normalized git remote when
one exists, else by an absolute repo root path. Daemons report theirs on pairing and on
replica registration.

Normalization: lowercase host, strip `.git` suffix, convert `git@host:owner/repo` to
`host/owner/repo`, drop credentials and trailing slashes.

```ts
// packages/protocol/src/index.ts
export type Project = {
  id: string;
  workspaceId: string;
  name: string;          // derived from remote path or repo root basename
  repoRemote: string | null;  // normalized; null when the checkout has no remote
  repoRoot: string | null;    // absolute path last reported; advisory only
  createdAt: string;
  lastActivityAt: string | null;
};
```

- `GET  /v1/projects` → `{ projects: Project[] }`, workspace-scoped, newest activity first.
- `POST /v1/projects` → upsert by `(workspaceId, repoRemote)` falling back to
  `(workspaceId, repoRoot)`; returns the `Project`. Idempotent.
- `GET  /v1/projects/:id` → single `Project`, 404 outside the caller's workspace.

`replicas` and `operations` each gain a nullable `project_id`, so the dashboard can
attribute activity per project. Backfill is not required — null means "before projects
existed" and the UI shows those under an "Unassigned" grouping.

## Contract C — auto-provisioned personal workspace

`POST /v1/workspaces` stays as-is for explicit team creation. New behavior: the first
authenticated request from a user with zero memberships auto-provisions a personal
workspace and an owner membership, transactionally and idempotently (a unique partial
index on `members(user_id) WHERE is_personal` prevents a double-provision under
concurrent requests). `workspaces` gains `is_personal boolean NOT NULL DEFAULT false`.

`GET /v1/memberships` therefore never returns an empty list for a valid user. The
dashboard's `#no-team` empty state is consequently dead and is removed.

## Contract D — dashboard sections

Frontend-only; computed client-side from the existing snapshot plus `GET /v1/projects`.
No new aggregation endpoints. Four sections, each with its own heading, stat row, and
panels:

| Section | Contents |
|---|---|
| Overview | live presence, connected projects, total settled edits, plan/seat usage |
| Projects | per-project cards: name, remote, last activity, edit count, active replicas |
| Coordination | tasks, claims, handoffs, intents |
| Validation & safety | pass rate, recent validation runs, risk mix from `transaction.safety.risk` |

Each section root carries a stable `data-tour` attribute so the spotlight tour can anchor
to it: `data-tour="overview" | "projects" | "coordination" | "validation" | "team-switcher"`.
These attribute values are a contract between the dashboard and tour workstreams.

Tour completion persists to Supabase user metadata as `onboarding_completed_at` (ISO
string), with a `localStorage` mirror so a metadata write failure never re-runs the tour
on every load.

## Verification bar

There is no `lint` or `typecheck` script in this repo. The real gates are:

- `pnpm build` — root `tsc --noEmit` across the workspace, plus the VS Code extension build.
- `pnpm test` — `vitest run --coverage`.
- `pnpm docs:build` — required for any workstream touching `apps/docs-site` (the dashboard
  lives at `apps/docs-site/dashboard`), since the root `tsc` does not cover it.

Every workstream leaves all applicable gates green and adds tests covering its own
contract surface. Backend workstreams additionally prove their migration applies cleanly
from an empty database via `pnpm service:migrate`; Postgres-backed integration tests run
under `pnpm test:postgres` with `CROSSCODE_TEST_DATABASE_URL` set.
