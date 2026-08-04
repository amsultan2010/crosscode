import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  claimIngestRequestSchema,
  claimIngestReceiptSchema,
  claimPairingCodeRequestSchema,
  claimPairingCodeResponseSchema,
  createPairingCodeResponseSchema,
  pairingStatusResponseSchema,
  createInviteRequestSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  cursorQuerySchema,
  cursorTooOldResponseSchema,
  OPERATIONS_PROTOCOL_VERSION,
  handoffIngestRequestSchema,
  handoffIngestReceiptSchema,
  intentIngestRequestSchema,
  intentIngestReceiptSchema,
  inviteSchema,
  listInvitesResponseSchema,
  listMembersResponseSchema,
  listWorkspaceTokensResponseSchema,
  memberSummarySchema,
  workspaceTokenSummarySchema,
  listProjectsResponseSchema,
  projectSchema,
  upsertProjectRequestSchema,
  redeemInviteResponseSchema,
  registerReplicaRequestSchema,
  registerReplicaResponseSchema,
  serviceIngestReceiptSchema,
  serviceIngestRequestSchema,
  setWorkspaceAutonomyRequestSchema,
  billingPortalResponseSchema,
  cancelSubscriptionResponseSchema,
  startCheckoutRequestSchema,
  startCheckoutResponseSchema,
  workspaceBillingResponseSchema,
  listMembershipsResponseSchema,
  taskIngestRequestSchema,
  taskIngestReceiptSchema,
  timeCursorQuerySchema,
  validationIngestRequestSchema,
  validationIngestReceiptSchema,
  workspaceAutonomyResponseSchema,
  EPOCH_CURSOR,
  WORKSPACE_TOKEN_PREFIX,
  type RemoteOperation
} from "@crosscode/protocol";
import { contentHash, redactPath } from "@crosscode/core";
import { ZodError } from "zod";
import type { JWTVerifyGetKey } from "jose";
import { verifySupabaseAccessToken } from "./auth.js";
import { PgStore, StoreConflictError, StoreGoneError, StoreUnauthorizedError, type Membership, type StoredOperation } from "./store.js";
import { attachWebSocketGateway, type WebSocketGateway } from "./ws.js";
import {
  BillingLimitError, getWorkspaceBillingStatus, priceCentsFor, reconcileSeatQuantity, seatQuantityFor,
  type BillingProvider
} from "./billing.js";
import { applyStripeWebhookEvent } from "./billing-webhook.js";
import { StripeSignatureError, stripeWebhookEventSchema, verifyStripeSignature } from "./stripe.js";

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
   * bucket, so the whole service runs into the 10/min pairing-claim limit at once
   * and the per-IP brute-force defense that limit exists for is gone.
   *
   * Off by default: on a directly-exposed socket the header is attacker-controlled,
   * and trusting it would let a caller rotate their own rate-limit key at will.
   */
  trustProxy?: boolean;
  /**
   * Spend security-critical rate-limit budgets against the database instead of process
   * memory. Required on any deployment where more than one instance serves requests --
   * a function platform, or several replicas behind a load balancer -- because an
   * in-memory counter there gives each instance its own full budget. Costs one round-trip
   * on the affected routes, which is why it is opt-in rather than always on.
   */
  durableRateLimits?: boolean;
  /**
   * Present only when this deployment has a payment provider configured. Absent -- the
   * self-hosted case -- means the checkout routes answer 503 and the webhook route does not
   * exist at all, rather than the service growing an unauthenticated endpoint it cannot
   * verify anything about.
   */
  billing?: BillingOptions;
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
/**
 * Claiming is unauthenticated and single-use, so there is no identity to charge and per-IP
 * throttling is the only thing standing between an attacker and brute-forcing the 40-bit
 * code space (Contract A). Deliberately unchanged, and deliberately still per-IP.
 */
const UNAUTHENTICATED_IP_RATE_PER_MINUTE = 10;

