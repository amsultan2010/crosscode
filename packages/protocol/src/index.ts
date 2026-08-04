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
  changes: z.array(z.object({ path: z.string().min(1), kind: z.enum(["add", "modify", "delete", "rename"]), previousPath: z.string().min(1).optional(), beforeHash: z.string().optional(), afterHash: z.string().optional(), unifiedPatch: z.string().optional(), afterContent: z.string().optional(), afterEncoding: z.enum(["utf8", "base64"]).optional() })).min(1),
  provenance: z.object({ source: z.enum(["filesystem", "cli-wrapper", "mcp", "hook", "extension"]), confidence: z.enum(["known", "inferred", "unknown"]) }),
  safety: z.object({ risk: riskSchema, requiresApproval: z.boolean() }),
  kind: captureKindSchema.optional()
}).strict().superRefine((transaction, context) => {
  transaction.changes.forEach((change, index) => {
    if (change.kind === "rename") {
      if (change.previousPath === undefined || change.previousPath === change.path) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", index, "previousPath"], message: "Rename changes require a previousPath different from path" });
      }
    } else if (change.previousPath !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", index, "previousPath"], message: "previousPath is only valid for rename changes" });
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

// repoRoot/repoRemote let a daemon declare which repository it is a replica of, so the
// service can upsert the matching project (Contract B) at registration time. Both are
// optional: a pre-projects daemon omits them and its replica keeps a null project_id.
export const registerReplicaRequestSchema = z.object({
  name: z.string().min(1),
  repoRoot: z.string().min(1).nullable().optional(),
  repoRemote: z.string().min(1).nullable().optional()
}).strict();
export type RegisterReplicaRequest = z.infer<typeof registerReplicaRequestSchema>;

export const registerReplicaResponseSchema = z.object({
  replicaId: z.string().min(1),
  createdAt: z.string().datetime(),
  // The project the reported repoRoot/repoRemote resolved to; null when the daemon
  // reported neither.
  projectId: z.string().min(1).nullable()
}).strict();
export type RegisterReplicaResponse = z.infer<typeof registerReplicaResponseSchema>;

export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(200)
}).strict();
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const createWorkspaceResponseSchema = z.object({
  workspaceId: z.string().min(1),
  memberId: z.string().min(1)
}).strict();
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;

// Invite roles exclude "owner": an invite link should never be able to mint another
// workspace owner, only the member/viewer roles addMember already allows a non-owner to hold.
export const inviteRoleSchema = z.enum(["member", "viewer"]);
export type InviteRole = z.infer<typeof inviteRoleSchema>;

export const createInviteRequestSchema = z.object({
  role: inviteRoleSchema.optional(),
  ttlSeconds: z.number().int().positive().max(30 * 24 * 60 * 60).optional()
}).strict();
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const inviteSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  code: z.string().min(1),
  role: workspaceRoleSchema,
  createdBy: z.string().min(1),
  expiresAt: z.string().datetime(),
  redeemedAt: z.string().datetime().nullable(),
  redeemedBy: z.string().nullable(),
  createdAt: z.string().datetime()
}).strict();
export type Invite = z.infer<typeof inviteSchema>;

export const listInvitesResponseSchema = z.object({
  invites: z.array(inviteSchema)
}).strict();
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;

export const redeemInviteResponseSchema = z.object({
  workspaceId: z.string().min(1),
  memberId: z.string().min(1),
  role: workspaceRoleSchema
}).strict();
export type RedeemInviteResponse = z.infer<typeof redeemInviteResponseSchema>;

// A paired device's `ccw_` token, secret excluded -- enough for a workspace owner to
// recognise a machine and decide whether to revoke it. The plaintext token is returned
// exactly once, by the pairing claim, and only its hash is ever stored.
export const workspaceTokenSummarySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  replicaId: z.string().min(1).nullable(),
  replicaName: z.string().min(1).nullable(),
  actorId: z.string(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime()
}).strict();
export type WorkspaceTokenSummary = z.infer<typeof workspaceTokenSummarySchema>;

