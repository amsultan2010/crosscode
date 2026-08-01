import { jwtVerify } from "jose";

export type SupabaseAccessClaims = {
  userId: string;
  email: string | undefined;
  expiresAt: string;
};

function key(secret: string): Uint8Array {
  if (Buffer.byteLength(secret) < 32) throw new Error("Supabase JWT secret must contain at least 32 bytes");
  return new TextEncoder().encode(secret);
}

export async function verifySupabaseAccessToken(
  token: string,
  jwtSecret: string,
  supabaseUrl: string
): Promise<SupabaseAccessClaims> {
  const issuer = `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;
  const { payload } = await jwtVerify(token, key(jwtSecret), {
    algorithms: ["HS256"],
    issuer,
    audience: "authenticated"
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Access token subject is invalid");
  }
  if (typeof payload.exp !== "number") throw new Error("Access token is missing an expiration");
  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    expiresAt: new Date(payload.exp * 1_000).toISOString()
  };
}
