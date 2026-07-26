import { z } from "zod";

export const riskSchema = z.enum(["low", "medium", "high", "critical"]);
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
  safety: z.object({ risk: riskSchema, requiresApproval: z.boolean() })
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

export const cursorResponseSchema = z.object({
  operations: z.array(remoteOperationSchema),
  nextCursor: z.number().int().nonnegative()
}).strict();
export type CursorResponse = z.infer<typeof cursorResponseSchema>;

export const validationSchema = z.object({ id: z.string(), profile: z.string(), command: z.string(), exitCode: z.number().int(), durationMs: z.number().nonnegative(), tree: z.string().optional(), output: z.string(), createdAt: z.string().datetime() });
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

export const captureRequestSchema = z.object({
  intent: z.string().trim().min(1).max(5_000)
}).strict();

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
  replicaSecret: z.string().min(1)
}).strict();
export type DaemonServiceConfig = z.infer<typeof daemonServiceConfigSchema>;

export const daemonConfigSchema = z.object({
  workspaceId: z.string().min(1),
  replicaId: z.string().min(1),
  actorId: z.string().min(1),
  service: daemonServiceConfigSchema.optional()
}).strict();
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;