export const listWorkspaceTokensResponseSchema = z.object({
  tokens: z.array(workspaceTokenSummarySchema)
}).strict();
export type ListWorkspaceTokensResponse = z.infer<typeof listWorkspaceTokensResponseSchema>;

// Removal is a soft disable, never a delete: operations and audit events reference the
// member row, so history has to stay attributable after someone leaves.
export const memberSummarySchema = z.object({
  memberId: z.string().min(1),
  actorId: z.string().min(1),
  role: workspaceRoleSchema,
  isPersonal: z.boolean(),
  disabledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime()
}).strict();
export type MemberSummary = z.infer<typeof memberSummarySchema>;

export const listMembersResponseSchema = z.object({
  members: z.array(memberSummarySchema)
}).strict();
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;

// A project is a repository inside a workspace (Contract B). repoRemote is the normalized
// dedup key when the checkout has a remote; repoRoot is the last absolute path a daemon
// reported and is advisory only -- it is the dedup key solely when repoRemote is null.
export const projectSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  repoRemote: z.string().nullable(),
  repoRoot: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime().nullable()
}).strict();
export type Project = z.infer<typeof projectSchema>;

// At least one key must be present, otherwise the upsert has nothing to dedup on.
export const upsertProjectRequestSchema = z.object({
  repoRoot: z.string().min(1).nullable().optional(),
  repoRemote: z.string().min(1).nullable().optional()
}).strict().refine(
  (body) => Boolean(body.repoRoot) || Boolean(body.repoRemote),
  { message: "Either repoRoot or repoRemote is required" }
);
export type UpsertProjectRequest = z.infer<typeof upsertProjectRequestSchema>;

export const listProjectsResponseSchema = z.object({
  projects: z.array(projectSchema)
}).strict();
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

// 0=always_ask (today's default), 1=auto_if_clean, 2=auto_always -- see BUILD_INSTRUCTIONS.md Phase 9.
export const workspaceAutonomyTierSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type WorkspaceAutonomyTier = z.infer<typeof workspaceAutonomyTierSchema>;

export const workspaceAutonomyResponseSchema = z.object({
  tier: workspaceAutonomyTierSchema
}).strict();
export type WorkspaceAutonomyResponse = z.infer<typeof workspaceAutonomyResponseSchema>;

export const workspaceBillingResponseSchema = z.object({
  workspaceId: z.string().min(1),
  plan: z.enum(["free", "essential", "pro", "unlimited", "team", "student"]),
  // null means unlimited (the plan's cap is Infinity server-side; JSON has no Infinity).
  seatCap: z.number().nullable(),
  currentMemberCount: z.number(),
  semanticReviewCallsPerMonth: z.number().nullable(),
  semanticReviewCallsUsedThisMonth: z.number(),
  autonomyTiers: z.array(z.enum(["always-ask", "auto-if-clean", "auto-always"])),
  historyRetentionDays: z.number()
}).strict();
export type WorkspaceBillingResponse = z.infer<typeof workspaceBillingResponseSchema>;

export const listMembershipsResponseSchema = z.object({
  memberships: z.array(z.object({
    workspaceId: z.string().min(1),
    workspaceName: z.string().min(1),
    role: workspaceRoleSchema
  }))
}).strict();
export type ListMembershipsResponse = z.infer<typeof listMembershipsResponseSchema>;

export const setWorkspaceAutonomyRequestSchema = z.object({
  tier: workspaceAutonomyTierSchema
}).strict();
export type SetWorkspaceAutonomyRequest = z.infer<typeof setWorkspaceAutonomyRequestSchema>;

