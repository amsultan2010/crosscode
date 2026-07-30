import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deleteSecret, keychainAvailable, readSecret, storeSecret } from "./keychain.js";

describe("OS keychain integration", () => {
  it("round-trips a secret through the real platform keychain when available", async () => {
    if (!(await keychainAvailable())) return;
    const account = `crosscode-test-${randomUUID()}`;
    const secret = `secret-${randomUUID()}`;
    try {
      expect(await storeSecret(account, secret)).toBe(true);
      expect(await readSecret(account)).toBe(secret);
    } finally {
      await deleteSecret(account);
    }
    expect(await readSecret(account)).toBeUndefined();
  });

  it("readSecret resolves to undefined for an account that was never stored", async () => {
    if (!(await keychainAvailable())) return;
    expect(await readSecret(`crosscode-test-never-stored-${randomUUID()}`)).toBeUndefined();
  });
});
