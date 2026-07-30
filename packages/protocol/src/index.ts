import { z } from "zod";

export const riskSchema = z.enum(["low", "medium", "high", "critical"]);
export const captureKindSchema = z.enum(["intent", "summary", "interface-change"]);
export type CaptureKind = z.infer<typeof captureKindSchema>;
export const taskStatusSchema = z.enum(["planned", "active", "blocked", "review", "complete", "cancelled"]);
export const taskSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), ownerId: z.string().min(1), status: taskStatusSchema,
  intent: z.string().optional(), paths: z.array(z.string()).default([]), createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});
export type Task = z.infer<typeof taskSchema>;

export const claimSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), ownerId: z.string().min(1),
  kind: z.enum(["path", "symbol", "interface"]), target: z.string().min(1), mode: z.enum(["exclusive-preferred", "shared"]),
  expiresAt: z.string().datetime().optional(), createdAt: z.string().datetime()
});
export type Claim = z.infer<typeof claimSchema>;

export const changeTransactionSchema = z.object({
  id: z.string().min(1), taskId: z.string().optional(), intent: z.string().optional(),
  base: z.object({ headCommit: z.string().optional(), files: z.array(z.object({ path: z.string(), blobHash: z.string().optional(), contentHash: z.string() })) }),
  changes: z.array(z.object({ path: z.string().min(1), kind: z.enum(["add", "modify", "delete", "rename"]), beforeHash: z.string().optional(), afterHash: z.string().optional(), unifiedPatch: z.string().optional(), afterContent: z.string().optional() })).min(1),
  provenance: z.object({ source: z.enum(["filesystem", "cli-wrapper", "mcp", "hook", "extension"]), confidence: z.enum(["known", "inferred", "unknown"]) }),
  safety: z.object({ risk: riskSchema, requiresApproval: z.boolean() }),
  kind: captureKindSchema.optional()
}).strict().superRefine((transaction, context) => {
  transaction.changes.forEach((change, index) => {
    if (change.kind === "rename") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", index, "kind"], message: "Rename changes require explicit delete and add operations" });
    }
    if (change.kind !== "delete" && change.afterContent === undefined && change.unifiedPatch === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", index, "afterContent"], message: "Non-delete changes require materializable content or a patch" });
    }
  });
});
export type ChangeTransaction = z.infer<typeof changeTransactionSchema>;

export const eventEnvelopeSchema = z.object({
  id: z.string().min(1), schemaVersion: z.literal(1), workspaceId: z.string().min(1), replicaId: z.string().min(1), actorId: z.string().min(1),
  sessionId: z.string().optional(), agent: z.object({ provider: z.enum(["cursor", "codex", "claude-code", "opencode", "devin-like", "unknown"]), adapterId: z.string().optional(), sessionReference: z.string().optional() }).optional(),
  type: z.string().min(1), clientSequence: z.number().int().nonnegative(), serverSequence: z.number().int().positive().optional(), createdAt: z.string().datetime(), payload: z.unknown(), signature: z.string().optional()
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const transactionCreatedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("transaction.created"),
  payload: changeTransactionSchema
}).strict().superRefine((event, context) => {
  if (event.id !== event.payload.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "id"],
      message: "Transaction payload ID must match the event ID"
    });
  }
});
export type TransactionCreatedEvent = z.infer<typeof transactionCreatedEventSchema>;

function assertPayloadIdMatches<T extends { id: string; payload: { id: string } }>(event: T, context: z.RefinementCtx): void {
  if (event.id !== event.payload.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "id"], message: "Payload ID must match the event ID" });
  }
}

export const taskCreatedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("task.created"),
  payload: taskSchema
}).strict();
export type TaskCreatedEvent = z.infer<typeof taskCreatedEventSchema>;

export const taskUpdatedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("task.updated"),
  payload: taskSchema
}).strict();
export type TaskUpdatedEvent = z.infer<typeof taskUpdatedEventSchema>;

export const claimCreatedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("claim.created"),
  payload: claimSchema
}).strict();
export type ClaimCreatedEvent = z.infer<typeof claimCreatedEventSchema>;

export const claimReleasedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("claim.released"),
  payload: claimSchema
}).strict();
export type ClaimReleasedEvent = z.infer<typeof claimReleasedEventSchema>;

export const remoteTaskSchema = z.object({
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  senderReplicaId: z.string().min(1),
  task: taskSchema,
  updatedAt: z.string().datetime()
}).strict();
export type RemoteTask = z.infer<typeof remoteTaskSchema>;

export const remoteClaimSchema = z.object({
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  senderReplicaId: z.string().min(1),
  claim: claimSchema,
  released: z.boolean(),
  updatedAt: z.string().datetime()
}).strict();
export type RemoteClaim = z.infer<typeof remoteClaimSchema>;

