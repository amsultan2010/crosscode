import { z } from "zod";
import { changeTransactionSchema, claimSchema, handoffSchema, intentSchema, taskSchema, validationSchema } from "@crosscode/protocol";

/**
 * Schemas for the daemon's local-only SQLite event log (local_events). Distinct from
 * @crosscode/protocol's network event envelopes -- these never cross the wire to the
 * coordination service; see docs/protocol.md's "Relationship to the daemon's local event
 * log" section. Reuses protocol DTO schemas wherever the local payload matches one exactly;
 * defines daemon-internal shapes (GitState, CheckpointRecord, StoredOperation) here since
 * they have no network counterpart.
 */

const gitStateSchema = z.object({
  head: z.string().optional(),
  headReflog: z.string().optional(),
  branch: z.string().optional(),
  worktree: z.string(),
  indexTree: z.string().optional(),
  operation: z.enum(["merge", "rebase", "cherry-pick", "revert"]).optional()
}).strict();

const gitTransitionKindSchema = z.enum(["unchanged", "branch-switch", "head-changed", "index-changed", "git-operation", "reset"]);

const checkpointRecordSchema = z.object({
  ref: z.string(), commit: z.string(), tree: z.string(), message: z.string(), createdAt: z.string().datetime()
}).strict();

const storedOperationStatusSchema = z.enum(["local", "proposed", "applying", "accepted", "rejected", "conflicted"]);

const storedOperationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  senderReplicaId: z.string().min(1),
  transaction: changeTransactionSchema,
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  status: storedOperationStatusSchema,
  materializationCheckpoint: z.string().optional()
}).strict();

const storedOperationWithRecoverySchema = storedOperationSchema.extend({ recovery: z.string() }).strict();

const cursorDownloadSchema = z.object({ cursor: z.number().int().nonnegative(), downloaded: z.number().int().nonnegative() }).strict();
const timeCursorDownloadSchema = z.object({ cursor: z.string().datetime(), downloaded: z.number().int().nonnegative() }).strict();
const publishReceiptSchema = <TIdKey extends string>(idKey: TIdKey) => z.object({
  eventId: z.string().min(1),
  [idKey]: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict() as z.ZodObject<{ eventId: z.ZodString } & Record<TIdKey, z.ZodString> & { updatedAt: z.ZodString }>;

function event<TType extends string, TPayload extends z.ZodTypeAny>(type: TType, payload: TPayload) {
  return z.object({ type: z.literal(type), payload }).strict();
}

export const localEventSchema = z.discriminatedUnion("type", [
  event("task.created", taskSchema),
  event("task.updated", taskSchema),
  event("task.published", publishReceiptSchema("taskId")),
  event("task.synchronized", timeCursorDownloadSchema),
  event("claim.created", claimSchema),
  event("claim.released", claimSchema),
  event("claim.published", publishReceiptSchema("claimId")),
  event("claim.synchronized", timeCursorDownloadSchema),
  event("checkpoint.created", checkpointRecordSchema),
  event("checkpoint.restored", z.object({ ref: z.string(), path: z.string() }).strict()),
  event("handoff.requested", handoffSchema),
  event("handoff.responded", handoffSchema),
  event("handoff.published", publishReceiptSchema("handoffId")),
  event("handoff.synchronized", timeCursorDownloadSchema),
  event("intent.published", intentSchema),
  event("intent.published_remote", publishReceiptSchema("intentId")),
  event("intent.synchronized", timeCursorDownloadSchema),
  event("validation.completed", z.array(validationSchema)),
  event("validation.published", z.object({ eventId: z.string().min(1), validationId: z.string().min(1), createdAt: z.string().datetime() }).strict()),
  event("validation.synchronized", timeCursorDownloadSchema),
  event("git.materialization_paused", z.object({ kind: gitTransitionKindSchema, previous: gitStateSchema, current: gitStateSchema }).strict()),
  event("git.head_changed", z.object({ kind: gitTransitionKindSchema, current: gitStateSchema }).strict()),
  event("transaction.reanalyzed", z.object({
    operations: z.array(z.object({ id: z.string(), status: storedOperationStatusSchema }).strict()),
    materializationPaused: z.boolean()
  }).strict()),
  event("transaction.created", storedOperationSchema),
  event("transaction.published", z.union([storedOperationSchema, z.object({ eventId: z.string().min(1), operationId: z.string().min(1), serverSequence: z.number().int().positive() }).strict()])),
  event("remote.synchronized", cursorDownloadSchema),
  // Operations this device could not open because it holds no workspace key for the
  // epoch that sealed them. Recorded rather than logged and forgotten, so "why does my
  // history start here" has an answer in the durable local log.
  event("remote.unreadable", z.object({ sequences: z.array(z.number().int().positive()).min(1) }).strict()),
  // The service dropped history below `cursor` under the workspace's plan retention, so
  // this replica jumped its cursor forward from `previousCursor`. Recorded because it is
  // the only trace that operations in that range existed and were never seen here. Note
  // this is a different loss from `remote.unreadable` above: there the service still has
  // the operation and this device cannot decrypt it, here the operation is gone.
  event("remote.resync_required", z.object({
    cursor: z.number().int().nonnegative(),
    previousCursor: z.number().int().nonnegative(),
    retentionDays: z.number().int().positive()
  }).strict()),
  event("transaction.proposed", z.object({ proposals: z.array(storedOperationSchema), remoteCursor: z.number().int().nonnegative() }).strict()),
  event("transaction.applying", storedOperationSchema),
  event("transaction.apply_rolled_back", z.object({ id: z.string(), checkpoint: z.string(), recovery: z.string() }).strict()),
  event("transaction.accepted", z.union([storedOperationSchema, storedOperationWithRecoverySchema])),
  event("transaction.rejected", storedOperationSchema),
  event("transaction.safety_updated", storedOperationSchema),
  event("transaction.auto_applied", z.object({ id: z.string(), autoApplyRisk: z.enum(["low", "medium", "high", "critical"]).optional(), autonomyTier: z.union([z.literal(0), z.literal(1), z.literal(2)]) }).strict()),
  event("transaction.conflicted", z.union([storedOperationSchema, storedOperationWithRecoverySchema, z.object({ id: z.string(), checkpoint: z.string(), recovery: z.string() }).strict()])),
  event("semantic_review.requested", z.object({
    id: z.string(), operationId: z.string(), path: z.string(), providerId: z.string(), classification: z.string(),
    requiresHumanApproval: z.boolean(),
    redactions: z.array(z.object({
      path: z.string(), reason: z.enum(["excluded-path", "secret-path", "secret-content", "configured-exclusion", "binary-content"]), hash: z.string()
    }).strict())
  }).strict()),
  event("semantic_review.resolved", z.object({ id: z.string(), decision: z.enum(["accepted", "rejected"]) }).strict()),
  event("publish.completed", z.object({ branch: z.string(), commit: z.string(), tree: z.string() }).strict())
]);

export type LocalEvent = z.infer<typeof localEventSchema>;
