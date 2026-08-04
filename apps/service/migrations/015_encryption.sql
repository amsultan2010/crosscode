-- End-to-end encryption of file payloads (docs/security.md#end-to-end-encryption).
--
-- The coordination service is a store-and-forward relay: it never inspected file content,
-- so encrypting the payload costs it no capability it was using. What changes here is
-- what it is *able* to do -- after this migration an encrypted workspace's
-- operations.transaction and operation_files.payload hold ciphertext under a key that is
-- only ever generated, stored, and used on member devices.

-- Marks an operation whose transaction payload is sealed. Kept as a column rather than
-- inferred from the JSON so the latch below, and any operator asking "is this workspace
-- actually encrypted", is a cheap indexed question rather than a jsonb probe.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS sealed boolean NOT NULL DEFAULT false;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS key_epoch integer;

-- The anti-downgrade latch. Once a workspace has ingested one sealed operation, the
-- service refuses plaintext for it forever (appendOperation). Encryption is decided
-- client-side by the presence of a local keyring, so this is not what makes a client
-- encrypt -- it is what stops a rolled-back, buggy, or coerced client from quietly
-- putting plaintext back into a workspace that had stopped sending it.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS encryption_latched_at timestamptz;

-- A device's X25519 public key, so an existing key holder can wrap workspace key epochs
-- to it. Write-once at the application layer: replacing a registered key would let
-- anything holding the device's token redirect future grants to a key of its choosing.
ALTER TABLE replicas ADD COLUMN IF NOT EXISTS device_public_key text;

-- One workspace key epoch, encrypted to one device. The service stores and forwards these
-- exactly as it does file payloads: it holds no private key, so a grant in this table is
-- as opaque to it as the operations the key protects.
--
-- The primary key is (workspace_id, epoch, recipient_replica_id): a device is granted a
-- given epoch once, and re-issuing is a no-op rather than a conflict, so the daemon's
-- "grant every epoch the recipient is missing" sweep is safely idempotent.
CREATE TABLE IF NOT EXISTS workspace_key_grants (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  epoch integer NOT NULL CHECK (epoch >= 0),
  recipient_replica_id uuid NOT NULL REFERENCES replicas(id) ON DELETE CASCADE,
  key_id text NOT NULL,
  -- Echoed from the recipient's registered key at insert time. A grant is useless if the
  -- recipient's key later changes, and keeping it here makes that detectable rather than
  -- surfacing as an unexplained decryption failure on the device.
  recipient_public_key text NOT NULL,
  sender_replica_id uuid REFERENCES replicas(id) ON DELETE SET NULL,
  wrapped jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, epoch, recipient_replica_id)
);

CREATE INDEX IF NOT EXISTS workspace_key_grants_recipient_idx
  ON workspace_key_grants (workspace_id, recipient_replica_id);

-- Defense-in-depth, same as every other table: the service connects with a privileged
-- role and enforces authorization in application code, so there is no self-service
-- INSERT/UPDATE/DELETE policy. SELECT is workspace-scoped -- a member seeing another
-- device's wrapped key learns nothing, since opening it needs that device's private key.
ALTER TABLE workspace_key_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_key_grants_member_select ON workspace_key_grants;
CREATE POLICY workspace_key_grants_member_select ON workspace_key_grants
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
