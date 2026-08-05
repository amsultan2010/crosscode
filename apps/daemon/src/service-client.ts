import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  operationsResponseSchema,
  OPERATIONS_PROTOCOL_VERSION,
  registerReplicaRequestSchema,
  registerReplicaResponseSchema,
  serviceIngestReceiptSchema,
  transactionCreatedEventSchema,
  type DaemonConfig
} from "@crosscode/protocol";
import type { LocalOperation } from "./types.js";
import type { OutboundRecord } from "./state.js";
import type { RemoteCursorTooOld, RemoteSyncTransport } from "./index.js";
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
  // `ccw_` workspace token. The workspace token covers the daemon ingest/read surface
  // only and cannot be refreshed, so a 401 on it is terminal.
  private session: StoredSession | undefined;
  private readonly workspaceToken: string | undefined;

  constructor(
    private readonly identity: CoordinationServiceIdentity,
    private readonly service: NonNullable<DaemonConfig["service"]>,
    private readonly hooks: CoordinationServiceHooks = {}
  ) {
    if (!service.session && !service.workspaceToken) {
      throw new Error("Run 'crosscode login' before starting the daemon");
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
   * token, or the `ccw_` workspace token. The gateway accepts either.
   */
  async getValidAccessToken(): Promise<string> {
    if (!this.session) {
      if (this.workspaceToken) return this.workspaceToken;
      throw new Error("Live sync needs a credential; run 'crosscode login'");
    }
    if (isExpiringSoon(this.session.expiresAt)) await this.refreshAccessToken();
    return this.session.accessToken;
  }

  async refreshAccessToken(): Promise<string> {
    if (!this.session) throw new Error("Workspace tokens cannot be refreshed; run 'crosscode login' again");
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

  /**
   * `protocolVersion` tells the service this client understands the cursor-too-old status.
   * Without it the service answers an unservable cursor with 410 rather than a body an
   * older daemon could misread, so sending it is what opts this daemon into resynchronizing
   * instead of failing.
   */
  async list(after: number): Promise<{ operations: LocalOperation[]; nextCursor: number } | RemoteCursorTooOld> {
    const data = operationsResponseSchema.parse(
      await this.authorizedRequest(`/v1/operations?afterSequence=${after}&protocolVersion=${OPERATIONS_PROTOCOL_VERSION}`, "GET")
    );
    // History this device never downloaded is gone from the service entirely, and is
    // handled by the daemon adopting the watermark rather than by failing the sync.
    if ("status" in data) return { status: data.status, resyncFrom: data.resyncFrom, retentionDays: data.retentionDays };
    // Already validated: operationsResponseSchema parsed every entry through
    // remoteOperationSchema. Re-parsing each one here cost a second pass, inside the
    // daemon's exclusive lock, on every sync.
    const operations = data.operations.map((parsed) => ({
      id: parsed.id, workspaceId: parsed.workspaceId, senderReplicaId: parsed.senderReplicaId,
      transaction: parsed.transaction as LocalOperation["transaction"], sequence: parsed.serverSequence, createdAt: parsed.createdAt
    }));
    return { nextCursor: data.nextCursor, operations };
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
