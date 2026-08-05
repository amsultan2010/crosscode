import { z } from "zod";

// The wire contract for real-time file sync. One file is one change; there are no
// bundles, no transactions, and no accept/reject lifecycle. Every workstream builds
// against this file, so keep it small and keep it honest.
//
// The old transaction-shaped schemas still live in ./index.ts because the code being
// replaced still imports them. They get deleted when their last consumer does, not
// before -- deleting an export ahead of its consumer is what forced a full revert last time.

export const PROTOCOL_VERSION = 3;

/* ------------------------------------------------------------------ sync unit */

/** `delete` carries no content; without this field a delete looks like an empty file. */
export const fileOpSchema = z.enum(["modify", "delete"]);
export type FileOp = z.infer<typeof fileOpSchema>;

export const fileVersionSchema = z.object({
  path: z.string().min(1),
  op: fileOpSchema,
  /** Hash of the content the sender edited from. Resolves the 3-way merge base. */
  baseHash: z.string().min(1).nullable(),
  /** Hash of the result. null for a delete. Doubles as the loop-suppression key. */
  contentHash: z.string().min(1).nullable(),
  /** Exactly one of these is set for a modify; neither for a delete. */
  content: z.string().optional(),
  patch: z.string().optional(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  /** Renames travel as delete + modify; this links them so a conflict can say where it went. */
  renamedFrom: z.string().min(1).optional()
}).strict().superRefine((version, context) => {
  if (version.op === "delete") {
    if (version.content !== undefined || version.patch !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A delete carries no content" });
    }
    if (version.contentHash !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A delete has no contentHash" });
    }
    return;
  }
  if ((version.content === undefined) === (version.patch === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A modify needs exactly one of content or patch" });
  }
  if (version.contentHash === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A modify needs a contentHash" });
  }
  // A patch is meaningless without the base it applies to; full content stands alone.
  if (version.patch !== undefined && version.baseHash === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A patch needs a baseHash" });
  }
});
export type FileVersion = z.infer<typeof fileVersionSchema>;

/** A file version as the service stored it: sender and ordering attached. */
export const changeSchema = z.object({
  sequence: z.number().int().positive(),
  projectId: z.string().min(1),
  branch: z.string().min(1),
  replicaId: z.string().min(1),
  createdAt: z.string().datetime(),
  version: fileVersionSchema
}).strict();
export type Change = z.infer<typeof changeSchema>;

/* -------------------------------------------------------------------- conflict */

/** Surfaced to the user's own agent. Crosscode never resolves one itself. */
export const conflictSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  detectedAt: z.string().datetime(),
  /** The three sides a 3-way merge needs, as text. Binary conflicts omit them. */
  ours: z.string().nullable(),
  theirs: z.string().nullable(),
  ancestor: z.string().nullable(),
  binary: z.boolean().default(false),
  renamedFrom: z.string().min(1).optional(),
  peer: z.string().min(1).optional()
}).strict();
export type Conflict = z.infer<typeof conflictSchema>;

/* ---------------------------------------------------------------------- routes */

export const createProjectRequestSchema = z.object({
  name: z.string().min(1).max(200),
  /** `owner/repo`. Identifies the room and gates invite redemption. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/)
}).strict();
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const syncProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  repo: z.string().min(1),
  plan: z.string().min(1).default("free"),
  createdAt: z.string().datetime()
}).strict();
export type SyncProject = z.infer<typeof syncProjectSchema>;

export const createInviteRequestSchema = z.object({
  projectId: z.string().min(1),
  expiresInHours: z.number().int().positive().max(720).default(168)
}).strict();
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const syncInviteSchema = z.object({
  /** The human-typed form: CC-7F3A-9C2E. */
  code: z.string().regex(/^CC-[0-9A-Z]{4}-[0-9A-Z]{4}$/),
  url: z.string().url(),
  projectId: z.string().min(1),
  repo: z.string().min(1),
  expiresAt: z.string().datetime()
}).strict();
export type SyncInvite = z.infer<typeof syncInviteSchema>;

export const redeemSyncInviteResponseSchema = z.object({
  projectId: z.string().min(1),
  repo: z.string().min(1),
  cloneCommand: z.string().min(1)
}).strict();
export type RedeemSyncInviteResponse = z.infer<typeof redeemSyncInviteResponseSchema>;

export const registerSyncReplicaRequestSchema = z.object({
  projectId: z.string().min(1),
  branch: z.string().min(1)
}).strict();
export type RegisterSyncReplicaRequest = z.infer<typeof registerSyncReplicaRequestSchema>;

export const registerSyncReplicaResponseSchema = z.object({
  replicaId: z.string().min(1),
  /** Where to resume from. 0 means a fresh replica with no history. */
  cursor: z.number().int().nonnegative()
}).strict();
export type RegisterSyncReplicaResponse = z.infer<typeof registerSyncReplicaResponseSchema>;

