import { describe, expect, it } from "vitest";
import { localEventSchema } from "./local-event.js";

describe("local event schema", () => {
  it("accepts a real transaction.created event", () => {
    const event = {
      type: "transaction.created",
      payload: {
        id: "t1",
        workspaceId: "w",
        senderReplicaId: "replica",
        transaction: {
          id: "t1",
          base: { files: [] },
          changes: [{ path: "a.txt", kind: "add", afterContent: "one\n", afterHash: "hash" }],
          provenance: { source: "filesystem", confidence: "known" },
          safety: { risk: "low", requiresApproval: false }
        },
        sequence: 0,
        createdAt: new Date().toISOString()
      }
    };
    expect(() => localEventSchema.parse(event)).not.toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => localEventSchema.parse({ type: "transaction.deleted", payload: {} })).toThrow();
  });

  it("rejects a known event type with a payload shape mismatch", () => {
    expect(() => localEventSchema.parse({ type: "transaction.created", payload: { id: "t1" } })).toThrow();
  });

  it("rejects an extra, undeclared field on a strict payload", () => {
    const event = {
      type: "remote.synchronized",
      payload: { cursor: 1, downloaded: 0, extra: "not allowed" }
    };
    expect(() => localEventSchema.parse(event)).toThrow();
  });
});
