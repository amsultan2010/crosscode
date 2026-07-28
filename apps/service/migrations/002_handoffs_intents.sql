CREATE TABLE IF NOT EXISTS handoffs (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text,
  replica_id uuid,
  payload jsonb NOT NULL,
  responded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS handoffs_workspace_cursor_idx
  ON handoffs (workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS intents (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text,
  replica_id uuid,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS intents_workspace_cursor_idx
  ON intents (workspace_id, updated_at);
