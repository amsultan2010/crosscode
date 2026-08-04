/**
 * The hosted Crosscode deployment, compiled in so that `crosscode signup` / `login` need no
 * flags and no environment setup -- the same reasoning as DEFAULT_SUPABASE_CONFIG in
 * supabase-client.ts, and these must stay pointed at the same deployment as that project.
 *
 * Both are public URLs, not secrets.
 *
 * Precedence everywhere these are used is: an explicit `--service`/`--web` flag, then the
 * value already persisted in this worktree's daemon config, then the environment variable,
 * then these constants. A self-hoster therefore keeps full control without editing code.
 */
export const DEFAULT_SERVICE_URL = "https://api.getcrosscode.dev";
export const DEFAULT_WEB_URL = "https://www.getcrosscode.dev";

/** Machine-wide override of the coordination service, beating only the compiled-in default. */
export function resolveDefaultServiceUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const url = environment.CROSSCODE_SERVICE_URL?.trim();
  return url ? url.replace(/\/+$/, "") : DEFAULT_SERVICE_URL;
}
