import { SignJWT, jwtVerify } from "jose";

export type AccessClaims = {
  memberId: string;
  actorId: string;
  workspaceId: string;
  replicaId: string;
  role: "owner" | "member" | "viewer";
  tokenVersion: number;
};

const issuer = "crosscode-service";
const audience = "crosscode-replica";

function key(secret: string): Uint8Array {
  if (Buffer.byteLength(secret) < 32) throw new Error("JWT secret must contain at least 32 bytes");
  return new TextEncoder().encode(secret);
}

export async function issueAccessToken(claims: AccessClaims, secret: string, ttlSeconds = 900): Promise<string> {
  return new SignJWT({
    actorId: claims.actorId,
    workspaceId: claims.workspaceId,
    replicaId: claims.replicaId,
    role: claims.role,
    tokenVersion: claims.tokenVersion
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.memberId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"], issuer, audience });
  if (
    typeof payload.sub !== "string" ||
    typeof payload.actorId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.replicaId !== "string" ||
    !["owner", "member", "viewer"].includes(String(payload.role)) ||
    typeof payload.tokenVersion !== "number"
  ) throw new Error("Access token claims are invalid");
  return {
    memberId: payload.sub,
    actorId: payload.actorId,
    workspaceId: payload.workspaceId,
    replicaId: payload.replicaId,
    role: payload.role as AccessClaims["role"],
    tokenVersion: payload.tokenVersion
  };
}
