import { z } from "zod";
import { changeTransactionSchema } from "@crosscode/protocol";

/**
 * Schemas for the daemon's local-only SQLite event log (local_events). Distinct from
 * @crosscode/protocol's network event envelopes -- these never cross the wire to the
 * coordination service; see docs/protocol.md's "Relationship to the daemon's local event
 * log" section. Reuses protocol DTO schemas wherever the local payload matches one exactly;
 * defines daemon-internal shapes (GitState, LocalOperation) here since they have no network
 * counterpart.
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

const localOperationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  senderReplicaId: z.string().min(1),
  transaction: changeTransactionSchema,
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime()
}).strict();

const cursorDownloadSchema = z.object({ cursor: z.number().int().nonnegative(), downloaded: z.number().int().nonnegative() }).strict();

function event<TType extends string, TPayload extends z.ZodTypeAny>(type: TType, payload: TPayload) {
  return z.object({ type: z.literal(type), payload }).strict();
}

export const localEventSchema = z.discriminatedUnion("type", [
  event("git.materialization_paused", z.object({ kind: gitTransitionKindSchema, previous: gitStateSchema, current: gitStateSchema }).strict()),
  event("git.head_changed", z.object({ kind: gitTransitionKindSchema, current: gitStateSchema }).strict()),
  event("transaction.created", localOperationSchema),
  event("transaction.published", z.union([localOperationSchema, z.object({ eventId: z.string().min(1), operationId: z.string().min(1), serverSequence: z.number().int().positive() }).strict()])),
  event("remote.synchronized", cursorDownloadSchema),
  // The service dropped history below `cursor` under the workspace's plan retention, so
  // this replica jumped its cursor forward from `previousCursor`. Recorded because it is
  // the only trace that operations in that range existed and were never seen here.
  event("remote.resync_required", z.object({
    cursor: z.number().int().nonnegative(),
    previousCursor: z.number().int().nonnegative(),
    retentionDays: z.number().int().positive()
  }).strict())
]);

export type LocalEvent = z.infer<typeof localEventSchema>;
