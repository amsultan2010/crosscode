import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export type StoredSession = { accessToken: string; refreshToken: string; expiresAt: string };

export function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set to use Supabase Auth");
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function toStoredSession(session: Session): StoredSession {
  const expiresAtMs = session.expires_at ? session.expires_at * 1_000 : Date.now() + (session.expires_in ?? 3_600) * 1_000;
  return { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: new Date(expiresAtMs).toISOString() };
}
