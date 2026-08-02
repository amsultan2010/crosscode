-- Phase 9 autonomy slider: how eagerly a workspace's daemons may auto-apply
-- incoming proposals without an explicit accept. 0=always_ask (today's
-- behavior), 1=auto_if_clean, 2=auto_always. This never changes what
-- assertApplicable/assertChangeApplicable allow -- it only controls whether
-- the daemon speculatively calls the ordinary accept() path.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS autonomy_tier smallint NOT NULL DEFAULT 0
  CHECK (autonomy_tier IN (0, 1, 2));
