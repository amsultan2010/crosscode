-- Contract B (docs/onboarding-contracts.md): a project is a repository inside a
-- workspace. Until now `workspaces` was the only container, so the dashboard could not
-- attribute activity to the checkout it came from.
--
-- The dedup key is deliberately two-tiered rather than one column: a checkout with a git
-- remote is keyed by its normalized remote (so two laptops cloning the same repo land on
-- one project), and a checkout without one falls back to its absolute repo root (so a
-- local-only repo still gets a row instead of colliding with every other remote-less
-- checkout on NULL). Two partial unique indexes express that: Postgres treats NULLs as
-- distinct in a plain UNIQUE constraint, which would silently allow unlimited duplicates
-- for the remote-less case.

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  repo_remote text,
  repo_root text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz,
  -- A project with neither key is unaddressable, so refuse to store one.
  CONSTRAINT projects_key_present CHECK (repo_remote IS NOT NULL OR repo_root IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_workspace_remote_key
  ON projects (workspace_id, repo_remote) WHERE repo_remote IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS projects_workspace_root_key
  ON projects (workspace_id, repo_root) WHERE repo_remote IS NULL AND repo_root IS NOT NULL;

-- GET /v1/projects orders by newest activity first.
CREATE INDEX IF NOT EXISTS projects_workspace_activity_idx
  ON projects (workspace_id, last_activity_at DESC NULLS LAST);

-- Nullable, never backfilled: NULL means "recorded before projects existed" and the
-- dashboard groups those under "Unassigned". ON DELETE SET NULL so removing a project
-- never takes settled operation history with it.
ALTER TABLE replicas ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS operations_workspace_project_idx
  ON operations (workspace_id, project_id);

-- Row Level Security here is defense-in-depth, same as every other table in
-- 005_rls_hardening.sql / 006_invites.sql: the service always connects with a privileged
-- Postgres role and enforces workspace scoping in application code, so there is no
-- self-service INSERT/UPDATE policy below.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_member_select ON projects;
CREATE POLICY projects_member_select ON projects
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
