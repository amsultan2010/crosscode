-- Adds the 'team' plan (the per-seat org tier: same caps as Unlimited, differentiated by
-- org controls rather than seat count -- see apps/service/src/billing.ts PLAN_LIMITS).
-- Plan *prices* are not stored here; only the enumeration the service enforces against.

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_plan_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_plan_check
  CHECK (plan IN ('free', 'essential', 'pro', 'unlimited', 'team', 'student'));
