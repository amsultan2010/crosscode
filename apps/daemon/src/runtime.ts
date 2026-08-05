import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FSWatcher } from "chokidar";
import { discoverRepository, remoteUrl, resolveGitPath } from "@crosscode/git";
import { daemonConfigSchema, daemonConnectionSchema, type DaemonConfig, type DaemonConnection, type PresenceUpdate } from "@crosscode/protocol";
import { cliSignInUrl, openInBrowser, startLoginCallbackServer } from "./browser-login.js";
import { resolveDefaultServiceUrl } from "./hosted.js";
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
  if (!refreshToken) throw new Error("Supabase session was not found in the config file or the OS keychain; run `crosscode login` again");
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

export type LoggedIn = { config: DaemonConfig; user: { id: string; email: string } };

/** Headless/agent login: credentials in, session persisted, nothing to open. */
export async function login(directory: string, credentials: { email: string; password: string }): Promise<LoggedIn> {
  const config = await loginTarget(directory);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: credentials.email, password: credentials.password });
  if (error || !data.session) throw new Error(`Supabase sign-in failed: ${error?.message ?? "no session returned"}`);
  const updated: DaemonConfig = { ...config, service: { url: resolveDefaultServiceUrl(), session: toStoredSession(data.session) } };
  await writeDaemonConfig(directory, updated);
  return { config: updated, user: { id: data.session.user.id, email: data.session.user.email ?? credentials.email } };
}

/**
 * Browser login: stands up the loopback callback server, hands the caller the URL to open,
 * and persists whatever the website posts back. Supabase Auth runs entirely in the browser
 * here, so no password ever reaches the terminal; login() above stays the headless path.
 */
export async function browserLogin(
  directory: string,
  options: { webUrl: string; openBrowser?: boolean; timeoutMs?: number; onUrl?: (url: string) => void }
): Promise<LoggedIn> {
  const config = await loginTarget(directory);
  const server = await startLoginCallbackServer({ timeoutMs: options.timeoutMs });
  try {
    const url = cliSignInUrl(options.webUrl, server.port, server.state);
    options.onUrl?.(url);
    if (options.openBrowser ?? true) openInBrowser(url);
    const callback = await server.session;
    const updated: DaemonConfig = {
      ...config,
      service: {
        url: resolveDefaultServiceUrl(),
        session: {
          accessToken: callback.access_token,
          refreshToken: callback.refresh_token,
          expiresAt: new Date(callback.expires_at * 1_000).toISOString()
        }
      }
    };
    await writeDaemonConfig(directory, updated);
    return { config: updated, user: callback.user };
  } finally {
    await server.close();
  }
}

async function loginTarget(directory: string): Promise<DaemonConfig> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before `crosscode login`");
  return config;
}

// Self-serve counterpart to login(): creates the Supabase Auth user via the anon key
// (no service-role key involved) instead of signing in to an existing one. Supabase Auth
// can be configured to require email confirmation, in which case signUp() returns a user
// but no session -- surfaced here as an error telling the caller to confirm and log in.
export async function signup(directory: string, credentials: { email: string; password: string; invite?: string; workspaceName?: string }): Promise<DaemonConfig> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before `crosscode signup`");
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signUp({ email: credentials.email, password: credentials.password });
  if (error || !data.session) {
    throw new Error(`Supabase sign-up failed: ${error?.message ?? "no session returned (email confirmation may be required; confirm and run `crosscode login`)"}`);
  }
  // actorId must match what the service records as the member's actor_id, which for
  // invite-redeemed and self-serve-created members is the account email (see
  // apps/service/src/http.ts's use of the verified token's email claim).
  let updated: DaemonConfig = { ...config, actorId: credentials.email, service: { url: resolveDefaultServiceUrl(), session: toStoredSession(data.session) } };
  await writeDaemonConfig(directory, updated);
  // A brand-new account has no workspace yet: redeem the given invite, or self-serve
  // create one so `crosscode signup` always lands the user somewhere usable rather
  // than leaving an authenticated-but-workspace-less account.
  updated = credentials.invite
    ? await redeemInvite(directory, credentials.invite)
    : await createWorkspace(directory, credentials.workspaceName ?? `${credentials.email}'s workspace`);
  return updated;
}

/**
 * One authenticated call to the coordination service using this checkout's stored
 * session. Every CLI-side service call goes through here so the auth header, the
 * workspace header, the timeout, and the `{ ok, data | error }` envelope are handled in
 * exactly one place -- and so a plan or permission refusal surfaces as the service's own
 * message rather than a bare status code.
 */
