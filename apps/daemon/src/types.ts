import type { RemoteOperation } from "../../service/src/index.js";
import type { RedactionRecord, SemanticReview } from "@crosscode/core";

export type StoredOperation = RemoteOperation & {
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
