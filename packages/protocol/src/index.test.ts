import { describe, expect, it } from "vitest";
import {
  changeTransactionSchema,
  checkpointRequestSchema,
  claimPairingCodeRequestSchema,
  claimPairingCodeResponseSchema,
  claimRequestSchema,
  cursorQuerySchema,
  pairingCodeSchema,
  pairingStatusResponseSchema,
  workspaceTokenSchema,
  cursorResponseSchema,
  daemonConfigSchema,
  daemonConnectionSchema,
  eventEnvelopeSchema,
  principalSchema,
  registerReplicaRequestSchema,
  registerReplicaResponseSchema,
  remoteOperationSchema,
  serviceIngestReceiptSchema,
  serviceIngestRequestSchema,
  publishRequestSchema,
  taskRequestSchema,
  taskSchema,
  transactionCreatedEventSchema,
  validationRequestSchema,
  presenceUpdateSchema,
  wsErrorMessageSchema,
  wsFanOutMessageSchema,
  wsSubscribeAckSchema,
  wsSubscribeRequestSchema
} from "./index.js";

describe("protocol schemas", () => {
  const transaction = {
    id: "transaction-1",
    base: { files: [] },
    changes: [{ path: "a.ts", kind: "add" as const, afterContent: "content" }],
    provenance: { source: "filesystem" as const, confidence: "known" as const },
    safety: { risk: "low" as const, requiresApproval: false }
  };
  const transactionEvent = {
    id: transaction.id,
    schemaVersion: 1 as const,
    workspaceId: "workspace-1",
    replicaId: "replica-1",
    actorId: "actor-1",
    type: "transaction.created" as const,
    clientSequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: transaction
  };

  it("rejects incompatible event schema versions", () => {
    expect(() => eventEnvelopeSchema.parse({ id: "e", schemaVersion: 2, workspaceId: "w", replicaId: "r", actorId: "a", type: "task.created", clientSequence: 1, createdAt: new Date().toISOString(), payload: {} })).toThrow();
  });

  it("validates a task and immutable transaction", () => {
    expect(taskSchema.parse({ id: "t", title: "Test", ownerId: "a", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }).status).toBe("active");
    expect(changeTransactionSchema.parse({ id: "x", base: { files: [] }, changes: [{ path: "a.ts", kind: "add", afterHash: "hash", afterContent: "content" }], provenance: { source: "filesystem", confidence: "known" }, safety: { risk: "low", requiresApproval: false } }).id).toBe("x");
    expect(() => changeTransactionSchema.parse({ id: "x", base: { files: [] }, changes: [{ path: "a.ts", kind: "modify", afterHash: "hash" }], provenance: { source: "filesystem", confidence: "known" }, safety: { risk: "low", requiresApproval: false } })).toThrow();
    expect(() => changeTransactionSchema.parse({ id: "x", base: { files: [] }, changes: [{ path: "b.ts", kind: "rename", afterContent: "content" }], provenance: { source: "filesystem", confidence: "known" }, safety: { risk: "low", requiresApproval: false } })).toThrow();
  });

  it("strictly validates local daemon boundary inputs", () => {
    expect(taskRequestSchema.parse({ title: "Task", paths: ["src"] })).toEqual({ title: "Task", paths: ["src"] });
    expect(() => taskRequestSchema.parse({ title: "Task", unexpected: true })).toThrow();
    expect(claimRequestSchema.parse({ taskId: "t", kind: "path", target: "src", mode: "exclusive-preferred" }).target).toBe("src");
    expect(checkpointRequestSchema.parse({ message: "before change" }).message).toBe("before change");
    expect(validationRequestSchema.parse({ profile: "fast" })).toEqual({ profile: "fast" });
    expect(() => validationRequestSchema.parse({ profile: "fast", commands: ["rm -rf somewhere"] })).toThrow();
    expect(publishRequestSchema.parse({ branch: "main", profile: "fast" })).toEqual({ branch: "main", profile: "fast" });
    expect(publishRequestSchema.parse({ branch: "main", profile: "fast", message: "release", dryRun: true })).toEqual({ branch: "main", profile: "fast", message: "release", dryRun: true });
    expect(() => publishRequestSchema.parse({ branch: "main", profile: "fast", extra: true })).toThrow();
    expect(() => publishRequestSchema.parse({ branch: "", profile: "fast" })).toThrow();
    expect(daemonConnectionSchema.parse({ pid: 123, port: 4567, secret: "secret", startedAt: "2026-01-01T00:00:00.000Z" }).port).toBe(4567);
  });

  it("validates service principals", () => {
    const principal = { workspaceId: "workspace-1", actorId: "actor-1", replicaId: "replica-1", role: "member" as const };
    expect(principalSchema.parse(principal)).toEqual(principal);
    expect(() => principalSchema.parse({ ...principal, role: "administrator" })).toThrow();
    expect(() => principalSchema.parse({ ...principal, extra: true })).toThrow();
  });

  it("validates self-service replica registration requests and responses", () => {
    expect(registerReplicaRequestSchema.parse({ name: "my-laptop" })).toEqual({ name: "my-laptop" });
    expect(() => registerReplicaRequestSchema.parse({ name: "" })).toThrow();
    expect(() => registerReplicaRequestSchema.parse({ name: "my-laptop", token: "x" })).toThrow();

    const response = { replicaId: "replica-1", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(registerReplicaResponseSchema.parse(response)).toEqual(response);
    expect(() => registerReplicaResponseSchema.parse({ ...response, createdAt: "not-a-date" })).toThrow();
  });

  it("binds transaction-created event identity to its transaction payload", () => {
    expect(transactionCreatedEventSchema.parse(transactionEvent).payload.id).toBe(transactionEvent.id);
    expect(() => transactionCreatedEventSchema.parse({ ...transactionEvent, id: "different-event-id" })).toThrow();
    expect(() => transactionCreatedEventSchema.parse({ ...transactionEvent, type: "task.created" })).toThrow();
    expect(() => transactionCreatedEventSchema.parse({ ...transactionEvent, unexpected: true })).toThrow();
  });

  it("validates service ingest, receipts, remote operations, and cursor reads", () => {
    expect(serviceIngestRequestSchema.parse({ event: transactionEvent }).event.id).toBe(transaction.id);
    expect(serviceIngestReceiptSchema.parse({ eventId: transaction.id, operationId: transaction.id, serverSequence: 1 })).toEqual({
      eventId: transaction.id, operationId: transaction.id, serverSequence: 1
    });

    const operation = {
      id: transaction.id,
      eventId: transactionEvent.id,
      workspaceId: transactionEvent.workspaceId,
      senderReplicaId: transactionEvent.replicaId,
      transaction,
      serverSequence: 1,
      createdAt: transactionEvent.createdAt
    };
    expect(remoteOperationSchema.parse(operation)).toEqual(operation);
    expect(cursorQuerySchema.parse({ afterSequence: 0 })).toEqual({ afterSequence: 0 });
    expect(cursorResponseSchema.parse({ operations: [operation], nextCursor: 1 }).nextCursor).toBe(1);
    expect(() => cursorQuerySchema.parse({ afterSequence: -1 })).toThrow();
    expect(() => serviceIngestReceiptSchema.parse({ eventId: transaction.id, operationId: transaction.id, serverSequence: 0 })).toThrow();
  });

  it("accepts secure or loopback daemon service configuration only", () => {
    const base = { workspaceId: "workspace-1", replicaId: "replica-1", actorId: "actor-1" };
    const session = { accessToken: "access-token", refreshToken: "refresh-token", expiresAt: "2026-01-01T00:05:00.000Z" };
    expect(daemonConfigSchema.parse({ ...base, service: { url: "https://service.example.test", session } }).service?.url).toBe("https://service.example.test");
    expect(daemonConfigSchema.parse({ ...base, service: { url: "http://127.0.0.1:8080", session } }).service?.url).toBe("http://127.0.0.1:8080");
    expect(() => daemonConfigSchema.parse({ ...base, service: { url: "http://service.example.test", session } })).toThrow();
    expect(() => daemonConfigSchema.parse({ ...base, service: { url: "https://service.example.test", session, token: "x" } })).toThrow();
    expect(() => daemonConfigSchema.parse({ ...base, service: { url: "https://service.example.test", session: { ...session, accessToken: "" } } })).toThrow();
  });

  it("makes replicaId optional on the daemon config until self-registration completes", () => {
    const { replicaId: _replicaId, ...withoutReplicaId } = { workspaceId: "workspace-1", replicaId: "replica-1", actorId: "actor-1" };
    expect(daemonConfigSchema.parse(withoutReplicaId)).toEqual(withoutReplicaId);
    expect(daemonConfigSchema.parse({ ...withoutReplicaId, replicaId: "replica-1" }).replicaId).toBe("replica-1");
    expect(() => daemonConfigSchema.parse({ ...withoutReplicaId, replicaId: "" })).toThrow();
  });

  it("validates WebSocket handshake, presence, fan-out, and ack/error messages", () => {
    const subscribeRequest = { type: "subscribe" as const, workspaceId: "workspace-1", replicaId: "replica-1", accessToken: "access-token" };
    expect(wsSubscribeRequestSchema.parse(subscribeRequest)).toEqual(subscribeRequest);
    expect(() => wsSubscribeRequestSchema.parse({ ...subscribeRequest, unexpected: true })).toThrow();

    const presence = { replicaId: "replica-1", actorId: "actor-1", status: "online" as const, lastSeenAt: "2026-01-01T00:00:00.000Z" };
    expect(presenceUpdateSchema.parse(presence)).toEqual(presence);
    expect(() => presenceUpdateSchema.parse({ ...presence, status: "away" })).toThrow();

    const operation = {
      id: transaction.id,
      eventId: transactionEvent.id,
      workspaceId: transactionEvent.workspaceId,
      senderReplicaId: transactionEvent.replicaId,
      transaction,
      serverSequence: 1,
      createdAt: transactionEvent.createdAt
    };
    expect(wsFanOutMessageSchema.parse({ type: "operation", operation }).type).toBe("operation");
    expect(wsFanOutMessageSchema.parse({ type: "presence", presence }).type).toBe("presence");
    expect(() => wsFanOutMessageSchema.parse({ type: "presence", operation })).toThrow();

    expect(wsSubscribeAckSchema.parse({ type: "subscribed", cursor: 0 })).toEqual({ type: "subscribed", cursor: 0 });
    expect(() => wsSubscribeAckSchema.parse({ type: "subscribed", cursor: -1 })).toThrow();
    expect(wsErrorMessageSchema.parse({ type: "error", message: "not authorized" }).message).toBe("not authorized");
    expect(() => wsErrorMessageSchema.parse({ type: "error", message: "" })).toThrow();
  });

  it("constrains pairing codes, claim payloads, and workspace tokens", () => {
    expect(pairingCodeSchema.parse("K4T9-2WQZ")).toBe("K4T9-2WQZ");
    // Crockford base32 excludes I/L/O/U so a spoken code cannot be mistranscribed.
    for (const invalid of ["k4t9-2wqz", "K4T92WQZ", "K4T9-2WQI", "K4TO-2WQZ", "K4T9-2WQZ-1"]) {
      expect(() => pairingCodeSchema.parse(invalid)).toThrow();
    }

    const claim = { code: "K4T9-2WQZ", actorId: "user@host", replicaName: "laptop", repoRoot: "/abs/path", repoRemote: null };
    expect(claimPairingCodeRequestSchema.parse(claim)).toEqual(claim);
    expect(() => claimPairingCodeRequestSchema.parse({ ...claim, extra: true })).toThrow();
    expect(() => claimPairingCodeRequestSchema.parse({ ...claim, repoRemote: undefined })).toThrow();

    const claimed = { workspaceId: "w", replicaId: "r", token: "ccw_token", projectId: null };
    expect(claimPairingCodeResponseSchema.parse(claimed)).toEqual(claimed);
    expect(claimPairingCodeResponseSchema.parse({ ...claimed, projectId: "p" }).projectId).toBe("p");

    const status = { status: "claimed" as const, claimedAt: "2026-08-01T12:00:00.000Z", replicaId: "r", actorId: "user@host" };
    expect(pairingStatusResponseSchema.parse(status)).toEqual(status);
    expect(() => pairingStatusResponseSchema.parse({ ...status, status: "unknown" })).toThrow();

    expect(workspaceTokenSchema.parse("ccw_abc")).toBe("ccw_abc");
    expect(() => workspaceTokenSchema.parse("eyJhbGciOi")).toThrow();
  });
});
