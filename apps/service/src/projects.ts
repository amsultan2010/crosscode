// Contract B (docs/onboarding-contracts.md): a project is keyed within a workspace by its
// normalized git remote when one exists, else by an absolute repo root path. This module
// owns that key derivation -- it is the dedup key, so every writer (POST /v1/projects and
// replica registration) must go through these helpers rather than storing whatever string
// the daemon happened to report.

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
// scp-style shorthand: [user@]host:path, with no scheme and a path that is not a drive
// letter or an absolute local path (`/x:y` is a path, `git@host:o/r` is a remote).
const SCP_LIKE = /^(?:[^@/]+@)?([^@/:]+):(.*)$/;

/**
 * Normalizes a git remote URL to a stable `host/owner/repo` (or bare path, for a
 * remote-less local clone source) dedup key. Returns null when there is nothing usable.
 *
 * Lowercases the host, drops credentials, drops the port, strips a trailing `.git` and
 * any trailing slashes. The port is dropped deliberately: `ssh://git@host:22/o/r` and
 * `git@host:o/r` are two transports for one repository, and keeping the port would file
 * them as two projects. Path case is preserved -- only the host is case-insensitive.
 */
export function normalizeRepoRemote(remote: string | null | undefined): string | null {
  const raw = remote?.trim();
  if (!raw) return null;

  let host = "";
  let path = raw;
  const scheme = SCHEME.exec(raw);
  if (scheme) {
    const rest = raw.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? "" : rest.slice(slash);
    // Everything before the last "@" is userinfo (a username, or a username:token pair).
    host = stripPort(authority.slice(authority.lastIndexOf("@") + 1));
  } else if (!raw.startsWith("/") && !raw.startsWith(".")) {
    const scp = SCP_LIKE.exec(raw);
    if (scp) {
      host = scp[1]!;
      path = scp[2]!;
    }
  }

  host = host.toLowerCase();
  path = path.replace(/\/+/g, "/").replace(/\/+$/, "");
  path = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (host) path = path.replace(/^\/+/, "");

  const normalized = host ? (path ? `${host}/${path}` : host) : path;
  return normalized.length > 0 ? normalized : null;
}

/**
 * Repo roots are advisory and only used as a fallback key, but they still have to be a
 * stable string: trailing slashes are dropped and a relative path is rejected outright
 * (a relative path means something different on every machine reporting it).
 */
export function normalizeRepoRoot(root: string | null | undefined): string | null {
  const raw = root?.trim();
  if (!raw || !raw.startsWith("/")) return null;
  const normalized = raw.replace(/\/+/g, "/").replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : "/";
}

function stripPort(authority: string): string {
  return authority.replace(/:\d+$/, "");
}

/** Display name: the last segment of the normalized remote, else the repo root basename. */
export function projectNameFrom(repoRemote: string | null, repoRoot: string | null): string {
  const source = repoRemote ?? repoRoot ?? "";
  const segment = source.split("/").filter(Boolean).at(-1);
  return segment ?? "project";
}
