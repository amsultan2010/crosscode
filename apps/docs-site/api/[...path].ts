import type { IncomingMessage, ServerResponse } from "node:http";
import { createServerlessHandler } from "@crosscode/service/serverless";

/**
 * The coordination service, served from the same project as the marketing site.
 *
 * Everything under /api/* and /v1/* is routed here by vercel.json and handed to the
 * service's own router, so there is exactly one implementation of routing, auth, and rate
 * limiting rather than a web copy and a self-hosted copy that drift apart. `pnpm service`
 * remains the persistent-process entrypoint self-hosters run.
 *
 * Both prefixes exist because clients address the service by *origin* and join an absolute
 * `/v1/...` onto it (`new URL(path, base)` discards any path the base carries), so
 * DEFAULT_SERVICE_URL in apps/daemon/src/hosted.ts is origin-only and the service has to
 * answer at the root. `/api/*` stays as the explicit spelling.
 *
 * Node runtime, not edge: the service uses node-postgres and node:crypto.
 */
export const config = { runtime: "nodejs" };

// Built on first request and reused while the instance stays warm, so the Postgres pool
// and the Supabase JWKS fetch are not paid for on every invocation.
const handler = createServerlessHandler();

export default async function (request: IncomingMessage, response: ServerResponse): Promise<void> {
  // The platform routes /api/v1/foo here; the router matches on /v1/foo. Strip the prefix
  // once, at the edge of the adapter, so no route pattern has to know it is behind /api.
  if (request.url) request.url = request.url.replace(/^\/api(?=\/|$)/, "") || "/";
  await handler(request, response);
}
