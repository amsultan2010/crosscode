import { describe, expect, it } from "vitest";
import { changeTransactionSchema, sealedTransactionSchema, type ChangeTransaction } from "@crosscode/protocol";
import { contentHash } from "@crosscode/core";
import { MissingEpochKeyError, openTransaction, sealTransaction } from "./sealing.js";
import { createKeyring, rotateKeyring } from "./workspace-key.js";

const binding = { workspaceId: "workspace-1", replicaId: "replica-1" };

function transaction(overrides: Partial<ChangeTransaction> = {}): ChangeTransaction {
  return changeTransactionSchema.parse({
    id: "operation-1",
    intent: "Rename CheckoutResponse.checkoutId to id",
    base: { headCommit: "abc123", files: [{ path: "src/checkout.ts", contentHash: contentHash("before\n") }] },
    changes: [
      { path: "src/checkout.ts", kind: "modify", beforeHash: contentHash("before\n"), afterHash: contentHash("after\n"), afterContent: "after\n", unifiedPatch: "@@ -1 +1 @@\n-before\n+after\n" },
      { path: "docs/checkout.md", kind: "add", afterHash: contentHash("# notes\n"), afterContent: "# notes\n" }
    ],
    provenance: { source: "filesystem", confidence: "known" },
    safety: { risk: "low", requiresApproval: false },
    ...overrides
  });
}

describe("sealed transactions", () => {
  it("round-trips a transaction and leaves nothing readable in the envelope", () => {
    const keyring = createKeyring("workspace-1");
    const original = transaction();
    const sealed = sealTransaction(original, keyring, binding);

    expect(sealedTransactionSchema.parse(sealed)).toEqual(sealed);
    expect(openTransaction(sealed, keyring, binding)).toEqual(original);

    // Nothing the service stores may contain a path, a hash, or file content. Serializing
    // the whole envelope and searching it is the check that actually holds as the shape
    // evolves -- asserting on named fields would silently stop covering a new one.
    const onTheWire = JSON.stringify(sealed);
    for (const secret of ["src/checkout.ts", "docs/checkout.md", "after\n", "# notes", "CheckoutResponse", "abc123", contentHash("after\n")]) {
      expect(onTheWire).not.toContain(secret);
    }
    expect(sealed.changes.map((change) => change.kind)).toEqual(["modify", "add"]);
  });

  it("gives the same file a different path token in every operation", () => {
    const keyring = createKeyring("workspace-1");
    const first = sealTransaction(transaction(), keyring, binding);
    const second = sealTransaction(transaction({ id: "operation-2" }), keyring, binding);
    // Otherwise the service could tell that two operations touched the same file, and
    // build a change history per file without ever decrypting one.
    expect(first.changes[0]!.pathToken).not.toBe(second.changes[0]!.pathToken);
  });

  it("refuses a payload the service moved, re-attributed, or edited", () => {
    const keyring = createKeyring("workspace-1");
    const sealed = sealTransaction(transaction(), keyring, binding);

    expect(() => openTransaction(sealed, keyring, { ...binding, workspaceId: "workspace-2" })).toThrow();
    expect(() => openTransaction(sealed, keyring, { ...binding, replicaId: "replica-9" })).toThrow();
    expect(() => openTransaction({ ...sealed, id: "operation-9" }, keyring, binding)).toThrow();

    const flipped = Buffer.from(sealed.sealed.ciphertext, "base64url");
    flipped[0] ^= 0x01;
    expect(() => openTransaction({ ...sealed, sealed: { ...sealed.sealed, ciphertext: flipped.toString("base64url") } }, keyring, binding)).toThrow();
  });

  it("refuses a file list the service edited outside the ciphertext", () => {
    const keyring = createKeyring("workspace-1");
    const sealed = sealTransaction(transaction(), keyring, binding);

    // `changes` is the one part outside the AEAD tag, because the service needs a row per
    // file. Dropping, reordering, or relabelling a row must still be caught.
    expect(() => openTransaction({ ...sealed, changes: [sealed.changes[0]!] }, keyring, binding)).toThrow(/declares the wrong number of files/);
    expect(() => openTransaction({ ...sealed, changes: [...sealed.changes].reverse() }, keyring, binding)).toThrow(/declared file list/);
    expect(() => openTransaction({
      ...sealed,
      changes: [{ ...sealed.changes[0]!, kind: "delete" as const }, sealed.changes[1]!]
    }, keyring, binding)).toThrow(/declared file list/);
  });

  it("reports a missing epoch distinctly from tampering, so sync can move past it", () => {
    const older = createKeyring("workspace-1");
    const rotated = rotateKeyring(older);
    const sealedUnderNewKey = sealTransaction(transaction(), rotated, binding);

    // A device granted only epoch 0 cannot read epoch 1. That is a state to report, not a
    // failure to stop on -- the daemon declares the gap and keeps its cursor moving.
    expect(() => openTransaction(sealedUnderNewKey, older, binding)).toThrow(MissingEpochKeyError);
    expect(openTransaction(sealedUnderNewKey, rotated, binding)).toEqual(transaction());
    // Rotation is additive: the rotated keyring still opens what the old epoch sealed.
    expect(openTransaction(sealTransaction(transaction(), older, binding), rotated, binding)).toEqual(transaction());
  });

  it("refuses to seal a secret path, since the service can no longer refuse it for us", () => {
    const keyring = createKeyring("workspace-1");
    for (const path of [".env", "config/.env.production", "deploy/id_rsa", "certs/server.pem"]) {
      const secret = transaction({ changes: [{ path, kind: "add", afterHash: contentHash("x"), afterContent: "x" }] });
      expect(() => sealTransaction(secret, keyring, binding)).toThrow(/Sensitive paths cannot be synchronized/);
    }
    // A rename must be judged on both ends, or `.env` leaves under an innocuous new name.
    const renamed = transaction({
      changes: [{ path: "notes.txt", kind: "rename", previousPath: ".env", afterHash: contentHash("x"), afterContent: "x" }]
    });
    expect(() => sealTransaction(renamed, keyring, binding)).toThrow(/Sensitive paths cannot be synchronized/);
  });

  it("seals binary payloads byte-for-byte", () => {
    const keyring = createKeyring("workspace-1");
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]);
    const binary = transaction({
      changes: [{ path: "assets/logo.png", kind: "add", afterHash: contentHash(bytes), afterContent: bytes.toString("base64"), afterEncoding: "base64" }]
    });
    const opened = openTransaction(sealTransaction(binary, keyring, binding), keyring, binding);
    expect(Buffer.from(opened.changes[0]!.afterContent!, "base64")).toEqual(bytes);
  });
});
