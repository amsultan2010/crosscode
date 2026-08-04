import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, type KeyObject
} from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverRepository, resolveGitPath } from "@crosscode/git";
import { devicePublicKeySchema, wrappedKeySchema, type DevicePublicKey, type WrappedKey } from "@crosscode/protocol";
import { KEYRING_SERVICE_NAME, deleteSecret, keychainAvailable, readSecret, storeSecret } from "./keychain.js";

/**
 * The workspace encryption keyring: every file payload a device sends is sealed under one
 * of these epoch keys, and the coordination service never holds any of them. This module
 * lives in apps/daemon rather than packages/core on purpose -- the service links
 * @crosscode/core, so keeping every function that can produce or consume a plaintext key
 * out of it makes "the service cannot decrypt" a property of the dependency graph rather
 * than of anyone's discipline.
 */

const KEYRING_FILE = "crosscode/keyring.json";
const KEYCHAIN_SENTINEL = "stored-in-os-keychain";
/** Prefix on an exported recovery code, so a pasted string is recognisably one of ours. */
export const RECOVERY_CODE_PREFIX = "ccrk1.";

export type Keyring = {
  version: 1;
  workspaceId: string;
  /**
   * The epoch new operations are sealed under, or null for a device that has registered
   * its identity but has not been granted any key yet. That state is deliberately
   * representable: a device joining an already-encrypted workspace must wait to be
   * granted rather than fall back to sending plaintext.
   */
  currentEpoch: number | null;
  /** epoch -> 32-byte key, base64url. Old epochs are kept so history stays readable. */
  epochs: Record<string, string>;
  /** This device's X25519 identity, used to receive (and issue) wrapped epoch keys. */
  device: { publicKey: DevicePublicKey; privateKey: string };
};

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * A public name for an epoch key. Truncated SHA-256 over a domain-separated input, so it
 * identifies which key sealed a payload (and lets a device notice it is missing one)
 * without being usable to recover the key or to confirm a guess at file content.
 */
export function keyIdFor(epochKey: Buffer): string {
  return createHash("sha256").update("crosscode/key-id/v1").update(epochKey).digest("hex").slice(0, 16);
}

/** The AES-256-GCM key that seals transaction payloads. */
export function contentKeyFor(epochKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", epochKey, Buffer.alloc(0), "crosscode/content/v1", 32));
}

/** The HMAC key behind `pathToken`. Separate from the content key so neither can stand in for the other. */
export function pathKeyFor(epochKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", epochKey, Buffer.alloc(0), "crosscode/path/v1", 32));
}

/**
 * A human-comparable fingerprint of a device's public key, in the same alphabet as a
 * pairing code. 60 bits, shown on both devices during pairing: the coordination service
 * relays public keys and could substitute its own, and comparing this out of band is the
 * only thing that detects it. Long enough that finding a colliding X25519 key is not a
 * practical offline attack, short enough to read aloud.
 */
const FINGERPRINT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function deviceFingerprint(publicKey: DevicePublicKey): string {
  const digest = createHash("sha256").update("crosscode/device-fingerprint/v1").update(publicKey, "utf8").digest();
  let out = "";
  for (let index = 0; index < 12; index += 1) {
    if (index > 0 && index % 4 === 0) out += "-";
    out += FINGERPRINT_ALPHABET[digest[index]! % FINGERPRINT_ALPHABET.length];
  }
  return out;
}

export function epochKey(keyring: Keyring, epoch: number): Buffer | undefined {
  const encoded = keyring.epochs[String(epoch)];
  return encoded === undefined ? undefined : Buffer.from(encoded, "base64url");
}

export function hasEpochKeys(keyring: Keyring): boolean {
  return keyring.currentEpoch !== null;
}

export function currentEpochKey(keyring: Keyring): { epoch: number; key: Buffer; keyId: string } {
  if (keyring.currentEpoch === null) throw new Error("This device has not been granted a workspace key yet");
  const key = epochKey(keyring, keyring.currentEpoch);
  if (!key) throw new Error(`Workspace keyring is missing its current epoch (${keyring.currentEpoch})`);
  return { epoch: keyring.currentEpoch, key, keyId: keyIdFor(key) };
}

// ---------------------------------------------------------------------------
// Creating and rotating
// ---------------------------------------------------------------------------

export function createKeyring(workspaceId: string): Keyring {
  return { ...createDeviceKeyring(workspaceId), currentEpoch: 0, epochs: { "0": randomBytes(32).toString("base64url") } };
}

