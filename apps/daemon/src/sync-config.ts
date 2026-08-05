import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { resolveGitPath } from "@crosscode/git";
import { syncDaemonConfigSchema, type SyncDaemonConfig } from "@crosscode/protocol";
import { repositoryRoot } from "@crosscode/sync";

/**
 * Everything the sync daemon keeps on disk, all of it inside `.git/crosscode/` so it is
 * per checkout, never committed, and removed with the clone.
 *
 * `sync.json`   the project and the credential (the wire contract's SyncDaemonConfig)
 * `sync.state`  the replica id and cursor, so a restart resumes instead of resyncing
 * `daemon.json` the loopback port and secret the CLI and MCP server connect on
 */

export const syncStateSchema = z.object({
  replicaId: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  cursor: z.number().int().nonnegative().default(0)
}).strict();
export type SyncState = z.infer<typeof syncStateSchema>;

/** The loopback descriptor. Local only, so it is defined here rather than on the wire. */
export const daemonDescriptorSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  secret: z.string().min(1),
  startedAt: z.string().datetime()
}).strict();
export type DaemonDescriptor = z.infer<typeof daemonDescriptorSchema>;

async function statePath(directory: string, name: string): Promise<string> {
  return resolveGitPath(await repositoryRoot(directory), `crosscode/${name}`);
}

export const syncConfigPath = (directory: string) => statePath(directory, "sync.json");
export const syncStatePath = (directory: string) => statePath(directory, "sync.state");
export const daemonDescriptorPath = (directory: string) => statePath(directory, "daemon.json");

/** Writes 0600 through a temp file, so a reader never sees a half-written config. */
async function writePrivate(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw new Error(`Crosscode state must not be a symbolic link: ${path}`);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function readSyncConfig(directory: string): Promise<SyncDaemonConfig> {
  const path = await syncConfigPath(directory);
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("This checkout is not joined to a Crosscode project; run `crosscode start`");
    throw error;
  });
  return syncDaemonConfigSchema.parse(JSON.parse(raw));
}

export async function writeSyncConfig(directory: string, config: SyncDaemonConfig): Promise<void> {
  await writePrivate(await syncConfigPath(directory), JSON.stringify(syncDaemonConfigSchema.parse(config)));
}

export async function readSyncState(directory: string): Promise<SyncState> {
  const path = await syncStatePath(directory);
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (!raw) return { cursor: 0 };
  // A corrupt state file costs a resync, not a start-up failure: the cursor is a cache of
  // where we got to, and the service can always tell us again.
  const parsed = syncStateSchema.safeParse(JSON.parse(raw) as unknown);
  return parsed.success ? parsed.data : { cursor: 0 };
}

export async function writeSyncState(directory: string, state: SyncState): Promise<void> {
  await writePrivate(await syncStatePath(directory), JSON.stringify(syncStateSchema.parse(state)));
}

export async function writeDaemonDescriptor(directory: string, descriptor: DaemonDescriptor): Promise<void> {
  await writePrivate(await daemonDescriptorPath(directory), JSON.stringify(daemonDescriptorSchema.parse(descriptor)));
}

/**
 * One daemon per checkout. Two would each watch the other's writes and publish them back
 * as their own, so a stale descriptor is cleaned up and a live one is refused.
 */
export async function assertNotAlreadyRunning(directory: string): Promise<void> {
  const path = await daemonDescriptorPath(directory);
  const existing = await readFile(path, "utf8").then((raw) => daemonDescriptorSchema.parse(JSON.parse(raw))).catch(() => undefined);
  if (!existing || existing.pid === process.pid) return;
  try { process.kill(existing.pid, 0); }
  catch { await rm(path, { force: true }); return; }
  throw new Error("A Crosscode daemon is already running for this worktree");
}

/** Removes the descriptor only if it is still ours, so a restart never deletes the new one. */
export async function removeOwnedDescriptor(directory: string, descriptor: DaemonDescriptor): Promise<void> {
  const path = await daemonDescriptorPath(directory);
  const current = await readFile(path, "utf8").then((raw) => daemonDescriptorSchema.parse(JSON.parse(raw))).catch(() => undefined);
  if (current?.pid === descriptor.pid && current.secret === descriptor.secret) await rm(path, { force: true });
}