export const taskCursorResponseSchema = z.object({
  tasks: z.array(remoteTaskSchema),
  nextCursor: z.string().datetime()
}).strict();
export type TaskCursorResponse = z.infer<typeof taskCursorResponseSchema>;

export const claimCursorResponseSchema = z.object({
  claims: z.array(remoteClaimSchema),
  nextCursor: z.string().datetime()
}).strict();
export type ClaimCursorResponse = z.infer<typeof claimCursorResponseSchema>;

export const taskIngestRequestSchema = z.object({
  event: z.discriminatedUnion("type", [taskCreatedEventSchema, taskUpdatedEventSchema])
}).strict().superRefine((request, context) => assertPayloadIdMatches(request.event, context));
export type TaskIngestRequest = z.infer<typeof taskIngestRequestSchema>;

export const claimIngestRequestSchema = z.object({
  event: z.discriminatedUnion("type", [claimCreatedEventSchema, claimReleasedEventSchema])
}).strict().superRefine((request, context) => assertPayloadIdMatches(request.event, context));
export type ClaimIngestRequest = z.infer<typeof claimIngestRequestSchema>;

export const taskIngestReceiptSchema = z.object({
  eventId: z.string().min(1),
  taskId: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict();
export type TaskIngestReceipt = z.infer<typeof taskIngestReceiptSchema>;

export const claimIngestReceiptSchema = z.object({
  eventId: z.string().min(1),
  claimId: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict();
export type ClaimIngestReceipt = z.infer<typeof claimIngestReceiptSchema>;

export const workspaceRoleSchema = z.enum(["owner", "member", "viewer"]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const principalSchema = z.object({
  workspaceId: z.string().min(1),
  actorId: z.string().min(1),
  replicaId: z.string().min(1),
  role: workspaceRoleSchema
}).strict();
export type Principal = z.infer<typeof principalSchema>;

export const enrollmentRequestSchema = z.object({
  token: z.string().min(1)
}).strict();
export type EnrollmentRequest = z.infer<typeof enrollmentRequestSchema>;

export const enrollmentResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime(),
  principal: principalSchema,
  replicaSecret: z.string().min(1)
}).strict();
export type EnrollmentResponse = z.infer<typeof enrollmentResponseSchema>;

export const replicaTokenExchangeRequestSchema = z.object({
  workspaceId: z.string().min(1),
  actorId: z.string().min(1),
  replicaId: z.string().min(1),
  replicaSecret: z.string().min(1)
}).strict();
export type ReplicaTokenExchangeRequest = z.infer<typeof replicaTokenExchangeRequestSchema>;

export const replicaTokenExchangeResponseSchema = enrollmentResponseSchema.omit({
  replicaSecret: true
});
export type ReplicaTokenExchangeResponse = z.infer<typeof replicaTokenExchangeResponseSchema>;

export const serviceIngestRequestSchema = z.object({
  event: transactionCreatedEventSchema
}).strict();
export type ServiceIngestRequest = z.infer<typeof serviceIngestRequestSchema>;

export const serviceIngestReceiptSchema = z.object({
  eventId: z.string().min(1),
  operationId: z.string().min(1),
  serverSequence: z.number().int().positive()
}).strict();
export type ServiceIngestReceipt = z.infer<typeof serviceIngestReceiptSchema>;

export const remoteOperationSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  senderReplicaId: z.string().min(1),
  transaction: changeTransactionSchema,
  serverSequence: z.number().int().positive(),
  createdAt: z.string().datetime()
}).strict();
export type RemoteOperation = z.infer<typeof remoteOperationSchema>;

export const cursorQuerySchema = z.object({
  afterSequence: z.number().int().nonnegative()
}).strict();
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export const timeCursorQuerySchema = z.object({
  after: z.string().datetime()
}).strict();
export type TimeCursorQuery = z.infer<typeof timeCursorQuerySchema>;

export const EPOCH_CURSOR = "1970-01-01T00:00:00.000Z";

export const cursorResponseSchema = z.object({
  operations: z.array(remoteOperationSchema),
  nextCursor: z.number().int().nonnegative()
}).strict();
export type CursorResponse = z.infer<typeof cursorResponseSchema>;

export const validationSchema = z.object({ id: z.string(), profile: z.string(), command: z.string(), exitCode: z.number().int(), durationMs: z.number().nonnegative(), tree: z.string().optional(), output: z.string(), runnerId: z.string(), createdAt: z.string().datetime() });
export type Validation = z.infer<typeof validationSchema>;

export const taskRequestSchema = z.object({
  title: z.string().trim().min(1).max(500),
  intent: z.string().trim().min(1).max(5_000).optional(),
  paths: z.array(z.string().min(1).max(1_024)).max(1_000).optional(),
  status: taskStatusSchema.optional()
}).strict();

export const claimRequestSchema = z.object({
  taskId: z.string().min(1).max(200),
  kind: z.enum(["path", "symbol", "interface"]),
  target: z.string().min(1).max(1_024),
  mode: z.enum(["exclusive-preferred", "shared"]),
  expiresAt: z.string().datetime().optional()
}).strict();

export const checkpointRequestSchema = z.object({
  message: z.string().trim().min(1).max(1_000).optional()
}).strict();

export const checkpointInspectRequestSchema = z.object({
  ref: z.string().min(1).max(2_000)
}).strict();

export const checkpointRestoreRequestSchema = z.object({
  ref: z.string().min(1).max(2_000),
  path: z.string().min(1).max(2_000)
}).strict();

export const validationRequestSchema = z.object({
  profile: z.string().trim().min(1).max(100)
}).strict();

export const publishRequestSchema = z.object({
  branch: z.string().min(1),
  profile: z.string().min(1),
  message: z.string().trim().min(1).max(1_000).optional(),
  dryRun: z.boolean().optional()
}).strict();

export const captureRequestSchema = z.object({
  intent: z.string().trim().min(1).max(5_000),
  kind: captureKindSchema.optional()
}).strict();

export const changeSummaryRequestSchema = z.object({
  summary: z.string().trim().min(1).max(5_000)
}).strict();

export const changeScopeRequestSchema = z.object({
  paths: z.array(z.string().min(1).max(1_024)).min(1).max(1_000)
}).strict();

export const handoffStatusSchema = z.enum(["pending", "accepted", "declined"]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

export const handoffSchema = z.object({
  id: z.string().min(1),
  operationId: z.string().min(1),
  requestedBy: z.string().min(1),
  note: z.string().optional(),
  status: handoffStatusSchema,
  createdAt: z.string().datetime(),
  respondedAt: z.string().datetime().optional()
}).strict();
export type Handoff = z.infer<typeof handoffSchema>;

export const handoffRequestSchema = z.object({
  operationId: z.string().min(1).max(200),
  note: z.string().trim().min(1).max(2_000).optional()
}).strict();

export const handoffDecisionSchema = z.enum(["accepted", "declined"]);

export const handoffRespondRequestSchema = z.object({
  decision: handoffDecisionSchema
}).strict();

export const handoffRequestedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("handoff.requested"),
  payload: handoffSchema
}).strict();
export type HandoffRequestedEvent = z.infer<typeof handoffRequestedEventSchema>;

