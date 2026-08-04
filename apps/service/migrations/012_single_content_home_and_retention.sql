-- Stores file content exactly once, and gives per-plan retention the state it needs.
--
-- (1) operations.event already holds the entire transaction.created envelope, and that
--     envelope's payload IS the ChangeTransaction -- afterContent, unifiedPatch and all.
--     operations.transaction and operation_files.payload were verbatim second and third
--     copies of the same bytes, and file bodies are the bulk of what this database stores.
--     Both are dropped. operation_files keeps its metadata columns and stays what it always
--     was in practice: a per-path index into an operation, which now *references* the one
--     copy of the content in operations.event via (workspace_id, operation_id, path).
--
-- (2) workspaces.operations_pruned_through is the highest server_sequence retention has
--     deleted for a workspace. Pruning always removes a prefix of the sequence, so every
--     sequence above this watermark is still present: a replica whose cursor is at or above
--     it can be served a complete list, and one below it must be told to resync rather than
--     handed a short list it would read as "caught up" (see store.ts listOperations).
ALTER TABLE operations DROP COLUMN IF EXISTS transaction;
ALTER TABLE operation_files DROP COLUMN IF EXISTS payload;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS operations_pruned_through bigint NOT NULL DEFAULT 0
  CHECK (operations_pruned_through >= 0);

-- The retention sweep asks for "the newest sequence older than the plan's window" per
-- workspace; without this it is a full scan of the largest table in the database.
CREATE INDEX IF NOT EXISTS operations_workspace_created_idx
  ON operations (workspace_id, created_at);
