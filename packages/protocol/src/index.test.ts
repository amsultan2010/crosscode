import { describe, expect, it } from "vitest";
import { daemonConfigSchema, daemonConnectionSchema, fileVersionSchema } from "./index.js";

const modify = {
  path: "src/a.ts",
  op: "modify" as const,
  baseHash: "base",
  contentHash: "after",
  content: "hello\n"
};

describe("file version invariants", () => {
  it("accepts a modify carrying full content, and one carrying a patch", () => {
    expect(fileVersionSchema.parse(modify).encoding).toBe("utf8");
    expect(fileVersionSchema.parse({ ...modify, content: undefined, patch: "@@ -1 +1 @@\n" }).patch).toBeDefined();
  });

  it("rejects a modify carrying both content and a patch, or neither", () => {
    expect(() => fileVersionSchema.parse({ ...modify, patch: "@@ -1 +1 @@\n" })).toThrow();
    expect(() => fileVersionSchema.parse({ ...modify, content: undefined })).toThrow();
  });

  // A patch is meaningless without the base it applies to; full content stands alone.
  it("rejects a patch with no base to apply it to", () => {
    expect(() => fileVersionSchema.parse({ ...modify, content: undefined, patch: "@@ -1 +1 @@\n", baseHash: null })).toThrow();
  });

  it("accepts a delete, and rejects one that carries content or a hash", () => {
    expect(fileVersionSchema.parse({ path: "src/a.ts", op: "delete", baseHash: "base", contentHash: null }).op).toBe("delete");
    expect(() => fileVersionSchema.parse({ path: "src/a.ts", op: "delete", baseHash: "base", contentHash: null, content: "x" })).toThrow();
    expect(() => fileVersionSchema.parse({ path: "src/a.ts", op: "delete", baseHash: "base", contentHash: "after" })).toThrow();
  });

  // Without a contentHash a modify has no loop-suppression key, so peers would echo forever.
  it("rejects a modify with no contentHash", () => {
    expect(() => fileVersionSchema.parse({ ...modify, contentHash: null })).toThrow();
  });
});

describe("local daemon shapes", () => {
  it("accepts the descriptor the daemon advertises its loopback port with", () => {
    const connection = { pid: 42, port: 51_234, secret: "s", startedAt: new Date(0).toISOString() };
    expect(daemonConnectionSchema.parse(connection).port).toBe(51_234);
    expect(() => daemonConnectionSchema.parse({ ...connection, port: 0 })).toThrow();
  });

  it("refuses a plaintext service URL that is not loopback", () => {
    const config = { workspaceId: "w", actorId: "a" };
    expect(daemonConfigSchema.parse({ ...config, service: { url: "https://example.com" } })).toBeTruthy();
    expect(daemonConfigSchema.parse({ ...config, service: { url: "http://127.0.0.1:3000" } })).toBeTruthy();
    expect(() => daemonConfigSchema.parse({ ...config, service: { url: "http://example.com" } })).toThrow();
  });
});
