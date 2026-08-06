import { redactPath } from "@crosscode/core";

/**
 * A path off the wire names a file we are about to write, so it is validated before it is
 * ever joined to the repository root. Absolute paths, `..`, and anything inside `.git`
 * would all escape the checkout or corrupt the repository itself.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 4_096) return false;
  if (path.includes("\0") || path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return false;
  const parts = path.split("/");
  return !parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git");
}

/**
 * The hard denylist. `redactPath` in @crosscode/core is the single definition of what
 * never leaves the machine -- `.env*`, keys, credentials -- and real-time syncing one of
 * those would be a serious incident, so it is checked on the way out *and* on the way in.
 */
export function isDenied(path: string): boolean {
  return redactPath(path) || isCrosscodeOwned(path);
}

/**
 * The files `crosscode start` writes into the checkout itself: the MCP registration, the
 * skill, and the hook in the agent's settings.
 *
 * Every checkout installs its own copy, so no two peers share an ancestor for them, and
 * syncing them means the first teammate to join arrives holding a conflict on all three
 * before they have typed anything. Worse, they can never converge: `start` rewrites them
 * locally on every run, so a resolution is undone by the next start.
 *
 * They are also not content in the sense the rest of the sync means. They are per-machine
 * setup, regenerated on demand by the command the invite already tells a teammate to run.
 * Nothing is lost by leaving them out, and nothing is fixable by leaving them in.
 */
function isCrosscodeOwned(path: string): boolean {
  return path === ".mcp.json"
    || path === ".claude/settings.json"
    || path.startsWith(".claude/skills/crosscode/");
}
