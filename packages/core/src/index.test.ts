import { describe, expect, it } from "vitest";
import { analyzeOperation, hunksOverlap, looksLikeInterfaceChange, pathOverlaps, redactPath } from "./index.js";

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
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: false })).toEqual({ classification: "independent", requiresApproval: false });
  });

  it("classifies same-file non-overlapping hunks as likely-compatible", () => {
    expect(hunksOverlap("@@ -1,2 +1,2 @@\n", "@@ -10,2 +10,2 @@\n")).toBe(false);
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: false, kind: "modify" }).classification).toBe("independent");
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "modify" })).toEqual({ classification: "likely-compatible", requiresApproval: true });
  });

  it("detects overlapping hunks on the same file", () => {
    expect(hunksOverlap("@@ -1,5 +1,5 @@\n", "@@ -3,2 +3,2 @@\n")).toBe(true);
  });

  it("classifies delete-vs-modify overlap as high-risk", () => {
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "delete" })).toEqual({ classification: "high-risk", requiresApproval: true });
  });

  it("classifies exported interface changes as semantic-overlap", () => {
    expect(looksLikeInterfaceChange("export function greet(name: string): void {}", "export function greet(name: string, loud: boolean): void {}", "src/a.ts")).toBe(true);
    expect(looksLikeInterfaceChange("export function greet(): void {}", "export function greet(): void { return; }", "src/a.js")).toBe(false);
    expect(analyzeOperation({ path: "src/a.ts", baseMatches: true, overlaps: true, kind: "modify", semanticOverlap: true })).toEqual({ classification: "semantic-overlap", requiresApproval: true });
  });
});
