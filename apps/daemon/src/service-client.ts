import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  claimIngestReceiptSchema,
  claimCursorResponseSchema,
  cursorResponseSchema,
  handoffCursorResponseSchema,
  handoffIngestReceiptSchema,
  intentCursorResponseSchema,
  intentIngestReceiptSchema,
  registerReplicaRequestSchema,
  registerReplicaResponseSchema,
  remoteOperationSchema,
  serviceIngestReceiptSchema,
  setWorkspaceAutonomyRequestSchema,
  taskIngestReceiptSchema,
  taskCursorResponseSchema,
  transactionCreatedEventSchema,
  validationCursorResponseSchema,
  validationIngestReceiptSchema,
  workspaceAutonomyResponseSchema,
  type DaemonConfig,
  type RemoteClaim,
  type RemoteHandoff,
  type RemoteIntent,
  type RemoteTask,
  type RemoteValidation
} from "@crosscode/protocol";
import type { LocalOperation } from "./types.js";
import type { ClaimOutboundRecord, HandoffOutboundRecord, IntentOutboundRecord, OutboundRecord, TaskOutboundRecord, ValidationOutboundRecord } from "./state.js";
import type { RemoteSyncTransport } from "./index.js";
import { getSupabaseClient, toStoredSession, type StoredSession } from "./supabase-client.js";

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export type CoordinationServiceIdentity = Pick<DaemonConfig, "workspaceId" | "actorId"> & { replicaId?: string };

export type CoordinationServiceHooks = {
  onSessionRefreshed?: (session: StoredSession) => Promise<void> | void;
  onReplicaRegistered?: (replicaId: string) => Promise<void> | void;
};

/**
 * identity.replicaId is mutated in place by ensureReplicaRegistered() so callers that
 * hold a reference to the same identity object observe the newly assigned id.
 */
export class CoordinationServiceClient implements RemoteSyncTransport {
  // Exactly one of these is set: a Supabase session (from `crosscode login`) or a
  // `ccw_` workspace token (from `crosscode join --pair`). The workspace token covers the
  // daemon ingest/read surface only and cannot be refreshed, so a 401 on it is terminal.
  private session: StoredSession | undefined;
  private readonly workspaceToken: string | undefined;

  constructor(
    private readonly identity: CoordinationServiceIdentity,
    private readonly service: NonNullable<DaemonConfig["service"]>,
    private readonly hooks: CoordinationServiceHooks = {}
  ) {
    if (!service.session && !service.workspaceToken) {
      throw new Error("Run 'crosscode login' or 'crosscode join --pair <code>' before starting the daemon");
    }
    this.session = service.session;
    this.workspaceToken = service.workspaceToken;
  }

  get replicaId(): string | undefined {
    return this.identity.replicaId;
  }

  /**
   * `repo` tells the service which repository this replica is a checkout of, so it can
   * upsert the matching project (Contract B). It is optional: a daemon started outside a
   * git repository simply registers without one and its replica stays unattributed.
   */
  async ensureReplicaRegistered(name?: string, repo?: { repoRoot?: string | null; repoRemote?: string | null }): Promise<string> {
    if (this.identity.replicaId) return this.identity.replicaId;
    const data = await this.authorizedRequest("/v1/replicas", "POST", registerReplicaRequestSchema.parse({
      name: name ?? defaultReplicaName(),
      repoRoot: repo?.repoRoot ?? undefined,
      repoRemote: repo?.repoRemote ?? undefined
    }));
    const response = registerReplicaResponseSchema.parse(data);
    this.identity.replicaId = response.replicaId;
    await this.hooks.onReplicaRegistered?.(response.replicaId);
    return response.replicaId;
  }

