import { createHash } from "node:crypto";
import type { ChangeTransaction } from "@crosscode/protocol";

export * from "./semantic-review.js";
export * from "./mock-semantic-reviewer.js";

export type Classification = "independent" | "likely-compatible" | "delete-vs-modify" | "semantic-overlap" | "stale-base" | "stale-base-resolved" | "critical";
export type Risk = "low" | "medium" | "high" | "critical";
export type OperationAnalysis = { classification: Classification; requiresApproval: boolean; risk: Risk; deletedSide?: "incoming" | "local"; dependents?: string[] };
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
const exportedSymbolNamePattern = /^\s*export\s+(?:function|class|interface|type|const)\s+([A-Za-z_$][\w$]*)/;
function exportedSymbolMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of source.split("\n")) {
    const match = exportedSymbolNamePattern.exec(line);
    if (match) map.set(match[1]!, line);
  }
  return map;
}
export function changedExportedSymbols(before: string | undefined, after: string | undefined): string[] {
  const beforeMap = exportedSymbolMap(before ?? "");
  const afterMap = exportedSymbolMap(after ?? "");
  const names = new Set<string>();
  for (const [name, line] of beforeMap) if (afterMap.get(name) !== line) names.add(name);
  for (const [name, line] of afterMap) if (beforeMap.get(name) !== line) names.add(name);
  return [...names];
}
export function redactPath(path: string): boolean {
  return /(^|\/)(\.env($|\.)|\.envrc$|\.npmrc$|\.netrc$|credentials($|[./])|secrets?($|[./])|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$)|\.(pem|key|p12|pfx|jks|keystore)$/i.test(path);
}
export function riskForPath(path: string): "low" | "critical" {
  return /(^|\/)(auth|migrations?|\.crosscode|\.git|\.github\/workflows)(\/|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|deploy|Dockerfile)/i.test(path) ? "critical" : "low";
}
export function riskForClassification(classification: Classification): Risk {
  switch (classification) {
    case "critical": return "critical";
    case "independent": return "low";
    case "likely-compatible": return "medium";
    default: return "high";
  }
}
export function analyzeOperation(input: { path: string; baseMatches: boolean; overlaps: boolean; kind?: "add" | "modify" | "delete" | "rename"; conflictingKind?: "add" | "modify" | "delete" | "rename"; semanticOverlap?: boolean; dependents?: string[] }): OperationAnalysis {
  const decide = (): { classification: Classification; requiresApproval: boolean; deletedSide?: "incoming" | "local" } => {
    if (riskForPath(input.path) === "critical") return { classification: "critical", requiresApproval: true };
    if (!input.baseMatches) return { classification: "stale-base", requiresApproval: true };
    if (input.overlaps && (input.kind === "delete" || input.conflictingKind === "delete") && input.kind !== input.conflictingKind) {
      return { classification: "delete-vs-modify", requiresApproval: true, deletedSide: input.kind === "delete" ? "incoming" : "local" };
    }
    if (input.overlaps && input.semanticOverlap) return { classification: "semantic-overlap", requiresApproval: true };
    return input.overlaps ? { classification: "likely-compatible", requiresApproval: true } : { classification: "independent", requiresApproval: false };
  };
  const decision = decide();
  return { ...decision, risk: riskForClassification(decision.classification), ...(input.dependents !== undefined ? { dependents: input.dependents } : {}) };
}
export function transactionRisk(transaction: Pick<ChangeTransaction, "changes">): "low" | "critical" { return transaction.changes.some((change) => riskForPath(change.path) === "critical") ? "critical" : "low"; }