export type BillingOptions = {
  provider: BillingProvider;
  /**
   * The endpoint signing secret. Without it there is no way to tell Stripe's bytes from
   * anyone else's, so its absence removes the route rather than weakening the check.
   */
  webhookSecret?: string;
};


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
  // Layer one, pre-auth: per-IP. Tight only where there is no identity to charge instead.
  //
  // The claim route's budget is spent against the database when a durable store is
  // configured, because that limit is the brute-force defence for a 40-bit code space and
  // an in-memory counter is per-instance: on a function platform, N warm instances would
  // quietly hand an attacker N times the budget. Every other route stays in memory, where
  // being approximate costs nothing and a round-trip per request would cost real latency.
  const isUnauthenticatedClaim = route === "POST /v1/pairing-codes/claim";
  const ipRate = isUnauthenticatedClaim ? UNAUTHENTICATED_IP_RATE_PER_MINUTE : IP_RATE_PER_MINUTE;
  const ipBucket = `ip:${remote}:${route}`;
  const withinIpBudget = isUnauthenticatedClaim && options.durableRateLimits
    ? await options.store.takeRateLimit(ipBucket, ipRate, 60)
    : limiter.take(ipBucket, ipRate);
  if (!withinIpBudget) {
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
    await syncSeats(options, redeemed.workspaceId);
    send(response, 200, redeemInviteResponseSchema.parse(redeemed));
    return;
  }

  // Unauthenticated by design: the pairing code is itself the credential, and the
  // response deliberately carries a workspace-scoped token rather than a user session, so
  // a terminal-side credential can never act as the user (Contract A).
  if (method === "POST" && url.pathname === "/v1/pairing-codes/claim") {
    const body = claimPairingCodeRequestSchema.parse(
      await readJson(request, Math.min(options.bodyLimitBytes ?? 1_048_576, 16_384))
    );
    const claimed = await options.store.claimPairingCode({
      code: body.code, actorId: body.actorId, replicaName: body.replicaName
    });
    // Attribute the freshly paired replica to the repository it is a checkout of, so the
    // CLI can group its activity by project from the very first pairing. Reported by
    // the daemon rather than trusted blindly: a checkout with neither a remote nor a repo
    // root yields null, which consumers group as "Unassigned".
    const projectId = await options.store.attachReplicaToProject(claimed.workspaceId, claimed.replicaId, {
      repoRoot: body.repoRoot, repoRemote: body.repoRemote
    });
    send(response, 200, claimPairingCodeResponseSchema.parse({ ...claimed, projectId }));
    return;
  }

  // Unauthenticated by design, and the only route in this service that is unauthenticated
  // without also being single-use: the payment provider has no Crosscode credential, so the
  // request signature is the credential. Four things stand between this route and an
  // attacker who can reach it:
  //
  // 1. The route does not exist unless a signing secret is configured.
  // 2. The signature is verified over the raw bytes, constant-time, before the body is
  //    parsed -- so an unsigned body never reaches a JSON parser, let alone a write.
  // 3. The signature covers a timestamp with a five-minute tolerance, which bounds how long
  //    a captured-and-replayed *valid* delivery stays useful.
  // 4. The event id is claimed in billing_events, so a redelivery inside that window is a
  //    no-op, and the handler itself re-reads authoritative state from the provider rather
  //    than trusting the body, so even a replay that got through cannot roll state back.
  if (method === "POST" && url.pathname === "/v1/webhooks/stripe") {
    const secret = options.billing?.webhookSecret;
    const provider = options.billing?.provider;
    if (!secret || !provider) throw new HttpError(404, "Route not found");
    const raw = await readRawBody(request, Math.min(options.bodyLimitBytes ?? 1_048_576, 1_048_576));
    try {
      verifyStripeSignature(raw, headerValue(request, "stripe-signature"), secret);
    } catch (error) {
      if (error instanceof StripeSignatureError) throw new HttpError(400, error.message);
      throw error;
    }
    let event;
    try {
      event = stripeWebhookEventSchema.parse(JSON.parse(raw));
    } catch {
      throw new HttpError(400, "Webhook body is not a recognizable event");
    }
    if (!await options.store.claimBillingEvent(event.id, event.type)) {
      send(response, 200, { received: true, duplicate: true });
      return;
    }
    const outcome = await applyStripeWebhookEvent(options.store, provider, event);
    await options.store.completeBillingEvent(event.id, outcome.workspaceId);
    send(response, 200, { received: true, duplicate: false, applied: outcome.applied });
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

  // Contract A: a `ccw_` token grants only the daemon ingest/read surface. Team and
  // pairing management stay behind a Supabase session, so a leaked terminal-side token
  // cannot invite members or mint further pairing codes.
  if (method === "POST" && url.pathname === "/v1/pairing-codes") {
    assertSupabaseCredential(identity, "/v1/pairing-codes");
    // Contract A scopes minting to owner or member: a viewer's paired daemon could not
    // ingest anything anyway, so handing one a workspace token has no legitimate use.
    if (identity.role === "viewer") throw new HttpError(403, "Viewer membership cannot pair a device");
    const minted = await options.store.createPairingCode(identity);
    send(response, 201, createPairingCodeResponseSchema.parse(minted));
    return;
  }

  const pairingStatusMatch = method === "GET" ? url.pathname.match(/^\/v1\/pairing-codes\/([^/]+)$/) : null;
  if (pairingStatusMatch) {
    assertSupabaseCredential(identity, "/v1/pairing-codes");
    const pairingId = decodeURIComponent(pairingStatusMatch[1]!);
    if (!UUID_PATTERN.test(pairingId)) throw new HttpError(400, "pairingId must be a UUID");
    const status = await options.store.getPairingCodeStatus(identity, pairingId);
    if (!status) throw new HttpError(404, "Pairing code was not found");
    send(response, 200, pairingStatusResponseSchema.parse(status));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/invites") {
    assertSupabaseCredential(identity, "/v1/invites");
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can create invites");
    const body = createInviteRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    const invite = await options.store.createInvite(identity, { role: body.role, ttlMs: body.ttlSeconds ? body.ttlSeconds * 1_000 : undefined });
    send(response, 201, inviteSchema.parse(invite));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/invites") {
    assertSupabaseCredential(identity, "/v1/invites");
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can list invites");
    const invites = await options.store.listInvites(identity);
    send(response, 200, listInvitesResponseSchema.parse({ invites }));
    return;
  }

  const deleteInviteMatch = method === "DELETE" ? url.pathname.match(/^\/v1\/invites\/([^/]+)$/) : null;
  if (deleteInviteMatch) {
    assertSupabaseCredential(identity, "/v1/invites");
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can revoke invites");
    await options.store.revokeInvite(identity, decodeURIComponent(deleteInviteMatch[1]!));
    send(response, 200, { revoked: true });
    return;
  }

  // Paired devices. A `ccw_` token never expires, so revoking one is the only way to
  // retire a lost or compromised machine -- and a workspace token must not be able to
  // revoke itself out of trouble or enumerate its peers, hence Supabase-only.
  if (method === "GET" && url.pathname === "/v1/workspace-tokens") {
    assertSupabaseCredential(identity, "/v1/workspace-tokens");
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can list paired devices");
    const tokens = await options.store.listWorkspaceTokens(identity);
    send(response, 200, listWorkspaceTokensResponseSchema.parse({ tokens }));
    return;
  }

  const revokeTokenMatch = method === "DELETE" ? url.pathname.match(/^\/v1\/workspace-tokens\/([^/]+)$/) : null;
  if (revokeTokenMatch) {
    assertSupabaseCredential(identity, "/v1/workspace-tokens");
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can revoke paired devices");
    const tokenId = decodeURIComponent(revokeTokenMatch[1]!);
    if (!UUID_PATTERN.test(tokenId)) throw new HttpError(400, "Workspace token id must be a UUID");
    const revoked = await options.store.revokeWorkspaceToken(identity, tokenId);
    send(response, 200, workspaceTokenSummarySchema.parse(revoked));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/members") {
    assertSupabaseCredential(identity, "/v1/members");
    const members = await options.store.listMembers(identity);
    send(response, 200, listMembersResponseSchema.parse({ members }));
    return;
  }

  const removeMemberMatch = method === "DELETE" ? url.pathname.match(/^\/v1\/members\/([^/]+)$/) : null;
  if (removeMemberMatch) {
    assertSupabaseCredential(identity, "/v1/members");
    if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can remove members");
    const memberId = decodeURIComponent(removeMemberMatch[1]!);
    if (!UUID_PATTERN.test(memberId)) throw new HttpError(400, "memberId must be a UUID");
    const removed = await options.store.disableMember(identity, memberId);
    await syncSeats(options, identity.workspaceId);
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

  // Upgrading, downgrading, and cancelling all act as the paying user and all move money,
  // so they are Supabase-only (never a `ccw_` terminal token) and owner-only.
  if (method === "POST" && url.pathname === "/v1/workspace/billing/checkout") {
    const provider = assertBillingOwner(identity, options);
    const body = startCheckoutRequestSchema.parse(await readJson(request, options.bodyLimitBytes ?? 1_048_576));
    // Student is Pro's limits at Essential's price, so selling it self-serve would just be
    // a discount anyone could take. It stays an out-of-band grant until the verification
    // flow in BUILD_INSTRUCTIONS.md Phase 10 exists.
    if (body.plan === "student") {
      throw new HttpError(403, "Student pricing requires verification and cannot be purchased self-serve");
    }
    const record = await options.store.getWorkspaceBilling(identity.workspaceId);
    // seatQuantityFor collapses to 1 on every flat-priced plan, so a client asking for
    // `--seats 10` on Pro cannot turn a $5 subscription into a $50 one -- the quantity is
    // a Stripe line-item quantity, and only Team's price is per seat.
    const activeMembers = await options.store.countActiveMembers(identity.workspaceId);
    const seats = seatQuantityFor(body.plan, Math.max(activeMembers, body.seats ?? 1));
    const priceCents = priceCentsFor(body.plan, body.interval, seats);
    const monthlyEquivalentCents = priceCentsFor(body.plan, "month", seats);

    // An existing subscription is moved in place rather than replaced: Checkout can only
    // create subscriptions, so sending someone back through it would leave the workspace
    // paying twice. Stripe prorates the mid-cycle difference, in both directions.
    if (record.stripeSubscriptionId && record.billingPlan) {
      await provider.changeSubscription({
        subscriptionId: record.stripeSubscriptionId, plan: body.plan, interval: body.interval, seats
      });
      // Applied here as well as by the webhook, from the same re-read of authoritative
      // state, so the caller sees the new plan immediately and the webhook that follows is
      // a no-op rather than a second, divergent write.
      await options.store.applySubscriptionState({
        workspaceId: identity.workspaceId,
        state: await provider.getSubscriptionState(record.stripeSubscriptionId)
      });
      send(response, 200, startCheckoutResponseSchema.parse({
        mode: "updated", plan: body.plan, interval: body.interval, seats, url: null, priceCents, monthlyEquivalentCents
      }));
      return;
    }

    const customerId = record.stripeCustomerId
      ?? (await provider.createCustomer(identity.workspaceId, identity.actorId)).customerId;
    // Linked before the redirect, so a checkout the user abandons still leaves the customer
    // attached to the workspace and the next attempt reuses it.
    await options.store.linkStripeCustomer(identity.workspaceId, customerId, identity.memberId);
    const session = await provider.createCheckoutSession(identity.workspaceId, body.plan, {
      interval: body.interval, seats, customerId, email: identity.actorId
    });
    send(response, 200, startCheckoutResponseSchema.parse({
      mode: "checkout", plan: body.plan, interval: body.interval, seats, url: session.url, priceCents, monthlyEquivalentCents
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/workspace/billing/cancel") {
    const provider = assertBillingOwner(identity, options);
    const record = await options.store.getWorkspaceBilling(identity.workspaceId);
    // billingPlan as well as the id: a subscription that already ended leaves its id behind
    // for the audit trail, and asking Stripe to cancel it again is an error, not a no-op.
    if (!record.stripeSubscriptionId || !record.billingPlan) throw new HttpError(409, "This workspace has no active subscription to cancel");
    // Cancels at period end, so the workspace keeps the limits it paid for until they run
    // out and then falls back to free's -- it never loses anything mid-period, and no
    // workspace data is touched in either case.
    await provider.cancelSubscription(record.stripeSubscriptionId);
    const applied = await options.store.applySubscriptionState({
      workspaceId: identity.workspaceId,
      state: await provider.getSubscriptionState(record.stripeSubscriptionId)
    });
    send(response, 200, cancelSubscriptionResponseSchema.parse({
      plan: applied.plan, cancelAtPeriodEnd: applied.cancelAtPeriodEnd, currentPeriodEnd: applied.currentPeriodEnd
    }));
    return;
  }

  // A provider-hosted page for cards, invoices and receipts. Not a Crosscode web UI: it is
  // Stripe's own surface, which is why it does not contradict the CLI-first decision.
  if (method === "POST" && url.pathname === "/v1/workspace/billing/portal") {
    const provider = assertBillingOwner(identity, options);
    const record = await options.store.getWorkspaceBilling(identity.workspaceId);
    if (!record.stripeCustomerId) throw new HttpError(409, "This workspace has no billing account yet");
    const session = await provider.createPortalSession(record.stripeCustomerId);
    send(response, 200, billingPortalResponseSchema.parse({ url: session.url }));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/presence") {
    const sessions = await options.store.listPresence(identity.workspaceId);
    send(response, 200, { sessions });
    return;
  }

  throw new HttpError(404, "Route not found");
}

// An authenticated principal plus which kind of credential proved it. Routes that must
// stay Supabase-only (team management, pairing) branch on `credential` rather than on the
// raw header, so the check is impossible to skip by reading the token a second way.
type Identity = Membership & { credential: "supabase" | "workspace-token" };

function assertSupabaseCredential(identity: Identity, surface: string): void {
  if (identity.credential !== "supabase") throw new HttpError(403, `Workspace tokens cannot access ${surface}`);
}

/**
 * The three gates every money-moving route shares: a real user session (not a terminal
 * token), the owner role, and a configured provider. Returns the provider so the route
 * body reads as one statement instead of four.
 */
function assertBillingOwner(identity: Identity, options: ServiceServerOptions): BillingProvider {
  assertSupabaseCredential(identity, "/v1/workspace/billing");
  if (identity.role !== "owner") throw new HttpError(403, "Only workspace owners can change the plan");
  if (!options.billing) throw new HttpError(503, "Billing is not configured on this deployment");
  return options.billing.provider;
}

/**
 * Keeps Team's per-seat subscription quantity in step with the workspace's active member
 * count when membership changes mid-cycle; Stripe prorates the difference itself. A no-op
 * on every other plan, and on deployments with no provider.
 *
 * Awaited rather than fired and forgotten -- an unhandled rejection here would be invisible
 * -- but it can never fail the request it rides on: nobody should be unable to remove a
 * member because Stripe is having an afternoon. A missed call self-corrects on the next
 * membership or plan change.
 */
async function syncSeats(options: ServiceServerOptions, workspaceId: string): Promise<void> {
  if (!options.billing) return;
  await reconcileSeatQuantity(options.store, options.billing.provider, workspaceId, (error) => reportBillingError(options, error));
}

function reportBillingError(options: ServiceServerOptions, error: unknown): void {
  if (options.onError) {
    options.onError(error);
    return;
  }
  process.stderr.write(`Crosscode seat reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The request body as raw text. Webhook signatures cover the exact bytes sent, so the body
 * cannot be round-tripped through JSON.parse/stringify before it is verified -- key order
 * and number formatting would not survive.
 */
async function readRawBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
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
  return Buffer.concat(chunks).toString("utf8");
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  return authorization.slice(7);
}

// Verifies the bearer token only, without requiring an existing workspace membership --
// for the self-serve routes (create workspace, redeem invite, list memberships) that a
// brand-new Supabase user must be able to call before they belong to any workspace. These
// routes act as the user, so a workspace token is refused outright rather than verified.
async function verifyToken(request: IncomingMessage, options: RequestOptions): Promise<{ userId: string; email: string | undefined }> {
  const token = bearerToken(request);
  if (token.startsWith(WORKSPACE_TOKEN_PREFIX)) throw new HttpError(403, "Workspace tokens cannot act on behalf of a user");
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

async function authenticate(request: IncomingMessage, options: RequestOptions): Promise<Identity> {
  const token = bearerToken(request);
  // A workspace token already names its workspace, so it does not need (and is not
  // trusted to supply) the workspace header; when one is sent it must agree.
  if (token.startsWith(WORKSPACE_TOKEN_PREFIX)) {
    let resolved;
    try {
      resolved = await options.store.resolveWorkspaceToken(token);
    } catch (error) {
      if (error instanceof StoreUnauthorizedError) throw new HttpError(401, error.message);
      throw error;
    }
    const declared = request.headers[WORKSPACE_HEADER];
    if (typeof declared === "string" && declared.length > 0 && declared !== resolved.workspaceId) {
      throw new HttpError(403, "Workspace token is scoped to a different workspace");
    }
    const { replicaId: _replicaId, ...membership } = resolved;
    // A paired checkout has no user, so its own token is the identity to charge.
    options.chargeIdentity?.(`member:${membership.memberId}`);
    return { ...membership, credential: "workspace-token" };
  }
  const workspaceId = request.headers[WORKSPACE_HEADER];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new HttpError(400, `${WORKSPACE_HEADER} header is required`);
  }
  // Charge the membership below rather than the user here: one person driving several
  // workspaces is doing several workspaces' worth of legitimate work, and double-charging
  // the same request to both buckets would make the per-user budget the real ceiling.
  const { userId } = await verifyToken(request, { ...options, chargeIdentity: undefined });
  let identity: Identity;
  try {
    identity = { ...await options.store.resolveMembership(userId, workspaceId), credential: "supabase" };
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
  if (method === "GET" && /^\/v1\/pairing-codes\/[^/]+$/.test(pathname)) return "GET /v1/pairing-codes/:pairingId";
  if (method === "GET" && /^\/v1\/projects\/[^/]+$/.test(pathname)) return "GET /v1/projects/:id";
  if (method === "DELETE" && /^\/v1\/workspace-tokens\/[^/]+$/.test(pathname)) return "DELETE /v1/workspace-tokens/:id";
  if (method === "DELETE" && /^\/v1\/members\/[^/]+$/.test(pathname)) return "DELETE /v1/members/:id";
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
    "POST /v1/workspace/billing/checkout",
    "POST /v1/workspace/billing/cancel",
    "POST /v1/workspace/billing/portal",
    "POST /v1/webhooks/stripe",
    "GET /v1/memberships",
    "GET /v1/projects",
    "POST /v1/projects",
    "POST /v1/workspaces",
    "POST /v1/invites",
    "GET /v1/invites",
    "POST /v1/pairing-codes",
    "POST /v1/pairing-codes/claim",
    "GET /v1/workspace/autonomy",
    "PUT /v1/workspace/autonomy",
    "GET /v1/workspace-tokens",
    "GET /v1/members"
  ]).has(route) ? route : "unknown";
}

function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ZodError) return 400;
  if (error instanceof StoreUnauthorizedError) return 401;
  // 402: the request was well-formed and authorized, and the only thing refusing it is
  // the workspace's plan. Distinct from a 403 so a client can tell "you may not" from
  // "you have run out", and act on the second by upgrading.
  if (error instanceof BillingLimitError) return 402;
  if (error instanceof StoreConflictError) return 409;
  // 410, not 404/409: a claimed, expired, or unknown pairing code are one indistinguishable
  // outcome, so the endpoint cannot be used to probe which codes ever existed.
  if (error instanceof StoreGoneError) return 410;
  return 500;
}

function messageFor(error: unknown): string {
  if (error instanceof StoreGoneError) return error.message;
  if (
    error instanceof HttpError || error instanceof StoreUnauthorizedError ||
    error instanceof StoreConflictError || error instanceof BillingLimitError
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
