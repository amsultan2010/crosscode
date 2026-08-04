import type { ChangeTransaction } from "@crosscode/protocol";
import type { RedactionRecord, SemanticReview } from "@crosscode/core";

/**
 * An operation as the daemon holds it locally.
 *
 * `sequence` is the daemon's own monotonic position, not the wire protocol's
 * `serverSequence`: it is 0 for work captured locally and not yet acknowledged, and takes
 * the service's value once it has been. `CoordinationServiceClient` translates between
 * this and `@crosscode/protocol`'s `RemoteOperation` at the network edge.
 *
 * Declared here rather than imported from apps/service: the daemon does not depend on the
 * service package (it talks to it over HTTP), and importing the service's in-memory test
 * double's types across an app boundary made the dependency direction a lie.
 */
export type LocalOperation = {
  id: string;
  workspaceId: string;
  senderReplicaId: string;
  transaction: ChangeTransaction;
  sequence: number;
  createdAt: string;
};

export type StoredOperation = LocalOperation & {
  status: "local" | "proposed" | "applying" | "accepted" | "rejected" | "conflicted";
  materializationCheckpoint?: string;
};

/**
 * Immutable audit record for one AI semantic review (BUILD_INSTRUCTIONS.md section 25).
 * Never holds secret values -- only redaction reasons/hashes and the hashes of the
 * reviewed content, so the base can be re-verified before any materialization without
 * re-exposing what was sent to the provider.
 */
export type SemanticReviewRecord = {
  id: string;
  operationId: string;
  path: string;
  providerId: string;
  classification: string;
  requestedRisk: "medium" | "high" | "critical";
  deterministicClassification: string;
  redactions: RedactionRecord[];
  baseHash?: string;
  localHash?: string;
  proposedHash?: string;
  response: SemanticReview;
  decision: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt?: string;
};
