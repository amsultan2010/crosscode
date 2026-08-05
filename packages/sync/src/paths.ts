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
  return redactPath(path);
}
