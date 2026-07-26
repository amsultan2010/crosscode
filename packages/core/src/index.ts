import { createHash } from "node:crypto";
import type { ChangeTransaction } from "@crosscode/protocol";

export type OperationAnalysis = { classification: "independent" | "likely-compatible" | "stale-base" | "high-risk" | "critical"; requiresApproval: boolean };

export function contentHash(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
export function pathOverlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
export function redactPath(path: string): boolean {
  return /(^|\/)(\.env($|\.)|\.envrc$|\.npmrc$|\.netrc$|credentials($|[./])|secrets?($|[./])|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$)|\.(pem|key|p12|pfx|jks|keystore)$/i.test(path);
}
export function riskForPath(path: string): "low" | "critical" {
  return /(^|\/)(auth|migrations?|\.crosscode|\.git|\.github\/workflows)(\/|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|deploy|Dockerfile)/i.test(path) ? "critical" : "low";
}
export function analyzeOperation(input: { path: string; baseMatches: boolean; overlaps: boolean; kind?: string }): OperationAnalysis {
  if (riskForPath(input.path) === "critical") return { classification: "critical", requiresApproval: true };
  if (!input.baseMatches) return { classification: "stale-base", requiresApproval: true };
  if (input.kind === "delete" && input.overlaps) return { classification: "high-risk", requiresApproval: true };
  return input.overlaps ? { classification: "likely-compatible", requiresApproval: true } : { classification: "independent", requiresApproval: false };
}
export function transactionRisk(transaction: Pick<ChangeTransaction, "changes">): "low" | "critical" { return transaction.changes.some((change) => riskForPath(change.path) === "critical") ? "critical" : "low"; }