export const handoffRespondedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("handoff.responded"),
  payload: handoffSchema
}).strict();
export type HandoffRespondedEvent = z.infer<typeof handoffRespondedEventSchema>;

export const remoteHandoffSchema = z.object({
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  senderReplicaId: z.string().min(1),
  handoff: handoffSchema,
  updatedAt: z.string().datetime()
}).strict();
export type RemoteHandoff = z.infer<typeof remoteHandoffSchema>;

export const handoffCursorResponseSchema = z.object({
  handoffs: z.array(remoteHandoffSchema),
  nextCursor: z.string().datetime()
}).strict();
export type HandoffCursorResponse = z.infer<typeof handoffCursorResponseSchema>;

export const handoffIngestRequestSchema = z.object({
  event: z.discriminatedUnion("type", [handoffRequestedEventSchema, handoffRespondedEventSchema])
}).strict().superRefine((request, context) => assertPayloadIdMatches(request.event, context));
export type HandoffIngestRequest = z.infer<typeof handoffIngestRequestSchema>;

export const handoffIngestReceiptSchema = z.object({
  eventId: z.string().min(1),
  handoffId: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict();
export type HandoffIngestReceipt = z.infer<typeof handoffIngestReceiptSchema>;

export const intentSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().optional(),
  actorId: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();
export type Intent = z.infer<typeof intentSchema>;

export const intentPublishedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("intent.published"),
  payload: intentSchema
}).strict();
export type IntentPublishedEvent = z.infer<typeof intentPublishedEventSchema>;

export const remoteIntentSchema = z.object({
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  senderReplicaId: z.string().min(1),
  intent: intentSchema,
  updatedAt: z.string().datetime()
}).strict();
export type RemoteIntent = z.infer<typeof remoteIntentSchema>;

export const intentCursorResponseSchema = z.object({
  intents: z.array(remoteIntentSchema),
  nextCursor: z.string().datetime()
}).strict();
export type IntentCursorResponse = z.infer<typeof intentCursorResponseSchema>;

