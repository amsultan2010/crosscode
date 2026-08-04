-- Phase 10, real billing. 008 added the placeholder columns; this adds the state a live
-- Stripe subscription actually needs, plus the two structures the lifecycle decisions in
-- BUILD_INSTRUCTIONS.md rest on: a webhook replay ledger, and a per-operation retention
-- stamp so a downgrade can never retroactively delete history.

ALTER TABLE workspaces
  -- What the workspace is *paying* for, as distinct from `plan`, which is what it is
  -- currently *entitled* to. They differ during a dunning grace period (billing_plan is
  -- still pro, plan is still pro, and the grace deadline is what will eventually drop it)
  -- and after a cancellation lands (billing_plan null, plan free).
  ADD COLUMN IF NOT EXISTS billing_plan text,
  ADD COLUMN IF NOT EXISTS billing_interval text,
  -- The Stripe subscription status verbatim, for diagnosis. Never enforced against
  -- directly -- entitlementForSubscription() in billing.ts owns that mapping.
  ADD COLUMN IF NOT EXISTS billing_status text,
  ADD COLUMN IF NOT EXISTS billing_seats integer,
  -- Set when a payment first fails, cleared when one succeeds. Until it passes, the
  -- workspace keeps every paid limit; after it passes, the workspace falls to free's
  -- limits and nothing is deleted.
  ADD COLUMN IF NOT EXISTS grace_period_ends_at timestamptz,
  -- Who pays. Advisory: the subscription belongs to the workspace (the Stripe customer is
  -- keyed by workspace_id), so this is for display and receipts, and is reassigned to
  -- another owner if this member leaves -- never a reason to cancel anything.
  ADD COLUMN IF NOT EXISTS billing_owner_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end boolean NOT NULL DEFAULT false;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_billing_plan_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_billing_plan_check
  CHECK (billing_plan IS NULL OR billing_plan IN ('essential', 'pro', 'unlimited', 'team', 'student'));

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_billing_interval_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_billing_interval_check
  CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year'));

-- One Stripe subscription/customer maps to exactly one workspace. The webhook resolves a
-- workspace from these, so a duplicate would make that resolution ambiguous and let one
-- workspace's payment state be applied to another's.
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_stripe_subscription_idx
  ON workspaces (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_stripe_customer_idx
  ON workspaces (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Webhook replay/idempotency ledger. The route is unauthenticated (signature-verified), so
-- it is the one place a third party's bytes reach a write path: recording Stripe's event id
-- here makes a redelivered or replayed event a no-op. processed_at is set only after the
-- handler succeeds, so a delivery that failed halfway is retried rather than swallowed.
CREATE TABLE IF NOT EXISTS billing_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS billing_events_received_idx ON billing_events (received_at);

-- No SELECT policy, deliberately: this is an internal ledger, not workspace content, and
-- nothing outside the service role has any business reading Stripe event ids.
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

-- The retention contract a downgrade has to honor (BUILD_INSTRUCTIONS.md Phase 10): a row's
-- retention is fixed by the plan in effect when it was written, so shrinking the plan's
-- history window stops history being *extended* and never deletes what was already
-- promised. 013 gave the retention sweep its cursor watermark; this column gives it the
-- per-row window it measures against, and PgStore.pruneWorkspaceOperations reads it instead
-- of the workspace's current plan.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS retention_days integer;

-- Backfill: rows written before this column existed were written under the workspace's
-- current plan -- nobody had changed plans yet, because there was no way to. The sweep
-- COALESCEs a leftover NULL to the current plan's window anyway, which is exactly the
-- behavior 013 shipped, so an unstamped row can never outlive what it would have.
UPDATE operations o
   SET retention_days = CASE w.plan
     WHEN 'free' THEN 7
     WHEN 'essential' THEN 30
     WHEN 'pro' THEN 90
     WHEN 'student' THEN 90
     ELSE 365
   END
  FROM workspaces w
 WHERE w.id = o.workspace_id AND o.retention_days IS NULL;
