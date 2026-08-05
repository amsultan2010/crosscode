import type { IncomingMessage, ServerResponse } from "node:http";
import { createSupabaseJwks } from "./auth.js";
import { createRequestHandler, sendHealth } from "./http.js";
import { createObservability, observeRequest } from "./observability.js";
import { createAnalytics } from "./analytics.js";
import { PgStore } from "./store.js";
import type { WebSocketGateway } from "./ws.js";

/**
 * Serverless adapter for the coordination service.
 *
 * The service's route handler is already a plain (IncomingMessage, ServerResponse)
 * function, which is exactly what a Node serverless runtime hands you -- so the whole API
 * runs on a function platform without forking any route logic. `apps/service/src/main.ts`
 * stays the persistent-process entrypoint that self-hosters and local development use;
 * this is an addition, not a replacement.
 *
 * What does NOT survive the move, and is handled here:
 *
 * - **Live push.** A function cannot hold `/v1/stream` open, so broadcasts become no-ops
 *   (see silentGateway). The daemon already re-syncs on a timer (apps/daemon/src/runtime.ts
 *   polls unconditionally) so nothing breaks, but "instant" degrades to "next poll" until a
 *   hosted pub/sub -- Supabase Realtime is the obvious one, since the daemon already depends
 *   on @supabase/supabase-js -- carries the notification instead.
 * - **Process-local state.** Every instance starts cold and shares nothing, so the
 *   in-memory rate limiter counts per instance rather than globally.
 */

/** Broadcasts have nowhere to go without a persistent process; dropping them is safe. */
const silentGateway: WebSocketGateway = {
  broadcastChanges: () => {}
};

export type ServerlessHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/**
 * Built once per instance and reused across warm invocations. The store owns a connection
 * pool and the JWKS fetch is cached, so paying for either on every request would add a
 * round-trip to Postgres and to Supabase for no reason.
 *
 * Point DATABASE_URL at Supabase's *pooled* connection string (port 6543). A function
 * platform opens a fresh pool per instance, and the direct port would exhaust Postgres
 * connections as concurrency rises.
 */
let cached: { handler: ServerlessHandler; store: PgStore } | undefined;

/**
 * The health probe is answered here, before any configuration is read, and every other
 * request builds (or reuses) the real handler. A deployment missing DATABASE_URL must still
 * be able to say "the function loaded and is running code", because that is a different
 * fault from "the function could not be imported" and the two get fixed in different places.
 * Routes that need the database still fail, which is what keeps the probe from being a lie.
 */
export function createServerlessHandler(environment: NodeJS.ProcessEnv = process.env): ServerlessHandler {
  return async (request, response) => {
    if (isHealthProbe(request)) {
      sendHealth(response);
      return;
    }
    const instance = (cached ??= buildHandler(environment));
    await instance.handler(request, response);
  };
}

function buildHandler(environment: NodeJS.ProcessEnv): { handler: ServerlessHandler; store: PgStore } {
  const databaseUrl = required(environment.DATABASE_URL, "DATABASE_URL");
  const supabaseUrl = required(environment.SUPABASE_URL, "SUPABASE_URL");
  const store = new PgStore(databaseUrl);
  const handler = createRequestHandler({
    store,
    jwks: createSupabaseJwks(supabaseUrl),
    supabaseUrl,
    // The platform terminates TLS and forwards plaintext, which is the same arrangement
    // CROSSCODE_TRUST_PROXY_TLS describes for a container host: x-forwarded-for is set by
    // infrastructure in front, so it is the trustworthy client address and the socket
    // address is the load balancer.
    trustProxy: true,
    allowedOrigins: parseAllowedOrigins(environment.CROSSCODE_ALLOWED_ORIGINS),
    // Inert unless POSTHOG_KEY is set in the function's environment.
    analytics: createAnalytics(environment),
    appUrl: environment.CROSSCODE_APP_URL,
    gateway: silentGateway
  });
  // main.ts refuses to start when the runtime role can update or delete immutable
  // operations and audit rows. A function platform has no startup to refuse at, so the
  // check runs once per cold instance and fails that instance's requests instead -- a
  // misconfigured role must not quietly become an append-only log that isn't append-only.
  // Deliberately not awaited inline: the check is one query, and blocking every first
  // request behind it would add a round-trip to each cold start.
  const privileged = store.assertRuntimePrivileges().then(() => undefined, (error: unknown) => error);
  // Inert unless SENTRY_DSN is set in the function's environment.
  const reporter = createObservability(environment);
  const guarded: ServerlessHandler = async (request, response) => {
    const context = observeRequest(reporter, request, response);
    try {
      const failure = await privileged;
      if (failure) throw failure;
      await handler(request, response);
    } catch (error) {
      reporter.capture(error, { ...context, status: 500 });
      throw error;
    } finally {
      // A function instance can be frozen the moment the invocation returns, so a report
      // started during it has to be awaited here or it may never leave the machine.
      await reporter.flush();
    }
  };
  return { handler: guarded, store };
}

/** Matches the two liveness spellings the router answers, ignoring any query string. */
function isHealthProbe(request: IncomingMessage): boolean {
  if (request.method !== "GET") return false;
  const pathname = (request.url ?? "/").split("?")[0];
  return pathname === "/health" || pathname === "/healthz";
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((origin) => origin.trim()).filter(Boolean).map((origin) => new URL(origin).origin);
}
