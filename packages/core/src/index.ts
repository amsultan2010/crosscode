import { createHash } from "node:crypto";

export function contentHash(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
export function redactPath(path: string): boolean {
  return /(^|\/)(\.env($|\.)|\.envrc$|\.npmrc$|\.netrc$|credentials($|[./])|secrets?($|[./])|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$)|\.(pem|key|p12|pfx|jks|keystore)$/i.test(path);
}
