-- The whole Crosscode schema, in one file.
--
-- Six tables and nothing else: users, projects, project_members, invites, replicas,
-- file_versions. The sixteen migrations this replaces described a product (proposals,
-- tasks, claims, billing, device pairing) that no longer exists; there is no production
-- data to preserve, so this is a deliberate wipe rather than an evolution of them.
--
-- Every statement is idempotent. Test suites that share one database each call migrate()
-- at startup, and the service runs it on deploy.
--
-- Row level security is on for all six tables from the start. The policies are written for
-- the Supabase `authenticated` role, whose JWT claims arrive as `request.jwt.claims`; the
-- service's own pool connects as the table owner and is therefore not subject to them
-- (Postgres exempts owners unless FORCE is set), which is what lets the service enforce
-- membership in code while any direct PostgREST access stays scoped to the caller.

BEGIN;

/* ------------------------------------------------------------------ identity helper */

-- The authenticated caller's id, or NULL for an unauthenticated connection. Mirrors what
-- Supabase's auth.uid() does, but reads the claim directly so this file also applies to a
-- plain Postgres (a local test database has no `auth` schema).
-- search_path is pinned empty: a mutable one lets a caller resolve the function's
-- references against a schema they control.
CREATE OR REPLACE FUNCTION crosscode_uid() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = ''
  AS $$
    SELECT nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
  $$;

/* --------------------------------------------------------------------------- tables */

-- One row per person, keyed by the Supabase auth user id (the JWT `sub`). GitHub is the
-- only sign-in provider, so the GitHub identity is stored here rather than looked up on
-- every request that needs to name someone.
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  github_id     text UNIQUE,
  github_login  text,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A room. `repo` is `owner/repo` on GitHub: it names the room and it is what invite
-- redemption checks the invitee's access against.
--
-- `plan` is kept even though nothing reads it. Billing is out of scope, and re-adding it
-- later should not need a migration.
CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  repo        text NOT NULL,
  plan        text NOT NULL DEFAULT 'free',
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id),
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- `code` is the human-typed CC-XXXX-XXXX form and is the only lookup key, so it is unique
-- across all projects rather than within one.
CREATE TABLE IF NOT EXISTS invites (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  code         text NOT NULL UNIQUE,
  created_by   uuid NOT NULL REFERENCES users (id),
  expires_at   timestamptz NOT NULL,
  redeemed_at  timestamptz,
  redeemed_by  uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One checkout on one machine, on one branch. A replica is the unit fan-out excludes, so
-- a sender never receives its own change back.
CREATE TABLE IF NOT EXISTS replicas (
  id            uuid PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id),
  branch        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- The durable change log, and the only place file content lives.
--
-- `sequence` is monotonic per (project, branch) and assigned under an advisory lock on
-- that pair, so a room's history is gap-free and a cursor is just the last sequence a
-- replica has applied. Retention is ~7 days, measured on created_at; a cursor that points
-- below what survives is answered with `cursor-too-old`, never with a short page.
CREATE TABLE IF NOT EXISTS file_versions (
  project_id  uuid   NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch      text   NOT NULL,
  sequence    bigint NOT NULL,
  replica_id  uuid   NOT NULL REFERENCES replicas (id) ON DELETE CASCADE,
  version     jsonb  NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, branch, sequence)
);

/* -------------------------------------------------------------------------- indexes */

CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members (user_id);
CREATE INDEX IF NOT EXISTS invites_project_idx ON invites (project_id);
CREATE INDEX IF NOT EXISTS replicas_project_branch_idx ON replicas (project_id, branch);
CREATE INDEX IF NOT EXISTS replicas_user_idx ON replicas (user_id);
-- Retention sweeps by age across every room at once, so it wants its own index rather
-- than the primary key's (project, branch, sequence) ordering.
CREATE INDEX IF NOT EXISTS file_versions_created_at_idx ON file_versions (created_at);

/* ---------------------------------------------------------------------------- rls */

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE replicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_self ON users;
CREATE POLICY users_self ON users
  USING (id = crosscode_uid())
  WITH CHECK (id = crosscode_uid());

DROP POLICY IF EXISTS projects_member_read ON projects;
CREATE POLICY projects_member_read ON projects FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM project_members m
     WHERE m.project_id = projects.id AND m.user_id = crosscode_uid()
  ));

DROP POLICY IF EXISTS projects_owner_write ON projects;
CREATE POLICY projects_owner_write ON projects FOR ALL
  USING (EXISTS (
    SELECT 1 FROM project_members m
     WHERE m.project_id = projects.id AND m.user_id = crosscode_uid() AND m.role = 'owner'
  ))
  WITH CHECK (created_by = crosscode_uid());

-- A member sees who else is in their rooms, and nothing about rooms they are not in.
DROP POLICY IF EXISTS project_members_read ON project_members;
CREATE POLICY project_members_read ON project_members FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM project_members mine
     WHERE mine.project_id = project_members.project_id AND mine.user_id = crosscode_uid()
  ));

-- Invite codes are the join credential, so only the room's owners may read or mint one.
-- Redemption is a service-side operation: it has to verify GitHub repo access first, which
-- is not something a policy can express.
DROP POLICY IF EXISTS invites_owner ON invites;
CREATE POLICY invites_owner ON invites FOR ALL
  USING (EXISTS (
    SELECT 1 FROM project_members m
     WHERE m.project_id = invites.project_id AND m.user_id = crosscode_uid() AND m.role = 'owner'
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM project_members m
     WHERE m.project_id = invites.project_id AND m.user_id = crosscode_uid() AND m.role = 'owner'
  ));

DROP POLICY IF EXISTS replicas_own ON replicas;
CREATE POLICY replicas_own ON replicas FOR ALL
  USING (user_id = crosscode_uid())
  WITH CHECK (user_id = crosscode_uid() AND EXISTS (
    SELECT 1 FROM project_members m
     WHERE m.project_id = replicas.project_id AND m.user_id = crosscode_uid()
  ));

DROP POLICY IF EXISTS file_versions_member_read ON file_versions;
CREATE POLICY file_versions_member_read ON file_versions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM project_members m
     WHERE m.project_id = file_versions.project_id AND m.user_id = crosscode_uid()
  ));

-- Publishing through PostgREST would bypass sequence assignment, so a member may only
-- insert a row attributed to a replica they own. There is deliberately no UPDATE or DELETE
-- policy: the change log is append-only, and retention runs as the owner.
DROP POLICY IF EXISTS file_versions_member_write ON file_versions;
CREATE POLICY file_versions_member_write ON file_versions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM replicas r
     WHERE r.id = file_versions.replica_id
       AND r.project_id = file_versions.project_id
       AND r.user_id = crosscode_uid()
  ));

COMMIT;
