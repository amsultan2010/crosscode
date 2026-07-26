import { randomUUID } from "node:crypto";
import { changeTransactionSchema, eventEnvelopeSchema, type ChangeTransaction, type EventEnvelope } from "@crosscode/protocol";

export type RemoteOperation = { id: string; workspaceId: string; senderReplicaId: string; transaction: ChangeTransaction; sequence: number; createdAt: string };

export class CoordinationService {
  private readonly operations = new Map<string, RemoteOperation[]>();
  private readonly seen = new Set<string>();
  private sequence = 0;

  receive(event: EventEnvelope, transaction: ChangeTransaction): RemoteOperation {
    eventEnvelopeSchema.parse(event);
    const validatedTransaction = changeTransactionSchema.parse(transaction);
    const existing = this.operations.get(event.workspaceId)?.find((operation) => operation.id === validatedTransaction.id);
    if (existing) return existing;
    if (this.seen.has(event.id)) throw new Error("Event ID was reused with a different operation");
    this.seen.add(event.id);
    const operation = { id: validatedTransaction.id || randomUUID(), workspaceId: event.workspaceId, senderReplicaId: event.replicaId, transaction: validatedTransaction, sequence: ++this.sequence, createdAt: new Date().toISOString() };
    this.operations.set(event.workspaceId, [...(this.operations.get(event.workspaceId) ?? []), operation]);
    return operation;
  }

  list(workspaceId: string, afterSequence = 0): RemoteOperation[] { return (this.operations.get(workspaceId) ?? []).filter((operation) => operation.sequence > afterSequence); }
}

export * from "./auth.js";
export * from "./crypto.js";
export * from "./http.js";
export * from "./store.js";