/**
 * A device identity with no epoch keys: enough to register a public key and receive a
 * grant, and deliberately not enough to seal anything.
 */
export function createDeviceKeyring(workspaceId: string): Keyring {
  return { version: 1, workspaceId, currentEpoch: null, epochs: {}, device: generateDeviceKeyPair() };
}

/**
 * Starts a new epoch. Deliberately additive: the previous epochs stay in the keyring, so
 * this device can still read history it already has. Rotation buys forward secrecy for
 * everything sealed *after* it -- it cannot un-share what a departing member already
 * downloaded, and nothing can, which is why docs/security.md says so plainly.
 */
export function rotateKeyring(keyring: Keyring): Keyring {
  const nextEpoch = (keyring.currentEpoch ?? -1) + 1;
  return { ...keyring, currentEpoch: nextEpoch, epochs: { ...keyring.epochs, [String(nextEpoch)]: randomBytes(32).toString("base64url") } };
}

/** Adds an epoch key received as a grant. Refuses to overwrite an epoch already held with different bytes. */
export function withEpochKey(keyring: Keyring, epoch: number, key: Buffer): Keyring {
  const existing = keyring.epochs[String(epoch)];
  const encoded = key.toString("base64url");
  if (existing !== undefined) {
    if (existing !== encoded) throw new Error(`Refusing a conflicting key for epoch ${epoch}`);
    return keyring;
  }
  return {
    ...keyring,
    epochs: { ...keyring.epochs, [String(epoch)]: encoded },
    currentEpoch: Math.max(keyring.currentEpoch ?? -1, epoch)
  };
}

// ---------------------------------------------------------------------------
// Device keys and grant wrapping
// ---------------------------------------------------------------------------

// X25519 keys have a fixed DER framing, so a raw 32-byte key round-trips through these
// two constants. Node has no raw import/export for X25519, and shipping DER on the wire
// would be 44 bytes of boilerplate around 32 bytes of key.
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export function generateDeviceKeyPair(): { publicKey: DevicePublicKey; privateKey: string } {
  const pair = generateKeyPairSync("x25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(X25519_SPKI_PREFIX.length);
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "der" }).subarray(X25519_PKCS8_PREFIX.length);
  return { publicKey: devicePublicKeySchema.parse(publicKey.toString("base64url")), privateKey: privateKey.toString("base64url") };
}

function importPublicKey(raw: DevicePublicKey): KeyObject {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) throw new Error("An X25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
}

function importPrivateKey(raw: string): KeyObject {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) throw new Error("An X25519 private key must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, bytes]), format: "der", type: "pkcs8" });
}

/**
 * The AES key both sides of a grant derive. Both public keys go into the HKDF info in a
 * fixed sender-then-recipient order, so a shared secret can only ever open the grant it
 * was derived for -- a wrapped key cannot be replayed toward a different recipient.
 */
function grantKey(shared: Buffer, senderPublicKey: string, recipientPublicKey: string, epoch: number): Buffer {
  const info = `crosscode/key-grant/v1|${senderPublicKey}|${recipientPublicKey}|${epoch}`;
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), info, 32));
}

export function wrapEpochKey(input: {
  epoch: number;
  key: Buffer;
  recipientPublicKey: DevicePublicKey;
  sender: Keyring["device"];
}): WrappedKey {
  const shared = diffieHellman({ privateKey: importPrivateKey(input.sender.privateKey), publicKey: importPublicKey(input.recipientPublicKey) });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", grantKey(shared, input.sender.publicKey, input.recipientPublicKey, input.epoch), nonce);
  const ciphertext = Buffer.concat([cipher.update(input.key), cipher.final(), cipher.getAuthTag()]);
  return wrappedKeySchema.parse({
    version: 1, algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
    senderPublicKey: input.sender.publicKey, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url")
  });
}

export function unwrapEpochKey(input: { epoch: number; wrapped: WrappedKey; recipient: Keyring["device"] }): Buffer {
  const shared = diffieHellman({ privateKey: importPrivateKey(input.recipient.privateKey), publicKey: importPublicKey(input.wrapped.senderPublicKey) });
  const bytes = Buffer.from(input.wrapped.ciphertext, "base64url");
  if (bytes.length <= 16) throw new Error("Wrapped key is malformed");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    grantKey(shared, input.wrapped.senderPublicKey, input.recipient.publicKey, input.epoch),
    Buffer.from(input.wrapped.nonce, "base64url")
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const key = Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]);
  if (key.length !== 32) throw new Error("Wrapped key did not contain a 32-byte epoch key");
  return key;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function keyringPath(directory: string): Promise<string> {
  const repository = await discoverRepository(directory);
  return resolveGitPath(repository.root, KEYRING_FILE);
}

