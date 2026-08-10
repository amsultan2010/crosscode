import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveGitPath } from "@crosscode/git";
import { writeFileAtomic } from "./json-file.js";
// Imported from the sync module by path, not from the package root: the legacy
// transaction-shaped schemas in packages/protocol/src/index.ts still export names the sync
// contract also uses (`createInviteRequestSchema`), and a local declaration shadows a
// `export *`. Reaching for the package root would silently bind the old schema.
import { syncDaemonConfigSchema, type SyncDaemonConfig } from "../../../packages/protocol/src/sync.js";
import { CliError } from "./errors.js";

/**
 * Per-checkout configuration, in exactly the shape the wire contract names
 * (`syncDaemonConfigSchema`): which project this checkout syncs, which repo that project is
 * for, and the session used to reach the service.
 *
 * It lives under the checkout's git directory rather than in the working tree, so it is
 * never a file that could be committed, synced, or shown in `git status`. `git rev-parse
 * --git-path` is what resolves it, which puts a linked worktree's config in its own
 * per-worktree directory -- one daemon per checkout means one config per checkout.
 */

export async function configPath(repoRoot: string): Promise<string> {
  return resolveGitPath(repoRoot, "crosscode/config.json");
}

export async function readConfig(repoRoot: string): Promise<SyncDaemonConfig | undefined> {
  const path = await configPath(repoRoot);
  const contents = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new CliError("CONFIG_UNREADABLE", "This checkout's Crosscode configuration is not valid JSON", "Delete it and run `crosscode start` again.");
  }
  const result = syncDaemonConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError("CONFIG_UNREADABLE", `This checkout's Crosscode configuration does not match the sync contract: ${result.error.issues[0]?.message ?? "unknown field"}`, "Delete it and run `crosscode start` again.");
  }
  return result.data;
}

export async function writeConfig(repoRoot: string, config: SyncDaemonConfig): Promise<SyncDaemonConfig> {
  const validated = syncDaemonConfigSchema.parse(config);
  const path = await configPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  // 0600: the session tokens in here are a credential. Written through a fresh file and
  // renamed into place, because `writeFile`'s mode only applies to a file it creates -- a
  // config left at 0644 by an earlier version would otherwise keep those permissions for
  // every refreshed token written into it afterwards.
  await writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`, 0o600);
  return validated;
}
