-- The one table the GitHub device flow needs.
--
-- `crosscode start` runs in a terminal that cannot receive a redirect, so sign-in is a
-- device handshake: the CLI asks for a pair of codes, the human takes the short one to
-- getcrosscode.dev/device in a browser they are already signed into, and the CLI polls
-- until that page has bound a Supabase session to the code it holds. This table is the
-- only place those two halves meet, and every row in it is a credential in flight.
--
-- Which is why it is shaped the way it is:
--
--   * the device code is stored as a SHA-256 hash, never in the clear. It is a bearer
--     token -- whoever presents it is handed the session -- so a leaked database dump, a
--     log of a slow query, or a support engineer reading rows must not be enough to claim
--     one.
--   * the user code is stored in the clear, because binding looks it up and it is not a
--     credential on its own: it does nothing without a browser session that has already
--     signed in with GitHub, and the row it names is gone within fifteen minutes.
--   * `session` holds the tokens in flight for those minutes and is set to NULL the moment
--     the CLI collects them. A row that has been consumed keeps its `consumed_at` so a
--     replayed poll can be told "already used" rather than "never existed", but keeps
--     nothing worth stealing.
--
-- Idempotent like 001, and applied after it: apps/service/src/store.ts's migrate() runs
-- every file in this directory in filename order.

BEGIN;

CREATE TABLE IF NOT EXISTS device_codes (
  id                uuid PRIMARY KEY,
  -- SHA-256 of the device code the CLI holds, hex. Unique because it is the poll's only
  -- lookup key, and a collision would hand one CLI another's session.
  device_code_hash  text NOT NULL UNIQUE,
  -- The short code a human retypes, in the grouped WDJB-MJHT form the /device page shows.
  user_code         text NOT NULL UNIQUE,
  -- The Supabase user the browser bound, NULL until someone does. Deliberately not a
  -- reference to users (id): binding happens before the service has ever seen this
  -- account, and provisioning a user row is the job of the first route that needs one.
  user_id           uuid,
  -- The bound Supabase session -- access token, refresh token, expiry, and the GitHub
  -- OAuth token that goes with it -- from the moment the browser hands it over until the
  -- CLI collects it. NULL before binding and NULL again after collection.
  session           jsonb,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Every read filters on expiry, and the sweep at the top of a new handshake deletes by it.
CREATE INDEX IF NOT EXISTS device_codes_expires_at_idx ON device_codes (expires_at);

/* ---------------------------------------------------------------------------- rls */

-- On, with no policies at all, which is not an oversight: RLS with no policy denies every
-- row to every non-owner role. Nothing about a device handshake is a PostgREST operation
-- -- the CLI is unauthenticated when it starts one, and the browser reaches it through the
-- service -- so the `authenticated` role has no business reading or writing this table.
--
-- The service is unaffected because it connects as `crosscode_runtime`, which holds
-- BYPASSRLS. That is what makes the grant below the only thing standing between this table
-- and the service, and why its absence was not a permissions warning but a 500.
ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;

/* ------------------------------------------------------------------------- grants */

-- The runtime role needs saying out loud, because nothing else says it. 001 never granted
-- to `crosscode_runtime` -- the six tables it creates were granted out of band, once, by
-- hand -- so a table added later starts with no grant at all and the service gets
-- `permission denied` on its first write. That is exactly what shipping this table did.
--
-- Guarded on the role existing because the role is a property of the deployment, not of the
-- schema: CI runs these migrations against a throwaway PostgreSQL that has no such role,
-- and an unguarded GRANT would fail the whole suite.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crosscode_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE device_codes TO crosscode_runtime;
  END IF;
END
$$;

COMMIT;
