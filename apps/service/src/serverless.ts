import type { IncomingMessage, ServerResponse } from "node:http";
import { createSupabaseJwks } from "./auth.js";
import { createRequestHandler } from "./http.js";
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
 *   in-memory rate limiter counts per instance rather than globally. Routes whose limit is
 *   a security control rather than a courtesy must be backed by the database instead; see
 *   the durable limiter wired in below.
 */

/** Broadcasts have nowhere to go without a persistent process; dropping them is safe. */
const silentGateway: WebSocketGateway = {
  broadcastOperation: () => {},
  broadcastTask: () => {},
  broadcastClaim: () => {},
  broadcastHandoff: () => {},
  broadcastIntent: () => {},
  broadcastValidation: () => {}
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

export function createServerlessHandler(environment: NodeJS.ProcessEnv = process.env): ServerlessHandler {
  if (cached) return cached.handler;
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
    // Non-negotiable here: instances share no memory, so the pairing-code brute-force
    // defence has to be counted in the database or it is not a defence at all.
    durableRateLimits: true,
    allowedOrigins: parseAllowedOrigins(environment.CROSSCODE_ALLOWED_ORIGINS),
    gateway: silentGateway
  });
  cached = { handler, store };
  return handler;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((origin) => origin.trim()).filter(Boolean).map((origin) => new URL(origin).origin);
}
