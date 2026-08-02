-- Phase 11 (onboarding rework): Contract A (pairing & verification) and Contract C
-- (auto-provisioned personal workspace) from docs/onboarding-contracts.md. A pairing
-- code is a short-lived single-use bearer secret the dashboard mints and a local daemon
-- redeems unauthenticated; redeeming hands back a workspace-scoped service token. Both
-- secrets are stored only as SHA-256 hashes -- the plaintext exists exactly once, in the
-- response body that mints it, the same way 001_initial.sql's enrollments.token_hash did.

-- 004_supabase_auth.sql added members.user_id as globally UNIQUE, which caps a Supabase
-- user at one workspace for the lifetime of the account. Contract C auto-provisions a
-- personal workspace on first use and then expects "Create a team" to be an ordinary
-- follow-up action (and GET /v1/memberships to return a list), so that cap has to go.
-- Narrow it to per-workspace uniqueness, which is what the store's "User is already a
-- member of a workspace" conflict path was always describing.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS members_workspace_user_idx ON members (workspace_id, user_id);
CREATE INDEX IF NOT EXISTS members_user_idx ON members (user_id);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_personal boolean NOT NULL DEFAULT false;
ALTER TABLE members ADD COLUMN IF NOT EXISTS is_personal boolean NOT NULL DEFAULT false;

-- Contract C's concurrency guard: two simultaneous first requests from the same brand-new
-- user must not both provision a personal workspace. The partial unique index makes the
-- loser of that race fail with a unique violation the store turns into "read the existing
-- one", so the invariant is enforced by the database rather than by application timing.
CREATE UNIQUE INDEX IF NOT EXISTS members_personal_user_idx ON members (user_id) WHERE is_personal;

CREATE TABLE IF NOT EXISTS pairing_codes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- SHA-256 of the XXXX-XXXX Crockford base32 plaintext. Never store the code itself:
  -- it is a bearer credential that redeems into a workspace token without any other proof.
  code_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claimed_replica_id uuid REFERENCES replicas(id) ON DELETE SET NULL,
  claimed_actor_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pairing_codes_workspace_created_idx
  ON pairing_codes (workspace_id, created_at);

-- Opaque `ccw_`-prefixed workspace service tokens: 32 random bytes base64url, scoped to
-- one workspace, non-expiring but revocable. member_id is the member whose pairing code
-- was redeemed, so a token inherits that member's role and replica ownership rather than
-- being a second, parallel notion of identity.
CREATE TABLE IF NOT EXISTS workspace_tokens (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  replica_id uuid REFERENCES replicas(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  pairing_id uuid REFERENCES pairing_codes(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_tokens_workspace_created_idx
  ON workspace_tokens (workspace_id, created_at);

-- Row Level Security here is defense-in-depth, same as every other table in
-- 004_supabase_auth.sql / 005_rls_hardening.sql / 006_invites.sql: the service always
-- connects with a privileged Postgres role and enforces authorization in application
-- code, so there is no self-service INSERT/UPDATE/DELETE policy below. Note that neither
-- table exposes its hash column to a member SELECT policy by accident: the hashes are the
-- only stored form of the secrets, and a member reading another replica's token hash
-- would still be a meaningful leak, so both policies are workspace-scoped SELECT only.
ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pairing_codes_member_select ON pairing_codes;
CREATE POLICY pairing_codes_member_select ON pairing_codes
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));

ALTER TABLE workspace_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_tokens_member_select ON workspace_tokens;
CREATE POLICY workspace_tokens_member_select ON workspace_tokens
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
