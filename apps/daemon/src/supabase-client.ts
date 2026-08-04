import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export type StoredSession = { accessToken: string; refreshToken: string; expiresAt: string };

export type SupabaseConfig = { url: string; anonKey: string };

/**
 * The hosted Crosscode Supabase project, compiled in so the README quickstart runs with no
 * environment setup at all. Both values are public by design: the `anon` key is the key
 * Supabase intends to ship in client code -- the docs site already serves it to browsers as
 * `VITE_SUPABASE_ANON_KEY` -- and Row Level Security, not key secrecy, is the boundary.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` must never be added here, defaulted, or read anywhere in the
 * CLI or daemon. It bypasses RLS entirely and belongs only to the administrator-side
 * `pnpm service:provision`.
 *
 * To point the published binary at a different project, replace these two constants; to
 * point one machine at a different project, set the two environment variables instead.
 */
export const DEFAULT_SUPABASE_CONFIG: SupabaseConfig = {
  url: "https://rzsslbmahvoesjxmgefr.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6c3NsYm1haHZvZXNqeG1nZWZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MjQ5NjYsImV4cCI6MjEwMDQwMDk2Nn0.lfGaM7r8dDg78NJyHS_ilVnCQdVakuZHS6s6j2IhY_M"
};

/** Carries a stable `code` and an actionable `hint` so the CLI can report both verbatim. */
export class SupabaseConfigError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint: string) {
    super(message);
  }
}

const BOTH_REQUIRED_HINT =
  "Set both SUPABASE_URL and SUPABASE_ANON_KEY (Project Settings -> API: the project URL and the `anon` public key), or unset both to use the hosted Crosscode project. See README.md, \"Set up Supabase and run the coordination service\".";

/**
 * Environment beats the compiled-in default, so a self-hoster keeps full control.
 *
 * The two variables are resolved as a pair rather than independently: pairing a
 * self-hoster's `SUPABASE_URL` with the hosted project's anon key would fail later, deep
 * inside Supabase Auth, with an error that says nothing about the real cause.
 */
export function resolveSupabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
  defaults: SupabaseConfig = DEFAULT_SUPABASE_CONFIG
): SupabaseConfig {
  const url = environment.SUPABASE_URL?.trim();
  const anonKey = environment.SUPABASE_ANON_KEY?.trim();
  if (url || anonKey) {
    if (!url || !anonKey) {
      throw new SupabaseConfigError(
        "SUPABASE_CONFIG_MISSING",
        `Supabase is half-configured: ${url ? "SUPABASE_ANON_KEY" : "SUPABASE_URL"} is set to an empty value or not set at all`,
        BOTH_REQUIRED_HINT
      );
    }
    return { url, anonKey };
  }
  if (!defaults.url || !defaults.anonKey) {
    throw new SupabaseConfigError(
      "SUPABASE_CONFIG_MISSING",
      "No Supabase project is configured and this build has no default one compiled in, so there is no account system to sign in against",
      BOTH_REQUIRED_HINT
    );
  }
  return { url: defaults.url, anonKey: defaults.anonKey };
}

export function getSupabaseClient(): SupabaseClient {
  const { url, anonKey } = resolveSupabaseConfig();
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function toStoredSession(session: Session): StoredSession {
  const expiresAtMs = session.expires_at ? session.expires_at * 1_000 : Date.now() + (session.expires_in ?? 3_600) * 1_000;
  return { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: new Date(expiresAtMs).toISOString() };
}
