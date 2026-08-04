import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createTempRepo, cleanupTempRepos } from "@crosscode/test-fixtures";
import { afterEach } from "vitest";
import * as keychain from "./keychain.js";
import {
  RECOVERY_CODE_PREFIX, createDeviceKeyring, createKeyring, currentEpochKey, deviceFingerprint,
  exportRecoveryCode, forgetKeyring, generateDeviceKeyPair, importRecoveryCode, keyIdFor, keyringPath,
  loadKeyring, rotateKeyring, saveKeyring, unwrapEpochKey, withEpochKey, wrapEpochKey
} from "./workspace-key.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempRepos();
});

describe("workspace keyring", () => {
  it("wraps an epoch key to another device and back", () => {
    const holder = createKeyring("workspace-1");
    const joiner = createDeviceKeyring("workspace-1");
    const current = currentEpochKey(holder);

    const wrapped = wrapEpochKey({ epoch: current.epoch, key: current.key, recipientPublicKey: joiner.device.publicKey, sender: holder.device });
    expect(unwrapEpochKey({ epoch: current.epoch, wrapped, recipient: joiner.device })).toEqual(current.key);

    // A grant is derived for one (sender, recipient, epoch) triple, so it cannot be
    // replayed toward another device or relabelled as a different epoch.
    const stranger = createDeviceKeyring("workspace-1");
    expect(() => unwrapEpochKey({ epoch: current.epoch, wrapped, recipient: stranger.device })).toThrow();
    expect(() => unwrapEpochKey({ epoch: current.epoch + 1, wrapped, recipient: joiner.device })).toThrow();
  });

  it("installs a granted epoch and refuses a conflicting one", () => {
    const device = createDeviceKeyring("workspace-1");
    expect(device.currentEpoch).toBeNull();
    const granted = withEpochKey(device, 3, Buffer.alloc(32, 7));
    expect(granted.currentEpoch).toBe(3);
    // Idempotent for the same bytes, because the daemon re-offers grants it already holds.
    expect(withEpochKey(granted, 3, Buffer.alloc(32, 7))).toEqual(granted);
    expect(() => withEpochKey(granted, 3, Buffer.alloc(32, 9))).toThrow(/conflicting key/);
  });

  it("keeps old epochs readable across a rotation", () => {
    const original = createKeyring("workspace-1");
    const rotated = rotateKeyring(original);
    expect(rotated.currentEpoch).toBe(1);
    expect(Object.keys(rotated.epochs).sort()).toEqual(["0", "1"]);
    expect(currentEpochKey(rotated).key).not.toEqual(currentEpochKey(original).key);
    expect(keyIdFor(currentEpochKey(rotated).key)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("persists through the OS keychain without writing key material to disk", async () => {
    const root = await createTempRepo({ prefix: "crosscode-keyring-" });
    const vault = new Map<string, string>();
    vi.spyOn(keychain, "keychainAvailable").mockResolvedValue(true);
    // The real macOS keychain silently truncates a stdin password past 128 bytes, which is
    // why only a small wrapping key goes in it; hold the fake to the same limit so the
    // indirection stays exercised rather than accidentally bypassed.
    vi.spyOn(keychain, "storeSecret").mockImplementation(async (account, secret) => {
      if (Buffer.byteLength(secret, "utf8") > keychain.MAX_KEYCHAIN_SECRET_BYTES) return false;
      vault.set(account, secret);
      return true;
    });
    vi.spyOn(keychain, "readSecret").mockImplementation(async (account) => vault.get(account));
    vi.spyOn(keychain, "deleteSecret").mockImplementation(async (account) => { vault.delete(account); });

    const keyring = rotateKeyring(rotateKeyring(createKeyring("workspace-1")));
    await saveKeyring(root, keyring);

    const onDisk = await readFile(await keyringPath(root), "utf8");
    expect(vault.size).toBe(1);
    for (const secret of Object.values(keyring.epochs)) expect(onDisk).not.toContain(secret);
    expect(onDisk).not.toContain(keyring.device.privateKey);
    await expect(loadKeyring(root)).resolves.toEqual(keyring);

    await forgetKeyring(root);
    expect(vault.size).toBe(0);
    await expect(loadKeyring(root)).resolves.toBeUndefined();
  });

  it("falls back to the mode-0600 file when no keychain is available", async () => {
    const root = await createTempRepo({ prefix: "crosscode-keyring-" });
    vi.spyOn(keychain, "keychainAvailable").mockResolvedValue(false);
    const keyring = createKeyring("workspace-1");
    await saveKeyring(root, keyring);
    await expect(loadKeyring(root)).resolves.toEqual(keyring);
  });

  it("round-trips a recovery code and refuses one from another workspace", () => {
    const keyring = rotateKeyring(createKeyring("workspace-1"));
    const code = exportRecoveryCode(keyring);
    expect(code.startsWith(RECOVERY_CODE_PREFIX)).toBe(true);

    const restored = importRecoveryCode(code, "workspace-1");
    expect(restored.epochs).toEqual(keyring.epochs);
    expect(restored.currentEpoch).toBe(keyring.currentEpoch);
    // A recovery code carries keys, never a device identity: the machine importing one
    // gets its own keypair and has to register it like any other device.
    expect(restored.device.publicKey).not.toBe(keyring.device.publicKey);

    expect(() => importRecoveryCode(code, "workspace-2")).toThrow(/belongs to workspace/);
    expect(() => importRecoveryCode("not-a-code", "workspace-1")).toThrow();
    expect(() => exportRecoveryCode(createDeviceKeyring("workspace-1"))).toThrow(/no workspace key/);
  });

  it("derives a stable, readable fingerprint per device key", () => {
    const device = generateDeviceKeyPair();
    const fingerprint = deviceFingerprint(device.publicKey);
    expect(fingerprint).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(deviceFingerprint(device.publicKey)).toBe(fingerprint);
    expect(deviceFingerprint(generateDeviceKeyPair().publicKey)).not.toBe(fingerprint);
  });
});