/**
 * Per *checkout*, not per workspace. Several checkouts of the same workspace live on one
 * machine routinely (that is the case Crosscode exists for), and keying the keychain entry
 * on the workspace alone would have them overwrite each other's wrapping key -- leaving
 * every checkout but the last with a file it can no longer open.
 */
function keychainAccount(file: Pick<KeyringFile, "workspaceId" | "keyringId">): string {
  return `${file.workspaceId}:${file.keyringId}`;
}

/**
 * The on-disk keyring. When the OS keychain is available the file holds only ciphertext
 * and the keychain holds the 32-byte key that opens it; otherwise the file holds the
 * keyring directly, at mode 0600, which is exactly what the daemon config already does
 * for the Supabase refresh token.
 *
 * The indirection exists because macOS caps a keychain secret written through stdin at
 * 128 bytes and a keyring with several epochs is comfortably larger. Storing a small
 * wrapping key there and the bulk in an encrypted file is the same protection with none
 * of the size limit.
 */
type KeyringFile = {
  version: 1;
  workspaceId: string;
  keyringId: string;
  wrapping: typeof KEYCHAIN_SENTINEL | "file";
  nonce?: string;
  keyring: string;
};

function fileCipherKey(wrappingKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", wrappingKey, Buffer.alloc(0), "crosscode/keyring-file/v1", 32));
}

