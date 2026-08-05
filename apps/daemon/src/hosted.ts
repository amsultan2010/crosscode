/**
 * The hosted Crosscode deployment, compiled in so that `crosscode signup` / `login` need no
 * flags and no environment setup -- the same reasoning as DEFAULT_SUPABASE_CONFIG in
 * supabase-client.ts, and these must stay pointed at the same deployment as that project.
 *
 * Both are public URLs, not secrets.
 */
// The coordination service runs as functions inside the website's deployment, reached at
// `/v1/*` on the same origin (apps/docs-site/vercel.json rewrites both `/v1/*` and `/api/*`
// into apps/docs-site/api/[...path].ts). This previously named an `api.` subdomain that was
// never created, so every unflagged `login`/`signup` resolved to a host that does not exist.
//
// The base must stay origin-only: every caller joins an absolute `/v1/...` path onto it
// with `new URL(path, base)`, which discards any path the base carries.
export const DEFAULT_SERVICE_URL = "https://www.getcrosscode.dev";
export const DEFAULT_WEB_URL = "https://www.getcrosscode.dev";

/** The coordination service every install talks to. Crosscode is hosted-only. */
export function resolveDefaultServiceUrl(): string {
  return DEFAULT_SERVICE_URL;
}
