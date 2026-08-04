import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FSWatcher } from "chokidar";
import { AgentDelegatedReviewer } from "@crosscode/core";
import { discoverRepository, remoteUrl, resolveGitPath } from "@crosscode/git";
import {
  claimPairingCodeRequestSchema, claimPairingCodeResponseSchema, daemonConfigSchema, daemonConnectionSchema,
  PAIRING_CODE_TTL_MS,
  type DaemonConfig, type DaemonConnection, type PresenceUpdate
} from "@crosscode/protocol";
import { cliSignInUrl, openInBrowser, startLoginCallbackServer } from "./browser-login.js";
import { resolveDefaultServiceUrl } from "./hosted.js";
import { startDaemon, type RunningDaemon } from "./index.js";
import { CoordinationServiceClient, type CoordinationServiceIdentity } from "./service-client.js";
import { LiveSyncClient } from "./ws-client.js";
import { keychainAvailable, readSecret, storeSecret, deleteSecret } from "./keychain.js";
import { getSupabaseClient, toStoredSession } from "./supabase-client.js";
import {
  KeyringSource, createKeyring, deviceFingerprint, exportRecoveryCode, forgetKeyring, generateDeviceKeyPair,
  importRecoveryCode, loadKeyring, rotateKeyring, saveKeyring, type Keyring
} from "./workspace-key.js";

