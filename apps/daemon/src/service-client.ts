import {
  claimIngestReceiptSchema,
  claimCursorResponseSchema,
  cursorResponseSchema,
  enrollmentResponseSchema,
  handoffCursorResponseSchema,
  handoffIngestReceiptSchema,
  intentCursorResponseSchema,
  intentIngestReceiptSchema,
  remoteOperationSchema,
  replicaTokenExchangeResponseSchema,
  serviceIngestReceiptSchema,
  taskIngestReceiptSchema,
  taskCursorResponseSchema,
  transactionCreatedEventSchema,
  validationCursorResponseSchema,
  validationIngestReceiptSchema,
  type DaemonConfig,
  type EnrollmentResponse,
  type RemoteClaim,
  type RemoteHandoff,
  type RemoteIntent,
  type RemoteTask,
  type RemoteValidation
} from "@crosscode/protocol";
import type { RemoteOperation } from "../../service/src/index.js";
import type { ClaimOutboundRecord, HandoffOutboundRecord, IntentOutboundRecord, OutboundRecord, TaskOutboundRecord, ValidationOutboundRecord } from "./state.js";
import type { RemoteSyncTransport } from "./index.js";

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export class CoordinationServiceClient implements RemoteSyncTransport {
  private accessToken?: string;

  constructor(private readonly identity: Pick<DaemonConfig, "workspaceId" | "actorId" | "replicaId">, private readonly service: NonNullable<DaemonConfig["service"]>) {}

  static async enroll(url: string, token: string): Promise<EnrollmentResponse> {
    return enrollmentResponseSchema.parse(await request(url, "/v1/enroll", "POST", undefined, { token }, false));
  }

  async upload(record: OutboundRecord): Promise<RemoteOperation> {
    const event = transactionCreatedEventSchema.parse(record.event);
    const data = await this.authorizedRequest("/v1/events", "POST", { event });
    const receipt = serviceIngestReceiptSchema.parse(data);
    return {
      id: receipt.operationId,
      workspaceId: this.identity.workspaceId,
      senderReplicaId: this.identity.replicaId,
      transaction: record.transaction,
      sequence: receipt.serverSequence,
      createdAt: event.createdAt
    };
  }

  async list(after: number): Promise<{ operations: RemoteOperation[]; nextCursor: number }> {
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
      senderReplicaId: this.identity.replicaId,
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
      senderReplicaId: this.identity.replicaId,
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
      senderReplicaId: this.identity.replicaId,
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
      senderReplicaId: this.identity.replicaId,
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
      senderReplicaId: this.identity.replicaId,
      validation: record.event.payload,
      createdAt: receipt.createdAt
    };
  }

  async listValidations(after: string): Promise<{ validations: RemoteValidation[]; nextCursor: string }> {
    const data = validationCursorResponseSchema.parse(await this.authorizedRequest(`/v1/validations?after=${encodeURIComponent(after)}`, "GET"));
    return { validations: data.validations, nextCursor: data.nextCursor };
  }

  private async authorizedRequest(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    if (!this.accessToken) await this.refresh();
    try { return await request(this.service.url, path, method, this.accessToken, body); }
    catch (error) {
      if (error instanceof ServiceHttpError) {
        if (error.status !== 401) throw error;
        await this.refresh();
        return request(this.service.url, path, method, this.accessToken, body);
      }
      return request(this.service.url, path, method, this.accessToken, body);
    }
  }

  private async refresh(): Promise<void> {
    this.accessToken = await fetchAccessToken(this.service.url, this.identity, this.service);
  }
}

export async function fetchAccessToken(
  url: string,
  identity: Pick<DaemonConfig, "workspaceId" | "actorId" | "replicaId">,
  service: Pick<NonNullable<DaemonConfig["service"]>, "replicaSecret">
): Promise<string> {
  const data = await request(url, "/v1/token", "POST", undefined, {
    workspaceId: identity.workspaceId,
    actorId: identity.actorId,
    replicaId: identity.replicaId,
    replicaSecret: service.replicaSecret
  });
  return replicaTokenExchangeResponseSchema.parse(data).accessToken;
}

class ServiceHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request(url: string, path: string, method: "GET" | "POST", token?: string, body?: unknown, retryNetwork = true): Promise<unknown> {
  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < (retryNetwork ? 2 : 1); attempt += 1) {
    try {
      response = await fetch(new URL(path, url), {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
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
