import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  changesResponseSchema,
  createProjectRequestSchema,
  listChangesQuerySchema,
  publishChangesRequestSchema,
  publishChangesResponseSchema,
  redeemSyncInviteResponseSchema,
  registerSyncReplicaRequestSchema,
  registerSyncReplicaResponseSchema,
  syncInviteSchema,
  syncProjectSchema
} from "@crosscode/protocol";
import { redactPath } from "@crosscode/core";
import { z, ZodError } from "zod";
import type { JWTVerifyGetKey } from "jose";
import { checkGitHubRepoAccess, verifySupabaseAccessToken, type GitHubIdentity, type RepoAccessChecker } from "./auth.js";
import { PgStore, StoreConflictError, StoreUnauthorizedError } from "./store.js";
import { attachWebSocketGateway, type WebSocketGateway } from "./ws.js";

export type ServiceServerOptions = {
  store: PgStore;
  jwks: JWTVerifyGetKey;
  supabaseUrl: string;
  /**
   * Origin the join links in invites point at, e.g. "https://getcrosscode.dev". The
   * invite's `url` is the only thing an invitee ever sees, so this is what makes a code
   * clickable rather than something to retype.
   */
  appUrl?: string;
  /** Injectable so tests do not reach GitHub. Defaults to the real API call. */
  checkRepoAccess?: RepoAccessChecker;
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
 * own quota. Set once per request in handleRequest and consumed by authenticate(), which
 * is why it is internal rather than part of the public options type.
 */
type RequestOptions = ServiceServerOptions & {
  /** Throws 429 when this identity has exhausted its own per-minute budget for the route. */
  chargeIdentity?: (identityKey: string) => void;
};

/** Who the bearer token says is calling. Project membership is checked per route. */
type Caller = {
  userId: string;
  email: string | undefined;
  github: GitHubIdentity | undefined;
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

/**
 * The invitee's own GitHub OAuth token, offered on the redeem call so the service can ask
 * GitHub whether they can see the project's repository.
 *
 * It travels in a header rather than the body because it is a credential, not data: it
 * must not end up in a request log that records bodies, and it is the same shape of thing
 * as the Authorization header beside it. Supabase hands the client this token as
 * `session.provider_token` at GitHub sign-in.
 */
const GITHUB_TOKEN_HEADER = "x-crosscode-github-token";

const DEFAULT_APP_URL = "https://getcrosscode.dev";

/**
 * Restated field for field from `createInviteRequestSchema` in packages/protocol/src/sync.ts,
 * which cannot be imported: the old transaction-era protocol exports a schema of the same
 * name from packages/protocol/src/index.ts, and an explicit export there shadows the
 * `export * from "./sync.js"` beneath it. The package has no subpath export to reach past
 * the collision with. This goes away the moment the old export does -- it is the only place
 * in the service that does not build directly against the contract.
 */
const createSyncInviteRequestSchema = z.object({
  projectId: z.string().min(1),
  expiresInHours: z.number().int().positive().max(720).default(168)
}).strict();

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
  gateway: WebSocketGateway
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
  // be rather than the address they happen to share. authenticate() calls this as soon as
  // an identity is established.
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

  const caller = await authenticate(request, options);
  const bodyLimit = options.bodyLimitBytes ?? 1_048_576;

  // Creating a project and redeeming an invite are both reachable by someone who belongs
  // to nothing yet, so they provision the user row the rest of the schema references.

  if (method === "POST" && url.pathname === "/v1/projects") {
    const body = createProjectRequestSchema.parse(await readJson(request, Math.min(bodyLimit, 16_384)));
    await upsertCaller(options, caller);
    const project = await options.store.createProject(caller.userId, body);
    send(response, 201, syncProjectSchema.parse(project));
    return;
  }

  const redeemMatch = method === "POST" ? url.pathname.match(/^\/v1\/invites\/([^/]+)\/redeem$/) : null;
  if (redeemMatch) {
    const code = decodeURIComponent(redeemMatch[1]!);
    const invite = await options.store.findInvite(code);
    if (!invite) throw new HttpError(404, "Invite code is not valid");
    if (invite.redeemedAt) throw new HttpError(409, "Invite has already been redeemed");
    if (Date.parse(invite.expiresAt) <= Date.now()) throw new HttpError(409, "Invite has expired");
    // The whole point of the invite page: a code is not access. Somebody who cannot read
    // the repository on GitHub cannot join the room that carries its working tree, and a
    // caller who offers no GitHub token has not shown they can.
    const githubToken = header(request, GITHUB_TOKEN_HEADER);
    if (!githubToken) throw new HttpError(403, `${GITHUB_TOKEN_HEADER} is required to verify access to ${invite.repo}`);
    const checkAccess = options.checkRepoAccess ?? checkGitHubRepoAccess;
    if (!await checkAccess(githubToken, invite.repo)) {
      throw new HttpError(403, `Your GitHub account does not have access to ${invite.repo}`);
    }
    await upsertCaller(options, caller);
    const redeemed = await options.store.redeemInvite({ code, userId: caller.userId });
    send(response, 200, redeemSyncInviteResponseSchema.parse({
      projectId: redeemed.projectId,
      repo: redeemed.repo,
      cloneCommand: cloneCommandFor(redeemed.repo)
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/invites") {
    const body = createSyncInviteRequestSchema.parse(await readJson(request, Math.min(bodyLimit, 16_384)));
    const invite = await options.store.createInvite({
      projectId: body.projectId,
      userId: caller.userId,
      expiresInHours: body.expiresInHours
    });
    send(response, 201, syncInviteSchema.parse({
      code: invite.code,
      url: joinUrl(options.appUrl, invite.code),
      projectId: invite.projectId,
      repo: invite.repo,
      expiresAt: invite.expiresAt
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/replicas") {
    const body = registerSyncReplicaRequestSchema.parse(await readJson(request, Math.min(bodyLimit, 16_384)));
    await options.store.requireMembership(body.projectId, caller.userId);
    const replica = await options.store.registerReplica({
      projectId: body.projectId, userId: caller.userId, branch: body.branch
    });
    send(response, 201, registerSyncReplicaResponseSchema.parse(replica));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/changes") {
    const body = publishChangesRequestSchema.parse(await readJson(request, bodyLimit));
    await options.store.requireMembership(body.projectId, caller.userId);
    // The replica is the sender identity fan-out excludes, so it has to be one of this
    // caller's own -- otherwise anybody could publish as somebody else's checkout and
    // suppress the echo to it.
    const replica = await options.store.touchReplica(body.projectId, caller.userId, body.replicaId);
    if (replica.branch !== body.branch) throw new HttpError(409, "Replica is registered to a different branch");
    for (const version of body.versions) {
      // A denylisted path reaching the change log would put a secret in a durable,
      // fan-out-to-everybody store. The daemon filters these too; this is the backstop.
      if (redactPath(version.path)) throw new HttpError(400, "Sensitive paths cannot be synchronized");
    }
    const changes = await options.store.publishChanges(body);
    gateway.broadcastChanges(body.projectId, body.branch, changes, body.replicaId);
    send(response, 200, publishChangesResponseSchema.parse({ cursor: changes.at(-1)!.sequence }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/changes") {
    const query = listChangesQuerySchema.parse({
      projectId: url.searchParams.get("projectId") ?? undefined,
      branch: url.searchParams.get("branch") ?? undefined,
      since: integerParam(url, "since"),
      limit: integerParam(url, "limit")
    });
    await options.store.requireMembership(query.projectId, caller.userId);
    const page = await options.store.listChanges(query);
    // A too-old cursor is answered with its own shape, never with a page: a short page and
    // "you are caught up" are the same message, so serving what survived retention would
    // silently drop everything it deleted.
    send(response, 200, changesResponseSchema.parse(
      page.status === "ok"
        ? { changes: page.changes, cursor: page.cursor }
        : { status: "cursor-too-old", resyncFrom: page.resyncFrom, retentionDays: page.retentionDays }
    ));
    return;
  }

  throw new HttpError(404, "Route not found");
}

/** The clone line the join page shows, straight from the contract's `cloneCommand`. */
function cloneCommandFor(repo: string): string {
  const directory = repo.split("/").at(-1) ?? repo;
  return `git clone git@github.com:${repo}.git && cd ${directory}`;
}

function joinUrl(appUrl: string | undefined, code: string): string {
  return new URL(`/join/${code}`, appUrl ?? DEFAULT_APP_URL).toString();
}

async function upsertCaller(options: RequestOptions, caller: Caller): Promise<void> {
  await options.store.upsertUser({
    id: caller.userId,
    githubId: caller.github?.id,
    githubLogin: caller.github?.login,
    email: caller.email
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single && single.length > 0 ? single : undefined;
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  return authorization.slice(7);
}

/**
 * Verifies the bearer token. Project membership is not resolved here: every route names
 * its own project in a body or a query, and a caller who belongs to nothing yet still has
 * to be able to create one or redeem an invite.
 */
async function authenticate(request: IncomingMessage, options: RequestOptions): Promise<Caller> {
  const token = bearerToken(request);
  let claims;
  try {
    claims = await verifySupabaseAccessToken(token, options.jwks, options.supabaseUrl);
  } catch {
    throw new HttpError(401, "Access token is invalid or expired");
  }
  // Outside the try: a 429 from the quota must not be swallowed and reported as a bad token.
  options.chargeIdentity?.(`user:${claims.userId}`);
  return { userId: claims.userId, email: claims.email, github: claims.github };
}

/** A non-negative integer query parameter, or undefined so the schema's default applies. */
function integerParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new HttpError(400, `${name} is outside the supported range`);
  return value;
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
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", `authorization, content-type, ${GITHUB_TOKEN_HEADER}`);
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
  const route = `${method} ${pathname}`;
  return new Set([
    "GET /healthz",
    "POST /v1/projects",
    "POST /v1/invites",
    "POST /v1/replicas",
    "POST /v1/changes",
    "GET /v1/changes"
  ]).has(route) ? route : "unknown";
}

function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ZodError) return 400;
  if (error instanceof StoreUnauthorizedError) return 403;
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
