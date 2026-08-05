import { describe, expect, it } from "vitest";
import { redactPath, riskForPath } from "./index.js";

describe("core safety rules", () => {
  it("detects secret paths", () => {
    expect(redactPath(".env")).toBe(true);
    expect(redactPath("keys/service.pem")).toBe(true);
    expect(redactPath("src/index.ts")).toBe(false);
  });

  it("treats lockfiles and auth paths as critical", () => {
    expect(riskForPath("package-lock.json")).toBe("critical");
    expect(riskForPath("src/auth/session.ts")).toBe("critical");
    expect(riskForPath("src/a.ts")).toBe("low");
  });
});
