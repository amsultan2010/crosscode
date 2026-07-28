import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FSWatcher } from "chokidar";
import { discoverRepository, resolveGitPath } from "@crosscode/git";
import { daemonConfigSchema, daemonConnectionSchema, type DaemonConfig, type DaemonConnection, type PresenceUpdate } from "@crosscode/protocol";
import { startDaemon, type RunningDaemon } from "./index.js";
import { CoordinationServiceClient } from "./service-client.js";
import { LiveSyncClient } from "./ws-client.js";

export async function daemonConfigPath(directory: string): Promise<string> {
  const repository = await discoverRepository(directory);
  return resolveGitPath(repository.root, "crosscode/config.json");
}

export async function daemonConnectionPath(directory: string): Promise<string> {
  const repository = await discoverRepository(directory);
  return resolveGitPath(repository.root, "crosscode/daemon.json");
}

export async function readDaemonConfig(directory: string): Promise<DaemonConfig> {
  return daemonConfigSchema.parse(JSON.parse(await readFile(await daemonConfigPath(directory), "utf8")));
}

export async function writeDaemonConfig(directory: string, config: DaemonConfig): Promise<void> {
  const path = await daemonConfigPath(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw new Error("Crosscode configuration must not be a symbolic link");
  const temporary = join(dirname(path), `.config.${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(daemonConfigSchema.parse(config)), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function writeConnection(path: string, connection: DaemonConnection): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = join(dirname(path), `.daemon.${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(daemonConnectionSchema.parse(connection)), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function removeOwnedConnection(path: string, connection: DaemonConnection): Promise<void> {
  const current = await readFile(path, "utf8").then((value) => daemonConnectionSchema.parse(JSON.parse(value))).catch(() => undefined);
  if (current?.pid === connection.pid && current.secret === connection.secret) await rm(path, { force: true });
}

type DaemonLock = { path: string; instanceId: string };

async function acquireDaemonLock(connectionPath: string): Promise<DaemonLock> {
  const path = join(dirname(connectionPath), "daemon.lock");
  const instanceId = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, instanceId }));
      await handle.close();
      return { path, instanceId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing: { pid?: number } = await readFile(path, "utf8").then((value) => JSON.parse(value) as { pid?: number }).catch(() => ({}));
      let alive = false;
      if (existing.pid) {
        try { process.kill(existing.pid, 0); alive = true; } catch {}
      }
      if (alive) throw new Error("A Crosscode daemon is already running for this worktree");
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not acquire the Crosscode daemon lock");
}

async function removeOwnedLock(lock: DaemonLock): Promise<void> {
  const current = await readFile(lock.path, "utf8").then((value) => JSON.parse(value) as { instanceId?: string }).catch(() => undefined);
  if (current?.instanceId === lock.instanceId) await rm(lock.path, { force: true });
}

export type ManagedDaemon = {
  connection: DaemonConnection;
  running: RunningDaemon;
  watcher: FSWatcher;
  stop: () => Promise<void>;
};

export async function runDaemonProcess(
  directory: string,
  options: { gitPollMs?: number; syncPollMs?: number; liveSync?: boolean; onPresence?: (presence: PresenceUpdate) => void } = {}
): Promise<ManagedDaemon> {
  const config = await readDaemonConfig(directory);
  const connectionPath = await daemonConnectionPath(directory);
  const lock = await acquireDaemonLock(connectionPath);
  let running: RunningDaemon;
  const daemonOptions = { workspaceId: config.workspaceId, replicaId: config.replicaId, actorId: config.actorId };
  try { running = await startDaemon(directory, daemonOptions); }
  catch (error) { await removeOwnedLock(lock); throw error; }
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  let liveSync: LiveSyncClient | undefined;
  let stopped = false;
  let observing = false;
  let syncing = false;
  const connection = daemonConnectionSchema.parse({ pid: process.pid, port: running.port, secret: running.secret, startedAt: new Date().toISOString() });
  try {
    watcher = await running.daemon.watch({ onError: (error) => console.error("Crosscode watcher error", error) });
    await running.daemon.runExclusive(() => running.daemon.capture("Recovered offline filesystem edits")).catch((error) => {
      if (!(error instanceof Error) || error.message !== "No eligible working-tree changes to capture") throw error;
    });
    if (config.service) {
      const serviceClient = new CoordinationServiceClient(config, config.service);
      running.daemon.configureRemoteSync();
      let rerunRequested = false;
      const synchronize = async () => {
        if (stopped) return;
        if (syncing) { rerunRequested = true; return; }
        syncing = true;
        try { await running.daemon.runExclusive(() => running.daemon.syncRemote(serviceClient)); }
        catch { running.daemon.recordRemoteSyncFailure(); }
        finally {
          syncing = false;
          if (rerunRequested && !stopped) { rerunRequested = false; void synchronize(); }
        }
      };
      void synchronize();
      syncTimer = setInterval(synchronize, options.syncPollMs ?? 1_000);
      syncTimer.unref();
      if (options.liveSync ?? true) {
        liveSync = new LiveSyncClient(config, config.service, {
          onOperation: (operation) => {
            if (operation.workspaceId === config.workspaceId) void synchronize();
          },
          onPresence: (presence) => {
            console.error(`Crosscode presence: ${presence.actorId} (${presence.replicaId}) is ${presence.status}`);
            options.onPresence?.(presence);
          },
          onTask: (task) => {
            if (task.workspaceId === config.workspaceId) void synchronize();
          },
          onClaim: (claim) => {
            if (claim.workspaceId === config.workspaceId) void synchronize();
          }
        });
        liveSync.start();
      }
    }
    timer = setInterval(async () => {
      if (observing || stopped) return;
      observing = true;
      try {
        await running.daemon.runExclusive(async () => {
          const transition = await running.daemon.observeGitTransition();
          if (transition.kind !== "unchanged") await running.daemon.reanalyzePendingOperations();
        });
      } catch (error) {
        console.error("Crosscode Git observer error", error);
      } finally {
        observing = false;
      }
    }, options.gitPollMs ?? 250);
    timer.unref();
    await writeConnection(connectionPath, connection);
  } catch (error) {
    if (timer) clearInterval(timer);
    if (syncTimer) clearInterval(syncTimer);
    liveSync?.stop();
    if (watcher) await watcher.close();
    try { await running.close(); } finally { await removeOwnedLock(lock); }
    throw error;
  }
  const activeWatcher = watcher;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await removeOwnedConnection(connectionPath, connection);
    if (timer) clearInterval(timer);
    if (syncTimer) clearInterval(syncTimer);
    liveSync?.stop();
    await activeWatcher.close();
    await running.daemon.drain();
    try { await running.close(); } finally { await removeOwnedLock(lock); }
  };
  return { connection, running, watcher: activeWatcher, stop };
}
