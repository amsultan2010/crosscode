import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  createInviteRequestSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  cursorQuerySchema,
  cursorTooOldResponseSchema,
  OPERATIONS_PROTOCOL_VERSION,
  inviteSchema,
  listInvitesResponseSchema,
  listMembersResponseSchema,
  memberSummarySchema,
  listProjectsResponseSchema,
  projectSchema,
  upsertProjectRequestSchema,
  redeemInviteResponseSchema,
  registerReplicaRequestSchema,
  registerReplicaResponseSchema,
  serviceIngestReceiptSchema,
  serviceIngestRequestSchema,
  listMembershipsResponseSchema,
  type RemoteOperation
} from "@crosscode/protocol";
import { contentHash, redactPath } from "@crosscode/core";
import { ZodError } from "zod";
import type { JWTVerifyGetKey } from "jose";
import { verifySupabaseAccessToken } from "./auth.js";
import { PgStore, StoreConflictError, StoreUnauthorizedError, type Membership, type StoredOperation } from "./store.js";
import { attachWebSocketGateway, type WebSocketGateway } from "./ws.js";

export type ServiceServerOptions = {
  store: PgStore;
  jwks: JWTVerifyGetKey;
  supabaseUrl: string;
  bodyLimitBytes?: number;
  tls?: { key: string | Buffer; cert: string | Buffer };
  /**
   * Exact browser origins allowed to call this service cross-origin, e.g.
   * "https://crosscode-one.vercel.app". Empty (the default) keeps the service
   * closed to browsers, which is right for a daemon-only deployment.
   *
   * Every request carries a bearer token, so this is an explicit allowlist and
   * never `*`: a wildcard would let any site on the internet spend a user's
   * credentials against this API.
   */
  allowedOrigins?: readonly string[];
  /**
   * Set when a reverse proxy in front of this process terminates TLS (see
   * CROSSCODE_TRUST_PROXY_TLS). Rate limiting then keys on the last hop in
   * `x-forwarded-for` rather than the socket address, which behind a proxy is the
   * load balancer itself -- without this every client on the deployment shares one
   * bucket, so ten legitimate daemons throttle each other.
   *
   * Off by default: on a directly-exposed socket the header is attacker-controlled,
   * and trusting it would let a caller rotate their own rate-limit key at will.
   */
  trustProxy?: boolean;
  /** Where unexpected (500-class) failures are reported. Defaults to stderr. */
  onError?: (error: unknown) => void;
};

/**
 * ServiceServerOptions plus the per-request hook that charges an authenticated caller's
 * own quota. Set once per request in handleRequest and consumed by verifyToken() and
 * authenticate(), which is why it is internal rather than part of the public options type.
 */
type RequestOptions = ServiceServerOptions & {
  /** Throws 429 when this identity has exhausted its own per-minute budget for the route. */
  chargeIdentity?: (identityKey: string) => void;
};

/**
 * Rate limits are two-layered, because keying everything on the client IP is wrong in both
 * directions at once: too loose against a single abusive account (which can rotate IPs, or
 * simply push ~432k events/day from one), and far too tight for an office or CI fleet behind
 * one NAT egress address, where ten legitimate daemons share a single bucket and throttle
 * each other into looking like the service is broken.
 *
 * So: a coarse per-IP ceiling that runs before authentication (the only signal available
 * that early, and a guard against unauthenticated floods), and the real quota charged
 * per authenticated identity once one is known.
 */
const IP_RATE_PER_MINUTE = 3_000;
const IDENTITY_RATE_PER_MINUTE = 600;
/** Replica registration is once-per-checkout; nobody legitimately does it in volume. */
const IDENTITY_REPLICA_RATE_PER_MINUTE = 30;

const JSON_TYPE = "application/json";