export const intentIngestRequestSchema = z.object({
  event: intentPublishedEventSchema
}).strict().superRefine((request, context) => assertPayloadIdMatches(request.event, context));
export type IntentIngestRequest = z.infer<typeof intentIngestRequestSchema>;

export const intentIngestReceiptSchema = z.object({
  eventId: z.string().min(1),
  intentId: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict();
export type IntentIngestReceipt = z.infer<typeof intentIngestReceiptSchema>;

export const intentRequestSchema = z.object({
  text: z.string().trim().min(1).max(5_000),
  taskId: z.string().min(1).max(200).optional()
}).strict();

export const validationCompletedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal("validation.completed"),
  payload: validationSchema
}).strict();
export type ValidationCompletedEvent = z.infer<typeof validationCompletedEventSchema>;

export const remoteValidationSchema = z.object({
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  senderReplicaId: z.string().min(1),
  validation: validationSchema,
  createdAt: z.string().datetime()
}).strict();
export type RemoteValidation = z.infer<typeof remoteValidationSchema>;

export const validationCursorResponseSchema = z.object({
  validations: z.array(remoteValidationSchema),
  nextCursor: z.string().datetime()
}).strict();
export type ValidationCursorResponse = z.infer<typeof validationCursorResponseSchema>;

export const validationIngestRequestSchema = z.object({
  event: validationCompletedEventSchema
}).strict().superRefine((request, context) => assertPayloadIdMatches(request.event, context));
export type ValidationIngestRequest = z.infer<typeof validationIngestRequestSchema>;

export const validationIngestReceiptSchema = z.object({
  eventId: z.string().min(1),
  validationId: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();
export type ValidationIngestReceipt = z.infer<typeof validationIngestReceiptSchema>;

export const daemonConnectionSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  secret: z.string().min(1),
  startedAt: z.string().datetime()
}).strict();
export type DaemonConnection = z.infer<typeof daemonConnectionSchema>;

export const daemonServiceConfigSchema = z.object({
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" || (
      url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  }, "Service URL must use HTTPS or loopback HTTP"),
  replicaSecret: z.string().min(1).optional()
}).strict();
export type DaemonServiceConfig = z.infer<typeof daemonServiceConfigSchema>;

export const daemonConfigSchema = z.object({
  workspaceId: z.string().min(1),
  replicaId: z.string().min(1),
  actorId: z.string().min(1),
  service: daemonServiceConfigSchema.optional()
}).strict();
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export const wsSubscribeRequestSchema = z.object({
  type: z.literal("subscribe"),
  workspaceId: z.string().min(1),
  replicaId: z.string().min(1),
  accessToken: z.string().min(1)
}).strict();
export type WsSubscribeRequest = z.infer<typeof wsSubscribeRequestSchema>;

export const presenceStatusSchema = z.enum(["online", "idle", "offline"]);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

export const presenceUpdateSchema = z.object({
  replicaId: z.string().min(1),
  actorId: z.string().min(1),
  status: presenceStatusSchema,
  lastSeenAt: z.string().datetime()
}).strict();
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;

export const wsFanOutMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("operation"), operation: remoteOperationSchema }).strict(),
  z.object({ type: z.literal("presence"), presence: presenceUpdateSchema }).strict(),
  z.object({ type: z.literal("task"), task: remoteTaskSchema }).strict(),
  z.object({ type: z.literal("claim"), claim: remoteClaimSchema }).strict(),
  z.object({ type: z.literal("handoff"), handoff: remoteHandoffSchema }).strict(),
  z.object({ type: z.literal("intent"), intent: remoteIntentSchema }).strict(),
  z.object({ type: z.literal("validation"), validation: remoteValidationSchema }).strict()
]);
export type WsFanOutMessage = z.infer<typeof wsFanOutMessageSchema>;

export const wsSubscribeAckSchema = z.object({
  type: z.literal("subscribed"),
  cursor: z.number().int().nonnegative()
}).strict();
export type WsSubscribeAck = z.infer<typeof wsSubscribeAckSchema>;

export const semanticReviewRequestBodySchema = z.object({
  path: z.string().min(1).max(2_000),
  providerId: z.string().min(1).max(200)
}).strict();
export type SemanticReviewRequestBody = z.infer<typeof semanticReviewRequestBodySchema>;

export const acceptOperationRequestSchema = z.object({
  reviewApprovals: z.record(z.string().min(1).max(2_000), z.string().min(1)).optional()
}).strict().optional();
export type AcceptOperationRequest = z.infer<typeof acceptOperationRequestSchema>;

export const wsErrorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string().min(1)
}).strict();
export type WsErrorMessage = z.infer<typeof wsErrorMessageSchema>;
