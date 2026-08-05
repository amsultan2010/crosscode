import { createHash } from "node:crypto";
import type { ChangeTransaction } from "@crosscode/protocol";

export function contentHash(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
export function redactPath(path: string): boolean {
  return /(^|\/)(\.env($|\.)|\.envrc$|\.npmrc$|\.netrc$|credentials($|[./])|secrets?($|[./])|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$)|\.(pem|key|p12|pfx|jks|keystore)$/i.test(path);
}
export function riskForPath(path: string): "low" | "critical" {
  return /(^|\/)(auth|migrations?|\.crosscode|\.git|\.github\/workflows)(\/|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|deploy|Dockerfile)/i.test(path) ? "critical" : "low";
}
export function transactionRisk(transaction: Pick<ChangeTransaction, "changes">): "low" | "critical" { return transaction.changes.some((change) => riskForPath(change.path) === "critical" || (change.kind === "rename" && change.previousPath !== undefined && riskForPath(change.previousPath) === "critical")) ? "critical" : "low"; }
