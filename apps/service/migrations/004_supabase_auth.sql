-- Migrates identity from Crosscode-issued enrollment tokens/replica secrets to
-- Supabase Auth: members now map directly to a Supabase auth.users id, and replicas
-- are self-registered by an authenticated member instead of minted via enrollment.

ALTER TABLE members ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL UNIQUE;
-- A real `REFERENCES auth.users(id) ON DELETE CASCADE` foreign key requires the `auth`
-- schema, which only exists inside an actual Supabase project (not in a plain Postgres
-- database used for local/CI testing). Add the FK manually once this migration has been
-- applied inside Supabase:
--   ALTER TABLE members ADD CONSTRAINT members_user_id_fkey
--     FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE replicas DROP COLUMN IF EXISTS credential_hash;

DROP TABLE IF EXISTS enrollments;

-- A real Supabase project already provides schema `auth` and function `auth.uid()`
-- (used below by membership_workspace_ids()). A plain Postgres database used for
-- local/CI testing has neither, so migrating it would otherwise fail with
-- "schema auth does not exist" the moment CREATE FUNCTION tries to resolve the
-- reference. Create a minimal stub only when they are missing; this is a no-op
-- against real Supabase, where auth.uid() reads the caller's JWT `sub` claim, and
-- gives local/CI Postgres a resolvable (always-NULL) stand-in instead. The stub's
-- NULL return only matters to `authenticated`/`anon`-role PostgREST callers; the
-- service itself always connects with a privileged role that bypasses RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    CREATE SCHEMA auth;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $stub$ SELECT NULL::uuid $stub$;
  END IF;
END $$;

-- Row Level Security below is defense-in-depth, not the primary authorization
-- mechanism: the service itself still connects with a privileged Postgres role (not
-- through PostgREST), and application code in authenticate()/resolveMembership()
-- remains the primary place authorization is enforced. These policies matter if the
-- Supabase project's PostgREST/anon or authenticated roles are ever used to query
-- these tables directly.
--
-- membership_workspace_ids() is SECURITY DEFINER so that the members table's own RLS
-- policy can look itself up without triggering infinite recursion (a policy on
-- `members` that subqueries `members` directly re-invokes its own USING clause).
CREATE OR REPLACE FUNCTION public.membership_workspace_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT workspace_id FROM members WHERE user_id = auth.uid();
$$;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE replicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- workspaces / members: membership itself is only ever written by the service's
-- privileged role (via provisionAdmin/addMember, using the Supabase service_role
-- key), so these get read-only policies; there is no self-service INSERT/UPDATE path.
--
-- Every policy below is preceded by DROP POLICY IF EXISTS: unlike the CREATE TABLE
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS statements elsewhere in these migrations,
-- Postgres has no CREATE POLICY IF NOT EXISTS, and PgStore.migrate() is called by
-- every test file (and by the standalone migrate script) against the same
-- already-migrated database, so this needs to be safe to run repeatedly.
DROP POLICY IF EXISTS workspaces_member_select ON workspaces;
CREATE POLICY workspaces_member_select ON workspaces
  FOR SELECT USING (id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS members_member_select ON members;
CREATE POLICY members_member_select ON members
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));

-- replicas: self-service registration by any authenticated member.
DROP POLICY IF EXISTS replicas_member_select ON replicas;
DROP POLICY IF EXISTS replicas_member_insert ON replicas;
DROP POLICY IF EXISTS replicas_member_update ON replicas;
CREATE POLICY replicas_member_select ON replicas
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY replicas_member_insert ON replicas
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY replicas_member_update ON replicas
  FOR UPDATE USING (workspace_id IN (SELECT public.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS sessions_member_select ON sessions;
DROP POLICY IF EXISTS sessions_member_insert ON sessions;
DROP POLICY IF EXISTS sessions_member_update ON sessions;
CREATE POLICY sessions_member_select ON sessions
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY sessions_member_insert ON sessions
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY sessions_member_update ON sessions
  FOR UPDATE USING (workspace_id IN (SELECT public.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS tasks_member_select ON tasks;
DROP POLICY IF EXISTS tasks_member_insert ON tasks;
DROP POLICY IF EXISTS tasks_member_update ON tasks;
CREATE POLICY tasks_member_select ON tasks
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY tasks_member_insert ON tasks
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY tasks_member_update ON tasks
  FOR UPDATE USING (workspace_id IN (SELECT public.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS claims_member_select ON claims;
DROP POLICY IF EXISTS claims_member_insert ON claims;
DROP POLICY IF EXISTS claims_member_update ON claims;
CREATE POLICY claims_member_select ON claims
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY claims_member_insert ON claims
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY claims_member_update ON claims
  FOR UPDATE USING (workspace_id IN (SELECT public.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS operations_member_select ON operations;
DROP POLICY IF EXISTS operations_member_insert ON operations;
CREATE POLICY operations_member_select ON operations
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY operations_member_insert ON operations
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS operation_files_member_select ON operation_files;
DROP POLICY IF EXISTS operation_files_member_insert ON operation_files;
CREATE POLICY operation_files_member_select ON operation_files
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY operation_files_member_insert ON operation_files
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS operation_dependencies_member_select ON operation_dependencies;
DROP POLICY IF EXISTS operation_dependencies_member_insert ON operation_dependencies;
CREATE POLICY operation_dependencies_member_select ON operation_dependencies
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY operation_dependencies_member_insert ON operation_dependencies
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS operation_reviews_member_select ON operation_reviews;
DROP POLICY IF EXISTS operation_reviews_member_insert ON operation_reviews;
CREATE POLICY operation_reviews_member_select ON operation_reviews
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY operation_reviews_member_insert ON operation_reviews
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS validations_member_select ON validations;
DROP POLICY IF EXISTS validations_member_insert ON validations;
CREATE POLICY validations_member_select ON validations
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY validations_member_insert ON validations
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS checkpoints_member_select ON checkpoints;
DROP POLICY IF EXISTS checkpoints_member_insert ON checkpoints;
CREATE POLICY checkpoints_member_select ON checkpoints
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY checkpoints_member_insert ON checkpoints
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));

DROP POLICY IF EXISTS audit_events_member_select ON audit_events;
DROP POLICY IF EXISTS audit_events_member_insert ON audit_events;
CREATE POLICY audit_events_member_select ON audit_events
  FOR SELECT USING (workspace_id IN (SELECT public.membership_workspace_ids()));
CREATE POLICY audit_events_member_insert ON audit_events
  FOR INSERT WITH CHECK (workspace_id IN (SELECT public.membership_workspace_ids()));