// Supabase-issued access tokens only carry the auth.users id (sub) — they no longer
// embed a workspaceId/replicaId the way Crosscode-issued tokens did. Every authenticated
// request must therefore say which workspace it targets via this header, since
// authenticate() runs before (and, for GET routes, without) a request body to read a
// workspaceId from. POST bodies still carry their own event.workspaceId, which is
// checked against this header for a redundant principal-binding match.
const WORKSPACE_HEADER = "x-crosscode-workspace-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertSafeServiceBinding(host: string, tlsEnabled: boolean): void {
  if (!isLoopback(host) && !tlsEnabled) {
    throw new Error(`Refusing non-loopback HTTP binding for ${host}; configure TLS`);
  }
}

/**
 * The route handler on its own, without a Node server wrapped around it.
 *
 * Exists so a serverless platform -- which hands you the same (IncomingMessage,
 * ServerResponse) pair and owns the listener itself -- can run the identical routing and
 * auth logic rather than a forked copy of it. The caller supplies the broadcast gateway,
 * because a platform with no persistent process has nowhere to broadcast to and passes a
 * no-op (see apps/service/src/serverless.ts).
 *
 * Note the rate limiter is per-handler, and therefore per-instance. In a persistent
 * process that is the whole service; on a function platform each instance counts
 * separately, so any limit that is a security control rather than a courtesy has to be
 * backed by the database instead.
 */
export function createRequestHandler(
  options: ServiceServerOptions & { gateway: WebSocketGateway }
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const limiter = new FixedWindowRateLimiter();
  return async (request, response) => {
    try {
      await handleRequest(request, response, options, limiter, options.gateway);
    } catch (error: unknown) {
      const status = statusFor(error);
      if (status >= 500) reportError(options, request, error);
      sendError(response, status, messageFor(error));
    }
  };
}

