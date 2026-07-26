import { describe, expect, it } from "vitest";
import { analyzeOperation, pathOverlaps, redactPath } from "./index.js";

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
});
