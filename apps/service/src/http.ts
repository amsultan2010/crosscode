import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  claimIngestRequestSchema,
  claimIngestReceiptSchema,
  createInviteRequestSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  cursorQuerySchema,
  handoffIngestRequestSchema,
  handoffIngestReceiptSchema,
  intentIngestRequestSchema,
  intentIngestReceiptSchema,
  inviteSchema,
  listInvitesResponseSchema,
  redeemInviteResponseSchema,
  registerReplicaRequestSchema,
  registerReplicaResponseSchema,
  serviceIngestReceiptSchema,
  serviceIngestRequestSchema,
  setWorkspaceAutonomyRequestSchema,
  workspaceBillingResponseSchema,
  listMembershipsResponseSchema,
  taskIngestRequestSchema,
  taskIngestReceiptSchema,
  timeCursorQuerySchema,
  validationIngestRequestSchema,
  validationIngestReceiptSchema,
  workspaceAutonomyResponseSchema,
  EPOCH_CURSOR,
  type RemoteOperation
} from "@crosscode/protocol";
import { contentHash, redactPath } from "@crosscode/core";
import { ZodError } from "zod";
import type { JWTVerifyGetKey } from "jose";
import { verifySupabaseAccessToken } from "./auth.js";
import { PgStore, StoreConflictError, StoreUnauthorizedError, type Membership, type StoredOperation } from "./store.js";
import { attachWebSocketGateway } from "./ws.js";
import { getWorkspaceBillingStatus } from "./billing.js";

export type ServiceServerOptions = {
  store: PgStore;
  jwks: JWTVerifyGetKey;
  supabaseUrl: string;
  bodyLimitBytes?: number;
  tls?: { key: string | Buffer; cert: string | Buffer };
};

const JSON_TYPE = "application/json";

// Supabase-issued access tokens only carry the auth.users id (sub) — they no longer
// embed a workspaceId/replicaId the way Crosscode-issued tokens did. Every authenticated
// request must therefore say which workspace it targets via this header, since
// authenticate() runs before (and, for GET routes, without) a request body to read a
// workspaceId from. POST bodies still carry their own event.workspaceId, which is
// checked against this header for a redundant principal-binding match.
const WORKSPACE_HEADER = "x-crosscode-workspace-id";

export function assertSafeServiceBinding(host: string, tlsEnabled: boolean): void {
  if (!isLoopback(host) && !tlsEnabled) {
    throw new Error(`Refusing non-loopback HTTP binding for ${host}; configure TLS`);
  }
}

