import { describe, expect, it } from "vitest";
import {
  changeTransactionSchema,
  checkpointRequestSchema,
  claimRequestSchema,
  daemonConnectionSchema,
  eventEnvelopeSchema,
  taskRequestSchema,
  taskSchema,
  validationRequestSchema
} from "./index.js";

describe("protocol schemas", () => {
  it("rejects incompatible event schema versions", () => {
    expect(() => eventEnvelopeSchema.parse({ id: "e", schemaVersion: 2, workspaceId: "w", replicaId: "r", actorId: "a", type: "task.created", clientSequence: 1, createdAt: new Date().toISOString(), payload: {} })).toThrow();
  });

  it("validates a task and immutable transaction", () => {
    expect(taskSchema.parse({ id: "t", title: "Test", ownerId: "a", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }).status).toBe("active");
    expect(changeTransactionSchema.parse({ id: "x", base: { files: [] }, changes: [{ path: "a.ts", kind: "add", afterHash: "hash", afterContent: "content" }], provenance: { source: "filesystem", confidence: "known" }, safety: { risk: "low", requiresApproval: false } }).id).toBe("x");
    expect(() => changeTransactionSchema.parse({ id: "x", base: { files: [] }, changes: [{ path: "a.ts", kind: "modify", afterHash: "hash" }], provenance: { source: "filesystem", confidence: "known" }, safety: { risk: "low", requiresApproval: false } })).toThrow();
    expect(() => changeTransactionSchema.parse({ id: "x", base: { files: [] }, changes: [{ path: "b.ts", kind: "rename", afterContent: "content" }], provenance: { source: "filesystem", confidence: "known" }, safety: { risk: "low", requiresApproval: false } })).toThrow();
  });

  it("strictly validates local daemon boundary inputs", () => {
    expect(taskRequestSchema.parse({ title: "Task", paths: ["src"] })).toEqual({ title: "Task", paths: ["src"] });
    expect(() => taskRequestSchema.parse({ title: "Task", unexpected: true })).toThrow();
    expect(claimRequestSchema.parse({ taskId: "t", kind: "path", target: "src", mode: "exclusive-preferred" }).target).toBe("src");
    expect(checkpointRequestSchema.parse({ message: "before change" }).message).toBe("before change");
    expect(validationRequestSchema.parse({ profile: "fast" })).toEqual({ profile: "fast" });
    expect(() => validationRequestSchema.parse({ profile: "fast", commands: ["rm -rf somewhere"] })).toThrow();
    expect(daemonConnectionSchema.parse({ pid: 123, port: 4567, secret: "secret", startedAt: "2026-01-01T00:00:00.000Z" }).port).toBe(4567);
  });
});
