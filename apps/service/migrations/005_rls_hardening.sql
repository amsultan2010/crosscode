-- Fixes two gaps found by Supabase's advisor lints after 004_supabase_auth.sql shipped:
-- 1. handoffs/intents had no RLS policies at all (Supabase projects enable RLS by
--    default on new public-schema tables, so this silently denied all PostgREST/
--    anon/authenticated access to them).
-- 2. membership_workspace_ids() lived in `public`, which Supabase exposes as a
--    callable PostgREST RPC endpoint (`/rest/v1/rpc/membership_workspace_ids`) even
--    though it's only meant to be used inside RLS policy bodies. Move it to a
--    `private` schema (outside PostgREST's exposed schema list) so policies can still
--    call it but it is not directly callable over the API, then repoint every existing
--    policy at the new location.

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.membership_workspace_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT workspace_id FROM members WHERE user_id = auth.uid();
$$;

DROP POLICY IF EXISTS workspaces_member_select ON workspaces;
CREATE POLICY workspaces_member_select ON workspaces
  FOR SELECT USING (id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS members_member_select ON members;
CREATE POLICY members_member_select ON members
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS replicas_member_select ON replicas;
DROP POLICY IF EXISTS replicas_member_insert ON replicas;
DROP POLICY IF EXISTS replicas_member_update ON replicas;
CREATE POLICY replicas_member_select ON replicas
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY replicas_member_insert ON replicas
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY replicas_member_update ON replicas
  FOR UPDATE USING (workspace_id IN (SELECT private.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS sessions_member_select ON sessions;
DROP POLICY IF EXISTS sessions_member_insert ON sessions;
DROP POLICY IF EXISTS sessions_member_update ON sessions;
CREATE POLICY sessions_member_select ON sessions
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY sessions_member_insert ON sessions
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY sessions_member_update ON sessions
  FOR UPDATE USING (workspace_id IN (SELECT private.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS tasks_member_select ON tasks;
DROP POLICY IF EXISTS tasks_member_insert ON tasks;
DROP POLICY IF EXISTS tasks_member_update ON tasks;
CREATE POLICY tasks_member_select ON tasks
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY tasks_member_insert ON tasks
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY tasks_member_update ON tasks
  FOR UPDATE USING (workspace_id IN (SELECT private.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS claims_member_select ON claims;
DROP POLICY IF EXISTS claims_member_insert ON claims;
DROP POLICY IF EXISTS claims_member_update ON claims;
CREATE POLICY claims_member_select ON claims
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY claims_member_insert ON claims
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY claims_member_update ON claims
  FOR UPDATE USING (workspace_id IN (SELECT private.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS operations_member_select ON operations;
DROP POLICY IF EXISTS operations_member_insert ON operations;
CREATE POLICY operations_member_select ON operations
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY operations_member_insert ON operations
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS operation_files_member_select ON operation_files;
DROP POLICY IF EXISTS operation_files_member_insert ON operation_files;
CREATE POLICY operation_files_member_select ON operation_files
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY operation_files_member_insert ON operation_files
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS operation_dependencies_member_select ON operation_dependencies;
DROP POLICY IF EXISTS operation_dependencies_member_insert ON operation_dependencies;
CREATE POLICY operation_dependencies_member_select ON operation_dependencies
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY operation_dependencies_member_insert ON operation_dependencies
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS operation_reviews_member_select ON operation_reviews;
DROP POLICY IF EXISTS operation_reviews_member_insert ON operation_reviews;
CREATE POLICY operation_reviews_member_select ON operation_reviews
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY operation_reviews_member_insert ON operation_reviews
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS validations_member_select ON validations;
DROP POLICY IF EXISTS validations_member_insert ON validations;
CREATE POLICY validations_member_select ON validations
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY validations_member_insert ON validations
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS checkpoints_member_select ON checkpoints;
DROP POLICY IF EXISTS checkpoints_member_insert ON checkpoints;
CREATE POLICY checkpoints_member_select ON checkpoints
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY checkpoints_member_insert ON checkpoints
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP POLICY IF EXISTS audit_events_member_select ON audit_events;
DROP POLICY IF EXISTS audit_events_member_insert ON audit_events;
CREATE POLICY audit_events_member_select ON audit_events
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY audit_events_member_insert ON audit_events
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS handoffs_member_select ON handoffs;
DROP POLICY IF EXISTS handoffs_member_insert ON handoffs;
DROP POLICY IF EXISTS handoffs_member_update ON handoffs;
CREATE POLICY handoffs_member_select ON handoffs
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY handoffs_member_insert ON handoffs
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY handoffs_member_update ON handoffs
  FOR UPDATE USING (workspace_id IN (SELECT private.membership_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

ALTER TABLE intents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intents_member_select ON intents;
DROP POLICY IF EXISTS intents_member_insert ON intents;
CREATE POLICY intents_member_select ON intents
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
CREATE POLICY intents_member_insert ON intents
  FOR INSERT WITH CHECK (workspace_id IN (SELECT private.membership_workspace_ids()));

DROP FUNCTION IF EXISTS public.membership_workspace_ids();
