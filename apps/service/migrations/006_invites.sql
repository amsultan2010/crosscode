-- Phase 8: invite-by-code/link so a workspace owner can bring in a teammate without an
-- admin running service:provision with a service-role key. redeemed_by references the
-- Supabase auth.users id of whoever redeems the code (no FK for the same reason
-- members.user_id has none in 004_supabase_auth.sql: the `auth` schema only exists inside
-- a real Supabase project, not plain Postgres used for local/CI testing).

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  created_by uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invites_workspace_created_idx
  ON invites (workspace_id, created_at);

-- Row Level Security here is defense-in-depth, same as every other table in
-- 004_supabase_auth.sql / 005_rls_hardening.sql: the service always connects with a
-- privileged Postgres role and enforces authorization (owner-only create/list/revoke) in
-- application code, so there is no self-service INSERT/UPDATE/DELETE policy below.
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invites_member_select ON invites;
CREATE POLICY invites_member_select ON invites
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
