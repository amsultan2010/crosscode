import { z } from "zod";

export const riskSchema = z.enum(["low", "medium", "high", "critical"]);
export const captureKindSchema = z.enum(["intent", "summary", "interface-change"]);
export type CaptureKind = z.infer<typeof captureKindSchema>;

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

export const planSchema = z.enum(["free", "essential", "pro", "unlimited", "team", "student"]);
export type PlanName = z.infer<typeof planSchema>;

/** Every plan a checkout can be started for. Free is reached by cancelling, not by buying. */
export const paidPlanSchema = z.enum(["essential", "pro", "unlimited", "team", "student"]);
export type PaidPlanName = z.infer<typeof paidPlanSchema>;

export const billingIntervalSchema = z.enum(["month", "year"]);
export type BillingIntervalName = z.infer<typeof billingIntervalSchema>;

export const workspaceBillingResponseSchema = z.object({
  workspaceId: z.string().min(1),
  // The plan whose limits are in force right now. During a payment grace period this is
  // still the paid plan; once the grace period lapses it becomes "free" while billingPlan
  // keeps naming what was being paid for.
  plan: planSchema,
  // null means unlimited (the plan's cap is Infinity server-side; JSON has no Infinity).
  seatCap: z.number().nullable(),
  currentMemberCount: z.number(),
  semanticReviewCallsPerMonth: z.number().nullable(),
  semanticReviewCallsUsedThisMonth: z.number(),
  autonomyTiers: z.array(z.enum(["always-ask", "auto-if-clean", "auto-always"])),
  historyRetentionDays: z.number(),
  billingPlan: paidPlanSchema.nullable(),
  billingInterval: billingIntervalSchema.nullable(),
  /** The payment provider's subscription status verbatim, for diagnosis. */
  billingStatus: z.string().nullable(),
  billingSeats: z.number().nullable(),
  /** Set only while a payment is failing: the deadline after which free's limits apply. */
  gracePeriodEndsAt: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodEnd: z.string().datetime().nullable(),
  billingOwnerActorId: z.string().nullable(),
  priceCents: z.number().nullable()
}).strict();
export type WorkspaceBillingResponse = z.infer<typeof workspaceBillingResponseSchema>;

// Annual is the default when the caller does not say, because at these prices the payment
// processor's fixed fee eats ~15% of a monthly charge against ~4% of an annual one.
export const startCheckoutRequestSchema = z.object({
  plan: paidPlanSchema,
  interval: billingIntervalSchema.default("year"),
  /** Team only; ignored on flat-priced plans, where the quantity is always 1. */
  seats: z.number().int().positive().max(10_000).optional()
}).strict();
export type StartCheckoutRequest = z.infer<typeof startCheckoutRequestSchema>;

export const startCheckoutResponseSchema = z.object({
  // "checkout" means follow `url` to enter a card; "updated" means an existing
  // subscription was moved in place and prorated, so there is nothing to open.
  mode: z.enum(["checkout", "updated"]),
  plan: paidPlanSchema,
  interval: billingIntervalSchema,
  seats: z.number().int().positive(),
  url: z.string().url().nullable(),
  priceCents: z.number().int().nonnegative(),
  /** What the same plan would cost on the other interval, for the CLI's savings copy. */
  monthlyEquivalentCents: z.number().int().nonnegative()
}).strict();
export type StartCheckoutResponse = z.infer<typeof startCheckoutResponseSchema>;

export const cancelSubscriptionResponseSchema = z.object({
  // The plan stays in force until the paid period ends; cancelling never takes effect
  // immediately and never deletes workspace data.
  plan: planSchema,
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodEnd: z.string().datetime().nullable()
}).strict();
export type CancelSubscriptionResponse = z.infer<typeof cancelSubscriptionResponseSchema>;

export const billingPortalResponseSchema = z.object({
  url: z.string().url()
}).strict();
export type BillingPortalResponse = z.infer<typeof billingPortalResponseSchema>;

export const listMembershipsResponseSchema = z.object({
  memberships: z.array(z.object({
    workspaceId: z.string().min(1),
    workspaceName: z.string().min(1),
    role: workspaceRoleSchema,
    // Contract C's auto-provisioned workspace, which is what `crosscode start` attaches a
    // checkout to when it has not been pointed at a team. Optional so a client built
    // against this schema still parses a response from a service deployed before the field
    // existed; a client that sees it missing everywhere falls back to "the only membership".
    isPersonal: z.boolean().optional()
  }))
}).strict();
export type ListMembershipsResponse = z.infer<typeof listMembershipsResponseSchema>;

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

export const cursorResponseSchema = z.object({
  operations: z.array(remoteOperationSchema),
  nextCursor: z.number().int().nonnegative()
}).strict();
export type CursorResponse = z.infer<typeof cursorResponseSchema>;

/**
 * Version of the `GET /v1/operations` read surface the client understands, sent as a
 * `protocolVersion` query parameter. Distinct from the envelope's `schemaVersion`, which
 * versions event shapes rather than this endpoint's answers.
 *
 * 1 -> 2 added the cursor-too-old status below. A daemon that predates it sends nothing
 * (so the service reads version 1) and is refused with `410 Gone` instead: it would parse
 * the status body with cursorResponseSchema, which is `.strict()` and has no `status` key,
 * so it cannot mistake it for a page -- but a hard HTTP failure it already surfaces as a
 * sync error is a much clearer answer than a validation crash.
 */
export const OPERATIONS_PROTOCOL_VERSION = 2;

/**
 * Retention has deleted the operations this cursor asks for, so no page can answer it
 * honestly. `resyncFrom` is the oldest cursor the service can still serve completely; a
 * replica adopts it and continues from there, accepting that proposals inside the deleted
 * range are gone. That is safe because Git, not this history, is the source of truth --
 * what is lost is unreviewed proposals, never committed or working-tree work.
 */
export const cursorTooOldResponseSchema = z.object({
  status: z.literal("cursor-too-old"),
  protocolVersion: z.literal(OPERATIONS_PROTOCOL_VERSION),
  resyncFrom: z.number().int().nonnegative(),
  retentionDays: z.number().int().positive()
}).strict();
export type CursorTooOldResponse = z.infer<typeof cursorTooOldResponseSchema>;

/** What `GET /v1/operations` answers a `protocolVersion=2` client: a page, or a resync order. */
export const operationsResponseSchema = z.union([cursorResponseSchema, cursorTooOldResponseSchema]);
export type OperationsResponse = z.infer<typeof operationsResponseSchema>;

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
  }).strict().optional()
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
  z.object({ type: z.literal("presence"), presence: presenceUpdateSchema }).strict()
]);
export type WsFanOutMessage = z.infer<typeof wsFanOutMessageSchema>;

export const wsSubscribeAckSchema = z.object({
  type: z.literal("subscribed"),
  cursor: z.number().int().nonnegative()
}).strict();
export type WsSubscribeAck = z.infer<typeof wsSubscribeAckSchema>;

export const wsErrorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string().min(1)
}).strict();
export type WsErrorMessage = z.infer<typeof wsErrorMessageSchema>;