export function createServiceServer(options: ServiceServerOptions): Server {
  const limiter = new FixedWindowRateLimiter();
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, options, limiter, gateway).catch((error: unknown) => {
      const status = statusFor(error);
      // Everything below 500 is a deliberate, described refusal the client can act
      // on. A 500 is a bug or an outage, and its detail is deliberately not in the
      // response body -- so if it is not reported here it is lost entirely.
      if (status >= 500) reportError(options, request, error);
      sendError(response, status, messageFor(error));
    });
  };
  const server = options.tls ? createHttpsServer(options.tls, listener) : createHttpServer(listener);
  const gateway = attachWebSocketGateway(server, options);
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  baseOptions: ServiceServerOptions,
  limiter: FixedWindowRateLimiter,
  gateway: ReturnType<typeof attachWebSocketGateway>
): Promise<void> {
  const options: RequestOptions = baseOptions;
  response.setHeader("cache-control", "no-store");
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://service.local");
  applyCorsHeaders(request, response, options.allowedOrigins);
  // Preflight carries no credentials and must be answered before any auth or rate-limit
  // work, or the browser never gets far enough to send the real request.
  if (method === "OPTIONS") {
    response.writeHead(corsOriginFor(request, options.allowedOrigins) ? 204 : 403);
    response.end();
    return;
  }
  const route = rateLimitRoute(method, url.pathname);
  const remote = clientAddress(request, options.trustProxy);
  // Layer one, pre-auth: per-IP. In memory, where being approximate costs nothing and a
  // round-trip per request would cost real latency.
  if (!limiter.take(`ip:${remote}:${route}`, IP_RATE_PER_MINUTE)) {
    response.setHeader("retry-after", "60");
    sendError(response, 429, "Rate limit exceeded");
    return;
  }
  // Layer two, post-auth: the real quota, charged against whoever the caller turns out to
  // be rather than the address they happen to share. verifyToken()/authenticate() call this
  // as soon as an identity is established.
  options.chargeIdentity = (identityKey: string): void => {
    const identityRate = route === "POST /v1/replicas"
      ? IDENTITY_REPLICA_RATE_PER_MINUTE
      : IDENTITY_RATE_PER_MINUTE;
    if (!limiter.take(`id:${identityKey}:${route}`, identityRate)) {
      response.setHeader("retry-after", "60");
      throw new HttpError(429, "Rate limit exceeded");
    }
  };

  if (method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    sendHealth(response);
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
    const { userId, email } = await verifyToken(request, options);
    // Contract C: a valid user never sees an empty membership list. Provisioning here
    // rather than at signup keeps it independent of how the account was created (website
    // OAuth, `crosscode signup`, or an admin), and the partial unique index behind
    // ensurePersonalWorkspace() makes concurrent first requests converge on one workspace.
    await options.store.ensurePersonalWorkspace({ userId, actorId: email ?? userId });
    const memberships = await options.store.listMembershipsForUser(userId);
    send(response, 200, listMembershipsResponseSchema.parse({
      memberships: memberships.map((m) => ({ workspaceId: m.workspaceId, workspaceName: m.workspaceName, role: m.role, isPersonal: m.isPersonal }))
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

  if (method === "GET" && url.pathname === "/v1/members") {
    const members = await options.store.listMembers(identity);
    send(response, 200, listMembersResponseSchema.parse({ members }));
    return;
  }

  const removeMemberMatch = method === "DELETE" ? url.pathname.match(/^\/v1\/members\/([^/]+)$/) : null;
  if (removeMemberMatch) {
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can remove members");
    const memberId = decodeURIComponent(removeMemberMatch[1]!);
    if (!UUID_PATTERN.test(memberId)) throw new HttpError(400, "memberId must be a UUID");
    const removed = await options.store.disableMember(identity, memberId);
    send(response, 200, memberSummarySchema.parse(removed));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/replicas") {
    const body = registerReplicaRequestSchema.parse(
      await readJson(request, Math.min(options.bodyLimitBytes ?? 1_048_576, 16_384))
    );
    const replica = await options.store.registerReplica(identity.userId, identity.workspaceId, body.name, {
      repoRoot: body.repoRoot, repoRemote: body.repoRemote
    });
    send(response, 201, registerReplicaResponseSchema.parse(replica));
    return;
  }

  // Declaring which repository a checkout belongs to is the same class of action as
  // registering a replica (an idempotent upsert of a checkout identity, not a content
  // mutation), so like POST /v1/replicas it is not gated on the viewer role.
  if (method === "POST" && url.pathname === "/v1/projects") {
    const body = upsertProjectRequestSchema.parse(await readJson(request, Math.min(options.bodyLimitBytes ?? 1_048_576, 16_384)));
    const project = await options.store.upsertProject(identity.workspaceId, body);
    if (!project) throw new HttpError(400, "repoRemote or repoRoot must yield a usable project key");
    send(response, 200, projectSchema.parse(project));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/projects") {
    const projects = await options.store.listProjects(identity.workspaceId);
    send(response, 200, listProjectsResponseSchema.parse({ projects }));
    return;
  }

  const projectMatch = method === "GET" ? url.pathname.match(/^\/v1\/projects\/([^/]+)$/) : null;
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]!);
    // Ids are uuids; a malformed one would otherwise reach Postgres and surface as a 500.
    // A project in another workspace and one that does not exist are both plain 404s.
    const project = UUID_PATTERN.test(projectId) ? await options.store.getProject(identity.workspaceId, projectId) : null;
    if (!project) throw new HttpError(404, "Project not found");
    send(response, 200, projectSchema.parse(project));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/events") {
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership is read-only");
    const body = serviceIngestRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    const event = body.event;
    // End-to-end encryption was removed with device pairing, so the sealed form the
    // protocol still accepts on the wire has nothing here that can store it.
    if (event.type !== "transaction.created") throw new HttpError(400, "Sealed transactions are not supported");
    if (event.serverSequence !== undefined) throw new HttpError(400, "Clients may not assign serverSequence");
    const transaction = event.payload;
    const fileKeys = transaction.changes.map((change) => change.path);
    if (new Set(fileKeys).size !== fileKeys.length) {
      throw new HttpError(400, "An operation may change each path only once");
    }
    if (
      event.workspaceId !== identity.workspaceId ||
      event.actorId !== identity.actorId
    ) throw new HttpError(403, "Event principal does not match authenticated membership");
    await options.store.assertReplicaOwnership(identity.workspaceId, identity.memberId, event.replicaId);
    for (const change of transaction.changes) {
      if (redactPath(change.path)) throw new HttpError(400, "Sensitive paths cannot be synchronized");
      if (change.kind !== "delete" && (change.afterContent === undefined || change.afterHash !== contentHash(change.afterContent))) {
        throw new HttpError(400, "Transaction content hash is invalid");
      }
    }
    const operation = await options.store.appendOperation(identity, event);
    gateway.broadcastOperation(identity.workspaceId, toRemoteOperation(operation), event.replicaId);
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
    // Absent means version 1: a daemon built before the cursor-too-old status existed.
    const rawVersion = url.searchParams.get("protocolVersion");
    if (rawVersion !== null && !/^\d+$/.test(rawVersion)) throw new HttpError(400, "protocolVersion must be a positive integer");
    const clientProtocolVersion = rawVersion === null ? 1 : Number(rawVersion);
    const query = cursorQuerySchema.parse({ afterSequence });
    const page = await options.store.listOperations(identity.workspaceId, query.afterSequence, 200);
    if (page.status === "cursor-too-old") {
      // Never answer this with a 200 page. Serving what survives would be indistinguishable
      // from "caught up" and would silently drop every proposal retention deleted, which is
      // the whole failure this status exists to prevent.
      if (clientProtocolVersion < OPERATIONS_PROTOCOL_VERSION) {
        throw new HttpError(410, `Operations before ${page.resyncFrom} are outside this workspace's ${page.retentionDays}-day history retention and have been deleted; upgrade the daemon to resynchronize automatically`);
      }
      send(response, 200, cursorTooOldResponseSchema.parse({
        status: "cursor-too-old",
        protocolVersion: OPERATIONS_PROTOCOL_VERSION,
        resyncFrom: page.resyncFrom,
        retentionDays: page.retentionDays
      }));
      return;
    }
    send(response, 200, {
      operations: page.items.map(toRemoteOperation),
      nextCursor: page.nextCursor
    });
    return;
  }

  throw new HttpError(404, "Route not found");
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  return authorization.slice(7);
}

// Verifies the bearer token only, without requiring an existing workspace membership --
// for the self-serve routes (create workspace, redeem invite, list memberships) that a
// brand-new Supabase user must be able to call before they belong to any workspace.
async function verifyToken(request: IncomingMessage, options: RequestOptions): Promise<{ userId: string; email: string | undefined }> {
  const token = bearerToken(request);
  let claims;
  try {
    claims = await verifySupabaseAccessToken(token, options.jwks, options.supabaseUrl);
  } catch {
    throw new HttpError(401, "Access token is invalid or expired");
  }
  // Outside the try: a 429 from the quota must not be swallowed and reported as a bad token.
  options.chargeIdentity?.(`user:${claims.userId}`);
  return { userId: claims.userId, email: claims.email };
}

async function authenticate(request: IncomingMessage, options: RequestOptions): Promise<Membership> {
  // Before the workspace header, so a request with no credential at all is a 401 rather
  // than a complaint about a header it was never going to get as far as needing.
  bearerToken(request);
  const workspaceId = request.headers[WORKSPACE_HEADER];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new HttpError(400, `${WORKSPACE_HEADER} header is required`);
  }
  // Charge the membership below rather than the user here: one person driving several
  // workspaces is doing several workspaces' worth of legitimate work, and double-charging
  // the same request to both buckets would make the per-user budget the real ceiling.
  const { userId } = await verifyToken(request, { ...options, chargeIdentity: undefined });
  let identity: Membership;
  try {
    identity = await options.store.resolveMembership(userId, workspaceId);
  } catch (error) {
    if (error instanceof StoreUnauthorizedError) throw new HttpError(401, error.message);
    throw error;
  }
  options.chargeIdentity?.(`member:${identity.memberId}`);
  return identity;
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

/** Exported so tests can assert on the exact bytes `GET /v1/operations` serializes. */
export function toRemoteOperation(operation: StoredOperation): RemoteOperation {
  return {
    id: operation.id,
    eventId: operation.eventId,
    workspaceId: operation.workspaceId,
    senderReplicaId: operation.senderReplicaId,
    projectId: operation.projectId,
    transaction: operation.transaction,
    serverSequence: operation.serverSequence,
    createdAt: operation.createdAt
  };
}

/** The request's Origin when it is on the allowlist, otherwise undefined. */
function corsOriginFor(request: IncomingMessage, allowedOrigins: readonly string[] | undefined): string | undefined {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins?.length) return undefined;
  return allowedOrigins.includes(origin) ? origin : undefined;
}

