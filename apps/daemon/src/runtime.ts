import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FSWatcher } from "chokidar";
import { AgentDelegatedReviewer } from "@crosscode/core";
import { discoverRepository, resolveGitPath } from "@crosscode/git";
import { daemonConfigSchema, daemonConnectionSchema, type DaemonConfig, type DaemonConnection, type PresenceUpdate } from "@crosscode/protocol";
import { startDaemon, type RunningDaemon } from "./index.js";
import { CoordinationServiceClient, type CoordinationServiceIdentity } from "./service-client.js";
import { LiveSyncClient } from "./ws-client.js";
import { keychainAvailable, readSecret, storeSecret, deleteSecret } from "./keychain.js";
import { getSupabaseClient, toStoredSession } from "./supabase-client.js";

const KEYCHAIN_REFRESH_TOKEN_SENTINEL = "stored-in-os-keychain";

function keychainAccount(config: Pick<DaemonConfig, "workspaceId" | "actorId">): string {
  return `${config.workspaceId}:${config.actorId}`;
}

export async function daemonConfigPath(directory: string): Promise<string> {
  const repository = await discoverRepository(directory);
  return resolveGitPath(repository.root, "crosscode/config.json");
}

export async function daemonConnectionPath(directory: string): Promise<string> {
  const repository = await discoverRepository(directory);
  return resolveGitPath(repository.root, "crosscode/daemon.json");
}

export async function readDaemonConfig(directory: string): Promise<DaemonConfig> {
  const config = daemonConfigSchema.parse(JSON.parse(await readFile(await daemonConfigPath(directory), "utf8")));
  if (!config.service?.session || config.service.session.refreshToken !== KEYCHAIN_REFRESH_TOKEN_SENTINEL) return config;
  const refreshToken = await readSecret(keychainAccount(config));
  if (!refreshToken) throw new Error("Supabase session was not found in the config file or the OS keychain; run `crosscode -- login` again");
  return { ...config, service: { ...config.service, session: { ...config.service.session, refreshToken } } };
}

export async function writeDaemonConfig(directory: string, config: DaemonConfig): Promise<void> {
  const path = await daemonConfigPath(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw new Error("Crosscode configuration must not be a symbolic link");
  let toWrite = daemonConfigSchema.parse(config);
  const refreshToken = toWrite.service?.session?.refreshToken;
  if (refreshToken && refreshToken !== KEYCHAIN_REFRESH_TOKEN_SENTINEL && await keychainAvailable()) {
    const stored = await storeSecret(keychainAccount(toWrite), refreshToken);
    if (stored) toWrite = { ...toWrite, service: { ...toWrite.service!, session: { ...toWrite.service!.session!, refreshToken: KEYCHAIN_REFRESH_TOKEN_SENTINEL } } };
  }
  const temporary = join(dirname(path), `.config.${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(toWrite), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function login(directory: string, credentials: { email: string; password: string; serviceUrl?: string }): Promise<DaemonConfig> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before `crosscode -- login`");
  const serviceUrl = credentials.serviceUrl ?? config.service?.url;
  if (!serviceUrl) throw new Error("A service URL is required to log in; pass --service or run `crosscode join` first");
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: credentials.email, password: credentials.password });
  if (error || !data.session) throw new Error(`Supabase sign-in failed: ${error?.message ?? "no session returned"}`);
  const updated: DaemonConfig = { ...config, service: { url: serviceUrl, session: toStoredSession(data.session) } };
  await writeDaemonConfig(directory, updated);
  return updated;
}

export async function logout(directory: string): Promise<void> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config?.service?.session) return;
  const supabase = getSupabaseClient();
  await supabase.auth.signOut().catch(() => {});
  await deleteSecret(keychainAccount(config));
  await writeDaemonConfig(directory, { ...config, service: { url: config.service.url } });
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

function createServiceClient(directory: string, config: Pick<DaemonConfig, "workspaceId" | "actorId" | "replicaId">, service: NonNullable<DaemonConfig["service"]>): CoordinationServiceClient {
  const identity: CoordinationServiceIdentity = { workspaceId: config.workspaceId, actorId: config.actorId, replicaId: config.replicaId };
  return new CoordinationServiceClient(identity, service, {
    onSessionRefreshed: async (session) => {
      const latest = await readDaemonConfig(directory).catch(() => undefined);
      if (!latest?.service) return;
      await writeDaemonConfig(directory, { ...latest, service: { ...latest.service, session } });
    },
    onReplicaRegistered: async (replicaId) => {
      const latest = await readDaemonConfig(directory).catch(() => undefined);
      if (!latest) return;
      await writeDaemonConfig(directory, { ...latest, replicaId });
    }
  });
}

export async function runDaemonProcess(
  directory: string,
  options: { gitPollMs?: number; syncPollMs?: number; liveSync?: boolean; replicaName?: string; onPresence?: (presence: PresenceUpdate) => void } = {}
): Promise<ManagedDaemon> {
  let config = await readDaemonConfig(directory);
  const connectionPath = await daemonConnectionPath(directory);
  const lock = await acquireDaemonLock(connectionPath);
  let running: RunningDaemon;
  let serviceClient: CoordinationServiceClient | undefined;
  try {
    if (config.service) {
      serviceClient = createServiceClient(directory, config, config.service);
      if (!config.replicaId) config = { ...config, replicaId: await serviceClient.ensureReplicaRegistered(options.replicaName) };
    } else if (!config.replicaId) {
      throw new Error("No replica identity configured; run `crosscode -- login` to enable self-service replica registration, or `crosscode init` for a local-only identity");
    }
  } catch (error) { await removeOwnedLock(lock); throw error; }
  const daemonOptions = { workspaceId: config.workspaceId, replicaId: config.replicaId!, actorId: config.actorId, reviewer: new AgentDelegatedReviewer() };
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
    if (config.service && serviceClient) {
      const client = serviceClient;
      running.daemon.configureRemoteSync();
      let rerunRequested = false;
      const synchronize = async () => {
        if (stopped) return;
        if (syncing) { rerunRequested = true; return; }
        syncing = true;
        try { await running.daemon.runExclusive(() => running.daemon.syncRemote(client)); }
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
        liveSync = new LiveSyncClient(config, config.service, client, {
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
          },
          onHandoff: (handoff) => {
            if (handoff.workspaceId === config.workspaceId) void synchronize();
          },
          onIntent: (intent) => {
            if (intent.workspaceId === config.workspaceId) void synchronize();
          },
          onValidation: (validation) => {
            if (validation.workspaceId === config.workspaceId) void synchronize();
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