// Pairing (docs/onboarding-contracts.md, Contract A). A workspace owner or member mints
// a code (`POST /v1/pairing-codes`), the
// user hands it to their coding agent, and the daemon redeems it unauthenticated -- the
// code itself is the credential, so it is short-lived (15 minutes), single-use, and only
// ever stored server-side as a SHA-256 hash.
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1_000;
// Crockford base32 minus the letters it deliberately excludes (I, L, O, U), so a code
// read aloud or retyped from a screen cannot be transcribed into a different valid code.
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const pairingCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, "Pairing codes look like XXXX-XXXX");
export type PairingCode = z.infer<typeof pairingCodeSchema>;

export const createPairingCodeResponseSchema = z.object({
  code: pairingCodeSchema,
  expiresAt: z.string().datetime(),
  pairingId: z.string().min(1)
}).strict();
export type CreatePairingCodeResponse = z.infer<typeof createPairingCodeResponseSchema>;

export const pairingStatusSchema = z.enum(["pending", "claimed", "expired"]);
export type PairingStatus = z.infer<typeof pairingStatusSchema>;

export const pairingStatusResponseSchema = z.object({
  status: pairingStatusSchema,
  claimedAt: z.string().datetime().nullable(),
  replicaId: z.string().min(1).nullable(),
  actorId: z.string().min(1).nullable()
}).strict();
export type PairingStatusResponse = z.infer<typeof pairingStatusResponseSchema>;

export const claimPairingCodeRequestSchema = z.object({
  code: pairingCodeSchema,
  actorId: z.string().min(1).max(200),
  replicaName: z.string().min(1).max(200),
  repoRoot: z.string().min(1).max(4_096),
  // Reported so the projects workstream can upsert a project from it; normalization and
  // the resulting projectId are entirely on that side of the seam (see Contract B).
  repoRemote: z.string().min(1).max(2_048).nullable()
}).strict();
export type ClaimPairingCodeRequest = z.infer<typeof claimPairingCodeRequestSchema>;

export const claimPairingCodeResponseSchema = z.object({
  workspaceId: z.string().min(1),
  replicaId: z.string().min(1),
  token: z.string().min(1),
  // Always null until the projects workstream extends the claim handler; the field is
  // declared now so the response shape never changes shape underneath a client.
  projectId: z.string().min(1).nullable()
}).strict();
export type ClaimPairingCodeResponse = z.infer<typeof claimPairingCodeResponseSchema>;

// Workspace service tokens: opaque, 32 random bytes base64url, scoped to one workspace.
// The service's bearer auth accepts either a Supabase JWT or one of these; the prefix is
// what lets it tell them apart before attempting (and failing) a JWT verification.
export const WORKSPACE_TOKEN_PREFIX = "ccw_";
export const workspaceTokenSchema = z.string().startsWith(WORKSPACE_TOKEN_PREFIX).min(WORKSPACE_TOKEN_PREFIX.length + 1);
export type WorkspaceToken = z.infer<typeof workspaceTokenSchema>;

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
  createdAt: z.string().datetime(),
  // The project the sending replica belongs to (Contract B), so a consumer can attribute
  // an edit to a repository. Null means the operation predates projects, or its replica
  // registered without reporting one -- consumers group those as "Unassigned".
  projectId: z.string().min(1).nullable()
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
  session: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.string().datetime()
  }).strict().optional(),
  // Set by `crosscode join --pair <code>`: a workspace-scoped service token standing in
  // for a Supabase session, so a paired install can reach the daemon ingest/read surface
  // without the terminal ever holding credentials that can act as the user.
  workspaceToken: workspaceTokenSchema.optional()
}).strict();
export type DaemonServiceConfig = z.infer<typeof daemonServiceConfigSchema>;

export const daemonConfigSchema = z.object({
  workspaceId: z.string().min(1),
  replicaId: z.string().min(1).optional(),
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
  lastSeenAt: z.string().datetime(),
  // Carried live for the same reason GET /v1/presence carries it: a consumer merges these
  // updates into its presence list, so without it a replica that connects after the
  // initial snapshot would lose its project attribution. Null when unattributed.
  projectId: z.string().min(1).nullable()
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