const execFile = promisify(execFileCallback);

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
export async function login(directory: string, credentials: { email: string; password: string; serviceUrl?: string }): Promise<LoggedIn> {
  const config = await loginTarget(directory);
  const serviceUrl = credentials.serviceUrl ?? config.service?.url ?? resolveDefaultServiceUrl();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: credentials.email, password: credentials.password });
  if (error || !data.session) throw new Error(`Supabase sign-in failed: ${error?.message ?? "no session returned"}`);
  const updated: DaemonConfig = { ...config, service: { url: serviceUrl, session: toStoredSession(data.session) } };
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
  options: { webUrl: string; serviceUrl?: string; openBrowser?: boolean; timeoutMs?: number; onUrl?: (url: string) => void }
): Promise<LoggedIn> {
  const config = await loginTarget(directory);
  const serviceUrl = options.serviceUrl ?? config.service?.url ?? resolveDefaultServiceUrl();
  const server = await startLoginCallbackServer({ timeoutMs: options.timeoutMs });
  try {
    const url = cliSignInUrl(options.webUrl, server.port, server.state);
    options.onUrl?.(url);
    if (options.openBrowser ?? true) openInBrowser(url);
    const callback = await server.session;
    const updated: DaemonConfig = {
      ...config,
      service: {
        url: serviceUrl,
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
export async function signup(directory: string, credentials: { email: string; password: string; invite?: string; workspaceName?: string; serviceUrl?: string }): Promise<DaemonConfig> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before `crosscode signup`");
  const serviceUrl = credentials.serviceUrl ?? config.service?.url ?? resolveDefaultServiceUrl();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signUp({ email: credentials.email, password: credentials.password });
  if (error || !data.session) {
    throw new Error(`Supabase sign-up failed: ${error?.message ?? "no session returned (email confirmation may be required; confirm and run `crosscode login`)"}`);
  }
  // actorId must match what the service records as the member's actor_id, which for
  // invite-redeemed and self-serve-created members is the account email (see
  // apps/service/src/http.ts's use of the verified token's email claim).
  let updated: DaemonConfig = { ...config, actorId: credentials.email, service: { url: serviceUrl, session: toStoredSession(data.session) } };
  await writeDaemonConfig(directory, updated);
  // A brand-new account has no workspace yet: redeem the given invite, or self-serve
  // create one so `crosscode signup` always lands the user somewhere usable rather
  // than leaving an authenticated-but-workspace-less account (see BUILD_INSTRUCTIONS.md
  // Phase 8's self-serve workspace creation exit criteria).
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
  if (!config.service?.url) throw new Error("No coordination service is configured; run `crosscode login --service <url>`");
  if (!config.service.session) throw new Error("Run `crosscode login` first; this command acts as your user account and a pairing token cannot");
  const response = await fetch(new URL(path, config.service.url), {
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
 * Redeems a one-time pairing code minted by the service (Contract A). Unauthenticated
 * on purpose -- the code is the credential -- and what comes back is a workspace-scoped
 * `ccw_` token, never a user session, so this path never puts credentials that can act as
 * the user into a terminal. Works without a prior `crosscode init`: pairing is allowed to
 * be the very first thing a fresh checkout does.
 */
export async function redeemPairingCode(
  directory: string,
  code: string,
  options: { serviceUrl?: string; replicaName?: string; actorId?: string } = {}
): Promise<DaemonConfig & { deviceFingerprint?: string }> {
  const existing = await readDaemonConfig(directory).catch(() => undefined);
  const serviceUrl = options.serviceUrl ?? existing?.service?.url;
  if (!serviceUrl) throw new Error("A service URL is required to pair; pass --service <url>");
  const repository = await discoverRepository(directory);
  const actorId = options.actorId ?? existing?.actorId ?? `${process.env.USER ?? "local-user"}@${hostname()}`;
  // A fresh device identity per pairing. Registering it in the claim is what lets the
  // minting side see a fingerprint to compare and, once a human has compared it, wrap the
  // workspace keyring to this machine -- the coordination service relays both halves and
  // can open neither.
  const device = encryptionEnabled() ? generateDeviceKeyPair() : undefined;
  const request = claimPairingCodeRequestSchema.parse({
    code: code.trim().toUpperCase(),
    actorId,
    replicaName: options.replicaName ?? hostname(),
    repoRoot: repository.root,
    repoRemote: await repoRemoteUrl(repository.root, repository.remotes),
    devicePublicKey: device?.publicKey
  });
  const response = await fetch(new URL("/v1/pairing-codes/claim", serviceUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(5_000)
  });
  const envelope = await response.json().catch(() => undefined) as
    | { ok: true; data: unknown }
    | { ok: false; error: string }
    | undefined;
  if (!response.ok || !envelope?.ok) {
    // 410 is the one status worth translating: the service deliberately cannot say
    // whether the code was already claimed, expired, or never existed.
    if (response.status === 410) throw new Error("Pairing code is no longer valid; ask a workspace admin to mint a new one");
    throw new Error(envelope && !envelope.ok ? envelope.error : `Pairing failed with status ${response.status}`);
  }
  const claimed = claimPairingCodeResponseSchema.parse(envelope.data);
  const updated: DaemonConfig = {
    ...existing,
    workspaceId: claimed.workspaceId,
    replicaId: claimed.replicaId,
    actorId,
    service: { ...existing?.service, url: serviceUrl, workspaceToken: claimed.token }
  };
  await writeDaemonConfig(directory, updated);
  if (!device) return updated;
  // Device identity only -- no epoch keys. This checkout cannot read or write workspace
  // content until the approving device grants it one, which is the correct state: the
  // alternative is falling back to plaintext, and that is never the safer default.
  await saveKeyring(directory, { version: 1, workspaceId: claimed.workspaceId, currentEpoch: null, epochs: {}, device });
  return { ...updated, deviceFingerprint: deviceFingerprint(device.publicKey) };
}

// ---------------------------------------------------------------------------
// Workspace encryption keys (docs/security.md#end-to-end-encryption)
// ---------------------------------------------------------------------------

/**
 * A service client for the CLI's one-shot key commands. Unlike the daemon's, this one is
 * built and thrown away per command, so it re-reads the config every time and never holds
 * a keyring in memory between calls.
 */
async function keyClient(directory: string): Promise<{ client: CoordinationServiceClient; config: DaemonConfig }> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before managing workspace keys");
  if (!config.service) throw new Error("No coordination service is configured; run `crosscode login --service <url>` or `crosscode join --pair <code>`");
  if (!config.replicaId) throw new Error("This checkout has no replica identity yet; start the daemon once so it can register");
  if (!encryptionEnabled()) throw new Error("CROSSCODE_ENCRYPTION=off disables end-to-end encryption for this checkout");
  return { client: createServiceClient(directory, config, config.service), config };
}

export type WorkspaceKeyStatus = {
  workspaceId: string;
  /** Null when this device has registered an identity but holds no key yet. */
  currentEpoch: number | null;
  epochs: number[];
  deviceFingerprint: string;
  encryptionEnabled: boolean;
};

export async function workspaceKeyStatus(directory: string): Promise<WorkspaceKeyStatus> {
  const keyring = await loadKeyring(directory);
  if (!keyring) throw new Error("This checkout has no workspace keyring yet; start the daemon once, or run `crosscode join --pair <code>`");
  return {
    workspaceId: keyring.workspaceId,
    currentEpoch: keyring.currentEpoch,
    epochs: Object.keys(keyring.epochs).map(Number).sort((left, right) => left - right),
    deviceFingerprint: deviceFingerprint(keyring.device.publicKey),
    encryptionEnabled: encryptionEnabled()
  };
}

/**
 * Prints the workspace key as a recovery code. This is the only copy that can exist
 * outside a paired device, and we cannot reissue it -- there is nothing on our side to
 * reissue it from. Callers must not put it in `--json` output or scrollback casually;
 * `crosscode key export` writes it to stdout alone and says so.
 */
export async function exportWorkspaceKey(directory: string): Promise<string> {
  const keyring = await loadKeyring(directory);
  if (!keyring) throw new Error("This checkout has no workspace keyring to export");
  return exportRecoveryCode(keyring);
}

export async function importWorkspaceKey(directory: string, recoveryCode: string): Promise<WorkspaceKeyStatus> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config) throw new Error("Run `crosscode init` before importing a workspace key");
  const existing = await loadKeyring(directory).catch(() => undefined);
  const imported = importRecoveryCode(recoveryCode, config.workspaceId);
  // Keep this machine's device identity if it already has one: it may already be a
  // registered grant recipient, and swapping the public key would orphan those grants
  // (the service refuses to re-register a device under a different key, by design).
  const keyring: Keyring = existing ? { ...imported, device: existing.device } : imported;
  await saveKeyring(directory, keyring);
  return workspaceKeyStatus(directory);
}

/** Creates the workspace's first key. Refused by the service path if anyone already holds one. */
export async function initWorkspaceKey(directory: string): Promise<WorkspaceKeyStatus> {
  const { client, config } = await keyClient(directory);
  const existing = await loadKeyring(directory).catch(() => undefined);
  if (existing?.currentEpoch !== null && existing !== undefined) throw new Error("This checkout already holds a workspace key");
  const created = createKeyring(config.workspaceId);
  await saveKeyring(directory, existing ? { ...created, device: existing.device } : created);
  await client.syncWorkspaceKeys();
  return workspaceKeyStatus(directory);
}

export async function rotateWorkspaceKey(directory: string): Promise<{ epoch: number; keyId: string; granted: number }> {
  const { client } = await keyClient(directory);
  return client.rotateWorkspaceKey();
}

/** Local only: drops this checkout's copy of the key. Nothing server-side changes. */
export async function forgetWorkspaceKey(directory: string): Promise<{ forgotten: boolean }> {
  return { forgotten: await forgetKeyring(directory) };
}

/**
 * Every device that has registered an encryption key with this workspace, with the
 * fingerprint to compare and whether it already holds the key. This is the list to read
 * when something looks wrong: a device here that nobody recognises is what a coordination
 * service inserting itself would look like, and `crosscode key rotate` is the answer.
 */
export async function listKeyDevices(directory: string): Promise<Array<{
  replicaId: string; replicaName: string; actorId: string; fingerprint: string; epochs: number[]; holdsKey: boolean;
}>> {
  const recipients = await serviceRequest<{ recipients: Array<{ replicaId: string; replicaName: string; actorId: string; publicKey: string; epochs: number[] }> }>(
    directory, "/v1/workspace-keys/recipients", { describe: "Key device list" }
  );
  return recipients.recipients.map((recipient) => ({
    replicaId: recipient.replicaId,
    replicaName: recipient.replicaName,
    actorId: recipient.actorId,
    fingerprint: deviceFingerprint(recipient.publicKey as Keyring["device"]["publicKey"]),
    epochs: recipient.epochs,
    holdsKey: recipient.epochs.length > 0
  }));
}

/** Grants one named device every key epoch this one holds. See `crosscode key approve`. */
export async function approveKeyDevice(directory: string, replicaId: string): Promise<{ granted: number; fingerprint: string }> {
  const { client } = await keyClient(directory);
  return client.approveKeyRecipient(replicaId);
}

export type PairingSession = {
  code: string;
  expiresAt: string;
  pairingId: string;
  /** Resolves once the code is claimed, with the claiming device's fingerprint to compare. */
  claimed: Promise<{ replicaId: string; actorId: string; fingerprint: string | null }>;
  approve: (replicaId: string) => Promise<{ granted: number; fingerprint: string }>;
  cancel: () => void;
};

/**
 * The minting half of Contract A, plus the key handoff. Returns as soon as the code
 * exists so the caller can display it, and exposes the claim as a promise: the CLI prints
 * the code, waits, shows the claiming device's fingerprint, and only grants the workspace
 * keyring once a human has confirmed it matches what the other machine printed.
 */
export async function startPairing(
  directory: string,
  options: { pollMs?: number; timeoutMs?: number } = {}
): Promise<PairingSession> {
  const { client } = await keyClient(directory);
  const minted = await serviceRequest<{ code: string; expiresAt: string; pairingId: string }>(
    directory, "/v1/pairing-codes", { method: "POST", body: {}, describe: "Pairing code" }
  );
  let cancelled = false;
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + (options.timeoutMs ?? PAIRING_CODE_TTL_MS);
  const claimed = (async () => {
    for (;;) {
      if (cancelled) throw new Error("Pairing cancelled");
      const status = await serviceRequest<{ status: string; replicaId: string | null; actorId: string | null; devicePublicKey: string | null }>(
        directory, `/v1/pairing-codes/${encodeURIComponent(minted.pairingId)}`, { describe: "Pairing status" }
      );
      if (status.status === "claimed" && status.replicaId) {
        return {
          replicaId: status.replicaId,
          actorId: status.actorId ?? "unknown",
          fingerprint: status.devicePublicKey ? deviceFingerprint(status.devicePublicKey as Keyring["device"]["publicKey"]) : null
        };
      }
      if (status.status === "expired" || Date.now() >= deadline) throw new Error("Pairing code expired before it was claimed");
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
  })();
  return {
    code: minted.code,
    expiresAt: minted.expiresAt,
    pairingId: minted.pairingId,
    claimed,
    approve: (replicaId: string) => client.approveKeyRecipient(replicaId),
    cancel: () => { cancelled = true; }
  };
}

async function repoRemoteUrl(root: string, remotes: string[]): Promise<string | null> {
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) return null;
  const url = await execFile("git", ["-C", root, "remote", "get-url", remote])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
  return url || null;
}

/**
 * Drops every credential this checkout holds -- a Supabase session and/or a `ccw_`
 * workspace token. The token case matters: it used to return early whenever there was no
 * session, so on a pairing-only install (`crosscode join --pair`) logout was a no-op that
 * silently left a live bearer credential on disk.
 *
 * Local only. Revoking a workspace token server-side is a workspace owner's action
 * (`crosscode devices revoke`), since a device cannot be trusted to retire itself.
 */
export async function logout(directory: string): Promise<{ session: boolean; workspaceToken: boolean }> {
  const config = await readDaemonConfig(directory).catch(() => undefined);
  if (!config?.service) return { session: false, workspaceToken: false };
  const cleared = { session: Boolean(config.service.session), workspaceToken: Boolean(config.service.workspaceToken) };
  if (cleared.session) {
    const supabase = getSupabaseClient();
    await supabase.auth.signOut().catch(() => {});
  }
  await deleteSecret(keychainAccount(config));
  if (!cleared.session && !cleared.workspaceToken) return cleared;
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

/**
 * Set CROSSCODE_ENCRYPTION=off to send file payloads to the coordination service in
 * plaintext. There is exactly one reason to: a self-hosted deployment, where the
 * "service" and the "customer" are the same party and readable payloads are worth more
 * than a property that party already has by owning the database. It cannot silently take
 * effect on a workspace that has already sent ciphertext -- the service latches, and
 * refuses the plaintext with a 409 rather than accepting the downgrade.
 */
function encryptionEnabled(): boolean {
  return (process.env.CROSSCODE_ENCRYPTION ?? "on").toLowerCase() !== "off";
}

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
  }, encryptionEnabled() ? new KeyringSource(directory) : undefined);
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
  const daemonOptions = { workspaceId: config.workspaceId, replicaId: config.replicaId!, actorId: config.actorId, reviewer: new AgentDelegatedReviewer(), transport: serviceClient };
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
        try {
          // Before anything is uploaded or downloaded: install any workspace key epoch
          // this device has been granted, and re-grant the ones it holds to devices that
          // are missing them. Sealing and opening both depend on it, so a failure here
          // has to fail the sync rather than silently fall through to a plaintext upload.
          await client.syncWorkspaceKeys();
          await running.daemon.runExclusive(() => running.daemon.syncRemote(client));
        }
        catch { running.daemon.recordRemoteSyncFailure(); }
        finally {
          syncing = false;
          if (rerunRequested && !stopped) { rerunRequested = false; void synchronize(); }
        }
      };
      void synchronize();
      syncTimer = setInterval(synchronize, options.syncPollMs ?? 1_000);
      syncTimer.unref();
      // Live sync subscribes with whichever credential this checkout holds -- a Supabase
      // session or a `ccw_` workspace token -- so a paired install gets the same push
      // updates as a logged-in one. The polling loop above stays as the fallback for
      // whenever the socket is down.
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