function applyCorsHeaders(request: IncomingMessage, response: ServerResponse, allowedOrigins: readonly string[] | undefined): void {
  // Vary regardless of the outcome: the response body for a given URL is identical for
  // every origin, but these headers are not, and a shared cache must not reuse one
  // origin's CORS decision for another.
  response.setHeader("vary", "origin");
  const origin = corsOriginFor(request, allowedOrigins);
  if (!origin) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", `authorization, content-type, ${WORKSPACE_HEADER}`);
  response.setHeader("access-control-max-age", "600");
}

/**
 * Liveness only. No auth and no store call, so it answers whenever the process (or the
 * serverless instance) can run code at all, which is what makes it a usable probe for "the
 * function was importable" as opposed to "the database is reachable". The `service` field is
 * what a caller checks: a request that misses the API and falls through to the static site
 * also returns 200, and only the body tells the two apart.
 *
 * Exported because the serverless adapter answers the probe before it has read any
 * configuration, and one spelling of the response is better than two.
 */
export function sendHealth(response: ServerResponse): void {
  send(response, 200, { status: "ok", service: "crosscode-service" });
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

/**
 * The address rate limiting keys on. Behind a trusted proxy that is the last entry in
 * `x-forwarded-for` -- the last hop is the only one the proxy itself appended, so it is
 * the only one a client cannot forge by sending its own header. The socket address is
 * used otherwise, and whenever the header is absent or unparseable.
 */
function clientAddress(request: IncomingMessage, trustProxy: boolean | undefined): string {
  const socketAddress = request.socket.remoteAddress ?? "unknown";
  if (!trustProxy) return socketAddress;
  const forwarded = request.headers["x-forwarded-for"];
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "").split(",");
  return chain.map((entry) => entry.trim()).filter(Boolean).at(-1) ?? socketAddress;
}