export async function serviceRequest<T>(
  directory: string,
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; workspaceId?: string; describe?: string } = {}
): Promise<T> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before talking to the coordination service");
  if (!config.service?.session) throw new Error("Run `crosscode login` first");
  const response = await fetch(new URL(path, config.service.url ?? resolveDefaultServiceUrl()), {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${config.service.session.accessToken}`,
      "x-crosscode-workspace-id": init.workspaceId ?? config.workspaceId,
      ...(init.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000)
  });
  const envelope = await response.json().catch(() => undefined) as
    | { ok: true; data: T }
    | { ok: false; error: string }
    | undefined;
  if (!response.ok || !envelope?.ok) {
    throw new Error(envelope && !envelope.ok ? envelope.error : `${init.describe ?? "Service request"} failed with status ${response.status}`);
  }
  return envelope.data;
}

export async function createWorkspace(directory: string, name: string): Promise<DaemonConfig> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before creating a workspace");
  if (!config.service?.session) throw new Error("Run `crosscode login` or `crosscode signup` before creating a workspace");
  const created = await serviceRequest<{ workspaceId: string; memberId: string }>(directory, "/v1/workspaces", {
    method: "POST", body: { name }, describe: "Workspace creation"
  });
  const updated: DaemonConfig = { ...config, workspaceId: created.workspaceId };
  await writeDaemonConfig(directory, updated);
  return updated;
}

// Redeems a workspace invite code against the coordination service and records the
// resulting workspaceId locally, standing in for the workspaceId a `crosscode join
// --workspace <id>` would otherwise require out-of-band.
export async function redeemInvite(directory: string, code: string): Promise<DaemonConfig> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before `crosscode join --invite`");
  if (!config.service?.session) throw new Error("Run `crosscode login` or `crosscode signup` before `crosscode join --invite`");
  const redeemed = await serviceRequest<{ workspaceId: string; memberId: string; role: string }>(
    directory, `/v1/invites/${encodeURIComponent(code)}/redeem`, { method: "POST", body: {}, describe: "Invite redemption" }
  );
  const updated: DaemonConfig = { ...config, workspaceId: redeemed.workspaceId };
  await writeDaemonConfig(directory, updated);
  return updated;
}

/**
 * Drops the Supabase session this checkout holds. Local only.
 */
export async function logout(directory: string): Promise<{ session: boolean }> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config?.service) return { session: false };
  const cleared = { session: Boolean(config.service.session) };
  if (cleared.session) {
    const supabase = getSupabaseClient();
    await supabase.auth.signOut().catch(() => {});
  }
  await deleteSecret(keychainAccount(config));
  if (!cleared.session) return cleared;
  await writeDaemonConfig(directory, { ...config, service: { url: config.service.url } });
  return cleared;
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

/**
 * Repo root + origin URL for the project this daemon belongs to (Contract B). Never
 * throws: a daemon that cannot describe its repository should still start, just without
 * project attribution.
 */
async function describeRepository(directory: string): Promise<{ repoRoot: string | null; repoRemote: string | null }> {
  const repository = await discoverRepository(directory).catch(() => undefined);
  if (!repository) return { repoRoot: null, repoRemote: null };
  return { repoRoot: repository.root, repoRemote: (await remoteUrl(repository.root).catch(() => undefined)) ?? null };
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
      if (!config.replicaId) {
        config = { ...config, replicaId: await serviceClient.ensureReplicaRegistered(options.replicaName, await describeRepository(directory)) };
      }
    } else if (!config.replicaId) {
      throw new Error("No replica identity configured; run `crosscode login` to enable self-service replica registration, or `crosscode init` for a local-only identity");
    }
  } catch (error) { await removeOwnedLock(lock); throw error; }
  const daemonOptions = { workspaceId: config.workspaceId, replicaId: config.replicaId!, actorId: config.actorId, transport: serviceClient };
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
      // Live sync subscribes with whichever credential this checkout holds. The polling
      // loop above stays as the fallback for whenever the socket is down.
      if (options.liveSync ?? true) {
        liveSync = new LiveSyncClient(config, config.service, client, {
          onOperation: (operation) => {
            if (operation.workspaceId === config.workspaceId) void synchronize();
          },
          onPresence: (presence) => {
            console.error(`Crosscode presence: ${presence.actorId} (${presence.replicaId}) is ${presence.status}`);
            options.onPresence?.(presence);
          }
        });
        liveSync.start();
      }
    }
    timer = setInterval(async () => {
      if (observing || stopped) return;
      observing = true;
      try {
        await running.daemon.runExclusive(() => running.daemon.observeGitTransition());
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
