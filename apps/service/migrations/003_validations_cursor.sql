ALTER TABLE validations ADD COLUMN IF NOT EXISTS event_id text;
ALTER TABLE validations ADD COLUMN IF NOT EXISTS replica_id uuid REFERENCES replicas(id);

CREATE INDEX IF NOT EXISTS validations_workspace_cursor_idx
  ON validations (workspace_id, created_at);
