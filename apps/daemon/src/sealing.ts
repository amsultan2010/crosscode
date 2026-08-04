import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import {
  changeTransactionSchema, sealedTransactionSchema,
  type ChangeTransaction, type SealedTransaction
} from "@crosscode/protocol";
import { redactPath } from "@crosscode/core";
import { contentKeyFor, currentEpochKey, epochKey, keyIdFor, pathKeyFor, pathToken, type Keyring } from "./workspace-key.js";

/**
 * Sealing and opening the transaction payload. This is the only seam where plaintext
 * crosses into (and out of) anything the coordination service will hold: everything above
 * it -- capture, conflict classification, diffing, review, materialization -- works on a
 * plain ChangeTransaction and is unchanged by encryption.
 */

/** Thrown when a sealed operation names an epoch this device has never been granted. */
export class MissingEpochKeyError extends Error {
  constructor(readonly epoch: number, readonly keyId: string) {
    super(`No workspace key for epoch ${epoch} (${keyId})`);
  }
}

/**
 * The two facts a receiver can independently check about a sealed payload: which
 * workspace it belongs to and which replica sent it. Both are attributed by the service,
 * so binding them into the AEAD tag is what stops the service from re-attributing an
 * operation or moving it between workspaces.
 */
export type SealBinding = { workspaceId: string; replicaId: string };

/**
 * Additional authenticated data. Every field here is one the service can see and could
 * otherwise rewrite: binding them into the AEAD tag means a sealed payload cannot be
 * moved to another workspace, re-attributed to another replica, or spliced onto a
 * different operation id. None of it is encrypted -- it is asserted.
 */
function additionalData(transactionId: string, envelope: { epoch: number; keyId: string }, binding: SealBinding): Buffer {
  return Buffer.from(
    `crosscode/seal/v1|${binding.workspaceId}|${binding.replicaId}|${transactionId}|${envelope.epoch}|${envelope.keyId}`,
    "utf8"
  );
}

export function sealTransaction(transaction: ChangeTransaction, keyring: Keyring, binding: SealBinding): SealedTransaction {
  const { epoch, key, keyId } = currentEpochKey(keyring);
  // The service used to refuse `.env` and friends at ingest. It cannot any more -- it sees
  // no paths -- so the check runs here instead, at the last point before content leaves
  // this machine. It is the same class of check it always was: a guard against a bug in
  // our own capture path, not against a hostile client, which would simply rename the
  // file. `eligiblePath` already rejects these at capture; this is the backstop.
  for (const change of transaction.changes) {
    if (redactPath(change.path)) throw new Error(`Sensitive paths cannot be synchronized: ${change.path}`);
    if (change.previousPath !== undefined && redactPath(change.previousPath)) {
      throw new Error(`Sensitive paths cannot be synchronized: ${change.previousPath}`);
    }
  }
  const { id, ...body } = transaction;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKeyFor(key), nonce);
  cipher.setAAD(additionalData(id, { epoch, keyId }, binding));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const pathKey = pathKeyFor(key);
  return sealedTransactionSchema.parse({
    id,
    sealed: { version: 1, algorithm: "AES-256-GCM", epoch, keyId, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") },
    changes: transaction.changes.map((change) => ({ pathToken: pathToken(pathKey, id, change.path), kind: change.kind }))
  });
}

export function openTransaction(sealed: SealedTransaction, keyring: Keyring, binding: SealBinding): ChangeTransaction {
  const key = epochKey(keyring, sealed.sealed.epoch);
  if (!key || keyIdFor(key) !== sealed.sealed.keyId) throw new MissingEpochKeyError(sealed.sealed.epoch, sealed.sealed.keyId);
  const bytes = Buffer.from(sealed.sealed.ciphertext, "base64url");
  if (bytes.length <= 16) throw new Error(`Sealed transaction ${sealed.id} is malformed`);
  const decipher = createDecipheriv("aes-256-gcm", contentKeyFor(key), Buffer.from(sealed.sealed.nonce, "base64url"));
  decipher.setAAD(additionalData(sealed.id, sealed.sealed, binding));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  // A failed tag check throws here. That is the integrity guarantee the service-side hash
  // check used to approximate, except this one holds against the service itself: it is
  // computed under a key the service has never had, so it cannot be recomputed to match a
  // substituted payload the way `afterHash` could.
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString("utf8");
  const transaction = changeTransactionSchema.parse({ id: sealed.id, ...JSON.parse(plaintext) as Record<string, unknown> });
  assertPathTokensMatch(sealed, transaction, pathKeyFor(key));
  return transaction;
}

/**
 * The clear-text `changes` array is the one part of a sealed operation the service can
 * edit without breaking the AEAD tag -- it is outside the ciphertext, because the service
 * needs one row per changed file. Recomputing every token from the decrypted paths is
 * what stops it from dropping, duplicating, or reordering those rows unnoticed.
 */
function assertPathTokensMatch(sealed: SealedTransaction, transaction: ChangeTransaction, pathKey: Buffer): void {
  if (sealed.changes.length !== transaction.changes.length) throw new Error(`Sealed transaction ${sealed.id} declares the wrong number of files`);
  for (const [index, change] of transaction.changes.entries()) {
    const declared = sealed.changes[index]!;
    const expected = pathToken(pathKey, sealed.id, change.path);
    if (declared.kind !== change.kind || !constantTimeEquals(declared.pathToken, expected)) {
      throw new Error(`Sealed transaction ${sealed.id} does not match its declared file list`);
    }
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
