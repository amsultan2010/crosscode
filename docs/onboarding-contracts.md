# Onboarding: frozen contracts

Status: authoritative. These are the cross-component contracts for how a person or a
coding agent gets from "no account" to "a checkout coordinating in a workspace."
**No component may change a contract in this document unilaterally.** The CLI, the
website's auth pages, and the coordination service are implemented against it
independently, so a unilateral change breaks someone else. If something here is
unimplementable, stop and report rather than inventing a different shape.

## Why this exists

Crosscode is CLI-first: there is no web dashboard, no web onboarding wizard, and no web
UI for teams or invites. Onboarding is therefore a sequence of commands, and the only
step with a browser in it is creating an account and signing in. That single browser
step still has to hand a real Supabase session back to a local process, and a
freshly-installed daemon still has to be attached to a workspace. Those two seams are
what the contracts below freeze.

The multi-tenant backend is untouched by the CLI-first decision. Workspaces,
memberships, invites, pairing codes, roles, RLS, presence, and billing all still exist in
`apps/service` and in the SQL migrations. They are reached from the CLI and the HTTP API.

## The flow

```
create an account
  ├─ on the website's sign-up page, or
  └─ crosscode signup --email <e> --password <p>
       └─ service auto-provisions a personal workspace ("<name>'s workspace", owner)   [Contract C]
            └─ crosscode login                                                          [Contract D]
                 └─ crosscode init
                      └─ crosscode join --workspace <id> | --invite <code> | --pair <code>   [Contract A]
                           └─ daemon syncs; activity is attributed to a project        [Contract B]
```

Nothing gates on creating a team. A personal workspace exists from the first
authenticated request, and joining or creating a team is an ordinary later action.

## Contract A: pairing and verification

A pairing code is a short-lived, single-use bearer secret that attaches a local checkout
to a workspace **without a login**. Whoever holds a session mints one; the user's coding
agent hands it to the daemon; the daemon redeems it unauthenticated (the code is the
credential) and receives back a workspace-scoped service token. The claim endpoint never
returns a Supabase user session, because a terminal-side credential must not be able to
act as the user.

Code format: `XXXX-XXXX`, Crockford base32, uppercase, from `crypto.randomBytes`. TTL 15
minutes. Single-use. Store only a SHA-256 hash of the code, never the plaintext.

### `POST /v1/pairing-codes` (Supabase JWT + workspace header)

Mints a code for the caller's workspace. Owner or member.

```jsonc
// response data
{ "code": "K4T9-2WQZ", "expiresAt": "2026-08-01T12:15:00.000Z", "pairingId": "<uuid>" }
```

### `GET /v1/pairing-codes/:pairingId` (Supabase JWT + workspace header)

Whoever minted the code polls this to confirm the claim. Poll every 2s, give up after 15
min.

```jsonc
{ "status": "pending" | "claimed" | "expired",
  "claimedAt": "<iso>" | null,
  "replicaId": "<uuid>" | null,
  "actorId": "<string>" | null }
```

### `POST /v1/pairing-codes/claim` (no auth; the code is the credential)

```jsonc
// request
{ "code": "K4T9-2WQZ", "actorId": "user@host", "replicaName": "laptop", "repoRoot": "/abs/path", "repoRemote": "git@github.com:o/r.git" | null,
  "devicePublicKey": "<base64url X25519>" }   // optional; see the encryption extension below
// response data
{ "workspaceId": "<uuid>", "replicaId": "<uuid>", "token": "<opaque service token>", "projectId": "<uuid>" | null,
  "pairingId": "<uuid>" | null }
```

### Encryption extension (additive)

