import { createHash } from "node:crypto";
import type { ChangeTransaction } from "@crosscode/protocol";

export type OperationAnalysis = { classification: "independent" | "likely-compatible" | "stale-base" | "high-risk" | "semantic-overlap" | "critical"; requiresApproval: boolean };
export type HunkRange = { start: number; length: number };

export function contentHash(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
export function pathOverlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
export function parseHunkRanges(unifiedPatch: string): HunkRange[] {
  const ranges: HunkRange[] = [];
  const headerPattern = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;
  for (const match of unifiedPatch.matchAll(headerPattern)) ranges.push({ start: Number(match[1]), length: match[2] === undefined ? 1 : Number(match[2]) });
  return ranges;
}
export function hunksOverlap(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  const leftRanges = parseHunkRanges(left);
  const rightRanges = parseHunkRanges(right);
  if (!leftRanges.length || !rightRanges.length) return true;
  return leftRanges.some((a) => rightRanges.some((b) => a.start < b.start + b.length && b.start < a.start + a.length));
}
const exportedSymbolPattern = /^\s*export\s+(function|class|interface|type|const)\s+/;
export function looksLikeInterfaceChange(before: string | undefined, after: string | undefined, path: string): boolean {
  if (!/\.tsx?$/.test(path)) return false;
  const beforeSignatures = new Set((before ?? "").split("\n").filter((line) => exportedSymbolPattern.test(line)));
  const afterSignatures = new Set((after ?? "").split("\n").filter((line) => exportedSymbolPattern.test(line)));
  if (beforeSignatures.size !== afterSignatures.size) return true;
  for (const line of beforeSignatures) if (!afterSignatures.has(line)) return true;
  return false;
}
export function redactPath(path: string): boolean {
  return /(^|\/)(\.env($|\.)|\.envrc$|\.npmrc$|\.netrc$|credentials($|[./])|secrets?($|[./])|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$)|\.(pem|key|p12|pfx|jks|keystore)$/i.test(path);
}
export function riskForPath(path: string): "low" | "critical" {
  return /(^|\/)(auth|migrations?|\.crosscode|\.git|\.github\/workflows)(\/|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|deploy|Dockerfile)/i.test(path) ? "critical" : "low";
}
export function analyzeOperation(input: { path: string; baseMatches: boolean; overlaps: boolean; kind?: string; semanticOverlap?: boolean }): OperationAnalysis {
  if (riskForPath(input.path) === "critical") return { classification: "critical", requiresApproval: true };
  if (!input.baseMatches) return { classification: "stale-base", requiresApproval: true };
  if (input.kind === "delete" && input.overlaps) return { classification: "high-risk", requiresApproval: true };
  if (input.overlaps && input.semanticOverlap) return { classification: "semantic-overlap", requiresApproval: true };
  return input.overlaps ? { classification: "likely-compatible", requiresApproval: true } : { classification: "independent", requiresApproval: false };
}
export function transactionRisk(transaction: Pick<ChangeTransaction, "changes">): "low" | "critical" { return transaction.changes.some((change) => riskForPath(change.path) === "critical") ? "critical" : "low"; }
