-- Who accepted which document, at which version, when, and where.
--
-- The terms carry a warranty disclaimer and a liability cap. A link in a footer is
-- browsewrap, and courts routinely decline to enforce it: until somebody affirmatively
-- assents and that assent is recorded, those clauses protect nobody. This table is the
-- record, and `apps/service/src/legal.ts` is where the version being accepted comes from.
--
-- **Append-only.** A row is never updated and never deleted by the service. The entire
-- evidentiary value is "this user accepted *this text* on *this date*", so overwriting a row
-- when the document changes destroys the only thing it was for. The runtime role is granted
-- SELECT and INSERT and nothing else (see the grant below and
-- PgStore.assertRuntimePrivileges, which refuses to start a service whose role can do more).
--
-- Idempotent like 001 and 002, and applied after them: apps/service/src/store.ts's migrate()
-- runs every file in this directory in filename order.

BEGIN;

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id          uuid PRIMARY KEY,
  -- The Supabase auth user id (the JWT `sub`). Deliberately not a reference to users (id),
  -- for the same reason device_codes.user_id is not: acceptance happens *before* the routes
  -- that provision a user row, and a foreign key would mean the first thing a new account
  -- does is the one thing it cannot do.
  user_id     uuid NOT NULL,
  document    text NOT NULL CHECK (document IN ('terms', 'privacy', 'dpa')),
  -- The published version of that document, e.g. '2026-08-01'. Compared for equality, never
  -- for order: any change to the text is a new version, and a new version is re-accepted.
  version     text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  -- Where the assent came from, as far as the service could tell. Both are evidence of the
  -- circumstances rather than identifiers we use for anything, and both are nullable because
  -- a request behind an unexpected proxy may carry neither.
  ip          text,
  user_agent  text,
  surface     text NOT NULL CHECK (surface IN ('signup', 'signin', 'device', 'join', 'cli'))
);

-- The one read there is: "what is the newest version this person accepted of each document",
-- asked on every route that gates on acceptance.
CREATE INDEX IF NOT EXISTS terms_acceptances_user_document_idx
  ON terms_acceptances (user_id, document, accepted_at DESC);

/* ---------------------------------------------------------------------------- rls */

-- On, with no policies, exactly as device_codes is: RLS with no policy denies every row to
-- every non-owner role, and nothing about an acceptance record is a PostgREST operation.
-- The service reaches it as `crosscode_runtime`, which holds BYPASSRLS -- so the grant below
-- is the only thing standing between this table and the service.
ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;

/* ------------------------------------------------------------------------- grants */

-- Said out loud, because nothing else says it. A table added without a grant to
-- `crosscode_runtime` arrives readable by nobody, and the first request that touches it 500s
-- with `permission denied` while /healthz still answers `ok`. That is how device_codes
-- shipped. /healthz now names any table the runtime role cannot read, and this grant is why
-- it will not have to.
--
-- SELECT and INSERT only: no UPDATE, no DELETE, no TRUNCATE. Append-only is not a convention
-- here, it is a privilege the service does not hold.
--
-- Guarded on the role existing because the role is a property of the deployment, not of the
-- schema: CI runs these migrations against a throwaway PostgreSQL that has no such role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crosscode_runtime') THEN
    REVOKE ALL PRIVILEGES ON TABLE terms_acceptances FROM crosscode_runtime;
    GRANT SELECT, INSERT ON TABLE terms_acceptances TO crosscode_runtime;
  END IF;
END
$$;

COMMIT;