End-to-end encryption of file payloads (see [security.md](./security.md#end-to-end-encryption))
extends this contract **additively**. No existing field changed meaning, type, or
nullability, so a client or service that predates it still interoperates:

- `POST /v1/pairing-codes/claim` accepts an optional `devicePublicKey` (raw X25519, 32
  bytes, base64url). Omitting it pairs the device without giving it a workspace key.
- Its response gains `pairingId`, so the claiming device can tell a human which pairing to
  compare a fingerprint for.
- `GET /v1/pairing-codes/:pairingId` gains `devicePublicKey: string | null`, relaying the
  claiming device's key to whoever minted the code.
- `POST /v1/replicas` accepts the same optional `devicePublicKey`.

Pairing carries the key, but does not by itself grant it: the minting side must show the
claiming device's 60-bit fingerprint to a human and get a confirmation before wrapping the
workspace keyring to it. The service relays public keys and could substitute its own, so
that comparison is the only thing that detects it. It is mandatory, not advisory.

Claiming is atomic: a conditional `UPDATE ... WHERE claimed_at IS NULL AND expires_at > now()`
that returns zero rows means already-claimed or expired, so respond 410, never 200. Rate
limit by IP: 10 attempts/minute, and treat unknown/expired codes identically so the
endpoint is not an oracle.

CLI side: `crosscode join --pair <code> [--service <url>] [--replica-name <name>]`. It
needs no prior `crosscode init` and no login, and it persists the returned token into the
mode-`0600` `<git-dir>/crosscode/config.json` without ever echoing it.

### Workspace service tokens

Opaque, 32 random bytes, base64url, prefixed `ccw_`. Stored as SHA-256 hash in
`workspace_tokens`. Scoped to one workspace, never expiring but revocable. The service's
existing bearer auth accepts **either** a Supabase JWT or a `ccw_` token; a `ccw_` token
resolves to its workspace and grants only the daemon ingest/read surface, and must be
rejected on `/v1/workspaces`, `/v1/memberships`, `/v1/invites`, and `/v1/pairing-codes`.

## Contract B: projects

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

`replicas` and `operations` each carry a nullable `project_id`, so activity can be
attributed per repository. Backfill is not required; null means "before projects
existed" and consumers group those as "Unassigned".

## Contract C: auto-provisioned personal workspace

`POST /v1/workspaces` stays as-is for explicit team creation. The first authenticated
request from a user with zero memberships auto-provisions a personal workspace and an
owner membership, transactionally and idempotently (a unique partial index on
`members(user_id) WHERE is_personal` prevents a double-provision under concurrent
requests). `workspaces` carries `is_personal boolean NOT NULL DEFAULT false`.

`GET /v1/memberships` therefore never returns an empty list for a valid user. This is
what lets onboarding skip team creation entirely: there is always something to join a
checkout to.

## Contract D: CLI browser login

`crosscode login` is the one step with a browser in it. It is frozen: the CLI and the
website's `/auth/cli.html` page are implemented against it independently and neither may
renegotiate it.

- `crosscode login` (no flags, TTY present) starts a loopback HTTP server on `127.0.0.1`
  on an ephemeral port with the route `/callback`, and generates a 32-character random
  `state`.
- It opens the browser at `${WEB_URL}/auth/cli.html?port=<port>&state=<state>`, where
  `WEB_URL` comes from `--web <url>`, else `CROSSCODE_WEB_URL`, else the deprecated
  `CROSSCODE_DASHBOARD_URL` (still read for setups that predate the dashboard's removal;
  it warns on stderr), else the hosted default `https://www.getcrosscode.dev` compiled
  into `apps/daemon/src/hosted.ts`. Because that default exists, bare `crosscode login`
  works and `WEB_URL_REQUIRED` is no longer reachable.
- `/auth/cli.html` is a page on the marketing site. If the visitor is not signed in it
  renders the normal sign-in form. After a successful Supabase sign-in it POSTs JSON to
  `http://127.0.0.1:<port>/callback`:

  ```jsonc
  { "state": "<echoed state>",
    "access_token": "…",
    "refresh_token": "…",
    "expires_at": 1754131200,   // unix seconds
    "user": { "id": "…", "email": "…" } }
  ```

  then renders "You're signed in. Return to your terminal."
- The CLI's loopback server answers the CORS preflight so that fetch succeeds:
  `OPTIONS /callback` → `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Methods: POST, OPTIONS`,
  `Access-Control-Allow-Headers: content-type`.
- Mismatched or missing `state` → error code `LOGIN_STATE_MISMATCH`. No callback within
  300s → `LOGIN_TIMEOUT`, with a hint pointing at `--email`/`--password` or
  `--no-browser`.
- `--no-browser` prints the URL instead of opening it. `--email <e> --password <p>` keeps
  the existing headless path, which is what agents and CI use. There is **no**
  `CROSSCODE_TOKEN` environment variable.
- On success the session is persisted through the existing daemon config writer (the
  mode-`0600` `<git-dir>/crosscode/config.json`). Tokens are never printed to stdout and
  never appear in `--json` output. `crosscode login --json` emits
  `{"value":{"userId":"…","email":"…"}}`.

The threat model is in [security.md](./security.md#sign-in-threat-model): loopback-only
binding, the role of `state`, why nothing is printed, and the 0600 file.

## Verification bar

There is no `lint` or `typecheck` script in this repo. The real gates are:

- `pnpm build`: root `tsc --noEmit` across the workspace.
- `pnpm test`: `vitest run --coverage`.
- `pnpm docs:build`: required for anything touching `apps/docs-site`, since the root
  `tsc` does not cover it.

Every change leaves all applicable gates green and adds tests covering its own contract
surface. Backend changes additionally prove their migration applies cleanly from an empty
database via `pnpm service:migrate`; Postgres-backed integration tests run under
`pnpm test:postgres` with `CROSSCODE_TEST_DATABASE_URL` set.
