import { describe, expect, it } from "vitest";
import { analyzeOperation, changedExportedSymbols, exportedSymbolNames, hunksOverlap, looksLikeInterfaceChange, pathOverlaps, redactPath, riskForClassification } from "./index.js";

describe("core safety rules", () => {
  it("detects path overlap and secret paths", () => {
    expect(pathOverlaps("src/api", "src/api/users.ts")).toBe(true);
    expect(pathOverlaps("src/api/a.ts", "src/api/b.ts")).toBe(false);
    expect(redactPath(".env")).toBe(true);
    expect(redactPath("keys/service.pem")).toBe(true);
  });

  it("requires approval for critical paths and stale bases", () => {
    expect(analyzeOperation({ path: "package-lock.json", baseMatches: true, overlaps: false }).requiresApproval).toBe(true);
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: false, overlaps: false }).classification).toBe("stale-base");
  });

  it("classifies non-overlapping changes to different files as independent", () => {
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: false })).toEqual({ classification: "independent", requiresApproval: false, risk: "low" });
  });

  it("classifies same-file non-overlapping hunks as likely-compatible", () => {
    expect(hunksOverlap("@@ -1,2 +1,2 @@\n", "@@ -10,2 +10,2 @@\n")).toBe(false);
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: false, kind: "modify" }).classification).toBe("independent");
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "modify" })).toEqual({ classification: "likely-compatible", requiresApproval: true, risk: "medium" });
  });

  it("detects overlapping hunks on the same file", () => {
    expect(hunksOverlap("@@ -1,5 +1,5 @@\n", "@@ -3,2 +3,2 @@\n")).toBe(true);
  });

  it("classifies delete-vs-modify overlap as a distinct, high-risk classification", () => {
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "delete" })).toEqual({ classification: "delete-vs-modify", requiresApproval: true, risk: "high", deletedSide: "incoming" });
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "modify", conflictingKind: "delete" })).toEqual({ classification: "delete-vs-modify", requiresApproval: true, risk: "high", deletedSide: "local" });
  });

  it("classifies exported interface changes as semantic-overlap", () => {
    expect(looksLikeInterfaceChange("export function greet(name: string): void {}", "export function greet(name: string, loud: boolean): void {}", "src/a.ts")).toBe(true);
    expect(looksLikeInterfaceChange("export function greet(): void {}", "export function greet(): void { return; }", "src/a.js")).toBe(false);
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "modify", semanticOverlap: true })).toEqual({ classification: "semantic-overlap", requiresApproval: true, risk: "high" });
  });

  it("maps risk levels per classification, independent of path", () => {
    expect(riskForClassification("independent")).toBe("low");
    expect(riskForClassification("likely-compatible")).toBe("medium");
    expect(riskForClassification("delete-vs-modify")).toBe("high");
    expect(riskForClassification("semantic-overlap")).toBe("high");
    expect(riskForClassification("stale-base")).toBe("high");
    expect(riskForClassification("stale-base-resolved")).toBe("high");
    expect(riskForClassification("critical")).toBe("critical");
  });

  it("extracts the names of exported symbols whose signature line changed", () => {
    expect(changedExportedSymbols("export function greet(name: string): void {}", "export function greet(name: string, loud: boolean): void {}")).toEqual(["greet"]);
    expect(changedExportedSymbols("export function greet(): void {}\nexport const stable = 1;", "export function greet(): void {}\nexport const stable = 1;")).toEqual([]);
    expect(changedExportedSymbols(undefined, "export function added(): void {}")).toEqual(["added"]);
    expect(changedExportedSymbols("export function removed(): void {}", undefined)).toEqual(["removed"]);
  });

  it("lists the names of every exported symbol in a source file", () => {
    expect(exportedSymbolNames("export function greet(): void {}\nexport const stable = 1;\nfunction helper() {}")).toEqual(["greet", "stable"]);
    expect(exportedSymbolNames("")).toEqual([]);
  });

  it("classifies a semantic export change with known dependents as interface-impact, distinct from semantic-overlap", () => {
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: false, kind: "modify", semanticOverlap: true, dependents: ["src/b.ts"] })).toEqual({ classification: "interface-impact", requiresApproval: true, risk: "high", dependents: ["src/b.ts"] });
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "modify", semanticOverlap: true, dependents: ["src/b.ts", "src/c.ts"] }).classification).toBe("interface-impact");
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "modify", semanticOverlap: true, dependents: [] }).classification).toBe("semantic-overlap");
    expect(riskForClassification("interface-impact")).toBe("high");
  });
});