export function createServiceServer(options: ServiceServerOptions): Server {
  const limiter = new FixedWindowRateLimiter();
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, options, limiter, gateway).catch((error: unknown) => {
      sendError(response, statusFor(error), messageFor(error));
    });
  };
  const server = options.tls ? createHttpsServer(options.tls, listener) : createHttpServer(listener);
  const gateway = attachWebSocketGateway(server, options);
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServiceServerOptions,
  limiter: FixedWindowRateLimiter,
  gateway: ReturnType<typeof attachWebSocketGateway>
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://service.local");
  const route = rateLimitRoute(method, url.pathname);
  const remote = request.socket.remoteAddress ?? "unknown";
  const rate = route === "POST /v1/replicas" ? 10 : 300;
  if (!limiter.take(`${remote}:${route}`, rate)) {
    response.setHeader("retry-after", "60");
    sendError(response, 429, "Rate limit exceeded");
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    send(response, 200, { status: "ok" });
    return;
  }

  // These two routes are reachable by a freshly authenticated Supabase user who is not
  // (yet) a member of any workspace, so they verify the bearer token only -- not the full
  // authenticate() below, which requires an existing membership resolved via the
  // WORKSPACE_HEADER.
  if (method === "POST" && url.pathname === "/v1/workspaces") {
    const { userId, email } = await verifyToken(request, options);
    const body = createWorkspaceRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    const created = await options.store.createWorkspace({ workspaceName: body.name, userId, actorId: email ?? userId });
    send(response, 201, createWorkspaceResponseSchema.parse(created));
    return;
  }

  const redeemMatch = method === "POST" ? url.pathname.match(/^\/v1\/invites\/([^/]+)\/redeem$/) : null;
  if (redeemMatch) {
    const { userId, email } = await verifyToken(request, options);
    const redeemed = await options.store.redeemInvite({ code: decodeURIComponent(redeemMatch[1]!), userId, actorId: email ?? userId });
    send(response, 200, redeemInviteResponseSchema.parse(redeemed));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/memberships") {
    const { userId } = await verifyToken(request, options);
    const memberships = await options.store.listMembershipsForUser(userId);
    send(response, 200, listMembershipsResponseSchema.parse({
      memberships: memberships.map((m) => ({ workspaceId: m.workspaceId, workspaceName: m.workspaceName, role: m.role }))
    }));
    return;
  }

  const identity = await authenticate(request, options);
  if (method === "POST" && url.pathname === "/v1/invites") {
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can create invites");
    const body = createInviteRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    const invite = await options.store.createInvite(identity, { role: body.role, ttlMs: body.ttlSeconds ? body.ttlSeconds * 1_000 : undefined });
    send(response, 201, inviteSchema.parse(invite));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/invites") {
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can list invites");
    const invites = await options.store.listInvites(identity);
    send(response, 200, listInvitesResponseSchema.parse({ invites }));
    return;
  }

  const deleteInviteMatch = method === "DELETE" ? url.pathname.match(/^\/v1\/invites\/([^/]+)$/) : null;
  if (deleteInviteMatch) {
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can revoke invites");
    await options.store.revokeInvite(identity, decodeURIComponent(deleteInviteMatch[1]!));
    send(response, 200, { revoked: true });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/replicas") {
    const body = registerReplicaRequestSchema.parse(
      await readJson(request, Math.min(options.bodyLimitBytes ?? 1_048_576, 16_384))
    );
    const replica = await options.store.registerReplica(identity.userId, identity.workspaceId, body.name);
    send(response, 201, registerReplicaResponseSchema.parse(replica));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/events") {
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership is read-only");
    const body = serviceIngestRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    if (body.event.serverSequence !== undefined) throw new HttpError(400, "Clients may not assign serverSequence");
    if (new Set(body.event.payload.changes.map((change) => change.path)).size !== body.event.payload.changes.length) {
      throw new HttpError(400, "An operation may change each path only once");
    }
    if (
      body.event.workspaceId !== identity.workspaceId ||
      body.event.actorId !== identity.actorId
    ) throw new HttpError(403, "Event principal does not match authenticated membership");
    await options.store.assertReplicaOwnership(identity.workspaceId, identity.memberId, body.event.replicaId);
    for (const change of body.event.payload.changes) {
      if (redactPath(change.path)) throw new HttpError(400, "Sensitive paths cannot be synchronized");
      if (change.kind !== "delete" && (change.afterContent === undefined || change.afterHash !== contentHash(change.afterContent))) {
        throw new HttpError(400, "Transaction content hash is invalid");
      }
    }
    const operation = await options.store.appendOperation(identity, body.event);
    gateway.broadcastOperation(identity.workspaceId, toRemoteOperation(operation), body.event.replicaId);
    send(response, 200, serviceIngestReceiptSchema.parse({
      eventId: operation.eventId,
      operationId: operation.id,
      serverSequence: operation.serverSequence
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/operations") {
    const rawCursor = url.searchParams.get("afterSequence") ?? "0";
    if (!/^\d+$/.test(rawCursor)) throw new HttpError(400, "afterSequence must be a non-negative integer");
    const afterSequence = Number(rawCursor);
    if (!Number.isSafeInteger(afterSequence)) throw new HttpError(400, "afterSequence is outside the supported range");
    const query = cursorQuerySchema.parse({ afterSequence });
    const page = await options.store.listOperations(identity.workspaceId, query.afterSequence, 200);
    send(response, 200, {
      operations: page.items.map(toRemoteOperation),
      nextCursor: page.nextCursor
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/tasks") {
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership is read-only");
    const body = taskIngestRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    if (
      body.event.workspaceId !== identity.workspaceId ||
      body.event.actorId !== identity.actorId
    ) throw new HttpError(403, "Event principal does not match authenticated membership");
    await options.store.assertReplicaOwnership(identity.workspaceId, identity.memberId, body.event.replicaId);
    const task = await options.store.upsertTask(identity, body.event);
    gateway.broadcastTask(identity.workspaceId, task, body.event.replicaId);
    send(response, 200, taskIngestReceiptSchema.parse({
      eventId: task.eventId,
      taskId: task.task.id,
      updatedAt: task.updatedAt
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/tasks") {
    const query = timeCursorQuerySchema.parse({ after: url.searchParams.get("after") ?? EPOCH_CURSOR });
    const page = await options.store.listTasks(identity.workspaceId, query.after, 200);
    send(response, 200, { tasks: page.items, nextCursor: page.nextCursor });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/claims") {
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership is read-only");
    const body = claimIngestRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    if (
      body.event.workspaceId !== identity.workspaceId ||
      body.event.actorId !== identity.actorId
    ) throw new HttpError(403, "Event principal does not match authenticated membership");
    await options.store.assertReplicaOwnership(identity.workspaceId, identity.memberId, body.event.replicaId);
    const claim = await options.store.upsertClaim(identity, body.event);
    gateway.broadcastClaim(identity.workspaceId, claim, body.event.replicaId);
    send(response, 200, claimIngestReceiptSchema.parse({
      eventId: claim.eventId,
      claimId: claim.claim.id,
      updatedAt: claim.updatedAt
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/claims") {
    const query = timeCursorQuerySchema.parse({ after: url.searchParams.get("after") ?? EPOCH_CURSOR });
    const page = await options.store.listClaims(identity.workspaceId, query.after, 200);
    send(response, 200, { claims: page.items, nextCursor: page.nextCursor });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/handoffs") {
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership is read-only");
    const body = handoffIngestRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    if (
      body.event.workspaceId !== identity.workspaceId ||
      body.event.actorId !== identity.actorId
    ) throw new HttpError(403, "Event principal does not match authenticated membership");
    await options.store.assertReplicaOwnership(identity.workspaceId, identity.memberId, body.event.replicaId);
    const handoff = await options.store.upsertHandoff(identity, body.event);
    gateway.broadcastHandoff(identity.workspaceId, handoff, body.event.replicaId);
    send(response, 200, handoffIngestReceiptSchema.parse({
      eventId: handoff.eventId,
      handoffId: handoff.handoff.id,
      updatedAt: handoff.updatedAt
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/handoffs") {
    const query = timeCursorQuerySchema.parse({ after: url.searchParams.get("after") ?? EPOCH_CURSOR });
    const page = await options.store.listHandoffs(identity.workspaceId, query.after, 200);
    send(response, 200, { handoffs: page.items, nextCursor: page.nextCursor });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/intents") {
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership is read-only");
    const body = intentIngestRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    if (
      body.event.workspaceId !== identity.workspaceId ||
      body.event.actorId !== identity.actorId
    ) throw new HttpError(403, "Event principal does not match authenticated membership");
    await options.store.assertReplicaOwnership(identity.workspaceId, identity.memberId, body.event.replicaId);
    const intent = await options.store.upsertIntent(identity, body.event);
    gateway.broadcastIntent(identity.workspaceId, intent, body.event.replicaId);
    send(response, 200, intentIngestReceiptSchema.parse({
      eventId: intent.eventId,
      intentId: intent.intent.id,
      updatedAt: intent.updatedAt
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/intents") {
    const query = timeCursorQuerySchema.parse({ after: url.searchParams.get("after") ?? EPOCH_CURSOR });
    const page = await options.store.listIntents(identity.workspaceId, query.after, 200);
    send(response, 200, { intents: page.items, nextCursor: page.nextCursor });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/validations") {
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership is read-only");
    const body = validationIngestRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    if (
      body.event.workspaceId !== identity.workspaceId ||
      body.event.actorId !== identity.actorId
    ) throw new HttpError(403, "Event principal does not match authenticated membership");
    await options.store.assertReplicaOwnership(identity.workspaceId, identity.memberId, body.event.replicaId);
    const validation = await options.store.recordValidation(identity, body.event);
    gateway.broadcastValidation(identity.workspaceId, validation, body.event.replicaId);
    send(response, 200, validationIngestReceiptSchema.parse({
      eventId: validation.eventId,
      validationId: validation.validation.id,
      createdAt: validation.createdAt
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/validations") {
    const query = timeCursorQuerySchema.parse({ after: url.searchParams.get("after") ?? EPOCH_CURSOR });
    const page = await options.store.listValidations(identity.workspaceId, query.after, 200);
    send(response, 200, { validations: page.items, nextCursor: page.nextCursor });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/workspace/autonomy") {
    const tier = await options.store.getWorkspaceAutonomyTier(identity.workspaceId);
    send(response, 200, workspaceAutonomyResponseSchema.parse({ tier }));
    return;
  }

  if (method === "PUT" && url.pathname === "/v1/workspace/autonomy") {
    if (identity.role !== "owner") throw new HttpError(403, "Only the workspace owner can change the autonomy tier");
    const body = setWorkspaceAutonomyRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    const tier = await options.store.setWorkspaceAutonomyTier(identity, body.tier);
    send(response, 200, workspaceAutonomyResponseSchema.parse({ tier }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/workspace/billing") {
    const status = await getWorkspaceBillingStatus(options.store, identity.workspaceId);
    send(response, 200, workspaceBillingResponseSchema.parse({
      ...status,
      seatCap: Number.isFinite(status.seatCap) ? status.seatCap : null,
      semanticReviewCallsPerMonth: Number.isFinite(status.semanticReviewCallsPerMonth) ? status.semanticReviewCallsPerMonth : null
    }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/presence") {
    const sessions = await options.store.listPresence(identity.workspaceId);
    send(response, 200, { sessions });
    return;
  }

  throw new HttpError(404, "Route not found");
}

// Verifies the bearer token only, without requiring an existing workspace membership --
// for the self-serve routes (create workspace, redeem invite) that a brand-new Supabase
// user must be able to call before they belong to any workspace.
async function verifyToken(request: IncomingMessage, options: ServiceServerOptions): Promise<{ userId: string; email: string | undefined }> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  try {
    const claims = await verifySupabaseAccessToken(authorization.slice(7), options.jwks, options.supabaseUrl);
    return { userId: claims.userId, email: claims.email };
  } catch {
    throw new HttpError(401, "Access token is invalid or expired");
  }
}

async function authenticate(request: IncomingMessage, options: ServiceServerOptions): Promise<Membership> {
  if (!request.headers.authorization?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  const workspaceId = request.headers[WORKSPACE_HEADER];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new HttpError(400, `${WORKSPACE_HEADER} header is required`);
  }
  const { userId } = await verifyToken(request, options);
  try {
    return await options.store.resolveMembership(userId, workspaceId);
  } catch (error) {
    if (error instanceof StoreUnauthorizedError) throw new HttpError(401, error.message);
    throw error;
  }
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== JSON_TYPE) throw new HttpError(415, "Content-Type must be application/json");
  const declaredLength = request.headers["content-length"];
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new HttpError(413, "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function toRemoteOperation(operation: StoredOperation): RemoteOperation {
  return {
    id: operation.id,
    eventId: operation.eventId,
    workspaceId: operation.workspaceId,
    senderReplicaId: operation.senderReplicaId,
    transaction: operation.transaction,
    serverSequence: operation.serverSequence,
    createdAt: operation.createdAt
  };
}

function send(response: ServerResponse, status: number, data: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": `${JSON_TYPE}; charset=utf-8` });
  response.end(JSON.stringify({ ok: true, data }));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": `${JSON_TYPE}; charset=utf-8` });
  response.end(JSON.stringify({ ok: false, error: message }));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  take(key: string, maximum: number): boolean {
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current && this.windows.size >= 10_000) {
      for (const [entryKey, value] of this.windows) {
        if (now - value.startedAt >= 60_000) this.windows.delete(entryKey);
      }
      if (this.windows.size >= 10_000) return false;
    }
    const next = !current || now - current.startedAt >= 60_000
      ? { startedAt: now, count: 1 }
      : { ...current, count: current.count + 1 };
    this.windows.set(key, next);
    if (this.windows.size > 10_000) {
      for (const [entryKey, value] of this.windows) {
        if (now - value.startedAt >= 60_000) this.windows.delete(entryKey);
      }
    }
    return next.count <= maximum;
  }
}

function rateLimitRoute(method: string, pathname: string): string {
  if (method === "POST" && /^\/v1\/invites\/[^/]+\/redeem$/.test(pathname)) return "POST /v1/invites/:code/redeem";
  if (method === "DELETE" && /^\/v1\/invites\/[^/]+$/.test(pathname)) return "DELETE /v1/invites/:id";
  const route = `${method} ${pathname}`;
  return new Set([
    "GET /healthz",
    "POST /v1/replicas",
    "POST /v1/events",
    "GET /v1/operations",
    "POST /v1/tasks",
    "GET /v1/tasks",
    "POST /v1/claims",
    "GET /v1/claims",
    "POST /v1/handoffs",
    "GET /v1/handoffs",
    "POST /v1/intents",
    "GET /v1/intents",
    "POST /v1/validations",
    "GET /v1/validations",
    "GET /v1/presence",
    "GET /v1/workspace/billing",
    "GET /v1/memberships",
    "POST /v1/workspaces",
    "POST /v1/invites",
    "GET /v1/invites",
    "GET /v1/workspace/autonomy",
    "PUT /v1/workspace/autonomy"
  ]).has(route) ? route : "unknown";
}

function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ZodError) return 400;
  if (error instanceof StoreUnauthorizedError) return 401;
  if (error instanceof StoreConflictError) return 409;
  return 500;
}

function messageFor(error: unknown): string {
  if (error instanceof HttpError || error instanceof StoreUnauthorizedError || error instanceof StoreConflictError) {
    return error.message;
  }
  if (error instanceof ZodError) return "Request validation failed";
  return "Internal server error";
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}
