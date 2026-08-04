# Network protocol

`packages/protocol/src/index.ts` is the single source of truth for every request,
response, and event shape exchanged between a daemon and the coordination service.
All schemas are Zod (`.strict()` where applicable); the CLI, MCP server, and
service all validate against the same definitions.

## Event envelope

Every network event a daemon uploads is wrapped in `eventEnvelopeSchema`:

```ts
{
  id: string;
  schemaVersion: 1;
  workspaceId: string;
  replicaId: string;
  actorId: string;
  sessionId?: string;
  agent?: { provider: "cursor" | "codex" | "claude-code" | "opencode" | "devin-like" | "unknown"; adapterId?: string; sessionReference?: string };
  type: string;
  clientSequence: number;   // non-negative int, per-replica ordering
  serverSequence?: number;  // assigned by the service on ingest, positive int
  createdAt: string;        // ISO datetime
  payload: unknown;
  signature?: string;
}
```

Concrete event types extend this envelope with `type: z.literal("...")` and a typed
`payload`, and most add a `superRefine` check that the envelope `id` matches
`payload.id` (`assertPayloadIdMatches`).

`schemaVersion` is currently fixed at `z.literal(1)` — there is only one version.
Because it's a literal rather than a range, any envelope with a different value
fails schema validation outright. The intended long-term rule (see
BUILD_INSTRUCTIONS.md) is that a future major bump follows the same pattern:
unknown/newer major versions are rejected rather than partially parsed.

## Event types actually defined

| `type` | Event schema | Payload |
| --- | --- | --- |
| `transaction.created` | `transactionCreatedEventSchema` | `ChangeTransaction` |
| `transaction.sealed` | `sealedTransactionCreatedEventSchema` | `SealedTransaction` |
| `task.created` | `taskCreatedEventSchema` | `Task` |
| `task.updated` | `taskUpdatedEventSchema` | `Task` |
| `claim.created` | `claimCreatedEventSchema` | `Claim` |
| `claim.released` | `claimReleasedEventSchema` | `Claim` |
| `handoff.requested` | `handoffRequestedEventSchema` | `Handoff` |
| `handoff.responded` | `handoffRespondedEventSchema` | `Handoff` |
| `intent.published` | `intentPublishedEventSchema` | `Intent` |
| `validation.completed` | `validationCompletedEventSchema` | `Validation` |

Each of these has a corresponding `*IngestRequest` schema the service accepts on
its HTTP ingest endpoints, and a `*IngestReceipt` schema returned back.

## Sealed transactions

`transaction.sealed` is what a client sends when the workspace is end-to-end encrypted,
which is the default against a hosted service. `serviceIngestRequestSchema` accepts either
form, and `remoteOperationSchema.transaction` is `syncedTransactionSchema` — a union of
`ChangeTransaction` and `SealedTransaction`. Use `isSealedTransaction()` to discriminate.

```ts
{
  id: string;                          // unchanged: the service still dedupes on it
  sealed: {
    version: 1;
    algorithm: "AES-256-GCM";
    epoch: number;                     // which workspace key epoch sealed this
    keyId: string;                     // 16 hex chars; names the key without revealing it
    nonce: string;                     // base64url, 12 bytes
    ciphertext: string;                // base64url, GCM tag appended
  };
  changes: Array<{
    pathToken: string;                 // HMAC-SHA256(pathKey, `${id}\0${path}`), 64 hex
    kind: "add" | "modify" | "delete" | "rename";
  }>;
}
```

Everything else a `ChangeTransaction` carries — `base`, `intent`, `provenance`, `safety`,
and every field of `changes` including paths, content, patches, and hashes — is inside the
ciphertext. The workspace id, sending replica id, and transaction id are bound in as AEAD
additional authenticated data, so a sealed payload cannot be moved between workspaces,
re-attributed, or spliced onto another operation.

Sealing and opening happen only in `apps/daemon/src/sealing.ts`, at the transport seam.
Nothing else in the codebase sees the sealed form, and `packages/core` — which the service
links — deliberately contains none of this code. Key distribution rides three routes
(`/v1/workspace-keys/state`, `/v1/workspace-keys/recipients`, `/v1/workspace-keys/grants`,
plus `PUT /v1/workspace-keys/device`) whose bodies are ciphertext the service cannot open.
See [security.md](./security.md#end-to-end-encryption).

## WebSocket fan-out

`wsFanOutMessageSchema` is a discriminated union on `type`, currently:

- `operation` — wraps a `RemoteOperation`
- `presence` — wraps a `PresenceUpdate` (`online` / `idle` / `offline`)
- `task` — wraps a `RemoteTask`
- `claim` — wraps a `RemoteClaim`
- `handoff` — wraps a `RemoteHandoff`
- `intent` — wraps a `RemoteIntent`
- `validation` — wraps a `RemoteValidation`

A replica subscribes with `wsSubscribeRequestSchema` (`workspaceId`, `replicaId`,
`accessToken`) and gets back a `wsSubscribeAckSchema` with a resume cursor, or a
`wsErrorMessageSchema` on failure. Each `remote*` payload additionally carries
`eventId`, `workspaceId`, `senderReplicaId`, and an `updatedAt`/`createdAt`
timestamp (validations are immutable, so `RemoteValidation` uses `createdAt`
instead of `updatedAt`) so a receiving replica can dedupe and order it against its
own cursor. `POST /v1/validations` / `GET /v1/validations` follow the same
request/receipt/cursor/fan-out pattern as `task`/`claim`/`handoff`/`intent` above,
letting replicas see each other's local validation results.

## Relationship to the daemon's local event log

The schemas above govern only what crosses the wire between a daemon and the
coordination service. Each daemon also keeps a separate, local-only SQLite event
log (`<git-dir>/crosscode/state.sqlite`) recording every local action — captures,
checkpoints, validations, and outbound/inbound cursors — for crash recovery and
projections. That local log is not part of this network protocol and is not sent
to the service as-is; a parallel workstream is making it schema-validated, but its
internal shape is out of scope here.
