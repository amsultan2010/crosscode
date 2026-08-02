-- Phase 10 (tiered pricing & billing) placeholder. No Stripe account exists yet, so
-- stripe_customer_id/stripe_subscription_id are nullable and unused until a real key
-- is wired up (see apps/service/src/billing.ts's StubBillingProvider).

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_plan_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_plan_check
  CHECK (plan IN ('free', 'essential', 'pro', 'unlimited', 'student'));

-- Meters semantic review calls/month per workspace (the metering axis with a direct
-- cost driver). Other axes (seats, autonomy tier) are derived from existing tables
-- (members, workspaces.plan) and don't need their own counters.
CREATE TABLE IF NOT EXISTS usage_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  metric text NOT NULL,
  period_start date NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (workspace_id, metric, period_start)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_counters_member_select ON usage_counters;
CREATE POLICY usage_counters_member_select ON usage_counters
  FOR SELECT USING (workspace_id IN (SELECT private.membership_workspace_ids()));
