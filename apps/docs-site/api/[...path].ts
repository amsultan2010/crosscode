import type { IncomingMessage, ServerResponse } from "node:http";
import { createServerlessHandler } from "@crosscode/service/serverless";

/**
 * The coordination service, served from the same project as the marketing site.
 *
 * Everything under /api/* is routed here by vercel.json and handed to the service's own
 * router, so there is exactly one implementation of routing, auth, and rate limiting
 * rather than a web copy and a self-hosted copy that drift apart. `pnpm service` remains
 * the persistent-process entrypoint self-hosters run.
 *
 * The daemon addresses the service by base URL and appends `/v1/...`, so it needs a base
 * of `https://<host>/api` here. That is what DEFAULT_SERVICE_URL in
 * apps/daemon/src/hosted.ts must point at.
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
