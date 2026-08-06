import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  changesResponseSchema,
  createInviteRequestSchema,
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
import {
  ACCEPTANCE_SURFACES,
  currentLegalDocuments,
  isCurrentVersion,
  LEGAL_DOCUMENTS,
  outstandingDocuments,
  REQUIRED_DOCUMENTS,
  type LegalDocument
} from "./legal.js";
import { hashDeviceCode, normalizeUserCode, PgStore, StoreConflictError, StoreUnauthorizedError, type RecordedAcceptance } from "./store.js";
import { attachWebSocketGateway, type WebSocketGateway } from "./ws.js";
import type { Analytics } from "./analytics.js";

export type ServiceServerOptions = {
  store: PgStore;
  jwks: JWTVerifyGetKey;
  supabaseUrl: string;
  /**
   * Origin the join links in invites point at, e.g. "https://www.getcrosscode.dev". The
   * invite's `url` is the only thing an invitee ever sees, so this is what makes a code
   * clickable rather than something to retype.
   */
  appUrl?: string;
  /** Injectable so tests do not reach GitHub. Defaults to the real API call. */
  checkRepoAccess?: RepoAccessChecker;
  bodyLimitBytes?: number;
  /** Product analytics. Absent, or inert without POSTHOG_KEY, means nothing is captured. */
  analytics?: Analytics;
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
  /** When the presented access token stops being accepted. Only the bind route reads it. */
  expiresAt: string;
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
 * The device routes are the only unauthenticated ones, so the per-identity layer cannot
 * reach them and the per-IP ceiling is the whole of what runs before the database is
 * touched. A person signs in a handful of times a day and their CLI polls twelve times a
 * minute, so this is ten daemons' worth of headroom and still two orders of magnitude
 * below the general ceiling.
 */
const DEVICE_IP_RATE_PER_MINUTE = 120;
/**
 * And a second ceiling per device code, because an office shares one egress address and
 * must not be throttled by a neighbour's spinning CLI. Twelve polls a minute is the
 * advertised interval; thirty is that with room to retry.
 *
 * Neither counter is what makes guessing a device code hopeless -- both live in this
 * instance's memory, and a function platform runs many instances. The 256 bits in the code
 * are what does that. These keep an impatient client off the database.
 */
const DEVICE_CODE_RATE_PER_MINUTE = 30;
/** How long a handshake stays open, and how often the CLI is asked to poll it. */
const DEVICE_CODE_TTL_SECONDS = 900;
const DEVICE_POLL_INTERVAL_SECONDS = 5;

const devicePollRequestSchema = z.object({ deviceCode: z.string().min(1).max(512) }).strict();

/**
 * What the /device page posts once its visitor has signed in with GitHub.
 *
 * The access token is deliberately not in here: it arrives in the Authorization header and
 * is stored only after jwtVerify has accepted it, so a caller cannot bind a session whose
 * access token is not their own. The refresh token cannot be verified by anyone but
 * Supabase, and travels with it because a CLI that could not refresh would be signed out
 * within the hour.
 */
const deviceBindRequestSchema = z.object({
  userCode: z.string().min(1).max(32),
  refreshToken: z.string().min(1).max(4_096),
  /** Supabase's `provider_token`. See DeviceSession in store.ts for why it matters. */
  githubToken: z.string().min(1).max(4_096).optional()
}).strict();

/**
 * What a surface posts once somebody has ticked the box.
 *
 * The version travels with each document rather than being taken from the server's own
 * constant, and is then checked against it: that is what makes "the version we recorded is
 * the version they were shown" a property of the request instead of a hope. A page that was
 * open when the documents changed is refused and told to reload, rather than quietly
 * recording assent to a text nobody read.
 */
const acceptanceRequestSchema = z.object({
  surface: z.enum(ACCEPTANCE_SURFACES),
  documents: z.record(z.enum(LEGAL_DOCUMENTS), z.string().min(1).max(64))
}).strict();

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

/**
 * `www`, not the apex. The apex answers 308 to this host, so both work in a browser -- but
 * these URLs are printed in a terminal for someone to open or retype, and the sign-in and
 * invite links are the two places a redirect hop is most expensive. It is also the host the
 * Supabase redirect allowlist is written against.
 */
const DEFAULT_APP_URL = "https://www.getcrosscode.dev";

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
  if (!limiter.take(`ip:${remote}:${route}`, route.startsWith("POST /v1/auth/") ? DEVICE_IP_RATE_PER_MINUTE : IP_RATE_PER_MINUTE)) {
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

  /**
   * Liveness *and* whether the runtime role can still use the database.
   *
   * The second half is not padding. Migrations create tables but have never granted to
   * `crosscode_runtime` -- the original six were granted once, by hand -- so a table added
   * later arrives readable by nobody and the first request touching it 500s with
   * `permission denied`. That is how `device_codes` shipped, and this route reported `ok`
   * throughout, because answering "is the process up" was all it did.
   *
   * A degraded answer is 503 so the scheduled probe treats it as an outage, and it names
   * the tables rather than returning a bare boolean somebody then has to go and diagnose.
   * Naming them leaks nothing: they are already listed in a public migration.
   */
  if (method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    const { unreadableTables } = await options.store.checkHealth();
    if (unreadableTables.length > 0) {
      send(response, 503, { status: "degraded", service: "crosscode-service", unreadableTables });
      return;
    }
    sendHealth(response);
    return;
  }

  const bodyLimit = options.bodyLimitBytes ?? 1_048_576;

  /**
   * What has to be accepted, and at which version, for every surface that shows it.
   *
   * Unauthenticated, because the sign-up page shows the checkbox to somebody who has no
   * account yet, and because there is nothing here that is not already published.
   */
  if (method === "GET" && url.pathname === "/v1/legal") {
    send(response, 200, { documents: currentLegalDocuments(), required: REQUIRED_DOCUMENTS });
    return;
  }

  // The two halves of the device handshake the CLI drives. Both are before authenticate()
  // and therefore exempt from the bearer catch-all, which is not a hole: a terminal that
  // has never signed in has no token to present, and producing one is the entire purpose
  // of these two routes. What stands in for a credential is the device code itself -- 256
  // bits, minted by the service, hashed at rest, and good for fifteen minutes.

  if (method === "POST" && url.pathname === "/v1/auth/github/device") {
    const started = await options.store.startDeviceCode({ expiresInSeconds: DEVICE_CODE_TTL_SECONDS });
    send(response, 201, {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUrl: new URL("/device", options.appUrl ?? DEFAULT_APP_URL).toString(),
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
      expiresInSeconds: Math.max(1, Math.round((Date.parse(started.expiresAt) - Date.now()) / 1_000))
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/auth/github/device/token") {
    const body = devicePollRequestSchema.parse(await readJson(request, Math.min(bodyLimit, 4_096)));
    // Keyed on the hash, not the code: the code is a credential and this map outlives the
    // request by a minute.
    if (!limiter.take(`device:${hashDeviceCode(body.deviceCode)}`, DEVICE_CODE_RATE_PER_MINUTE)) {
      response.setHeader("retry-after", "60");
      throw new HttpError(429, "Rate limit exceeded");
    }
    const claimed = await options.store.claimDeviceCode(body.deviceCode);
    // Each refusal is a different thing for the person at the terminal to do, so each gets
    // its own status rather than a blanket 400. A code that never existed and one that
    // expired are told apart on purpose: neither reveals anything, because a caller who
    // does not hold a device code cannot reach either answer.
    if (claimed.status === "unknown") throw new HttpError(404, "Device code is not valid");
    if (claimed.status === "expired") throw new HttpError(410, "Device code has expired");
    if (claimed.status === "consumed") throw new HttpError(409, "Device code has already been used");
    if (claimed.status === "pending") {
      send(response, 200, { status: "pending" });
      return;
    }
    const { githubToken, ...session } = claimed.session;
    // The GitHub token rides beside the session rather than inside it, because the session
    // is the shape the CLI writes to disk (syncDaemonConfigSchema, and it is strict) and a
    // GitHub OAuth token is not something to leave in a file. The CLI uses it once, in
    // memory, to redeem an invite.
    send(response, 200, { status: "complete", session, ...(githubToken ? { githubToken } : {}) });
    return;
  }

  const caller = await authenticate(request, options);

  /**
   * The record of assent. Every surface that shows the checkbox posts here, and this is the
   * only way a row is ever written -- a client that ticks a box and tells nobody is not
   * evidence of anything, which is why nothing about this is client-side.
   */
  if (method === "POST" && url.pathname === "/v1/legal/acceptances") {
    const body = acceptanceRequestSchema.parse(await readJson(request, Math.min(bodyLimit, 4_096)));
    const documents = body.documents as Partial<Record<LegalDocument, string>>;
    for (const document of REQUIRED_DOCUMENTS) {
      if (documents[document] === undefined) throw new HttpError(400, `Accepting requires the ${document} document`);
    }
    for (const [document, version] of Object.entries(documents) as [LegalDocument, string][]) {
      // The page was open when the text changed. Refused rather than recorded: a row saying
      // they accepted the current version would be a claim about a text they never saw.
      if (!isCurrentVersion(document, version)) {
        throw new HttpError(409, `The ${document} document has changed since this page was loaded; reload it and read it again`);
      }
    }
    const acceptances: RecordedAcceptance[] = (Object.entries(documents) as [LegalDocument, string][]).map(([document, version]) => ({
      userId: caller.userId,
      document,
      version,
      surface: body.surface,
      ip: remote,
      userAgent: header(request, "user-agent")?.slice(0, 512)
    }));
    await options.store.recordAcceptances(acceptances);
    // No analytics event: the acceptance table is the record, and the one thing that must
    // not happen is a second, weaker copy of it somewhere a retention policy will thin out.
    send(response, 201, { accepted: documents, outstanding: outstandingDocuments(documents) });
    return;
  }

  /**
   * What this caller still owes, which is what makes §11's re-acceptance promise keepable:
   * a stored version that is not the published one is outstanding, so the surfaces ask
   * again on the next sign-in instead of an email campaign nobody built.
   */
  if (method === "GET" && url.pathname === "/v1/legal/acceptances") {
    const accepted = await options.store.latestAcceptedVersions(caller.userId);
    send(response, 200, { accepted, outstanding: outstandingDocuments(accepted), documents: currentLegalDocuments() });
    return;
  }

  // The browser's half of the handshake, and the only authenticated one: whoever posts
  // here has just signed in with GitHub on getcrosscode.dev/device and is handing that
  // session to the terminal that printed the code they typed.
  if (method === "POST" && url.pathname === "/v1/auth/github/device/bind") {
    const body = deviceBindRequestSchema.parse(await readJson(request, Math.min(bodyLimit, 16_384)));
    // A Supabase project can have other providers enabled, and a session from one of them
    // would sign the CLI in as somebody with no GitHub identity -- which every later route
    // that checks repository access needs. Refused here, where the person can still go and
    // sign in the right way, rather than at the first invite they try to redeem.
    if (!caller.github) throw new HttpError(403, "Sign in with GitHub to authorize a terminal");
    const userCode = normalizeUserCode(body.userCode);
    if (!userCode) throw new HttpError(400, "That is not a Crosscode confirmation code");
    // Before the session leaves for the terminal, not after: this handshake is what
    // `crosscode start` turns into a running daemon that writes to somebody's working tree,
    // and the disclaimer of that belongs in front of it.
    await requireAcceptedTerms(options, caller.userId);
    const bound = await options.store.bindDeviceCode({
      userCode,
      userId: caller.userId,
      session: {
        // Re-read rather than taken from the body: this is the token authenticate() just
        // verified, so the session handed to the CLI is provably the caller's own.
        accessToken: bearerToken(request),
        refreshToken: body.refreshToken,
        expiresAt: caller.expiresAt,
        ...(body.githubToken ? { githubToken: body.githubToken } : {})
      }
    });
    if (bound.status === "unknown") throw new HttpError(404, "That confirmation code is not valid");
    if (bound.status === "expired") throw new HttpError(410, "That confirmation code has expired");
    if (bound.status === "consumed") throw new HttpError(409, "That confirmation code has already been used");
    // Not "you already did this": a second bind on a live code is somebody else's
    // handshake being redirected, and the honest answer to that is no.
    if (bound.status === "already-bound") throw new HttpError(409, "That confirmation code is already signed in");
    options.analytics?.capture("device_authorized", caller.userId);
    send(response, 200, { status: "bound" });
    return;
  }

  // Creating a project and redeeming an invite are both reachable by someone who belongs
  // to nothing yet, so they provision the user row the rest of the schema references.

  if (method === "POST" && url.pathname === "/v1/projects") {
    const body = createProjectRequestSchema.parse(await readJson(request, Math.min(bodyLimit, 16_384)));
    await requireAcceptedTerms(options, caller.userId);
    await upsertCaller(options, caller);
    const project = await options.store.createProject(caller.userId, body);
    options.analytics?.capture("project_created", caller.userId);
    send(response, 201, syncProjectSchema.parse(project));
    return;
  }

  const redeemMatch = method === "POST" ? url.pathname.match(/^\/v1\/invites\/([^/]+)\/redeem$/) : null;
  if (redeemMatch) {
    const code = decodeURIComponent(redeemMatch[1]!);
    // An invitee arrives here having never seen the terms, so this is where they are asked.
    await requireAcceptedTerms(options, caller.userId);
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
    options.analytics?.capture("invite_redeemed", caller.userId);
    send(response, 200, redeemSyncInviteResponseSchema.parse({
      projectId: redeemed.projectId,
      repo: redeemed.repo,
      cloneCommand: cloneCommandFor(redeemed.repo)
    }));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/invites") {
    const body = createInviteRequestSchema.parse(await readJson(request, Math.min(bodyLimit, 16_384)));
    const invite = await options.store.createInvite({
      projectId: body.projectId,
      userId: caller.userId,
      expiresInHours: body.expiresInHours
    });
    options.analytics?.capture("invite_created", caller.userId);
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
    // The last gate before a checkout is a synced checkout. The three routes in front of
    // this one can all be reached without registering, but nothing syncs without a replica,
    // so an account with no acceptance row cannot reach a synced state through any path.
    await requireAcceptedTerms(options, caller.userId);
    await options.store.requireMembership(body.projectId, caller.userId);
    const replica = await options.store.registerReplica({
      projectId: body.projectId, userId: caller.userId, branch: body.branch
    });
    options.analytics?.capture("replica_registered", caller.userId);
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
    options.analytics?.capture("changes_published", caller.userId, { versionCount: body.versions.length });
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

/**
 * Refuses a caller who has not accepted the current terms and privacy policy.
 *
 * 403 rather than 402-style special-casing, and with the reason spelled out, because the
 * fix is a page the person can go and read. This is the mechanical half of the warranty
 * disclaimer and the liability cap: an account that never assented can create nothing, join
 * nothing, sign a terminal in, or register a checkout to sync.
 */
async function requireAcceptedTerms(options: RequestOptions, userId: string): Promise<void> {
  const accepted = await options.store.latestAcceptedVersions(userId);
  const outstanding = outstandingDocuments(accepted);
  if (outstanding.length === 0) return;
  throw new HttpError(403, `Accept the current Crosscode ${outstanding.join(" and ")} at ${DEFAULT_APP_URL}/device to continue`);
}

async function upsertCaller(options: RequestOptions, caller: Caller): Promise<void> {
  const { created } = await options.store.upsertUser({
    id: caller.userId,
    githubId: caller.github?.id,
    githubLogin: caller.github?.login,
    email: caller.email
  });
  // The first time a person's account reaches the service at all. The closest honest
  // measure of an install: npm downloads count machines, this counts people who got far
  // enough to sign in.
  if (created) options.analytics?.capture("user_activated", caller.userId, { isNewUser: true });
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
  return { userId: claims.userId, email: claims.email, github: claims.github, expiresAt: claims.expiresAt };
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
    "GET /v1/legal",
    "GET /v1/legal/acceptances",
    "POST /v1/legal/acceptances",
    "POST /v1/auth/github/device",
    "POST /v1/auth/github/device/token",
    "POST /v1/auth/github/device/bind",
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
