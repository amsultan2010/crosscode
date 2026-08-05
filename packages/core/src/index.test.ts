import { describe, expect, it } from "vitest";
import { contentHash, redactPath } from "./index.js";

describe("core safety rules", () => {
  it("detects secret paths", () => {
    expect(redactPath(".env")).toBe(true);
    expect(redactPath("keys/service.pem")).toBe(true);
    expect(redactPath("src/index.ts")).toBe(false);
  });

  it("hashes content stably and distinguishes different content", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
});