function reportError(options: ServiceServerOptions, request: IncomingMessage, error: unknown): void {
  if (options.onError) {
    options.onError(error);
    return;
  }
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Crosscode service request failed: ${request.method ?? "GET"} ${request.url ?? "/"}\n${detail}\n`);
}

function rateLimitRoute(method: string, pathname: string): string {
  if (method === "POST" && /^\/v1\/invites\/[^/]+\/redeem$/.test(pathname)) return "POST /v1/invites/:code/redeem";
  if (method === "DELETE" && /^\/v1\/invites\/[^/]+$/.test(pathname)) return "DELETE /v1/invites/:id";
  if (method === "GET" && /^\/v1\/projects\/[^/]+$/.test(pathname)) return "GET /v1/projects/:id";
  if (method === "DELETE" && /^\/v1\/members\/[^/]+$/.test(pathname)) return "DELETE /v1/members/:id";
  const route = `${method} ${pathname}`;
  return new Set([
    "GET /healthz",
    "POST /v1/replicas",
    "POST /v1/events",
    "GET /v1/operations",
    "GET /v1/memberships",
    "GET /v1/projects",
    "POST /v1/projects",
    "POST /v1/workspaces",
    "POST /v1/invites",
    "GET /v1/invites",
    "GET /v1/members"
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
  if (
    error instanceof HttpError || error instanceof StoreUnauthorizedError ||
    error instanceof StoreConflictError
  ) {
    return error.message;
  }
  if (error instanceof ZodError) return "Request validation failed";
  return "Internal server error";
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}
