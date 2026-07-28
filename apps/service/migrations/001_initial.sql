CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  next_sequence bigint NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  token_version integer NOT NULL DEFAULT 1 CHECK (token_version > 0),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, actor_id)
);

CREATE TABLE IF NOT EXISTS replicas (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name text NOT NULL,
  credential_hash text NOT NULL,
  disabled_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL REFERENCES replicas(id) ON DELETE CASCADE,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS tasks (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text,
  replica_id uuid,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS event_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS replica_id uuid;

CREATE TABLE IF NOT EXISTS claims (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text,
  replica_id uuid,
  payload jsonb NOT NULL,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

ALTER TABLE claims ADD COLUMN IF NOT EXISTS event_id text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS replica_id uuid;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS released_at timestamptz;

CREATE TABLE IF NOT EXISTS operations (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  client_sequence bigint NOT NULL CHECK (client_sequence >= 0),
  server_sequence bigint NOT NULL CHECK (server_sequence > 0),
  replica_id uuid NOT NULL REFERENCES replicas(id),
  member_id uuid NOT NULL REFERENCES members(id),
  actor_id text NOT NULL,
  payload_hash text NOT NULL,
  event jsonb NOT NULL,
  transaction jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, event_id),
  UNIQUE (workspace_id, replica_id, client_sequence),
  UNIQUE (workspace_id, server_sequence)
);

CREATE INDEX IF NOT EXISTS operations_workspace_cursor_idx
  ON operations (workspace_id, server_sequence);

CREATE INDEX IF NOT EXISTS tasks_workspace_cursor_idx
  ON tasks (workspace_id, updated_at);

CREATE INDEX IF NOT EXISTS claims_workspace_cursor_idx
  ON claims (workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS operation_files (
  workspace_id uuid NOT NULL,
  operation_id text NOT NULL,
  path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('add', 'modify', 'delete', 'rename')),
  before_hash text,
  after_hash text,
  payload jsonb NOT NULL,
  PRIMARY KEY (workspace_id, operation_id, path),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES operations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operation_dependencies (
  workspace_id uuid NOT NULL,
  operation_id text NOT NULL,
  depends_on_operation_id text NOT NULL,
  PRIMARY KEY (workspace_id, operation_id, depends_on_operation_id),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES operations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operation_reviews (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES operations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS validations (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL REFERENCES replicas(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  replica_id uuid REFERENCES replicas(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_workspace_created_idx
  ON audit_events (workspace_id, created_at);
