-- Drops everything this service no longer serves.
--
-- The files before this one are left as they were applied: they are the history of every
-- deployed database, and rewriting them would not un-apply anything. This one runs last
-- and takes the tables and columns back out, so a fresh database and an existing one end
-- in the same shape.
--
-- What goes: the proposal/operation lifecycle's side tables (tasks, claims, handoffs,
-- intents, validations, checkpoints, reviews, dependency graph), device pairing and the
-- workspace tokens it minted, end-to-end encryption's key distribution, Stripe billing,
-- and the durable rate-limit buckets that only the pairing-claim route spent.
--
-- What stays: workspaces, members, invites, replicas, projects, operations,
-- operation_files, sessions and audit_events -- and workspaces.plan, which is kept
-- deliberately even though nothing reads it, so that billing returning later does not
-- need another migration.

DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS handoffs;
DROP TABLE IF EXISTS intents;
DROP TABLE IF EXISTS validations;
DROP TABLE IF EXISTS checkpoints;
DROP TABLE IF EXISTS operation_reviews;
DROP TABLE IF EXISTS operation_dependencies;

DROP TABLE IF EXISTS workspace_key_grants;
DROP TABLE IF EXISTS workspace_tokens;
DROP TABLE IF EXISTS pairing_codes;

DROP TABLE IF EXISTS billing_events;
DROP TABLE IF EXISTS usage_counters;
DROP TABLE IF EXISTS rate_limits;

ALTER TABLE operations
  DROP COLUMN IF EXISTS sealed,
  DROP COLUMN IF EXISTS key_epoch,
  DROP COLUMN IF EXISTS retention_days;

ALTER TABLE replicas
  DROP COLUMN IF EXISTS device_public_key;

ALTER TABLE workspaces
  DROP COLUMN IF EXISTS autonomy_tier,
  DROP COLUMN IF EXISTS encryption_latched_at,
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS stripe_subscription_id,
  DROP COLUMN IF EXISTS billing_plan,
  DROP COLUMN IF EXISTS billing_interval,
  DROP COLUMN IF EXISTS billing_status,
  DROP COLUMN IF EXISTS billing_seats,
  DROP COLUMN IF EXISTS billing_owner_member_id,
  DROP COLUMN IF EXISTS grace_period_ends_at,
  DROP COLUMN IF EXISTS subscription_current_period_end,
  DROP COLUMN IF EXISTS subscription_cancel_at_period_end;
