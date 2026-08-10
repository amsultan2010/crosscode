# wire protocol

`packages/protocol/src/sync.ts` is the source of truth for every shape exchanged between a
daemon, the coordination service, and the local clients. everything below is a description
of that file; if the two disagree, the file is right. all schemas are zod and `.strict()`,
and the cli, mcp server, daemon, and service validate against the same definitions.

`PROTOCOL_VERSION` is `5`. version 5 removed `plan` from `syncProject`: crosscode is free
for everyone with no paid plans, so there was never anything for the field to say.

## the sync unit

one file is one change. there are no bundles, no transactions, and no accept/reject
lifecycle.

```ts
fileVersionSchema = {
  path: string;
  op: "modify" | "delete";
  baseHash: string | null;      // what the sender edited from; resolves the merge base
  contentHash: string | null;   // the result; also the loop-suppression key
  content?: string;             // exactly one of content or patch, for a modify
  patch?: string;
  encoding: "utf8" | "base64";
  renamedFrom?: string;         // renames travel as delete + modify, linked by this
  mode?: "100644" | "100755";   // git's one bit: executable or not. absent means unchanged
}
```

`op` exists because without it a delete is indistinguishable from an empty file. the schema
enforces the rest: a delete carries no content and no `contentHash`; a modify carries
exactly one of `content` or `patch` and a `contentHash`; a patch is meaningless without a
`baseHash`.

a `change` is a stored `fileVersion` with `sequence`, `projectId`, `branch`, `replicaId`,
and `createdAt` attached. `sequence` is assigned by the service and is the cursor.

## conflicts

```ts
conflictSchema = {
  id: string;
  path: string;
  detectedAt: string;
  ours: string | null;      // your disk
  theirs: string | null;    // the sender's
  ancestor: string | null;  // what you both started from
  binary: boolean;          // when true, the three sides are null
  renamedFrom?: string;
  peer?: string;
}
```

this is the whole conflict surface. it is produced by the daemon and consumed by the user's
own agent through mcp; crosscode never resolves one itself and stores no resolution
lifecycle. a conflicted path is quarantined until `resolve` arrives with merged content.

## service routes

| route | request | response |
| --- | --- | --- |
| `POST /v1/projects` | `createProjectRequest` (`name`, `repo` as `owner/repo`) | `syncProject` |
| `POST /v1/invites` | `createInviteRequest` (`projectId`, `expiresInHours`) | `syncInvite` |
| `POST /v1/invites/:code/redeem` | none | `redeemSyncInviteResponse` (`projectId`, `repo`, `cloneCommand`) |
| `POST /v1/replicas` | `registerSyncReplicaRequest` (`projectId`, `branch`) | `registerSyncReplicaResponse` (`replicaId`, `cursor`) |
| `POST /v1/changes` | `publishChangesRequest` (up to 500 versions) | `publishChangesResponse` (`cursor`) |
| `GET /v1/changes?since=` | `listChangesQuery` | `listChangesResponse` **or** `syncCursorTooOld` |

an invite code is the human-typed `CC-7F3A-9C2E` form, and redeeming it verifies the
invitee has access to the repo.

sign-in sits in front of all of these and is the one part of the surface that is not
session-authenticated, because its purpose is to produce a session:

| route | request | response |
| --- | --- | --- |
| `POST /v1/auth/github/device` | none | `{ deviceCode, userCode, verificationUrl, intervalSeconds, expiresInSeconds }` |
| `POST /v1/auth/github/device/token` | `{ deviceCode }` | `{ status: "pending" }` **or** `{ status: "complete", session }` |
| `POST /v1/auth/github/device/bind` | `{ userCode }` | binds a signed-in browser session to the pending code |

three more carry terms acceptance: `GET /v1/legal` returns the current terms and privacy
versions, `POST /v1/legal/acceptances` records one, and `GET /v1/legal/acceptances` reports
what the account still owes. `POST /v1/replicas` refuses with 403 until nothing is
outstanding.

`session` is the same `{ accessToken, refreshToken, expiresAt }` that
`syncDaemonConfig.service.session` already pins, so nothing downstream of sign-in has a
second shape to learn. the cli parses these two responses in `apps/cli/src/auth.ts`;
[the onboarding contracts](../docs/onboarding-contracts.md) have the sequence and the
reasoning.

`changesResponse` is a union, and the second arm matters: `{ status: "cursor-too-old",
resyncFrom, retentionDays }` means `since` predates retention and the gap cannot be filled
incrementally. a daemon must resync from full content rather than read it as "nothing new".

## websocket `/v1/stream`

the client sends `subscribe` (`projectId`, `branch`, `replicaId`, `since`) and then
`presence` updates. the server sends `change`, `presence`, or `error`. presence carries
`replicaId`, `actor`, `branch`, and up to 50 recently touched `paths`, which is how an
agent can answer "who is working on what" without any ambient ui.

the stream is the fast path, not the only one. a host that cannot serve a websocket upgrade
(a serverless function, for one) leaves a daemon publishing happily and receiving
nothing, so a daemon that cannot open the stream falls back to polling `GET /v1/changes?since=`
every few seconds. edits still arrive, a few seconds later than they would have. presence
does not: it exists only on the socket, so a polling room goes quiet about who is where.

## daemon config and local api

`syncDaemonConfig` is what the daemon stores per checkout: `projectId`, `repo`, and the
service url with an optional session. it lives mode-`0600` under the checkout's git
directory.

the daemon's loopback http api is what `crosscode status` and the mcp tools call. the
contract pins the shapes:

- `syncStatus`: `branch`, `connected`, `paused`, `cursor`, `pendingConflicts`, `peers`.
  returned by `crosscode status` and the `status` mcp tool alike.
- `conflict[]`: the pending conflicts.
- `resolveConflictRequest`: `{ conflictId, content }`, the agent's merged result. written
  to disk and republished.
- `pauseRequest`: `{ paused }`.

the route spellings the mcp server uses are `GET /v1/status`, `GET /v1/conflicts`,
`POST /v1/conflicts/resolve`, and `POST /v1/pause`, with a `Bearer` secret from the
connection descriptor and an `{ ok, data }` envelope. they are listed in
`apps/mcp-server/src/daemon-api.ts`, which is the one place to change if they move.

## what is not in the protocol

no operation, task, claim, handoff, intent, snapshot, validation, or review shape, and
nothing an incoming change has to be approved through. the old transaction-shaped schemas
are gone: `packages/protocol/src/index.ts` now holds only the daemon's own on-disk
shapes (its loopback connection descriptor and the config `crosscode start` writes) and
re-exports `sync.ts`. the two files together are 296 lines.
