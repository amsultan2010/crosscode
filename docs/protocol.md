# Wire protocol

`packages/protocol/src/sync.ts` is the source of truth for every shape exchanged between a
daemon, the coordination service, and the local clients. Everything below is a description
of that file; if the two disagree, the file is right. All schemas are Zod and `.strict()`,
and the CLI, MCP server, daemon, and service validate against the same definitions.

`PROTOCOL_VERSION` is `3`.

## The sync unit

One file is one change. There are no bundles, no transactions, and no accept/reject
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
}
```

`op` exists because without it a delete is indistinguishable from an empty file. The schema
enforces the rest: a delete carries no content and no `contentHash`; a modify carries
exactly one of `content` or `patch` and a `contentHash`; a patch is meaningless without a
`baseHash`.

A `change` is a stored `fileVersion` with `sequence`, `projectId`, `branch`, `replicaId`,
and `createdAt` attached. `sequence` is assigned by the service and is the cursor.

## Conflicts

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

This is the whole conflict surface. It is produced by the daemon and consumed by the user's
own agent through MCP; Crosscode never resolves one itself and stores no resolution
lifecycle. A conflicted path is quarantined until `resolve` arrives with merged content.

## Service routes

| Route | Request | Response |
| --- | --- | --- |
| `POST /v1/projects` | `createProjectRequest` (`name`, `repo` as `owner/repo`) | `syncProject` |
| `POST /v1/invites` | `createInviteRequest` (`projectId`, `expiresInHours`) | `syncInvite` |
| `POST /v1/invites/:code/redeem` | none | `redeemSyncInviteResponse` (`projectId`, `repo`, `cloneCommand`) |
| `POST /v1/replicas` | `registerSyncReplicaRequest` (`projectId`, `branch`) | `registerSyncReplicaResponse` (`replicaId`, `cursor`) |
| `POST /v1/changes` | `publishChangesRequest` (up to 500 versions) | `publishChangesResponse` (`cursor`) |
| `GET /v1/changes?since=` | `listChangesQuery` | `listChangesResponse` **or** `syncCursorTooOld` |

An invite code is the human-typed `CC-7F3A-9C2E` form, and redeeming it verifies the
invitee has access to the repo.

`changesResponse` is a union, and the second arm matters: `{ status: "cursor-too-old",
resyncFrom, retentionDays }` means `since` predates retention and the gap cannot be filled
incrementally. A daemon must resync from full content rather than read it as "nothing new".

## Websocket `/v1/stream`

The client sends `subscribe` (`projectId`, `branch`, `replicaId`, `since`) and then
`presence` updates. The server sends `change`, `presence`, or `error`. Presence carries
`replicaId`, `actor`, `branch`, and up to 50 recently touched `paths`, which is how an
agent can answer "who is working on what" without any ambient UI.

## Daemon config and local API

`syncDaemonConfig` is what the daemon stores per checkout: `projectId`, `repo`, and the
service URL with an optional session. It lives mode-`0600` under the checkout's Git
directory.

The daemon's loopback HTTP API is what `crosscode status` and the MCP tools call. The
contract pins the shapes:

- `syncStatus`: `branch`, `connected`, `paused`, `cursor`, `pendingConflicts`, `peers`.
  Returned by `crosscode status` and the `status` MCP tool alike.
- `conflict[]`: the pending conflicts.
- `resolveConflictRequest`: `{ conflictId, content }`, the agent's merged result. Written
  to disk and republished.
- `pauseRequest`: `{ paused }`.

The route spellings the MCP server uses are `GET /v1/status`, `GET /v1/conflicts`,
`POST /v1/conflicts/resolve`, and `POST /v1/pause`, with a `Bearer` secret from the
connection descriptor and an `{ ok, data }` envelope. They are listed in
`apps/mcp-server/src/daemon-api.ts`, which is the one place to change if they move.

## What is not in the protocol

No operation, task, claim, handoff, intent, snapshot, validation, or review shape, and
nothing an incoming change has to be approved through. The old transaction-shaped schemas
still sit in `packages/protocol/src/index.ts`
because code being replaced still imports them; they are deleted when their last consumer
is, not before.
