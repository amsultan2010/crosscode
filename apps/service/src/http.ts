import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  cursorQuerySchema,
  enrollmentRequestSchema,
  enrollmentResponseSchema,
  replicaTokenExchangeRequestSchema,
  replicaTokenExchangeResponseSchema,
  serviceIngestReceiptSchema,
  serviceIngestRequestSchema,
  type RemoteOperation
} from "@crosscode/protocol";
import { contentHash, redactPath } from "@crosscode/core";
import { ZodError } from "zod";
import { issueAccessToken, verifyAccessToken, type AccessClaims } from "./auth.js";
import { PgStore, StoreConflictError, StoreUnauthorizedError, type StoredOperation } from "./store.js";

export type ServiceServerOptions = {
  store: PgStore;
  jwtSecret: string;
  accessTokenTtlSeconds?: number;
  bodyLimitBytes?: number;
  tls?: { key: string | Buffer; cert: string | Buffer };
};

const JSON_TYPE = "application/json";

export function assertSafeServiceBinding(host: string, tlsEnabled: boolean): void {
  if (!isLoopback(host) && !tlsEnabled) {
    throw new Error(`Refusing non-loopback HTTP binding for ${host}; configure TLS`);
  }
}

export function createServiceServer(options: ServiceServerOptions): Server {
  const limiter = new FixedWindowRateLimiter();
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, options, limiter).catch((error: unknown) => {
      sendError(response, statusFor(error), messageFor(error));
    });
  };
  return options.tls ? createHttpsServer(options.tls, listener) : createHttpServer(listener);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServiceServerOptions,
  limiter: FixedWindowRateLimiter
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://service.local");
  const route = rateLimitRoute(method, url.pathname);
  const remote = request.socket.remoteAddress ?? "unknown";
  const rate = route === "POST /v1/enroll" ? 10 : route === "POST /v1/token" ? 30 : 300;
  if (!limiter.take(`${remote}:${route}`, rate)) {
    response.setHeader("retry-after", "60");
    sendError(response, 429, "Rate limit exceeded");
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    send(response, 200, { status: "ok" });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/enroll") {
    const body = enrollmentRequestSchema.parse(await readJson(request, Math.min(options.bodyLimitBytes ?? 1_048_576, 16_384)));
    const enrollment = await options.store.enroll({ enrollmentToken: body.token });
    const token = await tokenResponse(enrollment.claims, options);
    send(response, 201, enrollmentResponseSchema.parse({ ...token, replicaSecret: enrollment.replicaSecret }));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/token") {
    const body = replicaTokenExchangeRequestSchema.parse(await readJson(request, 16_384));
    const claims = await options.store.authenticateReplica(body.replicaId, body.replicaSecret, {
      workspaceId: body.workspaceId,
      actorId: body.actorId
    });
    send(response, 200, replicaTokenExchangeResponseSchema.parse(await tokenResponse(claims, options)));
    return;
  }

  const identity = await authenticate(request, options);
  if (method === "POST" && url.pathname === "/v1/events") {
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership is read-only");
    const body = serviceIngestRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    if (body.event.serverSequence !== undefined) throw new HttpError(400, "Clients may not assign serverSequence");
    if (new Set(body.event.payload.changes.map((change) => change.path)).size !== body.event.payload.changes.length) {
      throw new HttpError(400, "An operation may change each path only once");
    }
    if (
      body.event.workspaceId !== identity.workspaceId ||
      body.event.replicaId !== identity.replicaId ||
      body.event.actorId !== identity.actorId
    ) throw new HttpError(403, "Event principal does not match authenticated membership");
    for (const change of body.event.payload.changes) {
      if (redactPath(change.path)) throw new HttpError(400, "Sensitive paths cannot be synchronized");
      if (change.kind !== "delete" && (change.afterContent === undefined || change.afterHash !== contentHash(change.afterContent))) {
        throw new HttpError(400, "Transaction content hash is invalid");
      }
    }
    const operation = await options.store.appendOperation(identity, body.event);
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

  throw new HttpError(404, "Route not found");
}

async function authenticate(request: IncomingMessage, options: ServiceServerOptions): Promise<AccessClaims> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  let claims: AccessClaims;
  try {
    claims = await verifyAccessToken(authorization.slice(7), options.jwtSecret);
  } catch {
    throw new HttpError(401, "Access token is invalid or expired");
  }
  return options.store.reauthorize(claims);
}

async function tokenResponse(claims: AccessClaims, options: ServiceServerOptions) {
  const expiresIn = options.accessTokenTtlSeconds ?? 900;
  const accessToken = await issueAccessToken(claims, options.jwtSecret, expiresIn);
  return {
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    principal: {
      workspaceId: claims.workspaceId,
      actorId: claims.actorId,
      replicaId: claims.replicaId,
      role: claims.role
    }
  };
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
  const route = `${method} ${pathname}`;
  return new Set([
    "GET /healthz",
    "POST /v1/enroll",
    "POST /v1/token",
    "POST /v1/events",
    "GET /v1/operations"
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