export const publishChangesRequestSchema = z.object({
  projectId: z.string().min(1),
  branch: z.string().min(1),
  replicaId: z.string().min(1),
  versions: z.array(fileVersionSchema).min(1).max(500)
}).strict();
export type PublishChangesRequest = z.infer<typeof publishChangesRequestSchema>;

export const publishChangesResponseSchema = z.object({
  /** Highest sequence assigned by this call. */
  cursor: z.number().int().positive()
}).strict();
export type PublishChangesResponse = z.infer<typeof publishChangesResponseSchema>;

export const listChangesQuerySchema = z.object({
  projectId: z.string().min(1),
  branch: z.string().min(1),
  since: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(500).default(200)
}).strict();
export type ListChangesQuery = z.infer<typeof listChangesQuerySchema>;

export const listChangesResponseSchema = z.object({
  changes: z.array(changeSchema),
  cursor: z.number().int().nonnegative()
}).strict();
export type ListChangesResponse = z.infer<typeof listChangesResponseSchema>;

/**
 * `since` predates retention, so the gap cannot be filled incrementally. The daemon must
 * resync from full content rather than read this as "nothing new".
 */
export const syncCursorTooOldSchema = z.object({
  status: z.literal("cursor-too-old"),
  resyncFrom: z.number().int().nonnegative(),
  retentionDays: z.number().int().positive()
}).strict();
export type SyncCursorTooOld = z.infer<typeof syncCursorTooOldSchema>;

export const changesResponseSchema = z.union([listChangesResponseSchema, syncCursorTooOldSchema]);
export type ChangesResponse = z.infer<typeof changesResponseSchema>;

/* ------------------------------------------------------------------- websocket */

export const presenceSchema = z.object({
  replicaId: z.string().min(1),
  actor: z.string().min(1),
  branch: z.string().min(1),
  /** Paths touched recently, so an agent can answer "who is working on what". */
  paths: z.array(z.string().min(1)).max(50),
  /**
   * The commit this replica's branch is on. Crosscode never syncs commits, but a peer that
   * has committed is a peer whose teammates now need to pull, and this is the only thing on
   * the wire that says so. Optional: a replica that has not announced one is unknown, not
   * up to date.
   */
  head: z.string().min(1).optional()
}).strict();
export type Presence = z.infer<typeof presenceSchema>;

export const wsSubscribeSchema = z.object({
  type: z.literal("subscribe"),
  projectId: z.string().min(1),
  branch: z.string().min(1),
  replicaId: z.string().min(1),
  since: z.number().int().nonnegative()
}).strict();

export const wsChangeSchema = z.object({ type: z.literal("change"), change: changeSchema }).strict();
export const wsPresenceSchema = z.object({ type: z.literal("presence"), peers: z.array(presenceSchema) }).strict();
export const wsSyncErrorSchema = z.object({ type: z.literal("error"), message: z.string().min(1) }).strict();

export const wsSyncServerMessageSchema = z.union([wsChangeSchema, wsPresenceSchema, wsSyncErrorSchema]);
export type WsSyncServerMessage = z.infer<typeof wsSyncServerMessageSchema>;
export const wsSyncClientMessageSchema = z.union([wsSubscribeSchema, wsPresenceSchema]);
export type WsSyncClientMessage = z.infer<typeof wsSyncClientMessageSchema>;

/* ---------------------------------------------------- daemon config + local API */

export const syncDaemonConfigSchema = z.object({
  projectId: z.string().min(1),
  repo: z.string().min(1),
  service: z.object({
    url: z.string().url(),
    session: z.object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
      expiresAt: z.string().datetime()
    }).optional()
  })
}).strict();
export type SyncDaemonConfig = z.infer<typeof syncDaemonConfigSchema>;

/** What `crosscode status` and the MCP `status` tool both return. */
export const syncStatusSchema = z.object({
  branch: z.string().min(1),
  connected: z.boolean(),
  paused: z.boolean(),
  cursor: z.number().int().nonnegative(),
  pendingConflicts: z.number().int().nonnegative(),
  peers: z.array(presenceSchema),
  /** The commit this checkout is on, so an agent can see it move. Absent before the first commit. */
  head: z.string().min(1).nullable().optional(),
  /**
   * Something the agent should act on that is not a conflict -- today, only "a teammate has
   * committed, this checkout needs a pull". Absent when there is nothing to say.
   */
  notice: z.string().min(1).optional()
}).strict();
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const resolveConflictRequestSchema = z.object({
  conflictId: z.string().min(1),
  /** The agent's merged result. Written to disk and republished. */
  content: z.string()
}).strict();
export type ResolveConflictRequest = z.infer<typeof resolveConflictRequestSchema>;

export const pauseRequestSchema = z.object({ paused: z.boolean() }).strict();
export type PauseRequest = z.infer<typeof pauseRequestSchema>;