export async function loadKeyring(directory: string): Promise<Keyring | undefined> {
  const path = await keyringPath(directory).catch(() => undefined);
  if (!path) return undefined;
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const file = JSON.parse(raw) as KeyringFile;
  if (file.wrapping !== KEYCHAIN_SENTINEL) return parseKeyring(Buffer.from(file.keyring, "base64url").toString("utf8"));
  const wrappingKey = await readSecret(keychainAccount(file), KEYRING_SERVICE_NAME);
  if (!wrappingKey) {
    throw new Error("The workspace encryption key was not found in the OS keychain; restore it with `crosscode key import <recovery code>`");
  }
  const bytes = Buffer.from(file.keyring, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", fileCipherKey(Buffer.from(wrappingKey, "base64url")), Buffer.from(file.nonce ?? "", "base64url"));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return parseKeyring(Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString("utf8"));
}

/**
 * Mtime-gated cache over loadKeyring(). The daemon needs the keyring on every sync, which
 * on a busy checkout is several times a second, and reading it for real costs a child
 * process on both supported platforms (`git rev-parse` to find the Git directory, then
 * `security`/`secret-tool` for the wrapping key). Doing that per sync starved the file
 * watcher badly enough to delay captures.
 *
 * A single `stat` is all a steady state costs here. It still picks up a rotation or an
 * import performed by the CLI in another process, which is why the daemon does not simply
 * hold the keyring it loaded at startup.
 */
export class KeyringSource {
  private cached: { mtimeMs: number; keyring: Keyring } | undefined;
  /** The keyring path never changes for a directory, so it is resolved once, not per call. */
  private resolvedPath: Promise<string | undefined> | undefined;

  constructor(private readonly directory: string) {}

  private path(): Promise<string | undefined> {
    this.resolvedPath ??= keyringPath(this.directory).catch(() => undefined);
    return this.resolvedPath;
  }

  async get(): Promise<Keyring | undefined> {
    const path = await this.path();
    const mtimeMs = path ? await stat(path).then((info) => info.mtimeMs, () => undefined) : undefined;
    if (mtimeMs === undefined) { this.cached = undefined; return undefined; }
    if (this.cached?.mtimeMs === mtimeMs) return this.cached.keyring;
    const keyring = await loadKeyring(this.directory);
    this.cached = keyring ? { mtimeMs, keyring } : undefined;
    return keyring;
  }

  /** Persists and immediately re-caches, so a grant merged mid-sync is visible to the next seal. */
  async save(keyring: Keyring): Promise<void> {
    await saveKeyring(this.directory, keyring);
    this.cached = undefined;
  }
}

export async function saveKeyring(directory: string, keyring: Keyring): Promise<void> {
  const path = await keyringPath(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw new Error("The Crosscode keyring must not be a symbolic link");
  const plaintext = Buffer.from(JSON.stringify(parseKeyring(JSON.stringify(keyring))), "utf8");
  // Reuse this checkout's existing keychain account so a rotation or a merged grant does
  // not orphan the entry it is replacing.
  const previous = await readFile(path, "utf8").then((raw) => JSON.parse(raw) as KeyringFile, () => undefined);
  const keyringId = previous?.keyringId ?? randomUUID();
  const wrappingKey = randomBytes(32);
  const identity = { workspaceId: keyring.workspaceId, keyringId };
  const stored = await keychainAvailable()
    ? await storeSecret(keychainAccount(identity), wrappingKey.toString("base64url"), KEYRING_SERVICE_NAME)
    : false;
  let file: KeyringFile;
  if (stored) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", fileCipherKey(wrappingKey), nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    file = { ...identity, version: 1, wrapping: KEYCHAIN_SENTINEL, nonce: nonce.toString("base64url"), keyring: ciphertext.toString("base64url") };
  } else {
    file = { ...identity, version: 1, wrapping: "file", keyring: plaintext.toString("base64url") };
  }
  const temporary = join(dirname(path), `.keyring.${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/** Drops this checkout's copy of the key. The workspace's history stays sealed under it. */
export async function forgetKeyring(directory: string): Promise<boolean> {
  const path = await keyringPath(directory).catch(() => undefined);
  if (!path) return false;
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return false;
  const file = JSON.parse(raw) as KeyringFile;
  await deleteSecret(keychainAccount(file), KEYRING_SERVICE_NAME);
  await rm(path, { force: true });
  return true;
}

function parseKeyring(json: string): Keyring {
  const value = JSON.parse(json) as Keyring;
  if (value.version !== 1 || typeof value.workspaceId !== "string" || !(value.currentEpoch === null || typeof value.currentEpoch === "number")) {
    throw new Error("The Crosscode keyring is malformed");
  }
  devicePublicKeySchema.parse(value.device?.publicKey);
  if (typeof value.device.privateKey !== "string") throw new Error("The Crosscode keyring is malformed");
  for (const [epoch, key] of Object.entries(value.epochs ?? {})) {
    if (!/^\d+$/.test(epoch) || Buffer.from(key, "base64url").length !== 32) throw new Error("The Crosscode keyring is malformed");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * The escape hatch for "every device that held this key is gone". Carries the epoch keys
 * and not the device identity, so importing one on a new machine yields a fresh device
 * keypair that still has to be granted -- or, as here, already holds every epoch it needs.
 *
 * We cannot regenerate this for anyone: it is the only copy outside the devices holding
 * the key, which is exactly what makes "we cannot read your code" true.
 */
export function exportRecoveryCode(keyring: Keyring): string {
  if (keyring.currentEpoch === null) throw new Error("This device holds no workspace key to export");
  return `${RECOVERY_CODE_PREFIX}${Buffer.from(JSON.stringify({
    v: 1, workspaceId: keyring.workspaceId, currentEpoch: keyring.currentEpoch, epochs: keyring.epochs
  }), "utf8").toString("base64url")}`;
}

export function importRecoveryCode(code: string, workspaceId: string): Keyring {
  const trimmed = code.trim();
  if (!trimmed.startsWith(RECOVERY_CODE_PREFIX)) throw new Error(`A recovery code starts with ${RECOVERY_CODE_PREFIX}`);
  const decoded = JSON.parse(Buffer.from(trimmed.slice(RECOVERY_CODE_PREFIX.length), "base64url").toString("utf8")) as
    { v: number; workspaceId: string; currentEpoch: number | null; epochs: Record<string, string> };
  if (decoded.v !== 1) throw new Error("Unsupported recovery code version");
  if (decoded.workspaceId !== workspaceId) throw new Error(`This recovery code belongs to workspace ${decoded.workspaceId}, not ${workspaceId}`);
  return parseKeyring(JSON.stringify({
    version: 1, workspaceId, currentEpoch: decoded.currentEpoch, epochs: decoded.epochs, device: generateDeviceKeyPair()
  }));
}

/** Constant-time compare for the fingerprint confirmation, so a mismatch leaks no prefix. */
export function fingerprintsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left.trim().toUpperCase(), "utf8");
  const b = Buffer.from(right.trim().toUpperCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function pathToken(pathKey: Buffer, transactionId: string, path: string): string {
  return createHmac("sha256", pathKey).update(`${transactionId}\0${path}`, "utf8").digest("hex");
}