  /**
   * The credential the live-sync WebSocket subscribes with: a refreshed Supabase access
   * token, or the `ccw_` workspace token when this install was paired rather than logged
   * in. The gateway accepts either, so a paired install gets live sync instead of being
   * left on the polling loop -- it already reaches the same ingest and read surface over
   * HTTP with this exact credential.
   */
  async getValidAccessToken(): Promise<string> {
    if (!this.session) {
      if (this.workspaceToken) return this.workspaceToken;
      throw new Error("Live sync needs a credential; run 'crosscode login' or 'crosscode join --pair <code>'");
    }
    if (isExpiringSoon(this.session.expiresAt)) await this.refreshAccessToken();
    return this.session.accessToken;
  }

  async refreshAccessToken(): Promise<string> {
    if (!this.session) throw new Error("Workspace tokens cannot be refreshed; run 'crosscode join --pair <code>' again");
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: this.session.refreshToken });
    if (error || !data.session) throw new Error(`Supabase session refresh failed: ${error?.message ?? "no session returned"}; run 'crosscode login' again`);
    this.session = toStoredSession(data.session);
    await this.hooks.onSessionRefreshed?.(this.session);
    return this.session.accessToken;
  }

  async upload(record: OutboundRecord): Promise<LocalOperation> {
    const event = transactionCreatedEventSchema.parse(record.event);
    const data = await this.authorizedRequest("/v1/events", "POST", { event });
    const receipt = serviceIngestReceiptSchema.parse(data);
    return {
      id: receipt.operationId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      transaction: record.transaction,
      sequence: receipt.serverSequence,
      createdAt: event.createdAt
    };
  }

  async list(after: number): Promise<{ operations: LocalOperation[]; nextCursor: number }> {
    const data = cursorResponseSchema.parse(await this.authorizedRequest(`/v1/operations?afterSequence=${after}`, "GET"));
    return {
      nextCursor: data.nextCursor,
      operations: data.operations.map((operation) => {
        const parsed = remoteOperationSchema.parse(operation);
        return { id: parsed.id, workspaceId: parsed.workspaceId, senderReplicaId: parsed.senderReplicaId, transaction: parsed.transaction, sequence: parsed.serverSequence, createdAt: parsed.createdAt };
      })
    };
  }

  async uploadTask(record: TaskOutboundRecord): Promise<RemoteTask> {
    const data = await this.authorizedRequest("/v1/tasks", "POST", { event: record.event });
    const receipt = taskIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      task: record.event.payload,
      updatedAt: receipt.updatedAt
    };
  }

  async listTasks(after: string): Promise<{ tasks: RemoteTask[]; nextCursor: string }> {
    const data = taskCursorResponseSchema.parse(await this.authorizedRequest(`/v1/tasks?after=${encodeURIComponent(after)}`, "GET"));
    return { tasks: data.tasks, nextCursor: data.nextCursor };
  }

  async uploadClaim(record: ClaimOutboundRecord): Promise<RemoteClaim> {
    const data = await this.authorizedRequest("/v1/claims", "POST", { event: record.event });
    const receipt = claimIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      claim: record.event.payload,
      released: record.event.type === "claim.released",
      updatedAt: receipt.updatedAt
    };
  }

  async listClaims(after: string): Promise<{ claims: RemoteClaim[]; nextCursor: string }> {
    const data = claimCursorResponseSchema.parse(await this.authorizedRequest(`/v1/claims?after=${encodeURIComponent(after)}`, "GET"));
    return { claims: data.claims, nextCursor: data.nextCursor };
  }

  async uploadHandoff(record: HandoffOutboundRecord): Promise<RemoteHandoff> {
    const data = await this.authorizedRequest("/v1/handoffs", "POST", { event: record.event });
    const receipt = handoffIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      handoff: record.event.payload,
      updatedAt: receipt.updatedAt
    };
  }

  async listHandoffs(after: string): Promise<{ handoffs: RemoteHandoff[]; nextCursor: string }> {
    const data = handoffCursorResponseSchema.parse(await this.authorizedRequest(`/v1/handoffs?after=${encodeURIComponent(after)}`, "GET"));
    return { handoffs: data.handoffs, nextCursor: data.nextCursor };
  }

  async uploadIntent(record: IntentOutboundRecord): Promise<RemoteIntent> {
    const data = await this.authorizedRequest("/v1/intents", "POST", { event: record.event });
    const receipt = intentIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      intent: record.event.payload,
      updatedAt: receipt.updatedAt
    };
  }

  async listIntents(after: string): Promise<{ intents: RemoteIntent[]; nextCursor: string }> {
    const data = intentCursorResponseSchema.parse(await this.authorizedRequest(`/v1/intents?after=${encodeURIComponent(after)}`, "GET"));
    return { intents: data.intents, nextCursor: data.nextCursor };
  }

  async uploadValidation(record: ValidationOutboundRecord): Promise<RemoteValidation> {
    const data = await this.authorizedRequest("/v1/validations", "POST", { event: record.event });
    const receipt = validationIngestReceiptSchema.parse(data);
    return {
      eventId: receipt.eventId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.requireReplicaId(),
      validation: record.event.payload,
      createdAt: receipt.createdAt
    };
  }

  async listValidations(after: string): Promise<{ validations: RemoteValidation[]; nextCursor: string }> {
    const data = validationCursorResponseSchema.parse(await this.authorizedRequest(`/v1/validations?after=${encodeURIComponent(after)}`, "GET"));
    return { validations: data.validations, nextCursor: data.nextCursor };
  }

  async getAutonomyTier(): Promise<0 | 1 | 2> {
    const data = workspaceAutonomyResponseSchema.parse(await this.authorizedRequest("/v1/workspace/autonomy", "GET"));
    return data.tier;
  }

  async setAutonomyTier(tier: 0 | 1 | 2): Promise<0 | 1 | 2> {
    const data = workspaceAutonomyResponseSchema.parse(await this.authorizedRequest("/v1/workspace/autonomy", "PUT", setWorkspaceAutonomyRequestSchema.parse({ tier })));
    return data.tier;
  }

  private requireReplicaId(): string {
    if (!this.identity.replicaId) throw new Error("Replica is not registered yet; call ensureReplicaRegistered() first");
    return this.identity.replicaId;
  }

  private async authorizedRequest(path: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<unknown> {
    if (!this.session) {
      return request(this.service.url, path, method, this.workspaceToken, body, true, this.identity.workspaceId);
    }
    try {
      return await request(this.service.url, path, method, this.session.accessToken, body, true, this.identity.workspaceId);
    } catch (error) {
      // A 401 is the one failure worth a second attempt, and only after refreshing:
      // the access token is short-lived and rotating it is exactly what fixes it.
      // Anything else -- including a network failure, which request() has already
      // retried internally -- propagates. Re-issuing it here discarded the original
      // error and quietly turned one timed-out upload into four sends.
      if (!(error instanceof ServiceHttpError) || error.status !== 401) throw error;
      await this.refreshAccessToken();
      return request(this.service.url, path, method, this.session!.accessToken, body, true, this.identity.workspaceId);
    }
  }
}

function isExpiringSoon(expiresAt: string, bufferMs = 30_000): boolean {
  return new Date(expiresAt).getTime() - Date.now() <= bufferMs;
}

function defaultReplicaName(): string {
  return `${hostname()}-${randomUUID().slice(0, 6)}`;
}

class ServiceHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request(url: string, path: string, method: "GET" | "POST" | "PUT", token?: string, body?: unknown, retryNetwork = true, workspaceId?: string): Promise<unknown> {
  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < (retryNetwork ? 2 : 1); attempt += 1) {
    try {
      response = await fetch(new URL(path, url), {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(workspaceId ? { "x-crosscode-workspace-id": workspaceId } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000)
      });
      break;
    } catch (error) { lastError = error; }
  }
  if (!response) throw lastError;
  const envelope = await response.json().catch(() => undefined) as Envelope<unknown> | undefined;
  if (!response.ok || !envelope?.ok) throw new ServiceHttpError(response.status, envelope && !envelope.ok ? envelope.error : `Service request failed with status ${response.status}`);
  return envelope.data;
}
